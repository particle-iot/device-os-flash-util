import { Device, FlashInterface } from './device';
import { delay } from './util';

import * as usb from 'particle-usb';

import * as fs from 'fs';

export async function openUsbDeviceById(id, { timeout = 3000 } = {}) {
	const t2 = Date.now() + timeout;
	for (;;) {
		try {
			return usb.openDeviceById(id);
		} catch (err) {
			// Ignore error
		}
		const t = t2 - Date.now();
		if (t <= 0) {
			throw new Error('Unable to open USB device');
		}
		await delay(Math.min(t, 300 + Math.floor(Math.random() * 200)));
	}
}

export class UsbDevice extends Device {
	constructor({ id, platformId, device, log }) {
		super({ id, platformId, log });
		this._dev = device;
	}

	async open(options) {
		if (this._dev) {
			throw new Error('Device is already open');
		}
		this._dev = await openUsbDeviceById(id, options);
	}

	async close() {
		if (this._dev) {
			await this._dev.close();
			this._dev = null;
		}
	}

	async reset() {
		if (!this._dev) {
			throw new Error('Device is not open');
		}
		await this._dev.reset();
	}

	async prepareToFlash() {
		if (!this._dev) {
			throw new Error('Device is not open');
		}
		try {
			await this._dev.enterListeningMode();
		} catch (err) {
			this._log.warn(err.message);
		}
	}

	async flashModule(module) {
		if (!this._dev) {
			throw new Error('Device is not open');
		}
		const data = fs.readFileSync(module.file);
		await this._dev.updateFirmware(data);
		return { resetPending: true };
	}

	async writeToFlash(file, storage, address) {
		throw new Error('Not supported');
	}

	canFlashModule(module) {
		return true;
	}

	canWriteToFlash(storage) {
		return false;
	}
}

export class UsbFlashInterface extends FlashInterface {
	constructor({ log }) {
		super({ log });
	}

	async init() {
	}

	async shutdown() {
	}

	async listDevices() {
		const devs = [];
		const usbDevs = await usb.getDevices();
		for (let usbDev of usbDevs) {
			try {
				await usbDev.open();
				const id = usbDev.id;
				devs.push(new UsbDevice({ id, platformId: dev.platformId, log: this._log }));
			} catch (err) {
				// Ignore error
			} finally {
				await usbDev.close();
			}
		}
		return devs;
	}

	async openDeviceById(id, options) {
		const usbDev = await openUsbDeviceById(id, options);
		return new UsbDevice({ id: usbDev.id, platformId: usbDev.platformId, device: usbDev, log: this._log });
	}
}
