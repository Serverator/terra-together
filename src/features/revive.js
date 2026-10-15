/**
 * src/features/revive.js
 * Multiplayer "downed" state: with a living ally in the room a death becomes a
 * bleed-out a nearby teammate can undo, instead of the vanilla checkpoint reload.
 * Responsibilities:
 *   - Divert PlayerCmp.onDeathHit into the downed state while the mechanic applies.
 *   - Keep enemies off a downed player (EnemyCmp aggro patches).
 *   - Drive bleed-out, peer revive progress (send/recv), and the revive-radius ring FX.
 *   - Publish UI state (window.terraTogether.reviveState) and tunables
 *     (window.terraTogether.reviveConfig).
 * Public surface: Reviver
 * Engine touchpoints: terra.export.PlayerCmp, EnemyCmp, FxEntity, Effect, ENT_ALIGN,
 *   Vec3, COMBATANT_STATE, g_player, g_rogue, g_tick.real, g_system.loopPaused,
 *   g_attackFreq.activeEnemies. Host callbacks are injected by client.js
 *   (send/isConnected/hasPeers/getLocalId/getPlayerActors/getPeerDowned/setLocalDowned).
 * Notes: Gated by window.terraTogether.reviveEnabled (mirrored by
 *   config/settings.js); host-authoritative, default OFF. client.js owns the
 *   addon/loop wiring and forwards net messages to onMessage/onPreUpdate.
 * Wire: MSG.REVIVE / MSG.REVIVE_PROGRESS from ../net/protocol.js. Neither payload
 *   carries a sender field, so a receiver can only check the addressed `target`
 *   (see onMessage) — the tracked-actor/range checks the area-heal path performs
 *   are impossible here; adding a `from` field is a protocol change (see onMessage).
 */

import { MSG } from "../net/protocol.js";

// Vanilla death (PlayerCmp.onDeathHit, player-cmp.js:1207) adds a 0.1x "playerDeath"
// slow-motion and reloads the checkpoint. In multiplayer that wrecks enemy sync: the
// dead client reloads the map (re-creating enemies) and its death slow-motion is
// sampled by the enemy time-factor sync, slowing every other client's enemies to 10%.
//
// So while a living ally is in the same room we turn the death into a "downed" state
// instead. The entity is kept alive with combatant.manualKill — which is exactly the
// engine's own "don't die yet, scripting will kill me later" flag used by enemy spawns
// (terra-actor-entity.js:105, enemy-cmp.js:1153). A defeated combatant also auto-blocks
// input: isInputBlocked() returns true for combatant.isDefeated() (player-cmp.js:2948).
// A downed player bleeds out; a teammate who stays within `radius` revives them with the
// engine's own CombatParams.revive() (combat-params.js:269, the primitive the rogue
// "once more" power is built on).
//
// Two independent fields make up "downed", and both must be set on entry and undone on
// exit, or the player ends up defeated-but-flagged-alive:
//   - combatant.manualKill: keeps the entity from being killed while
//     state >= DYING (CombatantCmp.onPostAction, combatant-cmp.js:367; onRespawn,
//     combatant-cmp.js:1077).
//   - combatant.state: drives isDefeated() (combatant-cmp.js:1056) and therefore input
//     blocking, enemy AI and the HUD. CombatParams.revive() does NOT touch it, which is
//     why the engine's own revive sets both (rogue-manager.js:1050-1051: params.revive()
//     then combatant.state = ALIVE); reviveLocal() does the same.
//
// Solo, in rogue, or with no living ally in the room: we fall straight through to the
// vanilla death, untouched.

export { Reviver };

const COMBATANT_STATE_ALIVE = terra.export.COMBATANT_STATE?.ALIVE ?? 0;
const Vec3 = terra.export.Vec3;
// Frame delta is clamped so a hitch (or an unpause) can't fast-forward the timers.
const MAX_DT = 0.1;

// Tunables, also exposed at runtime as window.terraTogether.reviveConfig. These are our
// own values (there are no engine constants to match, unlike the cited line numbers
// below); they are read every frame, so live edits take effect immediately.
const CONFIG = {
	bleedOut: 20,     // seconds a downed player has before being force-respawned
	reviveTime: 5,    // seconds a teammate must stay within `radius`
	radius: 3.0,      // world units (XY): revive range, also the drawn ring radius
	hpFactor: 0.25,    // HP fraction restored on revive
	cooldown: 1,      // seconds before a reviver can start another revive
	resend: 0.02,     // min progress change between revive-progress updates
	decay: 3.5,       // progress lost per second when nobody is reviving (0 = instant reset)
	reviveHold: 0.6,  // how long one progress update keeps the incoming bar alive
	moveFactor: 0.6,  // revive speed multiplier while the reviver is moving (0.5 = twice as slow)
	moveSpeed: 0.3,   // world units/sec below which the reviver counts as standing still
	// Ground ring shown on each downed teammate so helpers can see where to stand.
	// Set to null to disable. Any "FX:<sheet>#<name>" key works, e.g.
	// "FX:combat.targeting#circle3".
	ringEffect: null,
	ringScale: 1.5,     // ring size multiplier (1 = the effect's native size)
	ringZOffset: -0.1,  // world units to drop the ring toward the ground (negative = lower)
};

