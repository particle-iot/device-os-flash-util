import { Device, FlashInterface } from './device';

import * as usb from 'particle-usb';

export class UsbDevice extends Device {
	constructor({ id, platformId, log }) {
		super({ id, platformId, log });
	}

	async open() {
	}

	async close() {
	}

	async prepareToFlash() {
	}

	async writeToFlash(storage, address, data) {
	}

	async flashModule(module) {
	}

	async reset({ listeningMode }) {
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
		return [];
	}
}
