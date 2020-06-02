import * as path from 'path';

export class Flasher {
	constructor({ device, dfu, usb, log }) {
		this._log = log;
		this._dev = device;
		this._dfu = dfu;
		this._usb = usb;
	}

	async flash(modules) {
		modules = modules.filter(m => m.platformId === this._dev.platformId);
		if (!modules.length) {
			this._log.warn('Module list is empty');
			return;
		}
		// Filter out modules that can't be flashed using the selected interface
		const unsuppMods = modules.filter(m => !this._dev.canFlashModule(m));
		modules = modules.filter(m => this._dev.canFlashModule(m));
		if (modules.length) {
			await this._dev.prepareToFlash();
			for (let m of modules) {
				this._log.verbose('Flashing', path.basename(m.file));
				await this._dev.flashModule(m);
			}
			await this._dev.reset();
		}
		this._log.verbose('Flashed all modules');
	}

	get device() {
		return this._dev;
	}

	get log() {
		return this._log;
	}
}
