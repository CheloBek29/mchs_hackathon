import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../../../shared/api/client';
import type {
  DeploymentStatus,
  ResourceDeploymentDto,
  SessionStateBundleDto,
  VehicleDictionaryDto,
} from '../../../shared/api/types';
import type { IndicatorColor } from '../../../shared/ui/StatusIndicator';
import { useAuthStore } from '../../../store/useAuthStore';
import { useRealtimeStore } from '../../../store/useRealtimeStore';

export type VehicleStatusKey = DeploymentStatus | 'IDLE';

type VehicleStatusMeta = {
  label: string;
  className: string;
  indicatorColor: IndicatorColor;
  busy: boolean;
};

const DEFAULT_PHONE = '89237612034';

const TYPE_LABELS: Record<VehicleDictionaryDto['type'], string> = {
  AC: 'Автоцистерна',
  AL: 'Автолестница',
  ASA: 'Аварийно-спасательная',
};

const VEHICLE_SPEC_FALLBACKS: Record<VehicleDictionaryDto['type'], {
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
    water_capacity: 0,
    foam_capacity: 0,
    hose_length: 180,
  },
  ASA: {
    crew_size: 4,
    water_capacity: 1000,
    foam_capacity: 100,
    hose_length: 240,
  },
};

const normalizeVehicleSpec = (
  value: number | null,
  fallback: number,
): number => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return fallback;
};

const STATUS_META: Record<VehicleStatusKey, VehicleStatusMeta> = {
  IDLE: { label: 'НА БАЗЕ', className: 'bg-[#1f1f1f] text-gray-300', indicatorColor: 'green', busy: false },
  PLANNED: { label: 'ГОТОВИТСЯ', className: 'bg-[#3a3a3a] text-gray-100', indicatorColor: 'blue', busy: true },
  EN_ROUTE: { label: 'В ПУТИ', className: 'bg-[#2f6f24] text-white', indicatorColor: 'orange', busy: true },
  DEPLOYED: { label: 'НА МЕСТЕ', className: 'bg-[#27611d] text-white', indicatorColor: 'green', busy: true },
  ACTIVE: { label: 'РАБОТАЕТ', className: 'bg-[#9a3412] text-white', indicatorColor: 'red', busy: true },
  COMPLETED: { label: 'ЗАВЕРШЕНО', className: 'bg-[#202020] text-gray-400', indicatorColor: 'gray', busy: false },
};

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
};

