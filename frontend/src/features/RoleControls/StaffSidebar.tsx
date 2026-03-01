import React, { useMemo, useState } from 'react';
import type { DeploymentStatus, GeometryType, HoseType, ResourceKind } from '../../shared/api/types';
import { PixelButton } from '../../shared/ui/PixelButton';
import { StatusIndicator } from '../../shared/ui/StatusIndicator';
import { useVehicleRuntime } from '../Vehicles/model/useVehicleRuntime';
import { useRealtimeStore } from '../../store/useRealtimeStore';
import { useTacticalStore } from '../../store/useTacticalStore';
import { SimViewPanel } from '../../shared/visualization/SimViewPanel';
import { FireTimelineChart } from '../../widgets/FireTimelineChart/FireTimelineChart';

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
  if (normalized === 'ШТАБ' || normalized === 'HQ') {
    return 'HQ';
  }
  if (normalized === 'РТП' || normalized === 'RTP') {
    return 'RTP';
  }
  if (normalized === 'ДИСПЕТЧЕР' || normalized === 'DISPATCHER') {
    return 'DISPATCHER';
  }
  return normalized;
};

export const StaffSidebar: React.FC = () => {
  const {
    sessionId,
    bundle,
    vehicles,
    isLoading,
    loadError,
  } = useVehicleRuntime();
  const realtimeBundle = useRealtimeStore((state) => state.bundle);
  const pendingPlacement = useTacticalStore((state) => state.pendingPlacement);
  const setPendingPlacement = useTacticalStore((state) => state.setPendingPlacement);
  const clearPendingPlacement = useTacticalStore((state) => state.clearPendingPlacement);
  const showTransientMessage = useTacticalStore((state) => state.showTransientMessage);

  const [selectedHoseType, setSelectedHoseType] = useState<HoseType>('H51');
  const [actionError, setActionError] = useState('');

  const activeFireCount = useMemo(() => {
    if (!bundle) {
      return 0;
    }
    return bundle.fire_objects.filter((fireObject) => fireObject.is_active).length;
  }, [bundle]);

  const coordinationDeployments = useMemo(
    () => bundle?.resource_deployments ?? [],
    [bundle?.resource_deployments],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {
      PLANNED: 0,
      EN_ROUTE: 0,
      DEPLOYED: 0,
      ACTIVE: 0,
      COMPLETED: 0,
    };

    coordinationDeployments
      .filter((deployment) => deployment.resource_kind === 'VEHICLE')
      .forEach((deployment) => {
        counts[deployment.status] += 1;
      });

    return counts;
  }, [coordinationDeployments]);

  const pendingPlacementIsHq = pendingPlacement?.source === 'staff_sidebar';

  const requestHqUtilityPlacement = (
    resourceKind: ResourceKind,
    geometryType: GeometryType,
    label: string,
    status: DeploymentStatus,
  ) => {
    if (!sessionId) {
      setActionError('Для разметки нужна активная сессия');
      return;
    }

    setActionError('');

    if (
      pendingPlacement
      && pendingPlacement.source === 'staff_sidebar'
      && pendingPlacement.resourceKind === resourceKind
      && pendingPlacement.label === label
    ) {
      clearPendingPlacement();
      return;
    }

    setPendingPlacement({
      resourceKind,
      geometryType,
      label,
      status,
      source: 'staff_sidebar',
      roleLabel: 'ШТАБ',
      resourceData: {
        role: 'HQ',
        plan_only: true,
        map_markup: true,
        tactical_tool: resourceKind,
        hose_type: resourceKind === 'HOSE_LINE' ? selectedHoseType : undefined,
        spray_angle: resourceKind === 'NOZZLE' ? 0 : undefined,
        pressure: resourceKind === 'NOZZLE' ? 60 : undefined,
      },
    });

    const stepHint = geometryType === 'LINESTRING' ? 'укажите 2 точки на карте' : 'выберите точку на карте';
    showTransientMessage(`ШТАБ: ${label.toUpperCase()} - ${stepHint}`);
  };

  const requestHqVehicleMarker = (vehicleId: number, vehicleName: string) => {
    if (!sessionId) {
      setActionError('Для разметки нужна активная сессия');
      return;
    }

    setActionError('');
    const label = `МЕТКА ${vehicleName}`;

    if (
      pendingPlacement
      && pendingPlacement.source === 'staff_sidebar'
      && pendingPlacement.resourceKind === 'VEHICLE'
      && pendingPlacement.resourceData
      && typeof pendingPlacement.resourceData === 'object'
      && (pendingPlacement.resourceData as Record<string, unknown>).vehicle_source_id === vehicleId
    ) {
      clearPendingPlacement();
      return;
    }

    setPendingPlacement({
      resourceKind: 'VEHICLE',
      geometryType: 'POINT',
      label,
      status: 'DEPLOYED',
      source: 'staff_sidebar',
      roleLabel: 'ШТАБ',
      resourceData: {
        role: 'HQ',
        plan_only: true,
        map_markup: true,
        vehicle_source_id: vehicleId,
        vehicle_label: vehicleName,
      },
    });
    showTransientMessage(`ШТАБ: выберите точку на карте для метки ${vehicleName.toUpperCase()}`);
  };

  const hqMarkersCount = useMemo(() => {
    return coordinationDeployments.filter((deployment) => {
      const data = deployment.resource_data;
      if (!data || typeof data !== 'object') {
        return false;
      }
      const raw = data as Record<string, unknown>;
      return raw.plan_only === true && normalizeRoleTag(raw.role) === 'HQ' && deployment.status !== 'COMPLETED';
    }).length;
  }, [coordinationDeployments]);

  return (
    <div className="w-[320px] h-full bg-[#2b2b2b] flex flex-col shrink-0 border-r-2 border-black overflow-y-auto custom-scrollbar relative">
      <div className="p-4 flex-1 flex flex-col gap-5">
        <section className="space-y-2">
          <div className="text-[10px] uppercase text-white">ШТАБ - КООРДИНАЦИЯ</div>
          <div className="bg-[#404040] border-2 border-black p-2 text-[7px] text-gray-100 leading-relaxed">
            <div>Активных очагов: {activeFireCount}</div>
            <div>В пути: {statusCounts.EN_ROUTE + statusCounts.PLANNED}</div>
            <div>На месте: {statusCounts.DEPLOYED + statusCounts.ACTIVE}</div>
            <div>Штабных меток: {hqMarkersCount}</div>
          </div>

          {pendingPlacementIsHq && pendingPlacement ? (
            <div className="bg-[#1f3a1b] border border-[#2f6f24] px-2 py-1 text-[7px] text-green-200 flex items-center justify-between gap-2">
              <span className="truncate">Разметка: {pendingPlacement.label}</span>
              <PixelButton
                size="sm"
                className="text-[6px] px-2"
                onClick={clearPendingPlacement}
              >
                ОТМЕНА
              </PixelButton>
            </div>
          ) : null}

          {isLoading ? <div className="text-[8px] text-gray-400">Загрузка обстановки...</div> : null}
          {loadError ? <div className="text-[8px] text-red-400">{loadError}</div> : null}
          {actionError ? <div className="text-[8px] text-red-400">{actionError}</div> : null}
        </section>

        <SimViewPanel bundle={realtimeBundle} title="ШТАБ — ОБСТАНОВКА" heightClass="h-[190px]" />

        <section>
          <h2 className="text-[10px] text-white uppercase mb-2 font-pixel flex items-center gap-1">
            РАЗМЕТКА ШТАБА <span className="text-[8px]">▼</span>
          </h2>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[8px] uppercase">Рукав (метка)</span>
              <div className="flex items-center gap-1">
                <StatusIndicator color="line" />
                <select
                  className="h-5 bg-[#3d3d3d] border border-black px-1 text-[7px] text-white outline-none"
                  value={selectedHoseType}
                  onChange={(event) => {
                    setSelectedHoseType(event.target.value as HoseType);
                  }}
                >
                  <option value="H51">H51</option>
                  <option value="H66">H66</option>
                  <option value="H77">H77</option>
                  <option value="H150">H150</option>
                </select>
                <PixelButton
                  size="sm"
                  className="text-[6px] px-2"
                  disabled={!sessionId}
                  onClick={() => {
                    requestHqUtilityPlacement('HOSE_LINE', 'LINESTRING', `МЕТКА РУКАВ ${selectedHoseType}`, 'DEPLOYED');
                  }}
                >
                  СТАВИТЬ
                </PixelButton>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-[8px] uppercase">Ствол (метка)</span>
              <div className="flex items-center gap-1">
                <StatusIndicator color="green" />
                <PixelButton
                  size="sm"
                  className="text-[6px] px-2"
                  disabled={!sessionId}
                  onClick={() => {
                    requestHqUtilityPlacement('NOZZLE', 'POINT', 'МЕТКА СТВОЛ', 'DEPLOYED');
                  }}
                >
                  СТАВИТЬ
                </PixelButton>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-[8px] uppercase">Метка зоны</span>
              <div className="flex items-center gap-1">
                <StatusIndicator color="blue" />
                <PixelButton
                  size="sm"
                  className="text-[6px] px-2"
                  disabled={!sessionId}
                  onClick={() => {
                    requestHqUtilityPlacement('MARKER', 'POINT', 'МЕТКА ШТАБ', 'DEPLOYED');
                  }}
                >
                  СТАВИТЬ
                </PixelButton>
              </div>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-[10px] text-white uppercase mb-2 font-pixel flex items-center gap-1">
            МЕТКИ МАШИН <span className="text-[8px]">▼</span>
          </h2>

          <div className="flex flex-col gap-2 max-h-[220px] overflow-y-auto custom-scrollbar pr-1">
            {vehicles.map((vehicle) => {
              const pendingForVehicle =
                pendingPlacement?.source === 'staff_sidebar'
                && pendingPlacement.resourceKind === 'VEHICLE'
                && pendingPlacement.resourceData
                && typeof pendingPlacement.resourceData === 'object'
                && (pendingPlacement.resourceData as Record<string, unknown>).vehicle_source_id === vehicle.id;

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
                      size="sm"
                      className="text-[6px] h-4 px-1.5 tracking-tight"
                      disabled={!sessionId}
                      onClick={() => {
                        requestHqVehicleMarker(vehicle.id, vehicle.name);
                      }}
                    >
                      {pendingForVehicle ? 'ВЫБРАТЬ ТОЧКУ' : 'МЕТКА'}
                    </PixelButton>
                  </div>
                </div>
              );
            })}

            {!isLoading && vehicles.length === 0 ? (
              <div className="text-[8px] text-gray-500">Нет техники для разметки</div>
            ) : null}
          </div>
        </section>

        <FireTimelineChart snapshots={realtimeBundle?.snapshots_history ?? []} />

        <section className="bg-[#202020] border-2 border-black p-2 text-[7px] text-gray-300 uppercase leading-relaxed">
          Разметка штаба - только визуальные метки (`plan_only`), на симуляцию не влияют.
        </section>
      </div>
    </div>
  );
};
