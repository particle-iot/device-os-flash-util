const { platformForId, ModuleType } = require('./platform');

const { HalModuleParser, ModuleInfo } = require('binary-version-reader');
const { Octokit } = require('@octokit/rest');
const decompress = require('decompress');
const download = require('download');
const pLimit = require('p-limit');
const rimraf = require('rimraf');
const mkdirp = require('mkdirp');
const fg = require('fast-glob');
const semver = require('semver');

const fs = require('fs');
const path = require('path');

const REPO_OWNER = 'particle-iot';
const REPO_NAME = 'device-os';

const MAX_OLDER_RELEASES_TO_CHECK = 20;
const MAX_RELEASES_PER_PAGE = 100;
const MAX_CONCURRENT_DOWNLOADS = 6;

const {
	FunctionType: ModuleFunction,
	Flags: ModuleFlag,
	MODULE_PREFIX_SIZE
} = ModuleInfo;

class ModuleCache {
	constructor({ cacheDir, tempDir, log }) {
		this._log = log;
		this._tempDir = tempDir;
		this._cacheDir = cacheDir;
		this._github = null;
	}

	async init() {
		mkdirp.sync(this._cacheDir);
		const opts = {};
		const token = process.env.GITHUB_TOKEN;
		if (token) {
			opts.auth = token;
		}
		this._github = new Octokit(opts);
	}

	async shutdown() {
		try {
			this._github = null;
		} catch (err) {
			this._log.warn(err.message);
		}
	}

	async getReleaseModules(version, { noCache = false, draft = false } = {}) {
		let mods = [];
		const releaseDir = path.join(this._cacheDir, version);
		if (!noCache && fs.existsSync(releaseDir)) {
			this._log.info('Found cached module binaries');
			mods = await this._parseModuleBinaries(releaseDir);
		}
		if (!mods.length) {
			this._log.info('Downloading release binaries');
			const release = await this._downloadRelease(version, { draft });
			mods = release.modules;
			mods = await this._findMissingBinaries(version, mods);
			if (!mods.length) {
				throw new Error('No release binaries found');
			}
			// Do not cache draft releases
			if (!release.draft) {
				this._log.verbose('Updating cached binaries');
				rimraf.sync(releaseDir);
				for (const m of mods) {
					const p = platformForId(m.platformId);
					const destDir = path.join(releaseDir, p.name);
					mkdirp.sync(destDir);
					const destFile = path.join(destDir, path.basename(m.file));
					// NOTE: fs.renameSync() may fail across partitions at least on Linux
					fs.copyFileSync(m.file, destFile);
					if (!m.isAsset) {
						fs.unlinkSync(m.file);
					}
					m.file = destFile;
				}
			}
		}
		return mods;
	}

	async getModulesFromPath(fileOrDir) {
		let mods = null;
		const s = fs.statSync(fileOrDir);
		if (s.isDirectory(fileOrDir)) {
			mods = await this._parseModuleBinaries(fileOrDir);
		} else if (fileOrDir.endsWith('.zip')) {
			const dir = path.join(this._tempDir, path.basename(fileOrDir).slice(0, -4));
			mkdirp.sync(dir);
			await decompress(fileOrDir, dir);
			mods = await this._parseModuleBinaries(dir);
		} else {
			const m = await this._parseModuleBinary(fileOrDir);
			mods = [m];
		}
		return mods;
	}

