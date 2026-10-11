import { registerOptionTypes } from "./option-types.js";
import { createModSettings, SettingsTab } from "./settings.js";
import * as skin from './skin.js';
import * as client from './client.js';
import * as nameplates from './nameplates.js';

window.terraTogether ??= {};

class Multiplayer extends terra.export.Observable {
	onGameMapStart() {
		let hideParty = terra.export.g_options.get("tt-hide-party") ?? false;
		if (hideParty) {
			for (const party of terra.export.g_party?.entities ?? []) {
				party.core.hide(true);
			}
		}
	}

	onOptionEvent(event, key) {
		// Keep the server informed when the player renames themselves.
		if (key === "tt-username") {
			const name = String(terra.export.g_options.get("tt-username") ?? "").trim();
			client.send({ type: "profile", username: name === "" ? null : name });
		}

		if (key === "tt-hide-party") {
			let hideParty = terra.export.g_options.get("tt-hide-party") ?? false;
			if (hideParty) {
				for (const party of terra.export.g_party?.entities ?? []) {
					party.core.hide();
				}
			} else {
				for (const party of terra.export.g_party?.entities ?? []) {
					party.core.show();
				}
			}
		}

		// Apply on change, and whenever the options are (re)loaded. The latter is
		// what makes a stored value take effect on startup, not only when toggled.
		const OPTION_EVENT = terra.export.OPTION_EVENT;
		if (key === "tt-always-focused"
			|| event === OPTION_EVENT.SETTINGS_UPDATED
			|| event === OPTION_EVENT.SETTINGS_LOADED) {
			this.applyAlwaysFocused();
		}
	}

	applyAlwaysFocused() {
		const alwaysFocused = terra.export.g_options.get("tt-always-focused") ?? false;
		window.IG_KEEP_WINDOW_FOCUS = alwaysFocused;
		terra.export.g_system.setWindowFocus(false);
	}

	onAddonInit() {
		// Add the extra setting types (TEXT + BUTTON) before any menu is built.
		registerOptionTypes();

		terra.export.g_options.observers.push(this);

		let stepArray = terra.export.GAME_CONF.FEATURES.flatMap(f => f.steps ?? []).flat();
		terraTogether.steps = Object.fromEntries(stepArray.map(step => [step.key, step]));
	}

	onLoopStart() {
		// Build the settings category and its tab.
		createModSettings();

		// Baseline: apply the stored Always Focused value as soon as the game
		// starts. (A load also re-applies it via SETTINGS_UPDATED.)
		this.applyAlwaysFocused();
	}
}

terra.addAddon(new Multiplayer(), { onAddonInit: -10000, onLoopStart: -10000, onGameMapStart: 35000 });
terra.addAddon(new SettingsTab(), { onLoopStart: 40000 });

//# sourceURL=/mods/terra-together/main.js
