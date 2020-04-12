export const ModuleType = {
	USER_PART: 'user_part',
	SYSTEM_PART: 'system_part',
	BOOTLOADER: 'bootloader',
	RADIO_STACK: 'radio_stack',
	NCP_FIRMWARE: 'ncp_firmware'
};

export const StorageType = {
	INTERNAL_FLASH: 'internal_flash',
	EXTERNAL_FLASH: 'external_flash',
	FILESYSTEM: 'filesystem',
	OTHER: 'other'
};

export function moduleStorage(type, platformId) {
	switch (type) {
	case ModuleType.USER_PART:
	case ModuleType.SYSTEM_PART:
	case ModuleType.BOOTLOADER:
	case ModuleType.RADIO_STACK:
		return StorageType.INTERNAL_FLASH;
	case ModuleType.NCP_FIRMWARE:
		return StorageType.OTHER;
	default:
		throw new Error(`Unknown module type: ${type}`);
	}
}
