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
		let timer = null;
		if (timeout) {
			timer = setTimeout(() => {
				if (proc) {
					const p = proc;
					proc = null;
					p.kill();
					reject(new Error(`${cmd} has timed out`));
				}
			}, timeout);
		}
		const onExit = () => {
			if (proc) {
				const p = proc;
				proc = null;
				p.kill();
			}
		};
		process.once('exit', onExit);
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
		proc.on('exit', (exitCode, signal) => {
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
		proc.on('error', err => {
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

async function delay(ms) {
	return new Promise(resolve => setTimeout(() => resolve(), ms));
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

module.exports = {
	execCommand,
	delay,
	isDeviceId,
	isPrintable,
	isSpace,
	toUInt32Hex,
	toUInt16Hex
};
