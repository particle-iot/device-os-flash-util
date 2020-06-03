import mkdirp from 'mkdirp';

import * as fs from 'fs';
import * as path from 'path';

export class Flasher {
	constructor({ name, device, dfu, usb, tempDir, log }) {
		this._log = log;
		this._tempDir = tempDir;
		this._name = name;
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
				if (this._dev.canWriteToFlash(m.storage)) {
					let file = m.file;
					if (m.dropHeader) {
						file = this._dropModuleHeader(m.file, m.headerSize);
					}
					await this._dev.writeToFlash(file, m.storage, m.address);
				} else {
					await this._dev.flashModule(m);
				}
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

	_dropModuleHeader(file, headerSize) {
		const tempDir = path.join(this._tempDir, this._name);
		const ext = path.extname(file);
		const destFile = path.join(tempDir, path.basename(file, ext) + '-no-header' + ext);
		if (!fs.existsSync(destFile)) {
			mkdirp.sync(tempDir);
			let data = fs.readFileSync(file);
			data = data.slice(headerSize);
			fs.writeFileSync(destFile, data);
		}
		return destFile;
	}
}
