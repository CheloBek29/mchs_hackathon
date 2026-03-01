import React, { useMemo } from 'react';
import { useVehicleRuntime } from '../Vehicles/model/useVehicleRuntime';

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
    bundle,
    isLoading,
    loadError,
  } = useVehicleRuntime();

  const activeFireCount = useMemo(() => {
    if (!bundle) {
      return 0;
    }
    return bundle.fire_objects.filter((fireObject) => fireObject.is_active).length;
  }, [bundle]);

  const hqVisibleDeployments = useMemo(() => {
    const deployments = bundle?.resource_deployments ?? [];
    return deployments.filter((deployment) => {
      const resourceData = deployment.resource_data;
      if (!resourceData || typeof resourceData !== 'object') {
        return true;
      }
      const roleTag = normalizeRoleTag((resourceData as Record<string, unknown>).role);
      return roleTag !== 'BU1' && roleTag !== 'BU2';
    });
  }, [bundle?.resource_deployments]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {
      PLANNED: 0,
      EN_ROUTE: 0,
      DEPLOYED: 0,
      ACTIVE: 0,
      COMPLETED: 0,
    };

    hqVisibleDeployments
      .filter((deployment) => deployment.resource_kind === 'VEHICLE')
      .forEach((deployment) => {
        counts[deployment.status] += 1;
      });

    return counts;
  }, [hqVisibleDeployments]);

  return (
    <div className="w-[320px] h-full bg-[#2b2b2b] flex flex-col shrink-0 border-r-2 border-black overflow-y-auto custom-scrollbar relative">
      <div className="p-4 flex-1 flex flex-col gap-5">
        <section className="space-y-2">
          <div className="text-[10px] uppercase text-white">ШТАБ - КООРДИНАЦИЯ</div>
          <div className="bg-[#404040] border-2 border-black p-2 text-[7px] text-gray-100 leading-relaxed">
            <div>Активных очагов: {activeFireCount}</div>
            <div>В пути: {statusCounts.EN_ROUTE + statusCounts.PLANNED}</div>
            <div>На месте: {statusCounts.DEPLOYED + statusCounts.ACTIVE}</div>
          </div>

          {isLoading ? <div className="text-[8px] text-gray-400">Загрузка обстановки...</div> : null}
          {loadError ? <div className="text-[8px] text-red-400">{loadError}</div> : null}
        </section>

        <section className="bg-[#202020] border-2 border-black p-2 text-[7px] text-gray-300 uppercase leading-relaxed">
          Координация связи: РТП / БУ
        </section>
      </div>
    </div>
  );
};
