export type QualityLevel = 'ultra' | 'high' | 'medium' | 'low' | 'minimal';

export interface QualityProfile {
  name: QualityLevel;
  pixelRatioCap: number;
  shadowsEnabled: boolean;
  particleCount: number;
  voxelSamplingStep: number;
  voxelMaxCount: number;
  fireMaxInstances: number;
  smokeParticleCount: number;
  waterParticleBudget: number;
}

export const QUALITY_ORDER: QualityLevel[] = ['minimal', 'low', 'medium', 'high', 'ultra'];

export const QUALITY_PROFILES: Record<QualityLevel, QualityProfile> = {
  ultra: {
    name: 'ultra',
    pixelRatioCap: 2,
    shadowsEnabled: true,
    particleCount: 3600,
    voxelSamplingStep: 1,
    voxelMaxCount: 120_000,
    fireMaxInstances: 5000,
    smokeParticleCount: 6000,
    waterParticleBudget: 6000,
  },
  high: {
    name: 'high',
    pixelRatioCap: 1.75,
    shadowsEnabled: true,
    particleCount: 2400,
    voxelSamplingStep: 1,
    voxelMaxCount: 80_000,
    fireMaxInstances: 3200,
    smokeParticleCount: 3600,
    waterParticleBudget: 3600,
  },
  medium: {
    name: 'medium',
    pixelRatioCap: 1.5,
    shadowsEnabled: true,
    particleCount: 1400,
    voxelSamplingStep: 2,
    voxelMaxCount: 45_000,
    fireMaxInstances: 1700,
    smokeParticleCount: 1900,
    waterParticleBudget: 1800,
  },
  low: {
    name: 'low',
    pixelRatioCap: 1.25,
    shadowsEnabled: false,
    particleCount: 700,
    voxelSamplingStep: 3,
    voxelMaxCount: 22_000,
    fireMaxInstances: 850,
    smokeParticleCount: 900,
    waterParticleBudget: 700,
  },
  minimal: {
    name: 'minimal',
    pixelRatioCap: 1,
    shadowsEnabled: false,
    particleCount: 260,
    voxelSamplingStep: 5,
    voxelMaxCount: 8_000,
    fireMaxInstances: 320,
    smokeParticleCount: 300,
    waterParticleBudget: 240,
  },
};

export function getLowerQuality(current: QualityLevel): QualityLevel {
  const idx = QUALITY_ORDER.indexOf(current);
  if (idx <= 0) return current;
  return QUALITY_ORDER[idx - 1];
}

export function getHigherQuality(current: QualityLevel): QualityLevel {
  const idx = QUALITY_ORDER.indexOf(current);
  if (idx >= QUALITY_ORDER.length - 1) return current;
  return QUALITY_ORDER[idx + 1];
}
