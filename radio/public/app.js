'use strict';

const dom = {
  joinCard: document.getElementById('joinCard'),
  radioCard: document.getElementById('radioCard'),
  joinForm: document.getElementById('joinForm'),
  joinBtn: document.getElementById('joinBtn'),
  wsUrl: document.getElementById('wsUrl'),
  name: document.getElementById('name'),
  role: document.getElementById('role'),
  selfInfo: document.getElementById('selfInfo'),
  connectionStatus: document.getElementById('connectionStatus'),
  speakerIndicator: document.getElementById('speakerIndicator'),
  pttBtn: document.getElementById('pttBtn'),
  pttHint: document.getElementById('pttHint'),
  participants: document.getElementById('participants'),
  events: document.getElementById('events')
};

const rtcConfig = {
  iceServers: [],
  iceCandidatePoolSize: 4
};

const RADIO_NOISE_URL = '/assets/radio-noise.mp3';

const peers = new Map();

const state = {
  ws: null,
  connected: false,
  joined: false,
  self: null,
  participants: [],
  speaker: null,
  talkId: null,
  pttPressed: false,
  awaitingGrant: false,
  isTransmitting: false,
  deniedSpeaker: null,
  localStream: null,
  localTrack: null,
  audioOutContext: null,
  noiseElement: null,
  noiseSourceNode: null,
  noiseHpNode: null,
  noiseLpNode: null,
  noiseGainNode: null,
  noiseActive: false,
  noiseStopTimer: null
};

const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
dom.wsUrl.value = `${wsProtocol}://${window.location.host}/ws`;

function addEvent(message) {
  const line = document.createElement('li');
  const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  line.innerHTML = `<span class="time">${time}</span>${message}`;
  dom.events.prepend(line);

  while (dom.events.children.length > 80) {
    dom.events.removeChild(dom.events.lastChild);
  }
}

function setConnectionBadge(mode) {
  const badge = dom.connectionStatus;
  if (mode === 'online') {
    badge.textContent = 'ONLINE';
    badge.classList.add('online');
    return;
  }

  if (mode === 'connecting') {
    badge.textContent = 'CONNECTING';
    badge.classList.remove('online');
    return;
  }

  badge.textContent = 'OFFLINE';
  badge.classList.remove('online');
}

function currentSpeakerText() {
  if (!state.speaker) {
    return '[ГОВОРИТ: НЕТ]';
  }

  return `[ГОВОРИТ: ${state.speaker.role}] ${state.speaker.name}`;
}

function renderSpeaker() {
  dom.speakerIndicator.textContent = currentSpeakerText();
  dom.speakerIndicator.classList.toggle('live', Boolean(state.speaker));
}

function renderParticipants() {
  dom.participants.innerHTML = '';

  if (!state.participants.length) {
    const empty = document.createElement('li');
    empty.textContent = 'Нет подключенных участников.';
    dom.participants.appendChild(empty);
    return;
  }

  for (const item of state.participants) {
    const li = document.createElement('li');
    li.classList.toggle('live', Boolean(item.speaking));

    const me = state.self && state.self.id === item.id ? ' (вы)' : '';
    const speaking = item.speaking ? ' [говорит]' : '';
    li.textContent = `${item.role} - ${item.name}${me}${speaking}`;
    dom.participants.appendChild(li);
  }
}

