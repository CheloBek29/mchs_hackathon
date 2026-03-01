export type MaterialType = 'WOOD' | 'CONCRETE' | 'OIL' | 'UNKNOWN' | string;

export interface RenderWeather {
  windSpeedMs: number;
  windDirectionDeg: number;
  ambientTempC: number;
  humidityPct: number;
}

export interface RenderVoxel {
  x: number;
  y: number;
  z: number;
  materialType: MaterialType;
  isBurning?: boolean;
  temperature: number;
}

export interface RenderWaterSource {
  x: number;
  y: number;
  z: number;
  radiusM: number;
  flowRateLs: number;
}

export interface RenderSnapshot {
  voxels: RenderVoxel[];
  waterSources: RenderWaterSource[];
  weather: RenderWeather;
  entitiesCount?: number;
}

export interface RendererOptions {
  antialias?: boolean;
  shadowMap?: boolean;
  pixelRatioCap?: number;
  backgroundColor?: number;
  gridSize?: number;
  initialQuality?: 'ultra' | 'high' | 'medium' | 'low' | 'minimal';
  autoQuality?: boolean;
}
