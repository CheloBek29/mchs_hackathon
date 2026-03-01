import type { DeploymentStatus, GeometryType } from '../../shared/api/types.js';
import type { RenderSnapshot, RenderVoxel, RenderWeather } from '../renderer-three/types.js';

export type RetroQualityLevel = 'authentic' | 'balanced' | 'stable';

export interface RetroQualityProfile {
  internalHeight: number;
  vertexSnapResolution: number;
  colorLevels: number;
  ditherStrength: number;
}

export const RETRO_QUALITY_PROFILES: Record<RetroQualityLevel, RetroQualityProfile> = {
  authentic: {
    internalHeight: 240,
    vertexSnapResolution: 160,
    colorLevels: 18,
    ditherStrength: 0.95,
  },
  balanced: {
    internalHeight: 360,
    vertexSnapResolution: 280,
    colorLevels: 28,
    ditherStrength: 0.62,
  },
  stable: {
    internalHeight: 520,
    vertexSnapResolution: 0,
    colorLevels: 36,
    ditherStrength: 0.22,
  },
};

export interface RetroRendererOptions {
  antialias?: boolean;
  backgroundColor?: number;
  gridSize?: number;
  initialQuality?: RetroQualityLevel;
}

export interface RetroShape {
  id: string;
  kind: string;
  geometryType: GeometryType;
  center: { x: number; y: number } | null;
  points: Array<{ x: number; y: number }>;
  elevationM: number;
  heightM: number;
}

export interface RetroEmitter {
  id: string;
  x: number;
  y: number;
  z: number;
  areaM2: number;
  intensity: number;
}

export interface RetroVehicleRenderState {
  id: string;
  x: number;
  y: number;
  z: number;
  status: DeploymentStatus;
  waterRatio: number | null;
}

export interface RetroWaterJetRenderState {
  id: string;
  x: number;
  y: number;
  z: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  flowRateLs: number;
  radiusM: number;
}

export type RetroBurnCellState = 'burning' | 'charred';

export interface RetroBurnCell {
  id: string;
  x: number;
  y: number;
  z: number;
  state: RetroBurnCellState;
  intensity: number;
  temperature: number;
}

export interface RetroStaticSceneState {
  voxels: RenderVoxel[];
  buildingShells: RetroShape[];
  roads: RetroShape[];
  hydrants: RetroShape[];
  waterSources: RetroShape[];
  rooms: RetroShape[];
  walls: RetroShape[];
  doors: RetroShape[];
  stairs: RetroShape[];
  exits: RetroShape[];
}

export interface RetroDynamicSceneState {
  burningVoxels: RenderVoxel[];
  burnCells: RetroBurnCell[];
  fireEmitters: RetroEmitter[];
  smokeEmitters: RetroEmitter[];
  vehicles: RetroVehicleRenderState[];
  waterJets: RetroWaterJetRenderState[];
}

export interface RetroRenderSnapshot {
  schemaVersion: 'retro-v1';
  tickId: number;
  updatedAt: string | null;
  weather: RenderWeather;
  staticScene: RetroStaticSceneState;
  dynamicState: RetroDynamicSceneState;
  legacyRenderSnapshot: RenderSnapshot;
}
