const Particle = require('particle-api-js');

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_API_URL = 'https://api.particle.io';

class ParticleApi {
	constructor({ log }) {
		this._log = log;
		this._api = null;
		this._token = null;
	}

	async init() {
		const conf = this._loadApiSettings();
		this._token = conf.token;
		this._api = new Particle({ baseUrl: conf.url });
		const resp = await this._api.getUserInfo({ auth: this._token });
		const user = resp.body.username;
		this._log.verbose(`Signed in as ${user}`);
	}

	async shutdown() {
		try {
			this._api = null;
		} catch (err) {
			this._log.warn(err.message);
		}
	}

	async getDevices() {
		const resp = await this._api.listDevices({ auth: this._token });
		return resp.body.map(dev => ({
			id: dev.id,
			name: dev.name,
			platformId: dev.platform_id
		}));
	}

	async getDevice(deviceId) {
		const resp = await this._api.getDevice({ deviceId, auth: this._token });
		return resp.body;
	}

	async markDevelopment(deviceId, productId) {
		await this._api.updateDevice({
			deviceId: deviceId,
			auth: this._token,
			development: true,
			flash: false,
			product: productId
		});
	}

	_loadApiSettings() {
		let url = DEFAULT_API_URL;
		let token = process.env.PARTICLE_TOKEN;
		let profile = 'particle';
		// Get the name of the active CLI profile from ~/.particle/profile.json
		let file = path.join(os.homedir(), '.particle', 'profile.json');
		if (fs.existsSync(file)) {
			try {
				const conf = JSON.parse(fs.readFileSync(file, 'utf8'));
				if (conf.name) {
					profile = conf.name;
				}
			} catch (err) {
				this._log.warn(err.message);
			}
		}
		file = path.join(os.homedir(), '.particle', profile + '.config.json');
		if (fs.existsSync(file)) {
			this._log.verbose('Loading API settings:', file);
			try {
				const conf = JSON.parse(fs.readFileSync(file, 'utf8'));
				if (!token && conf.access_token) {
					token = conf.access_token;
				}
				if (conf.apiUrl) {
					url = conf.apiUrl;
				}
			} catch (err) {
				this._log.warn(err.message);
			}
		}
		if (!token) {
			throw new Error('Missing access token for Particle API');
		}
		this._log.debug('Particle API:', url);
		return { url, token };
	}
}

module.exports = {
	ParticleApi
};
