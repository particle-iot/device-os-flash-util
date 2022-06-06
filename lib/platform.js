const deviceConstants = require('@particle/device-constants');

const ModuleType = {
	USER_PART: 'user_part',
	SYSTEM_PART: 'system_part',
	BOOTLOADER: 'bootloader',
	RADIO_STACK: 'radio_stack',
	NCP_FIRMWARE: 'ncp_firmware'
};

const StorageType = {
	INTERNAL_FLASH: 'internal_flash',
	EXTERNAL_FLASH: 'external_flash',
	EXTERNAL_MCU: 'external_mcu'
};

function moduleTypeFromString(str) {
	switch (str) {
		case 'bootloader':
			return ModuleType.BOOTLOADER;
		case 'systemPart':
			return ModuleType.SYSTEM_PART;
		case 'userPart':
			return ModuleType.USER_PART;
		case 'radioStack':
			return ModuleType.RADIO_STACK;
		case 'ncpFirmware':
			return ModuleType.NCP_FIRMWARE;
		default:
			throw new Error(`Unsupported module type: ${str}`);
	}
}

function storageTypeFromString(str) {
	switch (str) {
		case 'internalFlash':
			return StorageType.INTERNAL_FLASH;
		case 'externalFlash':
			return StorageType.EXTERNAL_FLASH;
		case 'externalMcu':
			return StorageType.EXTERNAL_MCU;
		default:
			throw new Error(`Unsupported storage type: ${str}`);
	}
}

class Platform {
	constructor(info) {
		this._id = info.id;
		this._name = info.name;
		this._displayName = info.displayName;
		this._baseMcu = info.baseMcu;
		this._fwModules = [];
		for (const moduleInfo of info.firmwareModules) {
			const m = {
				type: moduleTypeFromString(moduleInfo.type),
				storage: storageTypeFromString(moduleInfo.storage),
				encrypted: !!moduleInfo.encrypted
			};
			if (moduleInfo.index !== undefined) {
				m.index = moduleInfo.index;
			}
			this._fwModules.push(m);
		}
		this._dfuStorage = [];
		for (const storageInfo of info.dfu.storage) {
			this._dfuStorage.push({
				type: storageTypeFromString(storageInfo.type),
				alt: storageInfo.alt
			});
		}
	}

	storageForFirmwareModule(type, index) {
		let m = this._fwModules.filter((m) => m.type === type);
		if (!m.length) {
			return null;
		}
		if (m.length === 1) {
			if (m.index !== undefined && m.index !== index) {
				return null;
			}
			m = m[0];
		} else {
			m = m.find((m) => m.index === index);
			if (!m) {
				return null;
			}
		}
		return {
			type: m.storage,
			encrypted: m.encrypted
		};
	}

	dfuAltSettingForStorage(type) {
		const s = this._dfuStorage.find((s) => s.type === type);
		if (!s) {
			return null;
		}
		return s;
	}

	get id() {
		return this._id;
	}

	get name() {
		return this._name;
	}

	get displayName() {
		return this._displayName;
	}

	get baseMcu() {
		return this._baseMcu;
	}

	get hasRadioStack() {
		return this._fwModules.some((m) => m.type === ModuleType.RADIO_STACK);
	}

	get hasNcpFirmware() {
		return this._fwModules.some((m) => m.type === ModuleType.NCP_FIRMWARE);
	}
}

const platforms = Object.values(deviceConstants).filter(p => p.generation >= 2).map(p => new Platform(p));
const platformsById = platforms.reduce((map, p) => map.set(p.id, p), new Map());
const platformsByName = platforms.reduce((map, p) => map.set(p.name, p), new Map());

function platformForId(id) {
	const p = platformsById.get(id);
	if (!p) {
		throw new RangeError(`Unknown platform ID: ${id}`);
	}
	return p;
}

function platformForName(name) {
	const p = platformsByName.get(name);
	if (!p) {
		throw new RangeError(`Unknown platform name: ${name}`);
	}
	return p;
}

module.exports = {
	ModuleType,
	StorageType,
	platformForId,
	platformForName
};
