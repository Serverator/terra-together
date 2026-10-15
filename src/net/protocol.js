/**
 * src/net/protocol.js
 * Single source of truth for the Terra Together wire message types.
 * Responsibilities:
 *   - Declare every `msg.type` string that client and server exchange over the websocket.
 *   - Provide isKnownType() so callers can validate an inbound type before dispatch.
 * Public surface: MSG, isKnownType
 * Engine touchpoints: none (pure data; no terra.* usage, no globals, no addon hooks)
 * Notes:
 *   - The string VALUES are the wire contract and are case-sensitive; both the client
 *     dispatch switch and the server relay switch match on them, so a typo here silently
 *     turns a message into a no-op (server) or an unhandled message (client).
 *   - Direction is not encoded: some types are client->server ("profile", "update",
 *     "scene_changed", "join_map", "revive", "revive_progress", "area_heal"), some are
 *     server->client ("welcome", "host_setting", "player_profile", "player_joined",
 *     "player_left"), and "update"/"join_map"/"scene_changed"/"revive*"/"area_heal" are
 *     also relayed back out by the server.
 */

export const MSG = { UPDATE:"update", SCENE_CHANGED:"scene_changed", PROFILE:"profile", JOIN_MAP:"join_map", REVIVE:"revive", REVIVE_PROGRESS:"revive_progress", AREA_HEAL:"area_heal", WELCOME:"welcome", HOST_SETTING:"host_setting", PLAYER_PROFILE:"player_profile", PLAYER_JOINED:"player_joined", PLAYER_LEFT:"player_left" };
export function isKnownType(type) { return Object.values(MSG).includes(type); }

//# sourceURL=/mods/terra-together/net/protocol.js
