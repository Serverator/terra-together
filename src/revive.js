// Downed / revive system (multiplayer).
//
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
// engine's own CombatParams.revive() (combat-params.js:269, the primitive rogue's
// "once more" perk uses).
//
// Solo, in rogue, or with no living ally in the room: we fall straight through to the
// vanilla death, untouched.

export { Reviver };

const COMBATANT_STATE_ALIVE = terra.export.COMBATANT_STATE?.ALIVE ?? 0;
// Frame delta is clamped so a hitch (or an unpause) can't fast-forward the timers.
const MAX_DT = 0.1;

// Tunables, also exposed at runtime as window.terraTogether.reviveConfig.
const CONFIG = {
	bleedOut: 20,     // seconds a downed player has before being force-respawned
	reviveTime: 5,    // seconds a teammate must stay within `radius`
	radius: 3.0,      // world units (XY): revive range, also the drawn ring radius
	hpFactor: 0.25,    // HP fraction restored on revive
	cooldown: 1,      // seconds before a reviver can start another revive
	resend: 0.02,     // min progress change between revive-progress updates
	decay: 3.0,       // progress lost per second when nobody is reviving (0 = instant reset)
	reviveHold: 0.6,  // how long one progress update keeps the incoming bar alive
	moveFactor: 0.5,  // revive speed multiplier while the reviver is moving (0.5 = twice as slow)
	moveSpeed: 0.2,   // world units/sec below which the reviver counts as standing still
	// Ground ring shown on each downed teammate so helpers can see where to stand.
	// Set to null to disable. Any "FX:<sheet>#<name>" key works, e.g.
	// "FX:combat.targeting#circle3".
	ringEffect: "FX:combat.targeting#circle3",
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

	debug(...args) {
		if (window.terraTogether?.reviveDebug)
			console.debug("[TT revive]", ...args);
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
		// they must not (re)acquire us. `setAggressive(true)` is the single choke point
		// used by both auto-aggro (enemy-cmp.js:601) and taking a hit (enemy-cmp.js:1100),
		// and `triggerAggression` adds aim/target side effects, so gate both.
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

	onMessage(msg) {
		if (msg?.target !== this.host.getLocalId?.() || !this.downed)
			return;
		if (msg.type === "revive")
			this.reviveLocal();
		else if (msg.type === "revive_progress")
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

		combatant.manualKill = true;
		this.downed = true;
		this.bleed = CONFIG.bleedOut;
		this.resetReviver();
		this.host.setLocalDowned?.(true);
		// The engine spawned the red death blink a moment ago (combatant-cmp.js:985). It
		// loops forever and is local to us, so drop it: we are staying alive, not dying.
		terra.export.FxEntity?.clearEntity?.(playerCmp.ent?.core, BLINK_GROUP, 0, false);
		this.dropEnemyAggro();
		this.debug("downed for", CONFIG.bleedOut, "s");
		return true;
	}

	reviveLocal() {
		const playerCmp = terra.export.g_player?.entity?.player;
		const combatant = playerCmp?.ent?.combatant;
		this.stopDowned(true);
		if (!combatant)
			return;
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
		this.debug("revived");
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
		this.stopDowned(false);
		this.debug(reason, "-> checkpoint");
		if (!playerCmp)
			return;
		try {
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
					this.host.send?.({ type: "revive_progress", target: this.target, frac: 0 });
				this.target = target; // possibly null
				this.sentFrac = -1;
			}
		}
		if (!this.target)
			return;

		const frac = Math.min(1, this.progress / CONFIG.reviveTime);
		if (Math.abs(frac - this.sentFrac) >= CONFIG.resend) {
			this.sentFrac = frac;
			this.host.send?.({ type: "revive_progress", target: this.target, frac });
		}
		if (frac >= 1) {
			this.host.send?.({ type: "revive", target: this.target });
			this.debug("revived peer", this.target);
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
			// Anchor to the peer's feet so the ring sits on the ground under them.
			const fx = effect.spawnEntity(actor, align?.Z_BASE ?? 0);
			if (!fx)
				return null;
			fx.setTarget2Entity?.(actor, align?.CENTER ?? 0);
			fx.setGroup(RING_GROUP);
			fx.start(-1);
			return fx;
		}
		catch (err) {
			this.debug("ring fx failed:", err);
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

//# sourceURL=/mods/terra-together/revive.js
