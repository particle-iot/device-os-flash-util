export const StorageType = {
	INTERNAL_FLASH: 'internal_flash',
	EXTERNAL_FLASH: 'external_flash',
	FILESYSTEM: 'filesystem',
	OTHER: 'other'
};

export class Device {
	constructor({ id, platformId, log }) {
		this._log = log;
		this._id = id;
		this._platformId = platformId;
	}

	async open() {
	}

	async close() {
	}

	async prepareToFlash() {
	}

	async writeToFlash(storage, address, data) {
	}

	async flashModule(module) {
	}

	async reset() {
	}

	set id(id) {
		this._id = id;
	}

	get id() {
		return this._id;
	}

	set platformId(id) {
		this._platformId = id;
	}

	get platformId() {
		return this._platformId;
	}

	get log() {
		return this._log;
	}
}

export class FlashInterface {
	constructor({ log }) {
		this._log = log;
	}

	async init() {
	}

	async shutdown() {
	}

	async listDevices() {
		return [];
	}

	get log() {
		return this._log;
	}
}
