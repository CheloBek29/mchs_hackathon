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
import type { DeploymentStatus } from '../../../shared/api/types.js';
import type { RetroVehicleRenderState } from '../types.js';

const STATUS_COLOR: Record<DeploymentStatus, number> = {
  PLANNED: 0x7f8a9a,
  EN_ROUTE: 0xd9a635,
  DEPLOYED: 0xea6f3b,
  ACTIVE: 0xd93a2f,
  COMPLETED: 0x5f6670,
};

function hashHeadingSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function headingById(id: string): number {
  const seed = Math.abs(hashHeadingSeed(id));
  const quarterTurn = seed % 4;
  return quarterTurn * (Math.PI / 2);
}

export class RetroVehicleLayer {
  private readonly group = new Group();
  private readonly bodyMesh: InstancedMesh;
  private readonly cabinMesh: InstancedMesh;
  private readonly tankMesh: InstancedMesh;
  private readonly bodyScratch = new Object3D();
  private readonly cabinScratch = new Object3D();
  private readonly tankScratch = new Object3D();
  private readonly matrixScratch = new Matrix4();
  private readonly colorScratch = new Color();
  private readonly hardCap: number;

  constructor(scene: Scene, hardCap = 300) {
    this.hardCap = Math.max(1, hardCap);

    const bodyGeometry = new BoxGeometry(1.8, 0.7, 0.95);
    const cabinGeometry = new BoxGeometry(0.72, 0.56, 0.9);
    const tankGeometry = new BoxGeometry(0.26, 0.38, 0.26);

    const bodyMaterial = new MeshStandardMaterial({
      color: new Color(0xc44a32),
      roughness: 0.74,
      metalness: 0.08,
      vertexColors: true,
    });

    const cabinMaterial = new MeshStandardMaterial({
      color: new Color(0xdee5ee),
      roughness: 0.55,
      metalness: 0.18,
      vertexColors: true,
    });

    const tankMaterial = new MeshStandardMaterial({
      color: new Color(0x49a7de),
      roughness: 0.52,
      metalness: 0.08,
      vertexColors: true,
      transparent: true,
      opacity: 0.94,
    });

    this.bodyMesh = new InstancedMesh(bodyGeometry, bodyMaterial, this.hardCap);
    this.bodyMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.bodyMesh.count = 0;
    this.bodyMesh.castShadow = false;
    this.bodyMesh.receiveShadow = true;

    this.cabinMesh = new InstancedMesh(cabinGeometry, cabinMaterial, this.hardCap);
    this.cabinMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.cabinMesh.count = 0;
    this.cabinMesh.castShadow = false;
    this.cabinMesh.receiveShadow = true;

    this.tankMesh = new InstancedMesh(tankGeometry, tankMaterial, this.hardCap);
    this.tankMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.tankMesh.count = 0;
    this.tankMesh.castShadow = false;
    this.tankMesh.receiveShadow = false;

    this.group.add(this.bodyMesh, this.cabinMesh, this.tankMesh);
    scene.add(this.group);
  }

  public setVehicles(vehicles: RetroVehicleRenderState[]): void {
    const count = Math.min(this.hardCap, vehicles.length);

    this.bodyMesh.count = count;
    this.cabinMesh.count = count;
    this.tankMesh.count = count;

    for (let index = 0; index < count; index += 1) {
      const vehicle = vehicles[index];
      const heading = headingById(vehicle.id);
      const cosHeading = Math.cos(heading);
      const sinHeading = Math.sin(heading);

      const bodyColor = STATUS_COLOR[vehicle.status] ?? STATUS_COLOR.DEPLOYED;
      this.colorScratch.setHex(bodyColor);
      this.bodyMesh.setColorAt(index, this.colorScratch);

      this.bodyScratch.position.set(vehicle.x, vehicle.z + 0.35, vehicle.y);
      this.bodyScratch.rotation.set(0, heading, 0);
      this.bodyScratch.scale.set(1, 1, 1);
      this.bodyScratch.updateMatrix();
      this.matrixScratch.copy(this.bodyScratch.matrix);
      this.bodyMesh.setMatrixAt(index, this.matrixScratch);

      this.colorScratch.setHex(0xe8eef7);
      this.cabinMesh.setColorAt(index, this.colorScratch);

      this.cabinScratch.position.set(
        vehicle.x + cosHeading * 0.54,
        vehicle.z + 0.84,
        vehicle.y + sinHeading * 0.54,
      );
      this.cabinScratch.rotation.set(0, heading, 0);
      this.cabinScratch.scale.set(1, 1, 1);
      this.cabinScratch.updateMatrix();
      this.matrixScratch.copy(this.cabinScratch.matrix);
      this.cabinMesh.setMatrixAt(index, this.matrixScratch);

      const waterRatio = vehicle.waterRatio === null ? 0.35 : Math.max(0, Math.min(1, vehicle.waterRatio));
      const tankHeight = 0.22 + waterRatio * 0.42;
      const tankColor = new Color().lerpColors(new Color(0x335870), new Color(0x58d1ff), waterRatio);
      this.tankMesh.setColorAt(index, tankColor);

      this.tankScratch.position.set(
        vehicle.x - cosHeading * 0.32,
        vehicle.z + 0.7 + tankHeight * 0.35,
        vehicle.y - sinHeading * 0.32,
      );
      this.tankScratch.rotation.set(0, heading, 0);
      this.tankScratch.scale.set(1, tankHeight, 1);
      this.tankScratch.updateMatrix();
      this.matrixScratch.copy(this.tankScratch.matrix);
      this.tankMesh.setMatrixAt(index, this.matrixScratch);
    }

    this.bodyMesh.instanceMatrix.needsUpdate = true;
    this.cabinMesh.instanceMatrix.needsUpdate = true;
    this.tankMesh.instanceMatrix.needsUpdate = true;

    if (this.bodyMesh.instanceColor) {
      this.bodyMesh.instanceColor.needsUpdate = true;
    }
    if (this.cabinMesh.instanceColor) {
      this.cabinMesh.instanceColor.needsUpdate = true;
    }
    if (this.tankMesh.instanceColor) {
      this.tankMesh.instanceColor.needsUpdate = true;
    }
  }

  public dispose(): void {
    this.group.removeFromParent();

    this.bodyMesh.geometry.dispose();
    if (!Array.isArray(this.bodyMesh.material)) {
      this.bodyMesh.material.dispose();
    }

    this.cabinMesh.geometry.dispose();
    if (!Array.isArray(this.cabinMesh.material)) {
      this.cabinMesh.material.dispose();
    }

    this.tankMesh.geometry.dispose();
    if (!Array.isArray(this.tankMesh.material)) {
      this.tankMesh.material.dispose();
    }
  }
}
