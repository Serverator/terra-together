/**
 * src/features/nameplates.js
 * Player nameplates and HP bars, drawn above each character with the game's Gui/TextGui.
 * Responsibilities:
 *  - NameplateGui, a GuiElement added to g_gui on loop start, one entry per visible actor
 *  - name text, scaled by the tt-nameplate-scale option
 *  - HP bar ColorGuis: fill ramp, pending-heal preview, lost-HP flash, downed/revive slices
 *  - what peers/self show, from the tt-nameplates / tt-hpbar options
 * Public surface: none (registers its own Nameplates addon at import time)
 * Engine touchpoints: terra.addAddon (onLoopStart 50000), terra.export g_gui / g_options /
 *  g_scene / g_player / g_system / g_tick, GuiElement, TextGui, ColorGui, Color;
 *  window.terraTogether.playerActors / playerNames / reviveState (see src/client/client.js)
 * Notes: building and anchoring the label text lives in ../debug/labels.js, shared with
 *  src/debug/enemy-debug.js (the font/align enum refs are documented there). Bar geometry
 *  is in nameplate text pixels, so it scales with the text at any Nameplate Scale.
 */

import { createLabel, headLabelPos, anchorLabel, placeLabelAbove, hideLabel, LABEL_HIDDEN_X } from "../debug/labels.js";

const NAMEPLATE_OPTION = "tt-nameplates";
const HPBAR_OPTION = "tt-hpbar";
const USERNAME_OPTION = "tt-username";
const NAMEPLATE_SCALE_OPTION = "tt-nameplate-scale";

// HP bar drawn under each nameplate. Solid rectangles via ColorGui; auto-disabled
// (nameplates still work) if the exports are missing.
const ColorGui = terra.export.ColorGui;
const Color = terra.export.Color;
const HP_BAR_ENABLED = !!ColorGui && !!Color;
// Bar geometry, in the *same pixel units as the nameplate text* (1:1 with text pixels),
// so it scales with the Nameplate Scale option exactly like the text does.
const HP_BAR_WIDTH = 32;    // px
const HP_BAR_HEIGHT = 2;    // px
const HP_BAR_OUTLINE = 1;   // px
const HP_BAR_GAP = 0;       // px between the text and the bar
// Fill starts at the game's combat HUD green (media/gui/combat.png) and ramps to red
// at low HP; dark grey track; black outline.
const HP_BAR_OUTLINE_COLOR = HP_BAR_ENABLED ? new Color(0.06, 0.06, 0.06, 1) : null;
const HP_BAR_BG_COLOR = HP_BAR_ENABLED ? new Color(55 / 255, 55 / 255, 55 / 255, 1) : null;
const HP_BAR_FILL_HIGH = HP_BAR_ENABLED ? new Color(44 / 255, 176 / 255, 68 / 255, 1) : null;
const HP_BAR_FILL_MID = HP_BAR_ENABLED ? new Color(222 / 255, 176 / 255, 32 / 255, 1) : null;
const HP_BAR_FILL_LOW = HP_BAR_ENABLED ? new Color(214 / 255, 48 / 255, 40 / 255, 1) : null;
// Pending-heal (HoT) preview. Deliberately brighter than the HUD's HEAL color -- this is
// rgb(55,110,110), while hp-hud.js HUD_COLORS_HP.HEAL is #274747 = rgb(39,71,71). Same teal
// family, but NOT the same value; the gap is intentional so the thin nameplate bar reads.
const HP_BAR_REG_COLOR = HP_BAR_ENABLED ? new Color(55 / 255, 110 / 255, 110 / 255, 1) : null;
// Lost-HP flash: on damage the lost slice shows in pink, lingers at full for
// HP_BAR_DAMAGE_HOLD seconds, then drains toward the current HP
// (fraction of max HP per second), like the HUD's used portion.
const HP_BAR_DAMAGE_COLOR = HP_BAR_ENABLED ? new Color(255 / 255, 168 / 255, 110 / 255, 1) : null;
const HP_BAR_DAMAGE_HOLD = 0.35;   // seconds before the pink starts draining
const HP_BAR_DAMAGE_SPEED = 0.4;   // fraction of max HP per second
// Top-pixel sheen: a lighter top row over the 2px bar gives it a little depth.
// Drawn as a translucent white overlay so it blends with whatever is beneath
// (fill, regen/damage slices, track, and the downed/revive bars).
const HP_BAR_GLOSS_COLOR = HP_BAR_ENABLED ? new Color(1, 1, 1, 0.3) : null;
// Downed/revive bars: darker purple = bleed-out time remaining, lighter purple = how
// far a teammate's revive has progressed.
const HP_BAR_DOWNED_COLOR = HP_BAR_ENABLED ? new Color(150 / 255, 60 / 255, 220 / 255, 1) : null;
const HP_BAR_REVIVE_COLOR = HP_BAR_ENABLED ? new Color(205 / 255, 130 / 255, 255 / 255, 1) : null;

