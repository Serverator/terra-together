/**
 * src/features/logo-skip.js
 * Skips the intro developer/promo logo sequence so the title menu appears right away.
 * Responsibilities:
 *   - Wrap g_gui.addElement to catch the TitleScreen as the game adds it.
 *   - Short-circuit LogoScreen.start while the "tt-skip-logos" option is on.
 *   - End an already-running sequence when the option is switched on.
 * Public surface: installLogoSkip, skipLogosNow
 * Engine touchpoints: terra.export.g_gui.addElement / g_gui.hooks, terra.export.g_options
 *   ("tt-skip-logos"), TitleScreen.logoScreen, LogoScreen.start/end/hasEnded.
 * Notes: Purely local/UI — no net code. installLogoSkip() must run before the game
 *   creates its TitleScreen (main.js calls it from Multiplayer.onLoopStart);
 *   skipLogosNow() is the toggle-while-playing path.
 */

// The game shows a LogoScreen (developer + promo logos) once the title scene appears,
// and only reveals the title menu when that sequence ends (TitleScreen.onLogoDown ->
// startBackground; bundle entry _runtime-and-entry.js:1472 starts the screen and :1491
// handles its ENDED callback). We intercept the TitleScreen as it is added so we can
// short-circuit the sequence when the option is on.
function patchLogoScreen(logoScreen) {
	if (!logoScreen || logoScreen.__ttPatched)
		return;
	const originalStart = logoScreen.start;
	logoScreen.start = function (...args) {
		if (terra.export.g_options.get("tt-skip-logos") ?? false) {
			// Fire the same ENDED callback the sequence would, jumping to the title menu.
			this.end();
			return;
		}
		return originalStart.apply(this, args);
	};
	logoScreen.__ttPatched = true;
}

// Idempotent: the guard flag lives on g_gui itself, so a second call is a no-op
// (double-wrapping addElement would run the title-screen hook twice). If g_gui is not
// up yet the flag stays unset, so a later call can still install the patch.
function installLogoSkip() {
	const g_gui = terra.export.g_gui;
	if (!g_gui || g_gui.__ttLogosPatched)
		return;
	const originalAddElement = g_gui.addElement;
	g_gui.addElement = function (element, ...rest) {
		const result = originalAddElement.call(this, element, ...rest);
		try {
			if (element?.constructor?.name === "TitleScreen")
				patchLogoScreen(element.logoScreen);
		}
		catch (err) {
			console.warn("[TerraTogether] Failed to hook the title logo screen:", err);
		}
		return result;
	};
	g_gui.__ttLogosPatched = true;
}

function findTitleScreen() {
	const hook = terra.export.g_gui?.hooks?.find(h => h.gui?.constructor?.name === "TitleScreen");
	return hook?.gui ?? null;
}

// Ends an in-progress intro logo sequence when the option is switched on.
function skipLogosNow() {
	if (!(terra.export.g_options.get("tt-skip-logos") ?? false))
		return;
	const logoScreen = findTitleScreen()?.logoScreen;
	if (logoScreen && !logoScreen.hasEnded())
		logoScreen.end();
}

export { installLogoSkip, skipLogosNow };

//# sourceURL=/mods/terra-together/features/logo-skip.js
