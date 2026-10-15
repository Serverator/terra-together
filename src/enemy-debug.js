// Enemy debug overlay: a small label above every live enemy showing
//   line 1 - the player who owns (will simulate) that enemy,
//   line 2 - the enemy's current logic state (IDLE / COMBAT / WEAK / ...),
//   line 3 - the action the enemy actor is currently running (idle / runCloser / ...).
//
// It reuses the player-nameplate mechanism from nameplates.js (a game-GUI TextGui
// positioned with hook.transformToMapPos) but is drawn at a fixed 0.5 scale.
//
// ─────────────────────────────── HOW TO TOGGLE ───────────────────────────────
//   1) Live / per-session — NW.js devtools console (F12, or Ctrl+Shift+I):
//        window.ttEnemyDebug = true;    // on
//        window.ttEnemyDebug = false;   // off
//      The flag is re-read every frame, so toggling is immediate and needs no reload.
//      Delete the property (delete window.ttEnemyDebug) to fall back to the option.
//   2) Persistent across restarts — Options > Multiplayer > Debug >
//      "Enemy Debug Overlay" (the tt-enemy-debug checkbox, declared in settings.js).
//
//   Enabled = window flag OR option. The overlay is off by default.
// ─────────────────────────────────────────────────────────────────────────────
//
// This module deliberately imports nothing so it stays self-contained; the option
// itself is declared in settings.js, which owns the option/menu plumbing.

const Vec3 = terra.export.Vec3;

// Option key (declared in settings.js, read here) and the console flag property name.
export const ENEMY_DEBUG_OPTION = "tt-enemy-debug";
const ENEMY_DEBUG_WINDOW_FLAG = "ttEnemyDebug";

// Required by the task: the overlay always draws at 0.5x, unlike the nameplates
// (which follow the "Nameplate Scale" option).
export const ENEMY_DEBUG_SCALE = 0.5;

const FONT_SIZE = terra.export.FONT_SIZE.SMALL;      // FONT_SIZE.SMALL === 0
const FONT_OUTLINE = terra.export.FONT_OUTLINE.ON;   // FONT_OUTLINE.ON === 2
const FONT_ALIGN = terra.export.FONT_ALIGN.CENTER;
const HEAD_OFFSET = 0.4;      // matches nameplates.js NAMEPLATE_HEAD_OFFSET
const HIDDEN_X = -100000;     // matches nameplates.js NAMEPLATE_HIDDEN_X
const LABEL_GAP = 0.15;       // extra world-space z so the label clears the head node

// The username option, same source nameplates.js/main.js use for the local player.
const USERNAME_OPTION = "tt-username";

// True when the overlay should draw this frame. Cheap enough to call every frame
// (two property reads), which is what makes the console flag live.
function isEnemyDebugEnabled() {
	if (typeof window !== "undefined" && window[ENEMY_DEBUG_WINDOW_FLAG] === true)
		return true;
	return terra.export.g_options?.get(ENEMY_DEBUG_OPTION) === true;
}

// Whitespace/command sanitising for network-supplied text. `{...}` are text commands in
// this engine's text blocks, so a crafted username must not reach the label verbatim.
function cleanText(value) {
	if (value == null)
		return null;
	const text = String(value).replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
	return text === "" ? null : text;
}

// ─────────────────────────── enemy owner (SWAP-POINT) ───────────────────────────
//
// Ownership is not implemented yet and the final scheme is still being decided, so ALL
// of the ownership policy lives in this one pure(ish) function and its two helpers
// below. When the real scheme lands, replace the body of enemyOwnerLabel() (and
// enemyStableId() if the stable id changes) and nothing else in this file needs to move.
//
// Baseline contract: given an enemy's stable id, every connected client independently
// computes the SAME owner, and with no peers the local player always owns everything.

// Key used for the local player when the server has not assigned an id yet
// (offline / single-player): there are no peers then, so this only ever competes
// with itself and the local player wins.
const LOCAL_ROSTER_KEY = "local";
const LOCAL_FALLBACK_NAME = "Player";

