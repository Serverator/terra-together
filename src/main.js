/**
 * src/main.js
 * Mod entry point (manifest.json "main") — a thin registration/wiring table that
 * hooks the multiplayer features into the engine.
 * Responsibilities:
 *   - Import the feature/config modules (skins + nameplates are side-effect imports:
 *     each registers its own addon at import time).
 *   - Multiplayer addon: option observer, profile send, revive/estus host sync,
 *     always-focused, auto-host, and installing the logo-skip patch.
 *   - Register the SettingsTab and EnemyDebug addons.
 * Public surface: none (side effects only; seeds window.terraTogether)
 * Engine touchpoints: terra.addAddon, terra.export.Observable, g_options, g_party,
 *   g_system, GAME_CONF, OPTION_EVENT; window.terraTogether.steps (+ the globals the
 *   features publish themselves).
 * Notes: The addon priority numbers below are load-order significant — do not
 *   renumber (see the comment on each terra.addAddon call).
 */

import { registerOptionTypes } from "./config/option-types.js";
import { createModSettings, SettingsTab, syncRevive, REVIVE_OPTION, syncEstusShare, ESTUS_OPTION } from "./config/settings.js";
// Imported for its side effect only: registers the SkinManager addon.
import "./features/skins.js";
import * as client from './client/client.js';
import * as server from './server/server.js';
// Imported for its side effect only: registers the Nameplates addon.
import "./features/nameplates.js";
import { EnemyDebug } from './debug/enemy-debug.js';
import { installLogoSkip, skipLogosNow } from './features/logo-skip.js';

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

		// Revive toggle: sync the runtime flag and (when hosting) push it to clients.
		if (key === REVIVE_OPTION) {
			syncRevive();
		}

		// Estus area-heal toggle: same host-authoritative sync.
		if (key === ESTUS_OPTION) {
			syncEstusShare();
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

		// Apply on change and on (re)load; the latter makes stored values apply at startup.
		const OPTION_EVENT = terra.export.OPTION_EVENT;
		if (key === "tt-always-focused"
			|| event === OPTION_EVENT.SETTINGS_UPDATED
			|| event === OPTION_EVENT.SETTINGS_LOADED) {
			this.applyAlwaysFocused();
		}

		// Auto-host: start hosting as soon as the option is enabled (no-op once hosting).
		if (key === "tt-auto-host") {
			this.applyAutoHost();
		}

		// Skip the logos immediately if they happen to be playing when enabled.
		if (key === "tt-skip-logos") {
			this.applySkipLogos();
		}
	}

	// Ends an in-progress intro logo sequence when the option is switched on.
	applySkipLogos() {
		skipLogosNow();
	}

	applyAlwaysFocused() {
		const alwaysFocused = terra.export.g_options.get("tt-always-focused") ?? false;
		window.IG_KEEP_WINDOW_FOCUS = alwaysFocused;
		terra.export.g_system.setWindowFocus(false);
	}

	// Starts hosting when the option is on and we aren't already hosting. Safe to call
	// repeatedly; the client connects to the local server on its next map start.
	applyAutoHost() {
		if (server.isHosting())
			return;
		if (!(terra.export.g_options.get("tt-auto-host") ?? false))
			return;
		const port = parseInt(terra.export.g_options.get("tt-server-port"), 10) || 17005;
		server.startServer("0.0.0.0", port).then(() => { syncRevive(); syncEstusShare(); }).catch(err => {
			console.error("[TerraTogether] Auto-host failed:", err);
		});
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

		// Wrap g_gui.addElement before the game creates its TitleScreen, so the intro
		// logo sequence can be skipped.
		installLogoSkip();

		// Apply the stored Always Focused value at startup (a load re-applies it too).
		this.applyAlwaysFocused();

		// Auto-host: start hosting at startup when the option is enabled.
		this.applyAutoHost();
	}
}

terra.addAddon(new Multiplayer(), { onAddonInit: -10000, onLoopStart: -10000, onGameMapStart: 35000 });
terra.addAddon(new SettingsTab(), { onLoopStart: 40000 });
// Enemy debug overlay: added just after the nameplates so its labels draw on top.
terra.addAddon(new EnemyDebug(), { onLoopStart: 50001 });

//# sourceURL=/mods/terra-together/main.js
