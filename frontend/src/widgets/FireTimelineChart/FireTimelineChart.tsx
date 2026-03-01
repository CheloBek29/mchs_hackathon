import { useMemo } from 'react';
import type { SessionStateSnapshotDto } from '../../shared/api/types';
import { extractFireRuntime } from '../../shared/api/fireRuntimeTypes';

interface FireTimelineChartProps {
  snapshots: SessionStateSnapshotDto[];
}

interface DataPoint {
  t: number;        // sim_time_seconds
  areaSumM2: number;
  qEffective: number;
}

const W = 272;
const H = 120;
const PAD_L = 36;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 24;
const CHART_W = W - PAD_L - PAD_R;
const CHART_H = H - PAD_T - PAD_B;

function toNum(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return isFinite(n) ? n : fallback;
}

function buildPoints(snapshots: SessionStateSnapshotDto[]): DataPoint[] {
  return snapshots
    .filter((s) => s.sim_time_seconds != null)
    .map((s) => {
      const sd = s.snapshot_data as Record<string, unknown> | null | undefined;
      const rt = extractFireRuntime(sd);
      // Суммарная площадь всех очагов из fire_directions
      const directions = rt.fire_directions ?? {};
      const areaSumM2 = Object.values(directions).reduce(
        (acc, d) => acc + toNum(d.area_m2),
        0,
      );
      return {
        t: toNum(s.sim_time_seconds),
        areaSumM2,
        qEffective: toNum(rt.q_effective_l_s),
      };
    })
    .sort((a, b) => a.t - b.t);
}

function scaleX(t: number, minT: number, maxT: number): number {
  if (maxT === minT) return PAD_L;
  return PAD_L + ((t - minT) / (maxT - minT)) * CHART_W;
}

function scaleY(v: number, maxV: number): number {
  if (maxV === 0) return PAD_T + CHART_H;
  return PAD_T + CHART_H - (v / maxV) * CHART_H;
}

function polylinePoints(
  pts: DataPoint[],
  getY: (p: DataPoint) => number,
  minT: number,
  maxT: number,
  maxV: number,
): string {
  return pts
    .map((p) => `${scaleX(p.t, minT, maxT).toFixed(1)},${scaleY(getY(p), maxV).toFixed(1)}`)
    .join(' ');
}

export function FireTimelineChart({ snapshots }: FireTimelineChartProps) {
  const points = useMemo(() => buildPoints(snapshots), [snapshots]);

  if (points.length < 2) {
    return (
      <div className="rounded border border-gray-700 bg-gray-900 text-xs text-gray-500 px-2 py-3 text-center">
        Недостаточно данных для графика
      </div>
    );
  }

  const minT = points[0].t;
  const maxT = points[points.length - 1].t;
  const maxArea = Math.max(1, ...points.map((p) => p.areaSumM2));
  const maxQ = Math.max(1, ...points.map((p) => p.qEffective));
  const maxVal = Math.max(maxArea, maxQ);

  const areaLine = polylinePoints(points, (p) => p.areaSumM2, minT, maxT, maxVal);
  const qLine = polylinePoints(points, (p) => p.qEffective, minT, maxT, maxVal);

  const lastArea = points[points.length - 1].areaSumM2;
  const lastQ = points[points.length - 1].qEffective;
  const durationMin = Math.round((maxT - minT) / 60);

  return (
    <div className="rounded border border-gray-700 bg-gray-900 overflow-hidden">
      {/* Заголовок */}
      <div className="flex justify-between items-center px-2 py-1 text-[10px] text-gray-400 border-b border-gray-700">
        <span className="font-semibold text-gray-200">📈 Динамика пожара</span>
        <span>{durationMin} мин</span>
      </div>

      {/* SVG График */}
      <svg width={W} height={H} className="block">
        {/* Сетка */}
        {[0.25, 0.5, 0.75, 1].map((frac) => {
          const y = PAD_T + CHART_H * (1 - frac);
          return (
            <g key={frac}>
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="#374151" strokeWidth="1" strokeDasharray="3,3" />
              <text x={PAD_L - 3} y={y + 3} fontSize="7" fill="#6b7280" textAnchor="end">
                {Math.round(maxVal * frac)}
              </text>
            </g>
          );
        })}

        {/* Линия площади (красная) */}
        <polyline
          points={areaLine}
          fill="none"
          stroke="#ef4444"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Линия Q_effective (синяя) */}
        <polyline
          points={qLine}
          fill="none"
          stroke="#3b82f6"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Ось X */}
        <line x1={PAD_L} y1={PAD_T + CHART_H} x2={W - PAD_R} y2={PAD_T + CHART_H} stroke="#4b5563" strokeWidth="1" />
        {/* Ось Y */}
        <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + CHART_H} stroke="#4b5563" strokeWidth="1" />
      </svg>

      {/* Легенда */}
      <div className="flex justify-between px-2 pb-1 text-[10px]">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-red-500" />
          <span className="text-gray-400">Sп {lastArea.toFixed(0)} м²</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-blue-500" />
          <span className="text-gray-400">Q {lastQ.toFixed(1)} л/с</span>
        </span>
      </div>
    </div>
  );
}
