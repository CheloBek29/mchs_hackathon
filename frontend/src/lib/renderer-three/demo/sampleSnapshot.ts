import type { RenderSnapshot } from '../types.js';

export function createSampleSnapshot(): RenderSnapshot {
  const voxels: RenderSnapshot['voxels'] = [];

  // Базовое "здание" из нескольких зон разных материалов
  for (let x = -8; x <= 8; x++) {
    for (let y = -6; y <= 6; y++) {
      for (let z = 0; z < 4; z++) {
        const materialType = x < -2 ? 'WOOD' : x > 2 ? 'CONCRETE' : 'OIL';
        const isBurning = x >= -1 && x <= 1 && y >= -1 && y <= 1 && z === 0;
        const temperature = isBurning ? 600 : 20;
        voxels.push({ x, y, z, materialType, isBurning, temperature });
      }
    }
  }

  return {
    voxels,
    waterSources: [
      { x: -2, y: -2, z: 0, radiusM: 2.2, flowRateLs: 3.6 },
      { x: 3, y: 2, z: 0, radiusM: 2.8, flowRateLs: 5.4 },
    ],
    weather: {
      windSpeedMs: 5,
      windDirectionDeg: 45,
      ambientTempC: 22,
      humidityPct: 55,
    },
    entitiesCount: voxels.length,
  };
}
