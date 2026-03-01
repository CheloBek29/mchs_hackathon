import { useEffect, useRef, useState } from 'react';
import { PixelButton } from '../../../shared/ui/PixelButton';
import { useAuthStore } from '../../../store/useAuthStore';

const resolveDefaultRadioWsUrl = (): string => {
  if (typeof window === 'undefined') {
    return 'ws://localhost:8080/ws';
  }
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.hostname}:8080/ws`;
};

// Radio server WebSocket URL – override with VITE_RADIO_WS_URL env variable
const RADIO_WS_URL = (import.meta.env.VITE_RADIO_WS_URL as string | undefined) ?? resolveDefaultRadioWsUrl();

type RadioChannel = '1' | '2' | '3' | '4';

const CHANNEL_OPTIONS: Array<{ value: RadioChannel; label: string }> = [
  { value: '1', label: 'Частота 1' },
  { value: '2', label: 'Частота 2' },
  { value: '3', label: 'Частота 3' },
  { value: '4', label: 'Частота 4' },
];

type RadioConsoleProps = {
  activeRole?: string;
};

interface PeerEntry {
  id: string;
  pc: RTCPeerConnection;
  sender: RTCRtpSender | null;
  pendingCandidates: RTCIceCandidate[];
  offered: boolean;
  dspSetup: boolean;
  outGain: GainNode | null;
  dspNode: AudioWorkletNode | null;
  wasSpeaking: boolean;
}

interface ServerParticipant {
  id: string;
  name: string;
  role: string;
  channel: string;
  speaking: boolean;
}

interface ServerSpeakerInfo {
  speaker: ServerParticipant;
  talkId: number;
}

const resolveDefaultChannelForRole = (role?: string): RadioChannel => {
  const normalized = (role || '').trim().toUpperCase();
  if (normalized === 'ДИСПЕТЧЕР' || normalized === 'РТП' || normalized === 'ШТАБ') {
    return '2';
  }
  if (normalized === 'БУ - 1' || normalized === 'БУ-1') {
    return '3';
  }
  if (normalized === 'БУ - 2' || normalized === 'БУ-2') {
    return '4';
  }
  return '1';
};

const RTC_CONFIG: RTCConfiguration = { iceServers: [], iceCandidatePoolSize: 4 };

function makeDistortionCurve(amount = 50): Float32Array<ArrayBuffer> {
  const k = amount;
  const nSamples = 44100;
  const curve = new Float32Array(new ArrayBuffer(nSamples * Float32Array.BYTES_PER_ELEMENT));
  for (let i = 0; i < nSamples; i++) {
    const x = (i * 2) / nSamples - 1;
    curve[i] = Math.tanh(x * (k / 10));
  }
  return curve;
}

export const RadioConsole = ({ activeRole }: RadioConsoleProps) => {
  const user = useAuthStore((state) => state.user);

  // --- Mutable WebRTC/WS state (refs – no re-renders) ---
  const wsRef = useRef<WebSocket | null>(null);
  const selfIdRef = useRef<string | null>(null);
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const localTrackRef = useRef<MediaStreamTrack | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletReadyRef = useRef<boolean>(false);
  const channelRef = useRef<RadioChannel>(resolveDefaultChannelForRole(activeRole));
  const roomRef = useRef<string>('default');
  const pttPressedRef = useRef<boolean>(false);
  const awaitingGrantRef = useRef<boolean>(false);
  const speakerRef = useRef<ServerParticipant | null>(null);
  const jammedChannelsRef = useRef<Set<string>>(new Set());
  const isMutedRef = useRef<boolean>(false);
  const joinedRef = useRef<boolean>(false);
  const participantsRef = useRef<ServerParticipant[]>([]);

  // --- React UI state ---
  const [selectedChannel, setSelectedChannelState] = useState<RadioChannel>(() => resolveDefaultChannelForRole(activeRole));
  const [isConnected, setIsConnected] = useState(false);
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [speaker, setSpeaker] = useState<ServerParticipant | null>(null);
  const [error, setError] = useState('');

  // Keyboard PTT refs (updated each render to avoid stale closures)
  const beginPttFnRef = useRef<() => void>(() => {});
  const endPttFnRef = useRef<() => void>(() => {});
  const pttPointerIdRef = useRef<number | null>(null);

  // Stable internal function refs (updated each render)
  const syncPeersFnRef = useRef<() => void>(() => {});
  const updateDSPStateFnRef = useRef<() => void>(() => {});
  const handleMessageFnRef = useRef<(msg: Record<string, unknown>) => void>(() => {});

  // --- Low-level helpers ---

  const sendWs = (payload: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  const setLocalTrackEnabled = (enabled: boolean) => {
    if (localTrackRef.current) {
      localTrackRef.current.enabled = enabled;
    }
  };

  const ensureAudioCtx = async (): Promise<void> => {
    if (!audioCtxRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Ctx = (window.AudioContext ?? (window as any).webkitAudioContext) as typeof AudioContext;
      audioCtxRef.current = new Ctx({ latencyHint: 'interactive' });
      try {
        await audioCtxRef.current.audioWorklet.addModule('/dsp-worklet.js');
        workletReadyRef.current = true;
      } catch (err) {
        console.error('[Radio] Failed to load dsp-worklet:', err);
      }
    }
    if (audioCtxRef.current.state === 'suspended') {
      await audioCtxRef.current.resume();
    }
  };

  // --- DSP ---

  const updateDSPState = () => {
    const speakerId = speakerRef.current?.id ?? null;
    const selfId = selfIdRef.current;
    const actx = audioCtxRef.current;
    const now = actx ? actx.currentTime : 0;
    const isJammed = jammedChannelsRef.current.has(channelRef.current);

    for (const [peerId, peer] of peersRef.current) {
      if (!peer.outGain || !actx) continue;

      if (peer.dspNode) {
        const param = peer.dspNode.parameters.get('jammed');
        if (param) param.setValueAtTime(isJammed ? 1.0 : 0.0, now);
      }

      if (isMutedRef.current) {
        peer.outGain.gain.cancelScheduledValues(now);
        peer.outGain.gain.setValueAtTime(0, now);
        peer.wasSpeaking = false;
        continue;
      }

      const isSpeaking = speakerId === peerId;
      const isSelf = peerId === selfId;

      if (isSpeaking && !isSelf) {
        peer.outGain.gain.cancelScheduledValues(now);
        peer.outGain.gain.setTargetAtTime(1.0, now, 0.05);
        peer.wasSpeaking = true;
      } else {
        if (peer.wasSpeaking && !isSpeaking) {
          if (peer.dspNode) {
            peer.dspNode.port.postMessage({ type: 'trigger_tail' });
          }
          peer.outGain.gain.cancelScheduledValues(now);
          peer.outGain.gain.setTargetAtTime(0, now + 0.16, 0.05);
          peer.wasSpeaking = false;
        } else if (!peer.wasSpeaking) {
          peer.outGain.gain.cancelScheduledValues(now);
          peer.outGain.gain.setValueAtTime(0, now);
        }
      }
    }
  };

  const setupPeerDSP = (peer: PeerEntry, stream: MediaStream) => {
    const actx = audioCtxRef.current;
    if (!actx || peer.dspSetup) return;

    const source = actx.createMediaStreamSource(stream);

    const hp = actx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    hp.Q.value = 0.7;

    const lp = actx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3000;
    lp.Q.value = 0.7;

    const driveGain = actx.createGain();
    driveGain.gain.value = 5.0;

    const waveShaper = actx.createWaveShaper();
    waveShaper.curve = makeDistortionCurve();

    const outGain = actx.createGain();
    outGain.gain.value = 0; // muted by default

    source.connect(hp);
    hp.connect(lp);
    lp.connect(driveGain);
    driveGain.connect(waveShaper);

    if (workletReadyRef.current) {
      const dspNode = new AudioWorkletNode(actx, 'radio-dsp-worklet');
      waveShaper.connect(dspNode);
      dspNode.connect(outGain);
      peer.dspNode = dspNode;
    } else {
      waveShaper.connect(outGain);
    }

    outGain.connect(actx.destination);
    peer.outGain = outGain;
    peer.dspSetup = true;
    peer.wasSpeaking = false;

    updateDSPStateFnRef.current();
  };

  // --- WebRTC peer management ---

  const attachLocalTrack = (peer: PeerEntry) => {
    const track = localTrackRef.current;
    const stream = localStreamRef.current;
    if (!track || !stream) return;
    if (peer.sender && peer.sender.track === track) return;
    try {
      peer.sender = peer.pc.addTrack(track, stream);
      const params = peer.sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 512_000;
      peer.sender.setParameters(params).catch(() => undefined);
    } catch {
      // ignore duplicate addTrack
    }
  };

  const closePeer = (peerId: string) => {
    const peer = peersRef.current.get(peerId);
    if (!peer) return;
    try {
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.close();
    } catch {
      // no-op: peer may already be closed
    }
    peersRef.current.delete(peerId);
  };

  const flushPendingCandidates = async (peer: PeerEntry) => {
    if (!peer.pc.remoteDescription?.type) return;
    while (peer.pendingCandidates.length) {
      const c = peer.pendingCandidates.shift()!;
      try {
        await peer.pc.addIceCandidate(c);
      } catch {
        // no-op: stale ICE candidate
      }
    }
  };

  const createAndSendOffer = async (peerId: string) => {
    const peer = peersRef.current.get(peerId);
    const selfId = selfIdRef.current;
    if (!peer || !selfId) return;
    if (selfId >= peerId) return; // only the lower UUID string initiates
    if (peer.offered || peer.pc.signalingState !== 'stable') return;
    peer.offered = true;
    try {
      const offer = await peer.pc.createOffer({ offerToReceiveAudio: true });
      await peer.pc.setLocalDescription(offer);
      sendWs({ type: 'signal_offer', to: peerId, sdp: peer.pc.localDescription });
    } catch {
      peer.offered = false;
    }
  };

  const ensurePeerConnection = (peerId: string): PeerEntry => {
    const existing = peersRef.current.get(peerId);
    if (existing) {
      attachLocalTrack(existing);
      return existing;
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peer: PeerEntry = {
      id: peerId,
      pc,
      sender: null,
      pendingCandidates: [],
      offered: false,
      dspSetup: false,
      outGain: null,
      dspNode: null,
      wasSpeaking: false,
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      sendWs({ type: 'signal_ice', to: peerId, candidate: event.candidate });
    };

    pc.ontrack = async (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      try {
        await ensureAudioCtx();
        setupPeerDSP(peer, stream);
      } catch (err) {
        console.error('[Radio] Failed to setup DSP:', err);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        closePeer(peerId);
      }
    };

    attachLocalTrack(peer);
    peersRef.current.set(peerId, peer);

    if (selfIdRef.current && selfIdRef.current < peerId) {
      void createAndSendOffer(peerId);
    }

    return peer;
  };

  const syncPeers = () => {
    if (!joinedRef.current || !selfIdRef.current) return;

    const required = new Set<string>();
    for (const p of participantsRef.current) {
      if (p.id === selfIdRef.current) continue;
      if (p.channel === channelRef.current) {
        required.add(p.id);
        ensurePeerConnection(p.id);
      }
    }

    for (const peerId of [...peersRef.current.keys()]) {
      if (!required.has(peerId)) {
        const peer = peersRef.current.get(peerId);
        const actx = audioCtxRef.current;
        if (peer?.outGain && actx) {
          peer.outGain.gain.cancelScheduledValues(actx.currentTime);
          peer.outGain.gain.setValueAtTime(0, actx.currentTime);
        }
        closePeer(peerId);
      }
    }
  };

  // --- Control message handler ---

  const handleControlMessage = (message: Record<string, unknown>) => {
    const type = message.type as string;

    switch (type) {
      case 'hello_required':
        break;

      case 'welcome': {
        const participant = message.participant as { id: string } | undefined;
        if (participant?.id) selfIdRef.current = participant.id;
        joinedRef.current = true;
        setIsConnected(true);
        setError('');
        syncPeersFnRef.current();
        break;
      }

      case 'state': {
        participantsRef.current = Array.isArray(message.participants)
          ? (message.participants as ServerParticipant[])
          : [];
        const speakersMap = message.speakers as Record<string, ServerSpeakerInfo> | undefined;
        const speakerInfo = speakersMap?.[channelRef.current];
        speakerRef.current = speakerInfo?.speaker ?? null;
        setSpeaker(speakerRef.current);

        jammedChannelsRef.current = new Set(
          Array.isArray(message.jammedChannels) ? (message.jammedChannels as string[]) : [],
        );

        if (!speakerRef.current || speakerRef.current.id !== selfIdRef.current) {
          pttPressedRef.current = false;
          awaitingGrantRef.current = false;
          setIsTransmitting(false);
          setLocalTrackEnabled(false);
        }

        syncPeersFnRef.current();
        updateDSPStateFnRef.current();
        break;
      }

      case 'speaker_update': {
        if (message.channel === channelRef.current) {
          const spk = (message.speaker as ServerParticipant | null) ?? null;
          speakerRef.current = spk;
          setSpeaker(spk);

          if (!spk || spk.id !== selfIdRef.current) {
            pttPressedRef.current = false;
            awaitingGrantRef.current = false;
            setIsTransmitting(false);
            setLocalTrackEnabled(false);
          }
        }
        updateDSPStateFnRef.current();
        break;
      }

      case 'ptt_granted': {
        if (!pttPressedRef.current) {
          awaitingGrantRef.current = false;
          setIsTransmitting(false);
          setLocalTrackEnabled(false);
          sendWs({ type: 'ptt_release' });
          break;
        }
        awaitingGrantRef.current = false;
        setIsTransmitting(true);
        setLocalTrackEnabled(true);
        break;
      }

      case 'ptt_denied': {
        pttPressedRef.current = false;
        awaitingGrantRef.current = false;
        setIsTransmitting(false);
        setLocalTrackEnabled(false);
        break;
      }

      case 'signal_offer': {
        void (async () => {
          const from = message.from as string | undefined;
          const sdp = message.sdp as RTCSessionDescriptionInit | undefined;
          if (!from || !sdp) return;
          const peer = ensurePeerConnection(from);
          try {
            await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
            await flushPendingCandidates(peer);
            const answer = await peer.pc.createAnswer();
            await peer.pc.setLocalDescription(answer);
            sendWs({ type: 'signal_answer', to: from, sdp: peer.pc.localDescription });
          } catch {
            // no-op: offer/answer race on reconnect
          }
        })();
        break;
      }

      case 'signal_answer': {
        void (async () => {
          const from = message.from as string | undefined;
          const sdp = message.sdp as RTCSessionDescriptionInit | undefined;
          if (!from || !sdp) return;
          const peer = ensurePeerConnection(from);
          try {
            await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
            await flushPendingCandidates(peer);
          } catch {
            // no-op: answer can arrive after peer reset
          }
        })();
        break;
      }

      case 'signal_ice': {
        void (async () => {
          const from = message.from as string | undefined;
          const candidate = message.candidate;
          if (!from || !candidate) return;
          const peer = ensurePeerConnection(from);
          if (!peer.pc.remoteDescription?.type) {
            peer.pendingCandidates.push(candidate as RTCIceCandidate);
            return;
          }
          try {
            await peer.pc.addIceCandidate(candidate as RTCIceCandidate);
          } catch {
            // no-op: invalid/stale candidate
          }
        })();
        break;
      }

      default:
        break;
    }
  };

  // Update stable refs each render
  syncPeersFnRef.current = syncPeers;
  updateDSPStateFnRef.current = updateDSPState;
  handleMessageFnRef.current = handleControlMessage;

  // --- Media acquisition ---

  const ensureLocalMedia = async () => {
    if (localTrackRef.current && localStreamRef.current) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const [track] = stream.getAudioTracks();
    if (!track) throw new Error('Не удалось получить трек микрофона');

    track.enabled = false; // muted until PTT is granted
    localStreamRef.current = stream;
    localTrackRef.current = track;

    for (const peer of peersRef.current.values()) {
      attachLocalTrack(peer);
    }
  };

  // --- PTT logic ---

  const requestTalk = async () => {
    if (!joinedRef.current || pttPressedRef.current) return;

    pttPressedRef.current = true;
    awaitingGrantRef.current = true;

    try {
      await ensureAudioCtx();
    } catch {
      // no-op: microphone request can still proceed
    }

    if (!localTrackRef.current) {
      try {
        await ensureLocalMedia();
      } catch (err) {
        pttPressedRef.current = false;
        awaitingGrantRef.current = false;
        setError(err instanceof Error ? err.message : 'Нет доступа к микрофону');
        return;
      }
    }

    if (!pttPressedRef.current) {
      awaitingGrantRef.current = false;
      return;
    }

    sendWs({ type: 'ptt_request' });
  };

  const releaseTalk = () => {
    if (!pttPressedRef.current && !awaitingGrantRef.current) return;
    pttPressedRef.current = false;
    awaitingGrantRef.current = false;
    setIsTransmitting(false);
    setLocalTrackEnabled(false);
    sendWs({ type: 'ptt_release' });
  };

  const beginPtt = () => { void requestTalk(); };
  const endPtt = () => { releaseTalk(); };

  // Update keyboard refs each render
  beginPttFnRef.current = beginPtt;
  endPttFnRef.current = endPtt;

  // --- Channel change ---

  const changeChannel = (newChannel: RadioChannel) => {
    if (channelRef.current === newChannel) return;
    channelRef.current = newChannel;
    setSelectedChannelState(newChannel);
    sendWs({ type: 'change_channel', channel: newChannel });
    speakerRef.current = null;
    setSpeaker(null);
    syncPeersFnRef.current();
    updateDSPStateFnRef.current();
  };

  useEffect(() => {
    const mappedChannel = resolveDefaultChannelForRole(activeRole);
    if (channelRef.current === mappedChannel) {
      return;
    }
    changeChannel(mappedChannel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRole]);

  // --- WebSocket connection effect ---

  useEffect(() => {
    if (!user?.id) return;
    roomRef.current = (user.session_id || 'default').trim() || 'default';

    let ws: WebSocket;
    try {
      ws = new WebSocket(RADIO_WS_URL);
    } catch {
      setError('Не удалось подключиться к серверу рации');
      return;
    }

    wsRef.current = ws;

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        name: user.username,
        role: activeRole ?? 'БЕЗ РОЛИ',
        channel: channelRef.current,
        room: roomRef.current,
      }));
    });

    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const msg = JSON.parse(event.data) as Record<string, unknown>;
        handleMessageFnRef.current(msg);
      } catch {
        // ignore malformed non-JSON WS payload
      }
    });

    ws.addEventListener('close', () => {
      joinedRef.current = false;
      selfIdRef.current = null;
      speakerRef.current = null;
      pttPressedRef.current = false;
      awaitingGrantRef.current = false;
      setIsConnected(false);
      setIsTransmitting(false);
      setSpeaker(null);
      const peerIds = [...peersRef.current.keys()];
      for (const peerId of peerIds) closePeer(peerId);
    });

    ws.addEventListener('error', () => {
      setError('Ошибка соединения с сервером рации');
    });

    return () => {
      releaseTalk();
      wsRef.current = null;
      joinedRef.current = false;
      selfIdRef.current = null;
      const peerIds = [...peersRef.current.keys()];
      for (const peerId of peerIds) closePeer(peerId);
      setIsConnected(false);
      setIsTransmitting(false);
      try {
        ws.close();
      } catch {
        // no-op
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?.session_id, activeRole]);

  // --- Keyboard T ---

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.key !== 't' && event.key !== 'T') return;
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
      event.preventDefault();
      beginPttFnRef.current();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 't' && event.key !== 'T') return;
      endPttFnRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // --- Force PTT release on blur / visibility change ---

  useEffect(() => {
    const forceStop = () => {
      if (pttPressedRef.current || awaitingGrantRef.current) releaseTalk();
    };
    const onVisibility = () => { if (document.visibilityState !== 'visible') forceStop(); };
    window.addEventListener('blur', forceStop);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', forceStop);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Mute → DSP ---

  useEffect(() => {
    isMutedRef.current = isMuted;
    updateDSPStateFnRef.current();
  }, [isMuted]);

  // --- Cleanup on unmount ---

  useEffect(() => {
    return () => {
      localTrackRef.current?.stop();
      localTrackRef.current = null;
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
    };
  }, []);

  // --- UI ---

  const isJammed = jammedChannelsRef.current.has(selectedChannel);
  const speakerIsOther = speaker && speaker.id !== selfIdRef.current;

  return (
    <div className="bg-[#1a1a1a] border-2 border-black p-2 text-[7px] uppercase">
      <div className="flex flex-wrap items-center gap-1">
        <div className="text-[8px] text-white pr-1">Рация {activeRole ? `| ${activeRole}` : ''}</div>

        <select
          value={selectedChannel}
          onChange={(e) => changeChannel(e.target.value as RadioChannel)}
          className="h-6 min-w-[92px] bg-[#3d3d3d] border-2 border-black px-2 text-[7px] text-white outline-none"
        >
          {CHANNEL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>

        <PixelButton
          size="sm"
          className="text-[6px] px-2"
          onClick={() => setIsMuted((prev) => !prev)}
        >
          {isMuted ? 'ЗВУК ВКЛ' : 'MUTE'}
        </PixelButton>

        <PixelButton
          size="sm"
          variant={isTransmitting ? 'active' : 'green'}
          className="text-[6px] px-2"
          disabled={!isConnected}
          onPointerDown={(e) => {
            pttPointerIdRef.current = e.pointerId;
            beginPtt();
          }}
          onPointerUp={(e) => {
            if (pttPointerIdRef.current === null || pttPointerIdRef.current === e.pointerId) {
              endPtt();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); beginPtt(); }
          }}
          onKeyUp={(e) => {
            if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); endPtt(); }
          }}
        >
          {isTransmitting ? 'ЭФИР' : 'ЗАЖМИ И ГОВОРИ'}
        </PixelButton>

        <div className={`px-1 ${isMuted ? 'text-amber-300' : isJammed ? 'text-red-400' : isTransmitting ? 'text-emerald-300' : 'text-cyan-300'}`}>
          {isMuted ? 'MUTE' : isJammed ? 'JAM' : isTransmitting ? 'TX' : 'RX'}
        </div>

        {speakerIsOther && (
          <div className="text-amber-300 px-1 text-[6px] normal-case">
            [{speaker!.role}] {speaker!.name}
          </div>
        )}
      </div>

      {!isConnected && user?.id && (
        <div className="text-[6px] text-zinc-400 mt-1">Подключение к серверу рации...</div>
      )}

      {isJammed && (
        <div className="text-[6px] text-red-400 mt-1">Канал зашумлён</div>
      )}

      {error ? <div className="text-[6px] text-red-300 mt-1 normal-case">{error}</div> : null}
    </div>
  );
};
