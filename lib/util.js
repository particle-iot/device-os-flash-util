const { spawn } = require('child_process');

async function execCommand(cmd, args, { timeout = 0 } = {}) {
	return new Promise((resolve, reject) => {
		let proc = spawn(cmd, args, {
			stdio: [
				'ignore', // stdin
				'pipe', // stdout
				'pipe' // stderr
			]
		});
		const onExit = () => {
			if (proc) {
				proc.kill();
			}
		};
		process.once('exit', onExit);
		let timer = null;
		if (timeout) {
			timer = setTimeout(() => {
				if (proc) {
					const p = proc;
					proc = null;
					process.off('exit', onExit);
					p.kill();
					reject(new Error(`${cmd} has timed out`));
				}
			}, timeout);
		}
		let stdout = '';
		let stderr = '';
		let output = ''; // Combined output
		proc.stdout.on('data', d => {
			stdout += d;
			output += d;
		});
		proc.stderr.on('data', d => {
			stderr += d;
			output += d;
		});
		proc.once('exit', (exitCode, signal) => {
			if (proc) {
				proc = null;
				process.off('exit', onExit);
				if (timer) {
					clearTimeout(timer);
				}
				if (signal) {
					reject(new Error(`${cmd} was terminated by ${signal}`));
				} else {
					resolve({ exitCode, stdout, stderr, output });
				}
			}
		});
		proc.once('error', err => {
			if (proc) {
				proc = null;
				process.off('exit', onExit);
				if (timer) {
					clearTimeout(timer);
				}
				reject(new Error(`${cmd} process error: ${err.message}`));
			}
		});
	});
}

function formatCommand(cmd, args) {
	let s = cmd;
	if (args) {
		s += ' ' + args.map(arg => arg.includes(' ') ? '"' + arg + '"' : arg).join(' ');
	}
	return s;
}

function isDeviceId(str) {
	return /^[0-9a-f]{24}$/i.test(str);
};

function isPrintable(char) {
	return /^[\x20-\x7f]$/.test(char); // ASCII-only
}

function isSpace(char) {
	return /^\s$/.test(char);
}

function toUInt32Hex(num) {
	return '0x' + num.toString(16).padStart(8, '0');
}

function toUInt16Hex(num) {
	return '0x' + num.toString(16).padStart(4, '0');
}

async function delay(ms) {
	return new Promise(resolve => setTimeout(() => resolve(), ms));
}

module.exports = {
	execCommand,
	formatCommand,
	isDeviceId,
	isPrintable,
	isSpace,
	toUInt32Hex,
	toUInt16Hex,
	delay
};
