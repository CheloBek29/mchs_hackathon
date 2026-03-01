import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PixelButton } from '../../shared/ui/PixelButton';
import { PixelInput } from '../../shared/ui/PixelInput';
import { PixelModal } from '../../shared/ui/PixelModal';
import { StatusIndicator } from '../../shared/ui/StatusIndicator';
import { apiClient } from '../../shared/api/client';
import type {
  ResourceDeploymentDto,
  SessionStateBundleDto,
  VehicleDictionaryDto,
} from '../../shared/api/types';
import { useAuthStore } from '../../store/useAuthStore';
import { useDispatcherStore } from '../../store/useDispatcherStore';
import { useRealtimeStore } from '../../store/useRealtimeStore';

type SpritePreset = { col: number; row: number };

type DispatcherJournalEntry = {
  id: string;
  text: string;
  time: string;
  created_at: string;
  author: string | null;
};

type PreparedVehicle = VehicleDictionaryDto & {
  dispatchCode: string;
  statusLabel: string;
  statusClass: string;
  isBusy: boolean;
  typeLabel: string;
  col: number;
  row: number;
};

const TYPE_LABELS: Record<VehicleDictionaryDto['type'], string> = {
  AC: 'Автоцистерна',
  AL: 'Автолестница',
  ASA: 'Аварийно-спасательная',
};

const VEHICLE_SPEC_DEFAULTS: Record<VehicleDictionaryDto['type'], {
  crew_size: number;
  water_capacity: number;
  foam_capacity: number;
  hose_length: number;
}> = {
  AC: {
    crew_size: 6,
    water_capacity: 3200,
    foam_capacity: 200,
    hose_length: 360,
  },
  AL: {
    crew_size: 3,
    water_capacity: 1000,
    foam_capacity: 100,
    hose_length: 180,
  },
  ASA: {
    crew_size: 4,
    water_capacity: 1000,
    foam_capacity: 120,
    hose_length: 240,
  },
};

const DEPLOYMENT_STATUS_META: Record<
  ResourceDeploymentDto['status'],
  { label: string; className: string; busy: boolean }
> = {
  PLANNED: { label: 'ГОТОВИТСЯ', className: 'bg-[#404040] text-gray-200', busy: true },
  EN_ROUTE: { label: 'В ПУТИ', className: 'bg-[#3d7f2b] text-white', busy: true },
  DEPLOYED: { label: 'НА МЕСТЕ', className: 'bg-[#3d7f2b] text-white', busy: true },
  ACTIVE: { label: 'РАБОТАЕТ', className: 'bg-[#3d7f2b] text-white', busy: true },
  COMPLETED: { label: 'НА БАЗЕ', className: 'bg-[#202020] text-gray-300', busy: false },
};

const DEFAULT_STATUS_META = {
  label: 'НА БАЗЕ',
  className: 'bg-[#202020] text-gray-300',
  busy: false,
};

const MAX_JOURNAL_ENTRIES = 80;
const DISPATCH_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DISPATCH_ETA_SEC_MIN = 30;
const DISPATCH_ETA_SEC_MAX = 120;

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
};

const normalizeVehicleSpec = (value: number | null, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return fallback;
};

const getSpriteByVehicleName = (name: string): SpritePreset => {
  const normalized = name.toUpperCase();

  if (normalized.includes('АЦ-40') || normalized.includes('АЦ 40')) return { col: 0, row: 0 };
  if (normalized.includes('АЦ-3') || normalized.includes('АЦ 3')) return { col: 1, row: 0 };
  if (normalized.includes('АЦ-6') || normalized.includes('АЦ 6')) return { col: 2, row: 0 };
  if (normalized.includes('ПНС-110')) return { col: 3, row: 0 };
  if (normalized.includes('АЛ-30')) return { col: 0, row: 1 };
  if (normalized.includes('АЛ-50')) return { col: 1, row: 1 };
  if (normalized.includes('АНР-3,0') || normalized.includes('АНР-3.0')) return { col: 2, row: 1 };
  if (normalized.includes('АР-2')) return { col: 3, row: 1 };

  return { col: 0, row: 0 };
};

