import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Points,
  PointsMaterial,
  Scene,
} from 'three';

export interface ParticleFieldConfig {
  capacity: number;
  areaWidth: number;
  areaDepth: number;
  minHeight: number;
  maxHeight: number;
  speedMin: number;
  speedMax: number;
  size: number;
  color: number;
  opacity: number;
}

interface ParticleState {
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

export class ParticleField {
  private readonly geometry = new BufferGeometry();
  private readonly material: PointsMaterial;
  private readonly points: Points;

  private readonly positions: Float32Array;
  private readonly states: ParticleState[];

  private activeCount = 0;
  private readonly capacity: number;
  private windX = 0;
  private windZ = 0;

  private readonly areaWidth: number;
  private readonly areaDepth: number;
  private readonly minHeight: number;
  private readonly maxHeight: number;
  private readonly speedMin: number;
  private readonly speedMax: number;

  constructor(scene: Scene, config: ParticleFieldConfig) {
    this.capacity = config.capacity;
    this.areaWidth = config.areaWidth;
    this.areaDepth = config.areaDepth;
    this.minHeight = config.minHeight;
    this.maxHeight = config.maxHeight;
    this.speedMin = config.speedMin;
    this.speedMax = config.speedMax;

    this.positions = new Float32Array(this.capacity * 3);
    this.states = new Array(this.capacity);

    for (let i = 0; i < this.capacity; i++) {
      this.states[i] = { vx: 0, vy: 0, vz: 0, life: 0 };
      this.respawn(i);
    }

    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geometry.setDrawRange(0, this.capacity);

    this.material = new PointsMaterial({
      color: new Color(config.color),
      size: config.size,
      transparent: true,
      opacity: clamp(config.opacity, 0, 1),
      depthWrite: false,
      blending: AdditiveBlending,
      sizeAttenuation: true,
    });

    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);

    this.setActiveCount(this.capacity);
  }

  public setWindDirection(dirX: number, dirZ: number): void {
    this.windX = dirX;
    this.windZ = dirZ;
  }

  public setActiveCount(count: number): void {
    this.activeCount = clamp(Math.floor(count), 0, this.capacity);
    this.geometry.setDrawRange(0, this.activeCount);
  }

  public setOpacity(opacity: number): void {
    this.material.opacity = clamp(opacity, 0, 1);
    this.material.needsUpdate = true;
  }

  public setPointSize(size: number): void {
    this.material.size = Math.max(0.02, size);
    this.material.needsUpdate = true;
  }

  public tick(deltaSec: number): void {
    const delta = Math.min(deltaSec, 0.05);

    for (let i = 0; i < this.activeCount; i++) {
      const idx = i * 3;
      const s = this.states[i];

      s.life -= delta;

      this.positions[idx] += (s.vx + this.windX * 0.45) * delta;
      this.positions[idx + 1] += s.vy * delta;
      this.positions[idx + 2] += (s.vz + this.windZ * 0.45) * delta;

      const x = this.positions[idx];
      const y = this.positions[idx + 1];
      const z = this.positions[idx + 2];

      const outOfBounds =
        x < -this.areaWidth / 2 ||
        x > this.areaWidth / 2 ||
        z < -this.areaDepth / 2 ||
        z > this.areaDepth / 2 ||
        y < this.minHeight ||
        y > this.maxHeight;

      if (s.life <= 0 || outOfBounds) {
        this.respawn(i);
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

  private respawn(index: number): void {
    const idx = index * 3;

    this.positions[idx] = (Math.random() - 0.5) * this.areaWidth;
    this.positions[idx + 1] = this.minHeight + Math.random() * (this.maxHeight - this.minHeight);
    this.positions[idx + 2] = (Math.random() - 0.5) * this.areaDepth;

    const speed = this.speedMin + Math.random() * (this.speedMax - this.speedMin);
    const angle = Math.random() * Math.PI * 2;

    this.states[index].vx = Math.cos(angle) * speed * 0.4;
    this.states[index].vz = Math.sin(angle) * speed * 0.4;
    this.states[index].vy = (Math.random() - 0.35) * speed;
    this.states[index].life = 2 + Math.random() * 6;
  }
}
