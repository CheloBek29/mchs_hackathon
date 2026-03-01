import { create } from 'zustand';
import type { DeploymentStatus, GeometryType, ResourceKind } from '../shared/api/types';

export type TacticalPlacementRequest = {
  resourceKind: ResourceKind;
  label: string;
  geometryType: GeometryType;
  status: DeploymentStatus;
  source: string;
  roleLabel: string;
  vehicleId?: number;
  resourceData?: Record<string, unknown>;
};

type TacticalStoreState = {
  pendingPlacement: TacticalPlacementRequest | null;
  transientMessage: string;
  maxHoseLength: number;
  setPendingPlacement: (request: TacticalPlacementRequest) => void;
  clearPendingPlacement: () => void;
  setMaxHoseLength: (length: number) => void;
  showTransientMessage: (message: string, durationMs?: number) => void;
  clearTransientMessage: () => void;
};

let transientTimer: ReturnType<typeof setTimeout> | null = null;

export const useTacticalStore = create<TacticalStoreState>((set) => ({
  pendingPlacement: null,
  transientMessage: '',
  maxHoseLength: 40,

  setPendingPlacement: (request) => {
    set({ pendingPlacement: request });
  },

  clearPendingPlacement: () => {
    set({ pendingPlacement: null });
  },

  setMaxHoseLength: (length) => {
    const normalized = Number.isFinite(length) ? Math.max(10, Math.min(200, Math.round(length))) : 40;
    set({ maxHoseLength: normalized });
  },

  showTransientMessage: (message, durationMs = 3200) => {
    if (transientTimer) {
      clearTimeout(transientTimer);
      transientTimer = null;
    }

    set({ transientMessage: message });

    transientTimer = setTimeout(() => {
      set({ transientMessage: '' });
      transientTimer = null;
    }, durationMs);
  },

  clearTransientMessage: () => {
    if (transientTimer) {
      clearTimeout(transientTimer);
      transientTimer = null;
    }
    set({ transientMessage: '' });
  },
}));
