/**
 * This is a hack to illustrate how to use the ModuleCache object in another project
 * 
 * Usage:
 * 
 * 1. Get a personal github access token, with just repo public_repo access
 * 2. Authorize particle-iot SSO GH token 
 * 3. Run this command: `GITHUB_TOKEN=redacted npm test --grep ModuleCache`
 */

const { expect } = require('chai');
const { ModuleCache } = require('./module.js');
const { Logger } = require('./log');

describe(`ModuleCache (module.js)`, () => {
	it('can instantiate it (note; does not make assertions)', async () => {
		const log = new Logger();
		const moduleCache = new ModuleCache({
			cacheDir: 'test-fixtures/module-cache1/cache',
			tempDir: 'test-fixtures/module-cache1/tmp',
			log
		});

		if (!process.env.GITHUB_TOKEN) {
			throw new Error("GITHUB_TOKEN env var is not test, mochaCache.init() requires it");
		}
		
		await moduleCache.init()
		const someModules = await moduleCache.getReleaseModules('2.1.0');
		console.log("moduleCache.getReleaseModules('2.1.0') returns this:", someModules);
		console.log("Also, checkout the 'test-fixtures/module-cache1/' dir for binaries");
	});
});
