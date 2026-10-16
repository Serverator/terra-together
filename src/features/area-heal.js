/**
 * src/features/area-heal.js
 * Drinking an estus flask also heals every player within `radius` (host-controlled).
 * Responsibilities:
 *   - Detect the local flask use (PlayerCuisine.useItem) and broadcast that flask's share in
 *     the same frame it is drunk.
 *   - Allow a full-HP flask use when a nearby ally needs it (isHotFullyHealed shadow).
 *   - Split what the flask heals between the hurt players in range (see hurtPeersInRange).
 *   - Apply the local player's share, reviving a downed self first.
 * Public surface: AreaHealer
 * Engine touchpoints: terra.export.PlayerCuisine.useItem, PlayerCmp.handleItemUse,
 *   PLAYER_ITEM_DIR, g_player(.combat.params, .cuisine.estus), g_playerHeal.playHealFx.
 *   Host callbacks are injected by client.js (send/isConnected/hasPeers/getLocalId/
 *   getPlayerActors/getPeerDowned/isSelfDowned/reviveLocal).
 * Notes: Gated by window.terraTogether.estusShareEnabled, falling back to the
 *   "tt-estus-share" option. Recipients never spend their own charges. client.js owns
 *   the addon/loop wiring and forwards net messages to onMessage/onPreUpdate.
 * Wire: MSG.AREA_HEAL from ../net/protocol.js. Unlike the revive payloads, this one
 *   carries `from`, which the receiver validates against a tracked actor (see onMessage),
 *   plus a `targets` map of player id -> that player's share of the flask. A peer on an
 *   older build still sends the pre-split flat `amount`, which the receiver honours as its
 *   own share (see the legacy note in onMessage) so a mixed-version pair heals both ways.
 * Diagnostics: window.ttAreaHealDebug = true (or window.terraTogether.areaHealDebug) in the
 *   devtools console logs what the sender decided at a drink and which gate (if any) dropped
 *   the heal on the receiving end. Off by default, like window.ttEnemyDebug.
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
// use locally and broadcast inside that same call; recipients re-check the distance against
// the sender's tracked actor, so only players still near the healer are affected. That actor
// sits at the ghost's snapshot-interpolated position, which lags the healer's true one by
// about a network update, so a peer right on the radius boundary can be included by the
// healer and rejected by the receiver (both use CONFIG.radius, just measured from two
// sources).
//
// The broadcast used to be held back until the drinker's own heal-over-time had ticked out,
// as a proxy for "the flask really fired". That hold is gone, and nothing needs it: a spent
// charge plus useItem() returning true is that evidence, read at the drink itself — and a
// drink at full HP, allowed when a nearby ally needs it, starts no HoT at all. The HoT's
// length is not a readiness signal either: the engine compresses it to
// `duration * healed / amount` (combat-params.js:255), so holding on it delayed the peer by
// anything from a frame (no HoT) to the 8s cap that used to live in CONFIG — ~3.4s for a
// drinker 19% down against a 360 flask. The later the message, the staler the healer actor
// the receiver measures its range gate against, so the wait could only cost accuracy.
//
// The divisor is decided once, and that once is when the flask is DRUNK: whoever is hurt and
// in range at the drink is counted and gets a share, and the resulting `targets` map is the
// one that goes out (see beginSend / splitTargets). Re-deriving it at send time would let a
// peer who had walked out of the 4-unit radius, been topped up by something else, or whose
// actor is not yet visible empty the list and silently turn the flask into a local-only
// heal. One decision, taken when the player drinks, is the world state they could actually
// see.
//
// "Hurt" is a downed peer or one below full HP, and it is read from the peer's current HP
// rather than from the in-flight-heals preview — see hurtPeersInRange for why that matters.
// Nobody hurt in range at that moment means nothing is sent: the flask stays local. A peer
// who dies, disconnects or walks out of range before the message lands fails the receiver's
// own gate and simply loses that share — it is not redistributed to the others (one flask
// heals at most its own amount, never more).
//
// Works in rogue (the heal carries no rogue guard; only the downed/revive path is
// rogue-gated elsewhere — see revive.js goDowned).

export { AreaHealer };

const PLAYER_ITEM_DIR = terra.export.PLAYER_ITEM_DIR;
// Tunables, also exposed at runtime as window.terraTogether.areaHealConfig.
const CONFIG = {
	radius: 4.0,      // world units (XY): heal range. Slightly more than revive's 3.0, so a
	                  // flask can still pick up a downed peer who is just outside revive range.
};

// Host-controlled (Options > Multiplayer > Estus Heals Allies). Default OFF. Prefers the
// runtime mirror (kept in sync by settings.js), falling back to the option value itself.
function enabled() {
	if (window.terraTogether?.estusShareEnabled === true)
		return true;
	return terra.export.g_options?.get?.("tt-estus-share") === true;
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

		window.terraTogether ??= {};
		window.terraTogether.areaHealConfig = CONFIG;
	}

	// Diagnostics, off by default: a window flag rather than an option, like
	// window.ttEnemyDebug (src/debug/enemy-debug.js). The older pre-restructure name is
	// accepted too. Console: `window.ttAreaHealDebug = true`.
	debugOn() {
		return window.ttAreaHealDebug === true || window.terraTogether?.areaHealDebug === true;
	}

	debug(...args) {
		if (this.debugOn())
			console.debug("[TT heal]", ...args);
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

			let result;
			try {
				result = originalUseItem.call(this, dir);
			}
			finally {
				if (forced)
					delete params.isHotFullyHealed;
			}

			// The flask was actually drunk (a charge went away); announce it there and then.
			if (result === true && (estus?.charges ?? 0) < beforeCharges)
				self.beginSend();

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

	// client.js calls all three unconditionally (client.js:101, 110, 130). The broadcast is
	// decided by beginSend and sent inside the drink's own frame, so there is no pending heal
	// to advance each frame and no per-drink state left for a map load or a reconnect to
	// clear. They stay declared because the wiring calls them.

	onPreUpdate() {
	}

	onGameMapLoad() {
	}

	onConnectionReset() {
	}

	// ---- outgoing -----------------------------------------------------------

	// Every visible peer within reach who needs healing, as {id, actor} pairs: a downed peer,
	// or one below full HP. Drives BOTH the full-HP use allowance and the split — the
	// eligible set and the divisor are this one list, read when the flask is drunk (see
	// splitTargets and the note at the top of this file).
	//
	// Read the peer's *current* HP, never `hpTarget`. ../client/snapshot.js publishes
	// hpTarget as getHPRatio(0, true), which the engine defines as currentHP *plus every
	// heal already in flight* (combat-params.js:433-436, combat-hot.js:54-61) — it is the
	// "where will my bar stop" preview the nameplates draw, so a peer sitting at 20% HP who
	// is mid-heal-over-time reports 1.0 and reads as full. Mid-heal is not a rare state
	// here: every share this feature hands out *is* a HoT, so a teammate healed (or revived)
	// by the previous flask reports full for the whole duration of that heal, and a second
	// flask within that window skipped them. With one peer in range that made the list
	// empty and no message was sent at all, so the flask healed nobody. `hp` is the honest
	// signal (and is what the nameplate bar itself is drawn from).
	//
	// A peer whose HP we cannot classify yet counts as hurt, not as full: including one can
	// at worst dilute the flask, while excluding one is the "healed nobody" failure above.
	// `hp` is written for every visible actor (../client/actors.js:164), so this is a
	// backstop rather than the usual path. The test is written as !(hp >= 1) so that a NaN
	// ratio (which no `hpTarget ?? 1`-style comparison would catch) also lands as hurt.
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
			const hp = actor.terraTogether?.hp;
			// A downed peer's HP is 0, but the flag alone still counts them on the frames
			// where the snapshot that says so has not landed yet (e.g. a one-shot death from
			// full HP, where the last HP we saw was still 1).
			const hurt = !!down?.get?.(id) || !(hp >= 1);
			if (hurt && dist2(me.core.pos, actor.core.pos) <= r2)
				list.push({ id, actor });
		}
		return list;
	}

	// The drinker's split of one flask: { playerId: share } over the hurt peers in range, or
	// null when that list is empty (divide by nobody) or the share is not a usable number.
	//
	// Called ONCE, at drink time, from beginSend, and sent with that same call: the number on
	// the wire is the one derived from the peers the drinker could see when they drank. The
	// drinker is not in the divisor — the engine already applied their own full self-heal
	// inside useItem — and a single hurt peer gets the whole flask.
	splitTargets(amount) {
		const hurt = this.hurtPeersInRange();
		const n = hurt.length;
		const share = amount / n;
		if (this.debugOn()) {
			this.debug("split:",
				"myHP", terra.export.g_player?.combat?.params?.getHPRatio?.(),
				"amount", amount, "n", n, "share", share,
				"peers", hurt.map(({ id, actor }) => `${id}:hp=${actor.terraTogether?.hp}`));
		}
		if (n === 0)
			return null;
		if (!(Number.isFinite(share) && share > 0))
			return null;
		const targets = {};
		for (const { id } of hurt)
			targets[id] = share;
		return targets;
	}

	beginSend() {
		if (!enabled())
			return;
		const estus = terra.export.g_player?.cuisine?.estus;
		if (!estus)
			return;
		// The heal the user's flask produces: amount (absolute HP, the total to be shared) and
		// HoT duration. Both are plain fields read once here, at drink time: EstusFlask.use()
		// only spends a charge (player-flask.js:74) and applyDish() — the only other writer —
		// only runs when a dish is cooked or eaten.
		const amount = estus.amount;
		const duration = estus.duration;
		// Decide the split here and send it with this call. There is deliberately nothing to
		// wait for: see the note at the top of this file on the removed heal-over-time hold.
		const targets = this.splitTargets(amount);
		this.debug("drink:", "sending now", "targets", targets);
		this.flush({ amount, duration, targets });
	}

	// Sends one flask's already-decided split. One flask, one broadcast: this runs once per
	// successful drink (beginSend's only caller is the useItem wrapper).
	flush({ amount, duration, targets }) {
		if (!enabled() || !this.host.isConnected?.() || !this.host.hasPeers?.()) {
			this.debug("flush dropped: not enabled/connected/peers");
			return;
		}
		if (!targets) {
			this.debug("flush dropped: nobody hurt in range at drink time, amount", amount);
			return;
		}
		this.host.send?.({ type: MSG.AREA_HEAL, from: this.host.getLocalId?.(), duration, targets });
		this.debug("sent area heal:", "amount", amount, "duration", duration, "targets", targets);
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
		const myId = this.host.getLocalId?.();
		if (!me?.core || !params) {
			this.debug("recv dropped: local player unavailable");
			return;
		}

		// The sender must be an actor we track in our current room.
		const healer = this.host.getPlayerActors?.()?.get?.(msg.from);
		if (!healer?.core?.isVisible?.()) {
			this.debug("recv dropped: healer", msg.from, "not tracked or not visible");
			return;
		}
		const r2 = CONFIG.radius * CONFIG.radius;
		const d2 = dist2(me.core.pos, healer.core.pos);
		if (d2 > r2) {
			this.debug("recv dropped: healer out of range", Math.sqrt(d2).toFixed(2), ">", CONFIG.radius);
			return;
		}

		// The healer divides the flask between the players it can see needing it, so our heal
		// is our own entry in `targets`. This does NOT re-derive the divisor - the payload is
		// the healer's decision, and the gates above are what keep a stale one from applying.
		//
		// Legacy payload (a peer on a pre-split build) carries no `targets`, only the flat
		// `amount` it heals *every* peer in range with: honour it as our own share rather than
		// dropping the heal. Dropping instead would make a mixed-version pair heal nobody in
		// either direction, since the old reader finds no `amount` in our split payload.
		let share = msg.targets?.[myId];
		let legacy = false;
		if (typeof share !== "number" || !Number.isFinite(share) || share <= 0) {
			if (typeof msg.amount === "number" && Number.isFinite(msg.amount) && msg.amount > 0) {
				share = msg.amount;
				legacy = true;
			}
			else {
				this.debug("recv dropped: no usable share for", myId,
					"targets[", myId, "]=", msg.targets?.[myId], "amount=", msg.amount);
				return;
			}
		}
		this.debug("recv:", "myId", myId, "from", msg.from, legacy ? "legacy amount" : "share", share,
			"targets[" + myId + "]=", msg.targets?.[myId]);
		const duration = typeof msg.duration === "number" ? msg.duration : 0;

		// Downed ally: revive at 25% first (same path revive.js uses), then deliver only the
		// *remainder* of our share. The instant revive counts as healing, so it is subtracted
		// from the share and the total received still equals the share.
		// Measuring HP (rather than assuming CONFIG.hpFactor) also self-corrects when the
		// revive gained nothing, e.g. reviveLocal() had no combatant to work on.
		let healAmount = share;
		const downed = !!this.host.isSelfDowned?.();
		if (downed) {
			const before = params.currentHP;
			try { this.host.reviveLocal?.(); }
			catch (err) { console.warn("[TT heal] revive failed:", err); }
			const instant = Math.max(0, params.currentHP - before);
			healAmount = Math.max(0, share - instant);
		}

		this.debug("applying:", "healAmount", healAmount, "duration", duration, "downed", downed);
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
