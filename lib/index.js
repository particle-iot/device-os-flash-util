#!/usr/bin/env node

import { App } from './app';
import { Logger, LogLevel, parseVerbosityArgs } from './logger';
import { name as PACKAGE_NAME, version as PACKAGE_VERSION, description as PACKAGE_DESC } from '../package.json';

import parseArgs from 'minimist';

import * as path from 'path';

const APP_NAME = path.basename(PACKAGE_NAME);

function showUsage() {
	console.log(`\
${PACKAGE_DESC}

Usage: ${APP_NAME} [options...] <version>

version
    Device OS version number.

Options:

-d DEVICE, --device=DEVICE
    Specify the target device.

--all-devices
    Flash all connected devices.

--openocd
    Use OpenOCD to flash devices.

--system
    Flash the system firmware.

--user
    Flash the user firmware.

--bootloader
    Flash the bootloader.

--ncp
    Flash the NCP firmware.

--radio
    Flash the radio stack module.

--reset
    Reset device settings to factory defaults.

--no-cache
    Do not use cached firmware binaries.

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

async function run() {
	let ok = true;
	let app = null;
	const log = new Logger();
	try {
		let args = process.argv.slice(2);
		log.level = parseVerbosityArgs(args);
		args = parseArgs(args, {
			string: ['_', 'device'],
			boolean: ['all-devices', 'openocd', 'system', 'user', 'bootloader', 'ncp', 'radio', 'reset', 'cache', 'version', 'help'],
			alias: {
				'device': 'd',
				'help': 'h'
			},
			default: {
				'cache': true
			},
			unknown: arg => {
				if (arg.startsWith('-')) {
					throw new RangeError(`Unknown argument: ${arg}`);
				}
			}
		});
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