// The infinite red blink loop the engine spawns on death (combatant-cmp.js:985). We
// keep the entity alive, so nothing tears it down; clear it on revive.
const BLINK_GROUP = "defeatBlink";
const RING_GROUP = "ttReviveRing";

// Host-controlled (Options > Multiplayer > Revive Teammates). Default OFF: with it off
// the vanilla death / checkpoint respawn runs untouched.
function enabled() {
	return window.terraTogether?.reviveEnabled === true;
}

// Real-time frame delta (seconds), or 0 while the loop is paused. Uses g_tick.real so a
// game slow-motion doesn't stretch the bleed-out / revive timers.
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

// The reviver has to hold still for a full-speed revive; moving halves the rate.
// Ground-plane speed only, so a hop in place doesn't count as moving.
function isMoving(ent) {
	const vel = ent?.move?.vel;
	return !!vel && vel.lengthXY() > CONFIG.moveSpeed;
}

class Reviver {
	// host: { send, isConnected, hasPeers, getLocalId, getPlayerActors, getPeerDowned,
	//         setLocalDowned }
	constructor(host) {
		this.host = host;
		this.installed = false;
		this.originalOnDeathHit = null;

		// Local player is down and bleeding out.
		this.downed = false;
		this.bleed = 0;

		// Local player is reviving a peer.
		this.target = null;
		this.progress = 0;
		this.cooldown = 0;
		this.sentFrac = -1;

		// id -> { actor, fx } ring effect on each downed peer.
		this.rings = new Map();
		// Progress of someone reviving us, for our own purple bar: { frac, t }.
		this.incoming = null;

		window.terraTogether ??= {};
		window.terraTogether.reviveConfig = CONFIG;
	}

	// Fraction of bleed-out time left (0..1), or null when not downed.
	downedFraction() {
		if (!this.downed)
			return null;
		return Math.max(0, Math.min(1, this.bleed / CONFIG.bleedOut));
	}

	// ---- addon hooks --------------------------------------------------------

	onLoopStart() {
		if (this.installed)
			return;
		const PlayerCmp = terra.export.PlayerCmp;
		if (!PlayerCmp?.prototype?.onDeathHit) {
			console.warn("[TT revive] PlayerCmp.onDeathHit not found; revive disabled.");
			return;
		}
		this.installed = true;
		const self = this;
		this.originalOnDeathHit = PlayerCmp.prototype.onDeathHit;
		// Intercept the death *callback*: the combatant has already entered KILL_HIT and
		// spawned its blink fx, but the slow-motion + checkpoint reload below are what we
		// want to avoid. We only intervene when we can actually go downed.
		PlayerCmp.prototype.onDeathHit = function (force) {
			let downed = false;
			try { downed = self.goDowned(this); }
			catch (err) { console.warn("[TT revive] goDowned failed:", err); }
			if (downed) return;
			return self.originalOnDeathHit.call(this, force);
		};

		// Enemies only ever target the local player (enemy-cmp.js:654). While we are down
		// they must not (re)acquire us. `setAggressive(true)` is the single choke point every
		// aggro path funnels through — checkAutoAggro (enemy-cmp.js:626) and taking a hit
		// (enemy-cmp.js:1103) both call triggerAggression -> setAggressive(true)
		// (enemy-cmp.js:1114) — and `triggerAggression` additionally wakes neighbours
		// (aggroNearbyEnemy) and re-targets, so gate both.
		const EnemyCmp = terra.export.EnemyCmp;
		if (EnemyCmp?.prototype?.setAggressive) {
			const originalSetAggressive = EnemyCmp.prototype.setAggressive;
			EnemyCmp.prototype.setAggressive = function (aggressive, skipHudUpdate) {
				if (aggressive && self.downed)
					return;
				return originalSetAggressive.call(this, aggressive, skipHudUpdate);
			};
		}
		if (EnemyCmp?.prototype?.triggerAggression) {
			const originalTriggerAggression = EnemyCmp.prototype.triggerAggression;
			EnemyCmp.prototype.triggerAggression = function () {
				if (self.downed)
					return;
				return originalTriggerAggression.call(this);
			};
		}
	}