function setBarColor(color, src) {
	if (!color || !src) return;
	color.r = src.r; color.g = src.g; color.b = src.b; color.a = src.a;
}

// Radio index -> scale; must match the "Nameplate Scale" list in src/config/settings.js.
const NAMEPLATE_SCALES = [0.5, 1.0, 1.5];
const NAMEPLATE_SCALE_DEFAULT = 1.0;

function getNameplateScale() {
	const index = terra.export.g_options?.get(NAMEPLATE_SCALE_OPTION);
	return NAMEPLATE_SCALES[index] ?? NAMEPLATE_SCALE_DEFAULT;
}

const NAMEPLATE_SELF_ID = "__tt_self__";

// Empty/whitespace nicknames have no nameplate at all.
function getNameplateText(name) {
	const trimmed = name == null ? "" : String(name).trim();
	return trimmed === "" ? null : trimmed;
}

function hideBar(entry) {
	if (entry.barOutline) for (const seg of entry.barOutline) seg.hook.pos.setC(LABEL_HIDDEN_X, 0);
	entry.barBg?.hook.pos.setC(LABEL_HIDDEN_X, 0);
	entry.barRegen?.hook.pos.setC(LABEL_HIDDEN_X, 0);
	entry.barDamage?.hook.pos.setC(LABEL_HIDDEN_X, 0);
	entry.barFill?.hook.pos.setC(LABEL_HIDDEN_X, 0);
	entry.barGloss?.hook.pos.setC(LABEL_HIDDEN_X, 0);
	// Forget the last-shown HP so a re-shown bar doesn't flash a stale drop.
	entry.hpShown = null;
	entry.damageHold = 0;
}

function hideEntry(entry) {
	hideLabel(entry.text);
	hideBar(entry);
}

