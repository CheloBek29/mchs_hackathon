'use strict';

const dom = {
  joinCard: document.getElementById('joinCard'),
  radioCard: document.getElementById('radioCard'),
  joinForm: document.getElementById('joinForm'),
  joinBtn: document.getElementById('joinBtn'),
  wsUrl: document.getElementById('wsUrl'),
  initialChannel: document.getElementById('initialChannel'),
  name: document.getElementById('name'),
  role: document.getElementById('role'),
  selfInfo: document.getElementById('selfInfo'),
  connectionStatus: document.getElementById('connectionStatus'),
  speakerIndicator: document.getElementById('speakerIndicator'),
  activeChannel: document.getElementById('activeChannel'),
  jamBtn: document.getElementById('jamBtn'),
  pttBtn: document.getElementById('pttBtn'),
  pttHint: document.getElementById('pttHint'),
  participants: document.getElementById('participants'),
  events: document.getElementById('events')
};

const rtcConfig = {
  iceServers: [],
  iceCandidatePoolSize: 4
};

const peers = new Map();

const state = {
  ws: null,
  connected: false,
  joined: false,
  channel: '1',
  jammedChannels: new Set(),
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
  audioOutContext: null
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
    return `[ГОВОРИТ: НЕТ]`;
  }

  return `[ГОВОРИТ: ${state.speaker.role}] ${state.speaker.name}`;
}

function renderSpeaker() {
  dom.speakerIndicator.textContent = currentSpeakerText();
  dom.speakerIndicator.classList.toggle('live', Boolean(state.speaker));
}

function renderParticipants() {
  dom.participants.innerHTML = '';

  const channelParticipants = state.participants.filter(p => p.channel === state.channel);

  if (!channelParticipants.length) {
    const empty = document.createElement('li');
    empty.textContent = 'Нет подключенных участников в этом канале.';
    dom.participants.appendChild(empty);
    return;
  }

  for (const item of channelParticipants) {
    const li = document.createElement('li');
    li.classList.toggle('live', Boolean(item.speaking));

    const me = state.self && state.self.id === item.id ? ' (вы)' : '';
    const speaking = item.speaking ? ' [говорит]' : '';
    li.textContent = `${item.role} - ${item.name}${me}${speaking}`;
    dom.participants.appendChild(li);
  }
}

function renderPttUi() {
  dom.activeChannel.value = state.channel;
  const isJammed = state.jammedChannels.has(state.channel);
  dom.jamBtn.classList.toggle('jamming', isJammed);
  dom.jamBtn.textContent = isJammed ? 'Восстановить частоту' : 'Глушить канал (Jam)';

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

  if (isJammed) {
    dom.pttHint.textContent = 'Канал зашумлен! Вас никто не услышит.';
  }

  if (!state.localTrack) {
    dom.pttBtn.textContent = 'МИКРОФОН НЕ ДОСТУПЕН';
    dom.pttHint.textContent = 'Разрешите доступ к микрофону, чтобы передавать голос.';
    return;
  }

  if (state.isTransmitting) {
    dom.pttBtn.textContent = 'ИДЕТ ПЕРЕДАЧА - ОТПУСТИТЕ ДЛЯ ЗАВЕРШЕНИЯ';
    if (!isJammed) dom.pttHint.textContent = 'Канал занят вами. Голос передается в реальном времени.';
    return;
  }

  if (state.awaitingGrant) {
    dom.pttBtn.textContent = 'ОЖИДАНИЕ ЗАХВАТА КАНАЛА...';
    dom.pttHint.textContent = 'Сервер проверяет доступность канала.';
    return;
  }

  if (state.deniedSpeaker) {
    dom.pttHint.textContent = `Канал занят: ${state.deniedSpeaker.role} ${state.deniedSpeaker.name}`;
  } else if (!isJammed) {
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

    try {
      await state.audioOutContext.audioWorklet.addModule('/dsp-worklet.js');
    } catch (err) {
      console.error('Failed to load dsp-worklet', err);
    }
  }

  if (state.audioOutContext.state === 'suspended') {
    await state.audioOutContext.resume();
  }
}

function makeDistortionCurve(amount = 50) {
  const k = typeof amount === 'number' ? amount : 50;
  const n_samples = 44100;
  const curve = new Float32Array(n_samples);
  for (let i = 0; i < n_samples; ++i) {
    const x = (i * 2) / n_samples - 1;
    curve[i] = Math.tanh(x * (k / 10)); // simple soft clipping
  }
  return curve;
}

function setupPeerDSP(peer, stream) {
  const actx = state.audioOutContext;
  if (!actx || peer.dspSetup) return;

  const source = actx.createMediaStreamSource(stream);

  // Highpass 300Hz
  const hp = actx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 300;
  hp.Q.value = 0.7;

  // Lowpass 3000Hz (creates the Bandpass together with HP)
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3000;
  lp.Q.value = 0.7;

  // Pre-gain for overdrive
  const driveGain = actx.createGain();
  driveGain.gain.value = 5.0;

  // Soft-clipping Distortion
  const waveShaper = actx.createWaveShaper();
  waveShaper.curve = makeDistortionCurve();

  // Custom Walkie-Talkie DSP Worklet (Noise, envelope, fading)
  const dspNode = new AudioWorkletNode(actx, 'radio-dsp-worklet');

  // Output gain node to route/mute audio for simplex logic
  const outGain = actx.createGain();
  outGain.gain.value = 0; // muted by default until speaking

  // Connect pipeline
  source.connect(hp);
  hp.connect(lp);
  lp.connect(driveGain);
  driveGain.connect(waveShaper);
  waveShaper.connect(dspNode);
  dspNode.connect(outGain);
  outGain.connect(actx.destination);

  peer.dspSetup = true;
  peer.outGain = outGain;
  peer.dspNode = dspNode;
  peer.wasSpeaking = false;

  // Need to force an immediate DSP state update because the peer might already
  // be the active speaker before their WebRTC track actually arrived.
  updateDSPState();
}

