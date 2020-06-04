import chalk from 'chalk';

import * as util from 'util';

export const LogLevel = {
	ERROR: 0,
	WARN: 1,
	INFO: 2,
	HAPPY: 3,
	VERBOSE: 4,
	DEBUG: 5,
	SILLY: 6
};

// Simple console logger with a winston-like API.
export class Logger {
	constructor({ level } = {}) {
		this._level = (level !== undefined) ? level : LogLevel.INFO;
	}

	error(...args) {
		this.log(LogLevel.ERROR, ...args);
	}

	warn(...args) {
		this.log(LogLevel.WARN, ...args);
	}

	info(...args) {
		this.log(LogLevel.INFO, ...args);
	}

	happy(...args) {
		this.log(LogLevel.HAPPY, ...args);
	}

	verbose(...args) {
		this.log(LogLevel.VERBOSE, ...args);
	}

	debug(...args) {
		this.log(LogLevel.DEBUG, ...args);
	}

	silly(...args) {
		this.log(LogLevel.SILLY, ...args);
	}

	log(level, ...args) {
		if (level <= this._level) {
			let msg = util.format(...args);
			if (level <= LogLevel.ERROR) {
				msg = chalk.red.bold(msg);
			} else if (level <= LogLevel.WARN) {
				msg = chalk.yellow(msg);
			} else if (level === LogLevel.HAPPY) {
				msg = chalk.green.bold(msg);
			} else if (level >= LogLevel.VERBOSE) {
				msg = chalk.dim(msg);
			}
			console.error(msg);
		}
	}

	child(tag) {
		return new ChildLogger({ parent: this, tag });
	}

	set level(level) {
		this._level = level;
	}

	get level() {
		return this._level;
	}
};

class ChildLogger extends Logger {
	constructor({ parent, tag }) {
		super({ level: parent.level });
		this._parent = parent;
		this._tag = tag;
	}

	log(level, ...args) {
		if (this._tag) {
			this._parent.log(level, this._tag, ...args);
		} else {
			this._parent.log(level, ...args);
		}
	}

	get tag() {
		return this._tag;
	}
}

export function parseVerbosityArgs(args) {
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
	if (verbosity >= 3) {
		return LogLevel.SILLY;
	}
	if (verbosity === 2) {
		return LogLevel.DEBUG;
	}
	if (verbosity === 1) {
		return LogLevel.VERBOSE;
	}
	return LogLevel.INFO;
}
