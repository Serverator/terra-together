// Terra Together - player nameplates.
//
// Rendered with the game's own Gui/TextGui (font system) so the labels go
// through the GUI renderer. Each label is anchored to the character's (stable)
// collision-box center and lifted above the head, then positioned with
// hook.transformToMapPos() -- the same approach world HUD elements and NPC
// dialogue use.
//
// The player id -> actor / username data lives in client.js and is shared via
// `window.terraTogether`.

import { loadConfig } from "./helper.js";

const Vec3 = terra.export.Vec3;

const NAMEPLATE_OPTION = "tt-nameplates";
const NAMEPLATE_FONT_SIZE = terra.export.FONT_SIZE.SMALL;
const NAMEPLATE_OUTLINE = terra.export.FONT_OUTLINE.ON;
const NAMEPLATE_FONT_ALIGN = terra.export.FONT_ALIGN.CENTER;
const NAMEPLATE_SCALE = 0.8;
const NAMEPLATE_HEAD_OFFSET = 0.4;

const NAMEPLATE_SELF_ID = "__tt_self__";
const NAMEPLATE_HIDDEN_X = -100000;

const config = loadConfig();
const nameplateWorld = new Vec3();

let nameplateLogged = false;

// Always render *something*: missing/empty names fall back to "Player".
function getNameplateText(name) {
	const trimmed = name == null ? "" : String(name).trim();
	return trimmed === "" ? "Player" : trimmed;
}

// World position just above the character, based on the stable collision box
// (not the animated head bone, which bobs while walking).
function getNameplateHeadPos(actor) {
	const core = actor?.core;
	if (!core) return null;

	const coll = core.colls?.[0];
	const sizeZ = coll?.size?.z ?? 2;

	const tools = terra.export.EntityTools;
	const align = terra.export.ENT_ALIGN;
	if (tools?.getAlignedPos && align) {
		const pos = tools.getAlignedPos(nameplateWorld, actor, align.CENTER);
		if (pos) {
			pos.z += sizeZ * 0.5 + NAMEPLATE_HEAD_OFFSET;
			return pos;
		}
	}

	const z = core.pos.z + sizeZ + NAMEPLATE_HEAD_OFFSET;
	return nameplateWorld.setC(core.pos.x, core.pos.y, z);
}

// One in-game TextGui per player, positioned over the head each frame.
class NameplateGui extends terra.export.GuiElement {
	constructor() {
		super();
		this.entries = new Map();
		this.hook.zIndex = 6;
		this.hook.updateOnPause = true;
		this.setSize(terra.export.g_system.size.x, terra.export.g_system.size.y);
	}

	createEntry(id) {
		const text = new terra.export.TextGui("", {
			size: NAMEPLATE_FONT_SIZE,
			outline: NAMEPLATE_OUTLINE,
			align: NAMEPLATE_FONT_ALIGN,
			dynamic: true,
			skipAutoPivot: true
		});
		text.setAlign(terra.export.GUI_ALIGN_X.LEFT, terra.export.GUI_ALIGN_Y.TOP);
		text.setPivot(0, 0);
		text.hook.scale = NAMEPLATE_SCALE;
		const entry = { text, name: null };
		this.entries.set(id, entry);
		this.addChild(text);
		return entry;
	}

	updateEntry(id, actor, name) {
		const entry = this.entries.get(id) ?? this.createEntry(id);

		const label = getNameplateText(name);
		if (entry.name !== label) {
			entry.name = label;
			entry.text.setText(label);
		}

		const pos = actor?.core?.isVisible?.() ? getNameplateHeadPos(actor) : null;
		if (!pos) {
			entry.text.hook.pos.setC(NAMEPLATE_HIDDEN_X, 0);
			return;
		}

		const text = entry.text;
		text.hook.transformToMapPos(pos, true);
		// Pivot is the top-left corner, so scale is applied about it directly.
		text.hook.pos.x -= text.hook.size.x * NAMEPLATE_SCALE * 0.5;
		text.hook.pos.y -= text.hook.size.y * NAMEPLATE_SCALE;
	}

	update() {
		if (!nameplateLogged) {
			nameplateLogged = true;
			console.log("[TerraTogether] Nameplate GUI active");
		}

		const actors = window.terraTogether?.playerActors;
		const names = window.terraTogether?.playerNames;
		const active = new Set();

		if (terra.export.g_scene?.isRunning?.() && !terra.export.g_scene?.isCutscene?.()) {
			const options = terra.export.g_options;
			const mode = options ? (options.get(NAMEPLATE_OPTION) ?? 2) : 2;
			if (mode) {
				if (actors) {
					for (const [id, actor] of actors) {
						active.add(id);
						this.updateEntry(id, actor, names?.get(id));
					}
				}
				if (mode >= 2) {
					active.add(NAMEPLATE_SELF_ID);
					this.updateEntry(NAMEPLATE_SELF_ID, terra.export.g_player?.entity, config?.client?.username);
				}
			}
		}

		for (const [id, entry] of [...this.entries]) {
			if (!active.has(id)) {
				this.removeChild(entry.text);
				this.entries.delete(id);
			}
		}
	}
}
NameplateGui.states = {
	DEFAULT: { transform: { alpha: 1 }, duration: 0 },
	HIDDEN: { transform: { alpha: 0 }, duration: 0 }
};

class Nameplates {
	onLoopStart() {
		terra.export.g_gui.addElement(new NameplateGui(), true);
	}
}

terra.addAddon(new Nameplates(), { onLoopStart: 50000 });

export { NameplateGui };

//# sourceURL=/mods/terra-together/nameplates.js