	async _findMissingBinaries(version, modules) {
		// Group modules by platform ID
		modules = modules.reduce((map, m) => {
			let mods = map.get(m.platformId);
			if (!mods) {
				mods = [];
				map.set(m.platformId, mods);
			}
			mods.push(m);
			return map;
		}, new Map());
		const missingModules = new Map();
		const addMissingModule = (platformId, moduleType) => {
			let types = missingModules.get(platformId);
			if (!types) {
				types = new Set();
				missingModules.set(platformId, types);
			}
			types.add(moduleType);
		};
		const removeMissingModule = (platformId, moduleType) => {
			const types = missingModules.get(platformId);
			if (!types) {
				return false;
			}
			if (!types.delete(moduleType)) {
				return false;
			}
			if (!types.size) {
				missingModules.delete(platformId);
			}
			return true;
		};
		for (const platformId of modules.keys()) {
			const p = platformForId(platformId);
			const mods = modules.get(platformId);
			if (p.hasRadioStack && !mods.some(m => m.type === ModuleType.RADIO_STACK)) {
				addMissingModule(platformId, ModuleType.RADIO_STACK);
			}
			if (p.hasNcpFirmware && !mods.some(m => m.type === ModuleType.NCP_FIRMWARE)) {
				addMissingModule(platformId, ModuleType.NCP_FIRMWARE);
			}
			if (!mods.some(m => m.type === ModuleType.USER_PART)) {
				addMissingModule(platformId, ModuleType.USER_PART);
			}
			if (!mods.some(m => m.type === ModuleType.BOOTLOADER)) {
				addMissingModule(platformId, ModuleType.BOOTLOADER);
			}
		}
		if (missingModules.size) {
			// Check the bundled binaries
			const dir = path.resolve(__dirname, '../assets/binaries');
			const mods = await this._parseModuleBinaries(dir);
			for (const m of mods) {
				if (removeMissingModule(m.platformId, m.type)) {
					m.isAsset = true; // This file needs to be copied, not moved
					modules.get(m.platformId).push(m);
				}
			}
		}
		if (missingModules.size) {
			// Remove radio stack and NCP firmware from the list of missing modules, since we never
			// published them for old Device OS versions anyway
			for (const platformId of missingModules.keys()) {
				const types = Array.from(missingModules.get(platformId).values());
				const noRadioStack = types.some(t => t === ModuleType.RADIO_STACK);
				const noNcpFirmware = types.some(t => t === ModuleType.NCP_FIRMWARE);
				if (noRadioStack) {
					this._log.warn('Radio stack module not found; platform ID:', platformId);
					removeMissingModule(platformId, ModuleType.RADIO_STACK);
				}
				if (noNcpFirmware) {
					this._log.warn('NCP firmware not found; platform ID:', platformId);
					removeMissingModule(platformId, ModuleType.NCP_FIRMWARE);
				}
			}
		}
		if (missingModules.size) {
			// Check older releases
			this._log.verbose('Some module binaries are missing; checking older releases');
			let versions = await this._listOlderReleaseVersions(version);
			versions = versions.slice(0, MAX_OLDER_RELEASES_TO_CHECK);
			for (const ver of versions) {
				this._log.debug('Checking', ver);
				const { modules: mods } = await this._downloadRelease(ver);
				for (const m of mods) {
					if (m.type === ModuleType.USER_PART && !m.file.match(/tinker/i) ||
							m.type === ModuleType.BOOTLOADER && !m.file.match(/bootloader/i)) {
						continue;
					}
					if (removeMissingModule(m.platformId, m.type)) {
						modules.get(m.platformId).push(m);
					}
				}
				if (!missingModules.size) {
					break;
				}
			}
		}
		for (const platformId of missingModules.keys()) {
			const types = Array.from(missingModules.get(platformId).values());
			const noUserPart = types.some(t => t === ModuleType.USER_PART);
			const noBootloader = types.some(t => t === ModuleType.BOOTLOADER);
			if (noUserPart) {
				this._log.warn('User part module not found; platform ID:', platformId);
			}
			if (noBootloader) {
				this._log.warn('Bootloader module not found; platform ID:', platformId);
			}
		}
		modules = Array.from(modules.values()).reduce((arr, mods) => arr.concat(mods), []);
		return modules;
	}

	async _findDraftRelease(version) {
		let page = 1;
		for (;;) {
			const resp = await this._github.repos.listReleases({
				page,
				per_page: MAX_RELEASES_PER_PAGE,
				repo: REPO_NAME,
				owner: REPO_OWNER
			});
			if (!resp.data.length) {
				return null;
			}
			for (const release of resp.data) {
				let ver = release.tag_name;
				if (ver && release.draft) {
					if (ver.startsWith('v')) {
						ver = ver.slice(1);
					}
					if (semver.eq(ver, version)) {
						return release;
					}
				}
			}
			++page;
		}
	}

	async _downloadRelease(version, { draft = false } = {}) {
		let release = null;
		try {
			const resp = await this._github.repos.getReleaseByTag({ tag: 'v' + version, repo: REPO_NAME, owner: REPO_OWNER });
			release = resp.data;
		} catch (err) {
			if (err.status !== 404) {
				throw err;
			}
			try {
				// Try a tag without 'v'
				const resp = await this._github.repos.getReleaseByTag({ tag: version, repo: REPO_NAME, owner: REPO_OWNER });
				release = resp.data;
			} catch (err) {
				if (err.status !== 404) {
					throw err;
				}
				if (draft) {
					// Check for draft release before erroring
					release = await this._findDraftRelease(version);
				}
				if (!release) {
					throw new Error(`Release not found: ${version}`);
				}
			}
		}
		const allAssets = release.assets.map(a => ({
			url: a.url,
			file: a.name,
			size: a.size
		}));
		// Get the list of module binaries
		let assets = allAssets.filter(a => a.file.endsWith('.bin'));
		if (!assets.length) {
			// FIXME: .zip files contain incomplete sets of binaries
			assets = allAssets.filter(a => a.file.endsWith('.zip'));
			if (!assets.length) {
				return [];
			}
		}
		// Download files
		const destDir = path.join(this._tempDir, 'downloads', version);
		mkdirp.sync(destDir);
		await this._downloadAssets(assets, destDir);
		// Unpack all .zip files
		const zipFiles = fg.sync('*.zip', { cwd: destDir, onlyFiles: true, absolute: true });
		for (const file of zipFiles) {
			const dir = path.join(destDir, file.slice(0, -4));
			mkdirp.sync(dir);
			await decompress(file, dir);
		}
		const modules = await this._parseModuleBinaries(destDir);
		return { modules, draft: release.draft };
	}