	onPreUpdate() {
		if (!this.installed)
			return;
		const step = dt();
		if (step <= 0)
			return;

		if (this.incoming) {
			this.incoming.t -= step;
			if (this.incoming.t <= 0)
				this.incoming = null;
		}

		this.updateRings();

		if (this.downed) {
			if (!enabled()) {
				// The host switched the mechanic off while we were down: finish the normal death.
				this.hardDeath("revive disabled");
			}
			else {
				// A teammate in the middle of reviving us freezes the bleed-out timer.
				const beingRevived = this.incoming ? this.incoming.frac > 0 : false;
				if (!beingRevived)
					this.bleed -= step;
				const peers = this.peerCounts();
				if (this.bleed <= 0 || (peers.visible > 0 && peers.living === 0))
					this.hardDeath(this.bleed <= 0 ? "bleed out" : "whole party down");
			}
		}
		else {
			this.reviverTick(step);
		}

		this.publishUiState();
	}

	onMapLoad() {
		this.clearRings();
		this.stopDowned(false);
		this.resetReviver();
	}

	onConnectionReset() {
		this.clearRings();
		this.stopDowned(false);
		this.resetReviver();
	}

	// Inbound revive traffic. TRUST GAP (protocol, not fixable here): neither message
	// carries a sender and the server relays both verbatim (server.js:129-133), so we
	// cannot tell who is reviving us. All we can verify is that the packet is addressed to
	// us and that we are downed - any peer can revive us from anywhere in the map, or hold
	// our bar above zero to freeze the bleed-out, without being tracked, visible or in
	// range. area-heal's payload does carry `from` and validates it against a tracked,
	// visible actor within `radius`; adding the same field here (ideally stamped by the
	// server, since a self-reported `from` is spoofable) is a wire change and needs
	// coordinator sign-off.
	onMessage(msg) {
		const localId = this.host.getLocalId?.();
		// `!localId` matters: before WELCOME assigns an id, an untargeted message used to
		// match, because undefined === undefined.
		if (!this.downed || !localId || msg?.target !== localId)
			return;
		if (msg.type === MSG.REVIVE)
			this.reviveLocal();
		else if (msg.type === MSG.REVIVE_PROGRESS)
			this.incoming = { frac: clamp01(msg.frac), t: CONFIG.reviveHold };
	}

	// ---- local player going down -------------------------------------------

	goDowned(playerCmp) {
		if (!enabled() || this.downed)
			return false;
		if (terra.export.g_rogue?.isActive?.())
			return false;
		if (!this.host.isConnected?.() || !this.host.hasPeers?.())
			return false;
		const peer = this.peerCounts();
		if (peer.living === 0)
			return false;

		const combatant = playerCmp?.ent?.combatant;
		if (!combatant)
			return false;

		// From here on both flags are set together (see the header): manualKill keeps the
		// entity from being killed, while its state stays KILL_HIT — the engine set that in
		// combatant.onDeathHit (combatant-cmp.js:982) — which is what keeps input blocked
		// and what reviveLocal() has to undo.
		combatant.manualKill = true;
		this.downed = true;
		this.bleed = CONFIG.bleedOut;
		this.resetReviver();
		this.host.setLocalDowned?.(true);
		// The engine spawned the red death blink a moment ago (combatant-cmp.js:985). It
		// loops forever and is local to us, so drop it: we are staying alive, not dying.
		terra.export.FxEntity?.clearEntity?.(playerCmp.ent?.core, BLINK_GROUP, 0, false);
		this.dropEnemyAggro();
		return true;
	}

	reviveLocal() {
		const playerCmp = terra.export.g_player?.entity?.player;
		const combatant = playerCmp?.ent?.combatant;
		// Guard BEFORE touching any state. The combatant can be gone (map/entity teardown,
		// a message that straggles in during it); clearing `downed` first would leave us
		// flagged up - to ourselves and, via setLocalDowned, to our peers - while the
		// engine still has the player defeated, so nothing would ever retry the respawn.
		// Bailing here keeps `downed` set, so the bleed-out runs out and hardDeath()
		// falls through to the vanilla respawn instead.
		if (!combatant)
			return;
		this.stopDowned(true);
		try {
			combatant.params.revive(CONFIG.hpFactor);
			combatant.manualKill = false;
			combatant.cancelStun(true);
			combatant.state = COMBATANT_STATE_ALIVE;
			// PlayerCmp.onRespawnEnd plays the get-up action (player-cmp.js:749).
			playerCmp.onRespawnEnd?.();
			terra.export.FxEntity?.clearEntity?.(combatant.ent?.core, BLINK_GROUP, 0, false);
			this.clearDefeatHud(combatant);
		}
		catch (err) {
			console.warn("[TT revive] revive failed:", err);
		}
	}

