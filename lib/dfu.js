import { Device, FlashInterface, StorageType } from './device';
import { ModuleType } from './module';

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

	async reset() {
	}

	async prepareToFlash() {
	}

	async writeToFlash(file, storage, address) {
	}

	canWriteToFlash(storage) {
		return (storage === StorageType.INTERNAL_FLASH || storage === StorageType.EXTERNAL_FLASH);
	}

	canFlashModule(module) {
		return (module.type !== ModuleType.BOOTLOADER && this.canWriteToFlash(module.storage));
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
