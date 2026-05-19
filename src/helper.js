export { createOption, loadConfig }

const fs = require("fs");

let config = null;

function loadConfig() {
	if (config)
		return config;
	
	try {
		const raw = fs.readFileSync("./mods/terra-together/config.json", 'utf8');
		return JSON.parse(raw);
	} catch (err) {
		if (err.code === 'ENOENT') {
			console.log('[TerraTogether] No config.json found, using defaults.');
		} else {
			console.warn('[TerraTogether] Failed to read config.json:', err.message);
		}
		// Use default config
		return {
			client: {
				username: "Player",
				server_address: "127.0.0.1",
				port: 17005
			},
			server: {
				enabled: false,
				port: 17005
			}
		};
	}
}

/** Helper function to create new options in the game menu

Should run in `onLoopStart` */
function createOption(id, data, type) {
	let builder = terra.export.OptionTypeBuilder.builders.get(type);
	
	let skinOption = new builder(id, data);

	optionManager.settings[id] = skinOption;
	
	// TODO: Options do not save for some reason
	optionManager.restore(id);
}

//# sourceURL=/mods/terra-together/helper.js