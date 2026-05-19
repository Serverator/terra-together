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
		let header;
		if (payload.length < 126) {
			header = Buffer.from([0x81, payload.length]);
		} else if (payload.length < 65536) {
			header = Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xFF]);
		} else {
			header = Buffer.allocUnsafe(10);
			header[0] = 0x81;
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(payload.length), 2);
		}
		this.socket.write(Buffer.concat([header, payload]));
	}

	close() {
		if (!this.isOpen) return;
		this.socket.write(Buffer.from([0x88, 0x00]), () =>
			this.socket.destroy()
		);
	}

	parseRecievedData() {
		while (this.buffer.length >= 2) {
			const masked = (this.buffer[1] & 0x80) !== 0;
			let payloadLen = this.buffer[1] & 0x7f;
			let offset = 2;

			if (payloadLen === 126) {
				if (this.buffer.length < 4) return;
				payloadLen = this.buffer.readUInt16BE(2);
				offset = 4;
			} else if (payloadLen === 127) {
				if (this.buffer.length < 10) return;
				payloadLen = Number(this.buffer.readBigUInt64BE(2));
				offset = 10;
			}

			const totalLen = offset + (masked ? 4 : 0) + payloadLen;
			if (this.buffer.length < totalLen) return;

			let payload;
			if (masked) {
				const mask = this.buffer.slice(offset, offset + 4);
				offset += 4;
				payload = Buffer.allocUnsafe(payloadLen);
				for (let i = 0; i < payloadLen; i++)
					payload[i] = this.buffer[offset + i] ^ mask[i % 4];
			} else {
				payload = this.buffer.slice(offset, offset + payloadLen);
			}

			this.buffer = this.buffer.slice(offset + payloadLen);
			this.emit('message', payload.toString('utf8'));
		}
	}
}

class WebSocketServer extends EventEmitter {
	constructor({ port, host = '0.0.0.0' }) {
		super();
		this.http = createServer();

		this.http.on('upgrade', (req, socket) => {
			const key = req.headers['sec-websocket-key'];
			if (!key) { socket.destroy(); return; }

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
		this.http.listen(port, host, () => this.emit('listening'));
	}

	close(cb) {
		this.http.close(cb);
	}
}

//# sourceURL=/mods/terra-together/ws.js
