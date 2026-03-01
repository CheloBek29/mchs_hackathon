import type { RenderSnapshot } from '../types.js';

export interface CoreWorldSnapshotLike {
  voxels?: Array<{
    x: number;
    y: number;
    z: number;
    materialType?: string;
    isBurning?: boolean;
    temperature?: number;
  }>;
  waterSources?: Array<{
    x: number;
    y: number;
    z: number;
    radiusM?: number;
    flowRateLs?: number;
  }>;
  weather?: {
    windSpeedMs?: number;
    windDirectionDeg?: number;
    ambientTempC?: number;
    humidityPct?: number;
  };
  entitiesCount?: number;
}

export function adaptCoreSnapshot(snapshot: CoreWorldSnapshotLike): RenderSnapshot {
  return {
    voxels: (snapshot.voxels ?? []).map((voxel) => ({
      x: voxel.x,
      y: voxel.y,
      z: voxel.z,
      materialType: voxel.materialType ?? 'UNKNOWN',
      isBurning: voxel.isBurning ?? false,
      temperature: voxel.temperature ?? 20,
    })),
    waterSources: (snapshot.waterSources ?? []).map((source) => ({
      x: source.x,
      y: source.y,
      z: source.z,
      radiusM: source.radiusM ?? 1,
      flowRateLs: source.flowRateLs ?? 1,
    })),
    weather: {
      windSpeedMs: snapshot.weather?.windSpeedMs ?? 0,
      windDirectionDeg: snapshot.weather?.windDirectionDeg ?? 0,
      ambientTempC: snapshot.weather?.ambientTempC ?? 20,
      humidityPct: snapshot.weather?.humidityPct ?? 50,
    },
    entitiesCount: snapshot.entitiesCount,
  };
}
