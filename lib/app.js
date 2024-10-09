const { OpenOcdFlashInterface } = require('./openocd');
const { DfuFlashInterface } = require('./dfu');
const { UsbFlashInterface } = require('./usb');
const { ModuleCache } = require('./module');
const { ParticleApi } = require('./api');
const { Flasher } = require('./flasher');
const { platformForId, platformForName, ModuleType } = require('./platform');
const { isDeviceId } = require('./util');

const usb = require('particle-usb');
const tmp = require('tmp');
const mkdirp = require('mkdirp');
const semver = require('semver');
const pLimit = require('p-limit');

const fs = require('fs');
const os = require('os');
const path = require('path');

tmp.setGracefulCleanup();

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_JOBS = Infinity;

class App {
	constructor({ name, log }) {
		this._log = log;
		this._name = name;
		this._ocd = null;
		this._dfu = null;
		this._usb = null;
		this._cache = null;
		this._api = null;
		this._homeDir = null;
		this._tempDir = null;
	}

	async init(args) {
		if (args.draft && !process.env.GITHUB_TOKEN) {
			throw new Error('GitHub API token is required to download a draft release');
		}
		// Parse arguments
		const verOrPath = this._parseVersionOrPathArg(args);
		const devArgs = this._parseDeviceArgs(args);
		const maxRetries = this._parseMaxRetriesArg(args);
		const maxJobs = this._parseMaxJobsArg(args);
		// Create home and temp directories
		this._homeDir = path.join(os.homedir(), '.particle', this._name);
		mkdirp.sync(this._homeDir);
		this._tempDir = tmp.dirSync({
			prefix: this._name + '-',
			unsafeCleanup: true // Remove the directory even if it's not empty
		}).name;
		// Initialize module cache
		this._log.info('Initializing module cache');
		this._cache = new ModuleCache({
			cacheDir: path.join(this._homeDir, 'binaries'),
			tempDir: this._tempDir,
			log: this._log
		});
		await this._cache.init();
		// Get module binaries
		let modules = [];
		if (verOrPath) {
			modules = await this._getModules(verOrPath, { noCache: !args.cache, draft: args.draft });
			modules = this._filterModules(modules, args);
		}
		// Initialize flash interface
		this._log.info('Initializing flash interface');
		if (args.openocd) {
			this._ocd = new OpenOcdFlashInterface({ log: this._log });
			await this._ocd.init(args);
		}
		if (!args.control) {
			this._dfu = new DfuFlashInterface({ log: this._log });
			await this._dfu.init();
		}
		this._usb = new UsbFlashInterface({ log: this._log });
		await this._usb.init();
		// Get target devices
		this._log.info('Enumerating local devices');
		let devs = await this._listLocalDevices({ maxRetries, maxJobs });
		devs = await this._getTargetDevices(devs, devArgs);
		if (args['mark-development']) {
			await this._markLocalDevicesAsDevelopment(devs);
		}
		// Flash module binaries
		this._log.info('Flashing target devices');
		await this._flashDevices(devs, modules, { maxRetries, maxJobs });
		this._log.info('Done');
	}

	async shutdown() {
		try {
			if (this._api) {
				await this._api.shutdown();
				this._api = null;
			}
			if (this._cache) {
				await this._cache.shutdown();
				this._cache = null;
			}
			if (this._usb) {
				await this._usb.shutdown();
				this._usb = null;
			}
			if (this._dfu) {
				await this._dfu.shutdown();
				this._dfu = null;
			}
			if (this._ocd) {
				await this._ocd.shutdown();
				this._ocd = null;
			}
		} catch (err) {
			this._log.warn(err.message);
		}
	}

	async _flashDevices(devs, modules, { maxRetries = 0, maxJobs = Infinity } = {}) {
		const flashers = [];
		this._log.verbose('Target devices:');
		for (let i = 0; i < devs.length; ++i) {
			const dev = devs[i];
			const platform = platformForId(dev.platformId);
			this._log.verbose(`${i + 1}. ${dev.id} (${platform.displayName})`);
			const name = 'device_' + (i + 1).toString();
			const log = this._log.addTag(`[Device ${i + 1}]`);
			dev.log = log;
			const f = new Flasher({
				name,
				device: dev,
				dfu: this._dfu,
				usb: this._usb,
				tempDir: this._tempDir,
				log
			});
			flashers.push(f);
		}
		let error = null; // First error
		const limit = pLimit(maxJobs);
		const promises = flashers.map(f => limit(async () => {
			try {
				await f.run(modules, { maxRetries });
			} catch (err) {
				f.log.error(err.message);
				if (!error) {
					error = err;
				}
			}
		}));
		await Promise.all(promises);
		if (error) {
			throw error;
		}
	}

