'use strict';
const { Device, FlashInterface } = require('./device');
const { delay } = require('./util');

const usb = require('particle-usb');

const fs = require('fs');

// Flashing an NCP firmware can take a few minutes
const FLASH_TIMEOUT = 4 * 60 * 1000;

async function openUsbDeviceById(id, { timeout = 3000 } = {}) {
	const t2 = Date.now() + timeout;
	for (;;) {
		try {
			const dev = await usb.openDeviceById(id);
			await delay(500); // Just in case
			return dev;
		} catch (_err) {
			// Ignore error
		}
		const t = t2 - Date.now();
		if (t <= 0) {
			throw new Error('Unable to open USB device');
		}
		await delay(Math.min(t, 250 + Math.floor(Math.random() * 250)));
	}
}

class UsbDevice extends Device {
	constructor({ id, platformId, device, log }) {
		super({ id, platformId, log });
		this._dev = device;
	}

	async open(options) {
		if (this._dev) {
			throw new Error('Device is already open');
		}
		this._dev = await openUsbDeviceById(this.id, options);
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
			// Make sure the device is not trying to connect to the cloud
			this._log.debug('Entering listening mode');
			await this._dev.enterListeningMode();
			await delay(1000); // Just in case
		} catch (err) {
			this._log.warn(err.message);
		}
	}

	async flashModule(module) {
		if (!this._dev) {
			throw new Error('Device is not open');
		}
		const data = fs.readFileSync(module.file);
		await this._dev.updateFirmware(data, { timeout: FLASH_TIMEOUT });
		return { resetPending: true };
	}

	async writeToFlash(/* file, storage, address */) {
		throw new Error('Not supported');
	}

	canFlashModule(/* module */) {
		return true;
	}

	canWriteToFlash(/* storage */) {
		return false;
	}
}

class UsbFlashInterface extends FlashInterface {
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
		for (const usbDev of usbDevs) {
			try {
				await usbDev.open();
				const id = usbDev.id;
				devs.push(new UsbDevice({ id, platformId: usbDev.platformId, log: this._log }));
			} catch (_err) {
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

module.exports = {
	openUsbDeviceById,
	UsbFlashInterface
};
