import type { TPSimRenderer } from '../render/TPSimRenderer.js';
import { adaptCoreSnapshot, type CoreWorldSnapshotLike } from './coreSnapshotAdapter.js';

export interface SnapshotSource {
  getRenderSnapshot(): CoreWorldSnapshotLike;
}

export function syncSnapshot(renderer: TPSimRenderer, source: SnapshotSource): void {
  const snapshot = adaptCoreSnapshot(source.getRenderSnapshot());
  renderer.setSnapshot(snapshot);
}
