import { OpenOcdFlashInterface } from './openocd';
import { DfuFlashInterface } from './dfu';
import { UsbFlashInterface } from './usb';
import { ModuleCache } from './module';
import { ParticleApi } from './api';
import { platformForName } from './platform';
import { isDeviceId } from './util';

import * as usb from 'particle-usb';
import tmp from 'tmp';
import mkdirp from 'mkdirp';
import semver from 'semver';

import * as os from 'os';
import * as path from 'path';

tmp.setGracefulCleanup();

export class App {
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
		// Parse arguments
		const version = this._parseVersionArg(args);
		const devArgs = this._parseDeviceArgs(args);
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
		// Initialize flash interface
		this._log.info('Initializing flash interface');
		if (args.openocd) {
			this._ocd = new OpenOcdFlashInterface({ log: this._log });
			await this._ocd.init();
		}
		this._dfu = new DfuFlashInterface({ log: this._log });
		await this._dfu.init();
		this._usb = new UsbFlashInterface({ log: this._log });
		await this._usb.init();
		// Get target devices
		this._log.info('Enumerating local devices');
		let devs = await this._listLocalDevices();
		devs = await this._getTargetDevices(devs, devArgs);
		await this._closeDevices(devs.unused);
		devs = devs.target;
		// await this._cache.getReleaseModules(version, { noCache: !args.cache });
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

	async _getTargetDevices(localDevs, devArgs) {
		const unknownPlatformDevIds = new Set(); // IDs of devices with unknown platform
		const devMap = new Map(); // Local devices by ID
		for (let dev of localDevs) {
			devMap.set(dev.id, dev);
			if (!dev.platformId) {
				unknownPlatformDevIds.add(dev.id);
			}
		}
		const argDevIds = new Set(); // Device IDs passed via command line
		const argDevNames = new Set(); // Device names passed via command line
		for (let arg of devArgs) {
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
			this._log.info("Getting device info from the cloud");
			const api = await this._particleApi();
			const userDevs = await api.getDevices();
			for (let userDev of userDevs) {
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
		let target = Array.from(devMap.values());
		let unused = [];
		if (argDevIds.size) {
			unused = target.filter(dev => !argDevIds.has(dev.id));
			target = target.filter(dev => argDevIds.has(dev.id));
			for (let dev of unused) {
				unknownPlatformDevIds.delete(dev.id);
			}
		}
		if (unknownPlatformDevIds.size) {
			const id = unknownPlatformDevIds.values().next().value;
			throw new Error(`Unknown device: ${id}`);
		}
		return { target, unused };
	}

	async _releaseUnusedDevices(devs) {
		const funcs = devs.map(dev => async () => {
			await this._flasher.releaseDevice(dev.id);
		});
		await Promise.all(funcs.map(fn => fn()));
	}

	async _listLocalDevices() {
		// Depending on the flash interface, device IDs and platform IDs may not be known at the time
		// when available devices are enumerated. As an optimization, first try to detect available
		// devices using particle-usb
		const devPlatforms = new Map();
		const usbDevs = await usb.getDevices();
		for (let dev of usbDevs) {
			try {
				await dev.open();
				devPlatforms.set(dev.id, dev.platformId);
				await dev.close();
			} catch (err) {
				// Ignore error
			}
		}
		const devs = [];
		const flashIf = this._ocd || this._dfu;
		const foundDevs = await flashIf.listDevices();
		const promises = foundDevs.map(async (dev) => {
			try {
				await dev.open();
				if (!dev.platformId && devPlatforms.has(dev.id)) {
					dev.platformId = devPlatforms.get(dev.id);
				}
				devs.push(dev);
			} catch (err) {
				this._log.warn(err.message);
				await dev.close();
			}
		});
		await Promise.all(promises);
		if (!devs.length) {
			throw new Error('No devices found');
		}
		this._log.verbose('Found devices:');
		for (let i = 0; i < devs.length; ++i) {
			this._log.verbose(`${i + 1}. ${devs[i].id}`);
		}
		return devs;
	}

	_parseDeviceArgs(args) {
		let devArgs = args.device;
		if (!devArgs) {
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
		for (let arg of devArgs) {
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
				dev.platformId = platformForName(platformName); // Platform hint
			}
			devs.push(dev);
		}
		return devs;
	}

	_parseVersionArg(args) {
		let ver = args._[0];
		if (!ver) {
			throw new Error('Device OS version is not specified');
		}
		if (ver.startsWith('v')) {
			ver = ver.slice(1);
		}
		if (!semver.valid(ver)) {
			throw new RangeError(`Invalid version number: ${args._[0]}`);
		}
		return ver;
	}

	async _particleApi() {
		if (!this._api) {
			this._api = new ParticleApi({ log: this._log });
			await this._api.init();
		}
		return this._api;
	}

	async _closeDevices(devs) {
		const promises = devs.map(dev => dev.close());
		await Promise.all(promises);
	}
}
