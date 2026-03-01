import type { TPSimRenderer } from '../render/TPSimRenderer.js';
import { adaptCoreSnapshot, type CoreWorldSnapshotLike } from './coreSnapshotAdapter.js';

export interface CoreEvent {
  type: string;
  payload?: unknown;
}

export interface CoreSimulatorLike {
  on(handler: (event: CoreEvent) => void): void;
  off(handler: (event: CoreEvent) => void): void;
  getRenderSnapshot(): CoreWorldSnapshotLike;
}

export interface CoreBindingOptions {
  maxSyncHz?: number;
}

export class CoreRenderBinding {
  private readonly maxSyncHz: number;
  private readonly minIntervalMs: number;
  private lastSyncAt = 0;
  private active = false;
  private readonly renderer: TPSimRenderer;
  private readonly simulator: CoreSimulatorLike;

  constructor(
    renderer: TPSimRenderer,
    simulator: CoreSimulatorLike,
    options: CoreBindingOptions = {},
  ) {
    this.renderer = renderer;
    this.simulator = simulator;
    this.maxSyncHz = Math.max(1, options.maxSyncHz ?? 20);
    this.minIntervalMs = 1000 / this.maxSyncHz;
  }

  public start(): void {
    if (this.active) return;
    this.active = true;
    this.simulator.on(this.handleCoreEvent);
    this.syncNow();
  }

  public stop(): void {
    if (!this.active) return;
    this.active = false;
    this.simulator.off(this.handleCoreEvent);
  }

  public syncNow(): void {
    const snapshot = this.simulator.getRenderSnapshot();
    this.renderer.setSnapshot(adaptCoreSnapshot(snapshot));
  }

  private readonly handleCoreEvent = (event: CoreEvent): void => {
    if (!this.active) return;

    if (event.type !== 'TICK_APPLIED' && event.type !== 'SIM_STATE_CHANGED') {
      return;
    }

    const now = performance.now();
    if (now - this.lastSyncAt < this.minIntervalMs) {
      return;
    }

    this.lastSyncAt = now;
    this.syncNow();
  };
}
