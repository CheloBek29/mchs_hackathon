import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  LineBasicMaterial,
  LineSegments,
  Scene,
} from 'three';
import type { RetroWaterJetRenderState } from '../types.js';

interface JetSegment {
  sourceX: number;
  sourceY: number;
  sourceZ: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  intensity: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

function sampleArc(segment: JetSegment, t: number): { x: number; y: number; z: number } {
  const safeT = clamp(t, 0, 1);
  const x = segment.sourceX + (segment.targetX - segment.sourceX) * safeT;
  const z = segment.sourceY + (segment.targetY - segment.sourceY) * safeT;
  const distance = Math.hypot(segment.targetX - segment.sourceX, segment.targetY - segment.sourceY);
  const archHeight = clamp(0.45 + distance * 0.06, 0.45, 3.8);
  const linearY = segment.sourceZ + (segment.targetZ - segment.sourceZ) * safeT;
  const y = linearY + 4 * archHeight * safeT * (1 - safeT);
  return { x, y, z };
}

export class RetroWaterJetLayer {
  private readonly geometry = new BufferGeometry();
  private readonly material = new LineBasicMaterial({
    color: new Color(0x72d4ff),
    transparent: true,
    opacity: 0.86,
  });
  private readonly lines: LineSegments;
  private readonly positions: Float32Array;
  private readonly segments: JetSegment[] = [];
  private readonly maxSegments: number;

  private activeSegments = 0;
  private elapsedSec = 0;

  constructor(scene: Scene, maxSegments = 2400) {
    this.maxSegments = Math.max(64, maxSegments);
    this.positions = new Float32Array(this.maxSegments * 2 * 3);

    const attribute = new BufferAttribute(this.positions, 3);
    attribute.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', attribute);
    this.geometry.setDrawRange(0, 0);

    this.lines = new LineSegments(this.geometry, this.material);
    this.lines.frustumCulled = false;
    scene.add(this.lines);
  }

  public setJets(jets: RetroWaterJetRenderState[]): void {
    this.segments.length = 0;

    for (const jet of jets) {
      const sourceX = jet.x;
      const sourceY = jet.y;
      const sourceZ = jet.z + 0.9;
      const targetX = jet.targetX;
      const targetY = jet.targetY;
      const targetZ = jet.targetZ + 0.5;
      const flowFactor = clamp(jet.flowRateLs / 8, 0.2, 1.5);
      const radiusFactor = clamp(jet.radiusM / 12, 0.4, 1.35);
      const dashCount = Math.round(clamp(3 + flowFactor * 3 + radiusFactor, 3, 10));

      for (let index = 0; index < dashCount; index += 1) {
        this.segments.push({
          sourceX,
          sourceY,
          sourceZ,
          targetX,
          targetY,
          targetZ,
          intensity: clamp(flowFactor * 0.72 + radiusFactor * 0.4, 0.25, 1.6),
        });
      }
    }

    this.activeSegments = Math.min(this.maxSegments, this.segments.length);
    this.geometry.setDrawRange(0, this.activeSegments * 2);
    this.rebuild(0);
  }

  public tick(deltaSec: number): void {
    if (this.activeSegments <= 0) {
      return;
    }
    this.elapsedSec += Math.max(0, deltaSec);
    this.rebuild(this.elapsedSec);
  }

  public dispose(): void {
    this.lines.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }

  private rebuild(timeSec: number): void {
    if (this.activeSegments <= 0) {
      this.geometry.setDrawRange(0, 0);
      return;
    }

    const dashLength = 0.18;
    const speed = 1.8;

    for (let index = 0; index < this.activeSegments; index += 1) {
      const segment = this.segments[index];
      const cycleOffset = (index * 0.173) % 1;
      const head = (timeSec * speed * segment.intensity + cycleOffset) % 1;
      const tail = Math.max(0, head - dashLength);

      const start = sampleArc(segment, tail);
      const end = sampleArc(segment, head);

      const positionIndex = index * 6;
      this.positions[positionIndex] = start.x;
      this.positions[positionIndex + 1] = start.y;
      this.positions[positionIndex + 2] = start.z;
      this.positions[positionIndex + 3] = end.x;
      this.positions[positionIndex + 4] = end.y;
      this.positions[positionIndex + 5] = end.z;
    }

    const attribute = this.geometry.getAttribute('position') as BufferAttribute;
    attribute.needsUpdate = true;
  }
}
