const chalk = require('chalk');

const util = require('util');

const LogLevel = {
	ERROR: 0,
	WARN: 1,
	INFO: 2,
	VERBOSE: 3,
	DEBUG: 4,
	SILLY: 5
};

// Simple console logger with a winston-like API.
class Logger {
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
			} else if (level >= LogLevel.VERBOSE) {
				msg = chalk.dim(msg);
			}
			console.error(msg);
		}
	}

	addTag(tag) {
		return new TaggedLogger({ parent: this, tag });
	}

	set level(level) {
		this._level = level;
	}

	get level() {
		return this._level;
	}
}

class TaggedLogger extends Logger {
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

module.exports = {
	LogLevel,
	Logger
};
