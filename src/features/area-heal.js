/**
 * src/features/area-heal.js
 * Drinking an estus flask also heals every player within `radius` (host-controlled).
 * Responsibilities:
 *   - Detect the local flask use (PlayerCuisine.useItem) and wait for the user's own
 *     heal to finish before broadcasting.
 *   - Allow a full-HP flask use when a nearby ally needs it (isHotFullyHealed shadow).
 *   - Split what the flask heals between the hurt players in range (see hurtPeersInRange).
 *   - Apply the local player's share, reviving a downed self first.
 * Public surface: AreaHealer
 * Engine touchpoints: terra.export.PlayerCuisine.useItem, PlayerCmp.handleItemUse,
 *   PLAYER_ITEM_DIR, g_player(.combat.params, .cuisine.estus), g_tick.real,
 *   g_system.loopPaused, g_playerHeal.playHealFx. Host callbacks are injected by
 *   client.js (send/isConnected/hasPeers/getLocalId/getPlayerActors/getPeerDowned/
 *   isSelfDowned/reviveLocal).
 * Notes: Gated by window.terraTogether.estusShareEnabled, falling back to the
 *   "tt-estus-share" option. Recipients never spend their own charges. client.js owns
 *   the addon/loop wiring and forwards net messages to onMessage/onPreUpdate.
 * Wire: MSG.AREA_HEAL from ../net/protocol.js. Unlike the revive payloads, this one
 *   carries `from`, which the receiver validates against a tracked actor (see onMessage),
 *   plus a `targets` map of player id -> that player's share of the flask.
 */

import { MSG } from "../net/protocol.js";

// When a player drinks their estus flask, the hurt players within `radius` are healed too,
// out of that one flask: its amount is divided between them, so two hurt peers each get
// half a flask. The *drinker* is not in that division — the engine already applied their
// own full self-heal inside useItem — and recipients do NOT spend their own charges, only
// the drinker spends one. (With a single hurt peer in range the share is the whole flask,
// i.e. unchanged from before the split.) The HoT duration is not rescaled: a share is
// delivered as the same duration at a proportionally lower per-tick rate.
//
// A downed teammate in range is instead instantly revived at 25% (the same factor
// revive.js uses); that instant healing counts against *their share* of the flask, so only
// the remainder of the share is delivered as the estus heal-over-time. The flask itself is
// not diminished by the revive — it only changes how that one recipient's share is split
// between the instant revive and the HoT.
//
// Peers are visual-only actors with no combat component (see client.js createPlayerActor),
// so we can't heal them locally: each client heals its OWN g_player. We detect the flask
// use locally, wait for the user's own heal to finish (the flask's HoT ticking out), then
// broadcast; recipients re-check the distance against the sender's tracked actor, so only
// players still near the healer are affected. That actor sits at the ghost's
// snapshot-interpolated position, which lags the healer's true one by about a network
// update, so a peer right on the radius boundary can be included by the healer and
// rejected by the receiver (both use CONFIG.radius, just measured from two sources).
//
// The divisor is decided once, when the message is sent: whoever is hurt and in range at
// that moment is counted and gets a share in the payload. A peer who dies, disconnects or
// walks out of range before the message lands fails the receiver's own gate and simply
// loses that share — it is not redistributed to the others (one flask heals at most its
// own amount, never more).
//
// Works in rogue (the heal carries no rogue guard; only the downed/revive path is
// rogue-gated elsewhere — see revive.js goDowned).

export { AreaHealer };

const PLAYER_ITEM_DIR = terra.export.PLAYER_ITEM_DIR;
// Frame delta is clamped so a hitch (or an unpause) can't fast-forward the timer.
const MAX_DT = 0.1;

// Tunables, also exposed at runtime as window.terraTogether.areaHealConfig.
const CONFIG = {
	radius: 4.0,      // world units (XY): heal range. Slightly more than revive's 3.0, so a
	                  // flask can still pick up a downed peer who is just outside revive range.
	// Safety cap on how long we wait for the local heal to complete before sending.
	// The flask's HoT is at most a few seconds; this only catches abnormal states.
	maxWait: 8,
};

// Host-controlled (Options > Multiplayer > Estus Heals Allies). Default OFF. Prefers the
// runtime mirror (kept in sync by settings.js), falling back to the option value itself.
function enabled() {
	if (window.terraTogether?.estusShareEnabled === true)
		return true;
	return terra.export.g_options?.get?.("tt-estus-share") === true;
}

// Real-time frame delta (seconds), or 0 while the loop is paused. Uses g_tick.real so a
// game slow-motion doesn't stretch the wait.
function dt() {
	if (terra.export.g_system?.loopPaused)
		return 0;
	const real = terra.export.g_tick?.real;
	return typeof real === "number" && real > 0 ? Math.min(real, MAX_DT) : 1 / 60;
}

function dist2(a, b) {
	const dx = a.x - b.x, dy = a.y - b.y;
	return dx * dx + dy * dy;
}

