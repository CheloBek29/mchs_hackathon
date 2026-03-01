import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Scene,
} from 'three';
import type { RenderVoxel } from '../types.js';

const MATERIAL_COLORS: Record<string, number> = {
  WOOD: 0x8a6137,
  CONCRETE: 0x6f757c,
  OIL: 0x2c2f35,
  CHARRED: 0x2a2b2d,
  UNKNOWN: 0x777777,
};

function colorForMaterial(materialType: string): number {
  return MATERIAL_COLORS[materialType] ?? MATERIAL_COLORS.UNKNOWN;
}

export class VoxelLayer {
  private readonly group = new Group();
  private readonly box = new BoxGeometry(1, 1, 1);
  private readonly scratch = new Object3D();
  private readonly scratchMatrix = new Matrix4();

  // Pool of persistent InstancedMesh objects grouped by material
  private meshPool = new Map<string, InstancedMesh>();

  private samplingStep = 1;
  private maxVoxelCount = 40000;

  constructor(scene: Scene) {
    scene.add(this.group);
  }

  public setVoxels(voxels: RenderVoxel[]): void {
    const filtered = this.filterByBudget(voxels);

    // Group incoming voxels by material
    const grouped = new Map<string, RenderVoxel[]>();
    for (const voxel of filtered) {
      const material = voxel.materialType ?? 'UNKNOWN';
      const bucket = grouped.get(material);
      if (bucket) {
        bucket.push(voxel);
      } else {
        grouped.set(material, [voxel]);
      }
    }

    // Reset counts for all existing meshes in the pool
    for (const mesh of this.meshPool.values()) {
      mesh.count = 0;
    }

    for (const [materialType, materialVoxels] of grouped.entries()) {
      let mesh = this.meshPool.get(materialType);

      // If we don't have a mesh for this material yet, or it's too small, recreate it
      if (!mesh || mesh.instanceMatrix.count < materialVoxels.length) {
        if (mesh) {
          this.group.remove(mesh);
          mesh.dispose();
        }

        const meshMaterial = new MeshStandardMaterial({
          color: new Color(colorForMaterial(materialType)),
          roughness: 0.92,
          metalness: 0.04,
        });

        // Pre-allocate buffer for maximum efficiency (using maxVoxelCount as a soft limit per material)
        const capacity = Math.max(materialVoxels.length, Math.min(this.maxVoxelCount, 10000));
        mesh = new InstancedMesh(this.box, meshMaterial, capacity);
        mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        this.meshPool.set(materialType, mesh);
        this.group.add(mesh);
      }

      mesh.count = materialVoxels.length;

      for (let i = 0; i < materialVoxels.length; i++) {
        const voxel = materialVoxels[i];
        this.scratch.position.set(voxel.x, voxel.z + 0.5, voxel.y);
        this.scratch.rotation.set(0, 0, 0);
        this.scratch.scale.set(1, 1, 1);
        this.scratch.updateMatrix();
        this.scratchMatrix.copy(this.scratch.matrix);
        mesh.setMatrixAt(i, this.scratchMatrix);
      }

      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  public dispose(): void {
    for (const mesh of this.meshPool.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        for (const mat of mesh.material) {
          mat.dispose();
        }
      } else {
        mesh.material.dispose();
      }
    }
    this.meshPool.clear();
    this.box.dispose();
    this.group.removeFromParent();
  }

  public setRenderBudget(samplingStep: number, maxVoxelCount: number): void {
    this.samplingStep = Math.max(1, Math.floor(samplingStep));
    this.maxVoxelCount = Math.max(1, Math.floor(maxVoxelCount));
  }

  private filterByBudget(voxels: RenderVoxel[]): RenderVoxel[] {
    if (voxels.length === 0) return voxels;

    const sampled: RenderVoxel[] = [];
    for (let i = 0; i < voxels.length; i += this.samplingStep) {
      sampled.push(voxels[i]);
      if (sampled.length >= this.maxVoxelCount) break;
    }

    return sampled;
  }
}