const sanitizeDispatchCodeInput = (value: string): string => {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
};

const makeDeterministicDispatchCode = (vehicle: VehicleDictionaryDto, salt = 0): string => {
  const seed = `${vehicle.id}:${vehicle.name}:${vehicle.type}:${salt}`;
  let hash = 2166136261;

  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  let value = hash >>> 0;
  let code = '';
  for (let index = 0; index < 7; index += 1) {
    const charIndex = value % DISPATCH_CODE_ALPHABET.length;
    code += DISPATCH_CODE_ALPHABET[charIndex];
    value = Math.floor(value / DISPATCH_CODE_ALPHABET.length);
    if (value === 0) {
      value = ((hash >>> ((index % 4) * 8)) ^ (index * 97) ^ (salt * 131)) >>> 0;
    }
  }

  return code;
};

const buildDispatchCodeByVehicle = (vehicles: VehicleDictionaryDto[]): Map<number, string> => {
  const usedCodes = new Set<string>();
  const byVehicleId = new Map<number, string>();

  vehicles.forEach((vehicle) => {
    let salt = 0;
    let candidate = makeDeterministicDispatchCode(vehicle, salt);
    while (usedCodes.has(candidate) && salt < 256) {
      salt += 1;
      candidate = makeDeterministicDispatchCode(vehicle, salt);
    }
    usedCodes.add(candidate);
    byVehicleId.set(vehicle.id, candidate);
  });

  return byVehicleId;
};

const formatEtaDuration = (totalSeconds: number): string => {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;

  if (minutes <= 0) {
    return `${seconds} сек.`;
  }

  if (seconds === 0) {
    return `${minutes} мин.`;
  }

  return `${minutes} мин. ${seconds} сек.`;
};

const resolveDispatchEtaSeconds = (): number => {
  const range = DISPATCH_ETA_SEC_MAX - DISPATCH_ETA_SEC_MIN;
  return DISPATCH_ETA_SEC_MIN + Math.floor(Math.random() * (range + 1));
};

const getLatestDeploymentByVehicle = (
  deployments: ResourceDeploymentDto[],
): Map<number, ResourceDeploymentDto> => {
  const byVehicle = new Map<number, ResourceDeploymentDto>();

  deployments.forEach((deployment) => {
    const vehicleId = deployment.vehicle_dictionary_id;
    if (!vehicleId) {
      return;
    }

    const previous = byVehicle.get(vehicleId);
    if (!previous) {
      byVehicle.set(vehicleId, deployment);
      return;
    }

    const previousTime = new Date(previous.created_at).getTime();
    const currentTime = new Date(deployment.created_at).getTime();
    if (currentTime >= previousTime) {
      byVehicle.set(vehicleId, deployment);
    }
  });

  return byVehicle;
};

export const parseDispatcherJournal = (
  snapshotData: Record<string, unknown> | null | undefined,
): DispatcherJournalEntry[] => {
  if (!snapshotData) {
    return [];
  }

  const rawJournal = snapshotData.dispatcher_journal;
  if (!Array.isArray(rawJournal)) {
    return [];
  }

  return rawJournal
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const raw = item as Record<string, unknown>;
      const text = typeof raw.text === 'string' ? raw.text.trim() : '';
      if (!text) {
        return null;
      }
      const id = typeof raw.id === 'string' ? raw.id : crypto.randomUUID();
      const time = typeof raw.time === 'string' ? raw.time : '--:--';
      const createdAt = typeof raw.created_at === 'string' ? raw.created_at : new Date().toISOString();
      const author = typeof raw.author === 'string' ? raw.author : null;

      return {
        id,
        text,
        time,
        created_at: createdAt,
        author,
      } satisfies DispatcherJournalEntry;
    })
    .filter((entry): entry is DispatcherJournalEntry => entry !== null)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
};