	// No ally could save us: hand back to the vanilla death (checkpoint reload).
	//
	// manualKill is deliberately LEFT true. loadCheckpoint only *schedules* a reload
	// behind a 2.5s fade (scene-manager.js:242 -> doLoadingTransition), and the world
	// keeps updating during that fade. If manualKill were cleared, onPostAction would
	// kill the player's core mid-frame (combatant-cmp.js:367 -> entity.js:227) while
	// g_player.entity still points at it — every system that then reads
	// g_player.entity.core.pos (e.g. kama-hook.js:175) crashes. The old combatant is
	// discarded when the map reloads, so the flag doesn't leak.
	hardDeath(reason) {
		const playerCmp = terra.export.g_player?.entity?.player;
		// Deliberately cleared even when there is no playerCmp left to respawn: an entity
		// that no longer exists cannot stay downed, and onMapLoad/onConnectionReset would
		// clear these anyway. (Keeping them would make onPreUpdate retry this every frame
		// with bleed <= 0.)
		this.stopDowned(false);
		if (!playerCmp)
			return;
		try {
			// null force: the real damage force is long gone by now. The vanilla path only
			// hands it to analytics, which tolerates null (analytics-combat.js:115).
			if (this.originalOnDeathHit)
				this.originalOnDeathHit.call(playerCmp, null);
		}
		catch (err) {
			console.warn("[TT revive] respawn failed:", err);
		}
	}

	// Death put our combatant's HP bar into the blinking "DEFEATED" state
	// (combatant-cmp.js:980 -> combat-hud.js:201 -> combat-bar.js:218). Nothing
	// auto-clears `blinking`, so undo it here or the bar can blink forever. The
	// player's floating HP bar is hidden by default (combat-hud.js:182-183), so
	// restore HIDDEN rather than DEFAULT (which would pop it up over the head).
	// The break bar and damage-sum hiding setDefeated() also did are left alone:
	// the HUD re-drives both from its own combat events (combat-hud.js:232-259).
	clearDefeatHud(combatant) {
		const bar = combatant?.hud?.hpBar;
		if (!bar)
			return;
		bar.blinking = false;
		bar.delayTimer = 0;
		bar.doStateTransition?.("HIDDEN", true);
	}

	// Make every enemy that is currently aggroed drop us (see the patches in onLoopStart).
	dropEnemyAggro() {
		const list = terra.export.g_attackFreq?.activeEnemies;
		if (!list)
			return;
		// Copy first: setAggressive(false) removes the enemy from activeEnemies
		// (enemy-cmp.js:397 -> attack-frequency.js:98), so iterating the live array skips
		// entries.
		for (const enemy of [...list])
			enemy?.setAggressive?.(false);
	}

	stopDowned(resetCombatant) {
		if (!this.downed)
			return;
		this.downed = false;
		this.bleed = 0;
		this.incoming = null;
		this.host.setLocalDowned?.(false);
		if (resetCombatant) {
			// resetCombatant is false on the hard-death path, where manualKill must stay
			// true (see hardDeath).
			const combatant = terra.export.g_player?.entity?.player?.ent?.combatant;
			if (combatant)
				combatant.manualKill = false;
		}
	}

	// Visible peers in this room, and how many of them are still up.
	peerCounts() {
		const actors = this.host.getPlayerActors?.();
		const down = this.host.getPeerDowned?.();
		const counts = { visible: 0, living: 0 };
		if (!actors)
			return counts;
		// playerActors only ever holds peers (client.js -> actors.js createPlayerActor);
		// we are never in it, so living === 0 really means "no ally can revive us".
		for (const [id, actor] of actors) {
			if (!actor?.core?.isVisible?.())
				continue;
			counts.visible++;
			if (!down?.get?.(id))
				counts.living++;
		}
		return counts;
	}

	// ---- reviving a peer ----------------------------------------------------

	resetReviver() {
		this.target = null;
		this.progress = 0;
		this.sentFrac = -1;
	}

