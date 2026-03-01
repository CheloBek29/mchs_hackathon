import { useCallback, useEffect, useMemo, useState } from 'react';
import { TopRoleNavBar } from './widgets/TopRoleNavBar/TopRoleNavBar';
import { DispatcherSidebar } from './features/DispatcherControls/DispatcherSidebar';
import { StaffSidebar } from './features/RoleControls/StaffSidebar';
import { RtpSidebar } from './features/RoleControls/RtpSidebar';
import { BuSidebar } from './features/RoleControls/BuSidebar';
import { TrainingLeadWorkspace } from './features/TrainingLeadControls/TrainingLeadWorkspace';
import { SimulationBoard } from './widgets/SimulationBoard/SimulationBoard';
import { PixelButton } from './shared/ui/PixelButton';
import { PixelInput } from './shared/ui/PixelInput';
import { apiClient } from './shared/api/client';
import type { SimulationSessionDto } from './shared/api/types';
import { ROLE_LABELS_RU, normalizeRoleName, type CanonicalRole } from './shared/auth/roles';
import { useAuthStore, type UserProfile } from './store/useAuthStore';
import { useRealtimeStore } from './store/useRealtimeStore';

type UiRole = 'РУКОВОДИТЕЛЬ' | 'ДИСПЕЧЕР' | 'РТП' | 'ШТАБ' | 'БУ - 1' | 'БУ - 2';

const UI_ROLE_ORDER: UiRole[] = ['РУКОВОДИТЕЛЬ', 'ДИСПЕЧЕР', 'РТП', 'ШТАБ', 'БУ - 1', 'БУ - 2'];
const UI_ROLE_SET = new Set<UiRole>(UI_ROLE_ORDER);

const PUBLIC_REGISTRATION_ROLES: CanonicalRole[] = [
  'DISPATCHER',
  'RTP',
  'HQ',
  'COMBAT_AREA_1',
  'COMBAT_AREA_2',
  'TRAINING_LEAD',
];

type AuthMode = 'login' | 'register';

type AuthLoginResponse = {
  access_token: string;
};

const DEFAULT_CREATED_SESSION_PAYLOAD = {
  status: 'CREATED',
  map_image_url: null,
  map_scale: 1,
  weather: {},
  time_multiplier: 1,
} as const;

const REALTIME_STATUS_LABELS: Record<string, string> = {
  idle: 'не подключено',
  connecting: 'подключение...',
  connected: 'в сети',
  degraded: 'переподключение',
};

const isUiRole = (value: string): value is UiRole => {
  return UI_ROLE_SET.has(value as UiRole);
};

const mapCanonicalToUiRole = (role: CanonicalRole): UiRole | null => {
  if (role === 'TRAINING_LEAD') {
    return 'РУКОВОДИТЕЛЬ';
  }
  if (role === 'DISPATCHER') {
    return 'ДИСПЕЧЕР';
  }
  if (role === 'RTP') {
    return 'РТП';
  }
  if (role === 'HQ') {
    return 'ШТАБ';
  }
  if (role === 'COMBAT_AREA_1') {
    return 'БУ - 1';
  }
  if (role === 'COMBAT_AREA_2') {
    return 'БУ - 2';
  }
  return null;
};

const resolveAvailableUiRoles = (canonicalRoles: CanonicalRole[]): UiRole[] => {
  const canAccessAllRoleViews = canonicalRoles.includes('ADMIN') || canonicalRoles.includes('TRAINING_LEAD');
  if (canAccessAllRoleViews) {
    return UI_ROLE_ORDER;
  }

  const allowed = new Set<UiRole>();
  for (const canonicalRole of canonicalRoles) {
    const uiRole = mapCanonicalToUiRole(canonicalRole);
    if (uiRole) {
      allowed.add(uiRole);
    }
  }

  const filtered = UI_ROLE_ORDER.filter((role) => allowed.has(role));
  if (filtered.length > 0) {
    return filtered;
  }

  return ['ДИСПЕЧЕР'];
};

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
};

