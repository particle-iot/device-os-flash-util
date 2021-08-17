/**
 * How to run integration test:
 * 
 * 1. Get a personal github access token, with just repo public_repo access
 * 2. Authorize particle-iot SSO GH token 
 * 3. Run this command: `GITHUB_TOKEN=redacted npm integration:test`
 */

const chai = require('chai');
const expect = chai.expect;
chai.use(require('chai-fs'));
const { ModuleCache } = require('../lib/module.js');
const { Logger, LogLevel } = require('../lib/log');

if (!process.env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN env var is not set, this integration test requires it");
}
describe(`ModuleCache can download a pre-determined draft release from GitHub using a GITHUB_TOKEN`, () => {
    it('can download the mock release 1.9.0-rc.1', async () => {
        // https://github.com/particle-iot/device-os/releases/edit/untagged-0aba6b1c0d9f970be876
        // boron-tinker@1.9.0-rc.1.bin

        //  const deviceOSVersion = '1.9.0-rc.1';
        //  const log = new Logger();
        //  // This doesnt work like you'd expect
        //  log.level = LogLevel.VERBOSE;
        //  const moduleCache = new ModuleCache({
        //      cacheDir: 'test-fixtures/module-cache1/cache',
        //      tempDir: 'test-fixtures/module-cache1/tmp',
        //      log
        //  });



        //  await moduleCache.init()

        //  // Each element in this array looks like this:
        //  //   {
        //  //   	platformId: 25,
        //  //   	type: 'system_part',
        //  //   	index: 1,
        //  //   	version: 2101,
        //  //   	storage: 'internal_flash',
        //  //   	address: 196608,
        //  //   	moduleSize: 496476,
        //  //   	headerSize: 24,
        //  //   	dropHeader: false,
        //  //   	crcValid: true,
        //  //   	fileSize: 496476,
        //  //   	file: '/Users/jgoggins/git/particle/device-os-flash-util/test-fixtures/module-cache1/cache/2.1.0/b5som/b5som-system-part1@2.1.0.bin'
        //  //   },
        //  const someModules = await moduleCache.getReleaseModules(deviceOSVersion);
        //  for (const element of someModules) {
        //      // console.log(`Making assertions on this`, element);
        //      // this file system assertion ability is from https://www.chaijs.com/plugins/chai-fs/
        //      expect(element.file).to.be.a.path();
        //  }
    });
});
