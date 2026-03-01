import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Points,
  PointsMaterial,
  Scene,
} from 'three';
import type { RenderVoxel } from '../types.js';
import type { QualityProfile } from '../quality/qualityProfiles.js';

interface SmokeSource {
  x: number;
  y: number;
  z: number;
}

interface SmokeParticleState {
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

export class SmokeLayer {
  private readonly geometry = new BufferGeometry();
  private readonly material: PointsMaterial;
  private readonly points: Points;
  private readonly positions: Float32Array;
  private readonly states: SmokeParticleState[];

  private readonly capacity: number;
  private activeCount = 0;
  private maxActiveByQuality = 1200;

  private windX = 0;
  private windZ = 0;
  private sources: SmokeSource[] = [];

  constructor(scene: Scene, capacity = 7000) {
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
    this.geometry.setDrawRange(0, 0);

    this.material = new PointsMaterial({
      color: new Color(0x46494d),
      size: 0.95,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  public setQuality(profile: QualityProfile): void {
    this.maxActiveByQuality = Math.min(this.capacity, profile.smokeParticleCount);
    this.activeCount = Math.min(this.activeCount, this.maxActiveByQuality);
    this.geometry.setDrawRange(0, this.activeCount);
  }

  public setWeather(windSpeedMs: number, windDirectionDeg: number, humidityPct: number): void {
    const rad = (windDirectionDeg * Math.PI) / 180;
    this.windX = Math.cos(rad) * windSpeedMs;
    this.windZ = Math.sin(rad) * windSpeedMs;

    const humidity = clamp(humidityPct / 100, 0, 1);
    this.material.opacity = clamp(0.16 + humidity * 0.28, 0.12, 0.44);
    this.material.size = clamp(0.8 + humidity * 0.8, 0.6, 1.7);
    this.material.needsUpdate = true;
  }

  public setSources(voxels: RenderVoxel[]): void {
    const burning = voxels.filter((v) => v.isBurning);
    this.sources = burning.map((b) => ({ x: b.x, y: b.z + 0.6, z: b.y }));

    if (this.sources.length === 0) {
      this.activeCount = 0;
      this.geometry.setDrawRange(0, 0);
      return;
    }

    const target = Math.min(this.maxActiveByQuality, this.sources.length * 7);
    this.activeCount = target;
    this.geometry.setDrawRange(0, this.activeCount);

    for (let i = 0; i < this.activeCount; i++) {
      this.respawn(i, true);
    }

    const attr = this.geometry.getAttribute('position') as BufferAttribute;
    attr.needsUpdate = true;
  }

  public tick(deltaSec: number): void {
    if (this.activeCount <= 0 || this.sources.length === 0) return;

    const dt = Math.min(deltaSec, 0.05);

    for (let i = 0; i < this.activeCount; i++) {
      const idx = i * 3;
      const s = this.states[i];

      s.life -= dt;

      this.positions[idx] += (s.vx + this.windX * 0.08) * dt;
      this.positions[idx + 1] += s.vy * dt;
      this.positions[idx + 2] += (s.vz + this.windZ * 0.08) * dt;

      if (s.life <= 0) {
        this.respawn(i, false);
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

  private respawn(index: number, randomY: boolean): void {
    const source = this.sources[Math.floor(Math.random() * this.sources.length)];
    const idx = index * 3;

    const jitter = 0.55;
    this.positions[idx] = source.x + (Math.random() - 0.5) * jitter;
    this.positions[idx + 1] = source.y + (randomY ? Math.random() * 1.6 : 0);
    this.positions[idx + 2] = source.z + (Math.random() - 0.5) * jitter;

    const drift = 0.12 + Math.random() * 0.35;
    const angle = Math.random() * Math.PI * 2;
    this.states[index].vx = Math.cos(angle) * drift;
    this.states[index].vz = Math.sin(angle) * drift;
    this.states[index].vy = 0.35 + Math.random() * 0.55;
    this.states[index].life = 0.8 + Math.random() * 2.1;
  }

  private setOffscreen(index: number): void {
    const idx = index * 3;
    this.positions[idx] = 0;
    this.positions[idx + 1] = -9999;
    this.positions[idx + 2] = 0;
  }
}