	async _getTargetDevices(localDevs, devArgs) {
		const unknownPlatformDevIds = new Set(); // IDs of devices with unknown platform
		const devMap = new Map(); // Local devices by ID
		for (const dev of localDevs) {
			devMap.set(dev.id, dev);
			if (!dev.platformId) {
				unknownPlatformDevIds.add(dev.id);
			}
		}
		const argDevIds = new Set(); // Device IDs passed via command line
		const argDevNames = new Set(); // Device names passed via command line
		for (const arg of devArgs) {
			if (arg.id) {
				const dev = devMap.get(arg.id);
				if (!dev) {
					throw new Error(`Device not found: ${arg.id}`);
				}
				if (!dev.platformId && arg.platformId) {
					dev.platformId = arg.platformId; // Platform hint
					unknownPlatformDevIds.delete(arg.id);
				}
				argDevIds.add(arg.id);
			} else {
				argDevNames.add(arg.name);
			}
		}
		if (argDevNames.size || unknownPlatformDevIds.size) {
			// Get missing info from the cloud
			this._log.info('Getting device info from the cloud');
			const api = await this._particleApi();
			const userDevs = await api.getDevices();
			for (const userDev of userDevs) {
				if (argDevNames.delete(userDev.name)) {
					if (!devMap.has(userDev.id)) {
						throw new Error(`Device not found: ${userDev.name}`);
					}
					argDevIds.add(userDev.id);
				}
				if (unknownPlatformDevIds.delete(userDev.id)) {
					const dev = devMap.get(userDev.id);
					dev.platformId = userDev.platformId;
				}
			}
			if (argDevNames.size) {
				const name = argDevNames.values().next().value;
				throw new Error(`Unknown device: ${name}`);
			}
		}
		let targetDevs = localDevs;
		if (argDevIds.size) {
			const unusedDevs = targetDevs.filter(dev => !argDevIds.has(dev.id));
			targetDevs = targetDevs.filter(dev => argDevIds.has(dev.id));
			for (const dev of unusedDevs) {
				unknownPlatformDevIds.delete(dev.id);
			}
		}
		if (unknownPlatformDevIds.size) {
			const id = unknownPlatformDevIds.values().next().value;
			throw new Error(`Unknown device: ${id}`);
		}
		return targetDevs;
	}

	async _listLocalDevices({ maxRetries = 0, maxJobs = Infinity }) {
		// Depending on the flash interface, device IDs and platform IDs may not be known at the time
		// when available devices are enumerated. As an optimization, first try to detect available
		// devices using particle-usb
		const devPlatforms = new Map();
		const usbDevs = await usb.getDevices();
		for (const dev of usbDevs) {
			try {
				await dev.open();
				devPlatforms.set(dev.id, dev.platformId);
				await dev.close();
			} catch (err) {
				// Ignore error
			}
		}
		const devs = [];
		const flashIf = this._ocd || this._dfu || this._usb;
		const foundDevs = await flashIf.listDevices();
		const limit = pLimit(maxJobs);
		const promises = foundDevs.map(dev => limit(async () => {
			let retries = maxRetries;
			for (;;) {
				try {
					if (!dev.id) {
						await dev.open();
					}
					if (!dev.platformId && devPlatforms.has(dev.id)) {
						dev.platformId = devPlatforms.get(dev.id);
					}
					devs.push(dev);
					break;
				} catch (err) {
					if (!retries) {
						throw err;
					}
					dev.log.warn(err.message);
					dev.log.warn('Retrying');
					--retries;
				} finally {
					await dev.close();
				}
			}
		}));
		await Promise.all(promises);
		if (!devs.length) {
			throw new Error('No devices found');
		}
		this._log.debug('Detected devices:');
		for (let i = 0; i < devs.length; ++i) {
			this._log.debug(`${i + 1}. ${devs[i].id}`);
		}
		return devs;
	}

