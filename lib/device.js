'use strict';
const EventEmitter = require('events');

class Device extends EventEmitter {
	constructor({ id, platformId, log }) {
		super();
		this._log = log;
		this._id = id;
		this._platformId = platformId;
	}

	async open(/* options */) {
	}

	async close() {
	}

	async reset() {
		throw new Error('Not implemented');
	}

	async prepareToFlash() {
	}

	async flashModule(/* module */) {
		throw new Error('Not implemented');
	}

	async writeToFlash(/* file, storage, address */) {
		throw new Error('Not implemented');
	}

	canFlashModule(/* module */) {
		return false;
	}

	canWriteToFlash(/* storage */) {
		return false;
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

	set log(log) {
		this._log = log;
	}

	get log() {
		return this._log;
	}
}

class FlashInterface {
	constructor({ log }) {
		this._log = log;
	}

	async init() {
	}

	async shutdown() {
	}

	async listDevices() {
		throw new Error('Not implemented');
	}

	async openDeviceById(/* id, options */) {
		throw new Error('Not implemented');
	}

	get log() {
		return this._log;
	}
}

module.exports = {
	Device,
	FlashInterface
};