function renderPttUi() {
  const disabled = !state.connected || !state.joined;
  dom.pttBtn.disabled = disabled;
  dom.pttBtn.classList.toggle('pressed', state.pttPressed);
  dom.pttBtn.classList.toggle('waiting', state.awaitingGrant && !state.isTransmitting);
  dom.pttBtn.classList.toggle('live', state.isTransmitting);

  if (disabled) {
    dom.pttBtn.textContent = 'Подключитесь к сессии';
    dom.pttHint.textContent = 'Сначала подключитесь и выберите роль.';
    return;
  }

  if (!state.localTrack) {
    dom.pttBtn.textContent = 'МИКРОФОН НЕ ДОСТУПЕН';
    dom.pttHint.textContent = 'Разрешите доступ к микрофону, чтобы передавать голос.';
    return;
  }

  if (state.isTransmitting) {
    dom.pttBtn.textContent = 'ИДЕТ ПЕРЕДАЧА - ОТПУСТИТЕ ДЛЯ ЗАВЕРШЕНИЯ';
    dom.pttHint.textContent = 'Канал занят вами. Голос передается в реальном времени.';
    return;
  }

  if (state.awaitingGrant) {
    dom.pttBtn.textContent = 'ОЖИДАНИЕ ЗАХВАТА КАНАЛА...';
    dom.pttHint.textContent = 'Сервер проверяет доступность канала.';
    return;
  }

  if (state.deniedSpeaker) {
    dom.pttHint.textContent = `Канал занят: ${state.deniedSpeaker.role} ${state.deniedSpeaker.name}`;
  } else {
    dom.pttHint.textContent = 'Нажмите и удерживайте кнопку, чтобы запросить канал.';
  }

  dom.pttBtn.textContent = 'Удерживайте для передачи (Пробел)';
}

function renderAll() {
  renderSpeaker();
  renderParticipants();
  renderPttUi();
}

function setLocalTrackEnabled(enabled) {
  if (!state.localTrack) {
    return;
  }
  state.localTrack.enabled = Boolean(enabled);
}

function sendJson(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }
  state.ws.send(JSON.stringify(payload));
}

async function ensurePlaybackContext() {
  if (!state.audioOutContext) {
    const Context = window.AudioContext || window.webkitAudioContext;
    state.audioOutContext = new Context({ latencyHint: 'interactive' });
  }

  if (state.audioOutContext.state === 'suspended') {
    await state.audioOutContext.resume();
  }
}

function ensureNoiseGraph() {
  if (!state.audioOutContext) {
    return;
  }

  if (state.noiseSourceNode && state.noiseHpNode && state.noiseLpNode && state.noiseGainNode && state.noiseElement) {
    return;
  }

  const context = state.audioOutContext;
  const noiseElement = new Audio(RADIO_NOISE_URL);
  const noiseSourceNode = context.createMediaElementSource(noiseElement);
  const hpNode = context.createBiquadFilter();
  const lpNode = context.createBiquadFilter();
  const gainNode = context.createGain();

  noiseElement.preload = 'auto';
  noiseElement.loop = true;
  noiseElement.crossOrigin = 'anonymous';
  noiseElement.volume = 1;

  gainNode.gain.value = 0;
  hpNode.type = 'highpass';
  hpNode.frequency.value = 1600;
  hpNode.Q.value = 0.7;
  lpNode.type = 'lowpass';
  lpNode.frequency.value = 7200;
  lpNode.Q.value = 0.7;

  noiseSourceNode.connect(hpNode);
  hpNode.connect(lpNode);
  lpNode.connect(gainNode);
  gainNode.connect(context.destination);

  state.noiseElement = noiseElement;
  state.noiseSourceNode = noiseSourceNode;
  state.noiseHpNode = hpNode;
  state.noiseLpNode = lpNode;
  state.noiseGainNode = gainNode;
}

async function setNoiseActive(active) {
  state.noiseActive = Boolean(active);

  try {
    await ensurePlaybackContext();
  } catch {
    return;
  }

  ensureNoiseGraph();
  if (!state.noiseGainNode || !state.audioOutContext || !state.noiseElement) {
    return;
  }

  if (state.noiseStopTimer) {
    clearTimeout(state.noiseStopTimer);
    state.noiseStopTimer = null;
  }

  const now = state.audioOutContext.currentTime;
  state.noiseGainNode.gain.cancelScheduledValues(now);

  if (state.noiseActive) {
    if (state.noiseElement.paused) {
      state.noiseElement.play().catch(() => {
        // Browser can block autoplay until explicit user gesture.
      });
    }
    state.noiseGainNode.gain.setTargetAtTime(0.06, now, 0.02);
    return;
  }

  state.noiseGainNode.gain.setTargetAtTime(0, now, 0.03);
  state.noiseStopTimer = window.setTimeout(() => {
    if (!state.noiseActive && state.noiseElement && !state.noiseElement.paused) {
      state.noiseElement.pause();
    }
    state.noiseStopTimer = null;
  }, 220);
}