	_filterModules(modules, args) {
		let types = new Set();
		// Whitelisted module types
		if (args.system) {
			types.add(ModuleType.SYSTEM_PART);
		}
		if (args.user) {
			types.add(ModuleType.USER_PART);
		}
		if (args.bootloader) {
			types.add(ModuleType.BOOTLOADER);
		}
		if (args.ncp) {
			types.add(ModuleType.NCP_FIRMWARE);
		}
		if (args.radio) {
			types.add(ModuleType.RADIO_STACK);
		}
		if (!types.size) {
			types = new Set(Object.values(ModuleType));
		}
		// Blacklisted module types
		if (args.noSystem) {
			types.delete(ModuleType.SYSTEM_PART);
		}
		if (args.noUser) {
			types.delete(ModuleType.USER_PART);
		}
		if (args.noBootloader) {
			types.delete(ModuleType.BOOTLOADER);
		}
		if (args.noNcp) {
			types.delete(ModuleType.NCP_FIRMWARE);
		}
		if (args.noRadio) {
			types.delete(ModuleType.RADIO_STACK);
		}
		return modules.filter(m => types.has(m.type));
	}

	async _getModules(verOrPath, { noCache = false, draft = false } = {}) {
		let mods = null;
		if (verOrPath.path) {
			mods = await this._cache.getModulesFromPath(verOrPath.path);
		} else {
			mods = await this._cache.getReleaseModules(verOrPath.version, { noCache, draft });
		}
		return mods;
	}

	_parseDeviceArgs(args) {
		let devArgs = args.device;
		if (!devArgs || !devArgs.length) {
			if (!args['all-devices']) {
				throw new Error('Target device is not specified');
			}
			return [];
		}
		if (args['all-devices']) {
			return [];
		}
		if (!Array.isArray(devArgs)) {
			devArgs = [devArgs];
		}
		const devs = [];
		for (const arg of devArgs) {
			const [devIdOrName, platformName] = arg.split(':');
			if (!devIdOrName) {
				throw new RangeError('Missing device ID or name');
			}
			const dev = {};
			if (isDeviceId(devIdOrName)) {
				dev.id = devIdOrName;
			} else {
				dev.name = devIdOrName;
			}
			if (platformName) {
				dev.platformId = platformForName(platformName).id; // Platform hint
			}
			devs.push(dev);
		}
		return devs;
	}

	_parseVersionOrPathArg(args) {
		let arg = args._[0];
		if (!arg) {
			throw new Error('Device OS version is not specified');
		}
		if (fs.existsSync(arg)) {
			arg = { path: arg };
		} else {
			if (arg.startsWith('v')) {
				arg = arg.slice(1);
			}
			if (!semver.valid(arg)) {
				throw new RangeError(`Invalid version number: ${args._[0]}`);
			}
			arg = { version: arg };
		}
		return arg;
	}

	_parseMaxRetriesArg(args) {
		if (args.retries === undefined) {
			return DEFAULT_MAX_RETRIES;
		}
		if (!Number.isInteger(args.retries)) {
			throw new Error(`Invalid argument: ${args.retries}`);
		}
		return args.retries;
	}

	_parseMaxJobsArg(args) {
		if (args.jobs === undefined) {
			return DEFAULT_MAX_JOBS;
		}
		if (!Number.isInteger(args.jobs)) {
			throw new Error(`Invalid argument: ${args.jobs}`);
		}
		return args.jobs;
	}

	async _particleApi() {
		if (!this._api) {
			this._api = new ParticleApi({ log: this._log });
			await this._api.init();
		}
		return this._api;
	}

	async _markLocalDevicesAsDevelopment(devs) {
		const api = await this._particleApi();
		for (const dev of devs) {
			let cloudDev;
			try {
				cloudDev = await api.getDevice(dev.id);
			} catch (e) {
				this._log.warn(`Failed to get device info for ${dev.id}`, e.message);
				continue;
			}
			if (cloudDev.product_id && !cloudDev.development) {
				this._log.info(`Marking ${dev.id} as development`);
				try {
					await api.markDevelopment(dev.id, cloudDev.product_id);
				} catch (e) {
					this._log.warn(`Failed to mark ${dev.id} as development`, e.message);
				}
			}
		}
	}
}

module.exports = {
	App
};