function clampRatio(v) {
	return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

// Bars are drawn in the text's pixel space: `scale` is the nameplate text's scale, so
// `w`/`h` are text pixels and stay 1:1 with the text at any scale; `x`/`y` are screen-space.
function layoutBar(bar, scale, x, y, w, h) {
	if (!bar) return;
	bar.hook.scale = scale;
	bar.hook.pos.setC(x, y);
	bar.hook.size.setC(w, h);
}

// Red (<=20%) -> yellow (50%) -> green (>=80%), interpolated in between. Below 20%
// and above 80% are solid so the fill doesn't shift while regenerating/dying.
function hpBarFillColor(color, ratio) {
	let from, to, t;
	if (ratio <= 0.2) {
		from = HP_BAR_FILL_LOW;
		to = HP_BAR_FILL_LOW;
		t = 0;
	}
	else if (ratio <= 0.5) {
		from = HP_BAR_FILL_LOW;
		to = HP_BAR_FILL_MID;
		t = (ratio - 0.2) / 0.3;
	}
	else if (ratio <= 0.8) {
		from = HP_BAR_FILL_MID;
		to = HP_BAR_FILL_HIGH;
		t = (ratio - 0.5) / 0.3;
	}
	else {
		from = HP_BAR_FILL_HIGH;
		to = HP_BAR_FILL_HIGH;
		t = 0;
	}
	color.r = from.r + (to.r - from.r) * t;
	color.g = from.g + (to.g - from.g) * t;
	color.b = from.b + (to.b - from.b) * t;
	color.a = 1;
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
		const text = createLabel(getNameplateScale());
		const entry = { text, name: null, barOutline: null, barBg: null, barRegen: null, barDamage: null, barFill: null, barGloss: null, hpShown: null, damage: 0, damageHold: 0 };
		if (HP_BAR_ENABLED) {
			// Outline as 4 edges with the corner pixels omitted, so the bar looks rounded.
			entry.barOutline = [];
			for (let i = 0; i < 4; i++) {
				const seg = new ColorGui(HP_BAR_OUTLINE_COLOR);
				entry.barOutline.push(seg);
				this.addChild(seg);
			}
			entry.barBg = new ColorGui(HP_BAR_BG_COLOR);
			entry.barRegen = new ColorGui(HP_BAR_REG_COLOR);
			entry.barDamage = new ColorGui(HP_BAR_DAMAGE_COLOR);
			entry.barFill = new ColorGui(HP_BAR_FILL_HIGH);
			entry.barGloss = new ColorGui(HP_BAR_GLOSS_COLOR);
			this.addChild(entry.barBg);
			this.addChild(entry.barRegen);
			this.addChild(entry.barDamage);
			this.addChild(entry.barFill);
			// Added last so its top row draws over the fill/slices/track.
			this.addChild(entry.barGloss);
		}
		this.entries.set(id, entry);
		this.addChild(text);
		return entry;
	}

	updateEntry(id, actor, name, hp, hpTarget, showName, showBar, downedFrac = null, reviveFrac = null) {
		const entry = this.entries.get(id) ?? this.createEntry(id);

		// The name and the HP bar are independent: either can show without the other.
		const label = getNameplateText(name);
		const wantName = showName && label != null;
		const wantBar = showBar && !!entry.barBg;
		if (!wantName && !wantBar) {
			hideEntry(entry);
			return;
		}

		if (wantName && entry.name !== label) {
			entry.name = label;
			entry.text.setText(label);
		}

		const pos = actor?.core?.isVisible?.() ? headLabelPos(actor) : null;
		if (!pos) {
			hideEntry(entry);
			return;
		}

		const text = entry.text;
		const scale = getNameplateScale();

		// Screen-space anchor at the head. The name and the bar are stacked bottom-up from
		// this baseline, so a lone element sits at the same height whether it is the name
		// or the bar. When both are shown, the bar keeps the baseline and the name is
		// raised above it by the bar's height (fill + one outline, plus the gap).
		anchorLabel(text, scale, pos);
		const anchorX = text.hook.pos.x;
		let stackY = text.hook.pos.y;

		const o = HP_BAR_OUTLINE;
		const H = HP_BAR_HEIGHT;

		if (entry.barBg) {
			if (!wantBar) {
				hideBar(entry);
			}
			else {
				const W = HP_BAR_WIDTH;
				// Bar bottom (including its bottom outline) rests on the baseline.
				const barX = anchorX - W * scale * 0.5;
				const barY = stackY - (H + o) * scale;
				const px = (lx) => barX + lx * scale;
				const py = (ly) => barY + ly * scale;
				// Outline edges only: the 4 corner pixels are left empty (rounded corners).
				layoutBar(entry.barOutline[0], scale, px(0), py(-o), W, o);
				layoutBar(entry.barOutline[1], scale, px(0), py(H), W, o);
				layoutBar(entry.barOutline[2], scale, px(-o), py(0), o, H);
				layoutBar(entry.barOutline[3], scale, px(W), py(0), o, H);
				layoutBar(entry.barBg, scale, barX, barY, W, H);

				// Fraction (0..1) of the bar that is coloured (i.e. not empty track); the sheen
				// only covers that part. Set per state below.
				let glossFrac = 0;

				if (downedFrac != null) {
					// Downed: bleed-out time (darker) with revive progress (lighter) over it.
					setBarColor(entry.barRegen.color, HP_BAR_DOWNED_COLOR);
					setBarColor(entry.barFill.color, HP_BAR_REVIVE_COLOR);
					layoutBar(entry.barDamage, scale, barX, barY, 0.0001, H);
					layoutBar(entry.barRegen, scale, barX, barY, Math.max(0.0001, W * clampRatio(downedFrac)), H);
					layoutBar(entry.barFill, scale, barX, barY, Math.max(0.0001, W * clampRatio(reviveFrac ?? 0)), H);
					glossFrac = Math.max(clampRatio(downedFrac), clampRatio(reviveFrac ?? 0));
					entry.hpShown = null;
					entry.damage = 0;
					entry.damageHold = 0;
				}
				else {
					const ratio = clampRatio(hp);

					// Lost-HP flash: remember the pre-damage level, hold it briefly, then drain
					// it toward the current HP. Drawn from 0, so the fill hides all but the lost
					// slice.
					if (entry.hpShown == null) {
						entry.damage = ratio;
						entry.damageHold = 0;
					}
					else if (ratio < entry.hpShown - 1e-4) {
						entry.damage = Math.max(entry.damage, entry.hpShown);
						entry.damageHold = HP_BAR_DAMAGE_HOLD;
					}
					entry.hpShown = ratio;
					const dt = terra.export.g_tick?.real ?? 0;
					if (entry.damage > ratio) {
						if (entry.damageHold > 0)
							entry.damageHold = Math.max(0, entry.damageHold - dt);
						else
							entry.damage = Math.max(ratio, entry.damage - HP_BAR_DAMAGE_SPEED * dt);
					}
					else {
						entry.damage = ratio;
						entry.damageHold = 0;
					}

					// Pending-heal preview extends from the current HP to where it will stop.
					const target = Math.max(ratio, clampRatio(hpTarget ?? hp));
					setBarColor(entry.barRegen.color, HP_BAR_REG_COLOR);
					setBarColor(entry.barDamage.color, HP_BAR_DAMAGE_COLOR);
					layoutBar(entry.barRegen, scale, barX, barY, Math.max(0.0001, W * target), H);
					layoutBar(entry.barDamage, scale, barX, barY, Math.max(0.0001, W * entry.damage), H);
					layoutBar(entry.barFill, scale, barX, barY, Math.max(0.0001, W * ratio), H);
					hpBarFillColor(entry.barFill.color, ratio);
					glossFrac = Math.max(ratio, target, entry.damage);
				}
				// Sheen: a lighter top pixel row, drawn only over the coloured portion so the
				// empty track stays flat.
				layoutBar(entry.barGloss, scale, barX, barY, Math.max(0.0001, W * clampRatio(glossFrac)), 1);
				// Raise the baseline above the bar for the name: bar fill plus one outline
				// (so the name sits on the top outline, as before) plus the configured gap.
				stackY -= (H + o + HP_BAR_GAP) * scale;
			}
		}

		if (wantName) {
			placeLabelAbove(text, anchorX, stackY, scale);
		}
		else {
			hideLabel(text);
		}
	}

	update() {
		const actors = window.terraTogether?.playerActors;
		const names = window.terraTogether?.playerNames;
		const active = new Set();

		if (terra.export.g_scene?.isRunning?.() && !terra.export.g_scene?.isCutscene?.()) {
			const options = terra.export.g_options;
			const nameMode = options ? (options.get(NAMEPLATE_OPTION) ?? 2) : 2;
			const hpMode = options ? (options.get(HPBAR_OPTION) ?? 2) : 2;
			if (nameMode || hpMode) {
				const peerName = nameMode >= 1;
				const peerBar = hpMode >= 1;
				if (actors && (peerName || peerBar)) {
					const rs = window.terraTogether?.reviveState;
					for (const [id, actor] of actors) {
						active.add(id);
						const downedFrac = actor?.terraTogether?.downedFrac ?? null;
						const reviveFrac = rs?.target === id ? rs.targetFrac : null;
						this.updateEntry(id, actor, names?.get(id), actor?.terraTogether?.hp, actor?.terraTogether?.hpTarget, peerName, peerBar || downedFrac != null, downedFrac, reviveFrac);
					}
				}
				const selfName = nameMode >= 2;
				const selfBar = hpMode >= 2;
				const rs = window.terraTogether?.reviveState;
				const selfDownedFrac = rs?.selfDownedFrac ?? null;
				if (selfName || selfBar || selfDownedFrac != null) {
					active.add(NAMEPLATE_SELF_ID);
					const params = terra.export.g_player?.combat?.params;
					this.updateEntry(NAMEPLATE_SELF_ID, terra.export.g_player?.entity, terra.export.g_options?.get(USERNAME_OPTION),
						params?.getHPRatio?.(), params?.getHPRatio?.(0, true), selfName, selfBar || selfDownedFrac != null, selfDownedFrac, rs?.selfReviveFrac ?? null);
				}
			}
		}

		for (const [id, entry] of [...this.entries]) {
			if (!active.has(id)) {
				this.removeChild(entry.text);
				if (entry.barOutline) for (const seg of entry.barOutline) this.removeChild(seg);
				if (entry.barBg) this.removeChild(entry.barBg);
				if (entry.barRegen) this.removeChild(entry.barRegen);
				if (entry.barDamage) this.removeChild(entry.barDamage);
				if (entry.barFill) this.removeChild(entry.barFill);
				if (entry.barGloss) this.removeChild(entry.barGloss);
				this.entries.delete(id);
			}
		}
	}
}
// GuiHook reads `element.constructor.states` when the element attaches
// (features/gui/gui-hook.js:95); both states are instant (duration 0) so a plate never
// fades. Overrides GuiElement's base table (DEFAULT only, spline EASE, 0.2s).
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

//# sourceURL=/mods/terra-together/features/nameplates.js
