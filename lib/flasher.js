const { platformForId } = require('./platform');
const { delay } = require('./util');

const chalk = require('chalk');
const mkdirp = require('mkdirp');

const fs = require('fs');
const path = require('path');

// This timeout should be long enough to allow the bootloader to apply an update
const REOPEN_TIMEOUT = 60 * 1000;

class Flasher {
	constructor({ name, device, dfu, usb, tempDir, log }) {
		this._log = log;
		this._tempDir = tempDir;
		this._name = name;
		this._dev = device;
		this._platform = platformForId(device.platformId);
		this._dfu = dfu;
		this._usb = usb;
	}

	async flash(modules, { factoryReset = false } = {}) {
		// Filter modules by target platform
		modules = modules.filter(m => m.platformId === this._dev.platformId);
		if (!modules.length && !factoryReset) {
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
			try {
				for (let m of otaModules) {
					if (!dev) {
						// Let the device reset cleanly before reopening it
						await delay(2000);
						dev = await this._usb.openDeviceById(this._dev.id, { timeout: REOPEN_TIMEOUT });
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
		if (factoryReset) {
			let dev = null;
			try {
				// Let the device reset cleanly before reopening it
				await delay(2000);
				dev = await this._dfu.openDeviceById(this._dev.id, { timeout: REOPEN_TIMEOUT });
				dev.log = this._log;
				await dev.prepareToFlash();
				const filesystem = this._platform.filesystem;
				if (filesystem && dev.canWriteToFlash(filesystem.storage)) {
					this._log.verbose('Erasing filesystem');
					const file = this._genBlankFile(filesystem.size);
					let t = Date.now();
					await dev.writeToFlash(file, filesystem.storage, filesystem.address);
					t = Math.round((Date.now() - t) / 100) / 10;
					this._log.debug(`Erased in ${t}s`);
				}
				const dct = this._platform.dct;
				if (dct && dev.canWriteToFlash(dct.storage)) {
					this._log.verbose('Erasing DCT');
					const file = this._genBlankFile(dct.size);
					let t = Date.now();
					await dev.writeToFlash(file, dct.storage, dct.address);
					t = Math.round((Date.now() - t) / 100) / 10;
					this._log.debug(`Erased in ${t}s`);
				}
				this._log.verbose('Resetting device');
				await dev.reset();
			} finally {
				if (dev) {
					await dev.close();
				}
			}
		}
		this._log.verbose(chalk.green.bold('Flashed successfully'));
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

	_genBlankFile(size) {
		const tempDir = path.join(this._tempDir, this._name);
		const destFile = path.join(tempDir, `blank-${size}.bin`);
		if (!fs.existsSync(destFile)) {
			mkdirp.sync(tempDir);
			const data = Buffer.alloc(size, 0xff); // FIXME
			fs.writeFileSync(destFile, data);
		}
		return destFile;
	}
}

module.exports = {
	Flasher
};
