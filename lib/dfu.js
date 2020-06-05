const { Device, FlashInterface, StorageType } = require('./device');
const { openUsbDeviceById } = require('./usb');
const { ModuleType } = require('./module');
const { platformForId } = require('./platform');
const { execCommand, toUInt32Hex, toUInt16Hex } = require('./util');

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
			this._log.verbose('Entering DFU mode');
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
		const usbDev = dev.usbDevice._dev; // FIXME
		const vidPid = toUInt16Hex(dev.vendorId) + ':' + toUInt16Hex(dev.productId);
		let idArg = null;
		let idVal = null;
		if (process.platform === 'darwin') {
			// USB port path may be incorrect on macOS, use the serial number instead
			idArg = '-S';
			idVal = dev.id;
		} else {
			idArg = '-p';
			idVal = usbDev.busNumber.toString() + '-' + usbDev.portNumbers.join('.');
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
		this._log.debug('$', 'dfu-util', args.map(arg => arg.includes(' ') ? '"' + arg + '"' : arg).join(' '));
		const r = await execCommand('dfu-util', args, { timeout: FLASH_TIMEOUT });
		// Reopen device
		await dev.open();
		this._dev = dev;
		if (r.exitCode !== 0) {
			throw new Error('dfu-util failed:\n' + r.stderr);
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
		for (let usbDev of usbDevs) {
			try {
				await usbDev.open();
				//console.dir(usbDev.usbDevice);
				const id = usbDev.id;
				devs.push(new DfuDevice({ id, platformId: usbDev.platformId, log: this._log }));
			} catch (err) {
				// Ignore error
			} finally {
				await usbDev.close();
			}
		}
		//sdfsdfsdfjdslkfjds = 1;
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
