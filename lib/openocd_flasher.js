import { Flasher } from './flasher';
import { isSpace, isPrintable } from './util';

import * as particleUsb from 'particle-usb';
import * as usb from 'usb';
import Telnet from 'telnet-client';
import which from 'which';

import { spawn } from 'child_process';

export const AdapterType = {
	DAPLINK: 'daplink',
	STLINK: 'stlink'
};

// Supported debuggers
const ADAPTER_INFO = [
	{
		type: AdapterType.DAPLINK,
		displayName: 'DAPLink',
		usbVendorId: 0x0d28,
		usbProductId: 0x0204,
		platformGen: 3, // For now, hardcode what platforms each debugger can be used with
		interfaceConfig: 'cmsis-dap.cfg',
		targetConfig: 'nrf52.cfg',
		serialParam: 'cmsis_dap_serial',
		resetTarget: false
	},
	{
		type: AdapterType.STLINK,
		displayName: 'ST-LINK/V2',
		usbVendorId: 0x0483,
		usbProductId: 0x3748,
		platformGen: 2,
		interfaceConfig: 'stlink-v2.cfg', // Deprecated in recent versions of OpenOCD
		targetConfig: 'stm32f2x.cfg',
		serialParam: 'hla_serial',
		// By default, Device OS for Gen 2 platforms is built without support for JTAG/SWD debugging,
		// so we need to reset the device in order to attach to it with a debugger
		resetTarget: true
	}
];

const ADAPTER_INFO_BY_USB_ID = ADAPTER_INFO.reduce((map, info) =>
		map.set(makeUsbDeviceId(info.usbVendorId, info.usbProductId), info), new Map());

const DEFAULT_TELNET_PORT = 4444;

const GEN3_DEVICE_ID_ADDRESS = 0x10000060;
const GEN3_DEVICE_ID_SIZE = 8;
const GEN3_DEVICE_ID_PREFIX = 'e00fce68';

const GEN2_DEVICE_ID_ADDRESS = 0x1fff7a10;
const GEN2_DEVICE_ID_SIZE = 12;

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

class Adapter {
	constructor({ info, serial, log }) {
		this._log = log;
		this._info = info;
		this._serial = serial;
		this._telnet = null;
		this._telnetOpen = false;
		this._ocdProc = null;
		this._ocdStopping = null;
		this._ocdRunning = false;
	}

