const { Platform, ModuleType, StorageType } = require('./platform');

const { expect } = require('chai');

describe('Platform', () => {
	const platformInfo = {
		id: 123,
		name: 'abc',
		displayName: 'Abc',
		baseMcu: 'xyz',
		firmwareModules: [
			{ type: 'bootloader', storage: 'internalFlash', encrypted: true },
			{ type: 'systemPart', storage: 'internalFlash' },
			{ type: 'userPart', storage: 'internalFlash' },
			{ type: 'radioStack', storage: 'externalFlash' },
			{ type: 'ncpFirmware', storage: 'externalMcu' }
		],
		dfu: {
			storage: [
				{ type: 'internalFlash', alt: 111 },
				{ type: 'externalFlash', alt: 222 },
				{ type: 'externalMcu', alt: 333 }
			]
		}
	};

	describe('constructor', () => {
		it('constructs a platform object from device-constants definitions', () => {
			const p = new Platform(platformInfo);
			expect(p.id).to.equal(123);
			expect(p.name).to.equal('abc');
			expect(p.displayName).to.equal('Abc');
			expect(p.baseMcu).to.equal('xyz');
			expect(p.hasRadioStack).to.be.true;
			expect(p.hasNcpFirmware).to.be.true;
			expect(p.storageForFirmwareModule(ModuleType.BOOTLOADER)).to.deep.equal({ type: StorageType.INTERNAL_FLASH, encrypted: true });
			expect(p.storageForFirmwareModule(ModuleType.SYSTEM_PART)).to.deep.equal({ type: StorageType.INTERNAL_FLASH, encrypted: false });
			expect(p.storageForFirmwareModule(ModuleType.USER_PART)).to.deep.equal({ type: StorageType.INTERNAL_FLASH, encrypted: false });
			expect(p.storageForFirmwareModule(ModuleType.RADIO_STACK)).to.deep.equal({ type: StorageType.EXTERNAL_FLASH, encrypted: false });
			expect(p.storageForFirmwareModule(ModuleType.NCP_FIRMWARE)).to.deep.equal({ type: StorageType.EXTERNAL_MCU, encrypted: false });
			expect(p.dfuAltSettingForStorage(StorageType.INTERNAL_FLASH)).to.equal(111);
			expect(p.dfuAltSettingForStorage(StorageType.EXTERNAL_FLASH)).to.equal(222);
			expect(p.dfuAltSettingForStorage(StorageType.EXTERNAL_MCU)).to.equal(333);
		});

		it('fails if the platform definitions contain an unknown module type', () => {
			expect(() => new Platform({
				...platformInfo,
				firmwareModules: [
					{ type: 'newModuleType', storage: 'internalFlash' }
				]
			})).to.throw('Unknown module type: newModuleType');
		});

		it('fails if the platform definitions contain an unknown storage type', () => {
			expect(() => new Platform({
				...platformInfo,
				firmwareModules: [
					{ type: 'systemPart', storage: 'newStorageType' }
				]
			})).to.throw('Unknown storage type: newStorageType');
		});
	});

	describe('storageForFirmwareModule', () => {
		it('returns the storage info for a firmware module type and index', () => {
			let p = new Platform({
				...platformInfo,
				firmwareModules: [
					{ type: 'systemPart', storage: 'internalFlash' }
				]
			});
			expect(p.storageForFirmwareModule(ModuleType.SYSTEM_PART)).to.deep.equal({ type: StorageType.INTERNAL_FLASH, encrypted: false });
			expect(p.storageForFirmwareModule(ModuleType.SYSTEM_PART, 2)).to.deep.equal({ type: StorageType.INTERNAL_FLASH, encrypted: false });
			p = new Platform({
				...platformInfo,
				firmwareModules: [
					{ type: 'systemPart', index: 1, storage: 'internalFlash' },
					{ type: 'systemPart', index: 2, storage: 'externalFlash', encrypted: true }
				]
			});
			expect(p.storageForFirmwareModule(ModuleType.SYSTEM_PART, 1)).to.deep.equal({ type: StorageType.INTERNAL_FLASH, encrypted: false });
			expect(p.storageForFirmwareModule(ModuleType.SYSTEM_PART, 2)).to.deep.equal({ type: StorageType.EXTERNAL_FLASH, encrypted: true });
		});

		it('returns null if the storage info is not found', () => {
			let p = new Platform({
				...platformInfo,
				firmwareModules: [
					{ type: 'systemPart', storage: 'internalFlash' }
				]
			});
			expect(p.storageForFirmwareModule(ModuleType.USER_PART)).to.be.null;
			p = new Platform({
				...platformInfo,
				firmwareModules: [
					{ type: 'systemPart', index: 1, storage: 'internalFlash' },
				]
			});
			expect(p.storageForFirmwareModule(ModuleType.SYSTEM_PART, 2)).to.be.null;
			p = new Platform({
				...platformInfo,
				firmwareModules: [
					{ type: 'systemPart', index: 1, storage: 'internalFlash' },
					{ type: 'systemPart', index: 2, storage: 'internalFlash' }
				]
			});
			expect(p.storageForFirmwareModule(ModuleType.SYSTEM_PART, 3)).to.be.null;
		});
	});

	describe('dfuAltSettingForStorage', () => {
		it('returns the alt setting for a storage type', () => {
			const p = new Platform({
				...platformInfo,
				dfu: {
					storage: [
						{ type: 'internalFlash', alt: 1 },
						{ type: 'externalFlash', alt: 2 }
					]
				}
			});
			expect(p.dfuAltSettingForStorage(StorageType.INTERNAL_FLASH)).to.equal(1);
			expect(p.dfuAltSettingForStorage(StorageType.EXTERNAL_FLASH)).to.equal(2);
		});

		it('returns null if the alt setting is not found', () => {
			const p = new Platform({
				...platformInfo,
				dfu: {
					storage: [
						{ type: 'internalFlash', alt: 1 }
					]
				}
			});
			expect(p.dfuAltSettingForStorage(StorageType.EXTERNAL_FLASH)).to.be.null;
		});
	});

	describe('hasRadioStack', () => {
		it('returns true if the platform has a radio stack module, or false otherwise', () => {
			let p = new Platform({
				...platformInfo,
				firmwareModules: [
					{ type: 'radioStack', storage: 'internalFlash' }
				]
			});
			expect(p.hasRadioStack).to.be.true;
			p = new Platform({
				...platformInfo,
				firmwareModules: []
			});
			expect(p.hasRadioStack).to.be.false;
		});
	});

	describe('hasNcpFirmware', () => {
		it('returns true if the platform has an NCP firmware module, or false otherwise', () => {
			let p = new Platform({
				...platformInfo,
				firmwareModules: [
					{ type: 'ncpFirmware', storage: 'externalMcu' }
				]
			});
			expect(p.hasNcpFirmware).to.be.true;
			p = new Platform({
				...platformInfo,
				firmwareModules: []
			});
			expect(p.hasNcpFirmware).to.be.false;
		});
	});
});