// 32-bit FNV-1a. Deterministic, platform-independent, no allocation beyond the string.
function stableHash(text) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

// Local player's display name: their configured username, else a readable fallback.
function selfDisplayName() {
	return cleanText(terra.export.g_options?.get(USERNAME_OPTION)) ?? LOCAL_FALLBACK_NAME;
}

// A peer's display name, falling back to a short stable tag when they never sent one.
function peerDisplayName(peerId, key) {
	const name = cleanText(window.terraTogether?.playerNames?.get(peerId));
	return name ?? ("Player " + String(key).slice(0, 4));
}

// The known roster: the local player plus every connected peer, sorted by id so the
// result never depends on Set/Map insertion order (which differs per client).
function ownerRoster() {
	const tt = (typeof window !== "undefined" ? window.terraTogether : null) ?? {};
	const selfKey = tt.playerId != null ? String(tt.playerId) : LOCAL_ROSTER_KEY;

	const roster = new Map();
	roster.set(selfKey, selfDisplayName());
	for (const peerId of tt.peers ?? []) {
		const key = String(peerId);
		if (roster.has(key))
			continue;
		roster.set(key, peerDisplayName(peerId, key));
	}

	return [...roster].map(([key, name]) => ({ key, name }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// The enemy's stable identity. Map-placed enemies are identified by their source spot
// (`m:<mapPath>#<core.mapId>`), which is the same string on every client. Anything
// spawner-created has mapId < 0 and can only fall back to a local id (`u:<core.uid>`),
// which is NOT correlated across clients - such enemies may show different owners per
// client until the real ownership scheme lands.
export function enemyStableId(core) {
	const mapId = core?.mapId;
	if (typeof mapId === "number" && mapId >= 0) {
		const mapPath = terra.export.g_game?.map?.active?.path ?? "?";
		return "m:" + mapPath + "#" + mapId;
	}
	return "u:" + (core?.uid ?? "?");
}

// SWAP-POINT: which player owns this enemy. Rendezvous ("highest random weight") hashing:
// each roster member scores hash(enemyId|playerId) and the highest score wins. Both
// clients compute the same winner from the same roster without talking to each other.
// Ties resolve to the lowest roster key (the roster is sorted and we compare strictly),
// so the choice is total and deterministic. No peers -> only the local player scores.
export function enemyOwnerLabel(enemyId) {
	const roster = ownerRoster();
	if (roster.length === 0)
		return LOCAL_FALLBACK_NAME;
	let best = roster[0];
	let bestScore = -1;
	for (const member of roster) {
		const score = stableHash(enemyId + "|" + member.key);
		if (score > bestScore) {
			bestScore = score;
			best = member;
		}
	}
	return best.name;
}

// ──────────────────────────────── entity plumbing ────────────────────────────────

function isWorldSceneActive() {
	return !!terra.export.g_scene?.isRunning?.() && !terra.export.g_scene?.isCutscene?.();
}

// A live enemy = an entity carrying an EnemyCmp whose combatant is alive. Enemies that
// have not finished initialising (no combatant yet) and already-killed entities are skipped.
function getLiveEnemy(core) {
	if (!core || !core.ent || core.isKilled?.())
		return null;
	const enemy = terra.export.EnemyCmp?.get?.(core.ent);
	if (!enemy || !enemy.combatant)
		return null;
	if (typeof enemy.isAlive === "function" && !enemy.isAlive())
		return null;
	return enemy;
}

const debugWorld = new Vec3();

// Just above the head, from the stable collision box (not the bobbing head bone).
// Mirrors nameplates.js getNameplateHeadPos().
function enemyHeadPos(entity) {
	const core = entity?.core;
	if (!core)
		return null;

	const sizeZ = core.colls?.[0]?.size?.z ?? 2;

	const tools = terra.export.EntityTools;
	const align = terra.export.ENT_ALIGN;
	if (tools?.getAlignedPos && align) {
		const pos = tools.getAlignedPos(debugWorld, entity, align.CENTER);
		if (pos) {
			pos.z += sizeZ * 0.5 + HEAD_OFFSET + LABEL_GAP;
			return pos;
		}
	}

	return debugWorld.setC(core.pos.x, core.pos.y, core.pos.z + sizeZ + HEAD_OFFSET + LABEL_GAP);
}

// owner / state / running action. Both enemy fields can legitimately be null.
function buildLabel(core, enemy) {
	const owner = enemyOwnerLabel(enemyStableId(core));
	const state = cleanText(enemy.currentState?.name) ?? "-";
	const action = cleanText(core.ent?.actor?.actionState?.sequence?.name);
	return action ? `${owner}\n${state}\n${action}` : `${owner}\n${state}`;
}

function hideEntry(entry) {
	entry.text.hook.pos.setC(HIDDEN_X, 0);
}

// One TextGui per live enemy, positioned over its head each frame.
class EnemyDebugGui extends terra.export.GuiElement {
	constructor() {
		super();
		this.entries = new Map();
		this.hook.zIndex = 6;            // same layer as the player nameplates
		this.hook.updateOnPause = true;
		this.setSize(terra.export.g_system.size.x, terra.export.g_system.size.y);
	}

	createEntry(key) {
		const text = new terra.export.TextGui("", {
			size: FONT_SIZE,
			outline: FONT_OUTLINE,
			align: FONT_ALIGN,
			dynamic: true,
			skipAutoPivot: true
		});
		text.setAlign(terra.export.GUI_ALIGN_X.LEFT, terra.export.GUI_ALIGN_Y.TOP);
		text.setPivot(0, 0);
		text.hook.scale = ENEMY_DEBUG_SCALE;
		const entry = { text, label: null };
		this.entries.set(key, entry);
		this.addChild(text);
		return entry;
	}

	updateEntry(key, core, label) {
		const entry = this.entries.get(key) ?? this.createEntry(key);

		if (entry.label !== label) {
			entry.label = label;
			entry.text.setText(label);
		}

		const pos = core.isVisible?.() ? enemyHeadPos(core.ent) : null;
		if (!pos) {
			hideEntry(entry);
			return;
		}

		const text = entry.text;
		// ignoreScale=true: transformToMapPos must not overwrite hook.scale, we own it.
		text.hook.scale = ENEMY_DEBUG_SCALE;
		text.hook.transformToMapPos(pos, true);

		// Screen-space anchor at the head; centre horizontally and sit fully above it.
		const anchorX = text.hook.pos.x;
		const anchorY = text.hook.pos.y;
		let width = text.hook.size.x * ENEMY_DEBUG_SCALE;
		let height = text.hook.size.y * ENEMY_DEBUG_SCALE;
		if (!Number.isFinite(width))
			width = 0;
		if (!Number.isFinite(height))
			height = 0;
		text.hook.pos.x = anchorX - width * 0.5;
		text.hook.pos.y = anchorY - height;
	}

	update() {
		const active = new Set();

		if (isEnemyDebugEnabled() && isWorldSceneActive()) {
			for (const core of terra.export.g_gState?.entities ?? []) {
				const enemy = getLiveEnemy(core);
				if (!enemy)
					continue;
				const key = String(core.uid);
				active.add(key);
				this.updateEntry(key, core, buildLabel(core, enemy));
			}
		}

		// Drop entries whose enemy is gone (or whose overlay was just switched off).
		for (const [key, entry] of [...this.entries]) {
			if (active.has(key))
				continue;
			this.removeChild(entry.text);
			this.entries.delete(key);
		}
	}
}
EnemyDebugGui.states = {
	DEFAULT: { transform: { alpha: 1 }, duration: 0 },
	HIDDEN: { transform: { alpha: 0 }, duration: 0 }
};

class EnemyDebug {
	onLoopStart() {
		const g_gui = terra.export.g_gui;
		if (!g_gui?.addElement)
			return;
		g_gui.addElement(new EnemyDebugGui(), true);
	}
}

export { EnemyDebug, EnemyDebugGui };

//# sourceURL=/mods/terra-together/enemy-debug.js