const normalizeTwoDigits = (value: string): string => value.replace(/\D/g, '').slice(0, 2);

const resolveEntryTime = (hoursRaw: string, minutesRaw: string): string => {
  const now = new Date();

  const parsedHours = Number.parseInt(hoursRaw, 10);
  const parsedMinutes = Number.parseInt(minutesRaw, 10);

  const safeHours = Number.isFinite(parsedHours) ? Math.min(Math.max(parsedHours, 0), 23) : now.getHours();
  const safeMinutes = Number.isFinite(parsedMinutes) ? Math.min(Math.max(parsedMinutes, 0), 59) : now.getMinutes();

  return `${String(safeHours).padStart(2, '0')}:${String(safeMinutes).padStart(2, '0')}`;
};

const countActiveFires = (bundle: SessionStateBundleDto | null): number => {
  if (!bundle) {
    return 0;
  }
  return bundle.fire_objects.filter((fireObject) => fireObject.is_active).length;
};

export const DispatcherSidebar: React.FC = () => {
  const { user } = useAuthStore();
  const realtimeBundle = useRealtimeStore((state) => state.bundle);
  const realtimeSessionId = useRealtimeStore((state) => state.sessionId);
  const sendRealtimeCommand = useRealtimeStore((state) => state.sendCommand);
  const showBanner = useDispatcherStore((state) => state.showBanner);

  const [vehicles, setVehicles] = useState<VehicleDictionaryDto[]>([]);
  const [bundle, setBundle] = useState<SessionStateBundleDto | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<number | null>(null);

  const [dispatchCodeInput, setDispatchCodeInput] = useState('');
  const [journalText, setJournalText] = useState('');
  const [journalHours, setJournalHours] = useState('');
  const [journalMinutes, setJournalMinutes] = useState('');
  const [lastDispatchMessage, setLastDispatchMessage] = useState('');

  const [isLoading, setIsLoading] = useState(true);
  const [dispatchingVehicleId, setDispatchingVehicleId] = useState<number | null>(null);
  const [isSavingJournal, setIsSavingJournal] = useState(false);

  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');

  const refreshData = useCallback(async () => {
    setIsLoading(true);
    setLoadError('');

    try {
      const vehiclesPromise = apiClient.get<VehicleDictionaryDto[]>('/vehicles');
      const bundlePromise = user?.session_id
        ? apiClient.get<SessionStateBundleDto>(`/sessions/${user.session_id}/state`)
        : Promise.resolve(null);

      const [vehiclesData, bundleData] = await Promise.all([vehiclesPromise, bundlePromise]);
      setVehicles(vehiclesData);
      setBundle(bundleData);
    } catch (error) {
      setLoadError(getErrorMessage(error, 'Не удалось загрузить данные диспетчерской панели'));
    } finally {
      setIsLoading(false);
    }
  }, [user?.session_id]);

  useEffect(() => {
    void refreshData();
  }, [refreshData]);

  useEffect(() => {
    if (!user?.session_id || !realtimeBundle || realtimeSessionId !== user.session_id) {
      return;
    }
    setBundle(realtimeBundle);
  }, [realtimeBundle, realtimeSessionId, user?.session_id]);

  const latestDeploymentByVehicle = useMemo(
    () => getLatestDeploymentByVehicle(bundle?.resource_deployments ?? []),
    [bundle?.resource_deployments],
  );

  const dispatchCodeByVehicle = useMemo(() => buildDispatchCodeByVehicle(vehicles), [vehicles]);

  const preparedVehicles = useMemo<PreparedVehicle[]>(() => {
    return vehicles.map((vehicle) => {
      const latest = latestDeploymentByVehicle.get(vehicle.id);
      const statusMeta = latest ? DEPLOYMENT_STATUS_META[latest.status] : DEFAULT_STATUS_META;
      const sprite = getSpriteByVehicleName(vehicle.name);
      const defaults = VEHICLE_SPEC_DEFAULTS[vehicle.type];

      return {
        ...vehicle,
        crew_size: normalizeVehicleSpec(vehicle.crew_size, defaults.crew_size),
        water_capacity: normalizeVehicleSpec(vehicle.water_capacity, defaults.water_capacity),
        foam_capacity: normalizeVehicleSpec(vehicle.foam_capacity, defaults.foam_capacity),
        hose_length: normalizeVehicleSpec(vehicle.hose_length, defaults.hose_length),
        dispatchCode: dispatchCodeByVehicle.get(vehicle.id) ?? '-------',
        statusLabel: statusMeta.label,
        statusClass: statusMeta.className,
        isBusy: statusMeta.busy,
        typeLabel: TYPE_LABELS[vehicle.type],
        col: sprite.col,
        row: sprite.row,
      };
    });
  }, [dispatchCodeByVehicle, latestDeploymentByVehicle, vehicles]);

  const selectedVehicle = useMemo(
    () => preparedVehicles.find((vehicle) => vehicle.id === selectedVehicleId) ?? null,
    [preparedVehicles, selectedVehicleId],
  );

  const dispatcherJournal = useMemo(
    () => parseDispatcherJournal(bundle?.snapshot?.snapshot_data ?? null),
    [bundle?.snapshot?.snapshot_data],
  );

  const activeFireCount = useMemo(() => countActiveFires(bundle), [bundle]);

  const dispatchVehicle = async (vehicle: PreparedVehicle, dispatchCode: string, etaSeconds: number) => {
    if (!user?.session_id) {
      setActionError('Для отправки техники выберите активную сессию');
      return;
    }
    if (vehicle.isBusy) {
      setActionError('Машина уже на выезде или работает на месте');
      return;
    }

    setDispatchingVehicleId(vehicle.id);
    setActionError('');
    try {
      const normalizedEtaSeconds = Math.max(DISPATCH_ETA_SEC_MIN, Math.min(DISPATCH_ETA_SEC_MAX, Math.round(etaSeconds)));
      const etaAt = new Date(Date.now() + normalizedEtaSeconds * 1000).toISOString();

      await sendRealtimeCommand(
        'create_resource_deployment',
        {
          resource_kind: 'VEHICLE',
          status: 'EN_ROUTE',
          vehicle_dictionary_id: vehicle.id,
          label: vehicle.name,
          geometry_type: 'POINT',
          geometry: { x: 0, y: 0 },
          resource_data: {
            source: 'dispatcher_sidebar',
            role: 'DISPATCHER',
            dispatch_code: dispatchCode,
            dispatch_eta_sec: normalizedEtaSeconds,
            dispatch_eta_min: Math.max(1, Math.ceil(normalizedEtaSeconds / 60)),
            dispatch_eta_at: etaAt,
          },
        },
        user.session_id,
      );
      const etaLabel = formatEtaDuration(normalizedEtaSeconds);
      setLastDispatchMessage(`${vehicle.name} через ~${etaLabel}`);
      setDispatchCodeInput('');
      showBanner(`МАШИНА ${vehicle.name.toUpperCase()} ПРИБУДЕТ ЧЕРЕЗ ~${etaLabel.toUpperCase()}`);
    } catch (error) {
      setActionError(getErrorMessage(error, 'Не удалось отправить технику'));
    } finally {
      setDispatchingVehicleId(null);
    }
  };

  const handleCallVehicle = async () => {
    const normalizedCode = sanitizeDispatchCodeInput(dispatchCodeInput);
    if (normalizedCode.length !== 7) {
      setActionError('Введите 7-символьный код вызова машины');
      return;
    }

    const vehicleByCode = preparedVehicles.find((vehicle) => vehicle.dispatchCode === normalizedCode);
    if (!vehicleByCode) {
      setActionError('Код не найден. Проверьте код машины');
      return;
    }

    if (vehicleByCode.isBusy) {
      setActionError('Машина по этому коду уже в работе');
      return;
    }

    const freeVehicles = preparedVehicles.filter((vehicle) => !vehicle.isBusy);

    const target = freeVehicles.find((vehicle) => vehicle.id === vehicleByCode.id);

    if (!target) {
      setActionError('Свободная машина по коду не найдена');
      return;
    }

    const etaSeconds = resolveDispatchEtaSeconds();
    await dispatchVehicle(target, normalizedCode, etaSeconds);
  };

  const saveJournalEntry = async () => {
    const normalizedText = journalText.trim();
    if (!normalizedText) {
      setActionError('Введите текст для журнала');
      return;
    }
    if (!user?.session_id) {
      setActionError('Для журнала нужна активная сессия');
      return;
    }

    const entryTime = resolveEntryTime(journalHours, journalMinutes);
    const nowIso = new Date().toISOString();

    const newEntry: DispatcherJournalEntry = {
      id: crypto.randomUUID(),
      text: normalizedText,
      time: entryTime,
      created_at: nowIso,
      author: user.username,
    };

    const baseSnapshotData =
      bundle?.snapshot?.snapshot_data && typeof bundle.snapshot.snapshot_data === 'object'
        ? bundle.snapshot.snapshot_data
        : {};
    const nextJournal = [newEntry, ...dispatcherJournal].slice(0, MAX_JOURNAL_ENTRIES);

    const nextSnapshotData: Record<string, unknown> = {
      ...baseSnapshotData,
      dispatcher_journal: nextJournal,
      dispatcher_last_note_at: nowIso,
      dispatcher_last_note_by: user.username,
    };

    setIsSavingJournal(true);
    setActionError('');
    try {
      await sendRealtimeCommand(
        'update_snapshot',
        {
          notes: normalizedText,
          snapshot_data: nextSnapshotData,
        },
        user.session_id,
      );
      setJournalText('');
      setJournalHours(entryTime.split(':')[0]);
      setJournalMinutes(entryTime.split(':')[1]);
      showBanner('ДАННЫЕ СОХРАНЕНЫ!');

      if (bundle?.snapshot) {
        setBundle({
          ...bundle,
          snapshot: {
            ...bundle.snapshot,
            notes: normalizedText,
            snapshot_data: nextSnapshotData,
          },
        });
      }
    } catch (error) {
      setActionError(getErrorMessage(error, 'Не удалось сохранить запись в журнал'));
    } finally {
      setIsSavingJournal(false);
    }
  };

  return (
    <div className="w-[320px] h-full bg-[#2b2b2b] flex flex-col shrink-0 border-r-2 border-black overflow-y-auto custom-scrollbar relative">
      <div className="p-4 flex-1 flex flex-col gap-4">
        <section className="flex flex-col gap-2">
          <div className="grid grid-cols-1 gap-2">
            <PixelInput
              className="w-full h-6"
              value={dispatchCodeInput}
              onChange={(event) => setDispatchCodeInput(sanitizeDispatchCodeInput(event.target.value))}
              placeholder="Код вызова (7 симв.)"
              maxLength={7}
            />
          </div>

          <PixelButton
            variant="green"
            className="w-full text-[10px] py-2"
            onClick={() => {
              void handleCallVehicle();
            }}
            disabled={dispatchingVehicleId !== null || isLoading || preparedVehicles.length === 0}
          >
            {dispatchingVehicleId !== null ? 'ОТПРАВКА...' : 'ПОДТВЕРДИТЬ ВЫЗОВ'}
          </PixelButton>

          {lastDispatchMessage ? (
            <div className="text-[7px] text-green-300 border border-green-700/40 bg-green-700/10 px-2 py-1 normal-case">
              {lastDispatchMessage}
            </div>
          ) : null}

          <div className="text-[7px] text-gray-400 leading-relaxed">
            {bundle?.weather
              ? `Ветер: ${bundle.weather.wind_speed}м/с ${bundle.weather.wind_dir}°`
              : ''}
            {`${bundle?.weather ? ' | ' : ''}Очаги: ${activeFireCount}`}
          </div>

          {loadError ? <div className="text-[8px] text-red-400">{loadError}</div> : null}
          {actionError ? <div className="text-[8px] text-red-400">{actionError}</div> : null}
        </section>

        <section>
          <h2 className="text-[10px] text-white uppercase mb-2 font-pixel flex items-center gap-1">
            МАШИНЫ <span className="text-[8px]">▼</span>
          </h2>
          <div className="flex flex-col gap-2 max-h-[260px] overflow-y-auto pr-1 custom-scrollbar">
            {isLoading ? <div className="text-[8px] text-gray-400">Загрузка техники...</div> : null}

            {preparedVehicles.map((vehicle) => (
              <div key={vehicle.id} className="bg-[#242424] border-2 border-black p-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[7px] uppercase truncate" title={vehicle.name}>{vehicle.name}</span>
                  <StatusIndicator color={vehicle.isBusy ? 'orange' : 'green'} size={6} />
                </div>

                <div className="mt-1 flex items-center justify-between gap-1">
                  <span className="text-[6px] text-cyan-300">КОД: {vehicle.dispatchCode}</span>
                  <div
                    className={`text-[6px] h-4 px-1.5 flex items-center justify-center min-w-[62px] border-2 border-black ${vehicle.statusClass}`}
                  >
                    {vehicle.statusLabel}
                  </div>
                  <PixelButton
                    variant="green"
                    className="text-[6px] h-4 px-1.5 tracking-tighter"
                    onClick={() => setSelectedVehicleId(vehicle.id)}
                  >
                    подробнее
                  </PixelButton>
                </div>
              </div>
            ))}

            {!isLoading && preparedVehicles.length === 0 ? (
              <div className="text-[8px] text-gray-500">Справочник техники пуст</div>
            ) : null}
          </div>
        </section>

        <section>
          <h2 className="text-[10px] text-white uppercase mb-2 font-pixel flex items-center gap-1">
            СПРАВОЧНИК <span className="text-[8px]">▲</span>
          </h2>
          <div className="bg-[#404040] border-2 border-black p-2 text-[7px] leading-relaxed text-gray-100">
            <div>Всего техники: {preparedVehicles.length}</div>
            <div>На выезде: {preparedVehicles.filter((vehicle) => vehicle.isBusy).length}</div>
            <div>В депо: {preparedVehicles.filter((vehicle) => !vehicle.isBusy).length}</div>
            <div>Активных очагов: {activeFireCount}</div>
          </div>
        </section>

        <section className="flex-1 flex flex-col">
          <h2 className="text-[10px] text-white uppercase mb-2 font-pixel flex items-center gap-1">
            ЖУРНАЛ <span className="text-[8px]">▼</span>
          </h2>

          <div className="flex items-center gap-1 mb-2">
            <PixelInput
              className="w-8 h-6 text-center"
              value={journalHours}
              onChange={(event) => setJournalHours(normalizeTwoDigits(event.target.value))}
              placeholder="чч"
            />
            <span className="text-white">:</span>
            <PixelInput
              className="w-8 h-6 text-center"
              value={journalMinutes}
              onChange={(event) => setJournalMinutes(normalizeTwoDigits(event.target.value))}
              placeholder="мм"
            />
          </div>

          <textarea
            className="w-full min-h-[96px] bg-[#404040] text-white border-2 border-black outline-none p-2 text-[8px] font-pixel resize-none mb-2 focus:border-gray-500 transition-colors"
            value={journalText}
            onChange={(event) => setJournalText(event.target.value)}
            placeholder="Добавьте запись в журнал..."
          />

          <div className="w-full flex justify-between items-center gap-2 mb-2">
            <PixelButton
              variant="green"
              className="text-[7px] px-3 py-1"
              disabled={isSavingJournal || !user?.session_id}
              onClick={() => {
                void saveJournalEntry();
              }}
            >
              {isSavingJournal ? 'СОХРАНЕНИЕ...' : 'СОХРАНИТЬ'}
            </PixelButton>
            {bundle?.snapshot?.notes ? (
              <div className="text-[6px] text-gray-300 truncate text-right">последняя: {bundle.snapshot.notes}</div>
            ) : null}
          </div>

          <div className="bg-[#232323] border-2 border-black p-2 text-[7px] text-gray-100 flex-1 min-h-[92px] overflow-y-auto custom-scrollbar">
            {dispatcherJournal.length === 0 ? (
              <div className="text-gray-500">Записи отсутствуют</div>
            ) : (
              <div className="flex flex-col gap-1">
                {dispatcherJournal.slice(0, 10).map((entry) => (
                  <div key={entry.id} className="border-b border-black/40 pb-1">
                    <div className="flex items-center justify-between text-[6px] text-gray-300">
                      <span>{entry.time}</span>
                      <span>{entry.author ?? 'диспетчер'}</span>
                    </div>
                    <div className="mt-0.5 break-words">{entry.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      <PixelModal
        isOpen={selectedVehicleId !== null}
        onClose={() => setSelectedVehicleId(null)}
        title={selectedVehicle?.name}
      >
        {selectedVehicle && (
          <div className="flex flex-col gap-3 font-pixel text-[8px] uppercase">
            <svg viewBox="0 0 553 265" className="w-full border-2 border-black mb-2 bg-[#111]">
              <image
                href="/assets/vehicles_sprite.png"
                width="2212"
                height="1534"
                x={-(selectedVehicle.col * 553)}
                y={-(selectedVehicle.row * 767) - 75}
              />
            </svg>

            <div className="flex justify-between items-center bg-[#202020] p-2 border-2 border-black">
              <span className="text-gray-400">Статус:</span>
              <div className="flex items-center gap-2">
                <span className={selectedVehicle.isBusy ? 'text-orange-400' : 'text-green-400'}>
                  {selectedVehicle.statusLabel}
                </span>
                <StatusIndicator color={selectedVehicle.isBusy ? 'orange' : 'green'} />
              </div>
            </div>

            <div className="flex justify-between items-center border-b border-gray-600 pb-1">
              <span className="text-gray-400">Тип:</span>
              <span>{selectedVehicle.typeLabel}</span>
            </div>
            <div className="flex justify-between items-center border-b border-gray-600 pb-1">
              <span className="text-gray-400">Экипаж:</span>
              <span>{selectedVehicle.crew_size ?? 0} чел.</span>
            </div>
            <div className="flex justify-between items-center border-b border-gray-600 pb-1">
              <span className="text-gray-400">Запас воды:</span>
              <span>{selectedVehicle.water_capacity ?? 0} л</span>
            </div>
            <div className="flex justify-between items-center border-b border-gray-600 pb-1">
              <span className="text-gray-400">Пена:</span>
              <span>{selectedVehicle.foam_capacity ?? 0} л</span>
            </div>
            <div className="flex justify-between items-center border-b border-gray-600 pb-1">
              <span className="text-gray-400">Рукава:</span>
              <span>{selectedVehicle.hose_length ?? 0} м</span>
            </div>

            <div className="flex justify-between items-center border-b border-gray-600 pb-1">
              <span className="text-gray-400">Код вызова:</span>
              <span className="text-cyan-300">{selectedVehicle.dispatchCode}</span>
            </div>

            <div className="text-[7px] text-gray-300 normal-case border border-black/40 bg-black/20 px-2 py-1">
              Отправка машины выполняется только через ввод кода вызова в верхнем блоке.
            </div>

            <div className="flex gap-2 mt-2">
              <PixelButton
                variant="active"
                className="w-full text-[7px]"
                onClick={() => setSelectedVehicleId(null)}
              >
                ЗАКРЫТЬ
              </PixelButton>
            </div>
          </div>
        )}
      </PixelModal>
    </div>
  );
};
