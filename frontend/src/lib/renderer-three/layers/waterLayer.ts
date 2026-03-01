import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Points,
  PointsMaterial,
  Scene,
} from 'three';
import type { QualityProfile } from '../quality/qualityProfiles.js';
import type { RenderWaterSource } from '../types.js';

interface WaterState {
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

export class WaterLayer {
  private readonly capacity: number;
  private readonly positions: Float32Array;
  private readonly states: WaterState[];

  private readonly geometry = new BufferGeometry();
  private readonly material: PointsMaterial;
  private readonly points: Points;

  private spawnCursor = 0;
  private particleBudget = 1600;

  private windX = 0;
  private windZ = 0;

  constructor(scene: Scene, capacity = 6000) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.states = new Array(capacity);

    for (let i = 0; i < capacity; i++) {
      this.states[i] = { vx: 0, vy: 0, vz: 0, life: 0 };
      this.setOffscreen(i);
    }

    const attr = new BufferAttribute(this.positions, 3);
    attr.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', attr);
    this.geometry.setDrawRange(0, capacity);

    this.material = new PointsMaterial({
      color: new Color(0x66c6ff),
      size: 0.18,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      blending: AdditiveBlending,
      sizeAttenuation: true,
    });

    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  public setQuality(profile: QualityProfile): void {
    this.particleBudget = Math.min(this.capacity, profile.waterParticleBudget);
  }

  public setWeather(windSpeedMs: number, windDirectionDeg: number): void {
    const rad = (windDirectionDeg * Math.PI) / 180;
    this.windX = Math.cos(rad) * windSpeedMs;
    this.windZ = Math.sin(rad) * windSpeedMs;
  }

  public emitFromSources(sources: RenderWaterSource[]): void {
    if (sources.length === 0) return;

    for (const source of sources) {
      const perSource = Math.floor(clamp(source.flowRateLs * 3 + source.radiusM * 2, 4, 36));
      for (let i = 0; i < perSource; i++) {
        this.spawnParticle(source);
      }
    }
  }

  public tick(deltaSec: number): void {
    const dt = Math.min(deltaSec, 0.05);

    for (let i = 0; i < this.particleBudget; i++) {
      const idx = i * 3;
      const s = this.states[i];

      if (s.life <= 0) continue;

      s.life -= dt;

      s.vy -= 9.2 * dt;

      this.positions[idx] += (s.vx + this.windX * 0.05) * dt;
      this.positions[idx + 1] += s.vy * dt;
      this.positions[idx + 2] += (s.vz + this.windZ * 0.05) * dt;

      if (s.life <= 0 || this.positions[idx + 1] < -0.45) {
        s.life = 0;
        this.setOffscreen(i);
      }
    }

    const attr = this.geometry.getAttribute('position') as BufferAttribute;
    attr.needsUpdate = true;
  }

  public dispose(): void {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }

  private spawnParticle(source: RenderWaterSource): void {
    const i = this.spawnCursor;
    this.spawnCursor = (this.spawnCursor + 1) % this.particleBudget;

    const idx = i * 3;

    const x = source.x;
    const y = source.z + 0.8;
    const z = source.y;

    this.positions[idx] = x + (Math.random() - 0.5) * 0.15;
    this.positions[idx + 1] = y;
    this.positions[idx + 2] = z + (Math.random() - 0.5) * 0.15;

    const spread = 0.65 + source.radiusM * 0.08;
    const angle = Math.random() * Math.PI * 2;
    const speed = 1.8 + Math.random() * 2.8 + source.flowRateLs * 0.15;

    this.states[i].vx = Math.cos(angle) * spread * speed * 0.45;
    this.states[i].vz = Math.sin(angle) * spread * speed * 0.45;
    this.states[i].vy = 1.2 + Math.random() * 2.2;
    this.states[i].life = 0.22 + Math.random() * 0.35;
  }

  private setOffscreen(index: number): void {
    const idx = index * 3;
    this.positions[idx] = 0;
    this.positions[idx + 1] = -9999;
    this.positions[idx + 2] = 0;
  }
}
