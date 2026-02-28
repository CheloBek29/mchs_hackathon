'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const TLS_KEY_PATH = process.env.TLS_KEY_PATH ? path.resolve(process.env.TLS_KEY_PATH) : null;
const TLS_CERT_PATH = process.env.TLS_CERT_PATH ? path.resolve(process.env.TLS_CERT_PATH) : null;

if ((TLS_KEY_PATH && !TLS_CERT_PATH) || (!TLS_KEY_PATH && TLS_CERT_PATH)) {
  console.error('Both TLS_KEY_PATH and TLS_CERT_PATH must be set together.');
  process.exit(1);
}

const TLS_ENABLED = Boolean(TLS_KEY_PATH && TLS_CERT_PATH);
const PORT = Number(process.env.PORT || (TLS_ENABLED ? 8443 : 8080));

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function requestHandler(req, res) {
  if (!req.url) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const requestedPath = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
  const normalizedPath = path.normalize(requestedPath).replace(/^([\\/])+/, '');
  const filePath = path.join(PUBLIC_DIR, normalizedPath);

  const publicPrefix = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : `${PUBLIC_DIR}${path.sep}`;
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(publicPrefix)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    res.end(data);
  });
}

let serverProtocol = 'http';
let server;

if (TLS_ENABLED) {
  let key;
  let cert;
  try {
    key = fs.readFileSync(TLS_KEY_PATH);
    cert = fs.readFileSync(TLS_CERT_PATH);
  } catch (error) {
    console.error(`Failed to read TLS files: ${error.message}`);
    process.exit(1);
  }
  server = https.createServer({ key, cert }, requestHandler);
  serverProtocol = 'https';
} else {
  server = http.createServer(requestHandler);
}

const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<import('ws').WebSocket, { id: string, name: string, role: string, joined: boolean }>} */
const clients = new Map();
let currentSpeakerId = null;
let currentTalkId = 0;

function safeName(raw, fallback) {
  const cleaned = String(raw || '')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}

function safeRole(raw) {
  return String(raw || '')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, 32)
    .toUpperCase() || 'БЕЗ РОЛИ';
}

function serializeParticipant(client) {
  return {
    id: client.id,
    name: client.name,
    role: client.role,
    speaking: client.id === currentSpeakerId
  };
}

function findClientById(id) {
  for (const [, client] of clients) {
    if (client.id === id) {
      return client;
    }
  }
  return null;
}

function findSocketByClientId(id) {
  for (const [ws, client] of clients) {
    if (client.id === id) {
      return { ws, client };
    }
  }
  return null;
}

