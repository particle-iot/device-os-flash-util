const { Device, FlashInterface, StorageType } = require('./device');
const { platformCommonsForGen } = require('./platform');
const { delay, execCommand, formatCommand, isSpace, isPrintable, toUInt32Hex } = require('./util');

const usb = require('usb');
const Telnet = require('telnet-client');
const which = require('which');

const EventEmitter = require('events');
const { spawn } = require('child_process');

const AdapterType = {
	DAPLINK: 'daplink',
	STLINK_V2: 'stlink_v2'
};

// Supported debuggers
const ADAPTER_INFO = [
	{
		type: AdapterType.DAPLINK,
		displayName: 'DAPLink',
		usbVendorId: 0x0d28,
		usbProductId: 0x0204,
		interfaceConfig: 'cmsis-dap.cfg',
		serialParam: 'cmsis_dap_serial',
		transport: 'swd',
		platformGen: [3, 2]
	},
	{
		type: AdapterType.STLINK_V2,
		displayName: 'ST-LINK/V2',
		usbVendorId: 0x0483,
		usbProductId: 0x3748,
		interfaceConfig: 'stlink-v2.cfg', // Deprecated in recent versions of OpenOCD
		serialParam: 'hla_serial',
		transport: 'hla_swd',
		platformGen: [2]
	}
];

const ADAPTER_INFO_BY_USB_ID = ADAPTER_INFO.reduce((map, info) =>
		map.set(makeUsbDeviceId(info.usbVendorId, info.usbProductId), info), new Map());

const DEFAULT_TELNET_PORT = 4444;
const DEFAULT_COMMAND_TIMEOUT = 3000;
const FLASH_COMMAND_TIMEOUT = 2 * 60 * 1000;
const DELAY_AFTER_RESET = 1000; // Avoid resetting devices too frequently
const DEVICE_ID_SIZE = 24; // Hex-encoded

function makeUsbDeviceId(vendorId, productId) {
	return [vendorId, productId].map(id => id.toString(16).padStart(4, '0')).join(':');
}

function trimTelnetResponseLine(line) {
	let begin = 0;
	for (; begin < line.length; ++begin) {
		const c = line.charAt(begin);
		if (!isSpace(c) && isPrintable(c)) {
			break;
		}
	}
	let end = line.length - 1;
	for (; end > begin; --end) {
		const c = line.charAt(end);
		if (!isSpace(c) && isPrintable(c)) {
			break;
		}
	}
	return line.slice(begin, end + 1);
}

function splitTelnetResponseLines(resp) {
	// Process backspace characters
	let i = 0;
	while (i < resp.length) {
		const c = resp.charAt(i);
		if (c === '\b') {
			// Remove this and the preceding character
			const left = (i > 0) ? resp.slice(0, i - 1) : '';
			const right = resp.slice(i + 1);
			resp = left + right;
			if (i > 0) {
				--i;
			}
		} else {
			++i;
		}
	}
	let lines = resp.split('\n');
	// Trim whitespace and non-printable characters
	lines = lines.map(line => trimTelnetResponseLine(line));
	// Remove empty lines
	return lines.filter(line => !!line);
}

const OpenOcdState = {
	STOPPED: 'stopped',
	STARTING: 'starting',
	RUNNING: 'running',
	STOPPING: 'stopping'
};

class OpenOcd extends EventEmitter {
	constructor({ log }) {
		super();
		this._log = log;
		this._proc = null;
		this._procRunning = false;
		this._telnet = null;
		this._telnetConnected = false;
		this._cmdRunning = false;
		this._state = OpenOcdState.STOPPED;
	}

	async start(port, args) {
		if (this._state !== OpenOcdState.STOPPED) {
			throw new Error('OpenOCD is already running');
		}
		try {
			this._setState(OpenOcdState.STARTING);
			await this._startProcess(args);
			await this._connectTelnet(port);
			if (this._state === OpenOcdState.STOPPING) {
				throw new Error('Stop requested');
			}
			this._setState(OpenOcdState.RUNNING);
		} catch (err) {
			await this.stop();
			throw err;
		}
	}

	async stop() {
		if (this._state === OpenOcdState.STOPPED) {
			return;
		}
		if (this._state === OpenOcdState.STOPPING) {
			return new Promise((resolve, reject) => {
				this.once('stopped', resolve);
			});
		}
		this._setState(OpenOcdState.STOPPING);
		await this._stopProcess();
		await this._disconnectTelnet();
		this._setState(OpenOcdState.STOPPED);
	}

