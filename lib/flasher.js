import { delay } from './util';

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
		// Filter modules by target platform
		modules = modules.filter(m => m.platformId === this._dev.platformId);
		if (!modules.length) {
			this._log.warn('Module list is empty');
			return;
		}
		const otaModules = []; // Modules that can only be flashed OTA
		const flashModules = []; // Modules that can be flashed directly
		for (let m of modules) {
			if (this._dev.canFlashModule(m) && this._dev.canWriteToFlash(m.storage)) {
				flashModules.push(m);
			} else {
				otaModules.push(m);
			}
		}
		if (flashModules.length) {
			await this._dev.prepareToFlash();
			for (let m of flashModules) {
				let file = m.file;
				this._log.verbose('Flashing', path.basename(file));
				if (m.dropHeader) {
					file = this._dropModuleHeader(m.file, m.headerSize);
				}
				let t = Date.now();
				await this._dev.writeToFlash(file, m.storage, m.address);
				t = Math.round((Date.now() - t) / 100) / 10;
				this._log.debug(`Flashed in ${t}s`);
			}
			this._log.verbose('Resetting device');
			await this._dev.reset();
		}
		await this._dev.close();
		if (otaModules.length) {
			this._log.verbose('Using control requests to flash remaining modules');
			let dev = null;
			// Give the device some time to re-attach to the system if it was reset
			let openTimeout = 3000;
			try {
				for (let m of otaModules) {
					if (!dev) {
						dev = await this._usb.openDeviceById(this._dev.id, { timeout: openTimeout });
						dev.log = this._log;
						await dev.prepareToFlash();
					}
					this._log.verbose('Flashing', path.basename(m.file));
					let t = Date.now();
					const r = await dev.flashModule(m);
					t = Math.round((Date.now() - t) / 100) / 10;
					this._log.debug(`Flashed in ${t}s`);
					if (r && r.resetPending) {
						await dev.close();
						dev = null;
						// Wait longer to let the bootloader apply the update
						openTimeout = 30000;
					}
				}
				if (dev) {
					this._log.verbose('Resetting device');
					await dev.reset();
				}
			} finally {
				if (dev) {
					await dev.close();
				}
			}
		}
		this._log.happy('Flashed all modules successfully');
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