function updateNoiseState() {
  const shouldNoise = Boolean(state.speaker && state.self && state.speaker.id !== state.self.id);
  setNoiseActive(shouldNoise);
}

function tuneSender(sender) {
  try {
    const parameters = sender.getParameters();
    if (!parameters.encodings || !parameters.encodings.length) {
      parameters.encodings = [{}];
    }

    parameters.encodings[0].maxBitrate = 512000;
    sender.setParameters(parameters).catch(() => {
      // Browser may ignore sender parameters.
    });
  } catch {
    // Sender tuning is optional.
  }
}

function attachLocalTrack(peer) {
  if (!state.localTrack || !state.localStream) {
    return;
  }

  if (peer.sender && peer.sender.track === state.localTrack) {
    return;
  }

  try {
    peer.sender = peer.pc.addTrack(state.localTrack, state.localStream);
    tuneSender(peer.sender);
  } catch {
    // Ignore duplicate addTrack errors.
  }
}

function closePeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) {
    return;
  }

  try {
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
  } catch {
    // Ignore close errors.
  }

  if (peer.audio) {
    peer.audio.srcObject = null;
  }

  peers.delete(peerId);
}

function closeAllPeers() {
  for (const peerId of [...peers.keys()]) {
    closePeer(peerId);
  }
}

async function flushPendingCandidates(peer) {
  if (!peer.pc.remoteDescription || !peer.pc.remoteDescription.type) {
    return;
  }

  while (peer.pendingCandidates.length) {
    const candidate = peer.pendingCandidates.shift();
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch {
      // Ignore invalid candidates.
    }
  }
}

async function createAndSendOffer(peerId) {
  const peer = peers.get(peerId);
  if (!peer || !state.self) {
    return;
  }

  if (state.self.id >= peerId) {
    return;
  }

  if (peer.offered || peer.pc.signalingState !== 'stable') {
    return;
  }

  peer.offered = true;

  try {
    const offer = await peer.pc.createOffer({ offerToReceiveAudio: true });
    await peer.pc.setLocalDescription(offer);

    sendJson({
      type: 'signal_offer',
      to: peerId,
      sdp: peer.pc.localDescription
    });
  } catch {
    peer.offered = false;
  }
}

function ensurePeerConnection(peerId) {
  const existing = peers.get(peerId);
  if (existing) {
    attachLocalTrack(existing);
    return existing;
  }

  const pc = new RTCPeerConnection(rtcConfig);
  const audio = new Audio();

  audio.autoplay = true;
  audio.playsInline = true;

  const peer = {
    id: peerId,
    pc,
    audio,
    sender: null,
    pendingCandidates: [],
    offered: false
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }

    sendJson({
      type: 'signal_ice',
      to: peerId,
      candidate: event.candidate
    });
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (!stream) {
      return;
    }

    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
      audio.play().catch(() => {
        // Playback will start after next user interaction.
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      closePeer(peerId);
    }
  };

  attachLocalTrack(peer);
  peers.set(peerId, peer);

  if (state.self && state.self.id < peerId) {
    createAndSendOffer(peerId);
  }

  return peer;
}

function syncPeers() {
  if (!state.joined || !state.self) {
    return;
  }

  const required = new Set();
  for (const participant of state.participants) {
    if (participant.id === state.self.id) {
      continue;
    }
    required.add(participant.id);
    ensurePeerConnection(participant.id);
  }

  for (const peerId of [...peers.keys()]) {
    if (!required.has(peerId)) {
      closePeer(peerId);
    }
  }
}

async function handleSignalOffer(message) {
  if (!message.from || !message.sdp) {
    return;
  }

  const peer = ensurePeerConnection(message.from);

  try {
    await peer.pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
    await flushPendingCandidates(peer);

    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);

    sendJson({
      type: 'signal_answer',
      to: message.from,
      sdp: peer.pc.localDescription
    });
  } catch {
    addEvent('Ошибка обработки входящего WebRTC offer.');
  }
}

async function handleSignalAnswer(message) {
  if (!message.from || !message.sdp) {
    return;
  }

  const peer = ensurePeerConnection(message.from);

  try {
    await peer.pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
    await flushPendingCandidates(peer);
  } catch {
    addEvent('Ошибка обработки WebRTC answer.');
  }
}