	async command(cmd, { timeout = DEFAULT_COMMAND_TIMEOUT } = {}) {
		if (this._state !== OpenOcdState.RUNNING) {
			throw new Error('OpenOCD is not running');
		}
		if (this._cmdRunning) {
			throw new Error('Another command is running');
		}
		this._cmdRunning = true;
		try {
			this._log.debug('>', cmd);
			let resp = await this._telnet.exec(cmd, { execTimeout: timeout });
			resp = splitTelnetResponseLines(resp);
			for (let line of resp) {
				this._log.debug('<', line);
			}
			return resp.join('\n');
		} finally {
			this._cmdRunning = false;
		}
	}

	get state() {
		return this._state;
	}

	set log(log) {
		this._log = log;
	}

	get log() {
		return this._log;
	}

	async _startProcess(args) {
		return new Promise((resolve, reject) => {
			this._log.debug('$', formatCommand('openocd', args));
			let proc = spawn('openocd', args, {
				stdio: [
					'ignore', // stdin
					'pipe', // stdout
					'pipe' // stderr
				]
			});
			const onExit = () => {
				if (proc) {
					proc.kill();
				}
			};
			process.once('exit', onExit);
			let error = null; // Startup error
			proc.once('exit', async (code, signal) => {
				if (proc) {
					proc = null;
					process.off('exit', onExit);
					if (signal) {
						error = new Error(`OpenOCD was terminated by ${signal}`);
					} else if (code !== 0) {
						error = new Error(`OpenOCD exited with code ${code}`);
					} else if (this._state !== OpenOcdState.STOPPING) {
						error = new Error(`OpenOCD exited unexpectedly`);
					}
					this._procRunning = false;
					this.emit('_processStopped');
					if (error) {
						await this._error(error);
					}
				}
			});
			proc.once('error', async (err) => {
				if (proc) {
					proc = null;
					process.off('exit', onExit);
					error = new Error(`OpenOCD process error: ${err.message}`);
					this._procRunning = false;
					this.emit('_processStopped');
					await this._error(error);
				}
			});
			let output = '';
			// proc.stdout.on('data', d => output += d);
			proc.stderr.on('data', d => output += d);
			setTimeout(() => {
				if (!error) {
					this._proc = proc;
					this._procRunning = true;
					resolve();
				} else {
					error = new Error(error.message + ('\n' + output).trimRight());
					reject(error);
				}
			}, 2000);
		});
	}

	async _stopProcess() {
		if (this._procRunning) {
			const stopped = new Promise((resolve, reject) => {
				this.once('_processStopped', resolve);
			});
			let kill = true;
			if (this._telnetConnected && !this._cmdRunning) {
				try {
					this._log.debug('> shutdown');
					await this._telnet.send('shutdown');
					await this._telnet.end();
					kill = false;
				} catch (err) {
					this._log.warn(err.message);
				}
			}
			if (kill) {
				this._proc.kill();
			}
			await stopped;
			this._procRunning = false;
		}
	}

	async _connectTelnet(port) {
		let telnet = new Telnet();
		telnet.once('close', async () => {
			if (telnet) {
				telnet = null;
				this._telnetConnected = false;
				this.emit('_telnetDisconnected');
				if (this._state !== OpenOcdState.STOPPING) {
					await this._error(new Error('Telnet connection closed unexpectedly'));
				}
			}
		});
		telnet.once('error', async (err) => {
			if (telnet) {
				const t = telnet;
				telnet = null;
				await t.destroy();
				this._telnetConnected = false;
				this.emit('_telnetDisconnected');
				if (typeof err === 'string') { // :(
					err = new Error(err);
				}
				await this._error(err);
			}
		});
		await telnet.connect({
			port,
			shellPrompt: '\r> ',
			timeout: 5000
		});
		this._telnet = telnet;
		this._telnetConnected = true;
	}

	async _disconnectTelnet() {
		if (this._telnetConnected) {
			const disconnected = new Promise((resolve, reject) => {
				this.once('_telnetDisconnected', resolve);
			});
			try {
				await this._telnet.end();
			} catch (err) {
				this._log.warn(err.message);
				await this._telnet.destroy();
			}
			await disconnected;
			this._telnetConnected = false;
		}
		this._cmdRunning = false;
	}

	async _error(err) {
		if (this._state !== OpenOcdState.STOPPED) {
			this.emit('error', err);
			await this.stop();
		}
	}

	_setState(state) {
		if (this._state !== state) {
			this._state = state;
			this.emit(state);
		}
	}
}

