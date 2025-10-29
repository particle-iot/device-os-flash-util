'use strict';
const chai = require('chai');
const expect = chai.expect;
chai.use(require('chai-fs'));
const { ModuleCache } = require('./module.js');
const { Logger, LogLevel } = require('./log');

const rimraf = require('rimraf');
const mkdirp = require('mkdirp');
const path = require('path');

const TEST_DIR = 'test-fixtures';

describe(`ModuleCache (module.js)`, () => {
	beforeEach(() => {
		rimraf.sync(TEST_DIR);
		mkdirp.sync(TEST_DIR);
	});

	it('can instantiate it and download all release modules associated with Device OS 2.1.0', async () => {
		const deviceOSVersion = '2.1.0';
		const log = new Logger();
		// This doesnt work like you'd expect
		log.level = LogLevel.VERBOSE;
		const moduleCache = new ModuleCache({
			cacheDir: path.join(TEST_DIR, 'cache'),
			tempDir: path.join(TEST_DIR, 'temp'),
			log
		});

		await moduleCache.init();

		// Each element in this array looks like this:
		//   {
		//   	platformId: 25,
		//   	type: 'system_part',
		//   	index: 1,
		//   	version: 2101,
		//   	storage: 'internal_flash',
		//   	address: 196608,
		//   	moduleSize: 496476,
		//   	headerSize: 24,
		//   	dropHeader: false,
		//   	crcValid: true,
		//   	fileSize: 496476,
		//   	file: '/Users/jgoggins/git/particle/device-os-flash-util/test-fixtures/module-cache1/cache/2.1.0/b5som/b5som-system-part1@2.1.0.bin'
		//   },
		const someModules = await moduleCache.getReleaseModules(deviceOSVersion);
		for (const element of someModules) {
			// console.log(`Making assertions on this`, element);
			// this file system assertion ability is from https://www.chaijs.com/plugins/chai-fs/
			expect(element.file).to.be.a.path();
		}
	});
});
