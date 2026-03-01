import React, { useEffect, useMemo, useState } from 'react';
import { PixelButton } from '../../shared/ui/PixelButton';
import { StatusIndicator } from '../../shared/ui/StatusIndicator';
import type { DeploymentStatus, GeometryType, ResourceKind } from '../../shared/api/types';
import {
  useVehicleRuntime,
  type VehicleRuntimeItem,
  type VehicleStatusKey,
} from '../Vehicles/model/useVehicleRuntime';
import { VehicleDetailsModal } from '../Vehicles/ui/VehicleDetailsModal';
import { useTacticalStore } from '../../store/useTacticalStore';
import { useRealtimeStore } from '../../store/useRealtimeStore';

interface BuSidebarProps {
  areaLabel?: string;
}

type BuAction = {
  label: string;
  nextStatus: DeploymentStatus | null;
  variant: 'default' | 'green';
  disabled?: boolean;
};

type IncomingVehicleInfo = {
  vehicle: VehicleRuntimeItem;
  etaSeconds: number | null;
  isArrived: boolean;
};

const BU_ACTION_BY_STATUS: Record<VehicleStatusKey, BuAction> = {
  IDLE: { label: 'ПОСТАВИТЬ', nextStatus: 'DEPLOYED', variant: 'green' },
  PLANNED: { label: 'В ПУТИ', nextStatus: null, variant: 'default', disabled: true },
  EN_ROUTE: { label: 'ПРИНЯТЬ', nextStatus: 'DEPLOYED', variant: 'green' },
  DEPLOYED: { label: 'СТВОЛ', nextStatus: 'ACTIVE', variant: 'green' },
  ACTIVE: { label: 'СНЯТЬ', nextStatus: 'COMPLETED', variant: 'default' },
  COMPLETED: { label: 'ПОСТАВИТЬ', nextStatus: 'DEPLOYED', variant: 'green' },
};

const normalizeRoleTag = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value.trim().toUpperCase();
  if (normalized === 'БУ - 1' || normalized === 'БУ1' || normalized === 'COMBAT_AREA_1') {
    return 'BU1';
  }
  if (normalized === 'БУ - 2' || normalized === 'БУ2' || normalized === 'COMBAT_AREA_2') {
    return 'BU2';
  }
  return normalized;
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

