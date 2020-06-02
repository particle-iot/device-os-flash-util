import { Device, FlashInterface } from './device';

import * as usb from 'particle-usb';
import which from 'which';

export class DfuDevice extends Device {
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

	async reset() {
	}
}

export class DfuFlashInterface extends FlashInterface {
	constructor({ log }) {
		super({ log });
	}

	async init() {
		try {
			await which('dfu-util');
		} catch (err) {
			throw new Error('dfu-util is not installed');
		}
	}

	async shutdown() {
	}

	async listDevices() {
		return [];
	}
}
