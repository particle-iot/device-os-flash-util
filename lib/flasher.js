const { platformForId } = require('./platform');
const { delay } = require('./util');

const chalk = require('chalk');
const mkdirp = require('mkdirp');

const fs = require('fs');
const path = require('path');

// This timeout should be long enough to allow the bootloader apply an update
const REOPEN_TIMEOUT = 60000;
// When reopening a device that was about to reset, give it some time to boot into the firmware
const REOPEN_DELAY = 3000;

class Flasher {
	constructor({ name, device, dfu, usb, tempDir, log }) {
		this._log = log;
		this._tempDir = tempDir;
		this._name = name;
		this._dev = device;
		this._platform = platformForId(device.platformId);
		this._dfu = dfu;
		this._usb = usb;
		this._retriesLeft = 0;
	}

	async run(modules, { maxRetries = 0 } = {}) {
		// Filter modules by target platform
		modules = modules.filter(m => m.platformId === this._dev.platformId);
		if (!modules.length) {
			this._log.warn('Module list is empty');
			return;
		}
		const flashModules = []; // Modules that can be flashed directly
		const otaModules = []; // Modules that can only be flashed OTA
		for (const m of modules) {
			if (this._dev.canFlashModule(m) && this._dev.canWriteToFlash(m.storage)) {
				flashModules.push(m);
			} else {
				otaModules.push(m);
			}
		}
		this._retriesLeft = maxRetries;
		if (flashModules.length) {
			await this._flashModules(flashModules);
		}
		if (otaModules.length) {
			if (flashModules.length) {
				this._log.verbose('Using control requests to flash remaining modules');
			}
			await this._updateModules(otaModules);
		}
		this._log.verbose(chalk.green.bold('Flashed successfully'));
	}

	async _flashModules(modules) {
		modules = [...modules];
		let needReset = false;
		let isOpen = false;
		for (;;) {
			try {
				if (!modules.length && !needReset) {
					break;
				}
				let prepare = false;
				if (!isOpen) {
					await this._dev.open();
					isOpen = true;
					prepare = true;
				}
				if (modules.length) {
					if (prepare) {
						this._log.verbose('Preparing device for flashing');
						await this._dev.prepareToFlash();
					}
					const m = modules[0];
					if (this._platform.encryptedModules) {
						if (this._platform.encryptedModules.find(el => (el.type === m.type && el.index === m.index))) {
							if (!m.encrypted) {
								this._log.warn(`Skipping ${path.basename(m.file)}. It's required to be encrypted`);
								modules.shift();
								continue;
							}
						}
					}

					let file = m.file;
					this._log.verbose('Flashing', path.basename(file));
					if (m.dropHeader) {
						file = this._dropModuleHeader(m.file, m.headerSize);
					}
					let t = Date.now();
					await this._dev.writeToFlash(file, m.storage, m.address);
					t = Math.round((Date.now() - t) / 100) / 10;
					this._log.debug(`Flashed in ${t}s`);
					modules.shift();
					if (!modules.length) {
						needReset = true;
					}
				}
				if (needReset) {
					this._log.verbose('Resetting device');
					await this._dev.reset();
					needReset = false;
				}
			} catch (err) {
				if (isOpen) {
					await this._dev.close();
					isOpen = false;
				}
				if (!this._retriesLeft) {
					throw err;
				}
				this._log.warn(err.message);
				this._log.warn('Retrying');
				--this._retriesLeft;
			}
		}
		if (isOpen) {
			await this._dev.close();
		}
	}

	async _updateModules(modules) {
		modules = [...modules];
		let needReset = false;
		let dev = null;
		for (;;) {
			try {
				if (!modules.length && !needReset) {
					break;
				}
				let prepare = false;
				if (!dev) {
					await delay(REOPEN_DELAY);
					dev = await this._usb.openDeviceById(this._dev.id, { timeout: REOPEN_TIMEOUT });
					dev.log = this._log;
					prepare = true;
				}
				if (modules.length) {
					if (prepare) {
						this._log.verbose('Preparing device for flashing');
						await dev.prepareToFlash();
					}
					const m = modules[0];
					this._log.verbose('Flashing', path.basename(m.file));
					let t = Date.now();
					const r = await dev.flashModule(m);
					t = Math.round((Date.now() - t) / 100) / 10;
					this._log.debug(`Flashed in ${t}s`);
					if (r && r.resetPending) {
						await dev.close();
						dev = null;
					}
					modules.shift();
					if (!modules.length && dev) {
						needReset = true;
					}
				}
				if (needReset) {
					this._log.verbose('Resetting device');
					await dev.reset();
					needReset = false;
				}
			} catch (err) {
				if (dev) {
					await dev.close();
					dev = null;
				}
				if (!this._retriesLeft) {
					throw err;
				}
				this._log.warn(err.message);
				this._log.warn('Retrying');
				--this._retriesLeft;
			}
		}
		if (dev) {
			await dev.close();
		}
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