	reviverTick(step) {
		const me = terra.export.g_player?.entity;
		if (!me?.core) {
			this.resetReviver();
			return;
		}
		if (this.cooldown > 0) {
			this.cooldown -= step;
			return;
		}

		const actors = this.host.getPlayerActors?.();
		const down = this.host.getPeerDowned?.();
		if (!actors || !down) {
			this.resetReviver();
			return;
		}

		// Nearest downed, visible peer within reach.
		const r2 = CONFIG.radius * CONFIG.radius;
		let target = null, best = r2;
		for (const [id, actor] of actors) {
			if (!down.get?.(id) || !actor?.core?.isVisible?.())
				continue;
			const d = dist2(me.core.pos, actor.core.pos);
			if (d <= best) {
				best = d;
				target = id;
			}
		}

		// Same target in reach: build progress. Otherwise decay instead of snapping to 0,
		// so the bar on the downed player drains when the reviver steps away.
		if (target !== null && target === this.target) {
			this.progress += step * (isMoving(me) ? CONFIG.moveFactor : 1);
		}
		else {
			if (this.progress > 0) {
				this.progress -= CONFIG.decay * step;
				if (this.progress < 0)
					this.progress = 0;
			}
			if (this.progress <= 0) {
				// Clear the abandoned peer's bar promptly, then adopt the new target.
				if (this.target && this.target !== target)
					this.host.send?.({ type: MSG.REVIVE_PROGRESS, target: this.target, frac: 0 });
				this.target = target; // possibly null
				this.sentFrac = -1;
			}
		}
		if (!this.target)
			return;

		const frac = Math.min(1, this.progress / CONFIG.reviveTime);
		if (Math.abs(frac - this.sentFrac) >= CONFIG.resend) {
			this.sentFrac = frac;
			this.host.send?.({ type: MSG.REVIVE_PROGRESS, target: this.target, frac });
		}
		if (frac >= 1) {
			// No `from`: the receiver cannot verify who we are (see onMessage).
			this.host.send?.({ type: MSG.REVIVE, target: this.target });
			this.resetReviver();
			this.cooldown = CONFIG.cooldown;
		}
	}

	publishUiState() {
		window.terraTogether.reviveState = {
			selfDownedFrac: this.downedFraction(),
			selfReviveFrac: this.incoming?.frac ?? null,
			target: this.target,
			targetFrac: this.target ? Math.min(1, this.progress / CONFIG.reviveTime) : null,
		};
	}

	// ---- revive-radius ring (drawn on downed peers) -------------------------

	updateRings() {
		const actors = this.host.getPlayerActors?.();
		const down = this.host.getPeerDowned?.();
		if (!actors || !down) {
			this.clearRings();
			return;
		}
		const live = new Set();
		for (const [id, actor] of actors) {
			if (!down.get?.(id) || !actor?.core?.isVisible?.())
				continue;
			live.add(id);
			if (!this.rings.has(id))
				this.rings.set(id, { actor, fx: this.spawnRing(actor) });
		}
		for (const [id, entry] of [...this.rings]) {
			if (live.has(id))
				continue;
			this.despawnRing(entry);
			this.rings.delete(id);
		}
	}

	spawnRing(actor) {
		if (!CONFIG.ringEffect || !actor?.core)
			return null;
		try {
			const effect = terra.export.Effect?.get?.(CONFIG.ringEffect);
			if (!effect)
				return null;
			const align = terra.export.ENT_ALIGN;
			// Anchor to the peer's feet, nudged down toward the ground (the effect hovers),
			// and scaled up a touch so it reads as a ground marker. Z_BASE/CENTER are the
			// entity alignments the engine's own ground markers use for those two roles.
			const offset = CONFIG.ringZOffset
				? new Vec3(0, 0, CONFIG.ringZOffset)
				: undefined;
			const fx = effect.spawnEntity(actor, align?.Z_BASE ?? 0, offset);
			if (!fx)
				return null;
			if (CONFIG.ringScale && CONFIG.ringScale !== 1)
				fx.scale = CONFIG.ringScale;
			fx.setTarget2Entity?.(actor, align?.CENTER ?? 0);
			fx.setGroup(RING_GROUP);
			fx.start(-1); // -1 = loop forever, like the defeat blink we cleared
			return fx;
		}
		catch (err) {
			return null;
		}
	}

	despawnRing(entry) {
		const core = entry?.actor?.core;
		if (!core)
			return;
		try { terra.export.FxEntity?.clearEntity?.(core, RING_GROUP, 0, true); }
		catch (err) { /* actor already gone with the map */ }
	}

	clearRings() {
		for (const entry of this.rings.values())
			this.despawnRing(entry);
		this.rings.clear();
	}
}

function clamp01(v) {
	return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

//# sourceURL=/mods/terra-together/features/revive.js
