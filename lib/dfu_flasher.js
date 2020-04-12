import { Flasher } from './flasher';

import * as particleUsb from 'particle-usb';
import which from 'which';

export class DfuFlasher extends Flasher {
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
	}

	async releaseDevice(id) {
	}
}
