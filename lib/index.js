#!/usr/bin/env node

const { App } = require('./app');
const { Logger, LogLevel } = require('./log');
const { name: PACKAGE_NAME, version: PACKAGE_VERSION, description: PACKAGE_DESC } = require('../package.json');

const parseArgs = require('minimist');

const path = require('path');

const APP_NAME = path.basename(PACKAGE_NAME);

function showUsage() {
	console.log(`\
${PACKAGE_DESC}

Usage: ${APP_NAME} [options...] <version | path>

version
    Device OS version number.
path
    Path to firmware binaries.

Options:

-d <device>, --device=<device>
    Specify the ID or name of the target device.
--all-devices
    Flash all connected devices.
--openocd
    Use OpenOCD to flash devices.
--system
    Flash the system firmware.
--no-system
    Do not flash the system firmware.
--user
    Flash the user firmware.
--no-user
    Do not flash the user firmware.
--bootloader
    Flash the bootloader.
--no-bootloader
    Do not flash the bootloader.
--ncp
    Flash the NCP firmware.
--no-ncp
    Do not flash the NCP firmware.
--radio
    Flash the radio stack module.
--no-radio
    Do not flash the radio stack module.
--factory-reset
    Reset device settings to factory defaults.
--no-cache
    Do not use cached firmware binaries.
-n <number>
    Limit the number of devices that can be flashed simultaneously.
-v, --verbose
    Enable verbose logging.
--version
    Show the version number.
-h, --help
    Show this message.

Environment variables:

PARTICLE_TOKEN
    Access token for the Particle API.
GITHUB_TOKEN
    Access token for the GitHub API.`);
}

// minimist doesn't allow parsing flags like --X and --no-X separately
function parseModuleArgs(args) {
	const m = {
		system: false,
		noSystem: false,
		user: false,
		noUser: false,
		bootloader: false,
		noBootloader: false,
		ncp: false,
		noNcp: false,
		radio: false,
		noRadio: false
	};
	let i = 0;
	while (i < args.length) {
		let filter = true;
		switch (args[i]) {
			case '--system': m.system = true; break;
			case '--no-system': m.noSystem = true; break;
			case '--user': m.user = true; break;
			case '--no-user': m.noUser = true; break;
			case '--bootloader': m.bootloader = true; break;
			case '--no-bootloader': m.noBootloader = true; break;
			case '--ncp': m.ncp = true; break;
			case '--no-ncp': m.noNcp = true; break;
			case '--radio': m.radio = true; break;
			case '--no-radio': m.noRadio = true; break;
			default: filter = false; break;
		}
		if (filter) {
			args.splice(i, 1);
		} else {
			++i;
		}
	}
	return m;
}

// minimist doesn't support arguments like -vv and -vvv
function parseVerbosityArgs(args) {
	let verbosity = 0;
	const rx = /^-v+$/;
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (rx.test(arg)) {
			const v = arg.length - 1;
			if (v > verbosity) {
				verbosity = v;
			}
			args.splice(i, 1);
		} else if (arg === '--verbose') {
			if (!verbosity) {
				verbosity = 1;
			}
			args.splice(i, 1);
		} else {
			++i;
		}
	}
	if (verbosity >= 2) {
		return LogLevel.SILLY;
	} else if (verbosity === 1) {
		return LogLevel.DEBUG;
	}
	return LogLevel.VERBOSE;
}

async function run() {
	let ok = true;
	let app = null;
	const log = new Logger();
	try {
		let args = process.argv.slice(2);
		log.level = parseVerbosityArgs(args);
		const moduleArgs = parseModuleArgs(args);
		args = parseArgs(args, {
			string: ['_', 'device'],
			boolean: ['all-devices', 'openocd', 'factory-reset', 'cache', 'version', 'help'],
			alias: {
				'device': 'd',
				'help': 'h'
			},
			default: {
				'cache': true
			},
			unknown: arg => {
				if (arg.startsWith('-') && arg !== '-n') {
					throw new RangeError(`Unknown argument: ${arg}`);
				}
			}
		});
		args = { ...args, ...moduleArgs };
		if (args.help) {
			showUsage();
		} else if (args.version) {
			console.log(PACKAGE_VERSION);
		} else {
			app = new App({ name: APP_NAME, log });
			await app.init(args);
		}
	} catch (err) {
		if (log.level >= LogLevel.DEBUG) {
			log.error(err.stack);
		} else {
			log.error(`Error: ${err.message}`);
		}
		ok = false;
	} finally {
		if (app) {
			await app.shutdown();
		}
	}
	process.exit(ok ? 0 : 1);
}

run();
