/**
 * src/net/ws.js
 * Hand-rolled RFC6455 WebSocket server: HTTP upgrade handshake plus frame encode/decode.
 * Responsibilities:
 *   - Perform the RFC6455 opening handshake (Sec-WebSocket-Key -> Sec-WebSocket-Accept).
 *   - Frame outbound text messages (0x81) with 7/16/64-bit payload lengths.
 *   - Parse inbound frames, unmask client payloads, and handle close/ping/pong opcodes.
 * Public surface: WebSocketServer, WebSocketConnection
 * Engine touchpoints: node built-ins only (http/crypto/events) supplied by the mod host; no terra.*
 * Notes:
 *   - This is transport plumbing only: no game logic and no knowledge of message types
 *     (the wire type table lives in src/net/protocol.js and is consumed by the server).
 *   - Loaded as an ES module (modloader.js:243 imports the mod entry with import()), yet
 *     `require` works here because the mod host is NW.js, which exposes node's built-ins
 *     to the page; `http`/`crypto`/`events` are supplied by the host, not by terra.*.
 *   - Framing invariant: decode handles exactly one frame per message and never inspects
 *     the FIN bit, so a fragmented message degrades badly -- the first fragment is emitted
 *     as if it were the whole message (truncated JSON, which the caller's JSON.parse then
 *     rejects) and the 0x0 continuation frames are dropped. That is safe for the payloads
 *     exchanged here: the client side is the JS WebSocket API (src/client/session.js, `new
 *     WebSocket`), which has no fragmentation step and always sends one unfragmented frame
 *     per send().
 *   - Only text frames (0x1) surface as 'message'; binary frames are consumed and ignored,
 *     close/ping/pong are handled below.
 *   - WebSocketConnection.send() emits unmasked frames, correct for server->client.
 *   - No maximum frame size is enforced, so a peer that declares a huge 64-bit length can
 *     make us buffer indefinitely (see parseRecievedData). Accepted for a co-op host.
 */
const { createServer } = require("http");
const { createHash } = require("crypto");
const { EventEmitter } = require("events");