function sendJson(ws, payload) {
  if (ws.readyState !== ws.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

function broadcastJson(payload, exceptWs = null) {
  for (const [ws] of clients) {
    if (ws === exceptWs || ws.readyState !== ws.OPEN) {
      continue;
    }
    ws.send(JSON.stringify(payload));
  }
}

function buildStatePayload() {
  const participants = [];
  for (const [, client] of clients) {
    if (client.joined) {
      participants.push(serializeParticipant(client));
    }
  }

  participants.sort((a, b) => a.role.localeCompare(b.role, 'ru') || a.name.localeCompare(b.name, 'ru'));

  const currentSpeaker = currentSpeakerId ? findClientById(currentSpeakerId) : null;

  return {
    type: 'state',
    participants,
    speaker: currentSpeaker ? serializeParticipant(currentSpeaker) : null,
    talkId: currentSpeakerId ? currentTalkId : null
  };
}

function broadcastState() {
  broadcastJson(buildStatePayload());
}

function releaseChannel(reason, releasedByClientId = null) {
  if (!currentSpeakerId) {
    return;
  }

  const previousSpeaker = findClientById(currentSpeakerId);
  currentSpeakerId = null;

  broadcastJson({
    type: 'speaker_update',
    speaker: null,
    talkId: null,
    reason: reason || 'released',
    releasedBy: releasedByClientId,
    previousSpeaker: previousSpeaker ? serializeParticipant(previousSpeaker) : null
  });

  broadcastState();
}

function grantChannel(ws, client) {
  currentSpeakerId = client.id;
  currentTalkId = (currentTalkId + 1) >>> 0;
  if (currentTalkId === 0) {
    currentTalkId = 1;
  }

  sendJson(ws, {
    type: 'ptt_granted',
    talkId: currentTalkId
  });

  broadcastJson({
    type: 'speaker_update',
    speaker: serializeParticipant(client),
    talkId: currentTalkId
  });

  broadcastState();
}

function denyChannel(ws) {
  const speaker = currentSpeakerId ? findClientById(currentSpeakerId) : null;
  sendJson(ws, {
    type: 'ptt_denied',
    reason: 'channel_busy',
    speaker: speaker ? serializeParticipant(speaker) : null
  });
}

wss.on('connection', (ws) => {
  const id = crypto.randomUUID();
  const client = {
    id,
    name: `Участник ${id.slice(0, 8)}`,
    role: 'БЕЗ РОЛИ',
    joined: false
  };

  clients.set(ws, client);

  sendJson(ws, {
    type: 'hello_required',
    id,
    message: 'Передайте имя и роль для входа в учебную сессию.'
  });

  ws.on('message', (raw, isBinary) => {
    if (!clients.has(ws)) {
      return;
    }

    const liveClient = clients.get(ws);
    if (!liveClient) {
      return;
    }

    if (isBinary) {
      if (!liveClient.joined || currentSpeakerId !== liveClient.id) {
        return;
      }

      const frame = Buffer.from(raw);
      if (frame.length <= 6) {
        return;
      }

      const frameType = frame.readUInt8(0);
      const talkId = frame.readUInt32LE(1);
      if (frameType !== 1 || talkId !== currentTalkId) {
        return;
      }

      for (const [peerWs, peerClient] of clients) {
        if (peerWs === ws || peerWs.readyState !== peerWs.OPEN || !peerClient.joined) {
          continue;
        }
        peerWs.send(frame, { binary: true });
      }
      return;
    }

    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      sendJson(ws, {
        type: 'error',
        code: 'bad_json',
        message: 'Неверный JSON формат.'
      });
      return;
    }

    switch (message.type) {
      case 'hello': {
        liveClient.name = safeName(message.name, liveClient.name);
        liveClient.role = safeRole(message.role);
        liveClient.joined = true;

        sendJson(ws, {
          type: 'welcome',
          id: liveClient.id,
          participant: serializeParticipant(liveClient)
        });

        sendJson(ws, buildStatePayload());
        broadcastState();
        break;
      }

      case 'ptt_request': {
        if (!liveClient.joined) {
          sendJson(ws, {
            type: 'error',
            code: 'not_joined',
            message: 'Сначала отправьте hello с именем и ролью.'
          });
          return;
        }

        if (!currentSpeakerId) {
          grantChannel(ws, liveClient);
          return;
        }

        if (currentSpeakerId === liveClient.id) {
          sendJson(ws, {
            type: 'ptt_granted',
            talkId: currentTalkId,
            resumed: true
          });
          return;
        }

        denyChannel(ws);
        break;
      }

      case 'ptt_release': {
        if (currentSpeakerId === liveClient.id) {
          releaseChannel('manual_release', liveClient.id);
        }
        break;
      }

      case 'signal_offer':
      case 'signal_answer':
      case 'signal_ice': {
        if (!liveClient.joined) {
          sendJson(ws, {
            type: 'error',
            code: 'not_joined',
            message: 'Сначала отправьте hello с именем и ролью.'
          });
          return;
        }

        const targetId = String(message.to || '').trim();
        if (!targetId) {
          sendJson(ws, {
            type: 'error',
            code: 'signal_bad_target',
            message: 'Поле to обязательно для сигналинга.'
          });
          return;
        }

        if (targetId === liveClient.id) {
          return;
        }

        const target = findSocketByClientId(targetId);
        if (!target || !target.client.joined || target.ws.readyState !== target.ws.OPEN) {
          sendJson(ws, {
            type: 'error',
            code: 'peer_not_found',
            message: 'Целевой участник недоступен.'
          });
          return;
        }

        if ((message.type === 'signal_offer' || message.type === 'signal_answer') && (!message.sdp || typeof message.sdp !== 'object')) {
          sendJson(ws, {
            type: 'error',
            code: 'signal_bad_sdp',
            message: 'Для offer/answer нужно передать sdp.'
          });
          return;
        }

        if (message.type === 'signal_ice') {
          sendJson(target.ws, {
            type: 'signal_ice',
            from: liveClient.id,
            candidate: message.candidate || null
          });
          return;
        }

        sendJson(target.ws, {
          type: message.type,
          from: liveClient.id,
          sdp: message.sdp
        });
        break;
      }

      case 'heartbeat': {
        sendJson(ws, { type: 'heartbeat_ack', now: Date.now() });
        break;
      }

      default:
        sendJson(ws, {
          type: 'error',
          code: 'unknown_type',
          message: `Неизвестный тип сообщения: ${String(message.type)}`
        });
        break;
    }
  });

  ws.on('close', () => {
    const closedClient = clients.get(ws);
    if (!closedClient) {
      return;
    }

    if (currentSpeakerId === closedClient.id) {
      releaseChannel('disconnect', closedClient.id);
    }

    clients.delete(ws);
    broadcastState();
  });

  ws.on('error', () => {
    // Socket errors are handled by close flow.
  });
});

function getLanAddresses(protocol) {
  const interfaces = os.networkInterfaces();
  const urls = [];
  for (const key of Object.keys(interfaces)) {
    const iface = interfaces[key] || [];
    for (const details of iface) {
      if (details.family === 'IPv4' && !details.internal) {
        urls.push(`${protocol}://${details.address}:${PORT}`);
      }
    }
  }
  return urls;
}

server.listen(PORT, HOST, () => {
  console.log(`PTT server listening on ${HOST}:${PORT} (${serverProtocol.toUpperCase()})`);
  console.log('Open in browser:');
  console.log(`- ${serverProtocol}://localhost:${PORT}`);
  for (const url of getLanAddresses(serverProtocol)) {
    console.log(`- ${url}`);
  }
});
