export { createOption }

import { registerOptionTypes } from "./option-types.js";

/** Helper function to create new options in the game menu

Should run in `onLoopStart` */
function createOption(id, data, type) {
	registerOptionTypes();

	let builder = terra.export.OptionTypeBuilder.builders.get(type);
	if (!builder)
		throw new Error("[TerraTogether] Unknown option type: " + type);

	let option = new builder(id, data);

	let options = terra.export.g_options;
	options.settings[id] = option;
	// Keep a value restored from localStorage/save, otherwise use the default.
	if (options.values[id] === undefined || options.values[id] === null)
		options.values[id] = option.default;

	return option;
}

//# sourceURL=/mods/terra-together/helper.js