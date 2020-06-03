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

	async reset() {
	}

	async prepareToFlash() {
	}

	async flashModule(module) {
		// TODO
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
		return [];
	}
}
