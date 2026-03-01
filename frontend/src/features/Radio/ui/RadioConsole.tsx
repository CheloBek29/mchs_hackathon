import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PixelButton } from '../../../shared/ui/PixelButton';
import { useAuthStore } from '../../../store/useAuthStore';
import { useRealtimeStore } from '../../../store/useRealtimeStore';

type RadioChannel = '1' | '2' | '3' | '4';

type RadioLogEntry = {
  id: string;
  kind: string;
  channel: RadioChannel;
  created_at: string;
  sender_user_id: string;
  sender_username: string;
  sender_role: string;
  audio_b64: string;
  mime_type: string;
  duration_ms: number;
  is_live_chunk: boolean;
  chunk_index: number | null;
  transmission_id: string;
};

type RadioConsoleProps = {
  activeRole?: string;
};

const CHANNEL_OPTIONS: Array<{ value: RadioChannel; label: string }> = [
  { value: '1', label: 'Частота 1' },
  { value: '2', label: 'Частота 2' },
  { value: '3', label: 'Частота 3' },
  { value: '4', label: 'Частота 4' },
];

const MAX_AUDIO_BASE64_LENGTH = 1_200_000;
const RADIO_SEGMENT_MS = 700;

const parseChannel = (value: unknown): RadioChannel => {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';

  if (normalized === '2' || normalized === 'RTP_HQ' || normalized === 'DISPATCH') {
    return '2';
  }
  if (normalized === '3' || normalized === 'RTP_BU1') {
    return '3';
  }
  if (normalized === '4' || normalized === 'RTP_BU2') {
    return '4';
  }
  return '1';
};

const parseFiniteNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const parseOptionalNonNegativeInt = (value: unknown): number | null => {
  const numberValue = parseFiniteNumber(value, Number.NaN);
  if (!Number.isFinite(numberValue)) {
    return null;
  }
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    return null;
  }
  return numberValue;
};

const parseRadioLogs = (value: unknown): RadioLogEntry[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const raw = entry as Record<string, unknown>;
      const id = typeof raw.id === 'string' ? raw.id : '';
      if (!id) {
        return null;
      }

      return {
        id,
        kind: typeof raw.kind === 'string' ? raw.kind : 'MESSAGE',
        channel: parseChannel(raw.channel),
        created_at: typeof raw.created_at === 'string' ? raw.created_at : new Date().toISOString(),
        sender_user_id: typeof raw.sender_user_id === 'string' ? raw.sender_user_id : '',
        sender_username: typeof raw.sender_username === 'string' ? raw.sender_username : 'unknown',
        sender_role: typeof raw.sender_role === 'string' ? raw.sender_role : 'UNKNOWN',
        audio_b64: typeof raw.audio_b64 === 'string' ? raw.audio_b64 : '',
        mime_type: typeof raw.mime_type === 'string' ? raw.mime_type : 'audio/webm',
        duration_ms: Math.max(0, Math.round(parseFiniteNumber(raw.duration_ms, 0))),
        is_live_chunk: raw.is_live_chunk === true,
        chunk_index: parseOptionalNonNegativeInt(raw.chunk_index),
        transmission_id: typeof raw.transmission_id === 'string' ? raw.transmission_id : '',
      } satisfies RadioLogEntry;
    })
    .filter((entry): entry is RadioLogEntry => entry !== null)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
};

const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать аудиофайл'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Некорректный формат аудио'));
        return;
      }
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
};

const generateTransmissionId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tx_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
};

