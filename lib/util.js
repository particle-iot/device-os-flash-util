import { spawn } from 'child_process';

export async function execCommand(cmd, args, { timeout = 0 } = {}) {
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
				if (timer) {
					clearTimeout(timer);
				}
				reject(new Error(`${cmd} was terminated by SIGTERM`));
			}
			process.off('exit', onExit);
			process.off('SIGINT', onExit);
		};
		process.on('exit', onExit);
		process.on('SIGINT', onExit);
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
				if (timer) {
					clearTimeout(timer);
				}
				reject(new Error(`${cmd} process error: ${err.message}`));
			}
		});
	});
}

export async function delay(ms) {
	return new Promise(resolve => setTimeout(() => resolve(), ms));
}

export function isDeviceId(str) {
	return /^[0-9a-f]{24}$/i.test(str);
};

export function isPrintable(char) {
	return /^[\x20-\x7f]$/.test(char); // ASCII-only
}

export function isSpace(char) {
	return /^\s$/.test(char);
}

export function toUInt32Hex(num) {
	return '0x' + num.toString(16).padStart(8, '0');
}

export function toUInt16Hex(num) {
	return '0x' + num.toString(16).padStart(4, '0');
}
