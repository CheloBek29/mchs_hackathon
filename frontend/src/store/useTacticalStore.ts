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
  setPendingPlacement: (request: TacticalPlacementRequest) => void;
  clearPendingPlacement: () => void;
  showTransientMessage: (message: string, durationMs?: number) => void;
  clearTransientMessage: () => void;
};

let transientTimer: ReturnType<typeof setTimeout> | null = null;

export const useTacticalStore = create<TacticalStoreState>((set) => ({
  pendingPlacement: null,
  transientMessage: '',

  setPendingPlacement: (request) => {
    set({ pendingPlacement: request });
  },

  clearPendingPlacement: () => {
    set({ pendingPlacement: null });
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