export const RadioConsole = ({ activeRole }: RadioConsoleProps) => {
  const user = useAuthStore((state) => state.user);
  const realtimeBundle = useRealtimeStore((state) => state.bundle);
  const realtimeSessionId = useRealtimeStore((state) => state.sessionId);
  const sendRealtimeCommand = useRealtimeStore((state) => state.sendCommand);

  const [selectedChannel, setSelectedChannel] = useState<RadioChannel>('1');
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordStartRef = useRef<number>(0);
  const recordTimerRef = useRef<number | null>(null);
  const chunkIndexRef = useRef<number>(0);
  const transmissionIdRef = useRef<string>('');
  const transmissionChannelRef = useRef<RadioChannel>('1');
  const sendQueueRef = useRef<Promise<void>>(Promise.resolve());

  const mutedRef = useRef<boolean>(isMuted);
  const playbackPrimedRef = useRef<boolean>(false);
  const playedLogIdsRef = useRef<Set<string>>(new Set());
  const previousChannelRef = useRef<RadioChannel>('1');
  const playbackQueueRef = useRef<RadioLogEntry[]>([]);
  const playbackActiveRef = useRef<boolean>(false);
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const playbackStartBoundaryMsRef = useRef<number>(Date.now());
  const pttActiveRef = useRef<boolean>(false);
  const pttPointerIdRef = useRef<number | null>(null);

  const sessionId = user?.session_id ?? null;

  const bundle = useMemo(() => {
    if (!sessionId || !realtimeBundle || realtimeSessionId !== sessionId) {
      return null;
    }
    return realtimeBundle;
  }, [realtimeBundle, realtimeSessionId, sessionId]);

  const snapshotData = useMemo(() => {
    if (bundle?.snapshot?.snapshot_data && typeof bundle.snapshot.snapshot_data === 'object') {
      return bundle.snapshot.snapshot_data as Record<string, unknown>;
    }
    return null;
  }, [bundle?.snapshot?.snapshot_data]);

  const radioLogs = useMemo(() => {
    const runtimeRaw = snapshotData?.radio_runtime;
    const runtime = runtimeRaw && typeof runtimeRaw === 'object' ? (runtimeRaw as Record<string, unknown>) : null;
    return parseRadioLogs(runtime?.logs);
  }, [snapshotData]);

  const stopRecordTimer = () => {
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
  };

  const releaseRecordingStream = () => {
    if (!streamRef.current) {
      return;
    }
    streamRef.current.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // ignore
      }
    });
    streamRef.current = null;
  };

  const stopPlayback = () => {
    playbackQueueRef.current = [];
    const currentAudio = playbackAudioRef.current;
    if (currentAudio) {
      try {
        currentAudio.pause();
        currentAudio.currentTime = 0;
      } catch {
        // ignore
      }
    }
    playbackAudioRef.current = null;
    playbackActiveRef.current = false;
  };

  const runPlaybackQueue = () => {
    if (playbackActiveRef.current) {
      return;
    }

    playbackActiveRef.current = true;
    void (async () => {
      try {
        while (playbackQueueRef.current.length > 0) {
          if (mutedRef.current) {
            playbackQueueRef.current = [];
            break;
          }

          const entry = playbackQueueRef.current.shift();
          if (!entry || !entry.audio_b64) {
            continue;
          }

          const audio = new Audio(`data:${entry.mime_type || 'audio/webm'};base64,${entry.audio_b64}`);
          audio.volume = 1;
          audio.playbackRate = 1;
          playbackAudioRef.current = audio;

          try {
            await audio.play();
            await new Promise<void>((resolve) => {
              audio.onended = () => resolve();
              audio.onerror = () => resolve();
            });
          } catch {
            break;
          } finally {
            playbackAudioRef.current = null;
          }
        }
      } finally {
        playbackActiveRef.current = false;
      }
    })();
  };

  const queueVoiceChunk = (
    chunkBlob: Blob,
    chunkMimeType: string,
    chunkDurationMs: number,
    chunkIndex: number,
    transmissionId: string,
    channel: RadioChannel,
    targetSessionId: string,
    isTransmissionEnd: boolean,
  ) => {
    sendQueueRef.current = sendQueueRef.current
      .then(async () => {
        const audioBase64 = await blobToBase64(chunkBlob);
        if (audioBase64.length > MAX_AUDIO_BASE64_LENGTH) {
          setError('Голосовой фрагмент слишком длинный. Сократите передачу');
          return;
        }

        await sendRealtimeCommand(
          'push_radio_message',
          {
            channel,
            audio_b64: audioBase64,
            mime_type: chunkMimeType || 'audio/webm',
            duration_ms: Math.max(80, chunkDurationMs),
            is_live_chunk: true,
            chunk_index: chunkIndex,
            transmission_id: transmissionId,
            is_transmission_end: isTransmissionEnd,
          },
          targetSessionId,
        );
      })
      .catch((sendError) => {
        setError(sendError instanceof Error ? sendError.message : 'Не удалось передать голос в эфир');
      });
  };

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      return;
    }
    try {
      recorder.stop();
    } catch {
      setError('Не удалось остановить передачу');
    }
    setIsRecording(false);
    stopRecordTimer();
  }, []);

  const startRecording = async () => {
    if (!sessionId) {
      setError('Нет активной сессии для передачи аудио');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError('Браузер не поддерживает запись аудио');
      return;
    }
    if (isRecording) {
      return;
    }

    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const preferredMimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
      const selectedMimeType = preferredMimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));

      transmissionIdRef.current = generateTransmissionId();
      transmissionChannelRef.current = selectedChannel;
      chunkIndexRef.current = 0;

      if (!pttActiveRef.current) {
        releaseRecordingStream();
        return;
      }

      const startSegmentRecorder = () => {
        const activeStream = streamRef.current;
        if (!activeStream || !sessionId || !pttActiveRef.current) {
          releaseRecordingStream();
          recorderRef.current = null;
          return;
        }

        const recorder = selectedMimeType
          ? new MediaRecorder(activeStream, { mimeType: selectedMimeType })
          : new MediaRecorder(activeStream);
        recorderRef.current = recorder;
        const segmentStartedAt = Date.now();

        recorder.ondataavailable = (event) => {
          if (!event.data || event.data.size === 0) {
            return;
          }
          const now = Date.now();
          const durationMs = Math.max(80, now - segmentStartedAt);
          const currentChunkIndex = chunkIndexRef.current;
          chunkIndexRef.current += 1;

          queueVoiceChunk(
            event.data,
            recorder.mimeType || selectedMimeType || 'audio/webm',
            durationMs,
            currentChunkIndex,
            transmissionIdRef.current,
            transmissionChannelRef.current,
            sessionId,
            !pttActiveRef.current,
          );
        };

        recorder.onerror = () => {
          setError('Ошибка передачи рации');
          pttActiveRef.current = false;
          setIsRecording(false);
          stopRecordTimer();
          releaseRecordingStream();
        };

        recorder.onstop = () => {
          if (!pttActiveRef.current) {
            setIsRecording(false);
            setRecordingSeconds(0);
            stopRecordTimer();
            releaseRecordingStream();
            recorderRef.current = null;
            return;
          }
          window.setTimeout(() => {
            if (pttActiveRef.current) {
              startSegmentRecorder();
            }
          }, 0);
        };

        recorder.start();
        window.setTimeout(() => {
          if (recorder.state === 'inactive') {
            return;
          }
          try {
            recorder.requestData();
          } catch {
            // ignore
          }
          try {
            recorder.stop();
          } catch {
            // ignore
          }
        }, RADIO_SEGMENT_MS);

      };

      recordStartRef.current = Date.now();
      setRecordingSeconds(0);
      setIsRecording(true);
      stopRecordTimer();
      recordTimerRef.current = window.setInterval(() => {
        setRecordingSeconds(Math.max(0, Math.floor((Date.now() - recordStartRef.current) / 1000)));
      }, 250);

      startSegmentRecorder();
    } catch (recordError) {
      setError(recordError instanceof Error ? recordError.message : 'Не удалось запустить передачу');
      setIsRecording(false);
      stopRecordTimer();
      releaseRecordingStream();
    }
  };

  const beginPtt = (pointerId?: number) => {
    if (pttActiveRef.current) {
      return;
    }
    pttActiveRef.current = true;
    pttPointerIdRef.current = typeof pointerId === 'number' ? pointerId : null;
    void startRecording();
  };

  const endPtt = () => {
    if (!pttActiveRef.current) {
      return;
    }
    pttActiveRef.current = false;
    pttPointerIdRef.current = null;
    stopRecording();
  };

  useEffect(() => {
    const forceStopPtt = () => {
      if (!pttActiveRef.current) {
        return;
      }
      pttActiveRef.current = false;
      pttPointerIdRef.current = null;
      stopRecording();
    };

    const handleGlobalPointerUp = () => {
      forceStopPtt();
    };
    const handleWindowBlur = () => {
      forceStopPtt();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        forceStopPtt();
      }
    };

    window.addEventListener('pointerup', handleGlobalPointerUp);
    window.addEventListener('pointercancel', handleGlobalPointerUp);
    window.addEventListener('blur', handleWindowBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('pointerup', handleGlobalPointerUp);
      window.removeEventListener('pointercancel', handleGlobalPointerUp);
      window.removeEventListener('blur', handleWindowBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [stopRecording]);

  useEffect(() => {
    mutedRef.current = isMuted;
    if (isMuted) {
      stopPlayback();
    }
  }, [isMuted]);

  useEffect(() => {
    if (!isMuted) {
      return;
    }
    for (const entry of radioLogs) {
      if (entry.channel === selectedChannel) {
        playedLogIdsRef.current.add(entry.id);
      }
    }
  }, [isMuted, radioLogs, selectedChannel]);

  useEffect(() => {
    if (!sessionId) {
      playbackPrimedRef.current = false;
      playedLogIdsRef.current.clear();
      playbackStartBoundaryMsRef.current = Date.now();
      stopPlayback();
      return;
    }
  }, [sessionId]);

  useEffect(() => {
    if (previousChannelRef.current === selectedChannel) {
      return;
    }
    previousChannelRef.current = selectedChannel;
    playbackStartBoundaryMsRef.current = Date.now();
    stopPlayback();
    for (const entry of radioLogs) {
      if (entry.channel === selectedChannel) {
        playedLogIdsRef.current.add(entry.id);
      }
    }
  }, [radioLogs, selectedChannel]);

  useEffect(() => {
    if (!sessionId || !user?.id || isMuted) {
      return;
    }

    if (!playbackPrimedRef.current) {
      for (const entry of radioLogs) {
        playedLogIdsRef.current.add(entry.id);
      }
      playbackPrimedRef.current = true;
      return;
    }

    const freshChunks = radioLogs
      .filter((entry) => {
        if (entry.kind !== 'MESSAGE' || !entry.audio_b64) {
          return false;
        }
        if (entry.channel !== selectedChannel) {
          return false;
        }
        if (entry.sender_user_id === user.id) {
          return false;
        }
        const createdAtMs = new Date(entry.created_at).getTime();
        if (Number.isFinite(createdAtMs) && createdAtMs < playbackStartBoundaryMsRef.current) {
          return false;
        }
        return !playedLogIdsRef.current.has(entry.id);
      })
      .sort((a, b) => {
        const byTime = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        if (byTime !== 0) {
          return byTime;
        }
        return (a.chunk_index ?? 0) - (b.chunk_index ?? 0);
      });

    if (freshChunks.length === 0) {
      return;
    }

    for (const entry of freshChunks) {
      playedLogIdsRef.current.add(entry.id);
      playbackQueueRef.current.push(entry);
    }
    runPlaybackQueue();
  }, [isMuted, radioLogs, selectedChannel, sessionId, user?.id]);

  useEffect(() => {
    return () => {
      stopRecordTimer();
      releaseRecordingStream();
      stopPlayback();

      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // ignore
        }
      }
      recorderRef.current = null;
    };
  }, []);

  return (
    <div className="bg-[#1a1a1a] border-2 border-black p-2 text-[7px] uppercase">
      <div className="flex flex-wrap items-center gap-1">
        <div className="text-[8px] text-white pr-1">Рация {activeRole ? `| ${activeRole}` : ''}</div>
        <select
          value={selectedChannel}
          onChange={(event) => setSelectedChannel(parseChannel(event.target.value))}
          className="h-6 min-w-[92px] bg-[#3d3d3d] border-2 border-black px-2 text-[7px] text-white outline-none"
        >
          {CHANNEL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <PixelButton
          size="sm"
          className="text-[6px] px-2"
          onClick={() => {
            setIsMuted((previous) => !previous);
          }}
        >
          {isMuted ? 'ЗВУК ВКЛ' : 'MUTE'}
        </PixelButton>

        <PixelButton
          size="sm"
          variant={isRecording ? 'active' : 'green'}
          className="text-[6px] px-2"
          disabled={!sessionId}
          onPointerDown={(event) => {
            beginPtt(event.pointerId);
          }}
          onPointerUp={(event) => {
            if (pttPointerIdRef.current === null || pttPointerIdRef.current === event.pointerId) {
              endPtt();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              beginPtt();
            }
          }}
          onKeyUp={(event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              endPtt();
            }
          }}
        >
          {isRecording ? `ЭФИР ${recordingSeconds}s` : 'ЗАЖМИ И ГОВОРИ'}
        </PixelButton>

        <div className={`${isMuted ? 'text-amber-300' : isRecording ? 'text-emerald-300' : 'text-cyan-300'} px-1`}>
          {isMuted ? 'MUTE' : isRecording ? 'TX' : 'RX'}
        </div>
      </div>

      {error ? <div className="text-[6px] text-red-300 mt-2 normal-case">{error}</div> : null}
    </div>
  );
};