	async open({ port, cwd } = {}) {
		try {
			port = port || DEFAULT_TELNET_PORT;
			cwd = cwd || process.cwd();
			this._log.verbose(`Starting OpenOCD; port: ${port}`);
			await this._startOpenOcd(port, cwd);
			this._log.verbose('Connecting to OpenOCD');
			await this._connectToOpenOcd(port);
			if (this._info.resetTarget) {
				await this._command('reset halt');
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
						if (this._info.resetTarget) {
							await this._command('reset');
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

	async getDeviceId() {
		let addr = 0;
		let size = 0;
		let prefix = '';
		switch (this._info.platformGen) {
			case 2: {
				addr = GEN2_DEVICE_ID_ADDRESS;
				size = GEN2_DEVICE_ID_SIZE;
				break;
			}
			case 3: {
				addr = GEN3_DEVICE_ID_ADDRESS;
				size = GEN3_DEVICE_ID_SIZE;
				prefix = GEN3_DEVICE_ID_PREFIX;
				break;
			}
			default:
				throw new Error(`Unsupported platform`);
		}
		addr = '0x' + addr.toString(16).padStart(8, '0');
		const resp = await this._command(`mdb ${addr} ${size}`);
		const rx = new RegExp(`^${addr}:\\s((?:[0-9A-Za-z]{2}\\s?){${size}})$`);
		const match = rx.exec(resp);
		if (!match || match.length !== 2) {
			throw new Error('Unable to get device ID');
		}
		const id = prefix + match[1].replace(/\s/g, '').toLowerCase();
		this._log.verbose('Device ID:', id);
		return id;
	}

	get adapterInfo() {
		return this._info;
	}

	get serialNumber() {
		return this._serial;
	}

	async _command(cmd) {
		this._log.debug('>', cmd);
		if (!this._telnetOpen) {
			throw new Error('Telnet connection is not open');
		}
		let resp = await this._telnet.exec(cmd);
		resp = splitTelnetResponseLines(resp);
		for (let line of resp) {
			this._log.debug('<', line);
		}
		return resp.join('\n');
	}

	async _connectToOpenOcd(port) {
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
			port,
			shellPrompt: '> '
		});
		this._telnet = telnet;
		this._telnetOpen = true;
	}

	async _startOpenOcd(port, cwd) {
		return new Promise((resolve, reject) => {
			const cmd = 'openocd';
			const args = [
				'-f', `interface/${this._info.interfaceConfig}`,
				'-f', `target/${this._info.targetConfig}`,
				'-c', `telnet_port ${port}; gdb_port disabled; tcl_port disabled; ${this._info.serialParam} ${this._serial}`
			];
			if (this._info.resetTarget) {
				args.push('-c');
				args.push('reset_config connect_assert_srst srst_only srst_nogate');
			}
			this._log.debug('$', cmd, args.map(arg => arg.includes(' ') ? '"' + arg + '"' : arg).join(' '));
			let proc = spawn(cmd, args, {
				stdio: [
					'ignore', // stdin
					'pipe', // stdout
					'pipe' // stderr
				],
				cwd
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

export class OpenOcdFlasher extends Flasher {
	constructor({ log }) {
		super({ log });
		this._deviceMap = new Map();
		this._openAdapters = [];
	}

	async init() {
		try {
			await which('openocd');
		} catch (err) {
			throw new Error('OpenOCD is not installed');
		}
		// Do our best to determine target device platforms
		let platforms = new Map();
		const devs = await particleUsb.getDevices();
		for (let dev of devs) {
			try {
				await dev.open();
				platforms.set(dev.id, dev.platformId);
				await dev.close();
			} catch (err) {
				// Ignore error
			}
		}
		const adapters = await this._listAdapters();
		if (!adapters.length) {
			this._log.verbose("No debug adapters found");
			return [];
		}
		this._log.verbose('Found debug adapters:');
		for (let i = 0; i < adapters.length; ++i) {
			const ad = adapters[i];
			this._log.verbose(`${i + 1}. ${ad.adapterInfo.displayName}; serial number: ${ad.serialNumber}`);
		}
		let nextPort = DEFAULT_TELNET_PORT;
		const funcs = adapters.map(ad => async () => {
			try {
				await ad.open({ port: nextPort++ });
			} catch (err) {
				this._log.warn(err.message);
				return;
			}
			const dev = {
				adapter: ad
			};
			try {
				dev.id = await ad.getDeviceId();
			} catch (err) {
				this._log.warn(err.message);
				await ad.close();
				return;
			}
			if (platforms.has(dev.id)) {
				dev.platformId = platforms.get(dev.id);
			}
			this._deviceMap.set(dev.id, dev);
			this._openAdapters.push(ad);
		});
		await Promise.all(funcs.map(fn => fn()));
	}

	async shutdown() {
		try {
			for (let ad of this._openAdapters) {
				await ad.close();
			}
			this._openAdapters = [];
			this._deviceMap.clear();
		} catch (err) {
			this._log.warn(err.message);
		}
	}

	async listDevices() {
		return Array.from(this._deviceMap.values());
	}

	async releaseDevice(id) {
		const dev = this._deviceMap.get(id);
		if (dev) {
			this._deviceMap.delete(id);
			await dev.adapter.close();
		}
	}

	async _listAdapters() {
		const adapters = [];
		let count = 0;
		const usbDevs = usb.getDeviceList();
		for (let usbDev of usbDevs) {
			const usbDesc = usbDev.deviceDescriptor;
			const info = ADAPTER_INFO_BY_USB_ID.get(makeUsbDeviceId(usbDesc.idVendor, usbDesc.idProduct));
			if (info) {
				let serial = null;
				try {
					serial = await this._getAdapterSerial(usbDev);
				} catch (err) {
					this._log.warn(err.message);
					continue;
				}
				++count;
				const log = this._log.child(`[Adapter ${count}]`);
				adapters.push(new Adapter({ info, serial, log }));
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
