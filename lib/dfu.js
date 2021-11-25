const { Device, FlashInterface, StorageType } = require('./device');
const { openUsbDeviceById } = require('./usb');
const { ModuleType } = require('./module');
const { platformForId } = require('./platform');
const { execCommand, formatCommand, toUInt32Hex, toUInt16Hex } = require('./util');

const usb = require('particle-usb');
const which = require('which');

const FLASH_TIMEOUT = 2 * 60 * 1000;

class DfuDevice extends Device {
	constructor({ id, platformId, device, log }) {
		super({ id, platformId, log });
		this._dev = device;
		this._platform = platformForId(platformId);
	}

	async open(options) {
		if (this._dev) {
			throw new Error('Device is already open');
		}
		this._dev = await openUsbDeviceById(this.id, options);
	}

	async close() {
		if (this._dev) {
			await this._dev.close();
			this._dev = null;
		}
	}

	async reset() {
		if (!this._dev) {
			throw new Error('Device is not open');
		}
		await this._dev.reset();
	}

	async prepareToFlash() {
		if (!this._dev) {
			throw new Error('Device is not open');
		}
		if (!this._dev.isInDfuMode) {
			this._log.debug('Entering DFU mode');
			await this._dev.enterDfuMode();
			await this._dev.close();
			this._dev = null; // _dev is also used as a flag
			this._dev = await openUsbDeviceById(this.id);
		}
	}

	async flashModule(module) {
		if (!this.canFlashModule(module)) {
			throw new Error('Unsupported module');
		}
		await this.writeToFlash(module.file, module.storage, module.address);
	}

	async writeToFlash(file, storage, address) {
		const alt = this._altSettingForStorage(storage);
		if (alt === undefined) {
			throw new Error('Unsupported storage');
		}
		const dev = this._dev;
		if (!dev) {
			throw new Error('Device is not open');
		}
		const vidPid = toUInt16Hex(dev.vendorId) + ':' + toUInt16Hex(dev.productId);
		let idArg = null;
		let idVal = null;
		if (process.platform === 'linux') {
			// Use bus/port numbers to identify the device on Linux
			const d = dev.usbDevice._dev; // FIXME
			idArg = '-p';
			idVal = d.busNumber.toString() + '-' + d.portNumbers.join('.');
		} else {
			idArg = '-S';
			idVal = dev.id;
		}
		const args = [
			'-d', vidPid,
			idArg, idVal,
			'-a', alt.toString(),
			'-s', toUInt32Hex(address),
			'-D', file
		];
		await this._dev.close();
		this._dev = null;
		this._log.debug('$', formatCommand('dfu-util', args));
		const r = await execCommand('dfu-util', args, { timeout: FLASH_TIMEOUT });
		// Reopen device
		await dev.open();
		this._dev = dev;
		if (r.exitCode !== 0) {
			throw new Error(`dfu-util exited with code ${r.exitCode}` + ('\n' + r.stderr).trimRight());
		}
	}

	canFlashModule(module) {
		return (module.type !== ModuleType.BOOTLOADER && this.canWriteToFlash(module.storage));
	}

	canWriteToFlash(storage) {
		const alt = this._altSettingForStorage(storage);
		return (alt !== undefined);
	}

	_altSettingForStorage(storage) {
		let alt = undefined;
		switch (storage) {
			case StorageType.INTERNAL_FLASH:
				alt = this._platform.internalFlash.dfuAltSetting;
				break;
			case StorageType.EXTERNAL_FLASH:
				alt = this._platform.externalFlash.dfuAltSetting;
				break;
		}
		return alt;
	}
}

class DfuFlashInterface extends FlashInterface {
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
		const devs = [];
		const usbDevs = await usb.getDevices();
		for (const usbDev of usbDevs) {
			try {
				await usbDev.open();
				const id = usbDev.id;
				devs.push(new DfuDevice({ id, platformId: usbDev.platformId, log: this._log }));
			} catch (err) {
				// Ignore error
			} finally {
				await usbDev.close();
			}
		}
		return devs;
	}

	async openDeviceById(id, options) {
		const usbDev = await openUsbDeviceById(id, options);
		return new DfuDevice({ id: usbDev.id, platformId: usbDev.platformId, device: usbDev, log: this._log });
	}
}

module.exports = {
	DfuFlashInterface
};
