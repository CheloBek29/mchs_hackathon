import React, { useEffect, useMemo, useState } from 'react';
import { PixelButton } from '../../shared/ui/PixelButton';
import { StatusIndicator } from '../../shared/ui/StatusIndicator';
import {
  useVehicleRuntime,
  type VehicleRuntimeItem,
} from '../Vehicles/model/useVehicleRuntime';
import { FireMetricsHUD } from '../../widgets/FireMetricsHUD/FireMetricsHUD';
import { SimViewPanel } from '../../shared/visualization/SimViewPanel';
import { useRealtimeStore } from '../../store/useRealtimeStore';
import { useTacticalStore } from '../../store/useTacticalStore';

type IncomingVehicleInfo = {
  vehicle: VehicleRuntimeItem;
  etaSeconds: number | null;
};

const parseFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

const resolveEtaSeconds = (vehicle: VehicleRuntimeItem, nowTimestamp = Date.now()): number | null => {
  const resourceData = vehicle.latestDeployment?.resource_data;
  if (!resourceData || typeof resourceData !== 'object') {
    return null;
  }

  const raw = resourceData as Record<string, unknown>;
  const etaAtRaw = raw.dispatch_eta_at;
  if (typeof etaAtRaw === 'string') {
    const etaTimestamp = new Date(etaAtRaw).getTime();
    if (Number.isFinite(etaTimestamp)) {
      const deltaSeconds = Math.ceil((etaTimestamp - nowTimestamp) / 1000);
      return Math.max(0, deltaSeconds);
    }
  }

  const etaSec = parseFiniteNumber(raw.dispatch_eta_sec);
  if (etaSec !== null) {
    return Math.max(0, Math.round(etaSec));
  }

  const etaMin = parseFiniteNumber(raw.dispatch_eta_min);
  if (etaMin !== null) {
    return Math.max(0, Math.round(etaMin * 60));
  }

  return null;
};

const formatEtaLabel = (etaSeconds: number | null): string => {
  if (etaSeconds === null) {
    return 'Машина в пути';
  }

  if (etaSeconds < 60) {
    return `Прибытие через ~${etaSeconds} сек`;
  }

  const minutes = Math.floor(etaSeconds / 60);
  const seconds = etaSeconds % 60;
  if (seconds === 0) {
    return `Прибытие через ~${minutes} мин`;
  }
  return `Прибытие через ~${minutes} мин ${seconds} сек`;
};

