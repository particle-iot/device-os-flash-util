const net = require('net');
const EventEmitter = require('events');

const TELNET_PORT = 23;
const DEFAULT_HOST = 'localhost';
const SOCKET_CLOSE_TIMEOUT = 5000;

const TelnetClientState = {
	CONNECTING: 'connecting',
	CONNECTED: 'connected',
	DISCONNECTING: 'disconnecting',
	DISCONNECTED: 'disconnected'
};

const DEFAULT_OPTIONS = {
	loginPrompt: /(?:^|\s)login:\s$/i,
	passwordPrompt: /(?:^|\s)password:\s$/i,
	shellPrompt: /^(?:(?:.+@.+:.+\$)|>)\s$/,
	user: undefined,
	password: undefined,
	enableEcho: true,
	suppressGoAhead: true,
	connectTimeout: 30000,
	execTimeout: 30000,
	lineTimeout: 5000
};

// RFC 854, Telnet Command Structure
const Protocol = {
	IAC: 255
};

// RFC 854, Telnet Command Structure
const Command = {
	WILL: 251,
	WONT: 252,
	DO: 253,
	DONT: 254
};

// https://www.iana.org/assignments/telnet-options/telnet-options.xhtml
const Option = {
	ECHO: 1, // RFC 857
	SUPPRESS_GO_AHEAD: 3 // RFC 858
};

// RFC 1143
const OptionState = {
	NO: Symbol('no'),
	YES: Symbol('yes'),
	WANT_NO: Symbol('want_no'),
	WANT_NO_OPPOSITE: Symbol('want_no_opposite'),
	WANT_YES: Symbol('want_yes'),
	WANT_YES_OPPOSITE: Symbol('want_yes_opposite')
};

class TelnetOption {
	constructor(code, name, desiredState = OptionState.NO) {
		if (desiredState != OptionState.YES && desiredState != OptionState.NO) {
			throw RangeError('Invalid state');
		}
		this._code = code;
		this._name = name;
		this._desiredState = desiredState;
		this._currentState = OptionState.NO;
	}

	get code() {
		return this._code;
	}

	get name() {
		return this._name;
	}

	get enabled() {
		return (this._currentState === OptionState.YES);
	}

	set currentState(state) {
		this._currentState = state;
	}

	get currentState() {
		return this._currentState;
	}

	set desiredState(state) {
		this._desiredState = state;
	}

	get desiredState() {
		return this._desiredState;
	}
};

function splitBuffer(buf, sep) {
	const splits = [];
	let pos = buf.indexOf(sep);
	while (pos !== -1) {
		splits.push(buf.slice(0, pos));
		buf = buf.slice(pos + 1);
		pos = buf.indexOf(sep);
	}
	splits.push(buf);
	return splits;
}

function formatOption(opt) {
	return opt.name + '=' + (opt.enabled ? '1' : '0');
}

class TelnetClient extends EventEmitter {
	constructor({ log }) {
		super();
		this._log = log;
		this._clientEcho = new TelnetOption(Option.ECHO, 'ECHO');
		this._serverEcho = new TelnetOption(Option.ECHO, 'ECHO');
		this._clientSuppressGoAhead = new TelnetOption(Option.SUPPRESS_GO_AHEAD, 'SUPPRESS-GO-AHEAD');
		this._serverSuppressGoAhead = new TelnetOption(Option.SUPPRESS_GO_AHEAD, 'SUPPRESS-GO-AHEAD');
		this._clientOpts = [this._clientEcho, this._clientSuppressGoAhead];
		this._serverOpts = [this._serverEcho, this._serverSuppressGoAhead];
		this._sock = null;
		this._resetState();
	}

