import React, { useMemo } from 'react';
import { PhysicsIsometricView } from './PhysicsIsometricView';
import type { SessionStateBundleDto } from '../api/types';

type SimViewPanelProps = {
  bundle: SessionStateBundleDto | null;
  title?: string;
  heightClass?: string;
};

export const SimViewPanel: React.FC<SimViewPanelProps> = ({
  bundle,
  title = 'SIMULATION 2.5D',
  heightClass = 'h-[200px]',
}) => {
  const counters = useMemo(() => {
    if (!bundle) {
      return { fires: 0, smoke: 0, vehicles: 0 };
    }
    const fires = bundle.fire_objects.filter((f) => f.is_active && f.kind !== 'SMOKE_ZONE').length;
    const smoke = bundle.fire_objects.filter((f) => f.is_active && f.kind === 'SMOKE_ZONE').length;
    const vehicles = bundle.resource_deployments.filter(
      (d) => d.resource_kind === 'VEHICLE' && (d.status === 'DEPLOYED' || d.status === 'ACTIVE'),
    ).length;
    return { fires, smoke, vehicles };
  }, [bundle]);

  return (
    <div className="border-2 border-black bg-[#0d131a]">
      {/* Header bar */}
      <div className="px-2 py-[3px] bg-[#111b25] border-b border-black flex items-center justify-between gap-2">
        <span className="text-[7px] uppercase text-cyan-300 tracking-widest font-pixel">
          ▌ {title}
        </span>
        <span className="text-[6px] text-gray-400 uppercase tracking-wide shrink-0">
          {bundle
            ? `огонь ${counters.fires} | дым ${counters.smoke} | техника ${counters.vehicles}`
            : 'нет данных'}
        </span>
      </div>

      {/* Canvas viewport */}
      <div className={`relative ${heightClass}`}>
        <PhysicsIsometricView
          bundle={bundle}
          title=""
          className="w-full h-full border-0"
          lod="medium"
        />
        {!bundle && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[7px] text-gray-500 uppercase tracking-widest animate-pulse">
              ОЖИДАНИЕ ДАННЫХ_
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