export const RtpSidebar: React.FC = () => {
  const {
    sessionId,
    bundle,
    vehicles,
    isLoading,
    loadError,
  } = useVehicleRuntime();
  const pendingPlacement = useTacticalStore((state) => state.pendingPlacement);
  const setPendingPlacement = useTacticalStore((state) => state.setPendingPlacement);
  const clearPendingPlacement = useTacticalStore((state) => state.clearPendingPlacement);
  const showTransientMessage = useTacticalStore((state) => state.showTransientMessage);
  const realtimeBundle = useRealtimeStore((state) => state.bundle);

  const [actionError, setActionError] = useState('');
  const [clockTick, setClockTick] = useState(() => Date.now());

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setClockTick(Date.now());
    }, 15_000);
    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  const activeFireCount = useMemo(() => {
    if (!bundle) {
      return 0;
    }
    return bundle.fire_objects.filter((fireObject) => fireObject.is_active).length;
  }, [bundle]);

  const incomingVehicles = useMemo<IncomingVehicleInfo[]>(() => {
    return vehicles
      .filter((vehicle) => vehicle.statusKey === 'PLANNED' || vehicle.statusKey === 'EN_ROUTE')
      .map((vehicle) => ({
        vehicle,
        etaSeconds: resolveEtaSeconds(vehicle, clockTick),
      }))
      .filter(({ vehicle, etaSeconds }) => {
        if (vehicle.statusKey !== 'EN_ROUTE') {
          return true;
        }
        return etaSeconds === null || etaSeconds > 0;
      })
      .sort((left, right) => {
        const leftEta = left.etaSeconds;
        const rightEta = right.etaSeconds;
        if (leftEta !== null && rightEta !== null) {
          return leftEta - rightEta;
        }
        if (leftEta !== null) {
          return -1;
        }
        if (rightEta !== null) {
          return 1;
        }
        return left.vehicle.name.localeCompare(right.vehicle.name, 'ru');
      });
  }, [clockTick, vehicles]);

  const arrivedVehicles = useMemo(() => {
    return vehicles.filter((vehicle) => {
      if (vehicle.statusKey === 'DEPLOYED' || vehicle.statusKey === 'ACTIVE') {
        return true;
      }
      if (vehicle.statusKey === 'EN_ROUTE') {
        const etaSeconds = resolveEtaSeconds(vehicle, clockTick);
        return etaSeconds !== null && etaSeconds <= 0;
      }
      return false;
    });
  }, [clockTick, vehicles]);

  const hasArrivedVehicles = arrivedVehicles.length > 0;
  const pendingPlacementIsRtp = pendingPlacement?.source === 'rtp_sidebar';

  const requestCommandPointPlacement = (label: string, commandPoint: 'HQ' | 'BU1' | 'BU2') => {
    if (!sessionId) {
      setActionError('Для размещения нужна активная сессия');
      return;
    }

    if (!hasArrivedVehicles) {
      setActionError('Командные точки создаются после поступления первой машины');
      return;
    }

    setActionError('');

    if (
      pendingPlacement &&
      pendingPlacement.source === 'rtp_sidebar' &&
      pendingPlacement.resourceKind === 'MARKER' &&
      pendingPlacement.label === label
    ) {
      clearPendingPlacement();
      return;
    }

    setPendingPlacement({
      resourceKind: 'MARKER',
      geometryType: 'POINT',
      label,
      status: 'DEPLOYED',
      source: 'rtp_sidebar',
      roleLabel: 'РТП',
      resourceData: {
        role: 'RTP',
        command_point: commandPoint,
      },
    });
    showTransientMessage(`РТП: выберите точку на карте для ${label.toUpperCase()}`);
  };

  return (
    <div className="w-[320px] h-full bg-[#2b2b2b] flex flex-col shrink-0 border-r-2 border-black overflow-y-auto custom-scrollbar relative">
      <div className="p-4 flex-1 flex flex-col gap-5">
        <section className="space-y-2">
          <div className="bg-[#404040] border-2 border-black p-2 text-[7px] text-gray-100 leading-relaxed">
            <div>Очагов: {activeFireCount}</div>
            <div>В пути: {incomingVehicles.length}</div>
            <div>Поступило: {arrivedVehicles.length}</div>
          </div>

          {pendingPlacementIsRtp && pendingPlacement ? (
            <div className="bg-[#1f3a1b] border border-[#2f6f24] px-2 py-1 text-[7px] text-green-200 flex items-center justify-between gap-2">
              <span className="truncate">Размещение: {pendingPlacement.label}</span>
              <PixelButton
                size="sm"
                className="text-[6px] px-2"
                onClick={clearPendingPlacement}
              >
                ОТМЕНА
              </PixelButton>
            </div>
          ) : null}

          {loadError ? <div className="text-[8px] text-red-400">{loadError}</div> : null}
          {actionError ? <div className="text-[8px] text-red-400">{actionError}</div> : null}
        </section>

        <FireMetricsHUD bundle={realtimeBundle} />

        <SimViewPanel bundle={realtimeBundle} title="РТП — ОБСТАНОВКА" heightClass="h-[190px]" />

        <section>
          <h2 className="text-[10px] text-white uppercase mb-2 font-pixel flex items-center gap-1">
            ПОСТУПЛЕНИЕ ТЕХНИКИ <span className="text-[8px]">▼</span>
          </h2>

          {!isLoading && !hasArrivedVehicles && incomingVehicles.length === 0 ? (
            <div className="bg-[#202020] border-2 border-black p-2 text-[8px] text-gray-300 uppercase">
              ОЖИДАНИЕ ПОСТУПЛЕНИЯ МАШИНЫ
            </div>
          ) : null}

          <div className="flex flex-col gap-2 max-h-[220px] overflow-y-auto custom-scrollbar pr-1">
            {isLoading ? <div className="text-[8px] text-gray-400">Загрузка техники...</div> : null}

            {incomingVehicles.map(({ vehicle, etaSeconds }) => (
              <div key={vehicle.id} className="bg-[#242424] border-2 border-black p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[7px] uppercase truncate" title={vehicle.name}>{vehicle.name}</span>
                  <StatusIndicator color="orange" size={6} />
                </div>
                <div className="mt-1 text-[6px] text-gray-300 uppercase">
                  {formatEtaLabel(etaSeconds)}
                </div>
              </div>
            ))}

            {arrivedVehicles.map((vehicle) => (
              <div key={`arrived-${vehicle.id}`} className="bg-[#1f3a1b] border border-[#2f6f24] p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[7px] uppercase text-green-200 truncate" title={vehicle.name}>{vehicle.name}</span>
                  <StatusIndicator color="green" size={6} />
                </div>
                <div className="mt-1 text-[6px] text-green-100 uppercase">Поступила в распоряжение РТП</div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-[10px] text-white uppercase mb-2 font-pixel flex items-center gap-1">
            ШТАБ И БУ <span className="text-[8px]">▼</span>
          </h2>

          <div className="grid grid-cols-3 gap-2">
            <PixelButton
              className="text-[7px]"
              disabled={!sessionId || !hasArrivedVehicles}
              onClick={() => {
                requestCommandPointPlacement('ШТАБ', 'HQ');
              }}
            >
              ШТАБ
            </PixelButton>
            <PixelButton
              className="text-[7px]"
              disabled={!sessionId || !hasArrivedVehicles}
              onClick={() => {
                requestCommandPointPlacement('БУ-1', 'BU1');
              }}
            >
              БУ-1
            </PixelButton>
            <PixelButton
              className="text-[7px]"
              disabled={!sessionId || !hasArrivedVehicles}
              onClick={() => {
                requestCommandPointPlacement('БУ-2', 'BU2');
              }}
            >
              БУ-2
            </PixelButton>
          </div>
        </section>

        <section className="bg-[#202020] border-2 border-black p-2 text-[7px] text-gray-300 uppercase leading-relaxed">
          Тушение и расстановка техники выполняются в БУ-1/БУ-2 после постановки командных точек.
        </section>
      </div>
    </div>
  );
};