async function handleSignalIce(message) {
  if (!message.from || !message.candidate) {
    return;
  }

  const peer = ensurePeerConnection(message.from);

  if (!peer.pc.remoteDescription || !peer.pc.remoteDescription.type) {
    peer.pendingCandidates.push(message.candidate);
    return;
  }

  try {
    await peer.pc.addIceCandidate(message.candidate);
  } catch {
    // Ignore invalid ICE candidate.
  }
}

async function ensureLocalMedia() {
  if (state.localTrack && state.localStream) {
    return;
  }

  if (!window.isSecureContext) {
    throw new Error(`Для микрофона нужен HTTPS (текущий адрес: ${window.location.origin}).`);
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Браузер не поддерживает доступ к микрофону.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      latency: { ideal: 0 }
    }
  });

  const [track] = stream.getAudioTracks();
  if (!track) {
    throw new Error('Не удалось получить аудио-трек микрофона.');
  }

  track.enabled = false;
  state.localStream = stream;
  state.localTrack = track;

  for (const peer of peers.values()) {
    attachLocalTrack(peer);
  }
}

function handleDisconnect(reason) {
  setLocalTrackEnabled(false);

  state.connected = false;
  state.joined = false;
  state.self = null;
  state.speaker = null;
  state.talkId = null;
  state.pttPressed = false;
  state.awaitingGrant = false;
  state.isTransmitting = false;
  state.participants = [];
  state.deniedSpeaker = null;
  state.ws = null;

  closeAllPeers();
  setNoiseActive(false);

  if (state.noiseStopTimer) {
    clearTimeout(state.noiseStopTimer);
    state.noiseStopTimer = null;
  }
  if (state.noiseElement) {
    state.noiseElement.pause();
  }

  setConnectionBadge('offline');
  dom.joinCard.classList.remove('hidden');
  dom.radioCard.classList.add('hidden');
  renderAll();

  addEvent(`Соединение закрыто: ${reason}`);
}

function handleControlMessage(message) {
  switch (message.type) {
    case 'hello_required':
      break;

    case 'welcome': {
      state.joined = true;
      state.self = message.participant || null;
      state.deniedSpeaker = null;
      dom.selfInfo.textContent = state.self
        ? `${state.self.role} - ${state.self.name}`
        : 'Неизвестный участник';
      dom.joinCard.classList.add('hidden');
      dom.radioCard.classList.remove('hidden');
      syncPeers();
      renderAll();
      addEvent('Подключение к учебной сессии выполнено.');
      break;
    }

    case 'state': {
      state.participants = Array.isArray(message.participants) ? message.participants : [];
      state.speaker = message.speaker || null;
      state.talkId = message.talkId || null;

      if (!state.speaker || !state.self || state.speaker.id !== state.self.id) {
        state.pttPressed = false;
        state.isTransmitting = false;
        state.awaitingGrant = false;
        setLocalTrackEnabled(false);
      }

      syncPeers();
      updateNoiseState();
      renderAll();
      break;
    }

    case 'speaker_update': {
      state.speaker = message.speaker || null;
      state.talkId = message.talkId || null;

      if (!state.speaker || !state.self || state.speaker.id !== state.self.id) {
        state.pttPressed = false;
        state.isTransmitting = false;
        state.awaitingGrant = false;
        setLocalTrackEnabled(false);
      }

      updateNoiseState();
      renderAll();
      break;
    }

    case 'ptt_granted': {
      if (!state.pttPressed) {
        state.awaitingGrant = false;
        state.isTransmitting = false;
        setLocalTrackEnabled(false);
        sendJson({ type: 'ptt_release' });
        renderAll();
        break;
      }

      state.awaitingGrant = false;
      state.deniedSpeaker = null;
      state.isTransmitting = true;
      setLocalTrackEnabled(true);
      renderAll();
      addEvent('Канал захвачен. Передача голоса активна.');
      break;
    }

    case 'ptt_denied': {
      state.pttPressed = false;
      state.awaitingGrant = false;
      state.isTransmitting = false;
      state.deniedSpeaker = message.speaker || null;
      setLocalTrackEnabled(false);
      renderAll();
      addEvent('Канал занят другим участником.');
      break;
    }

    case 'signal_offer': {
      handleSignalOffer(message);
      break;
    }

    case 'signal_answer': {
      handleSignalAnswer(message);
      break;
    }

    case 'signal_ice': {
      handleSignalIce(message);
      break;
    }

    case 'error': {
      addEvent(`Ошибка сервера: ${message.message || message.code || 'unknown'}`);
      break;
    }

    default:
      break;
  }
}

