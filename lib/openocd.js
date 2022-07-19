const { Device, FlashInterface } = require('./device');
const { StorageType } = require('./platform');
const { delay, formatCommand, isSpace, isPrintable, toUInt32Hex } = require('./util');

const usb = require('usb');
const Telnet = require('telnet-client');
const which = require('which');

const EventEmitter = require('events');
const { spawn } = require('child_process');

const AdapterType = {
	DAPLINK: 'daplink',
	STLINK_V2: 'stlink_v2',
	JLINK: 'jlink'
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
		platformMcu: ['nrf52840', 'stm32f2xx', 'rtl872x']
	},
	{
		// Support for hs-probe: https://github.com/probe-rs/hs-probe
		// supports usb bulk (v2)
		type: AdapterType.DAPLINK,
		displayName: 'hs-probe',
		usbVendorId: 0x1209,
		usbProductId: 0x4853,
		interfaceConfig: 'cmsis-dap.cfg',
		serialParam: 'cmsis_dap_serial',
		transport: 'swd',
		platformMcu: ['nrf52840', 'stm32f2xx', 'rtl872x']
	},
	{
		type: AdapterType.DAPLINK,
		displayName: 'DAPLink',
		usbVendorId: 0xc251,
		usbProductId: 0xf001,
		interfaceConfig: 'cmsis-dap.cfg',
		serialParam: 'cmsis_dap_serial',
		transport: 'swd',
		// This is a problematic v1 DAPLink that is being misdetected as DAPv2 (usb bulk)
		// Force using HID (DAPv1) interface
		extraInitialization: 'cmsis_dap_backend hid',
		platformMcu: ['nrf52840', 'stm32f2xx', 'rtl872x']
	},
	{
		type: AdapterType.STLINK_V2,
		displayName: 'ST-LINK/V2',
		usbVendorId: 0x0483,
		usbProductId: 0x3748,
		interfaceConfig: 'stlink-v2.cfg', // Deprecated in recent versions of OpenOCD
		serialParam: 'hla_serial',
		transport: 'hla_swd',
		platformMcu: ['stm32f2xx']
	},
	{
		type: AdapterType.JLINK,
		displayName: 'JLink',
		usbVendorId: 0x1366,
		usbProductId: 0x0101,
		interfaceConfig: 'jlink.cfg',
		serialParam: 'jlink serial',
		transport: 'swd',
		platformMcu: ['nrf52840', 'stm32f2xx', 'rtl872x']
	}
];

// Supported MCUs
const MCU_INFO = [
	{
		baseMcu: 'stm32f2xx',
		targetConfig: 'stm32f2x.cfg',
		mcuManufacturer: 'STMicroelectronics', // JEDEC manufacturer string
		deviceIdAddress: 0x1fff7a10, // UID
		// By default, Device OS for Gen 2 platforms is built without support for JTAG/SWD debugging,
		// so the target device needs to be reset when attaching to it with a debugger
		assertSrstOnConnect: true,
		// The bootloader's sector in flash may be locked
		unlockFlash: true
	},
	{
		baseMcu: 'nrf52840',
		targetConfig: 'nrf52.cfg',
		mcuManufacturer: 'Nordic VLSI ASA',
		deviceIdAddress: 0x10000060, // FICR
		deviceIdPrefix: 'e00fce68'
	},
	{
		baseMcu: 'rtl872x',
		targetConfig: 'rtl872x.tcl',
		mcuManufacturer: 'Realtek',
		deviceIdProcedure: 'rtl872x_read_efuse_mac; rtl872x_wdg_reset',
		deviceIdPrefix: '0a10aced2021',
		deviceIdRegex: new RegExp(`MAC:\\s([A-Fa-f0-9]{2}):([A-Fa-f0-9]{2}):([A-Fa-f0-9]{2}):([A-Fa-f0-9]{2}):([A-Fa-f0-9]{2}):([A-Fa-f0-9]{2})`),
		// FIXME: verification is disabled, it fails on some versions of OpenOCD
		flashWriteProcedure: (binary, address) => {
			return `rtl872x_flash_write_bin_ext ${binary} ${address} 1 1`;
		},
		resetRunProcedure: 'rtl872x_wdg_reset',
	}
];

