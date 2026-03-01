import { create } from 'zustand';

export type SimulationCameraMode = 'ISO_LOCKED' | 'TOP_DOWN' | 'ORBIT_FREE';

type CameraTarget = {
  x: number;
  y: number;
};

type SceneBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

type SimulationCameraState = {
  mode: SimulationCameraMode;
  zoom: number;
  target: CameraTarget;
  yaw: number;
  pitch: number;
  setMode: (mode: SimulationCameraMode) => void;
  setZoom: (zoom: number) => void;
  zoomBy: (factor: number) => void;
  setTarget: (target: CameraTarget) => void;
  panBy: (deltaX: number, deltaY: number) => void;
  orbitBy: (deltaYaw: number, deltaPitch: number) => void;
  fitToBounds: (bounds: SceneBounds) => void;
  reset: () => void;
};

const ZOOM_MIN = 0.35;
const ZOOM_MAX = 4.5;
const PITCH_MIN = 0.31;
const PITCH_MAX = 1.45;

const ISO_PRESET = {
  yaw: -Math.PI / 4,
  pitch: 0.78,
};
const TOP_DOWN_PRESET = {
  yaw: -Math.PI / 2,
  pitch: 1.45,
};
const ORBIT_PRESET = {
  yaw: -Math.PI / 3,
  pitch: 0.74,
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const sanitizeBounds = (value: number, fallback: number): number => {
  return Number.isFinite(value) ? value : fallback;
};

const resolvePreset = (mode: SimulationCameraMode): { yaw: number; pitch: number } => {
  if (mode === 'TOP_DOWN') {
    return TOP_DOWN_PRESET;
  }
  if (mode === 'ORBIT_FREE') {
    return ORBIT_PRESET;
  }
  return ISO_PRESET;
};

export const useSimulationCameraStore = create<SimulationCameraState>((set, get) => ({
  mode: 'ISO_LOCKED',
  zoom: 1,
  target: { x: 0, y: 0 },
  yaw: ISO_PRESET.yaw,
  pitch: ISO_PRESET.pitch,

  setMode: (mode) => {
    const preset = resolvePreset(mode);
    set((state) => {
      if (mode === state.mode) {
        return {
          mode,
          yaw: clamp(state.yaw, -Math.PI * 2, Math.PI * 2),
          pitch: clamp(state.pitch, PITCH_MIN, PITCH_MAX),
        };
      }
      return {
        mode,
        yaw: preset.yaw,
        pitch: preset.pitch,
      };
    });
  },

  setZoom: (zoom) => {
    set({
      zoom: clamp(Number.isFinite(zoom) ? zoom : 1, ZOOM_MIN, ZOOM_MAX),
    });
  },

  zoomBy: (factor) => {
    const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
    const nextZoom = get().zoom * safeFactor;
    set({
      zoom: clamp(nextZoom, ZOOM_MIN, ZOOM_MAX),
    });
  },

  setTarget: (target) => {
    const x = sanitizeBounds(target.x, 0);
    const y = sanitizeBounds(target.y, 0);
    set({ target: { x, y } });
  },

  panBy: (deltaX, deltaY) => {
    set((state) => {
      const nextX = state.target.x + (Number.isFinite(deltaX) ? deltaX : 0);
      const nextY = state.target.y + (Number.isFinite(deltaY) ? deltaY : 0);
      return {
        target: {
          x: nextX,
          y: nextY,
        },
      };
    });
  },

  orbitBy: (deltaYaw, deltaPitch) => {
    set((state) => ({
      yaw: state.yaw + (Number.isFinite(deltaYaw) ? deltaYaw : 0),
      pitch: clamp(state.pitch + (Number.isFinite(deltaPitch) ? deltaPitch : 0), PITCH_MIN, PITCH_MAX),
    }));
  },

  fitToBounds: (bounds) => {
    const minX = sanitizeBounds(bounds.minX, -20);
    const maxX = sanitizeBounds(bounds.maxX, 20);
    const minY = sanitizeBounds(bounds.minY, -20);
    const maxY = sanitizeBounds(bounds.maxY, 20);

    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const span = Math.max(width, height);
    const mode = get().mode;

    const zoomFromSpan = mode === 'TOP_DOWN'
      ? 110 / span
      : mode === 'ORBIT_FREE'
        ? 90 / span
        : 84 / span;

    set({
      target: {
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2,
      },
      zoom: clamp(zoomFromSpan, 0.55, 2.1),
    });
  },

  reset: () => {
    set({
      mode: 'ISO_LOCKED',
      zoom: 1,
      target: { x: 0, y: 0 },
      yaw: ISO_PRESET.yaw,
      pitch: ISO_PRESET.pitch,
    });
  },
}));