class AreaHealer {
	// host: { send, isConnected, hasPeers, getLocalId, getPlayerActors, getPeerDowned,
	//         isSelfDowned, reviveLocal }
	constructor(host) {
		this.host = host;
		this.installed = false;
		// Pending outgoing broadcast while the user's own heal finishes.
		// { params, hot, data } — hot is the flask's HoT (or null when there is none).
		this.pending = null;
		this.wait = 0;

		window.terraTogether ??= {};
		window.terraTogether.areaHealConfig = CONFIG;
	}

	// ---- addon hooks --------------------------------------------------------

	onLoopStart() {
		if (this.installed)
			return;
		const PlayerCuisine = terra.export.PlayerCuisine;
		if (!PlayerCuisine?.prototype?.useItem) {
			console.warn("[TT heal] PlayerCuisine.useItem not found; area heal disabled.");
			return;
		}
		this.installed = true;

		const self = this;
		const originalUseItem = PlayerCuisine.prototype.useItem;
		PlayerCuisine.prototype.useItem = function (dir) {
			const params = terra.export.g_player?.combat?.params;
			const estus = this.estus;
			const beforeCharges = estus?.charges ?? 0;

			// Let the flask be drunk at full HP when it would only help a nearby ally.
			// Vanilla gates the estus branch on isHotFullyHealed(); shadow that one call
			// so the rest of the vanilla path (charge, fx, event, trackers) runs untouched.
			// The shadow is an own property of the params instance, so the finally below
			// restores the prototype method even if the vanilla path throws.
			let forced = false;
			if (enabled()
				&& dir === PLAYER_ITEM_DIR?.DOWN
				&& estus?.hasCharges?.()
				&& params?.isHotFullyHealed?.()
				&& self.hurtPeersInRange().length > 0) {
				params.isHotFullyHealed = () => false;
				forced = true;
			}

			// Snapshot the HoT list so we can find the one the flask is about to start.
			const hotsBefore = params?.hots ? params.hots.slice() : null;
			let result;
			try {
				result = originalUseItem.call(this, dir);
			}
			finally {
				if (forced)
					delete params.isHotFullyHealed;
			}

			// The flask was actually drunk (a charge went away); queue the broadcast.
			if (result === true && (estus?.charges ?? 0) < beforeCharges)
				self.beginSend(params, hotsBefore);

			return result;
		};

		// The input handler refuses a full-HP flask use *before* useItem is ever called
		// (player-cmp.js:1437 is the isFullyHealed check, :1438 spawns the "healFull" fx).
		// It checks g_player.combat.isFullyHealed(), which just delegates to
		// params.isHotFullyHealed() (player-combat.js:930), so we shadow the same predicate
		// across the call when a nearby ally needs the heal.
		const PlayerCmp = terra.export.PlayerCmp;
		if (PlayerCmp?.prototype?.handleItemUse) {
			const originalHandleItemUse = PlayerCmp.prototype.handleItemUse;
			PlayerCmp.prototype.handleItemUse = function (input) {
				const params = terra.export.g_player?.combat?.params;
				const estus = terra.export.g_player?.cuisine?.estus;
				let forced = false;
				if (enabled() && estus?.hasCharges?.() && params?.isHotFullyHealed?.() && self.hurtPeersInRange().length > 0) {
					params.isHotFullyHealed = () => false;
					forced = true;
				}
				try {
					return originalHandleItemUse.call(this, input);
				}
				finally {
					if (forced)
						delete params.isHotFullyHealed;
				}
			};
		}
		else {
			console.warn("[TT heal] PlayerCmp.handleItemUse not found; full-HP flask use stays blocked.");
		}
	}

	onPreUpdate() {
		if (!this.installed || !this.pending)
			return;
		const step = dt();
		if (step <= 0)
			return;
		const { params, hot } = this.pending;
		this.wait += step;
		// The HoT is erased from params.hots when it ticks out (updateHOTs, started at
		// combat-params.js:385; the erase is at :392).
		const finished = (hot && params?.hots && params.hots.indexOf(hot) === -1)
			|| this.wait >= CONFIG.maxWait;
		if (finished)
			this.flush();
	}

	onGameMapLoad() {
		this.reset();
	}

	onConnectionReset() {
		this.reset();
	}

	reset() {
		this.pending = null;
		this.wait = 0;
	}

	// ---- outgoing -----------------------------------------------------------

	// Every visible peer within reach that isn't already topped off, as {id, actor} pairs.
	// A downed peer counts as hurt. Drives both the full-HP use allowance and the split.
	hurtPeersInRange() {
		const me = terra.export.g_player?.entity;
		const actors = this.host.getPlayerActors?.();
		const down = this.host.getPeerDowned?.();
		const list = [];
		if (!me?.core || !actors)
			return list;
		const r2 = CONFIG.radius * CONFIG.radius;
		for (const [id, actor] of actors) {
			if (!actor?.core?.isVisible?.())
				continue;
			const hurt = down?.get?.(id) || (actor.terraTogether?.hpTarget ?? 1) < 1;
			// ?? 1: a peer we have no snapshot data for counts as full, so an unknown peer
			// can never be the reason we spend a charge at full HP, nor dilute a share.
			if (hurt && dist2(me.core.pos, actor.core.pos) <= r2)
				list.push({ id, actor });
		}
		return list;
	}