export { WebSocketServer, WebSocketConnection };

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WebSocketConnection extends EventEmitter {
	constructor(socket) {
		super();
		this.isOpen = true;
		this.socket = socket;
		this.buffer = Buffer.alloc(0);

		socket.on('data', (chunk) => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			this.parseRecievedData();
		});

		socket.on('close', () => {
			this.isOpen = false;
			this.emit('close');
		});

		socket.on('error', (err) => this.emit('error', err));
	}

	send(data) {
		if (!this.isOpen) return;
		const payload = Buffer.from(data, 'utf8');
		// Server->client frames are never masked (RFC6455 5.1), so byte 1 has the mask bit
		// clear and there is no masking key: the header is byte 0 (FIN=1, opcode=1 => 0x81)
		// plus the length in the smallest of its three forms (RFC6455 5.2).
		let header;
		if (payload.length < 126) {
			// 7-bit length, carried in byte 1 itself.
			header = Buffer.from([0x81, payload.length]);
		} else if (payload.length < 65536) {
			// 16-bit length: byte 1 is the marker 126, bytes 2-3 the big-endian length.
			header = Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xFF]);
		} else {
			// 64-bit length: byte 1 is the marker 127, bytes 2-9 the big-endian length.
			header = Buffer.allocUnsafe(10);
			header[0] = 0x81;
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(payload.length), 2);
		}
		this.socket.write(Buffer.concat([header, payload]));
	}

	close() {
		if (!this.isOpen) return;
		// Close frame 0x88 with an empty payload (no status code), then destroy only once
		// the frame has flushed, so the socket is never torn down mid-write. isOpen stays
		// true until the socket's own 'close' event fires, so a send() racing this write
		// would still emit a data frame after the close frame -- do not send after close().
		this.socket.write(Buffer.from([0x88, 0x00]), () =>
			this.socket.destroy()
		);
	}

	parseRecievedData() {
		// Frame layout (RFC6455 5.2) -- byte 0: FIN(1) RSV(3) opcode(4); byte 1: MASK(1)
		// payloadLen(7); then, when payloadLen is 126 or 127, the 16- or 64-bit length;
		// then, when MASK is set, the 4-byte key; then the (masked) payload.
		// The loop drains every complete frame in this.buffer and returns as soon as one is
		// incomplete, keeping the remainder for the next 'data' chunk -- that is what makes
		// a frame split across TCP reads resume instead of being lost.
		while (this.buffer.length >= 2) {
			const opcode = this.buffer[0] & 0x0f; // FIN and RSV bits deliberately ignored
			const masked = (this.buffer[1] & 0x80) !== 0;
			let payloadLen = this.buffer[1] & 0x7f;
			let offset = 2; // bytes of the header consumed so far

			if (payloadLen === 126) {
				// 16-bit extended length: the frame cannot be sized until all 4 header
				// bytes have arrived, so bail out and wait rather than reading short.
				if (this.buffer.length < 4) return;
				payloadLen = this.buffer.readUInt16BE(2);
				offset = 4;
			} else if (payloadLen === 127) {
				// 64-bit extended length (10 header bytes in total). Values above 2^53
				// would lose precision in Number(), but a frame that large can never be
				// buffered anyway.
				if (this.buffer.length < 10) return;
				payloadLen = Number(this.buffer.readBigUInt64BE(2));
				offset = 10;
			}

			// Whole frame = header + masking key (only when the peer masked it) + payload.
			// If any byte is still missing, keep the buffer intact and wait for more data.
			const totalLen = offset + (masked ? 4 : 0) + payloadLen;
			if (this.buffer.length < totalLen) return;

			let payload;
			if (masked) {
				// Client->server frames must be masked (RFC6455 5.1). Unmask into a copy --
				// the key repeats every 4 bytes, and the copy is what keeps `payload`
				// readable after this.buffer is re-sliced past the frame below.
				const mask = this.buffer.slice(offset, offset + 4);
				offset += 4;
				payload = Buffer.allocUnsafe(payloadLen);
				for (let i = 0; i < payloadLen; i++)
					payload[i] = this.buffer[offset + i] ^ mask[i % 4];
			} else {
				// Unmasked payload: a view, not a copy (only peers that skip masking, which
				// the spec forbids for client->server, land here).
				payload = this.buffer.slice(offset, offset + payloadLen);
			}

			// Consume the frame before dispatching it: the branches below may emit() or
			// close(), and each must observe the frame already taken out of the buffer.
			this.buffer = this.buffer.slice(offset + payloadLen);

			if (opcode === 0x8) {
				// Peer requested close: acknowledge it and tear the socket down so both
				// sides actually get their 'close' event (otherwise the handshake hangs).
				this.close();
				return; // connection is over; drop whatever else is still buffered
			}
			if (opcode === 0x9) {
				// Ping: reply with a pong (0x8A) carrying the same payload. RFC6455 5.5 caps
				// control-frame payloads at 125 bytes, so the 7-bit length byte is always
				// sufficient and no extended length has to be appended here.
				this.socket.write(Buffer.concat([Buffer.from([0x8A, payload.length]), payload]));
				continue;
			}
			if (opcode === 0xA)
				continue; // pong: nothing to do

			if (opcode === 0x1)
				this.emit('message', payload.toString('utf8'));
			// Any other opcode (0x0 continuation, 0x2 binary) falls through: the frame is
			// consumed and ignored, see the framing note in the header.
		}
	}
}

class WebSocketServer extends EventEmitter {
	constructor({ port, host = '0.0.0.0' }) {
		super();
		this.http = createServer();

		// Node emits 'upgrade' for any request carrying an Upgrade header; the handshake
		// below is the RFC6455 4.2 one. It is not re-validated beyond the key, which is the
		// only peer-supplied field we read -- the game's own client is the only expected
		// peer, and a stricter check would only reject peers we don't have.
		this.http.on('upgrade', (req, socket) => {
			// Sec-WebSocket-Key is required; without it this is not a websocket upgrade.
			const key = req.headers['sec-websocket-key'];
			if (!key) { socket.destroy(); return; }

			// Accept = base64(sha1(key + the RFC6455 GUID)); the GUID is the magic constant that
			// proves to the peer we understood the request rather than echoing it back.
			const accept = createHash('sha1')
				.update(key + WS_GUID)
				.digest('base64');

			socket.write(
				'HTTP/1.1 101 Switching Protocols\r\n' +
				'Upgrade: websocket\r\n' +
				'Connection: Upgrade\r\n' +
				`Sec-WebSocket-Accept: ${accept}\r\n\r\n`
			);

			this.emit('connection', new WebSocketConnection(socket), req);
		});

		this.http.on('error', (err) => this.emit('error', err));
		this.http.on('close', () => this.emit('close'));
		// 'listening' (not the listen() call) is what callers await before dialling in,
		// so a client cannot race the bind; see startServer in src/server/server.js.
		this.http.listen(port, host, () => this.emit('listening'));
	}

	// Stops accepting peers. Already-upgraded sockets are the caller's to close (see
	// stopServer in src/server/server.js), so this is not a full teardown on its own.
	close(cb) {
		this.http.close(cb);
	}
}

//# sourceURL=/mods/terra-together/net/ws.js
