/**
 * How to run integration test:
 *
 * 1. Get a personal github access token, with just repo public_repo access
 * 2. Authorize particle-iot SSO GH token
 * 3. Run this command: `GITHUB_TOKEN=redacted npm run test:integration`
 */

const chai = require('chai');
const expect = chai.expect;
chai.use(require('chai-fs'));
const { ModuleCache } = require('../lib/module.js');
const { Logger, LogLevel } = require('../lib/log');

const rimraf = require('rimraf');
const mkdirp = require('mkdirp');
const path = require('path');

const TEST_DIR = 'test-fixtures';

describe(`ModuleCache can download a pre-determined draft release from GitHub using a GITHUB_TOKEN`, () => {
	beforeEach(() => {
		rimraf.sync(TEST_DIR);
		mkdirp.sync(TEST_DIR);
	});

	it('can download a mock 1.9.0-rc.1', async () => {
		if (!process.env.GITHUB_TOKEN) {
			throw new Error('GITHUB_TOKEN env var is not set, this integration test requires it');
		}
		const deviceOSVersion = '1.9.0-rc.1';
		const log = new Logger();
		log.level = LogLevel.VERBOSE;
		const moduleCache = new ModuleCache({
			cacheDir: path.join(TEST_DIR, 'cache'),
			tempDir: path.join(TEST_DIR, 'temp'),
			log
		});

		await moduleCache.init();

		const someModules = await moduleCache.getReleaseModules(deviceOSVersion, { draft: true });
		for (const element of someModules) {
			// console.log(`Making assertions on this`, element);
			// this file system assertion ability is from https://www.chaijs.com/plugins/chai-fs/
			expect(element.file).to.be.a.path();
		}
	});

	it('can download a production 2.1.0 release', async () => {
		const deviceOSVersion = '2.1.0';
		const log = new Logger();
		log.level = LogLevel.VERBOSE;
		const moduleCache = new ModuleCache({
			cacheDir: path.join(TEST_DIR, 'cache'),
			tempDir: path.join(TEST_DIR, 'temp'),
			log
		});

		await moduleCache.init();

		const someModules = await moduleCache.getReleaseModules(deviceOSVersion);
		for (const element of someModules) {
			// console.log(`Making assertions on this`, element);
			// this file system assertion ability is from https://www.chaijs.com/plugins/chai-fs/
			expect(element.file).to.be.a.path();
		}
	});

	it('will error if tried with an unknown release', async () => {
		if (!process.env.GITHUB_TOKEN) {
			throw new Error('GITHUB_TOKEN env var is not set, this integration test requires it');
		}
		const deviceOSVersion = '1.10.12-rc.13';
		const log = new Logger();
		log.level = LogLevel.VERBOSE;
		const moduleCache = new ModuleCache({
			cacheDir: path.join(TEST_DIR, 'cache'),
			tempDir: path.join(TEST_DIR, 'temp'),
			log
		});

		await moduleCache.init();

		try {
			await moduleCache.getReleaseModules(deviceOSVersion);
		} catch (err) {
			expect(String(err)).to.equal(`Error: Release not found: ${deviceOSVersion}`);
		}
	});
});