	beginSend(params, hotsBefore) {
		if (!enabled())
			return;
		const estus = terra.export.g_player?.cuisine?.estus;
		if (!estus)
			return;
		// Two flasks in quick succession: flush the previous heal before replacing it.
		if (this.pending)
			this.flush();
		// The heal the user's flask produces: amount (absolute HP, the total to be shared)
		// and HoT duration.
		const data = { amount: estus.amount, duration: estus.duration };
		// Wait for the flask's own heal to complete; if the user was already at full HP
		// no HoT starts, so there's nothing to wait for and we send right away.
		let hot = null;
		if (params?.hots && hotsBefore) {
			const before = new Set(hotsBefore);
			hot = params.hots.find(h => !before.has(h)) ?? null;
		}
		this.pending = { params, hot, data };
		this.wait = 0;
		if (!hot)
			this.flush();
	}

	flush() {
		const pending = this.pending;
		this.pending = null;
		this.wait = 0;
		if (!pending)
			return;
		if (!enabled() || !this.host.isConnected?.() || !this.host.hasPeers?.())
			return;
		const { amount, duration } = pending.data;
		// Divide the flask between the hurt peers in range right now (the drinker is not in
		// the divisor: see the note at the top of this file). Nobody hurt in range means
		// nothing to send - one full-HP flask use with no one to help stays local.
		const hurt = this.hurtPeersInRange();
		const n = hurt.length;
		if (n === 0)
			return;
		const share = amount / n;
		if (!(Number.isFinite(share) && share > 0))
			return;
		const targets = {};
		for (const { id } of hurt)
			targets[id] = share;
		this.host.send?.({ type: MSG.AREA_HEAL, from: this.host.getLocalId?.(), duration, targets });
	}

	// ---- incoming -----------------------------------------------------------

	// Inbound heal. The healer is identified by the payload's own `from`, which the server
	// relays verbatim (server.js:129-133) and so is unauthenticated: it is only used to pick
	// which of our tracked peers this heal claims to come from, and the heal is then gated
	// on that actor being visible and within `radius` - the check the revive payloads have
	// no way to make. A spoofed or oversized payload can at worst grant a free top-up:
	// params.heal() clamps to max HP (combat-params.js:244) and never touches charges,
	// buffs or stats.
	onMessage(msg) {
		if (msg?.type !== MSG.AREA_HEAL || !enabled())
			return;
		const me = terra.export.g_player?.entity;
		const params = terra.export.g_player?.combat?.params;
		if (!me?.core || !params)
			return;

		// The sender must be an actor we track in our current room.
		const healer = this.host.getPlayerActors?.()?.get?.(msg.from);
		if (!healer?.core?.isVisible?.())
			return;
		const r2 = CONFIG.radius * CONFIG.radius;
		if (dist2(me.core.pos, healer.core.pos) > r2)
			return;

		// The healer divides the flask between the players it can see needing it, so our heal
		// is our own entry in `targets`. No usable entry (an older peer still sending a flat
		// `amount`, or a malformed payload) means no heal: fail-safe rather than healing for
		// an amount nobody agreed on. This does NOT re-derive the divisor - the payload is the
		// healer's decision, and the gates below are what keep a stale one from applying.
		const share = msg.targets?.[this.host.getLocalId?.()];
		const duration = typeof msg.duration === "number" ? msg.duration : 0;
		if (typeof share !== "number" || !Number.isFinite(share) || share <= 0)
			return;

		// Downed ally: revive at 25% first (same path revive.js uses), then deliver only the
		// *remainder* of our share. The instant revive counts as healing, so it is subtracted
		// from the share and the total received still equals the share.
		// Measuring HP (rather than assuming CONFIG.hpFactor) also self-corrects when the
		// revive gained nothing, e.g. reviveLocal() had no combatant to work on.
		let healAmount = share;
		if (this.host.isSelfDowned?.()) {
			const before = params.currentHP;
			try { this.host.reviveLocal?.(); }
			catch (err) { console.warn("[TT heal] revive failed:", err); }
			const instant = Math.max(0, params.currentHP - before);
			healAmount = Math.max(0, share - instant);
		}

		try {
			// Same heal call the flask makes on its own user (player-flask.js:92); recipients
			// keep their charges.
			if (healAmount > 0)
				params.heal(healAmount, duration, true);
			terra.export.g_playerHeal?.playHealFx?.(me);
		}
		catch (err) {
			console.warn("[TT heal] applying heal failed:", err);
		}
	}
}

//# sourceURL=/mods/terra-together/features/area-heal.js
