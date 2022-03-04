const { StorageType } = require('./device');

const _ = require('lodash');

const PLATFORM_COMMONS = [
	{
		baseMcu: 'stm32f2xx',
		internalFlash: {
			dfuAltSetting: 0
		},
		dct: {
			dfuAltSetting: 1,
			storage: StorageType.INTERNAL_FLASH,
			address: 0x08004000,
			size: 32768 // 2 pages
		},
		openOcd: {
			targetConfig: 'stm32f2x.cfg',
			mcuManufacturer: 'STMicroelectronics', // JEDEC manufacturer string
			deviceIdAddress: 0x1fff7a10, // UID
			// By default, Device OS for Gen 2 platforms is built without support for JTAG/SWD debugging,
			// so the target device needs to be reset when attaching to it with a debugger
			assertSrstOnConnect: true,
			// The bootloader's sector in flash may be locked
			unlockFlash: true
		}
	},
	{
		baseMcu: 'nrf52840',
		hasRadioStack: true,
		internalFlash: {
			dfuAltSetting: 0
		},
		externalFlash: {
			dfuAltSetting: 2
		},
		dct: {
			dfuAltSetting: 1,
			storage: StorageType.FILESYSTEM
		},
		filesystem: {
			storage: StorageType.EXTERNAL_FLASH,
			address: 0x80000000,
			size: 2 * 1024 * 1024
		},
		openOcd: {
			targetConfig: 'nrf52.cfg',
			mcuManufacturer: 'Nordic VLSI ASA',
			deviceIdAddress: 0x10000060, // FICR
			deviceIdPrefix: 'e00fce68'
		}
	},
	{
		baseMcu: 'rtl872x',
		internalFlash: {
			dfuAltSetting: 0
		},
		externalFlash: {
			dfuAltSetting: 2
		},
		dct: {
			dfuAltSetting: 1,
			storage: StorageType.FILESYSTEM
		},
		filesystem: {
			storage: StorageType.EXTERNAL_FLASH,
			address: 0x08600000,
			size: 2 * 1024 * 1024
		},
		encryptedModules: [
			{
				// MBR is expected to be encrypted
				index: 1,
				type: 'bootloader'
			}
		],
		openOcd: {
			targetConfig: 'rtl872x.tcl',
			mcuManufacturer: 'Realtek',
			deviceIdProcedure: 'rtl872x_read_efuse_mac; rtl872x_wdg_reset',
			deviceIdPrefix: '0a10aced2021',
			deviceIdRegex: new RegExp(`MAC:\\s([A-Fa-f0-9]{2}):([A-Fa-f0-9]{2}):([A-Fa-f0-9]{2}):([A-Fa-f0-9]{2}):([A-Fa-f0-9]{2}):([A-Fa-f0-9]{2})`),
			// FIXME: verification is disabled, it fails on some versions of OpenOCD
			flashWriteProcedure: (binary, address) => {
				return `rtl872x_flash_write_bin_ext ${binary} ${address} 1 1`;
			},
			resetRunProcedure: 'rtl872x_wdg_reset',
		}
	},
];

const PLATFORM_COMMONS_BY_MCU = PLATFORM_COMMONS.reduce((map, p) => map.set(p.baseMcu, p), new Map());

// Supported Device OS platforms
const PLATFORMS = [
	{
		id: 6,
		name: 'photon',
		displayName: 'Photon',
		baseMcu: 'stm32f2xx'
	},
	{
		id: 8,
		name: 'p1',
		displayName: 'P1',
		baseMcu: 'stm32f2xx'
	},
	{
		id: 10,
		name: 'electron',
		displayName: 'Electron',
		baseMcu: 'stm32f2xx'
	},
	{
		id: 12,
		name: 'argon',
		displayName: 'Argon',
		baseMcu: 'nrf52840',
		hasNcpFirmware: true
	},
	{
		id: 13,
		name: 'boron',
		displayName: 'Boron',
		baseMcu: 'nrf52840'
	},
	{
		id: 14,
		name: 'xenon',
		displayName: 'Xenon',
		baseMcu: 'nrf52840'
	},
	{
		id: 22,
		name: 'asom',
		displayName: 'A SoM',
		baseMcu: 'nrf52840',
		hasNcpFirmware: true
	},
	{
		id: 23,
		name: 'bsom',
		displayName: 'B SoM',
		baseMcu: 'nrf52840'
	},
	{
		id: 25,
		name: 'b5som',
		displayName: 'B5 SoM',
		baseMcu: 'nrf52840',
		filesystem: {
			size: 4 * 1024 * 1024
		}
	},
	{
		id: 26,
		name: 'tracker',
		displayName: 'Tracker',
		baseMcu: 'nrf52840',
		filesystem: {
			size: 4 * 1024 * 1024
		}
	},
	{
		id: 32,
		name: 'p2',
		displayName: 'P2',
		baseMcu: 'rtl872x',
		filesystem: {
			size: 8 * 1024 * 1024
		}
	}
].map(p => _.merge({}, PLATFORM_COMMONS_BY_MCU.get(p.baseMcu), p));

const PLATFORMS_BY_ID = PLATFORMS.reduce((map, p) => map.set(p.id, p), new Map());
const PLATFORMS_BY_NAME = PLATFORMS.reduce((map, p) => map.set(p.name, p), new Map());

function platformForId(id) {
	const p = PLATFORMS_BY_ID.get(id);
	if (!p) {
		throw new RangeError(`Unknown platform ID: ${id}`);
	}
	return p;
}

function platformForName(name) {
	const p = PLATFORMS_BY_NAME.get(name);
	if (!p) {
		throw new RangeError(`Unknown platform name: ${name}`);
	}
	return p;
}

function platformCommonsForMcu(mcu) {
	const p = PLATFORM_COMMONS_BY_MCU.get(mcu);
	if (!p) {
		throw new RangeError('Hello from 2020!');
	}
	return p;
}

module.exports = {
	PLATFORMS,
	platformForId,
	platformForName,
	platformCommonsForMcu
};
