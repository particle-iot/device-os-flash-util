const { expect } = require('chai');
const sinon = require('sinon');
const { App } = require('./app');
const { Logger, LogLevel } = require('./log');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rimraf = require('rimraf');

describe('App', () => {
	const appName = 'tool-unit-tests';
	let app;
	const logger = new Logger({ level: LogLevel.DEBUG });
	beforeEach(() => {
		app = new App({
			name: appName,
			log: logger
		});
		// Silence the logs in this context
		sinon.stub(logger, 'info');
	});

	afterEach(() => {
		sinon.restore();
	});

	describe('constructor', () => {
		it('persists passed properties to instance vars', () => {
			expect(app._name).to.eql(appName);
		});
	});

	describe('init(args)', () => {
		let args;
		beforeEach(() => {
			args = {};
			sinon.stub(app, '_parseVersionOrPathArg');
			sinon.stub(app, '_parseDeviceArgs');
			sinon.stub(app, '_parseMaxRetriesArg');
			sinon.stub(app, '_parseMaxJobsArg');
			sinon.stub(app, '_listLocalDevices');
			sinon.stub(app, '_getTargetDevices');
			sinon.stub(app, '_flashDevices');
		});

		it('throws error if is draft and no GITHUB_TOKEN is provided', async () => {
			let error;
			try {
				await app.init({ draft: true });
			} catch (e) {
				error = e;
			}
			expect(error).to.be.an.instanceOf(Error);
			expect(error.message).to.eql('GitHub API token is required to download a draft release');
		});

		it('calls _parseVersionOrPathArg(args)', async () => {
			await app.init(args);
			expect(app._parseVersionOrPathArg).to.have.property('callCount', 1);
		});

		it('calls _parseDeviceArgs(args)', async () => {
			await app.init(args);
			expect(app._parseDeviceArgs).to.have.property('callCount', 1);
		});

		it('calls _parseMaxRetriesArg(args)', async () => {
			await app.init(args);
			expect(app._parseMaxRetriesArg).to.have.property('callCount', 1);
		});

		it('calls _parseMaxJobsArg(args)', async () => {
			await app.init(args);
			expect(app._parseMaxJobsArg).to.have.property('callCount', 1);
		});

		// Since we want to swap out ModuleCache for @particle/device-os-release
		// we're not testing against that interface, but rather the impacts of it
		describe('directory creation where DeviceOS binaries go', () => {
			const fakeEmptyHomeDir = path.resolve(path.join(__dirname, '../test-fixtures/fake-empty-home-dir'));
			const toDeleteForEach = path.join(fakeEmptyHomeDir, '.particle');
			const expectedToolHomeDir = path.join(fakeEmptyHomeDir, '.particle', appName);

			beforeEach(() => {
				sinon.stub(os, 'homedir').returns(fakeEmptyHomeDir);
				rimraf.sync(toDeleteForEach);
			});

			it('creates home dir', async () => {
				await app.init(args);
				expect(os.homedir).to.have.property('callCount', 1);
				expect(app._homeDir).to.eql(expectedToolHomeDir);
				expect(fs.existsSync(app._homeDir)).to.eql(true);
			});

			it('creates binaries subdir inside home dir', async () => {
				const binariesDir = path.join(expectedToolHomeDir, 'binaries');
				await app.init(args);
				expect(fs.existsSync(binariesDir)).to.eql(true);
			});
		});
	});

	describe('_parseVersionOrPathArg()', async () => {

	});

	describe('_getModules()', async () => {

	});
});
