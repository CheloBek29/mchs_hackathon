import { useMemo } from 'react';
import type { SessionStateBundleDto } from '../../shared/api/types';
import {
  extractFireRuntime,
  forecastLabel,
  forecastColorClass,
  type FireRuntimeSnapshot,
} from '../../shared/api/fireRuntimeTypes';

interface FireMetricsHUDProps {
  bundle: SessionStateBundleDto | null;
  /** Компактный вид для узких сайдбаров */
  compact?: boolean;
}

interface VehicleInfo {
  id: string;
  label: string;
  remainingL: number;
  capacityL: number;
  minutesUntilEmpty: number | null | undefined;
  isEmpty: boolean;
}

function toNum(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return isFinite(n) ? n : fallback;
}

export function FireMetricsHUD({ bundle, compact = false }: FireMetricsHUDProps) {
  const fireRuntime = useMemo<FireRuntimeSnapshot>(() => {
    const snapshotData = bundle?.snapshot?.snapshot_data as
      | Record<string, unknown>
      | null
      | undefined;
    return extractFireRuntime(snapshotData);
  }, [bundle?.snapshot?.snapshot_data]);

  const vehicles = useMemo<VehicleInfo[]>(() => {
    const vr = fireRuntime.vehicle_runtime ?? {};
    return Object.entries(vr).map(([id, item]) => ({
      id,
      label: `АЦ ${id}`,
      remainingL: toNum(item.water_remaining_l),
      capacityL: toNum(item.water_capacity_l, 1),
      minutesUntilEmpty: item.minutes_until_empty,
      isEmpty: item.is_empty,
    }));
  }, [fireRuntime.vehicle_runtime]);

  const isActive = bundle?.session?.status === 'IN_PROGRESS';

  const qRequired = toNum(fireRuntime.q_required_l_s);
  const qEffective = toNum(fireRuntime.q_effective_l_s);
  const ratio = toNum(fireRuntime.suppression_ratio);
  const forecast = fireRuntime.forecast;
  const forecastCls = forecastColorClass(forecast);
  const forecastTxt = forecastLabel(forecast);

  const pct = qRequired > 0 ? Math.min(100, Math.round((qEffective / qRequired) * 100)) : 0;

  if (!isActive && !fireRuntime.forecast) {
    return null; // Не показываем до старта урока
  }

  return (
    <div className="rounded border border-gray-600 bg-gray-900 text-xs text-gray-200 overflow-hidden">
      {/* Заголовок с прогнозом */}
      <div className={`flex items-center justify-between px-2 py-1 font-semibold ${forecastCls}`}>
        <span>🔥 Пожар</span>
        <span>{forecastTxt}</span>
      </div>

      {/* Расходы воды */}
      <div className="px-2 py-1 border-b border-gray-700 space-y-0.5">
        <div className="flex justify-between">
          <span className="text-gray-400">Q треб.</span>
          <span className="font-mono">{qRequired.toFixed(2)} л/с</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Q факт.</span>
          <span className={`font-mono ${ratio >= 1 ? 'text-green-400' : ratio >= 0.85 ? 'text-yellow-400' : 'text-red-400'}`}>
            {qEffective.toFixed(2)} л/с
          </span>
        </div>
        {/* Прогресс-бар */}
        <div className="relative h-1.5 bg-gray-700 rounded-full overflow-hidden mt-1">
          <div
            className={`absolute inset-y-0 left-0 rounded-full transition-all ${
              pct >= 100 ? 'bg-green-500' : pct >= 85 ? 'bg-yellow-500' : 'bg-red-500'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="text-right text-gray-500">{pct}%</div>
      </div>

      {/* Запасы воды по машинам */}
      {!compact && vehicles.length > 0 && (
        <div className="px-2 py-1 space-y-1">
          {vehicles.map((v) => {
            const fillPct = v.capacityL > 0
              ? Math.round((v.remainingL / v.capacityL) * 100)
              : 0;
            return (
              <div key={v.id}>
                <div className="flex justify-between items-center">
                  <span className={v.isEmpty ? 'text-red-400' : 'text-gray-300'}>
                    {v.label}
                  </span>
                  <span className="font-mono text-gray-400">
                    {Math.round(v.remainingL)}/{Math.round(v.capacityL)} л
                  </span>
                </div>
                <div className="relative h-1 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className={`absolute inset-y-0 left-0 rounded-full ${
                      v.isEmpty ? 'bg-red-700' : fillPct < 25 ? 'bg-orange-500' : 'bg-blue-500'
                    }`}
                    style={{ width: `${fillPct}%` }}
                  />
                </div>
                {v.minutesUntilEmpty != null && !v.isEmpty && (
                  <div className="text-right text-gray-500 text-[10px]">
                    ≈ {v.minutesUntilEmpty} мин
                  </div>
                )}
                {v.isEmpty && (
                  <div className="text-right text-red-400 text-[10px]">ПУСТО</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
