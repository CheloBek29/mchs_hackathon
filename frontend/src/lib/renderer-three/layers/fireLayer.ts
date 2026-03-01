import {
  AdditiveBlending,
  Color,
  ConeGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Scene,
} from 'three';
import type { RenderVoxel } from '../types.js';
import type { QualityProfile } from '../quality/qualityProfiles.js';

interface FireSource {
  x: number;
  y: number;
  z: number;
  phase: number;
  baseScale: number;
}

export class FireLayer {
  private readonly geometry = new ConeGeometry(0.34, 1.1, 7);
  private readonly material = new MeshStandardMaterial({
    color: new Color(0xff7d1f),
    emissive: new Color(0xff4400),
    emissiveIntensity: 1.6,
    roughness: 0.3,
    metalness: 0.0,
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
  });

  private readonly mesh: InstancedMesh;
  private readonly scratch = new Object3D();
  private readonly scratchMatrix = new Matrix4();

  private maxInstances = 3000;
  private sources: FireSource[] = [];

  constructor(scene: Scene, hardCap = 6000) {
    this.material.blending = AdditiveBlending;

    this.mesh = new InstancedMesh(this.geometry, this.material, hardCap);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;

    scene.add(this.mesh);
  }

  public setQuality(profile: QualityProfile): void {
    this.maxInstances = Math.max(1, profile.fireMaxInstances);
  }

  public setSources(voxels: RenderVoxel[]): void {
    const burning = voxels.filter((v) => v.isBurning);
    const count = Math.min(this.maxInstances, burning.length);

    this.sources = new Array(count);

    if (count <= 0) {
      this.mesh.count = 0;
      return;
    }

    const step = Math.max(1, Math.floor(burning.length / count));
    let sourceIdx = 0;

    for (let i = 0; i < burning.length && sourceIdx < count; i += step) {
      const voxel = burning[i];
      // Интенсивность (температура) определяет размер огня (20..1000C)
      const intensityFactor = Math.max(0.2, Math.min(1.0, voxel.temperature / 1000));

      this.sources[sourceIdx] = {
        x: voxel.x,
        y: voxel.z + 0.15 * intensityFactor,
        z: voxel.y,
        phase: Math.random() * Math.PI * 2,
        baseScale: (0.5 + Math.random() * 0.7) * intensityFactor,
      };
      sourceIdx += 1;
    }

    this.mesh.count = sourceIdx;
    this.updateMatrices(0);
  }

  public tick(timeSec: number): void {
    if (this.mesh.count <= 0) return;
    this.updateMatrices(timeSec);
  }

  public dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }

  private updateMatrices(timeSec: number): void {
    const count = this.mesh.count;

    for (let i = 0; i < count; i++) {
      const s = this.sources[i];
      const flicker = 0.86 + 0.26 * Math.sin(timeSec * 8.2 + s.phase);
      const height = s.baseScale * flicker;

      this.scratch.position.set(s.x, s.y + 0.3, s.z);
      this.scratch.rotation.set(0, s.phase * 0.5, 0);
      this.scratch.scale.set(0.5 * flicker, height, 0.5 * flicker);
      this.scratch.updateMatrix();

      this.scratchMatrix.copy(this.scratch.matrix);
      this.mesh.setMatrixAt(i, this.scratchMatrix);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
