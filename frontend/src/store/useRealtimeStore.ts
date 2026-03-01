import { create } from 'zustand';
import type { SessionStateBundleDto } from '../shared/api/types';

type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'degraded';

type AckMessage = {
  type: 'ack';
  commandId: string;
  status: 'applied' | 'duplicate';
  command: string;
  sessionId: string;
  serverTime: string;
};

type CommandMessage = {
  type: 'command';
  commandId: string;
  command: string;
  payload: Record<string, unknown>;
  sessionId: string;
};

type PendingCommand = {
  resolve: (value: AckMessage) => void;
  reject: (error: Error) => void;
  timeoutId: number;
};

type RealtimeState = {
  status: RealtimeStatus;
  sessionId: string | null;
  bundle: SessionStateBundleDto | null;
  lastError: string;
  reconnectAttempt: number;
  isReconnecting: boolean;
  connect: (sessionId: string) => void;
  disconnect: () => void;
  sendCommand: (
    command: string,
    payload: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<AckMessage>;
};

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const COMMAND_TIMEOUT_MS = 45000;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let desiredSessionId: string | null = null;
let reconnectAttempt = 0;
const pendingCommands = new Map<string, PendingCommand>();

const resolveApiUrlForRealtime = (): string => {
  const explicitApiUrl = import.meta.env.VITE_API_URL as string | undefined;
  if (explicitApiUrl && explicitApiUrl.trim().length > 0) {
    return explicitApiUrl;
  }

  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:8000/api`;
  }

  return 'http://localhost:8000/api';
};

const buildWsUrl = (): string => {
  const explicitUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (explicitUrl && explicitUrl.trim().length > 0) {
    return explicitUrl;
  }

  const apiUrl = resolveApiUrlForRealtime();
  const normalizedApiUrl = apiUrl.replace(/\/+$/, '');
  const wsBase = normalizedApiUrl
    .replace(/^https:\/\//i, 'wss://')
    .replace(/^http:\/\//i, 'ws://');

  if (wsBase.endsWith('/api')) {
    return `${wsBase}/ws`;
  }
  return `${wsBase}/api/ws`;
};

const WS_URL = buildWsUrl();

const clearReconnectTimer = () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
};

const rejectAllPendingCommands = (reason: string) => {
  for (const [commandId, pending] of pendingCommands.entries()) {
    window.clearTimeout(pending.timeoutId);
    pending.reject(new Error(reason));
    pendingCommands.delete(commandId);
  }
};

const closeSocket = () => {
  if (!socket) {
    return;
  }
  try {
    socket.close(1000, 'client_disconnect');
  } catch {
    // ignore close errors
  }
  socket = null;
};

const handleAck = (message: AckMessage) => {
  const pending = pendingCommands.get(message.commandId);
  if (!pending) {
    return;
  }
  window.clearTimeout(pending.timeoutId);
  pending.resolve(message);
  pendingCommands.delete(message.commandId);
};

const handleErrorMessage = (message: Record<string, unknown>) => {
  const detail = typeof message.detail === 'string' ? message.detail : 'Realtime error';
  const commandId = typeof message.commandId === 'string' ? message.commandId : null;

  if (commandId) {
    const pending = pendingCommands.get(commandId);
    if (pending) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(new Error(detail));
      pendingCommands.delete(commandId);
    }
  }

  useRealtimeStore.setState({ lastError: detail });
};

const handleIncomingMessage = (rawData: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return;
  }

  if (!parsed || typeof parsed !== 'object') {
    return;
  }

  const message = parsed as Record<string, unknown>;
  const messageType = message.type;
  if (typeof messageType !== 'string') {
    return;
  }

  if (messageType === 'auth_ok') {
    reconnectAttempt = 0;
    useRealtimeStore.setState({
      status: 'connected',
      isReconnecting: false,
      reconnectAttempt: 0,
      lastError: '',
      sessionId: typeof message.sessionId === 'string' ? message.sessionId : desiredSessionId,
    });
    return;
  }

  if (messageType === 'subscribed') {
    if (typeof message.sessionId === 'string') {
      useRealtimeStore.setState({ sessionId: message.sessionId });
    }
    return;
  }

  if (messageType === 'session_state') {
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : null;
    if (!sessionId) {
      return;
    }
    const bundle = message.bundle as SessionStateBundleDto | undefined;
    if (!bundle) {
      return;
    }

    const state = useRealtimeStore.getState();
    if (state.sessionId && state.sessionId !== sessionId) {
      return;
    }

    useRealtimeStore.setState({ sessionId, bundle });
    return;
  }

  if (messageType === 'ack') {
    handleAck(message as AckMessage);
    return;
  }

  if (messageType === 'auth_error' || messageType === 'error') {
    handleErrorMessage(message);
  }
};

const scheduleReconnect = (reason: string) => {
  if (!desiredSessionId) {
    useRealtimeStore.setState({
      status: 'idle',
      isReconnecting: false,
      lastError: '',
      reconnectAttempt: 0,
    });
    return;
  }

  reconnectAttempt += 1;
  const baseDelay = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(reconnectAttempt - 1, 0),
  );
  const jitter = Math.floor(Math.random() * 200);
  const delay = baseDelay + jitter;

  useRealtimeStore.setState({
    status: 'degraded',
    isReconnecting: true,
    reconnectAttempt,
    lastError: reason,
  });

  clearReconnectTimer();
  reconnectTimer = window.setTimeout(() => {
    openSocket();
  }, delay);
};

const openSocket = () => {
  const token = localStorage.getItem('auth_token');
  if (!token || !desiredSessionId) {
    useRealtimeStore.setState({
      status: 'idle',
      sessionId: desiredSessionId,
      reconnectAttempt: 0,
      isReconnecting: false,
    });
    return;
  }

  clearReconnectTimer();
  closeSocket();

  useRealtimeStore.setState({
    status: 'connecting',
    sessionId: desiredSessionId,
    reconnectAttempt,
    isReconnecting: reconnectAttempt > 0,
  });

  const ws = new WebSocket(WS_URL);
  socket = ws;

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: 'auth',
        accessToken: token,
        sessionId: desiredSessionId,
      }),
    );
  };

  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') {
      return;
    }
    handleIncomingMessage(event.data);
  };

  ws.onclose = (event) => {
    if (socket === ws) {
      socket = null;
    }
    rejectAllPendingCommands('WebSocket connection closed');
    if (!desiredSessionId) {
      useRealtimeStore.setState({
        status: 'idle',
        reconnectAttempt: 0,
        isReconnecting: false,
      });
      return;
    }
    scheduleReconnect(`Realtime disconnected (${event.code})`);
  };

  ws.onerror = () => {
    useRealtimeStore.setState({
      status: 'degraded',
      lastError: 'WebSocket transport error',
    });
  };
};

export const useRealtimeStore = create<RealtimeState>((set, get) => ({
  status: 'idle',
  sessionId: null,
  bundle: null,
  lastError: '',
  reconnectAttempt: 0,
  isReconnecting: false,

  connect: (sessionId: string) => {
    desiredSessionId = sessionId;
    set({ sessionId, lastError: '' });

    if (socket && socket.readyState === WebSocket.OPEN) {
      const subscribedSessionId = get().sessionId;
      if (subscribedSessionId === sessionId) {
        return;
      }
      socket.send(JSON.stringify({ type: 'subscribe_session', sessionId }));
      return;
    }

    if (socket && socket.readyState === WebSocket.CONNECTING) {
      return;
    }

    reconnectAttempt = 0;
    openSocket();
  },

  disconnect: () => {
    desiredSessionId = null;
    clearReconnectTimer();
    rejectAllPendingCommands('Realtime disconnected');
    closeSocket();
    reconnectAttempt = 0;
    set({
      status: 'idle',
      sessionId: null,
      bundle: null,
      lastError: '',
      reconnectAttempt: 0,
      isReconnecting: false,
    });
  },

  sendCommand: (command: string, payload: Record<string, unknown>, sessionId?: string) => {
    return new Promise<AckMessage>((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Realtime connection is not established'));
        return;
      }

      const targetSessionId = sessionId || get().sessionId || desiredSessionId;
      if (!targetSessionId) {
        reject(new Error('No active session selected for realtime command'));
        return;
      }

      const commandId = crypto.randomUUID();
      const message: CommandMessage = {
        type: 'command',
        commandId,
        command,
        payload,
        sessionId: targetSessionId,
      };

      const timeoutId = window.setTimeout(() => {
        const pending = pendingCommands.get(commandId);
        if (!pending) {
          return;
        }
        pendingCommands.delete(commandId);
        pending.reject(new Error('Realtime command timeout'));
      }, COMMAND_TIMEOUT_MS);

      pendingCommands.set(commandId, { resolve, reject, timeoutId });
      socket.send(JSON.stringify(message));
    });
  },
}));