class OpenOcdDevice extends Device {
	constructor({ info, serial, port, log }) {
		super({ log });
		this._info = info;
		this._serial = serial;
		this._port = port || DEFAULT_TELNET_PORT;
		this._target = null;
		this._openocd = new OpenOcd({ log });
		this._openocd.on('error', err => {
			this._log.error(err.message);
		});
	}

	async open(options) {
		if (this._openocd.state !== OpenOcdState.STOPPED) {
			throw new Error('Device is already open');
		}
		try {
			if (!this._target) {
				this._log.verbose('Detecting target platform');
				const platform = await this._detectPlatform();
				this._log.verbose('Target platform: Gen', platform.gen);
				this._target = platform.openOcd;
			}
			const cmds = [
				`${this._info.serialParam} ${this._serial}`,
				`telnet_port ${this._port}`,
				'gdb_port disabled',
				'tcl_port disabled'
			];
			if (this._target.resetTarget) {
				cmds.push('reset_config connect_assert_srst srst_only srst_nogate');
			}
			cmds.push('init');
			const args = [
				'-f', `interface/${this._info.interfaceConfig}`,
				'-f', `target/${this._target.targetConfig}`,
				'-c', cmds.join('; ')
			];
			this._log.verbose(`Starting OpenOCD; port: ${this._port}`);
			await this._openocd.start(this._port, args);
			if (this._target.resetTarget) {
				await this._openocd.command('reset init');
			}
			if (!this.id) {
				this.id = await this._getDeviceId();
				this._log.verbose('Device ID:', this.id);
			}
		} catch (err) {
			await this.close();
			throw err;
		}
	}

	async close() {
		if (this._openocd.state !== OpenOcdState.STOPPED) {
			if (this._target.resetTarget) {
				await this._openocd.command('reset run');
				await delay(DELAY_AFTER_RESET);
			}
			this._log.verbose('Stopping OpenOCD');
			await this._openocd.stop();
		}
	}

	async reset() {
		await this._openocd.command('reset run');
		await delay(DELAY_AFTER_RESET);
	}

	async prepareToFlash() {
		await this._openocd.command('reset init');
	}

	async flashModule(module) {
		if (!this.canFlashModule(module)) {
			throw new Error('Unsupported module');
		}
		await this.writeToFlash(module.file, module.storage, module.address);
	}

	async writeToFlash(file, storage, address) {
		if (!this.canWriteToFlash(storage)) {
			throw new Error('Unsupported storage');
		}
		const addrStr = toUInt32Hex(address);
		if (this._target.unlockFlash) {
			const resp = await this._openocd.command(`flash write_image erase unlock ${file} ${addrStr}`, { timeout: FLASH_COMMAND_TIMEOUT });
			if (!resp.match(/wrote \d+ bytes from file/)) {
				throw new Error('Programming failed' + ('\n' + resp).trimRight());
			}
		} else {
			const resp = await this._openocd.command(`program ${file} ${addrStr}`, { timeout: FLASH_COMMAND_TIMEOUT });
			if (!resp.includes('** Programming Finished **')) {
				throw new Error('Programming failed' + ('\n' + resp).trimRight());
			}
		}
	}

	canFlashModule(module) {
		return this.canWriteToFlash(module.storage);
	}

	canWriteToFlash(storage) {
		return (storage === StorageType.INTERNAL_FLASH);
	}

	get adapterInfo() {
		return this._info;
	}

	get serialNumber() {
		return this._serial;
	}

	set log(log) {
		super.log = log;
		this._openocd.log = log;
	}

	async _detectPlatform() {
		let openocd = null;
		try {
			const platformGen = this._info.platformGen;
			if (platformGen.length === 1) {
				return platformCommonsForGen(platformGen[0]).openOcd;
			}
			const trans = this._info.transport;
			if (trans !== 'swd') {
				throw new Error('Unsupported transport');
			}
			const type = 'cortex_m';
			const cmds = [
				`${this._info.serialParam} ${this._serial}`,
				`telnet_port ${this._port}`,
				'gdb_port disabled',
				'tcl_port disabled',
				`transport select ${trans}`,
				'adapter_khz 1000',
				'swd newdap chip cpu -enable',
				'dap create chip.dap -chain-position chip.cpu',
				`target create chip.cpu ${type} -dap chip.dap`,
				'reset_config connect_assert_srst srst_only srst_nogate',
				'init'
			];
			const args = [
				'-f', `interface/${this._info.interfaceConfig}`,
				'-c', cmds.join('; ')
			];
			openocd = new OpenOcd({ log: this._log });
			await openocd.start(this._port, args);
			const resp = await openocd.command('dap info');
			let platform = null;
			for (let gen of platformGen) {
				// TODO: This will likely not work for future platforms
				const p = platformCommonsForGen(gen);
				if (resp.includes(p.openOcd.mcuManufacturer)) {
					platform = p;
					break;
				}
			}
			await openocd.command('reset run');
			await delay(DELAY_AFTER_RESET);
			if (!platform) {
				throw new Error('Unknown target platform');
			}
			return platform;
		} finally {
			if (openocd) {
				await openocd.stop();
			}
		}
	}