function openSocket({ wsUrl, name, role }) {
  if (state.ws) {
    try {
      state.ws.close();
    } catch {
      // Ignore close errors.
    }
  }

  setConnectionBadge('connecting');
  dom.joinBtn.disabled = true;

  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (error) {
    dom.joinBtn.disabled = false;
    setConnectionBadge('offline');
    addEvent(`Некорректный URL: ${error.message}`);
    return;
  }

  state.ws = ws;

  ws.addEventListener('open', () => {
    state.connected = true;
    setConnectionBadge('online');
    dom.joinBtn.disabled = false;

    sendJson({
      type: 'hello',
      name,
      role
    });

    addEvent('WebSocket соединение установлено.');
  });

  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      return;
    }

    try {
      const message = JSON.parse(event.data);
      handleControlMessage(message);
    } catch {
      addEvent('Получено некорректное текстовое сообщение.');
    }
  });

  ws.addEventListener('close', () => {
    dom.joinBtn.disabled = false;
    handleDisconnect('socket closed');
  });

  ws.addEventListener('error', () => {
    addEvent('Ошибка WebSocket. Проверьте адрес и доступность сервера.');
  });
}

async function requestTalk() {
  if (!state.connected || !state.joined || state.pttPressed) {
    return;
  }

  state.pttPressed = true;
  state.awaitingGrant = true;
  state.deniedSpeaker = null;
  renderPttUi();

  if (!state.localTrack) {
    try {
      await ensureLocalMedia();
    } catch (error) {
      state.pttPressed = false;
      state.awaitingGrant = false;
      addEvent(`Микрофон недоступен: ${error.message}`);
      renderPttUi();
      return;
    }
  }

  if (!state.pttPressed) {
    state.awaitingGrant = false;
    renderPttUi();
    return;
  }

  sendJson({ type: 'ptt_request' });
}

function releaseTalk() {
  if (!state.pttPressed && !state.isTransmitting && !state.awaitingGrant) {
    return;
  }

  state.pttPressed = false;
  state.awaitingGrant = false;
  state.isTransmitting = false;
  setLocalTrackEnabled(false);
  renderPttUi();

  sendJson({ type: 'ptt_release' });
}

dom.joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const wsUrl = dom.wsUrl.value.trim();
  const name = dom.name.value.trim();
  const role = dom.role.value;

  if (!wsUrl || !name || !role) {
    addEvent('Заполните все поля подключения.');
    return;
  }

  try {
    await ensurePlaybackContext();
  } catch {
    // Browser may block audio until the next explicit action.
  }

  try {
    await ensureLocalMedia();
  } catch (error) {
    addEvent(`Микрофон пока недоступен: ${error.message}`);
  }

  openSocket({ wsUrl, name, role });
});

dom.pttBtn.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  requestTalk();
});

dom.pttBtn.addEventListener('pointerup', (event) => {
  event.preventDefault();
  releaseTalk();
});

dom.pttBtn.addEventListener('pointercancel', (event) => {
  event.preventDefault();
  releaseTalk();
});

dom.pttBtn.addEventListener('pointerleave', (event) => {
  if (event.buttons === 1) {
    releaseTalk();
  }
});

window.addEventListener('blur', () => {
  releaseTalk();
});

document.addEventListener('keydown', (event) => {
  const target = event.target;
  const tag = target && target.tagName ? target.tagName.toUpperCase() : '';
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if (typing) {
    return;
  }

  if (event.code === 'Space' && !event.repeat) {
    event.preventDefault();
    requestTalk();
  }
});

document.addEventListener('keyup', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
    releaseTalk();
  }
});

renderAll();
setConnectionBadge('offline');