const buildDefaultScenarioName = (): string => {
  const now = new Date();
  const formatted = now.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Сценарий ${formatted}`;
};

function App() {
  const { user, token, isAuthenticated, isLoading, setCredentials, setUser, setLoading, logout } = useAuthStore();
  const connectRealtime = useRealtimeStore((state) => state.connect);
  const disconnectRealtime = useRealtimeStore((state) => state.disconnect);
  const realtimeStatus = useRealtimeStore((state) => state.status);
  const realtimeBundle = useRealtimeStore((state) => state.bundle);
  const realtimeBundleSessionId = useRealtimeStore((state) => state.sessionId);

  const [activeRole, setActiveRole] = useState<UiRole>('ДИСПЕЧЕР');
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [loginName, setLoginName] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [registerName, setRegisterName] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerRole, setRegisterRole] = useState<CanonicalRole>('DISPATCHER');
  const [authSubmitLoading, setAuthSubmitLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  const [sessions, setSessions] = useState<SimulationSessionDto[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [sessionScenarioName, setSessionScenarioName] = useState('');
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionActionLoading, setSessionActionLoading] = useState(false);
  const [sessionError, setSessionError] = useState('');

  const canonicalRoles = useMemo(() => {
    return user?.roles
      .map((roleItem) => normalizeRoleName(roleItem.name))
      .filter((roleItem): roleItem is CanonicalRole => roleItem !== null) ?? [];
  }, [user?.roles]);

  const availableRoles = useMemo(() => {
    return resolveAvailableUiRoles(canonicalRoles);
  }, [canonicalRoles]);

  const canWriteSessions = useMemo(() => {
    return canonicalRoles.includes('ADMIN') || canonicalRoles.includes('DISPATCHER') || canonicalRoles.includes('TRAINING_LEAD');
  }, [canonicalRoles]);

  const selectedSession = useMemo(() => {
    if (!selectedSessionId) {
      return null;
    }
    return sessions.find((sessionItem) => sessionItem.id === selectedSessionId) ?? null;
  }, [selectedSessionId, sessions]);

  const activeRealtimeBundle = useMemo(() => {
    if (!user?.session_id || !realtimeBundle) {
      return null;
    }
    if (realtimeBundleSessionId !== user.session_id) {
      return null;
    }
    return realtimeBundle;
  }, [realtimeBundle, realtimeBundleSessionId, user?.session_id]);

  const lessonCompletionInfo = useMemo(() => {
    const bundle = activeRealtimeBundle;
    if (!bundle) {
      return { isCompleted: false, radioMessages: null as number | null };
    }

    const snapshotData =
      bundle.snapshot?.snapshot_data && typeof bundle.snapshot.snapshot_data === 'object'
        ? (bundle.snapshot.snapshot_data as Record<string, unknown>)
        : null;
    const lessonStateRaw = snapshotData?.training_lesson;
    const lessonState = lessonStateRaw && typeof lessonStateRaw === 'object' ? (lessonStateRaw as Record<string, unknown>) : null;

    const bySessionStatus = bundle.session.status === 'COMPLETED';
    const byLessonState = lessonState?.status === 'COMPLETED';
    const isCompleted = Boolean(bySessionStatus || byLessonState);

    const lessonResultRaw = snapshotData?.lesson_result;
    const lessonResult = lessonResultRaw && typeof lessonResultRaw === 'object' ? (lessonResultRaw as Record<string, unknown>) : null;
    const radioSummaryRaw = lessonResult?.radio_summary;
    const radioSummary = radioSummaryRaw && typeof radioSummaryRaw === 'object' ? (radioSummaryRaw as Record<string, unknown>) : null;
    const totalRadioMessages =
      typeof radioSummary?.total_messages === 'number' && Number.isFinite(radioSummary.total_messages)
        ? Math.max(0, Math.round(radioSummary.total_messages))
        : null;

    return {
      isCompleted,
      radioMessages: totalRadioMessages,
    };
  }, [activeRealtimeBundle]);

  const loadProfileByToken = useCallback(async (accessToken: string) => {
    const profile = await apiClient.get<UserProfile>('/auth/me', { token: accessToken });
    setCredentials(accessToken, profile);
  }, [setCredentials]);

  const loadSessions = useCallback(async () => {
    if (!isAuthenticated) {
      setSessions([]);
      setSelectedSessionId('');
      return;
    }

    setSessionsLoading(true);
    setSessionError('');
    try {
      const loadedSessions = await apiClient.get<SimulationSessionDto[]>('/sessions');
      setSessions(loadedSessions);
      setSelectedSessionId((previous) => {
        const preferred = user?.session_id || previous;
        if (preferred && loadedSessions.some((sessionItem) => sessionItem.id === preferred)) {
          return preferred;
        }
        return loadedSessions[0]?.id ?? '';
      });
    } catch (error) {
      setSessionError(getErrorMessage(error, 'Не удалось загрузить список сессий'));
      setSessions([]);
      setSelectedSessionId(user?.session_id ?? '');
    } finally {
      setSessionsLoading(false);
    }
  }, [isAuthenticated, user?.session_id]);

  const handleBindSession = useCallback(async (targetSessionId?: string) => {
    const sessionIdToBind = targetSessionId ?? selectedSessionId;

    if (!sessionIdToBind) {
      setSessionError('Сначала выберите сессию');
      return;
    }

    setSessionActionLoading(true);
    setSessionError('');
    try {
      const updatedUser = await apiClient.patch<UserProfile>('/auth/session', { session_id: sessionIdToBind });
      setUser(updatedUser);
    } catch (error) {
      setSessionError(getErrorMessage(error, 'Не удалось привязать сессию'));
    } finally {
      setSessionActionLoading(false);
    }
  }, [selectedSessionId, setUser]);

  const handleCreateSession = useCallback(async () => {
    if (!canWriteSessions) {
      return;
    }

    const scenarioName = sessionScenarioName.trim() || buildDefaultScenarioName();

    setSessionActionLoading(true);
    setSessionError('');
    try {
      const createdSession = await apiClient.post<SimulationSessionDto>('/sessions', {
        ...DEFAULT_CREATED_SESSION_PAYLOAD,
        scenario_name: scenarioName,
      });

      setSessions((previous) => [createdSession, ...previous.filter((sessionItem) => sessionItem.id !== createdSession.id)]);
      setSelectedSessionId(createdSession.id);
      setSessionScenarioName('');

      const updatedUser = await apiClient.patch<UserProfile>('/auth/session', { session_id: createdSession.id });
      setUser(updatedUser);
    } catch (error) {
      setSessionError(getErrorMessage(error, 'Не удалось создать сессию'));
    } finally {
      setSessionActionLoading(false);
    }
  }, [canWriteSessions, sessionScenarioName, setUser]);

  useEffect(() => {
    let disposed = false;

    const checkAuth = async () => {
      const storedToken = typeof window !== 'undefined' ? window.localStorage.getItem('auth_token') : null;
      if (!storedToken) {
        setLoading(false);
        return;
      }

      try {
        await loadProfileByToken(storedToken);
      } catch (error) {
        if (!disposed) {
          setAuthError(getErrorMessage(error, 'Не удалось загрузить профиль пользователя'));
          logout();
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    };

    void checkAuth();

    return () => {
      disposed = true;
    };
  }, [loadProfileByToken, logout, setLoading]);

  useEffect(() => {
    if (!isAuthenticated) {
      setSessions([]);
      setSelectedSessionId('');
      setSessionError('');
      return;
    }
    void loadSessions();
  }, [isAuthenticated, loadSessions]);

  useEffect(() => {
    if (!sessionScenarioName.trim()) {
      setSessionScenarioName(buildDefaultScenarioName());
    }
  }, [sessionScenarioName]);

  useEffect(() => {
    if (!selectedSessionId) {
      return;
    }
    if (sessions.some((sessionItem) => sessionItem.id === selectedSessionId)) {
      return;
    }

    if (user?.session_id && sessions.some((sessionItem) => sessionItem.id === user.session_id)) {
      setSelectedSessionId(user.session_id);
      return;
    }

    setSelectedSessionId(sessions[0]?.id ?? '');
  }, [selectedSessionId, sessions, user?.session_id]);

  useEffect(() => {
    if (!user?.session_id) {
      return;
    }
    if (selectedSessionId === user.session_id) {
      return;
    }
    if (!sessions.some((sessionItem) => sessionItem.id === user.session_id)) {
      return;
    }
    setSelectedSessionId(user.session_id);
  }, [selectedSessionId, sessions, user?.session_id]);

  useEffect(() => {
    if (!isAuthenticated || !token || !user?.session_id) {
      disconnectRealtime();
      return;
    }
    connectRealtime(user.session_id);
  }, [connectRealtime, disconnectRealtime, isAuthenticated, token, user?.session_id]);

  useEffect(() => {
    if (availableRoles.includes(activeRole)) {
      return;
    }
    setActiveRole(availableRoles[0]);
  }, [activeRole, availableRoles]);

  const handleLoginAuth = async () => {
    const normalizedLogin = loginName.trim().toLowerCase();
    if (!normalizedLogin) {
      setAuthError('Введите логин');
      return;
    }
    if (!loginPassword) {
      setAuthError('Введите пароль');
      return;
    }

    setAuthSubmitLoading(true);
    setAuthError('');
    try {
      const authResponse = await apiClient.post<AuthLoginResponse>('/auth/login', {
        login: normalizedLogin,
        password: loginPassword,
      });
      await loadProfileByToken(authResponse.access_token);
      setLoginPassword('');
    } catch (error) {
      setAuthError(getErrorMessage(error, 'Не удалось войти по логину и паролю'));
    } finally {
      setAuthSubmitLoading(false);
      setLoading(false);
    }
  };

  const handleRegisterAuth = async () => {
    const normalizedLogin = registerName.trim().toLowerCase();
    if (!normalizedLogin) {
      setAuthError('Введите логин для регистрации');
      return;
    }
    if (!registerPassword) {
      setAuthError('Введите пароль для регистрации');
      return;
    }

    setAuthSubmitLoading(true);
    setAuthError('');
    try {
      await apiClient.post<UserProfile>('/auth/register', {
        username: normalizedLogin,
        password: registerPassword,
        requested_role: registerRole,
      });

      const authResponse = await apiClient.post<AuthLoginResponse>('/auth/login', {
        login: normalizedLogin,
        password: registerPassword,
      });
      await loadProfileByToken(authResponse.access_token);

      setRegisterPassword('');
      setLoginName(normalizedLogin);
      setLoginPassword('');
    } catch (error) {
      setAuthError(getErrorMessage(error, 'Не удалось зарегистрироваться'));
    } finally {
      setAuthSubmitLoading(false);
      setLoading(false);
    }
  };

  const handleRoleChange = (role: string) => {
    if (!isUiRole(role)) {
      return;
    }
    if (!availableRoles.includes(role)) {
      return;
    }
    setActiveRole(role);
  };

  if (isLoading) {
    return (
      <div className="w-screen h-screen bg-black text-white font-pixel flex items-center justify-center">
        <div className="text-[12px] tracking-widest">ЗАГРУЗКА ПРОФИЛЯ...</div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <div className="w-screen h-screen bg-black text-white font-pixel flex items-center justify-center p-4">
        <div className="w-full max-w-[680px] bg-[#2b2b2b] border-2 border-black p-6 space-y-4">
          <h1 className="text-[20px] tracking-wider drop-shadow-[2px_2px_0_rgba(0,0,0,0.8)]">МЧС ТРЕНАЖЕР</h1>

          <div className="grid grid-cols-2 gap-2">
            <PixelButton
              variant={authMode === 'login' ? 'active' : 'default'}
              className="w-full text-[9px]"
              onClick={() => {
                setAuthMode('login');
                setAuthError('');
              }}
            >
              Вход
            </PixelButton>
            <PixelButton
              variant={authMode === 'register' ? 'active' : 'default'}
              className="w-full text-[9px]"
              onClick={() => {
                setAuthMode('register');
                setAuthError('');
              }}
            >
              Регистрация
            </PixelButton>
          </div>

          {authMode === 'login' ? (
            <div className="space-y-3">
              <p className="text-[9px] text-gray-300 leading-relaxed">
                Войдите по логину и паролю. После входа роли и рабочее место загрузятся автоматически.
              </p>
              <PixelInput
                value={loginName}
                onChange={(event) => setLoginName(event.target.value)}
                placeholder="Логин"
                className="w-full"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void handleLoginAuth();
                  }
                }}
              />
              <PixelInput
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                type="password"
                placeholder="Пароль"
                className="w-full"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void handleLoginAuth();
                  }
                }}
              />
              <PixelButton
                variant="green"
                className="w-full"
                onClick={() => {
                  void handleLoginAuth();
                }}
                disabled={authSubmitLoading}
              >
                {authSubmitLoading ? 'ПОДКЛЮЧЕНИЕ...' : 'ВОЙТИ'}
              </PixelButton>
            </div>
          ) : null}

          {authMode === 'register' ? (
            <div className="space-y-3">
              <p className="text-[9px] text-gray-300 leading-relaxed">
                Создайте пользователя: логин, пароль и роль. После регистрации будет выполнен автоматический вход.
              </p>
              <PixelInput
                value={registerName}
                onChange={(event) => setRegisterName(event.target.value)}
                placeholder="Логин"
                className="w-full"
              />
              <PixelInput
                value={registerPassword}
                onChange={(event) => setRegisterPassword(event.target.value)}
                type="password"
                placeholder="Пароль"
                className="w-full"
              />
              <select
                value={registerRole}
                onChange={(event) => setRegisterRole(event.target.value as CanonicalRole)}
                className="bg-[#404040] text-white border-2 border-black outline-none px-2 py-1 text-[10px] w-full focus:border-gray-500 transition-colors"
              >
                {PUBLIC_REGISTRATION_ROLES.map((roleName) => (
                  <option key={roleName} value={roleName}>
                    {ROLE_LABELS_RU[roleName]}
                  </option>
                ))}
              </select>
              <div className="text-[8px] text-gray-400">Пароль: минимум 8 символов, верхний/нижний регистр, цифра и спецсимвол.</div>
              <PixelButton
                variant="green"
                className="w-full"
                onClick={() => {
                  void handleRegisterAuth();
                }}
                disabled={authSubmitLoading}
              >
                {authSubmitLoading ? 'СОЗДАНИЕ...' : 'ЗАРЕГИСТРИРОВАТЬСЯ'}
              </PixelButton>
            </div>
          ) : null}

          {authError ? <div className="text-[8px] text-red-400">{authError}</div> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="w-screen h-screen flex flex-col overflow-hidden bg-black text-white font-pixel">
      {/* Top Navigation */}
      <TopRoleNavBar roles={availableRoles} activeRole={activeRole} setActiveRole={handleRoleChange} />

      <div className="h-[28px] bg-[#1f1f1f] border-b border-black px-4 flex items-center justify-between text-[7px] uppercase tracking-wide">
        <div className="truncate pr-3">
          {user.username} | {canonicalRoles.join(', ') || 'ROLE_UNDEFINED'}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span>Realtime: {REALTIME_STATUS_LABELS[realtimeStatus] ?? realtimeStatus}</span>
          <button
            type="button"
            onClick={logout}
            className="px-2 py-1 border border-black bg-[#3a3a3a] hover:bg-[#4a4a4a] transition-colors"
          >
            Выход
          </button>
        </div>
      </div>

      {activeRole !== 'РУКОВОДИТЕЛЬ' ? (
        <>
          <div className="h-[34px] bg-[#252525] border-b border-black px-4 flex items-center justify-between gap-3 text-[7px] uppercase tracking-wide">
            <div className="min-w-0 flex items-center gap-2 flex-1">
              <span className="text-gray-300 shrink-0">Сессия:</span>
              <select
                value={selectedSessionId}
                onChange={(event) => {
                  const nextSessionId = event.target.value;
                  setSelectedSessionId(nextSessionId);
                  if (canWriteSessions && nextSessionId) {
                    void handleBindSession(nextSessionId);
                  }
                }}
                disabled={sessionsLoading || sessionActionLoading || sessions.length === 0 || !canWriteSessions}
                className="h-6 min-w-[220px] max-w-[420px] bg-[#404040] text-white border-2 border-black outline-none px-2 text-[8px] disabled:opacity-60"
              >
                {sessions.length === 0 ? <option value="">нет доступных сессий</option> : null}
                {sessions.map((sessionItem) => (
                  <option key={sessionItem.id} value={sessionItem.id}>
                    {sessionItem.scenario_name} [{sessionItem.status}]
                  </option>
                ))}
              </select>
            </div>

            {canWriteSessions ? (
              <div className="flex items-center gap-2 shrink-0">
                <PixelInput
                  value={sessionScenarioName}
                  onChange={(event) => setSessionScenarioName(event.target.value)}
                  placeholder="Название сценария"
                  className="h-6 w-[220px] text-[8px]"
                />
                <PixelButton
                  size="sm"
                  variant="green"
                  className="h-6 px-2 text-[7px]"
                  disabled={sessionActionLoading}
                  onClick={() => {
                    void handleCreateSession();
                  }}
                >
                  НОВАЯ СЕССИЯ
                </PixelButton>
              </div>
            ) : (
              <div className="text-gray-400 shrink-0">
                {selectedSession ? `ТЕКУЩАЯ: ${selectedSession.scenario_name}` : 'СЕССИЯ НАЗНАЧАЕТСЯ ДИСПЕТЧЕРОМ/РУКОВОДИТЕЛЕМ'}
              </div>
            )}
          </div>

          {sessionError ? (
            <div className="h-[18px] bg-[#301111] border-b border-black px-4 text-[7px] uppercase tracking-wide text-red-300 flex items-center">
              {sessionError}
            </div>
          ) : null}
        </>
      ) : null}

      {activeRole !== 'РУКОВОДИТЕЛЬ' && lessonCompletionInfo.isCompleted ? (
        <div className="h-[20px] bg-[#062325] border-b border-black px-4 text-[7px] uppercase tracking-wide text-cyan-200 flex items-center justify-between gap-2">
          <span>ТРЕНИРОВКА ОКОНЧЕНА. ВСЕМ СПАСИБО ЗА РАБОТУ.</span>
          {lessonCompletionInfo.radioMessages !== null ? <span>РАЦИЯ: {lessonCompletionInfo.radioMessages}</span> : null}
        </div>
      ) : null}

      {/* Main Content Area */}
      {activeRole === 'РУКОВОДИТЕЛЬ' ? (
        <TrainingLeadWorkspace />
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* Left Sidebar */}
          {activeRole === 'ДИСПЕЧЕР' && <DispatcherSidebar />}
          {activeRole === 'ШТАБ' && <StaffSidebar />}
          {activeRole === 'РТП' && <RtpSidebar />}
          {(activeRole === 'БУ - 1' || activeRole === 'БУ - 2') && <BuSidebar areaLabel={activeRole} />}

          {/* Center Canvas Area */}
          <div className="flex-1 relative bg-[#111]">
            <SimulationBoard activeRole={activeRole} />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
