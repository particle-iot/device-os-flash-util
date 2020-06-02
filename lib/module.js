import { platformForId, PLATFORMS } from './platform';
import { StorageType } from './device';

import { HalModuleParser, ModuleInfo } from 'binary-version-reader';
import { Octokit } from '@octokit/rest';
import decompress from 'decompress';
import download from 'download';
import pLimit from 'p-limit';
import rimraf from 'rimraf';
import mkdirp from 'mkdirp';
import fg from 'fast-glob';
import semver from 'semver';

import * as fs from 'fs';
import * as path from 'path';

const REPO_OWNER = 'particle-iot';
const REPO_NAME = 'device-os';

const MAX_OLDER_RELEASES_TO_CHECK = 20;
const MAX_RELEASES_PER_PAGE = 100;
const MAX_CONCURRENT_DOWNLOADS = 6;

const ModuleFunction = ModuleInfo.FunctionType;

export const ModuleType = {
	USER_PART: 'user_part',
	SYSTEM_PART: 'system_part',
	BOOTLOADER: 'bootloader',
	RADIO_STACK: 'radio_stack',
	NCP_FIRMWARE: 'ncp_firmware'
};

export class ModuleCache {
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

	async getReleaseModules(version, { noCache = false } = {}) {
		let mods = [];
		const releaseDir = path.join(this._cacheDir, version);
		if (!noCache && fs.existsSync(releaseDir)) {
			this._log.info('Found cached release binaries');
			mods = await this._parseModuleBinaries(releaseDir);
		}
		if (!mods.length) {
			this._log.info('Downloading release binaries');
			mods = await this._downloadReleaseBinaries(version, PLATFORMS.map(p => p.id) /* All supported platforms */);
			mods = await this._findMissingBinaries(version, mods);
			if (!mods.length) {
				throw new Error('No release binaries found');
			}
			this._log.verbose('Updating cached binaries');
			rimraf.sync(releaseDir);
			for (let m of mods) {
				const p = platformForId(m.platformId);
				const destDir = path.join(releaseDir, p.name);
				mkdirp.sync(destDir);
				const destFile = path.join(destDir, path.basename(m.file));
				if (m.isAsset) {
					fs.copyFileSync(m.file, destFile);
				} else {
					fs.renameSync(m.file, destFile);
				}
				m.file = destFile;
			}
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
		for (let platformId of modules.keys()) {
			const p = platformForId(platformId);
			const mods = modules.get(platformId);
			let types = [];
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
			for (let m of mods) {
				if (removeMissingModule(m.platformId, m.type)) {
					m.isAsset = true; // This file needs to be copied, not moved
					modules.get(m.platformId).push(m);
				}
			}
		}
		if (missingModules.size) {
			// Remove radio stack and NCP firmware from the list of missing modules, since we never
			// published them for old Device OS versions anyway
			for (let platformId of missingModules.keys()) {
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
			for (let ver of versions) {
				this._log.debug('Checking', ver);
				const mods = await this._downloadReleaseBinaries(ver, Array.from(missingModules.keys()));
				for (let m of mods) {
					if (removeMissingModule(m.platformId, m.type)) {
						modules.get(m.platformId).push(m);
					}
				}
				if (!missingModules.size) {
					break;
				}
			}
		}
		for (let platformId of missingModules.keys()) {
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

	async _downloadReleaseBinaries(version, platformIds) {
		let resp = null;
		const tag = 'v' + version;
		try {
			resp = await this._github.repos.getReleaseByTag({ tag: 'v' + version, repo: REPO_NAME, owner: REPO_OWNER });
		} catch (err) {
			if (err.status === 404) {
				throw new Error(`Release not found: ${tag}`);
			}
			throw err;
		}
		const allAssets = resp.data.assets.map(a => ({
			url: a.browser_download_url,
			file: a.name,
			size: a.size
		}));
		// Get the list of module binaries
		let assets = allAssets.filter(a => a.file.endsWith('.bin'));
		assets = this._filterBinAssetsByPlatform(assets, platformIds);
		if (!assets.length) {
			// FIXME: .zip files contain incomplete sets of binaries
			assets = allAssets.filter(a => a.file.endsWith('.zip'));
			assets = this._filterZipAssetsByPlatform(assets, platformIds);
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
		for (let file of zipFiles) {
			const destDir = path.join(destDir, file.slice(0, -4));
			mkdirp.sync(destDir);
			await decompress(file, destDir);
		}
		const modules = await this._parseModuleBinaries(destDir);
		return modules;
	}

	async _parseModuleBinaries(dir) {
		const modules = new Map();
		const parser = new HalModuleParser();
		const files = fg.sync('**/*.bin', { cwd: dir, onlyFiles: true, absolute: true });
		for (let file of files) {
			let info = null;
			try {
				info = await parser.parseFile(file);
			} catch (err) {
				this._log.warn(err.message);
				continue;
			}
			info = info.prefixInfo;
			let platform = null;
			try {
				platform = platformForId(info.platformID);
			} catch (err) {
				// this._log.warn(err.message);
				continue;
			}
			let type = null;
			let storage = null;
			switch (info.moduleFunction) {
				case ModuleFunction.BOOTLOADER: {
					type = ModuleType.BOOTLOADER;
					storage = StorageType.INTERNAL_FLASH;
					break;
				}
				case ModuleFunction.SYSTEM_PART: {
					type = ModuleType.SYSTEM_PART;
					storage = StorageType.INTERNAL_FLASH;
					break;
				}
				case ModuleFunction.USER_PART: {
					type = ModuleType.USER_PART;
					storage = StorageType.INTERNAL_FLASH;
					break;
				}
				case ModuleFunction.NCP_FIRMWARE: {
					type = ModuleType.NCP_FIRMWARE;
					storage = StorageType.OTHER;
					break;
				}
				case ModuleFunction.RADIO_STACK: {
					type = ModuleType.RADIO_STACK;
					storage = StorageType.INTERNAL_FLASH;
					break;
				}
				case ModuleFunction.MONO_FIRMWARE:
				case ModuleFunction.RESOURCE:
				case ModuleFunction.SETTINGS: {
					continue;
				}
				default: {
					this._log.warn('Unknown module function:', info.moduleFunction);
					continue;
				}
			}
			const startAddr = Number.parseInt(info.moduleStartAddy, 16);
			const endAddr = Number.parseInt(info.moduleEndAddy, 16);
			const fileSize = fs.statSync(file).size;
			const m = {
				platformId: platform.id,
				type,
				index: info.moduleIndex,
				version: info.moduleVersion,
				storage,
				address: startAddr,
				size: endAddr - startAddr,
				file,
				fileSize
			};
			if (info.moduleFlags & ModuleInfo.Flags.DROP_MODULE_INFO) {
				m.dropHeader = true;
				m.headerSize = ModuleInfo.HEADER_SIZE;
			}
			const key = platform.name + ':' + m.type + ':' + m.index.toString();
			const m2 = modules.get(key);
			if (m2) {
				if (m2.version !== m.version) {
					this._log.warn('Found different versions of the same module');
					if (m2.version > m.version) {
						continue;
					}
				} else if (m2.fileSize < m.fileSize) {
					continue; // Likely a debug build
				}
			}
			modules.set(key, m);
		}
		return Array.from(modules.values());
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
			for (let release of resp.data) {
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
		const input = assets.map(a => limit(() => {
			this._log.debug(`Downloading ${a.file}`);
			return download(a.url, dir, { filename: a.file });
		}));
		await Promise.all(input);
	}

	_filterZipAssetsByPlatform(zipAssets, platformIds) {
		const filters = platformIds.map(id => { // File name filters
			const p = platformForId(id);
			return { platformId: id, regExp: new RegExp(`(?:[^a-zA-Z0-9]|^)${p.name}(?:[^a-zA-Z0-9]|$)`) };
		});
		const assets = new Map();
		for (let a of zipAssets) {
			for (let f of filters) {
				if (f.regExp.test(a.file)) {
					const a2 = assets.get(f.platformId);
					if (!a2 || a2.size > a.size) { // Get the smallest file
						assets.set(f.platformId, a);
					}
				}
			}
		}
		return Array.from(assets.values());
	}

	_filterBinAssetsByPlatform(binAssets, platformIds) {
		const filters = platformIds.map(id => { // File name filters
			const p = platformForId(id);
			return { regExp: new RegExp(`(?:[^a-zA-Z0-9]|^)${p.name}(?:[^a-zA-Z0-9]|$)`) };
		});
		const assets = [];
		for (let a of binAssets) {
			for (let f of filters) {
				if (f.regExp.test(a.file)) {
					assets.push(a);
				}
			}
		}
		return assets;
	}

	_getCachedReleaseDir(version) {
		const dir = path.join(this._cacheDir, version);
		if (!fs.existsSync(dir)) {
			return null;
		}
		return dir;
	}
}