export const BuSidebar: React.FC<BuSidebarProps> = ({ areaLabel = 'БУ' }) => {
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
  const sendRealtimeCommand = useRealtimeStore((state) => state.sendCommand);

  const [selectedVehicleId, setSelectedVehicleId] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');
  const [claimingVehicleId, setClaimingVehicleId] = useState<number | null>(null);
  const [clockTick, setClockTick] = useState(() => Date.now());

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setClockTick(Date.now());
    }, 15_000);
    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  const areaRoleTag = areaLabel === 'БУ - 1' ? 'BU1' : areaLabel === 'БУ - 2' ? 'BU2' : '';

  const areaScopedVehicles = useMemo(() => {
    if (!areaRoleTag) {
      return vehicles;
    }

    return vehicles.filter((vehicle) => {
      const resourceData = vehicle.latestDeployment?.resource_data;
      const raw = resourceData && typeof resourceData === 'object'
        ? (resourceData as Record<string, unknown>)
        : null;
      const roleTag = normalizeRoleTag(raw?.role);

      if (roleTag === 'BU1' || roleTag === 'BU2') {
        return roleTag === areaRoleTag;
      }

      return vehicle.statusKey === 'DEPLOYED' || vehicle.statusKey === 'ACTIVE';
    });
  }, [areaRoleTag, vehicles]);

  const areaStatusCounts = useMemo(() => {
    const counts: Record<VehicleStatusKey, number> = {
      IDLE: 0,
      PLANNED: 0,
      EN_ROUTE: 0,
      DEPLOYED: 0,
      ACTIVE: 0,
      COMPLETED: 0,
    };

    areaScopedVehicles.forEach((vehicle) => {
      counts[vehicle.statusKey] += 1;
    });

    return counts;
  }, [areaScopedVehicles]);

  const incomingVehicles = useMemo<IncomingVehicleInfo[]>(() => {
    return vehicles
      .filter((vehicle) => vehicle.statusKey === 'PLANNED' || vehicle.statusKey === 'EN_ROUTE')
      .map((vehicle) => {
        const etaSeconds = resolveEtaSeconds(vehicle, clockTick);
        const isArrived = vehicle.statusKey === 'EN_ROUTE' && etaSeconds !== null && etaSeconds <= 0;
        return {
          vehicle,
          etaSeconds,
          isArrived,
        };
      })
      .sort((left, right) => {
        if (left.isArrived && !right.isArrived) {
          return -1;
        }
        if (!left.isArrived && right.isArrived) {
          return 1;
        }

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

  const incomingStats = useMemo(() => {
    let waiting = 0;
    let arrived = 0;

    incomingVehicles.forEach((item) => {
      if (item.isArrived) {
        arrived += 1;
      } else {
        waiting += 1;
      }
    });

    return {
      waiting,
      arrived,
    };
  }, [incomingVehicles]);

  const areaCrewCapacity = useMemo(() => {
    return areaScopedVehicles
      .filter((vehicle) => vehicle.statusKey === 'DEPLOYED' || vehicle.statusKey === 'ACTIVE')
      .reduce((sum, vehicle) => sum + Math.max(0, vehicle.crew_size ?? 0), 0);
  }, [areaScopedVehicles]);

  const areaActiveHoseLines = useMemo(() => {
    const deployments = bundle?.resource_deployments ?? [];
    return deployments.filter((deployment) => {
      if (deployment.resource_kind !== 'HOSE_LINE' || deployment.status === 'COMPLETED') {
        return false;
      }
      const resourceData = deployment.resource_data;
      if (!resourceData || typeof resourceData !== 'object') {
        return false;
      }
      const raw = resourceData as Record<string, unknown>;
      const roleTag = normalizeRoleTag(raw.role);
      return roleTag === areaRoleTag;
    }).length;
  }, [areaRoleTag, bundle?.resource_deployments]);

  const availableHoseTeams = useMemo(() => {
    return Math.max(0, Math.floor(areaCrewCapacity / 2) - areaActiveHoseLines);
  }, [areaActiveHoseLines, areaCrewCapacity]);

  const selectedVehicle = useMemo(
    () => vehicles.find((vehicle) => vehicle.id === selectedVehicleId) ?? null,
    [selectedVehicleId, vehicles],
  );

  const selectedVehicleRoleTag = useMemo(() => {
    const resourceData = selectedVehicle?.latestDeployment?.resource_data;
    if (!resourceData || typeof resourceData !== 'object') {
      return '';
    }
    return normalizeRoleTag((resourceData as Record<string, unknown>).role);
  }, [selectedVehicle?.latestDeployment?.resource_data]);

  const selectedVehicleIsAssignedToArea = useMemo(() => {
    if (!selectedVehicle || !areaRoleTag) {
      return false;
    }
    return selectedVehicleRoleTag === areaRoleTag;
  }, [areaRoleTag, selectedVehicle, selectedVehicleRoleTag]);

  const selectedVehicleCanAcceptFromArrival = useMemo(() => {
    if (!selectedVehicle || selectedVehicle.statusKey !== 'EN_ROUTE') {
      return false;
    }
    const etaSeconds = resolveEtaSeconds(selectedVehicle, clockTick);
    return etaSeconds !== null && etaSeconds <= 0;
  }, [clockTick, selectedVehicle]);

  const selectedVehicleCanPrimaryAction = useMemo(() => {
    if (!selectedVehicle || !sessionId) {
      return false;
    }
    const action = BU_ACTION_BY_STATUS[selectedVehicle.statusKey];
    if (action.disabled || !action.nextStatus) {
      return false;
    }
    if (selectedVehicleIsAssignedToArea) {
      return true;
    }
    return selectedVehicleCanAcceptFromArrival;
  }, [
    selectedVehicle,
    selectedVehicleCanAcceptFromArrival,
    selectedVehicleIsAssignedToArea,
    sessionId,
  ]);

  const pendingPlacementIsBu = pendingPlacement?.source === 'combat_area_sidebar';

  const requestBuUtilityPlacement = (
    resourceKind: ResourceKind,
    geometryType: GeometryType,
    label: string,
    status: DeploymentStatus,
  ) => {
    if (!sessionId) {
      setActionError('Для размещения ресурсов нужна активная сессия');
      return;
    }

    setActionError('');

    if (resourceKind === 'HOSE_LINE' && availableHoseTeams <= 0) {
      setActionError('Недостаточно расчета на рукав: требуется 2 человека на каждую линию');
      return;
    }

    if (
      pendingPlacement &&
      pendingPlacement.source === 'combat_area_sidebar' &&
      pendingPlacement.roleLabel === areaLabel &&
      pendingPlacement.resourceKind === resourceKind &&
      pendingPlacement.label === label
    ) {
      clearPendingPlacement();
      return;
    }

    setPendingPlacement({
      resourceKind,
      geometryType,
      label,
      status,
      source: 'combat_area_sidebar',
      roleLabel: areaLabel,
      resourceData: {
        role: areaLabel,
        tactical_tool: resourceKind,
        crew_required: resourceKind === 'HOSE_LINE' ? 2 : undefined,
        hose_type: resourceKind === 'HOSE_LINE' ? label : undefined,
      },
    });

    const stepHint = geometryType === 'LINESTRING' ? 'укажите 2 точки на карте' : 'выберите точку на карте';
    showTransientMessage(`${areaLabel}: ${label.toUpperCase()} - ${stepHint}`);
  };

  const requestBuPlacement = (vehicle: VehicleRuntimeItem) => {
    if (!sessionId) {
      setActionError('Для размещения техники нужна активная сессия');
      return;
    }

    const action = BU_ACTION_BY_STATUS[vehicle.statusKey];
    if (!action.nextStatus || action.disabled) {
      return;
    }

    setActionError('');

    if (
      pendingPlacement &&
      pendingPlacement.source === 'combat_area_sidebar' &&
      pendingPlacement.roleLabel === areaLabel &&
      pendingPlacement.vehicleId === vehicle.id &&
      pendingPlacement.status === action.nextStatus
    ) {
      clearPendingPlacement();
      return;
    }

    setPendingPlacement({
      resourceKind: 'VEHICLE',
      geometryType: 'POINT',
      vehicleId: vehicle.id,
      label: vehicle.name,
      status: action.nextStatus,
      source: 'combat_area_sidebar',
      roleLabel: areaLabel,
      resourceData: {
        role: areaLabel,
        previous_status: vehicle.statusKey,
        target_status: action.nextStatus,
      },
    });
    showTransientMessage(`${areaLabel}: выберите точку на карте для ${vehicle.name.toUpperCase()}`);
  };

  const claimVehicleToArea = async (vehicle: VehicleRuntimeItem) => {
    if (!sessionId) {
      setActionError('Для принятия техники нужна активная сессия');
      return;
    }

    if (vehicle.statusKey !== 'DEPLOYED' && vehicle.statusKey !== 'ACTIVE') {
      setActionError('В участок можно принять только поступившую технику');
      return;
    }

    const latestDeployment = vehicle.latestDeployment;
    if (!latestDeployment) {
      setActionError('Не найдены данные о текущем положении техники');
      return;
    }

    setActionError('');
    setClaimingVehicleId(vehicle.id);

    try {
      await sendRealtimeCommand(
        'create_resource_deployment',
        {
          resource_kind: 'VEHICLE',
          status: vehicle.statusKey,
          vehicle_dictionary_id: vehicle.id,
          label: vehicle.name,
          geometry_type: latestDeployment.geometry_type,
          geometry: latestDeployment.geometry,
          rotation_deg: latestDeployment.rotation_deg,
          resource_data: {
            ...(latestDeployment.resource_data ?? {}),
            source: 'combat_area_claim',
            role: areaLabel,
            previous_status: vehicle.statusKey,
            target_status: vehicle.statusKey,
          },
        },
        sessionId,
      );

      showTransientMessage(`${areaLabel}: ${vehicle.name.toUpperCase()} принят в участок`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Не удалось принять машину в участок');
    } finally {
      setClaimingVehicleId(null);
    }
  };

  return (
    <div className="w-[320px] h-full bg-[#2b2b2b] flex flex-col shrink-0 border-r-2 border-black overflow-y-auto custom-scrollbar relative">
      <div className="p-4 flex-1 flex flex-col gap-5">
        <section className="space-y-2">
          <div className="text-[10px] uppercase text-white">{areaLabel} - техника участка</div>

          <div className="bg-[#404040] border-2 border-black p-2 text-[7px] text-gray-100 leading-relaxed">
            <div>Техника участка: {areaScopedVehicles.length}</div>
            <div>Свободно: {areaStatusCounts.IDLE + areaStatusCounts.COMPLETED}</div>
            <div>В пути: {areaStatusCounts.PLANNED + areaStatusCounts.EN_ROUTE}</div>
            <div>На позиции: {areaStatusCounts.DEPLOYED + areaStatusCounts.ACTIVE}</div>
            <div>Ожидается прибытие: {incomingStats.waiting}</div>
            <div>Поступило к приему: {incomingStats.arrived}</div>
            <div>Расчетов на рукава: {availableHoseTeams}</div>
          </div>

          {pendingPlacementIsBu && pendingPlacement?.roleLabel === areaLabel ? (
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

        <section>
          <h2 className="text-[10px] text-white uppercase mb-2 font-pixel flex items-center gap-1">
            ПОСТУПЛЕНИЕ ТЕХНИКИ <span className="text-[8px]">▼</span>
          </h2>

          <div className="flex flex-col gap-2 max-h-[210px] overflow-y-auto custom-scrollbar pr-1">
            {isLoading ? <div className="text-[8px] text-gray-400">Загрузка поступления...</div> : null}

            {incomingVehicles.map(({ vehicle, etaSeconds, isArrived }) => {
              const isPendingVehiclePlacement =
                pendingPlacement?.source === 'combat_area_sidebar' &&
                pendingPlacement.roleLabel === areaLabel &&
                pendingPlacement.vehicleId === vehicle.id;

              return (
                <div
                  key={`incoming-${vehicle.id}`}
                  className={isArrived ? 'bg-[#1f3a1b] border border-[#2f6f24] p-2' : 'bg-[#242424] border-2 border-black p-2'}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-[7px] uppercase truncate ${isArrived ? 'text-green-200' : 'text-white'}`}
                      title={vehicle.name}
                    >
                      {vehicle.name}
                    </span>
                    <StatusIndicator color={isArrived ? 'green' : 'orange'} size={6} />
                  </div>

                  <div className={`mt-1 text-[6px] uppercase ${isArrived ? 'text-green-100' : 'text-gray-300'}`}>
                    {isArrived
                      ? 'Машина прибыла. Поставьте на позицию участка.'
                      : formatEtaLabel(etaSeconds)}
                  </div>

                  <div className="mt-1 flex items-center justify-between gap-1">
                    <PixelButton
                      variant={isArrived ? 'green' : 'default'}
                      className="text-[6px] h-4 px-1.5 tracking-tight"
                      disabled={!sessionId || !isArrived}
                      onClick={() => {
                        requestBuPlacement(vehicle);
                      }}
                    >
                      {isPendingVehiclePlacement ? 'ВЫБРАТЬ ТОЧКУ' : isArrived ? 'ПРИНЯТЬ' : 'ОЖИДАНИЕ'}
                    </PixelButton>
                    <PixelButton
                      variant="default"
                      className="text-[6px] h-4 px-1.5 tracking-tight"
                      onClick={() => setSelectedVehicleId(vehicle.id)}
                    >
                      данные
                    </PixelButton>
                  </div>
                </div>
              );
            })}

            {!isLoading && incomingVehicles.length === 0 ? (
              <div className="text-[8px] text-gray-500">Нет поступающей техники</div>
            ) : null}
          </div>
        </section>

        <section>
          <h2 className="text-[10px] text-white uppercase mb-3 font-pixel flex items-center gap-1">
            РАЗМЕЩЕНИЕ НА КАРТЕ <span className="text-[8px]">▼</span>
          </h2>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[8px] uppercase">Рукавная линия</span>
              <div className="flex items-center gap-1">
                <StatusIndicator color="line" />
                <PixelButton
                  size="sm"
                  className="text-[6px] px-2"
                  disabled={!sessionId || availableHoseTeams <= 0}
                  onClick={() => {
                    requestBuUtilityPlacement('HOSE_LINE', 'LINESTRING', `РУКАВ ${areaLabel}`, 'ACTIVE');
                  }}
                >
                  РАЗМЕСТИТЬ
                </PixelButton>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-[8px] uppercase">Ствол</span>
              <div className="flex items-center gap-1">
                <StatusIndicator color="green" />
                <PixelButton
                  size="sm"
                  className="text-[6px] px-2"
                  disabled={!sessionId}
                  onClick={() => {
                    requestBuUtilityPlacement('NOZZLE', 'POINT', `СТВОЛ ${areaLabel}`, 'ACTIVE');
                  }}
                >
                  РАЗМЕСТИТЬ
                </PixelButton>
              </div>
            </div>

            <div className="text-[7px] text-gray-400">
              Доступно расчетов на рукава: {availableHoseTeams}
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-[10px] text-white uppercase mb-3 font-pixel flex items-center gap-1">
            МАШИНЫ <span className="text-[8px]">▼</span>
          </h2>
          <div className="flex flex-col gap-2 max-h-[380px] overflow-y-auto custom-scrollbar pr-1">
            {isLoading ? <div className="text-[8px] text-gray-400">Загрузка техники...</div> : null}

            {areaScopedVehicles.map((vehicle) => {
              const action = BU_ACTION_BY_STATUS[vehicle.statusKey];
              const vehicleRoleTag = normalizeRoleTag(
                vehicle.latestDeployment?.resource_data && typeof vehicle.latestDeployment.resource_data === 'object'
                  ? (vehicle.latestDeployment.resource_data as Record<string, unknown>).role
                  : '',
              );
              const isAssignedToArea = vehicleRoleTag === areaRoleTag;
              const canClaimVehicle = !isAssignedToArea && (vehicle.statusKey === 'DEPLOYED' || vehicle.statusKey === 'ACTIVE');

              return (
                <div key={vehicle.id} className="bg-[#242424] border-2 border-black p-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[7px] uppercase truncate" title={vehicle.name}>{vehicle.name}</span>
                    <StatusIndicator color={vehicle.indicatorColor} size={6} />
                  </div>

                  <div className="mt-1 flex items-center justify-between gap-1">
                    <div className={`text-[6px] h-4 px-1.5 flex items-center justify-center min-w-[66px] border-2 border-black ${vehicle.statusClassName}`}>
                      {vehicle.statusLabel}
                    </div>
                    <PixelButton
                      variant={canClaimVehicle ? 'green' : action.variant}
                      className="text-[6px] h-4 px-1.5 tracking-tight"
                      disabled={
                        canClaimVehicle
                          ? !sessionId || claimingVehicleId === vehicle.id
                          : action.disabled || !sessionId || !isAssignedToArea
                      }
                      onClick={() => {
                        if (canClaimVehicle) {
                          void claimVehicleToArea(vehicle);
                          return;
                        }
                        requestBuPlacement(vehicle);
                      }}
                    >
                      {canClaimVehicle
                        ? claimingVehicleId === vehicle.id
                          ? 'ПРИНЯТИЕ...'
                          : 'ВЗЯТЬ В БУ'
                        : pendingPlacement?.source === 'combat_area_sidebar' && pendingPlacement.vehicleId === vehicle.id
                          ? 'ВЫБРАТЬ ТОЧКУ'
                          : action.label}
                    </PixelButton>
                    <PixelButton
                      variant="default"
                      className="text-[6px] h-4 px-1.5 tracking-tight"
                      onClick={() => setSelectedVehicleId(vehicle.id)}
                    >
                      данные
                    </PixelButton>
                  </div>
                </div>
              );
            })}

            {!isLoading && areaScopedVehicles.length === 0 ? (
              <div className="text-[8px] text-gray-500">Нет поступившей техники для участка</div>
            ) : null}
          </div>
        </section>
      </div>

      <VehicleDetailsModal
        isOpen={selectedVehicleId !== null}
        onClose={() => setSelectedVehicleId(null)}
        vehicle={selectedVehicle}
        primaryActionLabel={selectedVehicle ? BU_ACTION_BY_STATUS[selectedVehicle.statusKey].label : undefined}
        primaryActionDisabled={!selectedVehicleCanPrimaryAction}
        primaryActionLoading={false}
        onPrimaryAction={(vehicle) => {
          requestBuPlacement(vehicle);
        }}
      />
    </div>
  );
};