	async _parseModuleBinaries(dir) {
		const modules = new Map();
		const files = fg.sync('**/*.bin', { cwd: dir, onlyFiles: true, absolute: true });
		for (const file of files) {
			let m = null;
			try {
				m = await this._parseModuleBinary(file);
			} catch (err) {
				this._log.warn('Skipping module binary:', path.basename(file));
				this._log.warn(err.message);
				continue;
			}
			const platform = platformForId(m.platformId);
			const key = platform.name + ':' + m.type + ':' + m.index.toString();
			const m2 = modules.get(key);
			if (m2) {
				const isTinker = (m.type === ModuleType.USER_PART && m.file.match(/tinker/i));
				const hasTinker = (m2.type === ModuleType.USER_PART && m2.file.match(/tinker/i));
				if (hasTinker && !isTinker) { // Prefer Tinker
					continue;
				}
				if (hasTinker || !isTinker) {
					if (m2.version !== m.version) {
						this._log.warn('Found different versions of the same module type');
						if (m2.version > m.version) { // Prefer the higher version
							continue;
						}
					} else if (m2.fileSize < m.fileSize) { // Prefer the smaller binary
						continue;
					}
				}
			}
			modules.set(key, m);
		}
		return Array.from(modules.values());
	}

	async _parseModuleBinary(file) {
		const parser = new HalModuleParser();
		const bin = fs.readFileSync(file);
		let info = await parser.parseBuffer({ fileBuffer: bin });
		const crcValid = info.crc.ok;
		if (!crcValid) {
			this._log.warn('CRC check failed:', path.basename(file));
		}
		info = info.prefixInfo;
		const platform = platformForId(info.platformID);
		let type = null;
		switch (info.moduleFunction) {
			case ModuleFunction.BOOTLOADER: {
				type = ModuleType.BOOTLOADER;
				break;
			}
			case ModuleFunction.SYSTEM_PART: {
				type = ModuleType.SYSTEM_PART;
				break;
			}
			case ModuleFunction.USER_PART: {
				type = ModuleType.USER_PART;
				break;
			}
			case ModuleFunction.NCP_FIRMWARE: {
				type = ModuleType.NCP_FIRMWARE;
				break;
			}
			case ModuleFunction.RADIO_STACK: {
				type = ModuleType.RADIO_STACK;
				break;
			}
			case ModuleFunction.MONO_FIRMWARE:
			case ModuleFunction.RESOURCE:
			case ModuleFunction.SETTINGS: {
				throw new Error(`Unsupported module function: ${info.moduleFunction}`);
			}
			default: {
				throw new Error(`Unknown module function: ${info.moduleFunction}`);
			}
		}
		const storageInfo = platform.storageForFirmwareModule(type, info.moduleIndex);
		if (!storageInfo) {
			throw new Error('Cannot determine storage device for firmware module');
		}
		const startAddr = Number.parseInt(info.moduleStartAddy, 16);
		const endAddr = Number.parseInt(info.moduleEndAddy, 16);
		const fileSize = fs.statSync(file).size;
		const m = {
			platformId: platform.id,
			type,
			index: info.moduleIndex,
			version: info.moduleVersion,
			storage: storageInfo.type,
			address: startAddr,
			moduleSize: endAddr - startAddr + 4 /* CRC-32 */,
			headerSize: MODULE_PREFIX_SIZE,
			dropHeader: !!(info.moduleFlags & ModuleFlag.DROP_MODULE_INFO),
			encrypted: !!(info.moduleFlags & ModuleFlag.ENCRYPTED),
			needsToBeEncrypted: storageInfo.encrypted,
			crcValid,
			fileSize,
			file
		};
		if (info.moduleFlags & ModuleInfo.Flags.DROP_MODULE_INFO) {
			m.dropHeader = true;
			m.headerSize = ModuleInfo.HEADER_SIZE;
		}
		return m;
	}

	async _listOlderReleaseVersions(version) {
		let versions = new Set();
		// List all releases
		let page = 1;
		for (;;) {
			const resp = await this._github.repos.listReleases({
				page,
				per_page: MAX_RELEASES_PER_PAGE,
				repo: REPO_NAME,
				owner: REPO_OWNER
			});
			if (!resp.data.length) {
				break;
			}
			for (const release of resp.data) {
				let ver = release.tag_name;
				if (ver) {
					if (ver.startsWith('v')) {
						ver = ver.slice(1);
					}
					if (semver.valid(ver)) {
						versions.add(ver);
					}
				}
			}
			++page;
		}
		versions = Array.from(versions.values());
		versions = versions.filter(v => semver.lt(v, version));
		versions.sort(semver.compare).reverse(); // Sort in descending order
		return versions;
	}

	async _downloadAssets(assets, dir) {
		const limit = pLimit(MAX_CONCURRENT_DOWNLOADS);
		const promises = assets.map(a => limit(() => {
			this._log.debug('Downloading', a.file);
			const opts = {
				filename: a.file,
				headers: {
					accept: 'application/octet-stream'
				}
			};
			if (process.env.GITHUB_TOKEN) {
				opts.headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
			}
			return download(a.url, dir, opts);
		}));
		await Promise.all(promises);
	}
}

module.exports = {
	ModuleCache
};