function updateDSPState() {
  const speakerId = state.speaker ? state.speaker.id : null;
  const selfId = state.self ? state.self.id : null;
  const now = state.audioOutContext ? state.audioOutContext.currentTime : 0;
  const isJammed = state.jammedChannels.has(state.channel);

  for (const [peerId, peer] of peers) {
    if (!peer.outGain || !state.audioOutContext) continue;

    if (peer.dspNode) {
      const param = peer.dspNode.parameters.get('jammed');
      if (param) param.setValueAtTime(isJammed ? 1.0 : 0.0, now);
    }

    const isSpeaking = (speakerId === peerId);
    const isSelf = (peerId === selfId);

    if (isSpeaking && !isSelf) {
      // Someone else is speaking: unmute them quickly
      peer.outGain.gain.cancelScheduledValues(now);
      peer.outGain.gain.setTargetAtTime(1.0, now, 0.05);
      peer.wasSpeaking = true;
    } else {
      // Not speaking or it's us: mute them
      if (peer.wasSpeaking && !isSpeaking) {
        // Just stopped speaking -> Trigger the tssshk squelch tail!
        if (peer.dspNode) {
          peer.dspNode.port.postMessage({ type: 'trigger_tail' });
        }
        // Allow the tail to play out by muting slightly slower (tail is ~150ms)
        peer.outGain.gain.cancelScheduledValues(now);
        peer.outGain.gain.setTargetAtTime(0, now + 0.16, 0.05);
        peer.wasSpeaking = false;
      } else if (!peer.wasSpeaking) {
        // Was already quiet
        peer.outGain.gain.cancelScheduledValues(now);
        peer.outGain.gain.setValueAtTime(0, now);
      }
    }
  }
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

  pc.ontrack = async (event) => {
    const [stream] = event.streams;
    if (!stream) {
      return;
    }

    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
      audio.muted = true; // Use Web Audio API for output
      audio.play().catch(() => { });

      try {
        await ensurePlaybackContext();
        setupPeerDSP(peer, stream);
      } catch (err) {
        console.error('Failed to setup DSP', err);
      }
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
    if (participant.channel === state.channel) {
      required.add(participant.id);
      ensurePeerConnection(participant.id);
    }
  }

  for (const peerId of [...peers.keys()]) {
    if (!required.has(peerId)) {
      const peer = peers.get(peerId);
      if (peer && peer.outGain && state.audioOutContext) {
        // Instantly mute before tearing down the connection to prevent residual noise
        peer.outGain.gain.cancelScheduledValues(state.audioOutContext.currentTime);
        peer.outGain.gain.setValueAtTime(0, state.audioOutContext.currentTime);
      }
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
  state.jammedChannels.clear();
  state.deniedSpeaker = null;
  state.ws = null;

  closeAllPeers();

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
      const speakerInfo = message.speakers ? message.speakers[state.channel] : null;
      state.speaker = speakerInfo ? speakerInfo.speaker : null;
      state.talkId = speakerInfo ? speakerInfo.talkId : null;
      state.jammedChannels = new Set(message.jammedChannels || []);

      if (!state.speaker || !state.self || state.speaker.id !== state.self.id) {
        state.pttPressed = false;
        state.isTransmitting = false;
        state.awaitingGrant = false;
        setLocalTrackEnabled(false);
      }

      syncPeers();
      updateDSPState();
      renderAll();
      break;
    }

    case 'speaker_update': {
      if (message.channel === state.channel) {
        state.speaker = message.speaker || null;
        state.talkId = message.talkId || null;

        if (!state.speaker || !state.self || state.speaker.id !== state.self.id) {
          state.pttPressed = false;
          state.isTransmitting = false;
          state.awaitingGrant = false;
          setLocalTrackEnabled(false);
        }
      }

      updateDSPState();
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

function openSocket({ wsUrl, name, role, channel }) {
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
      role,
      channel
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
  const channel = dom.initialChannel.value;

  if (!wsUrl || !name || !role || !channel) {
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

  state.channel = channel;
  openSocket({ wsUrl, name, role, channel });
});

dom.activeChannel.addEventListener('change', (event) => {
  const newChannel = event.target.value;
  if (state.channel === newChannel) return;

  state.channel = newChannel;
  sendJson({ type: 'change_channel', channel: newChannel });

  syncPeers();
  updateDSPState();
  renderAll();
  addEvent(`Переход на частоту ${newChannel}.`);
});

dom.jamBtn.addEventListener('click', () => {
  const isJammed = state.jammedChannels.has(state.channel);
  if (isJammed) {
    sendJson({ type: 'unjam_channel', channel: state.channel });
    addEvent(`Отключено глушение на частоте ${state.channel}.`);
  } else {
    sendJson({ type: 'jam_channel', channel: state.channel });
    addEvent(`Включено глушение на частоте ${state.channel}!`);
  }
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
