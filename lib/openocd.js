import { Device, FlashInterface, StorageType } from './device';
import { platformCommons } from './platform';
import { isSpace, isPrintable, toUInt32Hex } from './util';

import * as usb from 'usb';
import Telnet from 'telnet-client';
import which from 'which';

import { spawn } from 'child_process';

export const AdapterType = {
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
		platformGen: 3 // For now, hardcode which platforms each debugger can be used with
	},
	{
		type: AdapterType.STLINK_V2,
		displayName: 'ST-LINK/V2',
		usbVendorId: 0x0483,
		usbProductId: 0x3748,
		interfaceConfig: 'stlink-v2.cfg', // Deprecated in recent versions of OpenOCD
		serialParam: 'hla_serial',
		platformGen: 2
	}
];

const ADAPTER_INFO_BY_USB_ID = ADAPTER_INFO.reduce((map, info) =>
		map.set(makeUsbDeviceId(info.usbVendorId, info.usbProductId), info), new Map());

const DEFAULT_TELNET_PORT = 4444;
const DEFAULT_TELNET_COMMAND_TIMEOUT = 3000;

const DEVICE_ID_SIZE = 24; // Hex-encoded

const FLASH_TIMEOUT = 2 * 60 * 1000;

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
	return resp.split('\n').map(line => trimTelnetResponseLine(line)).filter(line => !!line);
}

class OpenOcdDevice extends Device {
	constructor({ info, serial, port, log }) {
		super({ log });
		this._info = info;
		this._serial = serial;
		this._port = port || DEFAULT_TELNET_PORT;
		this._platform = platformCommons(info.platformGen).openOcd; // FIXME
		this._telnet = null;
		this._telnetOpen = false;
		this._ocdProc = null;
		this._ocdStopping = null;
		this._ocdRunning = false;
	}

	async open(options) {
		if (this._ocdRunning) {
			throw new Error('Device is already open');
		}
		try {
			this._log.verbose(`Starting OpenOCD; port: ${this._port}`);
			await this._startOpenOcd();
			this._log.debug('Connecting to OpenOCD');
			await this._connectToOpenOcd();
			if (this._platform.resetTarget) {
				await this._command('reset init');
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
		try {
			if (this._ocdRunning) {
				const ocdStopped = new Promise((resolve, reject) => {
					this._ocdStopping = { resolve, reject };
				});
				if (this._telnetOpen) {
					this._log.verbose('Stopping OpenOCD');
					try {
						if (this._platform.resetTarget) {
							await this._command('reset run');
						}
						await this._command('shutdown');
					} catch (err) {
						// Ignore error
					}
				} else {
					this._log.verbose('Terminating OpenOCD process');
					this._ocdProc.kill();
				}
				await ocdStopped;
			}
			if (this._telnetOpen) {
				await this._telnet.destroy();
			}
			this._telnet = null;
			this._ocdProc = null;
			this._ocdStopping = null;
		} catch (err) {
			this._log.warn(err.message);
		}
	}

	async reset() {
		await this._command('reset run');
	}

	async prepareToFlash() {
		await this._command('reset init');
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
		let opts = ['erase'];
		if (this._platform.unlockFlash) {
			opts.push('unlock');
		}
		opts = opts.join(' ');
		const addrStr = toUInt32Hex(address);
		const resp = await this._command(`flash write_image ${opts} ${file} ${addrStr} bin`, { timeout: FLASH_TIMEOUT });
		if (!resp.match(/wrote \d+ bytes from file/)) {
			throw new Error('Programming failed:\n' + resp);
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

	async _getDeviceId() {
		const addrStr = toUInt32Hex(this._platform.deviceIdAddress);
		const prefix = this._platform.deviceIdPrefix || ''; // Hex-encoded
		const size = Math.floor((DEVICE_ID_SIZE - prefix.length) / 2);
		const resp = await this._command(`mdb ${addrStr} ${size}`);
		const rx = new RegExp(`^${addrStr}:\\s((?:[0-9A-Za-z]{2}\\s?){${size}})$`);
		const match = rx.exec(resp);
		if (!match || match.length !== 2) {
			throw new Error('Unable to get device ID');
		}
		const id = prefix + match[1].replace(/\s/g, '').toLowerCase();
		return id;
	}

	async _command(cmd, { timeout = DEFAULT_TELNET_COMMAND_TIMEOUT } = {}) {
		this._log.debug('>', cmd);
		if (!this._telnetOpen) {
			throw new Error('Telnet connection is not open');
		}
		let resp = await this._telnet.exec(cmd, { execTimeout: timeout });
		resp = splitTelnetResponseLines(resp);
		for (let line of resp) {
			this._log.debug('<', line);
		}
		return resp.join('\n');
	}

	async _connectToOpenOcd() {
		let telnet = new Telnet();
		telnet.on('close', () => {
			this._telnetOpen = false;
		});
		telnet.on('error', err => {
			if (this._telnet && !this._ocdStopping) {
				this._log.error('Telnet connection error:', err.message);
			}
		});
		await telnet.connect({
			port: this._port,
			shellPrompt: '\r> ',
			timeout: 3000
		});
		this._telnet = telnet;
		this._telnetOpen = true;
	}

	async _startOpenOcd() {
		return new Promise((resolve, reject) => {
			const cmds = [
				`${this._info.serialParam} ${this._serial}`,
				`telnet_port ${this._port}`,
				'gdb_port disabled',
				'tcl_port disabled'
			];
			if (this._platform.resetTarget) {
				cmds.push('reset_config connect_assert_srst srst_only srst_nogate');
			}
			const args = [
				'-f', `interface/${this._info.interfaceConfig}`,
				'-f', `target/${this._platform.targetConfig}`,
				'-c', cmds.join('; ')
			];
			this._log.debug('$', 'openocd', args.map(arg => arg.includes(' ') ? '"' + arg + '"' : arg).join(' '));
			let proc = spawn('openocd', args, {
				stdio: [
					'ignore', // stdin
					'pipe', // stdout
					'pipe' // stderr
				]
			});
			let error = null;
			proc.on('exit', (code, signal) => {
				if (proc) {
					proc = null;
					if (signal) {
						error = new Error(`OpenOCD process was terminated by ${signal}`);
					} else if (code !== 0) {
						error = new Error(`OpenOCD process exited with code ${code}`);
					} else if (!this._ocdStopping) {
						error = new Error(`OpenOCD process exited unexpectedly`);
					}
					if (this._ocdProc) {
						if (this._ocdStopping) {
							if (error) {
								this._log.warn(error.message);
							}
							this._ocdStopping.resolve();
						} else {
							this._log.error(error.message);
						}
						this._ocdRunning = false;
					}
				}
			});
			proc.on('error', err => {
				if (proc) {
					proc = null;
					error = new Error(`OpenOCD process error: ${err.message}`);
					if (this._ocdProc) {
						if (this._ocdStopping) {
							this._ocdStopping.reject(error);
						} else {
							this._log.error(error.message);
						}
						this._ocdRunning = false;
					}
				}
			});
			let output = ''; // Combined stdout and stderr output
			proc.stdout.on('data', d => output += d);
			proc.stderr.on('data', d => output += d);
			setTimeout(() => {
				if (proc) {
					this._ocdProc = proc;
					this._ocdRunning = true;
					resolve();
				} else {
					output = output.trim();
					if (output.length) {
						error = new Error(error.message + '\n' + output);
					}
					reject(error);
				}
			}, 1000);
		});
	}
}

export class OpenOcdFlashInterface extends FlashInterface {
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