	async connect(host = DEFAULT_HOST, port = TELNET_PORT, options = {}) {
		if (this._connState !== TelnetClientState.DISCONNECTED) {
			throw new Error('Connection is already open');
		}
		let timer = null;
		try {
			this._host = host;
			this._port = port;
			this._connOpts = { ...DEFAULT_OPTIONS, ...options };
			if (this._connOpts.enableEcho) {
				this._serverEcho.desiredState = OptionState.YES;
			}
			if (this._connOpts.suppressGoAhead) {
				this._clientSuppressGoAhead.desiredState = OptionState.YES;
				this._serverSuppressGoAhead.desiredState = OptionState.YES;
			}
			this._setState(TelnetClientState.CONNECTING);
			timer = setTimeout(async () => {
				await this._error(new Error('Connection timeout'));
			}, this._connOpts.connectTimeout);
			await this._connectSocket();
			await this._negotiateOptions();
			await this._login();
			this._setState(TelnetClientState.CONNECTED);
		} catch (err) {
			await this._error(err);
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	async disconnect() {
		if (this._connState === TelnetClientState.DISCONNECTED) {
			return;
		}
		if (this._connState === TelnetClientState.DISCONNECTING) {
			return new Promise((resolve, reject) => {
				this.once(TelnetClientState.DISCONNECTED, resolve);
			});
		}
		this._setState(TelnetClientState.DISCONNECTING);
		// Interrupt all pending operations
		if (!this._failed) {
			this._failed = true;
			this.emit('_error', new Error('Disconnect requested'));
		}
		await this._disconnectSocket(); // Never fails
		setImmediate(() => {
			this._resetState();
			this.emit(TelnetClientState.DISCONNECTED);
		});
	}

	get state() {
		return this._connState;
	}

	get host() {
		return this._host;
	}

	get port() {
		return this._port;
	}

	get options() {
		return this._connOpts;
	}

	async _login() {
		if (!this._loginPromptReceived) {
			const received = new Promise((resolve, reject) => {
				const onSuccess = () => {
					this.off('_login', onSuccess);
					this.off('_prompt', onSuccess);
					this.off('_error', onError);
					resolve();
				};
				const onError = err => {
					this.off('_login', onSuccess);
					this.off('_prompt', onSuccess);
					reject(err);
				};
				this.once('_login', onSuccess);
				this.once('_prompt', onSuccess);
				this.once('_error', onError);
			});
			await received;
		}
		if (this._loginPromptReceived) {
			if (typeof this._connOpts.user !== 'string') {
				throw new Error('Server requires authentication');
			}
			this._sock.write(Buffer.from(this._connOpts.user + '\r\n'));
		}
		if (!this._passwordPromptReceived) {
			const received = new Promise((resolve, reject) => {
				const onSuccess = () => {
					this.off('_error', onError);
					resolve();
				};
				const onError = err => {
					this.off('_password', onSuccess);
					reject(err);
				};
				this.once('_password', onSuccess);
				this.once('_error', onError);
			});
			await received;
		}
		if (this._passwordPromptReceived) {
			if (typeof this._connOpts.password !== 'string') {
				throw new Error('Server requires authentication');
			}
			this._sock.write(Buffer.from(this._connOpts.password + '\r\n'));
		}
		if (!this._shellPromptReceived) {
			const received = new Promise((resolve, reject) => {
				const onSuccess = () => {
					this.off('_error', onError);
					resolve();
				};
				const onError = err => {
					this.off('_prompt', onSuccess);
					reject(err);
				};
				this.once('_prompt', onSuccess);
				this.once('_error', onError);
			});
			await received;
		}
	}

	async _negotiateOptions() {
		this._sendOptions();
		if (this._negotiatingOptions()) {
			const negotiated = new Promise((resolve, reject) => {
				const onSuccess = () => {
					this.off('_error', onError);
					resolve();
				};
				const onError = err => {
					this.off('_negotiating', onSuccess);
					reject(err);
				};
				this.once('_negotiating', onSuccess); // Will be emitted with 'false'
				this.once('_error', onError);
			});
			await negotiated;
		}
		this._log.debug('Client options:', this._clientOpts.map(opt => formatOption(opt)).join('; '));
		this._log.debug('Server options:', this._serverOpts.map(opt => formatOption(opt)).join('; '));
		if (!this._clientSuppressGoAhead.enabled || !this._serverSuppressGoAhead.enabled) {
			// It's unlikely that a sane Telnet server would refuse to enable this option
			throw new Error('Failed to enable SUPPRESS-GO-AHEAD option');
		}
		this._optionsNegotiated = true;
	}

	_negotiatingOptions() {
		return this._clientOpts.some(opt => opt.currentState != OptionState.YES && opt.currentState != OptionState.NO) ||
				this._serverOpts.some(opt => opt.currentState != OptionState.YES && opt.currentState != OptionState.NO);
	}

	_sendOptions() {
		const wasNegotiating = this._negotiatingOptions();
		// Client options
		for (let opt of this._clientOpts) {
			if (opt.desiredState === OptionState.YES) { // Enable option
				switch (opt.currentState) {
					case OptionState.NO: {
						opt.currentState = OptionState.WANT_YES;
						this._sendCommand(Command.WILL, opt.code);
						break;
					}
					case OptionState.YES: {
						break; // Already enabled
					}
					case OptionState.WANT_NO: {
						opt.currentState = OptionState.WANT_NO_OPPOSITE;
						break;
					}
					case OptionState.WANT_NO_OPPOSITE: {
						break; // Already queued an enable request
					}
					case OptionState.WANT_YES: {
						break; // Already negotiating for enable
					}
					case OptionState.WANT_YES_OPPOSITE: {
						opt.currentState = OptionState.WANT_YES;
						break;
					}
				}
			} else { // Disable option
				switch (opt.currentState) {
					case OptionState.NO: {
						break; // Already disabled
					}
					case OptionState.YES: {
						opt.currentState = OptionState.WANT_NO;
						this._sendCommand(Command.WONT, opt.code);
						break;
					}
					case OptionState.WANT_NO: {
						break; // Already negotiating for disable
					}
					case OptionState.WANT_NO_OPPOSITE: {
						opt.currentState = OptionState.WANT_NO;
						break;
					}
					case OptionState.WANT_YES: {
						opt.currentState = OptionState.WANT_YES_OPPOSITE;
						break;
					}
					case OptionState.WANT_YES_OPPOSITE: {
						break; // Already queued a disable request
					}
				}
			}
		}
		// Server options
		for (let opt of this._serverOpts) {
			if (opt.desiredState === OptionState.YES) { // Enable option
				switch (opt.currentState) {
					case OptionState.NO: {
						opt.currentState = OptionState.WANT_YES;
						this._sendCommand(Command.DO, opt.code);
						break;
					}
					case OptionState.YES: {
						break; // Already enabled
					}
					case OptionState.WANT_NO: {
						opt.currentState = OptionState.WANT_NO_OPPOSITE;
						break;
					}
					case OptionState.WANT_NO_OPPOSITE: {
						break; // Already queued an enable request
					}
					case OptionState.WANT_YES: {
						break; // Already negotiating for enable
					}
					case OptionState.WANT_YES_OPPOSITE: {
						opt.currentState = OptionState.WANT_YES;
						break;
					}
				}
			} else { // Disable option
				switch (opt.currentState) {
					case OptionState.NO: {
						break; // Already disabled
					}
					case OptionState.YES: {
						opt.currentState = OptionState.WANT_NO;
						this._sendCommand(Command.DONT, opt.code);
						break;
					}
					case OptionState.WANT_NO: {
						break; // Already negotiating for disable
					}
					case OptionState.WANT_NO_OPPOSITE: {
						opt.currentState = OptionState.WANT_NO;
						break;
					}
					case OptionState.WANT_YES: {
						opt.currentState = OptionState.WANT_YES_OPPOSITE;
						break;
					}
					case OptionState.WANT_YES_OPPOSITE: {
						break; // Already queued a disable request
					}
				}
			}
		}
		const negotiating = this._negotiatingOptions();
		if (negotiating != wasNegotiating) {
			this.emit('_negotiating', negotiating);
		}
	}

	_receiveOption(cmd, optCode) {
		const wasNegotiating = this._negotiatingOptions();
		const opts = (cmd === Command.WILL || cmd === Command.WONT) ? this._serverOpts : this._clientOpts;
		const opt = opts.find(opt => opt.code === optCode);
		if (opt) {
			switch (cmd) {
				case Command.WILL: {
					switch (opt.currentState) {
						case OptionState.NO: {
							if (opt.desiredState === OptionState.YES) {
								opt.currentState = OptionState.YES;
								this._sendCommand(Command.DO, opt.code);
							} else {
								this._sendCommand(Command.DONT, opt.code);
							}
							break;
						}
						case OptionState.YES: {
							break; // Ignore
						}
						case OptionState.WANT_NO: {
							this._log.warn('DONT answered by WILL');
							opt.currentState = OptionState.NO;
							break;
						}
						case OptionState.WANT_NO_OPPOSITE: {
							this._log.warn('DONT answered by WILL');
							opt.currentState = OptionState.YES;
							break;
						}
						case OptionState.WANT_YES: {
							opt.currentState = OptionState.YES;
							break;
						}
						case OptionState.WANT_YES_OPPOSITE: {
							opt.currentState = OptionState.WANT_NO;
							this._sendCommand(Command.DONT, opt.code);
							break;
						}
					}
					break;
				}
				case Command.WONT: {
					switch (opt.currentState) {
						case OptionState.NO: {
							break; // Ignore
						}
						case OptionState.YES: {
							opt.currentState = OptionState.NO;
							this._sendCommand(Command.DONT, opt.code);
							break;
						}
						case OptionState.WANT_NO: {
							opt.currentState = OptionState.NO;
							break;
						}
						case OptionState.WANT_NO_OPPOSITE: {
							opt.currentState = OptionState.WANT_YES;
							this._sendCommand(Command.DO, opt.code);
							break;
						}
						case OptionState.WANT_YES: {
							opt.currentState = OptionState.NO;
							break;
						}
						case OptionState.WANT_YES_OPPOSITE: {
							opt.currentState = OptionState.NO;
							break;
						}
					}
					break;
				}
				case Command.DO: {
					switch (opt.currentState) {
						case OptionState.NO: {
							if (opt.desiredState === OptionState.YES) {
								opt.currentState = OptionState.YES;
								this._sendCommand(Command.WILL, opt.code);
							} else {
								this._sendCommand(Command.WONT, opt.code);
							}
							break;
						}
						case OptionState.YES: {
							break; // Ignore
						}
						case OptionState.WANT_NO: {
							this._log.warn('WONT answered by DO');
							opt.currentState = OptionState.NO;
							break;
						}
						case OptionState.WANT_NO_OPPOSITE: {
							this._log.warn('WONT answered by DO');
							opt.currentState = OptionState.YES;
							break;
						}
						case OptionState.WANT_YES: {
							opt.currentState = OptionState.YES;
							break;
						}
						case OptionState.WANT_YES_OPPOSITE: {
							opt.currentState = OptionState.WANT_NO;
							this._sendCommand(Command.WONT, opt.code);
							break;
						}
					}
					break;
				}
				case Command.DONT: {
					switch (opt.currentState) {
						case OptionState.NO: {
							break; // Ignore
						}
						case OptionState.YES: {
							opt.currentState = OptionState.NO;
							this._sendCommand(Command.WONT, opt.code);
							break;
						}
						case OptionState.WANT_NO: {
							opt.currentState = OptionState.NO;
							break;
						}
						case OptionState.WANT_NO_OPPOSITE: {
							opt.currentState = OptionState.WANT_YES;
							this._sendCommand(Command.WILL, opt.code);
							break;
						}
						case OptionState.WANT_YES: {
							opt.currentState = OptionState.NO;
							break;
						}
						case OptionState.WANT_YES_OPPOSITE: {
							opt.currentState = OptionState.NO;
							break;
						}
					}
					break;
				}
			}
		} else if (cmd === Command.WILL) { // Server wants to enable an unsupported option
			this._sendCommand(Command.DONT, optCode);
		} else if (cmd === Command.DO) { // Server wants us to enable an unsupported option
			this._sendCommand(Command.WONT, optCode);
		}
		const negotiating = this._negotiatingOptions();
		if (negotiating != wasNegotiating) {
			this.emit('_negotiating', negotiating);
		}
	}

	_receiveCommands() {
		let offs = 0;
		for (;;) {
			offs = this._recvBuf.indexOf(Protocol.IAC, offs);
			if (offs === -1) {
				return true; // Done
			}
			if (offs + 1 >= this._recvBuf.length) {
				return false; // Read more
			}
			let cmdSize = 2;
			const cmd = this._recvBuf[offs + 1];
			if (cmd >= Command.WILL && cmd <= Command.DONT) {
				if (offs + 2 >= this._recvBuf.length) {
					return false; // Read more
				}
				const opt = this._recvBuf[offs + 2];
				this._receiveOption(cmd, opt);
				++cmdSize;
			}
			this._recvBuf = Buffer.concat([this._recvBuf.slice(0, offs), this._recvBuf.slice(offs + cmdSize)]);
		}
	}

	async _receiveData(data) {
		try {
			this._recvBuf = Buffer.concat([this._recvBuf, data]);
			if (!this._receiveCommands()) {
				return;
			}
			if (!this._optionsNegotiated) {
				return;
			}
			// Filter out CR and NUL characters
			this._recvBuf = this._recvBuf.filter(b => b != 0x00 && b != 0x0d);
			const splits = splitBuffer(this._recvBuf, 0x0a /* \n */);
			for (let i = 0; i < splits.length; ++i) {
				const line = splits[i].toString('ascii');
				let matched = false;
				if (!matched && this._expectLoginPrompt &&
						((this._connOpts.loginPrompt instanceof RegExp && line.match(this._connOpts.loginPrompt) ||
						typeof this._connOpts.loginPrompt === 'string' && line === this._connOpts.loginPrompt))) {
					matched = true;
					this._expectLoginPrompt = false;
					this._loginPromptReceived = true;
					this._expectPasswordPrompt = true;
					this.emit('_login');
				}
				if (!matched && this._expectPasswordPrompt &&
						((this._connOpts.passwordPrompt instanceof RegExp && line.match(this._connOpts.passwordPrompt) ||
						typeof this._connOpts.passwordPrompt === 'string' && line === this._connOpts.passwordPrompt))) {
					matched = true;
					this._expectPasswordPrompt = false;
					this._passwordPromptReceived = true;
					this.emit('_password');
				}
				if (!matched &&
						((this._connOpts.shellPrompt instanceof RegExp && line.match(this._connOpts.shellPrompt) ||
						typeof this._connOpts.shellPrompt === 'string' && line === this._connOpts.shellPrompt))) {
					matched = true;
					this._expectLoginPrompt = false;
					this._expectPasswordPrompt = false;
					this._shellPromptReceived = true;
					this.emit('_prompt');
				}
				if (!matched) {
					this.emit('line', line);
				}
			}
		} catch (err) {
			await this._error(err);
		}
	}

	_sendCommand(cmd, opt) {
		if (opt !== undefined) {
			this._sock.write(Buffer.from([Protocol.IAC, cmd, opt]));
		} else {
			this._sock.write(Buffer.from([Protocol.IAC, cmd]));
		}
	}

	async _connectSocket() {
		this._sock = net.connect(this._port, this._host);
		this._sock.on('data', data => {
			this._receiveData(data);
		});
		this._sock.once('error', async (err) => {
			await this._error(err);
		});
		const connected = new Promise((resolve, reject) => {
			const onConnect = () => {
				this.off('_error', onError);
				this._log.debug('Connected to', this._sock.remoteAddress + ':' + this._sock.remotePort);
				this._sock.once('close', async () => {
					await this._error(new Error('Server closed connection unexpectedly'));
				});
				resolve();
			};
			const onError = err => {
				this._sock.off('connect', onConnect);
				reject(err);
			};
			this._sock.once('connect', onConnect);
			this.once('_error', onError);
		});
		await connected;
	}

	async _disconnectSocket() {
		if (this._sock.destroyed) {
			return;
		}
		if (this._sock.connecting) {
			this._sock.destroy();
			return;
		}
		const disconnected = new Promise((resolve, reject) => {
			const destroy = () => {
				clearTimeout(timer);
				this._sock.off('close', destroy);
				this._sock.off('_error', destroy);
				this._sock.destroy();
				resolve();
			};
			const timer = setTimeout(destroy, SOCKET_CLOSE_TIMEOUT);
			this._sock.removeAllListeners('close');
			this._sock.once('close', destroy);
			this.once('_error', destroy);
		});
		await disconnected; // Never fails
	}

	async _error(err) {
		if (!this._failed) {
			this._failed = true;
			// Use another event internally to preserve the semantic of the 'error' event
			this.emit('_error', err);
			this.emit('error', err);
			await this.disconnect();
		}
	}

	_setState(state) {
		if (this._connState !== state) {
			this._connState = state;
			this.emit(state);
		}
	}

	_resetState() {
		if (this._sock) {
			this._sock.removeAllListeners();
			this._sock.destroy();
		}
		for (let opt of this._clientOpts) {
			opt.currentState = OptionState.NO;
			opt.desiredState = OptionState.NO;
		}
		for (let opt of this._serverOpts) {
			opt.currentState = OptionState.NO;
			opt.desiredState = OptionState.NO;
		}
		this._connState = TelnetClientState.DISCONNECTED;
		this._connOpts = {};
		this._host = '';
		this._port = 0;
		this._recvBuf = Buffer.alloc(0);
		// TODO: These flags can be replaced with a single enum variable
		this._expectLoginPrompt = true;
		this._loginPromptReceived = false;
		this._expectPasswordPrompt = false;
		this._passwordPromptReceived = false;
		this._shellPromptReceived = false;
		this._optionsNegotiated = false;
		this._failed = false;
	}
}

module.exports = {
	TELNET_PORT,
	TelnetClientState,
	TelnetClient
};
