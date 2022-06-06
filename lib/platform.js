const deviceConstants = require('@particle/device-constants');

const platforms = Object.values(deviceConstants).filter(p => p.generation >= 2);
const platformsById = platforms.reduce((map, p) => map.set(p.id, p), new Map());
const platformsByName = platforms.reduce((map, p) => map.set(p.name, p), new Map());

function platformForId(id) {
	const p = platformsById.get(id);
	if (!p) {
		throw new RangeError(`Unknown platform ID: ${id}`);
	}
	return p;
}

function platformForName(name) {
	const p = platformsByName.get(name);
	if (!p) {
		throw new RangeError(`Unknown platform name: ${name}`);
	}
	return p;
}

module.exports = {
	platformForId,
	platformForName
};
