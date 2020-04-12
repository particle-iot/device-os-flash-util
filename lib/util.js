export function isDeviceId(str) {
	return /^[0-9a-f]{24}$/i.test(str);
};

export function isPrintable(char) {
	return /^[\x20-\x7f]$/.test(c); // ASCII-only
}

export function isSpace(char) {
	return /^\s$/.test(c);
}

export async function delay(ms) {
	return new Promise(resolve => setTimeout(() => resolve(), ms));
}