	async _getDeviceId() {
		const addrStr = toUInt32Hex(this._target.deviceIdAddress);
		const prefix = this._target.deviceIdPrefix || ''; // Hex-encoded
		const size = Math.floor((DEVICE_ID_SIZE - prefix.length) / 2);
		const resp = await this._openocd.command(`mdb ${addrStr} ${size}`);
		const rx = new RegExp(`^${addrStr}:\\s((?:[0-9A-Za-z]{2}\\s?){${size}})$`);
		const match = rx.exec(resp);
		if (!match || match.length !== 2) {
			throw new Error('Unable to read device ID' + ('\n' + resp).trimRight());
		}
		const id = prefix + match[1].replace(/\s/g, '').toLowerCase();
		return id;
	}
}

class OpenOcdFlashInterface extends FlashInterface {
	constructor({ log }) {
		super({ log });
	}

	async init() {
		try {
			await which('openocd');
		} catch (err) {
			throw new Error('OpenOCD is not installed');
		}
	}

	async shutdown() {
	}

	async listDevices() {
		const adapters = await this._listAdapters();
		if (!adapters.length) {
			this._log.verbose("No debug adapters found");
			return [];
		}
		this._log.verbose('Detected debug adapters:');
		for (let ad of adapters) {
			this._log.verbose(`${ad.index}. ${ad.info.displayName}; s/n: ${ad.serial}`);
		}
		return adapters.map(ad => new OpenOcdDevice({
			info: ad.info,
			serial: ad.serial,
			port: DEFAULT_TELNET_PORT + ad.index - 1,
			log: this._log.addTag(`[Adapter ${ad.index}]`)
		}));
	}

	async openDeviceById(id, options) {
		const devs = await this.listDevices();
		for (let dev of devs) {
			try {
				await dev.open(options);
			} catch (err) {
				this._log.warn(err.message);
				continue; // Ignore error
			}
			if (dev.id === id) {
				return dev;
			}
			await dev.close();
		}
		throw new Error('Device not found');
	}

	async _listAdapters() {
		const adapters = [];
		const usbDevs = usb.getDeviceList();
		let lastIndex = 0;
		for (let usbDev of usbDevs) {
			const usbDesc = usbDev.deviceDescriptor;
			const info = ADAPTER_INFO_BY_USB_ID.get(makeUsbDeviceId(usbDesc.idVendor, usbDesc.idProduct));
			if (info) {
				try {
					const serial = await this._getAdapterSerial(usbDev);
					adapters.push({ info, serial, index: ++lastIndex });
				} catch (err) {
					this._log.warn(err.message);
				}
			}
		}
		return adapters;
	}

	async _getAdapterSerial(usbDev) {
		return new Promise((resolve, reject) => {
			try {
				usbDev.open();
			} catch (err) {
				return reject(new Error(`Unable to open USB device: ${err.message}`));
			}
			const descIndex = usbDev.deviceDescriptor.iSerialNumber;
			usbDev.controlTransfer(
				usb.LIBUSB_ENDPOINT_IN, // bmRequestType
				usb.LIBUSB_REQUEST_GET_DESCRIPTOR, // bRequest
				(usb.LIBUSB_DT_STRING << 8) | descIndex, // wValue
				0x0409, // wIndex (0x0409: English - United States)
				255, // wLength
				(err, buf) => {
					try {
						usbDev.close();
					} catch (err) {
						this._log.warn(err.message);
					}
					if (err) {
						return reject(err);
					}
					// OpenOCD uses libusb_get_string_descriptor_ascii() which replaces non-ASCII characters with '?'
					let serial = '';
					for (let i = 2; i < buf.length; i += 2) { // Skip bLength and bDescriptorType fields
						const c = buf[i];
						if (c >= 0x80 || buf[i + 1]) { // Non-ASCII character
							serial += '?';
						} else if (c <= 0x20 || c === 0x7f) { // SPACE, DEL or a control character
							serial += '\\x' + Number(c).toString(16).padStart(2, '0');
						} else {
							serial += String.fromCharCode(c);
						}
					}
					resolve(serial);
				}
			);
		});
	}
}

module.exports = {
	AdapterType,
	OpenOcdFlashInterface
};