const getSpriteByVehicleName = (name: string): { col: number; row: number } => {
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

const isTemplateVehicleRow = (vehicle: VehicleDictionaryDto): boolean => {
  const normalizedName = vehicle.name.toLowerCase();
  const missingSpecs =
    vehicle.water_capacity == null &&
    vehicle.foam_capacity == null &&
    vehicle.crew_size == null &&
    vehicle.hose_length == null;

  if (!missingSpecs) {
    return false;
  }

  return (
    normalizedName.includes('—') ||
    normalizedName.includes('автоцистерны') ||
    normalizedName.includes('автолестницы') ||
    normalizedName.includes('аварийно-спасательные')
  );
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

export type VehicleRuntimeItem = VehicleDictionaryDto & {
  phone: string;
  typeLabel: string;
  statusKey: VehicleStatusKey;
  statusLabel: string;
  statusClassName: string;
  indicatorColor: IndicatorColor;
  isBusy: boolean;
  latestDeployment: ResourceDeploymentDto | null;
  col: number;
  row: number;
};

type CreateVehicleDeploymentParams = {
  vehicle: VehicleRuntimeItem;
  status: DeploymentStatus;
  source: string;
  resourceData?: Record<string, unknown>;
  geometry?: Record<string, unknown>;
};

export const useVehicleRuntime = () => {
  const { user } = useAuthStore();
  const realtimeBundle = useRealtimeStore((state) => state.bundle);
  const realtimeSessionId = useRealtimeStore((state) => state.sessionId);
  const sendRealtimeCommand = useRealtimeStore((state) => state.sendCommand);

  const [vehicles, setVehicles] = useState<VehicleDictionaryDto[]>([]);
  const [bundle, setBundle] = useState<SessionStateBundleDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');

  const sessionId = user?.session_id ?? null;

  const refreshData = useCallback(
    async (withMainLoader = true) => {
      if (withMainLoader) {
        setIsLoading(true);
      } else {
        setIsRefreshing(true);
      }
      setLoadError('');

      try {
        const [vehiclesData, bundleData] = await Promise.all([
          apiClient.get<VehicleDictionaryDto[]>('/vehicles'),
          sessionId ? apiClient.get<SessionStateBundleDto>(`/sessions/${sessionId}/state`) : Promise.resolve(null),
        ]);

        setVehicles(vehiclesData);
        setBundle(bundleData);
      } catch (error) {
        setLoadError(getErrorMessage(error, 'Не удалось загрузить данные по технике'));
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    void refreshData(true);
  }, [refreshData]);

  useEffect(() => {
    if (!sessionId || !realtimeBundle || realtimeSessionId !== sessionId) {
      return;
    }
    setBundle(realtimeBundle);
  }, [realtimeBundle, realtimeSessionId, sessionId]);

  const latestDeploymentByVehicle = useMemo(
    () => getLatestDeploymentByVehicle(bundle?.resource_deployments ?? []),
    [bundle?.resource_deployments],
  );

  const runtimeVehicles = useMemo<VehicleRuntimeItem[]>(() => {
    return vehicles.filter((vehicle) => !isTemplateVehicleRow(vehicle)).map((vehicle) => {
      const latestDeployment = latestDeploymentByVehicle.get(vehicle.id) ?? null;
      const statusKey: VehicleStatusKey = latestDeployment?.status ?? 'IDLE';
      const statusMeta = STATUS_META[statusKey];
      const sprite = getSpriteByVehicleName(vehicle.name);
      const fallbackSpecs = VEHICLE_SPEC_FALLBACKS[vehicle.type];

      return {
        ...vehicle,
        phone: DEFAULT_PHONE,
        typeLabel: TYPE_LABELS[vehicle.type],
        crew_size: normalizeVehicleSpec(vehicle.crew_size, fallbackSpecs.crew_size),
        water_capacity: normalizeVehicleSpec(vehicle.water_capacity, fallbackSpecs.water_capacity),
        foam_capacity: normalizeVehicleSpec(vehicle.foam_capacity, fallbackSpecs.foam_capacity),
        hose_length: normalizeVehicleSpec(vehicle.hose_length, fallbackSpecs.hose_length),
        statusKey,
        statusLabel: statusMeta.label,
        statusClassName: statusMeta.className,
        indicatorColor: statusMeta.indicatorColor,
        isBusy: statusMeta.busy,
        latestDeployment,
        col: sprite.col,
        row: sprite.row,
      };
    });
  }, [latestDeploymentByVehicle, vehicles]);

  const statusCounts = useMemo(() => {
    const counts: Record<VehicleStatusKey, number> = {
      IDLE: 0,
      PLANNED: 0,
      EN_ROUTE: 0,
      DEPLOYED: 0,
      ACTIVE: 0,
      COMPLETED: 0,
    };

    runtimeVehicles.forEach((vehicle) => {
      counts[vehicle.statusKey] += 1;
    });

    return counts;
  }, [runtimeVehicles]);

  const sendVehicleDeployment = useCallback(
    async ({ vehicle, status, source, resourceData, geometry }: CreateVehicleDeploymentParams) => {
      if (!sessionId) {
        throw new Error('Для работы с техникой нужна активная сессия');
      }

      await sendRealtimeCommand(
        'create_resource_deployment',
        {
          resource_kind: 'VEHICLE',
          status,
          vehicle_dictionary_id: vehicle.id,
          label: vehicle.name,
          geometry_type: 'POINT',
          geometry: geometry ?? { x: 0, y: 0 },
          resource_data: {
            source,
            ...resourceData,
          },
        },
        sessionId,
      );
    },
    [sendRealtimeCommand, sessionId],
  );

  return {
    sessionId,
    bundle,
    vehicles: runtimeVehicles,
    statusCounts,
    isLoading,
    isRefreshing,
    loadError,
    refreshData,
    sendVehicleDeployment,
  };
};