const ADAPTER_INFO_BY_USB_ID = ADAPTER_INFO.reduce((map, info) =>
	map.set(makeUsbDeviceId(info.usbVendorId, info.usbProductId), info), new Map());
const MCU_INFO_BY_NAME = MCU_INFO.reduce((map, info) => map.set(info.baseMcu, info), new Map());

const DEFAULT_TELNET_PORT = 4444;

const OPENOCD_STARTUP_TIMEOUT = 10000;
const TELNET_CONNECT_TIMEOUT = 10000;
const DEFAULT_COMMAND_TIMEOUT = 10000;
const FLASH_COMMAND_TIMEOUT = 2 * 60 * 1000;

const MIN_OPENOCD_RESTART_INTERVAL = 1000;
const MAX_OPENOCD_RESTART_INTERVAL = 3000;
const MIN_DEVICE_RESET_INTERVAL = 5000;

const DEVICE_ID_SIZE = 24; // Hex-encoded

const ARM_MAX_DEBUG_PORTS = 5;

function getMcuInfo(mcu) {
	const info = MCU_INFO_BY_NAME.get(mcu);
	if (!info) {
		throw new Error(`Unknown MCU: ${mcu}`);
	}
	return info;
}

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

	async start(args, port) {
		if (this._state !== OpenOcdState.STOPPED) {
			throw new Error('OpenOCD is already running');
		}
		try {
			this._setState(OpenOcdState.STARTING);
			await this._startProcess(args);
			if (port) {
				await this._connectTelnet(port);
			}
			if (this._state !== OpenOcdState.STARTING) {
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
			return new Promise(resolve => {
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
			for (const line of resp) {
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

	get isCommandRunning() {
		return this._cmdRunning;
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
			let error = null;
			proc.once('exit', async (code, signal) => {
				if (proc) {
					proc = null;
					process.off('exit', onExit);
					if (!error) {
						if (signal) {
							error = new Error(`OpenOCD was terminated by ${signal}`);
						} else if (code !== 0) {
							error = new Error(`OpenOCD exited with code ${code}`);
						} else if (this._state !== OpenOcdState.STOPPING) {
							error = new Error(`OpenOCD exited unexpectedly`);
						}
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
					if (!error) {
						error = new Error(`OpenOCD process error: ${err.message}`);
					}
					this._procRunning = false;
					this.emit('_processStopped');
					await this._error(error);
				}
			});
			let output = ''; // Combined stdout and stderr output
			const parseOutput = (data) => {
				output += data;
				if (output.match(/Listening on port \d+ for telnet connections/i)) {
					this.emit('_processReady');
				}
			};
			const { stdout, stderr } = proc;
			stdout.on('data', parseOutput);
			stderr.on('data', parseOutput);
			const timer = setTimeout(() => {
				if (proc) {
					if (!error) {
						error = new Error('Timeout while waiting for OpenOCD to start');
					}
					proc.kill();
				}
			}, OPENOCD_STARTUP_TIMEOUT);
			let onReady = null;
			let onStopped = null;
			onReady = () => {
				stdout.off('data', parseOutput);
				stderr.off('data', parseOutput);
				this.off('_processStopped', onStopped);
				clearTimeout(timer);
				this._proc = proc;
				this._procRunning = true;
				resolve();
			};
			onStopped = () => {
				stdout.off('data', parseOutput);
				stderr.off('data', parseOutput);
				this.off('_processReady', onReady);
				clearTimeout(timer);
				const err = new Error(error.message + ('\n' + output).trimRight());
				reject(err);
			};
			this.once('_processReady', onReady);
			this.once('_processStopped', onStopped);
		});
	}

	async _stopProcess() {
		if (this._procRunning) {
			const stopped = new Promise(resolve => {
				this.once('_processStopped', resolve);
			});
			let kill = true;
			if (this._telnetConnected && !this._cmdRunning) {
				try {
					this._log.debug('> shutdown');
					await this._telnet.send('shutdown', { timeout: 1000 });
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
				let msg = null;
				if (typeof err === 'string') { // :(
					msg = err;
				} else {
					msg = err.message;
				}
				err = new Error(`Telnet connection error: ${msg}`);
				await this._error(err);
			}
		});
		await telnet.connect({
			port,
			shellPrompt: '> ',
			timeout: TELNET_CONNECT_TIMEOUT
		});
		this._telnet = telnet;
		this._telnetConnected = true;
	}

	async _disconnectTelnet() {
		if (this._telnetConnected) {
			const disconnected = new Promise(resolve => {
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
		const now = Date.now();
		this._lastStopped = now;
		this._lastReset = now;
		this._openocd = new OpenOcd({ log });
		this._openocd.on('error', err => {
			this._log.error(err.message);
		});
	}

	async open(/* options */) {
		if (this._openocd.state !== OpenOcdState.STOPPED) {
			throw new Error('Device is already open');
		}
		try {
			if (!this._target) {
				this._log.verbose('Detecting target platform');
				let platform = null;
				try {
					platform = await this._detectPlatform({ assertSrst: false });
				} catch (err) {
					this._log.verbose('Retrying with asserted SRST');
					platform = await this._detectPlatform({ assertSrst: true });
				}
				this._log.verbose(`Target platform: ${platform.baseMcu}`);
				this._target = platform;
			}
			const cmds = [
				`${this._info.serialParam} ${this._serial}`,
				`telnet_port ${this._port}`,
				'gdb_port disabled',
				'tcl_port disabled'
			];
			if (this._target.assertSrstOnConnect) {
				cmds.push('reset_config connect_assert_srst srst_only srst_nogate');
			}
			cmds.push('init');

			if (this._info.extraInitialization) {
				cmds.unshift(this._info.extraInitialization);
			}

			const args = [
				'-f', `interface/${this._info.interfaceConfig}`,
				'-f', `target/${this._target.targetConfig}`,
				'-c', cmds.join('; ')
			];
			await this._startOpenOcd(args, { resetAndHalt: this._target.assertSrstOnConnect });
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
		if (this._target && this._target.assertSrstOnConnect && this._openocd.state === OpenOcdState.RUNNING &&
				!this._openocd.isCommandRunning) {
			try {
				await this._resetTarget('run');
			} catch (err) {
				// Ignore error
			}
		}
		await this._stopOpenOcd();
	}

	async reset() {
		await this._resetTarget('run');
	}

	async prepareToFlash() {
		await this._resetTarget('init');
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
		if (!this._target.flashWriteProcedure) {
			if (this._target.unlockFlash) {
				const resp = await this._openocd.command(`flash write_image erase unlock ${file} ${addrStr}`, { timeout: FLASH_COMMAND_TIMEOUT });
				if (!resp.match(/wrote \d+ bytes from file/i)) {
					throw new Error('Programming failed' + ('\n' + resp).trimRight());
				}
			} else {
				const resp = await this._openocd.command(`program ${file} ${addrStr}`, { timeout: FLASH_COMMAND_TIMEOUT });
				if (!resp.match(/\* Programming Finished \*/i)) {
					throw new Error('Programming failed' + ('\n' + resp).trimRight());
				}
			}
		} else {
			const cmd = this._target.flashWriteProcedure(file, addrStr);
			const resp = await this._openocd.command(cmd, { timeout: FLASH_COMMAND_TIMEOUT });
			if (!resp.match(/\* Programming Finished \*/i)) {
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

	get log() {
		return super.log;
	}

	async _detectPlatform({ assertSrst = false } = {}) {
		try {
			const platformMcu = this._info.platformMcu;
			if (platformMcu.length === 1) {
				return getMcuInfo(platformMcu[0]);
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
				`target create chip.cpu ${type} -dap chip.dap`
			];
			if (assertSrst) {
				cmds.push('reset_config connect_assert_srst srst_only srst_nogate');
			}
			cmds.push('init');

			if (this._info.extraInitialization) {
				cmds.unshift(this._info.extraInitialization);
			}

			const args = [
				'-f', `interface/${this._info.interfaceConfig}`,
				'-c', cmds.join('; ')
			];
			await this._startOpenOcd(args, { resetAndHalt: assertSrst });
			let resp = '';
			for (let i = 0; i < ARM_MAX_DEBUG_PORTS; i++) {
				const r = await this._openocd.command(`dap info ${i}`);
				if (r.match(/No AP found at this ap/i)) {
					break;
				}
				resp += r;
			}
			let platform = null;
			for (const mcu of platformMcu) {
				const p = getMcuInfo(mcu);
				if (resp.includes(p.mcuManufacturer)) {
					platform = p;
					break;
				}
			}
			if (assertSrst) {
				await this._resetTarget('run');
			}
			if (!platform) {
				throw new Error('Unknown target platform' + ('\n' + resp).trimRight());
			}
			return platform;
		} finally {
			await this._stopOpenOcd();
		}
	}

	async _getDeviceId() {
		const prefix = this._target.deviceIdPrefix || ''; // Hex-encoded
		let match = null;
		let resp;
		if (this._target.deviceIdAddress) {
			const addrStr = toUInt32Hex(this._target.deviceIdAddress);
			const size = Math.floor((DEVICE_ID_SIZE - prefix.length) / 2);
			resp = await this._openocd.command(`mdb ${addrStr} ${size}`);
			const rx = new RegExp(`^${addrStr}:\\s((?:[0-9A-Za-z]{2}\\s?){${size}})$`);
			match = rx.exec(resp);
		} else if (this._target.deviceIdProcedure) {
			resp = await this._openocd.command(this._target.deviceIdProcedure);
			match = this._target.deviceIdRegex.exec(resp);
			if (match && match.length > 1) {
				// Fixup results a bit if regex got device id that consists of multiple parts
				for (let i = 2; i < match.length; i++) {
					match[1] += match[i];
				}
				match.length = 2;
			}
		}
		if (!match || match.length !== 2) {
			throw new Error('Unable to read device ID' + ('\n' + resp).trimRight());
		}
		const id = prefix + match[1].replace(/\s/g, '').toLowerCase();
		return id;
	}

	async _startOpenOcd(args, { resetAndHalt = false } = {}) {
		const now = Date.now();
		let startDelay = 0;
		const restartInterval = MIN_OPENOCD_RESTART_INTERVAL +
				Math.ceil((MAX_OPENOCD_RESTART_INTERVAL - MIN_OPENOCD_RESTART_INTERVAL) * Math.random());
		let dt = now - this._lastStopped;
		if (dt < restartInterval) {
			startDelay = restartInterval - dt;
		}
		if (resetAndHalt) {
			dt = now - this._lastReset;
			if (dt < MIN_DEVICE_RESET_INTERVAL) {
				dt = MIN_DEVICE_RESET_INTERVAL - dt;
				if (dt > startDelay) {
					startDelay = dt;
				}
			}
		}
		if (startDelay) {
			await delay(startDelay);
		}
		try {
			this._log.debug(`Starting OpenOCD; port: ${this._port}`);
			await this._openocd.start(args, this._port);
		} catch (err) {
			this._lastStopped = Date.now();
			throw err;
		}
		if (resetAndHalt) {
			await this._resetTarget('halt');
		}
	}

	async _stopOpenOcd() {
		if (this._openocd.state !== OpenOcdState.STOPPED) {
			this._log.debug('Stopping OpenOCD');
			await this._openocd.stop();
			this._lastStopped = Date.now();
		}
	}

	async _resetTarget(mode = 'run') {
		const dt = Date.now() - this._lastReset;
		if (dt < MIN_DEVICE_RESET_INTERVAL) {
			await delay(MIN_DEVICE_RESET_INTERVAL - dt);
		}
		if (mode === 'run' && this._target && this._target.resetRunProcedure) {
			await this._openocd.command(this._target.resetRunProcedure);
		} else {
			const resp = await this._openocd.command('reset ' + mode);
			if ((mode === 'init' || mode === 'halt') && !resp.match(/target halted due to/i)) {
				this._log.debug('Falling back to soft reset and halt');
				await this._openocd.command('soft_reset_halt');
			}
		}
		this._lastReset = Date.now();
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
			this._log.verbose('No debug adapters found');
			return [];
		}
		this._log.verbose('Detected debug adapters:');
		for (const ad of adapters) {
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
		for (const dev of devs) {
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
		for (const usbDev of usbDevs) {
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
