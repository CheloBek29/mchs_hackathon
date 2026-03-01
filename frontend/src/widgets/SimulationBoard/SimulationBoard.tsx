import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RadioConsole } from '../../features/Radio/ui/RadioConsole';
import { extractFireRuntime } from '../../shared/api/fireRuntimeTypes';
import type { DeploymentStatus, FireObjectDto, GeometryType, ResourceDeploymentDto } from '../../shared/api/types';
import { PixelButton } from '../../shared/ui/PixelButton';
import { PhysicsIsometricView } from '../../shared/visualization/PhysicsIsometricView';
import { RetroSimView } from '../../shared/visualization/RetroSimView';
import { ThreeSimView } from '../../shared/visualization/ThreeSimView';
import { useAuthStore } from '../../store/useAuthStore';
import { useDispatcherStore } from '../../store/useDispatcherStore';
import { useRealtimeStore } from '../../store/useRealtimeStore';
import { useTacticalStore } from '../../store/useTacticalStore';

type Point = { x: number; y: number };

type WorldViewport = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
};

type DragState = {
  start: Point;
  basePan: Point;
  moved: boolean;
};

type FireRuntimeVehicleState = {
  waterCapacityL: number;
  waterRemainingL: number;
  isEmpty: boolean;
  minutesUntilEmptyMins: number | null;
  updatedAtMs: number | null;
};

type FireRuntimeHoseState = {
  hasWater: boolean;
  linkedVehicleId: number | null;
  strictChain: boolean;
  chainId: string;
  blockedReason: string;
};

type FireRuntimeNozzleState = {
  hasWater: boolean;
  linkedVehicleId: number | null;
  linkedHoseLineId: string;
  linkedHoseLineChainId: string;
  strictChain: boolean;
  effectiveFlowLps: number;
  availablePressureBar: number;
  lineLossBar: number;
  pressureFactor: number;
  lineLengthM: number;
  hoseType: string;
  blockedReason: string;
};

type ChainLinkKind = 'VEHICLE_TO_HOSE' | 'HOSE_TO_NOZZLE' | 'VEHICLE_TO_NOZZLE';

type ChainLinkState = {
  id: string;
  kind: ChainLinkKind;
  from: Point;
  to: Point;
  fromKey: string;
  toKey: string;
  hasWater: boolean;
  strictChain: boolean;
  blockedReason: string;
  roleTag: string;
  highlighted: boolean;
};

type TacticalChainGraph = {
  links: ChainLinkState[];
  activeLinks: number;
  dryLinks: number;
  strictLinks: number;
  brokenLinks: number;
  vehicleToHoseLinks: number;
  hoseToNozzleLinks: number;
  vehicleToNozzleLinks: number;
};

type ParsedFireRuntime = {
  vehicleRuntimeById: Map<number, FireRuntimeVehicleState>;
  hoseRuntimeById: Map<string, FireRuntimeHoseState>;
  nozzleRuntimeById: Map<string, FireRuntimeNozzleState>;
  schemaVersion: string | null;
  updatedAtMs: number | null;
  activeNozzles: number | null;
  wetNozzles: number | null;
  wetHoseLines: number | null;
  effectiveFlowLps: number | null;
  consumedWaterLTick: number | null;
  activeFireObjects: number | null;
  activeSmokeObjects: number | null;
  qRequiredLps: number | null;
  qEffectiveLps: number | null;
  suppressionRatio: number | null;
  forecast: string | null;
  tickLagSec: number | null;
};

type NozzleRuntimeItem = {
  id: string;
  roleTag: string;
  center: Point | null;
  flowLps: number;
  strictChain: boolean;
  linkedHoseLineId: string;
  linkedHoseLineChainId: string;
  linkedVehicleId: number | null;
};

type HydraulicRuntime = {
  wetNozzleIds: Set<string>;
  wetHoseLineIds: Set<string>;
  nozzleFlowById: Map<string, number>;
  nozzleVehicleById: Map<string, number>;
  wetNozzleCount: number;
  effectiveFlowVisibleLps: number;
};

type SceneLayerItem = {
  id: string;
  kind: string;
  geometryType: GeometryType;
  geometry: Record<string, unknown>;
  label: string;
  props: Record<string, unknown>;
};

type SceneLayerData = {
  activeFloorId: string;
  siteItems: SceneLayerItem[];
  floorItems: SceneLayerItem[];
  fireSourceItems: SceneLayerItem[];
  smokeSourceItems: SceneLayerItem[];
};

type DeploymentCharacteristic = {
  label: string;
  value: string;
};

const DEFAULT_WORLD_WIDTH = 240;
const DEFAULT_WORLD_HEIGHT = 160;
const MAX_VIEWPORT_SPAN = 520;
const CANVAS_PADDING_PX = 24;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 5.5;

const DEPLOYMENT_COLORS: Record<string, string> = {
  PLANNED: '#9ca3af',
  EN_ROUTE: '#d97706',
  DEPLOYED: '#22c55e',
  ACTIVE: '#ef4444',
  COMPLETED: '#6b7280',
};

const DEPLOYMENT_HINT_LABELS: Record<string, string> = {
  PLANNED: 'готовится',
  EN_ROUTE: 'в пути',
  DEPLOYED: 'на месте',
  ACTIVE: 'работает',
  COMPLETED: 'завершено',
};

const BLOCKED_REASON_LABELS: Record<string, string> = {
  NO_LINKED_HOSE: 'нет привязанного рукава',
  NO_LINKED_SPLITTER: 'нет привязанного разветвления',
  NO_LINKED_VEHICLE: 'нет привязанной машины',
  NO_WATER_SOURCE: 'нет подачи воды',
  NO_PRESSURE: 'недостаточное давление в линии',
};

const FIRE_KINDS = new Set(['FIRE_SEAT', 'FIRE_ZONE']);
const SMOKE_KINDS = new Set(['SMOKE_ZONE']);

const DEPLOYMENT_ACTIONS_BY_STATUS: Record<
  DeploymentStatus,
  { nextStatus: DeploymentStatus; label: string } | null
> = {
  PLANNED: { nextStatus: 'EN_ROUTE', label: 'В ПУТЬ' },
  EN_ROUTE: { nextStatus: 'DEPLOYED', label: 'НА ПОЗИЦИЮ' },
  DEPLOYED: { nextStatus: 'ACTIVE', label: 'АКТИВИРОВАТЬ' },
  ACTIVE: { nextStatus: 'COMPLETED', label: 'ЗАВЕРШИТЬ' },
  COMPLETED: { nextStatus: 'DEPLOYED', label: 'ВЕРНУТЬ НА ПОЗИЦИЮ' },
};

const numberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

const toPoint = (value: unknown): Point | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const x = numberOrNull(raw.x);
  const y = numberOrNull(raw.y);
  if (x === null || y === null) {
    return null;
  }
  return { x, y };
};

const extractGeometryPoints = (geometryType: GeometryType, geometry: Record<string, unknown>): Point[] => {
  if (geometryType === 'POINT') {
    const point = toPoint(geometry);
    return point ? [point] : [];
  }

  const rawPoints = geometry.points;
  if (!Array.isArray(rawPoints)) {
    return [];
  }

  return rawPoints
    .map((entry) => toPoint(entry))
    .filter((entry): entry is Point => entry !== null);
};

const buildViewport = (points: Point[]): WorldViewport => {
  if (points.length === 0) {
    return {
      minX: -DEFAULT_WORLD_WIDTH / 2,
      maxX: DEFAULT_WORLD_WIDTH / 2,
      minY: -DEFAULT_WORLD_HEIGHT / 2,
      maxY: DEFAULT_WORLD_HEIGHT / 2,
      width: DEFAULT_WORLD_WIDTH,
      height: DEFAULT_WORLD_HEIGHT,
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  points.forEach((point) => {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  });

  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const margin = Math.max(15, Math.max(width, height) * 0.18);

  const expanded = {
    minX: minX - margin,
    maxX: maxX + margin,
    minY: minY - margin,
    maxY: maxY + margin,
  };

  let viewportWidth = expanded.maxX - expanded.minX;
  let viewportHeight = expanded.maxY - expanded.minY;
  const viewportCenterX = (expanded.minX + expanded.maxX) / 2;
  const viewportCenterY = (expanded.minY + expanded.maxY) / 2;

  if (viewportWidth > MAX_VIEWPORT_SPAN) {
    viewportWidth = MAX_VIEWPORT_SPAN;
  }
  if (viewportHeight > MAX_VIEWPORT_SPAN) {
    viewportHeight = MAX_VIEWPORT_SPAN;
  }

  const finalMinX = viewportCenterX - viewportWidth / 2;
  const finalMaxX = viewportCenterX + viewportWidth / 2;
  const finalMinY = viewportCenterY - viewportHeight / 2;
  const finalMaxY = viewportCenterY + viewportHeight / 2;

  return {
    minX: finalMinX,
    maxX: finalMaxX,
    minY: finalMinY,
    maxY: finalMaxY,
    width: viewportWidth,
    height: viewportHeight,
  };
};

const worldToCanvasBase = (point: Point, width: number, height: number, viewport: WorldViewport): Point => {
  const usableWidth = width - CANVAS_PADDING_PX * 2;
  const usableHeight = height - CANVAS_PADDING_PX * 2;

  return {
    x: CANVAS_PADDING_PX + ((point.x - viewport.minX) / Math.max(1e-6, viewport.width)) * usableWidth,
    y: CANVAS_PADDING_PX + ((viewport.maxY - point.y) / Math.max(1e-6, viewport.height)) * usableHeight,
  };
};

const canvasBaseToWorld = (point: Point, width: number, height: number, viewport: WorldViewport): Point => {
  const usableWidth = width - CANVAS_PADDING_PX * 2;
  const usableHeight = height - CANVAS_PADDING_PX * 2;

  const normalizedX = (point.x - CANVAS_PADDING_PX) / Math.max(1, usableWidth);
  const normalizedY = (point.y - CANVAS_PADDING_PX) / Math.max(1, usableHeight);

  return {
    x: viewport.minX + normalizedX * viewport.width,
    y: viewport.maxY - normalizedY * viewport.height,
  };
};

const applyViewTransform = (point: Point, width: number, height: number, zoom: number, pan: Point): Point => {
  const centerX = width / 2;
  const centerY = height / 2;
  return {
    x: centerX + (point.x - centerX) * zoom + pan.x,
    y: centerY + (point.y - centerY) * zoom + pan.y,
  };
};

const unapplyViewTransform = (point: Point, width: number, height: number, zoom: number, pan: Point): Point => {
  const centerX = width / 2;
  const centerY = height / 2;
  return {
    x: centerX + (point.x - centerX - pan.x) / Math.max(1e-6, zoom),
    y: centerY + (point.y - centerY - pan.y) / Math.max(1e-6, zoom),
  };
};

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
};

const parseCreatedAt = (value: string): number => {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const getVisibleDeployments = (deployments: ResourceDeploymentDto[]): ResourceDeploymentDto[] => {
  const latestVehicleById = new Map<number, ResourceDeploymentDto>();
  const nonVehicle: ResourceDeploymentDto[] = [];

  deployments.forEach((deployment) => {
    if (deployment.resource_kind !== 'VEHICLE') {
      nonVehicle.push(deployment);
      return;
    }

    const vehicleId = deployment.vehicle_dictionary_id;
    if (!vehicleId) {
      nonVehicle.push(deployment);
      return;
    }

    const previous = latestVehicleById.get(vehicleId);
    if (!previous || parseCreatedAt(deployment.created_at) >= parseCreatedAt(previous.created_at)) {
      latestVehicleById.set(vehicleId, deployment);
    }
  });

  return [...Array.from(latestVehicleById.values()), ...nonVehicle].sort(
    (a, b) => parseCreatedAt(a.created_at) - parseCreatedAt(b.created_at),
  );
};

const distanceSquared = (a: Point, b: Point): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

const distanceToSegment = (point: Point, start: Point, end: Point): number => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
    return Math.sqrt(distanceSquared(point, start));
  }

  const t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, t));

  const projected = {
    x: start.x + clamped * dx,
    y: start.y + clamped * dy,
  };
  return Math.sqrt(distanceSquared(point, projected));
};

const polylineLengthMeters = (points: Point[]): number => {
  if (points.length < 2) {
    return 0;
  }
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const dx = points[index].x - points[index - 1].x;
    const dy = points[index].y - points[index - 1].y;
    length += Math.sqrt(dx * dx + dy * dy);
  }
  return length;
};

const isPointNearPolyline = (point: Point, points: Point[], thresholdPx: number): boolean => {
  for (let index = 1; index < points.length; index += 1) {
    if (distanceToSegment(point, points[index - 1], points[index]) <= thresholdPx) {
      return true;
    }
  }
  return false;
};

const isPointInsidePolygon = (point: Point, polygon: Point[]): boolean => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
};

const pickScaleBarLengthByPixels = (pixelsPerMeter: number): number => {
  if (!Number.isFinite(pixelsPerMeter) || pixelsPerMeter <= 0) {
    return 10;
  }

  const targetPx = 110;
  const minPx = 56;
  const maxPx = 180;
  const roughMeters = targetPx / pixelsPerMeter;

  const exponent = Math.floor(Math.log10(Math.max(roughMeters, 0.1)));
  const base = Math.pow(10, exponent);
  const multipliers = [1, 2, 5, 10];

  let bestMeters = base;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const multiplier of multipliers) {
    const meters = base * multiplier;
    const pixels = meters * pixelsPerMeter;
    if (pixels >= minPx && pixels <= maxPx) {
      return meters;
    }
    const distance = Math.abs(pixels - targetPx);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMeters = meters;
    }
  }

  return Math.max(0.5, bestMeters);
};

const formatScaleDistance = (meters: number): string => {
  if (meters >= 1000) {
    const km = meters / 1000;
    return Number.isInteger(km) ? `${km} км` : `${km.toFixed(1)} км`;
  }
  return Number.isInteger(meters) ? `${meters} м` : `${meters.toFixed(1)} м`;
};

const parseIsoTimestampMs = (value: unknown): number | null => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return timestamp;
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const toRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const formatLiters = (value: number): string => {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return Math.max(0, Math.round(value)).toLocaleString('ru-RU');
};

const normalizeFlowLps = (value: unknown, fallback = 3.5): number => {
  const parsed = numberOrNull(value);
  if (parsed === null) {
    return fallback;
  }
  return clamp(parsed, 1, 12);
};

const extractGeometryCenter = (geometryType: GeometryType, geometry: Record<string, unknown>): Point | null => {
  const points = extractGeometryPoints(geometryType, geometry);
  if (points.length === 0) {
    return null;
  }
  if (geometryType === 'POINT') {
    return points[0];
  }

  const sum = points.reduce(
    (accumulator, point) => ({
      x: accumulator.x + point.x,
      y: accumulator.y + point.y,
    }),
    { x: 0, y: 0 },
  );

  return {
    x: sum.x / points.length,
    y: sum.y / points.length,
  };
};

const parseFireRuntimeSnapshot = (snapshotData: Record<string, unknown> | null): ParsedFireRuntime => {
  const parsed: ParsedFireRuntime = {
    vehicleRuntimeById: new Map(),
    hoseRuntimeById: new Map(),
    nozzleRuntimeById: new Map(),
    schemaVersion: null,
    updatedAtMs: null,
    activeNozzles: null,
    wetNozzles: null,
    wetHoseLines: null,
    effectiveFlowLps: null,
    consumedWaterLTick: null,
    activeFireObjects: null,
    activeSmokeObjects: null,
    qRequiredLps: null,
    qEffectiveLps: null,
    suppressionRatio: null,
    forecast: null,
    tickLagSec: null,
  };

  const fireRuntime = extractFireRuntime(snapshotData);
  if (
    Object.keys(fireRuntime.vehicle_runtime).length === 0
    && Object.keys(fireRuntime.hose_runtime).length === 0
    && Object.keys(fireRuntime.nozzle_runtime).length === 0
    && !fireRuntime.updated_at
  ) {
    return parsed;
  }

  parsed.schemaVersion = typeof fireRuntime.schema_version === 'string' ? fireRuntime.schema_version : null;
  parsed.updatedAtMs = parseIsoTimestampMs(fireRuntime.updated_at);
  parsed.activeNozzles = numberOrNull(fireRuntime.active_nozzles);
  parsed.wetNozzles = numberOrNull(fireRuntime.wet_nozzles);
  parsed.wetHoseLines = numberOrNull(fireRuntime.wet_hose_lines);
  parsed.effectiveFlowLps = numberOrNull(fireRuntime.effective_flow_l_s);
  parsed.consumedWaterLTick = numberOrNull(fireRuntime.consumed_water_l_tick);
  parsed.activeFireObjects = numberOrNull(fireRuntime.active_fire_objects);
  parsed.activeSmokeObjects = numberOrNull(fireRuntime.active_smoke_objects);
  parsed.qRequiredLps = numberOrNull(fireRuntime.q_required_l_s);
  parsed.qEffectiveLps = numberOrNull(fireRuntime.q_effective_l_s);
  parsed.suppressionRatio = numberOrNull(fireRuntime.suppression_ratio);
  parsed.forecast = typeof fireRuntime.forecast === 'string' ? fireRuntime.forecast : null;
  parsed.tickLagSec = numberOrNull(fireRuntime.runtime_health?.tick_lag_sec);

  Object.entries(fireRuntime.hose_runtime ?? {}).forEach(([deploymentId, value]) => {
      const runtimeState = toRecord(value);
      if (!runtimeState) {
        return;
      }

      parsed.hoseRuntimeById.set(deploymentId, {
        hasWater: runtimeState.has_water === true,
        linkedVehicleId: numberOrNull(runtimeState.linked_vehicle_id),
        strictChain: runtimeState.strict_chain === true,
        chainId: typeof runtimeState.chain_id === 'string' ? runtimeState.chain_id : '',
        blockedReason: typeof runtimeState.blocked_reason === 'string' ? runtimeState.blocked_reason : '',
      });
    });

  Object.entries(fireRuntime.nozzle_runtime ?? {}).forEach(([deploymentId, value]) => {
      const runtimeState = toRecord(value);
      if (!runtimeState) {
        return;
      }

      parsed.nozzleRuntimeById.set(deploymentId, {
        hasWater: runtimeState.has_water === true,
        linkedVehicleId: numberOrNull(runtimeState.linked_vehicle_id),
        linkedHoseLineId: typeof runtimeState.linked_hose_line_id === 'string' ? runtimeState.linked_hose_line_id : '',
        linkedHoseLineChainId:
          typeof runtimeState.linked_hose_line_chain_id === 'string' ? runtimeState.linked_hose_line_chain_id : '',
        strictChain: runtimeState.strict_chain === true,
        effectiveFlowLps: Math.max(0, numberOrNull(runtimeState.effective_flow_l_s) ?? 0),
        availablePressureBar: Math.max(0, numberOrNull(runtimeState.available_pressure_bar) ?? 0),
        lineLossBar: Math.max(0, numberOrNull(runtimeState.line_loss_bar) ?? 0),
        pressureFactor: Math.max(0, numberOrNull(runtimeState.pressure_factor) ?? 0),
        lineLengthM: Math.max(0, numberOrNull(runtimeState.line_length_m) ?? 0),
        hoseType: typeof runtimeState.hose_type === 'string' ? runtimeState.hose_type : '',
        blockedReason: typeof runtimeState.blocked_reason === 'string' ? runtimeState.blocked_reason : '',
      });
    });

  Object.entries(fireRuntime.vehicle_runtime ?? {}).forEach(([key, value]) => {
    const vehicleId = Number.parseInt(key, 10);
    if (!Number.isFinite(vehicleId) || vehicleId <= 0) {
      return;
    }

    const runtimeState = toRecord(value);
    if (!runtimeState) {
      return;
    }

    const waterCapacityL = numberOrNull(runtimeState.water_capacity_l);
    const waterRemainingL = numberOrNull(runtimeState.water_remaining_l);
    if (waterCapacityL === null && waterRemainingL === null) {
      return;
    }

    const normalizedCapacity = Math.max(0, waterCapacityL ?? waterRemainingL ?? 0);
    const normalizedRemaining = clamp(waterRemainingL ?? normalizedCapacity, 0, Math.max(normalizedCapacity, 0));

    parsed.vehicleRuntimeById.set(vehicleId, {
      waterCapacityL: normalizedCapacity,
      waterRemainingL: normalizedRemaining,
      isEmpty: runtimeState.is_empty === true || normalizedRemaining <= 0.01,
      minutesUntilEmptyMins: numberOrNull(runtimeState.minutes_until_empty),
      updatedAtMs: parseIsoTimestampMs(runtimeState.updated_at),
    });
  });

  return parsed;
};

const parseSceneLayer = (snapshotData: Record<string, unknown> | null): SceneLayerData => {
  const empty: SceneLayerData = {
    activeFloorId: 'F1',
    siteItems: [],
    floorItems: [],
    fireSourceItems: [],
    smokeSourceItems: [],
  };

  if (!snapshotData) {
    return empty;
  }

  const scene = toRecord(snapshotData.training_lead_scene);
  if (!scene) {
    return empty;
  }

  const parseItem = (itemRaw: Record<string, unknown>, fallbackKind = 'UNKNOWN'): SceneLayerItem | null => {
    const geometryTypeRaw = typeof itemRaw.geometry_type === 'string' ? itemRaw.geometry_type.toUpperCase() : '';
    if (geometryTypeRaw !== 'POINT' && geometryTypeRaw !== 'LINESTRING' && geometryTypeRaw !== 'POLYGON') {
      return null;
    }

    const geometry = toRecord(itemRaw.geometry);
    if (!geometry) {
      return null;
    }

    const kind = typeof itemRaw.kind === 'string' ? itemRaw.kind.toUpperCase() : fallbackKind;
    const label = typeof itemRaw.label === 'string' ? itemRaw.label : kind;
    const id = typeof itemRaw.id === 'string' ? itemRaw.id : `${kind}:${label}`;

    return {
      id,
      kind,
      geometryType: geometryTypeRaw,
      geometry,
      label,
      props: toRecord(itemRaw.props) ?? {},
    };
  };

  const siteItems: SceneLayerItem[] = [];
  const siteEntities = Array.isArray(scene.site_entities) ? scene.site_entities : [];
  siteEntities.forEach((entry) => {
    const raw = toRecord(entry);
    if (!raw) {
      return;
    }
    const item = parseItem(raw, 'SITE_ENTITY');
    if (item) {
      siteItems.push(item);
    }
  });

  const activeFloorId = typeof scene.active_floor_id === 'string' && scene.active_floor_id.trim().length > 0
    ? scene.active_floor_id
    : 'F1';

  const floors = Array.isArray(scene.floors) ? scene.floors : [];
  const selectedFloor = floors.find((entry) => {
    const raw = toRecord(entry);
    return raw && typeof raw.floor_id === 'string' && raw.floor_id === activeFloorId;
  }) ?? floors[0];

  const floorRaw = toRecord(selectedFloor);
  if (!floorRaw) {
    return {
      ...empty,
      activeFloorId,
      siteItems,
    };
  }

  const floorItems: SceneLayerItem[] = [];
  const objects = Array.isArray(floorRaw.objects) ? floorRaw.objects : [];
  objects.forEach((entry) => {
    const raw = toRecord(entry);
    if (!raw) {
      return;
    }
    const item = parseItem(raw, 'SCENE_OBJECT');
    if (item) {
      floorItems.push(item);
    }
  });

  return {
    activeFloorId: typeof floorRaw.floor_id === 'string' ? floorRaw.floor_id : activeFloorId,
    siteItems,
    floorItems,
    fireSourceItems: floorItems.filter((item) => item.kind === 'FIRE_SOURCE'),
    smokeSourceItems: floorItems.filter((item) => item.kind === 'SMOKE_ZONE'),
  };
};

const resolveNozzleFlowFromDeployment = (deployment: ResourceDeploymentDto): number => {
  const resourceData = toRecord(deployment.resource_data);
  if (!resourceData) {
    return 3.5;
  }
  return normalizeFlowLps(
    resourceData.nozzle_flow_l_s ?? resourceData.intensity_l_s ?? resourceData.flow_l_s,
    3.5,
  );
};

const getFireAreaM2 = (fireObject: FireObjectDto): number => {
  const area = numberOrNull(fireObject.area_m2);
  if (area !== null && area > 0) {
    return area;
  }

  if (fireObject.kind === 'SMOKE_ZONE') {
    return 32;
  }
  if (fireObject.kind === 'FIRE_ZONE') {
    return 48;
  }
  return 25;
};

const resolveChainIdFromResourceData = (resourceData: Record<string, unknown> | null): string => {
  if (!resourceData) {
    return '';
  }

  if (typeof resourceData.chain_id === 'string' && resourceData.chain_id.trim().length > 0) {
    return resourceData.chain_id;
  }
  if (
    typeof resourceData.linked_hose_line_chain_id === 'string'
    && resourceData.linked_hose_line_chain_id.trim().length > 0
  ) {
    return resourceData.linked_hose_line_chain_id;
  }
  return '';
};

const resolveLinkedHoseRefFromResourceData = (
  resourceData: Record<string, unknown> | null,
): { hoseId: string; chainId: string } => {
  if (!resourceData) {
    return { hoseId: '', chainId: '' };
  }

  const hoseId =
    typeof resourceData.linked_hose_line_id === 'string'
      ? resourceData.linked_hose_line_id
      : typeof resourceData.hose_line_deployment_id === 'string'
        ? resourceData.hose_line_deployment_id
        : '';
  const chainId =
    typeof resourceData.linked_hose_line_chain_id === 'string'
      ? resourceData.linked_hose_line_chain_id
      : typeof resourceData.hose_line_chain_id === 'string'
        ? resourceData.hose_line_chain_id
        : '';

  return {
    hoseId,
    chainId,
  };
};

const formatDurationMmSs = (totalSeconds: number): string => {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const formatGameClock = (secondsRaw: number): string => {
  const normalized = Math.max(0, Math.floor(secondsRaw) % (24 * 60 * 60));
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  const seconds = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

type RoleView = 'DISPATCHER' | 'RTP' | 'HQ' | 'BU1' | 'BU2' | 'OTHER';

const resolveRoleView = (activeRole?: string): RoleView => {
  if (activeRole === 'ДИСПЕЧЕР') {
    return 'DISPATCHER';
  }
  if (activeRole === 'РТП') {
    return 'RTP';
  }
  if (activeRole === 'ШТАБ') {
    return 'HQ';
  }
  if (activeRole === 'БУ - 1') {
    return 'BU1';
  }
  if (activeRole === 'БУ - 2') {
    return 'BU2';
  }
  return 'OTHER';
};

const normalizeDeploymentRoleTag = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    return '';
  }

  if (normalized === 'БУ - 1' || normalized === 'БУ1' || normalized === 'COMBAT_AREA_1') {
    return 'BU1';
  }
  if (normalized === 'БУ - 2' || normalized === 'БУ2' || normalized === 'COMBAT_AREA_2') {
    return 'BU2';
  }
  if (normalized === 'ШТАБ' || normalized === 'HQ') {
    return 'HQ';
  }
  if (normalized === 'РТП' || normalized === 'RTP') {
    return 'RTP';
  }
  if (normalized === 'ДИСПЕТЧЕР' || normalized === 'DISPATCHER') {
    return 'DISPATCHER';
  }
  return normalized;
};

const normalizeCommandPointTag = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }

  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    return '';
  }

  if (normalized === 'BU1' || normalized === 'БУ1' || normalized === 'БУ - 1' || normalized === 'БУ-1') {
    return 'BU1';
  }
  if (normalized === 'BU2' || normalized === 'БУ2' || normalized === 'БУ - 2' || normalized === 'БУ-2') {
    return 'BU2';
  }
  if (normalized === 'HQ' || normalized === 'ШТАБ') {
    return 'HQ';
  }
  return normalized;
};

const getDeploymentRoleTag = (deployment: ResourceDeploymentDto): string => {
  const resourceData = deployment.resource_data;
  if (!resourceData || typeof resourceData !== 'object') {
    return '';
  }

  const raw = resourceData as Record<string, unknown>;
  return normalizeDeploymentRoleTag(raw.role ?? raw.initiated_from_role);
};

const isDeploymentVisibleForRole = (deployment: ResourceDeploymentDto, roleView: RoleView): boolean => {
  if (roleView === 'RTP' || roleView === 'DISPATCHER' || roleView === 'OTHER') {
    return true;
  }

  const deploymentRoleTag = getDeploymentRoleTag(deployment);

  if (roleView === 'HQ') {
    return deploymentRoleTag !== 'BU1' && deploymentRoleTag !== 'BU2';
  }

  if (roleView === 'BU1') {
    if (deployment.resource_kind === 'VEHICLE') {
      return deploymentRoleTag === 'BU1';
    }
    return deploymentRoleTag !== 'BU2';
  }

  if (roleView === 'BU2') {
    if (deployment.resource_kind === 'VEHICLE') {
      return deploymentRoleTag === 'BU2';
    }
    return deploymentRoleTag !== 'BU1';
  }

  return true;
};

const canManageDeploymentForRole = (deployment: ResourceDeploymentDto, roleView: RoleView): boolean => {
  if (roleView === 'OTHER') {
    return true;
  }

  if (roleView === 'DISPATCHER') {
    return false;
  }

  if (roleView === 'RTP' || roleView === 'HQ') {
    return false;
  }

  const deploymentRoleTag = getDeploymentRoleTag(deployment);
  if (roleView === 'BU1') {
    return deploymentRoleTag === 'BU1';
  }
  if (roleView === 'BU2') {
    return deploymentRoleTag === 'BU2';
  }

  return true;
};

interface SimulationBoardProps {
  activeRole?: string;
  isReadOnly?: boolean;
}

type BoardViewportMode = 'TACTICAL' | 'SIM_25D' | 'SIM_3D' | 'RETRO';

export const SimulationBoard: React.FC<SimulationBoardProps> = ({ activeRole, isReadOnly = false }) => {
  const user = useAuthStore((state) => state.user);
  const realtimeBundle = useRealtimeStore((state) => state.bundle);
  const realtimeSessionId = useRealtimeStore((state) => state.sessionId);
  const sendRealtimeCommand = useRealtimeStore((state) => state.sendCommand);

  const dispatcherBannerText = useDispatcherStore((state) => state.bannerText);

  const pendingPlacement = useTacticalStore((state) => state.pendingPlacement);
  const maxHoseLength = useTacticalStore((state) => state.maxHoseLength);
  const clearPendingPlacement = useTacticalStore((state) => state.clearPendingPlacement);
  const transientMessage = useTacticalStore((state) => state.transientMessage);
  const showTransientMessage = useTacticalStore((state) => state.showTransientMessage);

  const [viewZoom, setViewZoom] = useState(1);
  const [viewPan, setViewPan] = useState<Point>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [hoverPlacementPoint, setHoverPlacementPoint] = useState<Point | null>(null);
  const [linePlacementStart, setLinePlacementStart] = useState<Point | null>(null);
  const [placementError, setPlacementError] = useState('');
  const [isPlacing, setIsPlacing] = useState(false);
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string | null>(null);
  const [nozzleSettings, setNozzleSettings] = useState({ spray_angle: 0, pressure: 60 });
  const [isApplyingNozzleSettings, setIsApplyingNozzleSettings] = useState(false);
  const [deploymentActionError, setDeploymentActionError] = useState('');
  const [isUpdatingDeployment, setIsUpdatingDeployment] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 980, height: 560 });
  const [nowTickMs, setNowTickMs] = useState(() => Date.now());
  const [viewportMode, setViewportMode] = useState<BoardViewportMode>('TACTICAL');
  const [isMiniMapVisible, setIsMiniMapVisible] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasHolderRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressNextClickRef = useRef(false);

  const bundle = useMemo(() => {
    if (!user?.session_id || !realtimeBundle) {
      return null;
    }
    if (realtimeSessionId !== user.session_id) {
      return null;
    }
    return realtimeBundle;
  }, [realtimeBundle, realtimeSessionId, user?.session_id]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowTickMs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  const roleView = useMemo(() => resolveRoleView(activeRole), [activeRole]);
  const currentBuRoleTag = roleView === 'BU1' ? 'BU1' : roleView === 'BU2' ? 'BU2' : '';
  const currentBuLabel = roleView === 'BU1' ? 'БУ-1' : roleView === 'BU2' ? 'БУ-2' : '';
  const isBuRole = roleView === 'BU1' || roleView === 'BU2';
  const isRtpRole = roleView === 'RTP';
  const isHqRole = roleView === 'HQ';
  const isDispatcherRole = roleView === 'DISPATCHER';

  const snapshotData = useMemo(() => {
    const raw = bundle?.snapshot?.snapshot_data;
    return toRecord(raw);
  }, [bundle?.snapshot?.snapshot_data]);

  const fireRuntime = useMemo(() => parseFireRuntimeSnapshot(snapshotData), [snapshotData]);
  const sceneLayer = useMemo(() => parseSceneLayer(snapshotData), [snapshotData]);

  const isBuActivatedByRtp = useMemo(() => {
    if (!isBuRole) {
      return true;
    }

    const expectedCommandPoint = roleView === 'BU1' ? 'BU1' : roleView === 'BU2' ? 'BU2' : '';
    if (!expectedCommandPoint) {
      return true;
    }

    const deployments = bundle?.resource_deployments ?? realtimeBundle?.resource_deployments ?? [];
    return deployments.some((deployment) => {
      if (deployment.resource_kind !== 'MARKER' || deployment.status === 'COMPLETED') {
        return false;
      }
      if (getDeploymentRoleTag(deployment) !== 'RTP') {
        return false;
      }
      const resourceData = toRecord(deployment.resource_data);
      const commandPoint = normalizeCommandPointTag(resourceData?.command_point);
      return commandPoint === expectedCommandPoint;
    });
  }, [bundle, isBuRole, realtimeBundle, roleView]);

  const buActivationLockMessage = useMemo(() => {
    if (!isBuRole || isBuActivatedByRtp) {
      return '';
    }
    return `${currentBuLabel}: ожидание постановки РТП (командная точка ${currentBuRoleTag})`;
  }, [currentBuLabel, currentBuRoleTag, isBuActivatedByRtp, isBuRole]);

  const lessonTiming = useMemo(() => {
    if (!snapshotData) {
      return null;
    }

    const lessonState = toRecord(snapshotData.training_lesson);
    if (!lessonState) {
      return null;
    }

    const startedAtMs = parseIsoTimestampMs(lessonState.started_at);
    if (startedAtMs === null) {
      return null;
    }

    const isInProgress = lessonState.status === 'IN_PROGRESS';
    const finishedAtMs = parseIsoTimestampMs(lessonState.finished_at);

    const elapsedFromServer = numberOrNull(lessonState.elapsed_game_sec);

    const referenceMs = isInProgress ? nowTickMs : finishedAtMs ?? nowTickMs;
    const elapsedRealSecFallback = Math.max(0, Math.floor((referenceMs - startedAtMs) / 1000));
    const timeMultiplier =
      typeof bundle?.session.time_multiplier === 'number' && Number.isFinite(bundle.session.time_multiplier)
        ? clamp(bundle.session.time_multiplier, 0.1, 30)
        : 1;
    const elapsedGameSecFallback = Math.max(0, Math.floor(elapsedRealSecFallback * timeMultiplier));

    const elapsedGameSec =
      elapsedFromServer !== null ? Math.max(0, Math.floor(elapsedFromServer)) : elapsedGameSecFallback;

    const timeLimitSec =
      typeof lessonState.time_limit_sec === 'number' && Number.isFinite(lessonState.time_limit_sec)
        ? Math.max(0, Math.floor(lessonState.time_limit_sec))
        : null;

    const startSimTimeSec =
      typeof lessonState.start_sim_time_seconds === 'number' && Number.isFinite(lessonState.start_sim_time_seconds)
        ? Math.max(0, Math.floor(lessonState.start_sim_time_seconds))
        : 10 * 60 * 60;

    const simClockFromSnapshot =
      typeof bundle?.snapshot?.sim_time_seconds === 'number' && Number.isFinite(bundle.snapshot.sim_time_seconds)
        ? Math.max(0, Math.floor(bundle.snapshot.sim_time_seconds))
        : null;

    const remainingSec = timeLimitSec !== null ? Math.max(0, timeLimitSec - elapsedGameSec) : null;

    return {
      inProgress: isInProgress,
      elapsedGameSec,
      gameClockSec: simClockFromSnapshot ?? startSimTimeSec + elapsedGameSec,
      remainingSec,
      timeoutReached: remainingSec !== null && remainingSec <= 0,
    };
  }, [bundle?.session.time_multiplier, bundle?.snapshot?.sim_time_seconds, nowTickMs, snapshotData]);

  const isLessonLive = lessonTiming?.inProgress === true;
  const isLessonCompleted = useMemo(() => {
    if (!bundle) {
      return false;
    }

    const bySessionStatus = bundle.session.status === 'COMPLETED';
    const lessonState = snapshotData ? toRecord(snapshotData.training_lesson) : null;
    const byLessonState = lessonState?.status === 'COMPLETED';
    return Boolean(bySessionStatus || byLessonState);
  }, [bundle, snapshotData]);

  useEffect(() => {
    if (!isLessonLive) {
      return;
    }
    setViewportMode((previous) => (previous === 'TACTICAL' ? 'SIM_25D' : previous));
  }, [isLessonLive]);

  useEffect(() => {
    if (!isLessonCompleted) {
      return;
    }
    setIsMiniMapVisible(false);
  }, [isLessonCompleted]);

  const isFullscreenSimulation = viewportMode === 'SIM_25D' || viewportMode === 'SIM_3D' || viewportMode === 'RETRO';
  const isTacticalViewport = viewportMode === 'TACTICAL';
  const miniMapFitsLayout = canvasSize.width >= 760 && canvasSize.height >= 420;
  const canShowMiniMap = isTacticalViewport && !isReadOnly && miniMapFitsLayout && !isLessonCompleted;
  const miniMapPanelWidth = Math.max(170, Math.min(250, Math.round(canvasSize.width * 0.24)));
  const shouldRenderMiniMap = canShowMiniMap && isMiniMapVisible;

  const visibleDeployments = useMemo(() => {
    if (!bundle) {
      return [];
    }
    return getVisibleDeployments(bundle.resource_deployments).filter((deployment) =>
      isDeploymentVisibleForRole(deployment, roleView),
    );
  }, [bundle, roleView]);

  const selectedDeployment = useMemo(() => {
    if (!selectedDeploymentId) {
      return null;
    }
    return visibleDeployments.find((deployment) => deployment.id === selectedDeploymentId) ?? null;
  }, [selectedDeploymentId, visibleDeployments]);

  const selectedDeploymentAction = useMemo(() => {
    if (!selectedDeployment) {
      return null;
    }
    if (isBuRole && !isBuActivatedByRtp) {
      return null;
    }
    if (!canManageDeploymentForRole(selectedDeployment, roleView)) {
      return null;
    }
    if (selectedDeployment.resource_kind === 'VEHICLE') {
      return DEPLOYMENT_ACTIONS_BY_STATUS[selectedDeployment.status];
    }
    if (selectedDeployment.status === 'COMPLETED') {
      return null;
    }
    return {
      nextStatus: 'COMPLETED' as const,
      label: 'ЗАВЕРШИТЬ',
    };
  }, [isBuActivatedByRtp, isBuRole, roleView, selectedDeployment]);

  const canAdjustSelectedNozzle = useMemo(() => {
    if (!selectedDeployment || selectedDeployment.resource_kind !== 'NOZZLE') {
      return false;
    }
    if (isBuRole && !isBuActivatedByRtp) {
      return false;
    }
    return canManageDeploymentForRole(selectedDeployment, roleView);
  }, [isBuActivatedByRtp, isBuRole, roleView, selectedDeployment]);

  useEffect(() => {
    if (!isBuRole || isBuActivatedByRtp) {
      return;
    }
    if (!pendingPlacement || pendingPlacement.source !== 'combat_area_sidebar') {
      return;
    }
    clearPendingPlacement();
    setLinePlacementStart(null);
    setHoverPlacementPoint(null);
  }, [clearPendingPlacement, isBuActivatedByRtp, isBuRole, pendingPlacement]);

  const fireStats = useMemo(() => {
    const stats = {
      activeFireCount: 0,
      activeSmokeCount: 0,
      activeFireAreaM2: 0,
      activeSmokeAreaM2: 0,
      activeFireCapAreaM2: 0,
    };

    (bundle?.fire_objects ?? []).forEach((fireObject) => {
      if (!fireObject.is_active) {
        return;
      }
      const areaM2 = Math.max(0, getFireAreaM2(fireObject));
      if (FIRE_KINDS.has(fireObject.kind)) {
        stats.activeFireCount += 1;
        stats.activeFireAreaM2 += areaM2;
        const extra = toRecord(fireObject.extra);
        const maxArea = numberOrNull(extra?.max_area_m2);
        if (maxArea !== null && maxArea > 0) {
          stats.activeFireCapAreaM2 += maxArea;
        }
        return;
      }
      if (SMOKE_KINDS.has(fireObject.kind)) {
        stats.activeSmokeCount += 1;
        stats.activeSmokeAreaM2 += areaM2;
      }
    });

    return stats;
  }, [bundle?.fire_objects]);

  const activeFireCount = fireStats.activeFireCount;

  const latestVisibleVehicleDeployments = useMemo(() => {
    const byVehicle = new Map<number, ResourceDeploymentDto>();

    visibleDeployments.forEach((deployment) => {
      if (deployment.resource_kind !== 'VEHICLE' || !deployment.vehicle_dictionary_id) {
        return;
      }
      byVehicle.set(deployment.vehicle_dictionary_id, deployment);
    });

    return byVehicle;
  }, [visibleDeployments]);

  const hydraulicRuntime = useMemo<HydraulicRuntime>(() => {
    const wetNozzleIds = new Set<string>();
    const wetHoseLineIds = new Set<string>();
    const nozzleFlowById = new Map<string, number>();
    const nozzleVehicleById = new Map<string, number>();

    const vehicleCandidates = Array.from(latestVisibleVehicleDeployments.entries())
      .map(([vehicleId, deployment]) => {
        if (deployment.status !== 'DEPLOYED' && deployment.status !== 'ACTIVE') {
          return null;
        }

        const runtimeState = fireRuntime.vehicleRuntimeById.get(vehicleId);
        return {
          vehicleId,
          roleTag: getDeploymentRoleTag(deployment),
          center: extractGeometryCenter(deployment.geometry_type, deployment.geometry),
          // When no runtime state yet (no tick has run), treat as full — backend is ground truth
          waterRemainingL: runtimeState !== undefined ? runtimeState.waterRemainingL : 9999,
        };
      })
      .filter((entry): entry is { vehicleId: number; roleTag: string; center: Point | null; waterRemainingL: number } => {
        return entry !== null;
      });

    const visibleHoseById = new Map<string, ResourceDeploymentDto>();
    const visibleHoseByChainId = new Map<string, ResourceDeploymentDto>();

    visibleDeployments
      .filter((deployment) => deployment.resource_kind === 'HOSE_LINE' && deployment.status !== 'COMPLETED')
      .filter((deployment) => {
        const resourceData = toRecord(deployment.resource_data);
        return resourceData?.plan_only !== true;
      })
      .forEach((deployment) => {
        visibleHoseById.set(deployment.id, deployment);
        const resourceData = toRecord(deployment.resource_data);
        const chainId =
          typeof resourceData?.chain_id === 'string'
            ? resourceData.chain_id
            : typeof resourceData?.linked_hose_line_chain_id === 'string'
              ? resourceData.linked_hose_line_chain_id
              : '';
        if (chainId.trim().length > 0) {
          visibleHoseByChainId.set(chainId, deployment);
        }
      });

    const activeNozzles: NozzleRuntimeItem[] = visibleDeployments
      .filter((deployment) => deployment.resource_kind === 'NOZZLE' && deployment.status === 'ACTIVE')
      .filter((deployment) => {
        const resourceData = toRecord(deployment.resource_data);
        return resourceData?.plan_only !== true;
      })
      .map((deployment) => {
        const flowLps = resolveNozzleFlowFromDeployment(deployment);
        nozzleFlowById.set(deployment.id, flowLps);

        const resourceData = toRecord(deployment.resource_data);
        const linkedHoseLineId =
          typeof resourceData?.linked_hose_line_id === 'string'
            ? resourceData.linked_hose_line_id
            : typeof resourceData?.hose_line_deployment_id === 'string'
              ? resourceData.hose_line_deployment_id
              : '';
        const linkedHoseLineChainId =
          typeof resourceData?.linked_hose_line_chain_id === 'string'
            ? resourceData.linked_hose_line_chain_id
            : typeof resourceData?.hose_line_chain_id === 'string'
              ? resourceData.hose_line_chain_id
              : '';
        const linkedVehicleId = numberOrNull(resourceData?.linked_vehicle_id);

        return {
          id: deployment.id,
          roleTag: getDeploymentRoleTag(deployment),
          center: extractGeometryCenter(deployment.geometry_type, deployment.geometry),
          flowLps,
          strictChain: resourceData?.strict_chain === true,
          linkedHoseLineId,
          linkedHoseLineChainId,
          linkedVehicleId,
        };
      });

    let effectiveFlowVisibleLps = 0;
    const wetRoles = new Set<string>();

    activeNozzles.forEach((nozzle) => {
      const runtimeNozzle = fireRuntime.nozzleRuntimeById.get(nozzle.id);
      if (runtimeNozzle) {
        if (runtimeNozzle.hasWater) {
          wetNozzleIds.add(nozzle.id);
          effectiveFlowVisibleLps += runtimeNozzle.effectiveFlowLps > 0 ? runtimeNozzle.effectiveFlowLps : nozzle.flowLps;
          if (runtimeNozzle.linkedVehicleId !== null && runtimeNozzle.linkedVehicleId > 0) {
            nozzleVehicleById.set(nozzle.id, runtimeNozzle.linkedVehicleId);
          }
          if (nozzle.roleTag) {
            wetRoles.add(nozzle.roleTag);
          }
        }
        return;
      }

      let candidates = vehicleCandidates
        .filter((vehicle) => vehicle.waterRemainingL > 0.01)
        .filter((vehicle) => {
          if (!nozzle.roleTag) {
            return true;
          }
          if (!vehicle.roleTag) {
            return true;
          }
          return vehicle.roleTag === nozzle.roleTag;
        });

      if (nozzle.strictChain) {
        let linkedHose = nozzle.linkedHoseLineId ? visibleHoseById.get(nozzle.linkedHoseLineId) : undefined;
        if (!linkedHose && nozzle.linkedHoseLineChainId) {
          linkedHose = visibleHoseByChainId.get(nozzle.linkedHoseLineChainId);
        }

        if (!linkedHose) {
          return;
        }

        const linkedHoseData = toRecord(linkedHose.resource_data);
        const linkedVehicleIdFromHose = numberOrNull(linkedHoseData?.linked_vehicle_id);
        const linkedVehicleIdFromHoseRuntime = fireRuntime.hoseRuntimeById.get(linkedHose.id)?.linkedVehicleId ?? null;
        const targetVehicleId = nozzle.linkedVehicleId ?? linkedVehicleIdFromHose ?? linkedVehicleIdFromHoseRuntime;

        if (targetVehicleId === null || targetVehicleId <= 0) {
          return;
        }

        candidates = candidates.filter((vehicle) => vehicle.vehicleId === targetVehicleId);
      }

      if (!nozzle.center) {
        if (candidates.length > 0) {
          const assignedVehicle = candidates[0];
          wetNozzleIds.add(nozzle.id);
          nozzleVehicleById.set(nozzle.id, assignedVehicle.vehicleId);
          effectiveFlowVisibleLps += nozzle.flowLps;
          if (nozzle.roleTag) {
            wetRoles.add(nozzle.roleTag);
          }
        }
        return;
      }
      const nozzleCenter = nozzle.center;

      if (candidates.length === 0) {
        return;
      }

      candidates.sort((left, right) => {
        if (!left.center && !right.center) {
          return 0;
        }
        if (!left.center) {
          return 1;
        }
        if (!right.center) {
          return -1;
        }
        return distanceSquared(nozzleCenter, left.center) - distanceSquared(nozzleCenter, right.center);
      });

      const assignedVehicle = candidates[0];
      wetNozzleIds.add(nozzle.id);
      nozzleVehicleById.set(nozzle.id, assignedVehicle.vehicleId);
      effectiveFlowVisibleLps += nozzle.flowLps;
      if (nozzle.roleTag) {
        wetRoles.add(nozzle.roleTag);
      }
    });

    visibleDeployments
      .filter((deployment) => deployment.resource_kind === 'HOSE_LINE' && deployment.status !== 'COMPLETED')
      .filter((deployment) => {
        const resourceData = toRecord(deployment.resource_data);
        return resourceData?.plan_only !== true;
      })
      .forEach((deployment) => {
        const runtimeHose = fireRuntime.hoseRuntimeById.get(deployment.id);
        if (runtimeHose) {
          if (runtimeHose.hasWater) {
            wetHoseLineIds.add(deployment.id);
          }
          return;
        }

        const resourceData = toRecord(deployment.resource_data);
        const strictChain = resourceData?.strict_chain === true;
        if (strictChain) {
          const linkedVehicleId = numberOrNull(resourceData?.linked_vehicle_id);
          if (linkedVehicleId !== null && linkedVehicleId > 0) {
            const hasWater = vehicleCandidates.some(
              (vehicle) => vehicle.vehicleId === linkedVehicleId && vehicle.waterRemainingL > 0.01,
            );
            if (hasWater) {
              wetHoseLineIds.add(deployment.id);
            }
          }
          return;
        }

        const roleTag = getDeploymentRoleTag(deployment);
        const hasWaterForRole = roleTag ? wetRoles.has(roleTag) : wetNozzleIds.size > 0;
        if (hasWaterForRole) {
          wetHoseLineIds.add(deployment.id);
        }
      });

    return {
      wetNozzleIds,
      wetHoseLineIds,
      nozzleFlowById,
      nozzleVehicleById,
      wetNozzleCount: fireRuntime.wetNozzles !== null ? Math.max(0, Math.floor(fireRuntime.wetNozzles)) : wetNozzleIds.size,
      effectiveFlowVisibleLps,
    };
  }, [
    fireRuntime.hoseRuntimeById,
    fireRuntime.nozzleRuntimeById,
    fireRuntime.vehicleRuntimeById,
    fireRuntime.wetNozzles,
    latestVisibleVehicleDeployments,
    visibleDeployments,
  ]);

  const deploymentCounts = useMemo(() => {
    const counts: Record<string, number> = {
      PLANNED: 0,
      EN_ROUTE: 0,
      DEPLOYED: 0,
      ACTIVE: 0,
      COMPLETED: 0,
    };
    visibleDeployments
      .filter((deployment) => deployment.resource_kind === 'VEHICLE')
      .forEach((deployment) => {
        counts[deployment.status] = (counts[deployment.status] || 0) + 1;
      });
    return counts;
  }, [visibleDeployments]);

  const tacticalResourceCounts = useMemo(() => {
    let hoseLines = 0;
    let nozzles = 0;
    let waterSources = 0;

    visibleDeployments.forEach((deployment) => {
      if (deployment.status === 'COMPLETED') {
        return;
      }
      if (deployment.resource_kind === 'HOSE_LINE') {
        hoseLines += 1;
      } else if (deployment.resource_kind === 'NOZZLE') {
        nozzles += 1;
      } else if (deployment.resource_kind === 'WATER_SOURCE') {
        waterSources += 1;
      }
    });

    return {
      hoseLines,
      nozzles,
      waterSources,
    };
  }, [visibleDeployments]);

  const buHydraulicPanel = useMemo(() => {
    if (!currentBuRoleTag) {
      return null;
    }

    let hosesTotal = 0;
    let hosesWet = 0;
    let nozzlesTotal = 0;
    let nozzlesWet = 0;
    let flowLps = 0;
    const roleVehicleIds = new Set<number>();

    visibleDeployments.forEach((deployment) => {
      const roleTag = getDeploymentRoleTag(deployment);
      if (roleTag !== currentBuRoleTag) {
        return;
      }

      if (deployment.resource_kind === 'VEHICLE' && deployment.vehicle_dictionary_id) {
        roleVehicleIds.add(deployment.vehicle_dictionary_id);
      }

      if (deployment.status === 'COMPLETED') {
        return;
      }

      if (deployment.resource_kind === 'HOSE_LINE') {
        hosesTotal += 1;
        if (hydraulicRuntime.wetHoseLineIds.has(deployment.id)) {
          hosesWet += 1;
        }
      }

      if (deployment.resource_kind === 'NOZZLE' && deployment.status === 'ACTIVE') {
        nozzlesTotal += 1;
        if (hydraulicRuntime.wetNozzleIds.has(deployment.id)) {
          nozzlesWet += 1;
          flowLps += hydraulicRuntime.nozzleFlowById.get(deployment.id) ?? resolveNozzleFlowFromDeployment(deployment);
        }
      }
    });

    let waterRemainingL = 0;
    let waterCapacityL = 0;
    let emptyVehicles = 0;

    roleVehicleIds.forEach((vehicleId) => {
      const runtimeState = fireRuntime.vehicleRuntimeById.get(vehicleId);
      if (!runtimeState) {
        return;
      }
      waterRemainingL += runtimeState.waterRemainingL;
      waterCapacityL += runtimeState.waterCapacityL;
      if (runtimeState.isEmpty) {
        emptyVehicles += 1;
      }
    });

    const waterPercent = waterCapacityL > 0 ? clamp((waterRemainingL / waterCapacityL) * 100, 0, 100) : null;

    return {
      hosesTotal,
      hosesWet,
      nozzlesTotal,
      nozzlesWet,
      flowLps,
      waterRemainingL,
      waterCapacityL,
      waterPercent,
      emptyVehicles,
      trackedVehicles: roleVehicleIds.size,
    };
  }, [
    currentBuRoleTag,
    fireRuntime.vehicleRuntimeById,
    hydraulicRuntime.nozzleFlowById,
    hydraulicRuntime.wetHoseLineIds,
    hydraulicRuntime.wetNozzleIds,
    visibleDeployments,
  ]);

  const tacticalChainGraph = useMemo<TacticalChainGraph>(() => {
    type VehicleNode = {
      key: string;
      vehicleId: number;
      center: Point | null;
      roleTag: string;
    };

    type HoseNode = {
      key: string;
      hoseId: string;
      center: Point | null;
      roleTag: string;
      chainId: string;
      linkedVehicleId: number | null;
      strictChain: boolean;
      hasWater: boolean;
      blockedReason: string;
    };

    type NozzleNode = {
      key: string;
      nozzleId: string;
      center: Point | null;
      roleTag: string;
      linkedHoseId: string;
      linkedHoseChainId: string;
      linkedVehicleId: number | null;
      strictChain: boolean;
      hasWater: boolean;
      blockedReason: string;
    };

    const vehicleNodesByKey = new Map<string, VehicleNode>();
    const hoseNodesById = new Map<string, HoseNode>();
    const hoseIdByChainId = new Map<string, string>();
    const nozzleNodes: NozzleNode[] = [];

    visibleDeployments.forEach((deployment) => {
      if (deployment.resource_kind === 'VEHICLE') {
        const vehicleId = deployment.vehicle_dictionary_id;
        if (!vehicleId) {
          return;
        }
        if (deployment.status === 'COMPLETED') {
          return;
        }

        const vehicleKey = `vehicle:${vehicleId}`;
        vehicleNodesByKey.set(vehicleKey, {
          key: vehicleKey,
          vehicleId,
          center: extractGeometryCenter(deployment.geometry_type, deployment.geometry),
          roleTag: getDeploymentRoleTag(deployment),
        });
        return;
      }

      if (deployment.resource_kind === 'HOSE_LINE') {
        if (deployment.status === 'COMPLETED') {
          return;
        }
        const resourceData = toRecord(deployment.resource_data);
        if (resourceData?.plan_only === true) {
          return;
        }

        const runtimeHose = fireRuntime.hoseRuntimeById.get(deployment.id);
        const chainId = runtimeHose?.chainId || resolveChainIdFromResourceData(resourceData);
        const linkedVehicleId = runtimeHose?.linkedVehicleId ?? numberOrNull(resourceData?.linked_vehicle_id);

        const hoseNode: HoseNode = {
          key: `hose:${deployment.id}`,
          hoseId: deployment.id,
          center: extractGeometryCenter(deployment.geometry_type, deployment.geometry),
          roleTag: getDeploymentRoleTag(deployment),
          chainId,
          linkedVehicleId,
          strictChain: runtimeHose?.strictChain ?? (resourceData?.strict_chain === true),
          hasWater: runtimeHose?.hasWater ?? hydraulicRuntime.wetHoseLineIds.has(deployment.id),
          blockedReason: runtimeHose?.blockedReason ?? '',
        };

        hoseNodesById.set(deployment.id, hoseNode);
        if (chainId.trim().length > 0) {
          hoseIdByChainId.set(chainId, deployment.id);
        }
        return;
      }

      if (deployment.resource_kind === 'NOZZLE') {
        if (deployment.status === 'COMPLETED') {
          return;
        }
        const resourceData = toRecord(deployment.resource_data);
        if (resourceData?.plan_only === true) {
          return;
        }

        const runtimeNozzle = fireRuntime.nozzleRuntimeById.get(deployment.id);
        const ref = resolveLinkedHoseRefFromResourceData(resourceData);

        nozzleNodes.push({
          key: `nozzle:${deployment.id}`,
          nozzleId: deployment.id,
          center: extractGeometryCenter(deployment.geometry_type, deployment.geometry),
          roleTag: getDeploymentRoleTag(deployment),
          linkedHoseId: runtimeNozzle?.linkedHoseLineId || ref.hoseId,
          linkedHoseChainId: runtimeNozzle?.linkedHoseLineChainId || ref.chainId,
          linkedVehicleId: runtimeNozzle?.linkedVehicleId ?? numberOrNull(resourceData?.linked_vehicle_id),
          strictChain: runtimeNozzle?.strictChain ?? (resourceData?.strict_chain === true),
          hasWater: runtimeNozzle?.hasWater ?? hydraulicRuntime.wetNozzleIds.has(deployment.id),
          blockedReason: runtimeNozzle?.blockedReason ?? '',
        });
      }
    });

    const resolveHoseIdForNozzle = (nozzle: NozzleNode): string => {
      if (nozzle.linkedHoseId && hoseNodesById.has(nozzle.linkedHoseId)) {
        return nozzle.linkedHoseId;
      }
      if (nozzle.linkedHoseChainId && hoseIdByChainId.has(nozzle.linkedHoseChainId)) {
        return hoseIdByChainId.get(nozzle.linkedHoseChainId) ?? '';
      }
      return '';
    };

    const resolveVehicleIdForNozzle = (nozzle: NozzleNode, hoseId: string): number | null => {
      if (nozzle.linkedVehicleId !== null && nozzle.linkedVehicleId > 0) {
        return nozzle.linkedVehicleId;
      }
      if (!hoseId) {
        return null;
      }
      return hoseNodesById.get(hoseId)?.linkedVehicleId ?? null;
    };

    const highlightedKeys = new Set<string>();
    const markHighlighted = (key: string) => {
      if (key) {
        highlightedKeys.add(key);
      }
    };

    if (selectedDeployment) {
      if (selectedDeployment.resource_kind === 'VEHICLE' && selectedDeployment.vehicle_dictionary_id) {
        const selectedVehicleKey = `vehicle:${selectedDeployment.vehicle_dictionary_id}`;
        markHighlighted(selectedVehicleKey);

        hoseNodesById.forEach((hoseNode) => {
          if (hoseNode.linkedVehicleId === selectedDeployment.vehicle_dictionary_id) {
            markHighlighted(hoseNode.key);
          }
        });

        nozzleNodes.forEach((nozzleNode) => {
          const hoseId = resolveHoseIdForNozzle(nozzleNode);
          const vehicleId = resolveVehicleIdForNozzle(nozzleNode, hoseId);
          if (vehicleId === selectedDeployment.vehicle_dictionary_id) {
            markHighlighted(nozzleNode.key);
          }
        });
      }

      if (selectedDeployment.resource_kind === 'HOSE_LINE') {
        const selectedHoseKey = `hose:${selectedDeployment.id}`;
        markHighlighted(selectedHoseKey);

        const selectedHoseNode = hoseNodesById.get(selectedDeployment.id);
        if (selectedHoseNode?.linkedVehicleId) {
          markHighlighted(`vehicle:${selectedHoseNode.linkedVehicleId}`);
        }

        nozzleNodes.forEach((nozzleNode) => {
          const hoseId = resolveHoseIdForNozzle(nozzleNode);
          if (hoseId === selectedDeployment.id) {
            markHighlighted(nozzleNode.key);
          }
        });
      }

      if (selectedDeployment.resource_kind === 'NOZZLE') {
        const selectedNozzleKey = `nozzle:${selectedDeployment.id}`;
        markHighlighted(selectedNozzleKey);

        const selectedNozzle = nozzleNodes.find((node) => node.nozzleId === selectedDeployment.id);
        if (selectedNozzle) {
          const hoseId = resolveHoseIdForNozzle(selectedNozzle);
          if (hoseId) {
            markHighlighted(`hose:${hoseId}`);
          }
          const vehicleId = resolveVehicleIdForNozzle(selectedNozzle, hoseId);
          if (vehicleId) {
            markHighlighted(`vehicle:${vehicleId}`);
          }
        }
      }
    }

    const links: ChainLinkState[] = [];

    const pushLink = (link: Omit<ChainLinkState, 'highlighted'>) => {
      links.push({
        ...link,
        highlighted: highlightedKeys.has(link.fromKey) || highlightedKeys.has(link.toKey),
      });
    };

    hoseNodesById.forEach((hoseNode) => {
      if (!hoseNode.center || !hoseNode.linkedVehicleId || hoseNode.linkedVehicleId <= 0) {
        return;
      }
      const vehicleKey = `vehicle:${hoseNode.linkedVehicleId}`;
      const vehicleNode = vehicleNodesByKey.get(vehicleKey);
      if (!vehicleNode?.center) {
        return;
      }

      pushLink({
        id: `veh_to_hose:${hoseNode.hoseId}`,
        kind: 'VEHICLE_TO_HOSE',
        from: vehicleNode.center,
        to: hoseNode.center,
        fromKey: vehicleNode.key,
        toKey: hoseNode.key,
        hasWater: hoseNode.hasWater,
        strictChain: hoseNode.strictChain,
        blockedReason: hoseNode.blockedReason,
        roleTag: hoseNode.roleTag || vehicleNode.roleTag,
      });
    });

    nozzleNodes.forEach((nozzleNode) => {
      if (!nozzleNode.center) {
        return;
      }

      const hoseId = resolveHoseIdForNozzle(nozzleNode);
      if (hoseId) {
        const hoseNode = hoseNodesById.get(hoseId);
        if (hoseNode?.center) {
          pushLink({
            id: `hose_to_nozzle:${hoseId}:${nozzleNode.nozzleId}`,
            kind: 'HOSE_TO_NOZZLE',
            from: hoseNode.center,
            to: nozzleNode.center,
            fromKey: hoseNode.key,
            toKey: nozzleNode.key,
            hasWater: nozzleNode.hasWater,
            strictChain: nozzleNode.strictChain,
            blockedReason: nozzleNode.blockedReason,
            roleTag: nozzleNode.roleTag || hoseNode.roleTag,
          });
          return;
        }
      }

      const linkedVehicleId = resolveVehicleIdForNozzle(nozzleNode, hoseId);
      if (!linkedVehicleId || linkedVehicleId <= 0) {
        return;
      }

      const vehicleKey = `vehicle:${linkedVehicleId}`;
      const vehicleNode = vehicleNodesByKey.get(vehicleKey);
      if (!vehicleNode?.center) {
        return;
      }

      pushLink({
        id: `veh_to_nozzle:${linkedVehicleId}:${nozzleNode.nozzleId}`,
        kind: 'VEHICLE_TO_NOZZLE',
        from: vehicleNode.center,
        to: nozzleNode.center,
        fromKey: vehicleNode.key,
        toKey: nozzleNode.key,
        hasWater: nozzleNode.hasWater,
        strictChain: nozzleNode.strictChain,
        blockedReason: nozzleNode.blockedReason || 'NO_LINKED_HOSE',
        roleTag: nozzleNode.roleTag || vehicleNode.roleTag,
      });
    });

    const activeLinks = links.filter((link) => link.hasWater).length;
    const strictLinks = links.filter((link) => link.strictChain).length;
    const brokenLinks = links.filter((link) => link.blockedReason.length > 0 && !link.hasWater).length;

    return {
      links,
      activeLinks,
      dryLinks: Math.max(0, links.length - activeLinks),
      strictLinks,
      brokenLinks,
      vehicleToHoseLinks: links.filter((link) => link.kind === 'VEHICLE_TO_HOSE').length,
      hoseToNozzleLinks: links.filter((link) => link.kind === 'HOSE_TO_NOZZLE').length,
      vehicleToNozzleLinks: links.filter((link) => link.kind === 'VEHICLE_TO_NOZZLE').length,
    };
  }, [
    fireRuntime.hoseRuntimeById,
    fireRuntime.nozzleRuntimeById,
    hydraulicRuntime.wetHoseLineIds,
    hydraulicRuntime.wetNozzleIds,
    selectedDeployment,
    visibleDeployments,
  ]);

  const latestDeploymentHint = useMemo(() => {
    if (visibleDeployments.length === 0) {
      return '';
    }
    const latest = visibleDeployments
      .slice()
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    return `${latest.label.toUpperCase()} - ${DEPLOYMENT_HINT_LABELS[latest.status] ?? latest.status.toLowerCase()}`;
  }, [visibleDeployments]);

  const selectedDeploymentRuntimeDetails = useMemo(() => {
    if (!selectedDeployment) {
      return [] as string[];
    }

    const details: string[] = [];
    const roleTag = getDeploymentRoleTag(selectedDeployment);
    if (roleTag) {
      details.push(`роль: ${roleTag}`);
    }

    if (selectedDeployment.resource_kind === 'VEHICLE' && selectedDeployment.vehicle_dictionary_id) {
      const runtimeState = fireRuntime.vehicleRuntimeById.get(selectedDeployment.vehicle_dictionary_id);
      if (runtimeState) {
        const percent = runtimeState.waterCapacityL > 0
          ? Math.round((runtimeState.waterRemainingL / runtimeState.waterCapacityL) * 100)
          : 0;
        details.push(
          `вода: ${formatLiters(runtimeState.waterRemainingL)} / ${formatLiters(runtimeState.waterCapacityL)} л (${percent}%)`,
        );
      }
    }

    if (selectedDeployment.resource_kind === 'NOZZLE') {
      const isWet = hydraulicRuntime.wetNozzleIds.has(selectedDeployment.id);
      const flowLps = hydraulicRuntime.nozzleFlowById.get(selectedDeployment.id) ?? resolveNozzleFlowFromDeployment(selectedDeployment);
      const runtimeState = fireRuntime.nozzleRuntimeById.get(selectedDeployment.id);
      details.push(`ствол: ${isWet ? 'с подачей' : 'без подачи'}`);
      details.push(`расход: ${flowLps.toFixed(1)} л/с`);
      if (runtimeState) {
        details.push(`давление: ${runtimeState.availablePressureBar.toFixed(1)} бар`);
        if (runtimeState.lineLossBar > 0) {
          details.push(`потери: ${runtimeState.lineLossBar.toFixed(2)} бар`);
        }
        if (runtimeState.lineLengthM > 0) {
          const hoseLabel = runtimeState.hoseType ? ` ${runtimeState.hoseType}` : '';
          details.push(`линия: ${runtimeState.lineLengthM.toFixed(1)} м${hoseLabel}`);
        }
      }

      if (runtimeState?.strictChain) {
        details.push('схема: жесткая');
      }

      const fedByVehicleId = hydraulicRuntime.nozzleVehicleById.get(selectedDeployment.id);
      if (fedByVehicleId) {
        details.push(`питание от машины #${fedByVehicleId}`);
      }

      if (!isWet && runtimeState?.blockedReason) {
        details.push(
          `причина: ${BLOCKED_REASON_LABELS[runtimeState.blockedReason] ?? runtimeState.blockedReason.toLowerCase()}`,
        );
      }
    }

    if (selectedDeployment.resource_kind === 'HOSE_LINE') {
      const isWet = hydraulicRuntime.wetHoseLineIds.has(selectedDeployment.id);
      details.push(`рукав: ${isWet ? 'под давлением' : 'без давления'}`);

      const runtimeState = fireRuntime.hoseRuntimeById.get(selectedDeployment.id);
      if (runtimeState?.strictChain) {
        details.push('схема: жесткая');
      }
      if (runtimeState?.linkedVehicleId && runtimeState.linkedVehicleId > 0) {
        details.push(`питание от машины #${runtimeState.linkedVehicleId}`);
      }

      const resourceData = toRecord(selectedDeployment.resource_data);
      const hoseTypeRaw = typeof resourceData?.hose_type === 'string' ? resourceData.hose_type : null;
      if (hoseTypeRaw && hoseTypeRaw.trim()) {
        details.push(`тип: ${hoseTypeRaw}`);
      }
    }

    return details;
  }, [fireRuntime.hoseRuntimeById, fireRuntime.nozzleRuntimeById, fireRuntime.vehicleRuntimeById, hydraulicRuntime, selectedDeployment]);

  const selectedDeploymentCharacteristics = useMemo(() => {
    if (!selectedDeployment) {
      return [] as DeploymentCharacteristic[];
    }

    if (
      selectedDeployment.resource_kind !== 'VEHICLE'
      && selectedDeployment.resource_kind !== 'HOSE_LINE'
      && selectedDeployment.resource_kind !== 'NOZZLE'
    ) {
      return [] as DeploymentCharacteristic[];
    }

    const characteristics: DeploymentCharacteristic[] = [];
    const resourceData = toRecord(selectedDeployment.resource_data);
    const roleTag = getDeploymentRoleTag(selectedDeployment);
    if (roleTag) {
      characteristics.push({ label: 'Участок', value: roleTag });
    }

    const center = extractGeometryCenter(selectedDeployment.geometry_type, selectedDeployment.geometry);
    if (center) {
      characteristics.push({ label: 'Координаты', value: `${center.x.toFixed(1)} ; ${center.y.toFixed(1)} м` });
    }

    if (selectedDeployment.resource_kind === 'VEHICLE') {
      if (selectedDeployment.vehicle_dictionary_id) {
        characteristics.push({ label: 'ID машины', value: `#${selectedDeployment.vehicle_dictionary_id}` });
      }

      const runtimeState = selectedDeployment.vehicle_dictionary_id
        ? fireRuntime.vehicleRuntimeById.get(selectedDeployment.vehicle_dictionary_id)
        : undefined;
      if (runtimeState) {
        const percent = runtimeState.waterCapacityL > 0
          ? Math.round((runtimeState.waterRemainingL / runtimeState.waterCapacityL) * 100)
          : 0;
        characteristics.push({
          label: 'Вода в цистерне',
          value: `${formatLiters(runtimeState.waterRemainingL)} / ${formatLiters(runtimeState.waterCapacityL)} л (${percent}%)`,
        });
        characteristics.push({
          label: 'Ресурс',
          value: runtimeState.isEmpty ? 'пусто' : 'рабочий запас',
        });
      }

      const dispatchCode = typeof resourceData?.dispatch_code === 'string' ? resourceData.dispatch_code.trim() : '';
      if (dispatchCode) {
        characteristics.push({ label: 'Код выезда', value: dispatchCode });
      }

      const etaAtMs = parseIsoTimestampMs(resourceData?.dispatch_eta_at);
      if (etaAtMs !== null) {
        const remainingSec = Math.max(0, Math.ceil((etaAtMs - nowTickMs) / 1000));
        characteristics.push({
          label: 'ETA',
          value: remainingSec > 0 ? `${Math.max(1, Math.ceil(remainingSec / 60))} мин` : 'прибыла',
        });
      } else {
        const etaSec = numberOrNull(resourceData?.dispatch_eta_sec);
        if (etaSec !== null && etaSec > 0) {
          characteristics.push({ label: 'ETA', value: `${Math.max(1, Math.ceil(etaSec / 60))} мин` });
        }
      }
    }

    if (selectedDeployment.resource_kind === 'HOSE_LINE') {
      const points = extractGeometryPoints(selectedDeployment.geometry_type, selectedDeployment.geometry);
      const lengthM = polylineLengthMeters(points);
      if (lengthM > 0) {
        characteristics.push({ label: 'Длина линии', value: formatScaleDistance(lengthM) });
      }

      const isWet = hydraulicRuntime.wetHoseLineIds.has(selectedDeployment.id);
      characteristics.push({ label: 'Подача', value: isWet ? 'под давлением' : 'без давления' });

      const hoseTypeRaw = typeof resourceData?.hose_type === 'string' ? resourceData.hose_type.trim().toUpperCase() : '';
      if (hoseTypeRaw) {
        characteristics.push({ label: 'Тип рукава', value: hoseTypeRaw });
      }

      const runtimeState = fireRuntime.hoseRuntimeById.get(selectedDeployment.id);
      const linkedVehicleId = runtimeState?.linkedVehicleId ?? numberOrNull(resourceData?.linked_vehicle_id);
      if (linkedVehicleId && linkedVehicleId > 0) {
        characteristics.push({ label: 'Питание', value: `машина #${linkedVehicleId}` });
      }

      const chainIdRaw = typeof resourceData?.chain_id === 'string' ? resourceData.chain_id.trim() : '';
      const chainId = chainIdRaw || runtimeState?.chainId || '';
      if (chainId) {
        characteristics.push({ label: 'Цепочка', value: chainId });
      }
    }

    if (selectedDeployment.resource_kind === 'NOZZLE') {
      const runtimeState = fireRuntime.nozzleRuntimeById.get(selectedDeployment.id);
      const isWet = hydraulicRuntime.wetNozzleIds.has(selectedDeployment.id);
      const flowLps = hydraulicRuntime.nozzleFlowById.get(selectedDeployment.id) ?? resolveNozzleFlowFromDeployment(selectedDeployment);
      const sprayAngle = clamp(numberOrNull(resourceData?.spray_angle) ?? nozzleSettings.spray_angle, 0, 90);
      const pressure = clamp(numberOrNull(resourceData?.pressure) ?? nozzleSettings.pressure, 20, 100);

      characteristics.push({ label: 'Подача', value: isWet ? 'есть' : 'нет' });
      characteristics.push({ label: 'Расход', value: `${flowLps.toFixed(1)} л/с` });
      characteristics.push({ label: 'Угол распыла', value: `${Math.round(sprayAngle)}°` });
      characteristics.push({ label: 'Давление', value: `${Math.round(pressure)} бар` });

      const nozzleType = typeof resourceData?.nozzle_type === 'string' ? resourceData.nozzle_type.trim().toUpperCase() : '';
      if (nozzleType) {
        characteristics.push({ label: 'Тип ствола', value: nozzleType });
      }

      if (runtimeState && runtimeState.availablePressureBar > 0) {
        characteristics.push({
          label: 'Доступное давление',
          value: `${runtimeState.availablePressureBar.toFixed(1)} бар`,
        });
      }
      if (runtimeState && runtimeState.lineLengthM > 0) {
        const hoseLabel = runtimeState.hoseType ? ` (${runtimeState.hoseType})` : '';
        characteristics.push({ label: 'Линия до ствола', value: `${runtimeState.lineLengthM.toFixed(1)} м${hoseLabel}` });
      }

      const linkedHoseId =
        runtimeState?.linkedHoseLineId
        || (typeof resourceData?.linked_hose_line_id === 'string' ? resourceData.linked_hose_line_id.trim() : '');
      if (linkedHoseId) {
        characteristics.push({ label: 'Привязанный рукав', value: linkedHoseId });
      }

      const linkedVehicleId =
        hydraulicRuntime.nozzleVehicleById.get(selectedDeployment.id)
        ?? runtimeState?.linkedVehicleId
        ?? numberOrNull(resourceData?.linked_vehicle_id);
      if (linkedVehicleId && linkedVehicleId > 0) {
        characteristics.push({ label: 'Питание', value: `машина #${linkedVehicleId}` });
      }

      if (!isWet && runtimeState?.blockedReason) {
        characteristics.push({
          label: 'Причина отсутствия подачи',
          value: BLOCKED_REASON_LABELS[runtimeState.blockedReason] ?? runtimeState.blockedReason.toLowerCase(),
        });
      }
    }

    return characteristics;
  }, [
    fireRuntime.hoseRuntimeById,
    fireRuntime.nozzleRuntimeById,
    fireRuntime.vehicleRuntimeById,
    hydraulicRuntime.nozzleFlowById,
    hydraulicRuntime.nozzleVehicleById,
    hydraulicRuntime.wetHoseLineIds,
    hydraulicRuntime.wetNozzleIds,
    nozzleSettings.pressure,
    nozzleSettings.spray_angle,
    nowTickMs,
    selectedDeployment,
  ]);

  const worldViewport = useMemo(() => {
    const points: Point[] = [];

    bundle?.fire_objects.forEach((fireObject) => {
      points.push(...extractGeometryPoints(fireObject.geometry_type, fireObject.geometry));
    });

    sceneLayer.siteItems.forEach((item) => {
      points.push(...extractGeometryPoints(item.geometryType, item.geometry));
    });
    sceneLayer.floorItems.forEach((item) => {
      points.push(...extractGeometryPoints(item.geometryType, item.geometry));
    });

    visibleDeployments.forEach((deployment) => {
      points.push(...extractGeometryPoints(deployment.geometry_type, deployment.geometry));
    });

    if (points.length === 0) {
      points.push({ x: 0, y: 0 });
    }

    return buildViewport(points);
  }, [bundle, sceneLayer.floorItems, sceneLayer.siteItems, visibleDeployments]);

  const placementNeedsLine = pendingPlacement?.geometryType === 'LINESTRING';

  useEffect(() => {
    if (!selectedDeployment || selectedDeployment.resource_kind !== 'NOZZLE') {
      return;
    }
    const data = toRecord(selectedDeployment.resource_data);
    const spray = clamp(numberOrNull(data?.spray_angle) ?? 0, 0, 90);
    const pressure = clamp(numberOrNull(data?.pressure) ?? 60, 20, 100);
    setNozzleSettings({ spray_angle: spray, pressure });
  }, [selectedDeployment]);

  const getCanvasLocalPoint = useCallback((event: { clientX: number; clientY: number }): Point => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return { x: 0, y: 0 };
    }
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(1, rect.width);
    const scaleY = canvas.height / Math.max(1, rect.height);
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  }, []);

  const localCanvasToWorld = useCallback(
    (localPoint: Point): Point => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return { x: 0, y: 0 };
      }

      const basePoint = unapplyViewTransform(localPoint, canvas.width, canvas.height, viewZoom, viewPan);
      return canvasBaseToWorld(basePoint, canvas.width, canvas.height, worldViewport);
    },
    [viewPan, viewZoom, worldViewport],
  );

  const worldToLocalCanvas = useCallback(
    (worldPoint: Point): Point | null => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return null;
      }
      const base = worldToCanvasBase(worldPoint, canvas.width, canvas.height, worldViewport);
      return applyViewTransform(base, canvas.width, canvas.height, viewZoom, viewPan);
    },
    [viewPan, viewZoom, worldViewport],
  );

  const hitTestDeployment = useCallback(
    (localPoint: Point): ResourceDeploymentDto | null => {
      const deploymentsByPriority = visibleDeployments
        .slice()
        .sort((a, b) => parseCreatedAt(b.created_at) - parseCreatedAt(a.created_at));

      for (const deployment of deploymentsByPriority) {
        const worldPoints = extractGeometryPoints(deployment.geometry_type, deployment.geometry);
        if (worldPoints.length === 0) {
          continue;
        }

        const screenPoints = worldPoints
          .map((point) => worldToLocalCanvas(point))
          .filter((point): point is Point => point !== null);

        if (screenPoints.length === 0) {
          continue;
        }

        if (deployment.geometry_type === 'POINT') {
          const pointHitRadiusPx =
            deployment.resource_kind === 'VEHICLE'
              ? 16
              : deployment.resource_kind === 'NOZZLE'
                ? 13
                : deployment.resource_kind === 'WATER_SOURCE'
                  ? 12
                  : 10;
          if (distanceSquared(localPoint, screenPoints[0]) <= pointHitRadiusPx * pointHitRadiusPx) {
            return deployment;
          }
          continue;
        }

        if (deployment.geometry_type === 'LINESTRING') {
          const lineHitThresholdPx = deployment.resource_kind === 'HOSE_LINE' ? 10 : 8;
          if (screenPoints.length >= 2 && isPointNearPolyline(localPoint, screenPoints, lineHitThresholdPx)) {
            return deployment;
          }
          continue;
        }

        if (deployment.geometry_type === 'POLYGON' && screenPoints.length >= 3) {
          if (isPointInsidePolygon(localPoint, screenPoints)) {
            return deployment;
          }
          const closed = [...screenPoints, screenPoints[0]];
          if (isPointNearPolyline(localPoint, closed, 6)) {
            return deployment;
          }
        }
      }

      return null;
    },
    [visibleDeployments, worldToLocalCanvas],
  );

  const handleSelectedDeploymentAction = useCallback(async () => {
    if (!selectedDeployment || !selectedDeploymentAction || isUpdatingDeployment) {
      return;
    }
    if (isBuRole && !isBuActivatedByRtp) {
      setDeploymentActionError(`${currentBuLabel}: ожидайте постановки РТП перед тактическими действиями`);
      return;
    }

    const sessionId = realtimeSessionId || user?.session_id;
    if (!sessionId) {
      setDeploymentActionError('Нет активной сессии для тактической команды');
      return;
    }

    setDeploymentActionError('');
    setIsUpdatingDeployment(true);
    try {
      await sendRealtimeCommand(
        'create_resource_deployment',
        {
          resource_kind: selectedDeployment.resource_kind,
          status: selectedDeploymentAction.nextStatus,
          vehicle_dictionary_id: selectedDeployment.vehicle_dictionary_id,
          label: selectedDeployment.label,
          geometry_type: selectedDeployment.geometry_type,
          geometry: selectedDeployment.geometry,
          rotation_deg: selectedDeployment.rotation_deg,
          resource_data: {
            ...(selectedDeployment.resource_data ?? {}),
            source: 'simulation_board_action_panel',
            previous_deployment_id: selectedDeployment.id,
            previous_status: selectedDeployment.status,
            target_status: selectedDeploymentAction.nextStatus,
            initiated_from_role: activeRole ?? null,
          },
        },
        sessionId,
      );

      showTransientMessage(
        `${selectedDeployment.label.toUpperCase()}: ${DEPLOYMENT_HINT_LABELS[selectedDeploymentAction.nextStatus] ?? selectedDeploymentAction.nextStatus.toLowerCase()}`,
      );
      setSelectedDeploymentId(null);
    } catch (error) {
      setDeploymentActionError(getErrorMessage(error, 'Не удалось выполнить команду по выбранному ресурсу'));
    } finally {
      setIsUpdatingDeployment(false);
    }
  }, [
    activeRole,
    currentBuLabel,
    isBuActivatedByRtp,
    isBuRole,
    isUpdatingDeployment,
    realtimeSessionId,
    selectedDeployment,
    selectedDeploymentAction,
    sendRealtimeCommand,
    showTransientMessage,
    user?.session_id,
  ]);

  const handleApplyNozzleSettings = useCallback(async () => {
    if (!selectedDeployment || selectedDeployment.resource_kind !== 'NOZZLE' || isApplyingNozzleSettings) {
      return;
    }
    if (!canAdjustSelectedNozzle) {
      setDeploymentActionError('Нет прав для изменения параметров выбранного ствола');
      return;
    }
    if (isBuRole && !isBuActivatedByRtp) {
      setDeploymentActionError(`${currentBuLabel}: ожидайте постановки РТП перед настройкой ствола`);
      return;
    }

    const sessionId = realtimeSessionId || user?.session_id;
    if (!sessionId) {
      setDeploymentActionError('Нет активной сессии для настройки ствола');
      return;
    }

    setDeploymentActionError('');
    setIsApplyingNozzleSettings(true);
    try {
      await sendRealtimeCommand(
        'create_resource_deployment',
        {
          resource_kind: selectedDeployment.resource_kind,
          status: selectedDeployment.status,
          vehicle_dictionary_id: selectedDeployment.vehicle_dictionary_id,
          label: selectedDeployment.label,
          geometry_type: selectedDeployment.geometry_type,
          geometry: selectedDeployment.geometry,
          rotation_deg: selectedDeployment.rotation_deg,
          resource_data: {
            ...(selectedDeployment.resource_data ?? {}),
            source: 'simulation_board_nozzle_settings',
            previous_deployment_id: selectedDeployment.id,
            spray_angle: Math.round(nozzleSettings.spray_angle),
            pressure: Math.round(nozzleSettings.pressure),
            initiated_from_role: activeRole ?? null,
          },
        },
        sessionId,
      );

      showTransientMessage(
        `${selectedDeployment.label.toUpperCase()}: угол ${Math.round(nozzleSettings.spray_angle)}°, давление ${Math.round(nozzleSettings.pressure)}`,
      );
    } catch (error) {
      setDeploymentActionError(getErrorMessage(error, 'Не удалось применить параметры ствола'));
    } finally {
      setIsApplyingNozzleSettings(false);
    }
  }, [
    activeRole,
    canAdjustSelectedNozzle,
    currentBuLabel,
    isBuActivatedByRtp,
    isBuRole,
    isApplyingNozzleSettings,
    nozzleSettings.pressure,
    nozzleSettings.spray_angle,
    realtimeSessionId,
    selectedDeployment,
    sendRealtimeCommand,
    showTransientMessage,
    user?.session_id,
  ]);

  const zoomAtCanvasPoint = useCallback(
    (nextZoom: number, anchor: Point) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }

      const targetZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
      if (Math.abs(targetZoom - viewZoom) < 1e-6) {
        return;
      }

      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const baseX = centerX + (anchor.x - centerX - viewPan.x) / viewZoom;
      const baseY = centerY + (anchor.y - centerY - viewPan.y) / viewZoom;

      setViewZoom(targetZoom);
      setViewPan({
        x: anchor.x - centerX - (baseX - centerX) * targetZoom,
        y: anchor.y - centerY - (baseY - centerY) * targetZoom,
      });
    },
    [viewPan.x, viewPan.y, viewZoom],
  );

  const drawBoard = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const width = canvas.width;
    const height = canvas.height;

    const toScreen = (worldPoint: Point): Point => {
      const base = worldToCanvasBase(worldPoint, width, height, worldViewport);
      return applyViewTransform(base, width, height, viewZoom, viewPan);
    };

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, width, height);

    const origin = toScreen({ x: 0, y: 0 });
    let gridStepMeters = Math.max(5, Math.round(worldViewport.width / 16));

    const gridStepPixels = (stepM: number) => {
      const xStep = toScreen({ x: stepM, y: 0 });
      const yStep = toScreen({ x: 0, y: stepM });
      return {
        stepX: Math.abs(xStep.x - origin.x),
        stepY: Math.abs(yStep.y - origin.y),
      };
    };

    let { stepX, stepY } = gridStepPixels(gridStepMeters);
    while ((stepX < 16 || stepY < 16) && gridStepMeters < 4096) {
      gridStepMeters *= 2;
      ({ stepX, stepY } = gridStepPixels(gridStepMeters));
    }
    while ((stepX > 140 || stepY > 140) && gridStepMeters > 0.5) {
      gridStepMeters /= 2;
      ({ stepX, stepY } = gridStepPixels(gridStepMeters));
    }

    const pixelsPerMeter = stepX / Math.max(gridStepMeters, 1e-6);

    const drawVerticalGrid = (major: boolean) => {
      if (!Number.isFinite(stepX) || stepX < 4) {
        return;
      }
      const firstIndex = Math.ceil((0 - origin.x) / stepX);
      const lastIndex = Math.floor((width - origin.x) / stepX);
      for (let index = firstIndex; index <= lastIndex; index += 1) {
        const isMajor = index % 5 === 0;
        if (major !== isMajor) {
          continue;
        }
        const x = origin.x + index * stepX;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
    };

    const drawHorizontalGrid = (major: boolean) => {
      if (!Number.isFinite(stepY) || stepY < 4) {
        return;
      }
      const firstIndex = Math.ceil((0 - origin.y) / stepY);
      const lastIndex = Math.floor((height - origin.y) / stepY);
      for (let index = firstIndex; index <= lastIndex; index += 1) {
        const isMajor = index % 5 === 0;
        if (major !== isMajor) {
          continue;
        }
        const y = origin.y + index * stepY;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    };

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.11)';
    drawVerticalGrid(false);
    drawHorizontalGrid(false);

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.26)';
    drawVerticalGrid(true);
    drawHorizontalGrid(true);

    const drawPolyline = (points: Point[]) => {
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      });
      ctx.stroke();
    };

    const drawPolygon = (points: Point[]) => {
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) {
          ctx.moveTo(point.x, point.y);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      });
      ctx.closePath();
    };

    sceneLayer.siteItems.forEach((item) => {
      const worldPoints = extractGeometryPoints(item.geometryType, item.geometry);
      if (worldPoints.length === 0) {
        return;
      }
      const points = worldPoints.map((point) => toScreen(point));

      ctx.save();

      if (item.kind === 'BUILDING_CONTOUR') {
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 2;
        ctx.fillStyle = 'rgba(30, 41, 59, 0.22)';
        if (item.geometryType === 'POLYGON' && points.length >= 3) {
          drawPolygon(points);
          ctx.fill();
          ctx.stroke();
        } else if (item.geometryType === 'LINESTRING' && points.length >= 2) {
          drawPolyline(points);
        }
      } else if (item.kind === 'ROAD_ACCESS') {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
        ctx.lineWidth = 3;
        ctx.setLineDash([10, 6]);
        if (points.length >= 2) {
          drawPolyline(points);
        }
      } else if (item.kind === 'HYDRANT' || item.kind === 'WATER_SOURCE') {
        const point = points[0];
        if (!point) {
          ctx.restore();
          return;
        }

        ctx.beginPath();
        ctx.moveTo(point.x, point.y - 7);
        ctx.lineTo(point.x + 7, point.y);
        ctx.lineTo(point.x, point.y + 7);
        ctx.lineTo(point.x - 7, point.y);
        ctx.closePath();
        ctx.fillStyle = item.kind === 'HYDRANT' ? '#0ea5e9' : '#1d4ed8';
        ctx.strokeStyle = '#93c5fd';
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
      }

      ctx.restore();
    });

    sceneLayer.floorItems
      .filter((item) => item.kind !== 'FIRE_SOURCE' && item.kind !== 'SMOKE_ZONE')
      .forEach((item) => {
        const worldPoints = extractGeometryPoints(item.geometryType, item.geometry);
        if (worldPoints.length === 0) {
          return;
        }
        const points = worldPoints.map((point) => toScreen(point));

        ctx.save();

        if (item.kind === 'ROOM') {
          if (item.geometryType === 'POLYGON' && points.length >= 3) {
            drawPolygon(points);
            ctx.fillStyle = 'rgba(71, 85, 105, 0.18)';
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
            ctx.lineWidth = 1.3;
            ctx.fill();
            ctx.stroke();

            const center = extractGeometryCenter(item.geometryType, item.geometry);
            if (center) {
              const screenCenter = toScreen(center);
              ctx.fillStyle = 'rgba(226, 232, 240, 0.75)';
              ctx.font = '7px "Press Start 2P", monospace';
              ctx.fillText(item.label.slice(0, 12), screenCenter.x - 14, screenCenter.y);
            }
          }
        } else if (item.kind === 'WALL') {
          ctx.strokeStyle = 'rgba(226, 232, 240, 0.86)';
          ctx.lineWidth = 2;
          if (item.geometryType === 'LINESTRING' && points.length >= 2) {
            drawPolyline(points);
          }
        } else if (item.kind === 'DOOR') {
          ctx.strokeStyle = 'rgba(125, 211, 252, 0.9)';
          ctx.lineWidth = 2;
          if (item.geometryType === 'LINESTRING' && points.length >= 2) {
            drawPolyline(points);
          }
        } else if (item.kind === 'EXIT') {
          const point = points[0];
          if (point) {
            ctx.beginPath();
            ctx.moveTo(point.x, point.y - 6);
            ctx.lineTo(point.x + 6, point.y + 6);
            ctx.lineTo(point.x - 6, point.y + 6);
            ctx.closePath();
            ctx.fillStyle = '#22c55e';
            ctx.strokeStyle = '#86efac';
            ctx.fill();
            ctx.stroke();
          }
        } else if (item.kind === 'STAIR') {
          const point = points[0];
          if (point) {
            ctx.strokeStyle = '#60a5fa';
            ctx.lineWidth = 1.4;
            for (let index = 0; index < 4; index += 1) {
              ctx.strokeRect(point.x - 7 + index * 2, point.y - 7 + index * 2, 14 - index * 4, 14 - index * 4);
            }
          }
        } else if (item.kind === 'HYDRANT' || item.kind === 'WATER_SOURCE') {
          const point = points[0];
          if (point) {
            ctx.beginPath();
            ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
            ctx.fillStyle = item.kind === 'HYDRANT' ? '#06b6d4' : '#1d4ed8';
            ctx.strokeStyle = '#bae6fd';
            ctx.fill();
            ctx.stroke();
          }
        }

        ctx.restore();
      });

    type HazardItem = {
      kind: string;
      geometryType: GeometryType;
      geometry: Record<string, unknown>;
      areaM2: number;
      isActive: boolean;
      label: string;
      smokeDensity: number;
    };

    const runtimeHazards: HazardItem[] = (bundle?.fire_objects ?? []).map((fireObject) => ({
      kind: fireObject.kind,
      geometryType: fireObject.geometry_type,
      geometry: fireObject.geometry,
      areaM2: getFireAreaM2(fireObject),
      isActive: fireObject.is_active,
      label: fireObject.name,
      smokeDensity: 0.65,
    }));

    const fallbackSceneHazards: HazardItem[] = runtimeHazards.length > 0
      ? []
      : [
        ...sceneLayer.fireSourceItems.map((item) => ({
          kind: 'FIRE_SEAT',
          geometryType: item.geometryType,
          geometry: item.geometry,
          areaM2: Math.max(8, numberOrNull(item.props.fire_area_m2 ?? item.props.area_m2) ?? 28),
          isActive: item.props.is_active !== false,
          label: item.label,
          smokeDensity: Math.max(0, Math.min(1, numberOrNull(item.props.smoke_density) ?? 0.62)),
        })),
        ...sceneLayer.smokeSourceItems.map((item) => ({
          kind: 'SMOKE_ZONE',
          geometryType: item.geometryType,
          geometry: item.geometry,
          areaM2: Math.max(12, numberOrNull(item.props.fire_area_m2 ?? item.props.area_m2) ?? 38),
          isActive: item.props.is_active !== false,
          label: item.label,
          smokeDensity: Math.max(0, Math.min(1, numberOrNull(item.props.smoke_density) ?? 0.72)),
        })),
      ];

    const hazardsToDraw = runtimeHazards.length > 0 ? runtimeHazards : fallbackSceneHazards;

    hazardsToDraw.forEach((hazard) => {
      const worldPoints = extractGeometryPoints(hazard.geometryType, hazard.geometry);
      if (worldPoints.length === 0) {
        return;
      }
      const points = worldPoints.map((point) => toScreen(point));
      const isSmoke = hazard.kind === 'SMOKE_ZONE';
      const areaM2 = Math.max(1, hazard.areaM2);

      ctx.save();

      if (hazard.geometryType === 'POINT') {
        const point = points[0];
        const radiusMeters = Math.sqrt(areaM2 / Math.PI);
        const baseRadius = clamp(radiusMeters * pixelsPerMeter, isSmoke ? 12 : 8, isSmoke ? 340 : 220);
        const pulse = hazard.isActive ? 1 + Math.sin((nowTickMs + point.x * 7) / (isSmoke ? 1000 : 360)) * (isSmoke ? 0.08 : 0.12) : 0.9;
        const radiusPx = baseRadius * pulse;

        if (isSmoke) {
          const smokeGradient = ctx.createRadialGradient(point.x, point.y, radiusPx * 0.12, point.x, point.y, radiusPx);
          smokeGradient.addColorStop(0, `rgba(203, 213, 225, ${0.55 * hazard.smokeDensity})`);
          smokeGradient.addColorStop(0.45, `rgba(100, 116, 139, ${0.42 * hazard.smokeDensity})`);
          smokeGradient.addColorStop(1, 'rgba(30, 41, 59, 0)');
          ctx.fillStyle = smokeGradient;
          ctx.beginPath();
          ctx.arc(point.x, point.y, radiusPx, 0, Math.PI * 2);
          ctx.fill();

          for (let index = 0; index < 7; index += 1) {
            const phase = nowTickMs / 1050 + index * 1.12;
            const driftX = Math.cos(phase) * radiusPx * 0.28;
            const driftY = Math.sin(phase * 1.2) * radiusPx * 0.22;
            const blobRadius = radiusPx * (0.14 + index * 0.05);
            ctx.fillStyle = `rgba(71, 85, 105, ${0.09 + index * 0.025})`;
            ctx.beginPath();
            ctx.arc(point.x + driftX, point.y + driftY, blobRadius, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          const flameGradient = ctx.createRadialGradient(point.x, point.y, radiusPx * 0.06, point.x, point.y, radiusPx);
          flameGradient.addColorStop(0, 'rgba(255, 251, 235, 0.98)');
          flameGradient.addColorStop(0.2, 'rgba(253, 186, 116, 0.95)');
          flameGradient.addColorStop(0.45, 'rgba(249, 115, 22, 0.9)');
          flameGradient.addColorStop(0.82, 'rgba(127, 29, 29, 0.52)');
          flameGradient.addColorStop(1, 'rgba(17, 24, 39, 0)');
          ctx.fillStyle = flameGradient;
          ctx.beginPath();
          ctx.arc(point.x, point.y, radiusPx, 0, Math.PI * 2);
          ctx.fill();

          for (let index = 0; index < 12; index += 1) {
            const phase = nowTickMs / 260 + index * 1.7;
            const flameX = point.x + Math.cos(phase) * radiusPx * 0.34;
            const flameY = point.y + Math.sin(phase * 1.6) * radiusPx * 0.29;
            const flameRadius = radiusPx * (0.06 + ((index % 4) * 0.025));
            ctx.fillStyle = index % 2 === 0 ? 'rgba(251, 146, 60, 0.4)' : 'rgba(254, 215, 170, 0.34)';
            ctx.beginPath();
            ctx.arc(flameX, flameY, flameRadius, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        ctx.beginPath();
        ctx.arc(point.x, point.y, isSmoke ? 4 : 5, 0, Math.PI * 2);
        ctx.fillStyle = isSmoke ? '#94a3b8' : '#f97316';
        ctx.strokeStyle = isSmoke ? '#cbd5e1' : '#fdba74';
        ctx.lineWidth = 1.2;
        ctx.fill();
        ctx.stroke();

        if (!isSmoke && hazard.isActive) {
          ctx.fillStyle = '#fdba74';
          ctx.font = '7px "Press Start 2P", monospace';
          ctx.fillText(`${Math.round(areaM2)}м2`, point.x + 8, point.y + 11);
        }
      }

      if (hazard.geometryType === 'LINESTRING' && points.length >= 2) {
        ctx.strokeStyle = isSmoke ? 'rgba(148, 163, 184, 0.75)' : 'rgba(249, 115, 22, 0.85)';
        ctx.lineWidth = isSmoke ? 2.5 : 2;
        ctx.setLineDash(isSmoke ? [8, 5] : [6, 3]);
        drawPolyline(points);
      }

      if (hazard.geometryType === 'POLYGON' && points.length >= 3) {
        drawPolygon(points);

        const bounds = points.reduce(
          (accumulator, point) => ({
            minX: Math.min(accumulator.minX, point.x),
            maxX: Math.max(accumulator.maxX, point.x),
            minY: Math.min(accumulator.minY, point.y),
            maxY: Math.max(accumulator.maxY, point.y),
          }),
          { minX: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY },
        );

        const gradient = ctx.createLinearGradient(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
        if (isSmoke) {
          gradient.addColorStop(0, `rgba(148, 163, 184, ${0.15 + hazard.smokeDensity * 0.2})`);
          gradient.addColorStop(1, 'rgba(51, 65, 85, 0.04)');
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.7)';
        } else {
          gradient.addColorStop(0, 'rgba(253, 186, 116, 0.34)');
          gradient.addColorStop(0.45, 'rgba(249, 115, 22, 0.3)');
          gradient.addColorStop(1, 'rgba(127, 29, 29, 0.1)');
          ctx.strokeStyle = 'rgba(251, 146, 60, 0.86)';
        }

        ctx.fillStyle = gradient;
        ctx.globalAlpha = hazard.isActive ? 1 : 0.45;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }

      ctx.restore();
    });

    if (isBuRole && tacticalChainGraph.links.length > 0) {
      const drawArrowHead = (
        start: Point,
        end: Point,
        color: string,
        highlighted: boolean,
      ) => {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < 1) {
          return;
        }

        const ux = dx / distance;
        const uy = dy / distance;
        const size = highlighted ? 7 : 5;

        const tip = {
          x: end.x,
          y: end.y,
        };
        const left = {
          x: end.x - ux * size - uy * (size * 0.6),
          y: end.y - uy * size + ux * (size * 0.6),
        };
        const right = {
          x: end.x - ux * size + uy * (size * 0.6),
          y: end.y - uy * size - ux * (size * 0.6),
        };

        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(left.x, left.y);
        ctx.lineTo(right.x, right.y);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };

      tacticalChainGraph.links.forEach((link) => {
        const from = toScreen(link.from);
        const to = toScreen(link.to);

        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < 6) {
          return;
        }

        const ux = dx / distance;
        const uy = dy / distance;
        const startOffset = link.kind === 'HOSE_TO_NOZZLE' ? 8 : 10;
        const endOffset = link.kind === 'HOSE_TO_NOZZLE' ? 8 : 9;

        const start = {
          x: from.x + ux * startOffset,
          y: from.y + uy * startOffset,
        };
        const end = {
          x: to.x - ux * endOffset,
          y: to.y - uy * endOffset,
        };

        let color = '#94a3b8';
        if (link.hasWater) {
          color = '#38bdf8';
        }
        if (link.kind === 'VEHICLE_TO_NOZZLE') {
          color = link.hasWater ? '#22d3ee' : '#f59e0b';
        }
        if (link.blockedReason && !link.hasWater) {
          color = '#ef4444';
        }

        const lineWidth = link.highlighted ? 3 : link.hasWater ? 2.4 : 1.8;

        ctx.save();
        ctx.globalAlpha = link.highlighted ? 0.98 : 0.72;
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        if (!link.hasWater) {
          ctx.setLineDash(link.kind === 'VEHICLE_TO_NOZZLE' ? [5, 3] : [7, 5]);
          ctx.lineDashOffset = -((nowTickMs / 120) % 24);
        } else {
          ctx.setLineDash([10, 4]);
          ctx.lineDashOffset = -((nowTickMs / 80) % 28);
          ctx.shadowColor = color;
          ctx.shadowBlur = link.highlighted ? 10 : 6;
        }

        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();

        ctx.setLineDash([]);
        drawArrowHead(start, end, color, link.highlighted);

        if (link.blockedReason && !link.hasWater) {
          const midX = (start.x + end.x) / 2;
          const midY = (start.y + end.y) / 2;
          const size = link.highlighted ? 5 : 4;
          ctx.strokeStyle = '#f87171';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(midX - size, midY - size);
          ctx.lineTo(midX + size, midY + size);
          ctx.moveTo(midX + size, midY - size);
          ctx.lineTo(midX - size, midY + size);
          ctx.stroke();
        }

        ctx.restore();
      });
    }

    visibleDeployments.forEach((deployment: ResourceDeploymentDto) => {
      const points = extractGeometryPoints(deployment.geometry_type, deployment.geometry);
      if (points.length === 0) {
        return;
      }

      const isSelected = selectedDeploymentId === deployment.id;
      const statusColor = DEPLOYMENT_COLORS[deployment.status] || '#22c55e';

      ctx.save();
      ctx.strokeStyle = statusColor;
      ctx.fillStyle = statusColor;
      ctx.lineWidth = isSelected ? 3 : 2;

      if (deployment.geometry_type === 'LINESTRING' && points.length >= 2) {
        if (deployment.resource_kind === 'HOSE_LINE') {
          const hoseHasWater = hydraulicRuntime.wetHoseLineIds.has(deployment.id);
          ctx.strokeStyle = hoseHasWater ? '#38bdf8' : '#64748b';
          ctx.lineWidth = hoseHasWater ? (isSelected ? 4 : 3) : isSelected ? 3 : 2;
          if (!hoseHasWater || deployment.status !== 'ACTIVE') {
            ctx.setLineDash([8, 4]);
          } else {
            const dashOffset = ((nowTickMs / 45) % 14) * -1;
            ctx.setLineDash([9, 5]);
            ctx.lineDashOffset = dashOffset;
            ctx.shadowColor = '#38bdf8';
            ctx.shadowBlur = 6;
          }
        }

        ctx.beginPath();
        points.forEach((point, index) => {
          const screen = toScreen(point);
          if (index === 0) {
            ctx.moveTo(screen.x, screen.y);
          } else {
            ctx.lineTo(screen.x, screen.y);
          }
        });
        ctx.stroke();
      }

      if (deployment.geometry_type === 'POINT') {
        const point = toScreen(points[0]);

        if (deployment.resource_kind === 'VEHICLE') {
          const markerSize = isSelected ? 12 : 10;
          const markerOffset = markerSize / 2;
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(point.x - markerOffset, point.y - markerOffset, markerSize, markerSize);
          ctx.strokeStyle = statusColor;
          ctx.strokeRect(point.x - markerOffset, point.y - markerOffset, markerSize, markerSize);

          if (deployment.vehicle_dictionary_id) {
            const vehicleRuntime = fireRuntime.vehicleRuntimeById.get(deployment.vehicle_dictionary_id);
            if (vehicleRuntime) {
              const ratio = vehicleRuntime.waterCapacityL > 0
                ? clamp(vehicleRuntime.waterRemainingL / vehicleRuntime.waterCapacityL, 0, 1)
                : 0;
              const waterColor = ratio > 0.6 ? '#38bdf8' : ratio > 0.25 ? '#facc15' : '#f87171';

              ctx.fillStyle = waterColor;
              ctx.fillRect(point.x - markerOffset + 2, point.y - markerOffset + 2, markerSize - 4, markerSize - 4);

              const barWidth = markerSize + 8;
              ctx.fillStyle = '#0f172a';
              ctx.fillRect(point.x - barWidth / 2, point.y + markerOffset + 3, barWidth, 3);
              ctx.fillStyle = waterColor;
              ctx.fillRect(point.x - barWidth / 2, point.y + markerOffset + 3, barWidth * ratio, 3);
            }
          }
        } else if (deployment.resource_kind === 'NOZZLE') {
          const nozzleHasWater = hydraulicRuntime.wetNozzleIds.has(deployment.id);
          const isNozzleActive = deployment.status === 'ACTIVE';
          const radius = isSelected ? 6 : 5;

          ctx.beginPath();
          ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
          if (isNozzleActive && nozzleHasWater) {
            ctx.fillStyle = '#38bdf8';
            ctx.strokeStyle = '#bae6fd';
            ctx.shadowColor = '#38bdf8';
            ctx.shadowBlur = 8;
          } else if (isNozzleActive) {
            ctx.fillStyle = '#92400e';
            ctx.strokeStyle = '#f59e0b';
            ctx.setLineDash([3, 2]);
          } else {
            ctx.fillStyle = '#6b7280';
            ctx.strokeStyle = '#cbd5e1';
          }
          ctx.fill();
          ctx.stroke();
        } else if (deployment.resource_kind === 'WATER_SOURCE') {
          const size = isSelected ? 8 : 6;
          ctx.beginPath();
          ctx.moveTo(point.x, point.y - size);
          ctx.lineTo(point.x + size, point.y);
          ctx.lineTo(point.x, point.y + size);
          ctx.lineTo(point.x - size, point.y);
          ctx.closePath();
          ctx.fillStyle = '#1d4ed8';
          ctx.strokeStyle = '#93c5fd';
          ctx.fill();
          ctx.stroke();
        } else if (deployment.resource_kind === 'MARKER') {
          const size = isSelected ? 8 : 6;
          ctx.beginPath();
          ctx.moveTo(point.x, point.y - size);
          ctx.lineTo(point.x + size * 0.8, point.y + size);
          ctx.lineTo(point.x - size * 0.8, point.y + size);
          ctx.closePath();
          ctx.fillStyle = '#eab308';
          ctx.strokeStyle = '#fde68a';
          ctx.fill();
          ctx.stroke();
        } else {
          const markerSize = isSelected ? 10 : 8;
          const markerOffset = markerSize / 2;
          ctx.fillRect(point.x - markerOffset, point.y - markerOffset, markerSize, markerSize);
        }

        ctx.font = '8px "Press Start 2P", monospace';
        ctx.fillStyle = isSelected ? '#ffffff' : '#e2e8f0';
        ctx.fillText(deployment.label.slice(0, 10), point.x + 7, point.y - 6);
      }

      if (deployment.geometry_type === 'POLYGON' && points.length >= 3) {
        ctx.beginPath();
        points.forEach((point, index) => {
          const screen = toScreen(point);
          if (index === 0) {
            ctx.moveTo(screen.x, screen.y);
          } else {
            ctx.lineTo(screen.x, screen.y);
          }
        });
        ctx.closePath();
        ctx.globalAlpha = 0.18;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.stroke();
      }

      if (isSelected && points.length > 0) {
        const anchor = toScreen(points[0]);
        ctx.fillStyle = '#ffffff';
        ctx.font = '8px "Press Start 2P", monospace';
        ctx.fillText(`[${deployment.resource_kind}]`, anchor.x + 6, anchor.y + 9);
      }

      ctx.restore();
    });

    const scaleLengthM = pickScaleBarLengthByPixels(pixelsPerMeter);
    const scaleLengthPx = scaleLengthM * pixelsPerMeter;
    const scaleY = height - 18;
    const scalePrimaryLabel = formatScaleDistance(scaleLengthM);
    const scaleSecondaryLabel = `1 клетка ~ ${Math.round(gridStepMeters * 10) / 10} м`;

    ctx.save();
    ctx.font = '8px "Press Start 2P", monospace';

    const maxTextWidth = Math.max(
      ctx.measureText(scalePrimaryLabel).width,
      ctx.measureText(scaleSecondaryLabel).width,
    );

    const panelPaddingX = 10;
    const panelWidth = Math.max(scaleLengthPx, maxTextWidth) + panelPaddingX * 2;
    const panelRightX = width - 12;
    const panelLeftX = Math.max(8, panelRightX - panelWidth);
    const scaleRightX = panelRightX - panelPaddingX;
    const scaleLeftX = scaleRightX - scaleLengthPx;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.58)';
    ctx.fillRect(panelLeftX, scaleY - 28, panelWidth, 28);

    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(scaleLeftX, scaleY);
    ctx.lineTo(scaleRightX, scaleY);
    ctx.stroke();

    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(scaleLeftX, scaleY - 4);
    ctx.lineTo(scaleLeftX, scaleY + 4);
    ctx.moveTo(scaleRightX, scaleY - 4);
    ctx.lineTo(scaleRightX, scaleY + 4);
    ctx.stroke();

    ctx.fillStyle = '#e2e8f0';
    ctx.textAlign = 'right';
    ctx.fillText(scalePrimaryLabel, scaleRightX, scaleY - 16);
    ctx.fillText(scaleSecondaryLabel, scaleRightX, scaleY - 6);
    ctx.restore();

    if (pendingPlacement && hoverPlacementPoint) {
      const point = toScreen(hoverPlacementPoint);
      ctx.save();
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(point.x - 9, point.y);
      ctx.lineTo(point.x + 9, point.y);
      ctx.moveTo(point.x, point.y - 9);
      ctx.lineTo(point.x, point.y + 9);
      ctx.stroke();
      ctx.restore();
    }

    if (pendingPlacement && linePlacementStart) {
      const start = toScreen(linePlacementStart);
      ctx.save();
      ctx.fillStyle = '#86efac';
      ctx.beginPath();
      ctx.arc(start.x, start.y, 4, 0, Math.PI * 2);
      ctx.fill();

      if (hoverPlacementPoint) {
        const end = toScreen(hoverPlacementPoint);
        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
      }
      ctx.restore();
    }
  }, [
    bundle,
    fireRuntime.vehicleRuntimeById,
    hoverPlacementPoint,
    hydraulicRuntime,
    isBuRole,
    linePlacementStart,
    nowTickMs,
    pendingPlacement,
    sceneLayer,
    selectedDeploymentId,
    tacticalChainGraph,
    viewPan,
    viewZoom,
    visibleDeployments,
    worldViewport,
  ]);

  useEffect(() => {
    drawBoard();
  }, [canvasSize.height, canvasSize.width, drawBoard]);

  useEffect(() => {
    const holder = canvasHolderRef.current;
    if (!holder) {
      return;
    }

    const updateCanvasSize = () => {
      const nextWidth = Math.max(640, Math.floor(holder.clientWidth - 14));
      const nextHeight = Math.max(360, Math.floor(holder.clientHeight - 14));
      setCanvasSize((previous) => {
        if (previous.width === nextWidth && previous.height === nextHeight) {
          return previous;
        }
        return { width: nextWidth, height: nextHeight };
      });
    };

    updateCanvasSize();
    const observer = new ResizeObserver(() => {
      updateCanvasSize();
    });
    observer.observe(holder);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pendingPlacement) {
      setHoverPlacementPoint(null);
      setLinePlacementStart(null);
      return;
    }
    setSelectedDeploymentId(null);
  }, [pendingPlacement]);

  useEffect(() => {
    if (!selectedDeploymentId) {
      return;
    }
    if (visibleDeployments.some((deployment) => deployment.id === selectedDeploymentId)) {
      return;
    }
    setSelectedDeploymentId(null);
  }, [selectedDeploymentId, visibleDeployments]);

  useEffect(() => {
    if (!selectedDeployment) {
      setDeploymentActionError('');
      return;
    }
    setDeploymentActionError('');
  }, [selectedDeployment]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      clearPendingPlacement();
      setHoverPlacementPoint(null);
      setLinePlacementStart(null);
      setSelectedDeploymentId(null);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [clearPendingPlacement]);

  const endPan = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    if (drag.moved) {
      suppressNextClickRef.current = true;
    }
    dragRef.current = null;
    setIsPanning(false);
  }, []);

  useEffect(() => {
    const handleMouseUp = () => {
      endPan();
    };
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [endPan]);

  const handleCanvasMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (isReadOnly) {
      return;
    }

    const localPoint = getCanvasLocalPoint(event);
    const shouldPan =
      !pendingPlacement || event.button === 1 || event.button === 2 || event.shiftKey || event.altKey || event.metaKey;

    if (!shouldPan || event.button !== 0 && event.button !== 1 && event.button !== 2) {
      return;
    }

    event.preventDefault();
    dragRef.current = {
      start: localPoint,
      basePan: { ...viewPan },
      moved: false,
    };
    setIsPanning(true);
  };

  const handleCanvasMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (isReadOnly) {
      return;
    }

    const localPoint = getCanvasLocalPoint(event);

    if (dragRef.current) {
      const drag = dragRef.current;
      const dx = localPoint.x - drag.start.x;
      const dy = localPoint.y - drag.start.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        drag.moved = true;
      }
      setViewPan({
        x: drag.basePan.x + dx,
        y: drag.basePan.y + dy,
      });
      return;
    }

    if (pendingPlacement) {
      setHoverPlacementPoint(localCanvasToWorld(localPoint));
    }
  };

  const handleCanvasWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    if (isReadOnly) {
      return;
    }

    event.preventDefault();
    const anchor = getCanvasLocalPoint(event);
    if (event.deltaY < 0) {
      zoomAtCanvasPoint(viewZoom * 1.12, anchor);
    } else {
      zoomAtCanvasPoint(viewZoom / 1.12, anchor);
    }
  };

  const handleCanvasClick = async (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (isReadOnly) {
      return;
    }

    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }

    if (isPlacing) {
      return;
    }

    if (!pendingPlacement) {
      const hit = hitTestDeployment(getCanvasLocalPoint(event));
      setSelectedDeploymentId(hit?.id ?? null);
      return;
    }

    if (isBuRole && !isBuActivatedByRtp) {
      setPlacementError(`${currentBuLabel}: ожидайте постановки РТП перед размещением ресурсов`);
      return;
    }

    const sessionId = realtimeSessionId || user?.session_id;
    if (!sessionId) {
      setPlacementError('Нет активной сессии для размещения ресурса');
      return;
    }

    const worldPoint = localCanvasToWorld(getCanvasLocalPoint(event));

    if (placementNeedsLine && !linePlacementStart) {
      setLinePlacementStart(worldPoint);
      setHoverPlacementPoint(worldPoint);
      showTransientMessage(`${pendingPlacement.roleLabel}: выберите конечную точку линии`);
      return;
    }

    if (pendingPlacement.resourceKind === 'HOSE_LINE' && placementNeedsLine && linePlacementStart) {
      const dx = linePlacementStart.x - worldPoint.x;
      const dy = linePlacementStart.y - worldPoint.y;
      const distanceMeters = Math.sqrt(dx * dx + dy * dy);
      if (distanceMeters > maxHoseLength) {
        showTransientMessage(
          `${pendingPlacement.roleLabel}: длина рукава ${distanceMeters.toFixed(1)} м > лимита ${maxHoseLength} м`,
        );
        return;
      }
    }

    const geometryPayload = placementNeedsLine
      ? { points: [linePlacementStart ?? worldPoint, worldPoint] }
      : { x: worldPoint.x, y: worldPoint.y };

    const baseResourceData: Record<string, unknown> = {
      source: pendingPlacement.source,
      role: pendingPlacement.roleLabel,
      placed_via: 'simulation_board_click',
      line_start: linePlacementStart,
      ...(pendingPlacement.resourceData ?? {}),
    };

    if (pendingPlacement.resourceKind === 'HOSE_LINE') {
      const roleTag = normalizeDeploymentRoleTag(baseResourceData.role ?? pendingPlacement.roleLabel);
      const lineStart = linePlacementStart ?? worldPoint;
      const lineCenter: Point = {
        x: (lineStart.x + worldPoint.x) / 2,
        y: (lineStart.y + worldPoint.y) / 2,
      };

      const vehicleCandidates = visibleDeployments
        .filter((deployment) => deployment.resource_kind === 'VEHICLE')
        .filter((deployment) => deployment.status === 'DEPLOYED' || deployment.status === 'ACTIVE')
        .filter((deployment) => {
          if (!deployment.vehicle_dictionary_id) {
            return false;
          }
          const runtime = fireRuntime.vehicleRuntimeById.get(deployment.vehicle_dictionary_id);
          if (!runtime) {
            return true;
          }
          return runtime.waterRemainingL > 0.01;
        })
        .filter((deployment) => {
          if (!roleTag) {
            return true;
          }
          const deploymentRole = getDeploymentRoleTag(deployment);
          return !deploymentRole || deploymentRole === roleTag;
        });

      if (vehicleCandidates.length === 0) {
        setPlacementError(
          isBuRole
            ? `${currentBuLabel}: сначала примите поступившую машину и поставьте ее на позицию`
            : 'Для рукавной линии нужна машина на позиции с остатком воды',
        );
        return;
      }

      let selectedVehicle = vehicleCandidates[0];
      let bestDistance = Number.POSITIVE_INFINITY;
      vehicleCandidates.forEach((candidate) => {
        const center = extractGeometryCenter(candidate.geometry_type, candidate.geometry);
        if (!center) {
          return;
        }
        const distance = distanceSquared(center, lineCenter);
        if (distance < bestDistance) {
          bestDistance = distance;
          selectedVehicle = candidate;
        }
      });

      const linkedVehicleId = selectedVehicle.vehicle_dictionary_id;
      if (!linkedVehicleId) {
        setPlacementError('Не удалось определить машину для питания рукава');
        return;
      }

      baseResourceData.strict_chain = true;
      baseResourceData.linked_vehicle_id = linkedVehicleId;
      baseResourceData.linked_vehicle_deployment_id = selectedVehicle.id;

      const splitterCandidates = visibleDeployments
        .filter((deployment) => deployment.resource_kind === 'HOSE_SPLITTER' && deployment.status !== 'COMPLETED')
        .filter((deployment) => {
          if (!roleTag) {
            return true;
          }
          const deploymentRole = getDeploymentRoleTag(deployment);
          return !deploymentRole || deploymentRole === roleTag;
        });

      let nearestSplitter: ResourceDeploymentDto | null = null;
      let splitterDistance = Number.POSITIVE_INFINITY;
      splitterCandidates.forEach((candidate) => {
        const center = extractGeometryCenter(candidate.geometry_type, candidate.geometry);
        if (!center) {
          return;
        }
        const distance = Math.sqrt(distanceSquared(center, lineStart));
        if (distance < splitterDistance) {
          splitterDistance = distance;
          nearestSplitter = candidate;
        }
      });

      const splitter = nearestSplitter as ResourceDeploymentDto | null;
      if (splitter && splitterDistance <= 7) {
        baseResourceData.linked_splitter_id = splitter.id;
        const splitterData = toRecord(splitter.resource_data);
        if (typeof splitterData?.chain_id === 'string' && splitterData.chain_id.trim().length > 0) {
          baseResourceData.parent_chain_id = splitterData.chain_id;
        }
      }

      if (typeof baseResourceData.chain_id !== 'string' || baseResourceData.chain_id.trim().length === 0) {
        baseResourceData.chain_id = `hose_${crypto.randomUUID()}`;
      }
    }

    if (pendingPlacement.resourceKind === 'HOSE_SPLITTER') {
      const roleTag = normalizeDeploymentRoleTag(baseResourceData.role ?? pendingPlacement.roleLabel);
      const vehicleCandidates = visibleDeployments
        .filter((deployment) => deployment.resource_kind === 'VEHICLE')
        .filter((deployment) => deployment.status === 'DEPLOYED' || deployment.status === 'ACTIVE')
        .filter((deployment) => {
          if (!roleTag) {
            return true;
          }
          const deploymentRole = getDeploymentRoleTag(deployment);
          return !deploymentRole || deploymentRole === roleTag;
        });

      let selectedVehicleForSplitter: ResourceDeploymentDto | null = null;
      let bestVehicleDistance = Number.POSITIVE_INFINITY;
      vehicleCandidates.forEach((candidate) => {
        const center = extractGeometryCenter(candidate.geometry_type, candidate.geometry);
        if (!center) {
          return;
        }
        const distance = distanceSquared(center, worldPoint);
        if (distance < bestVehicleDistance) {
          bestVehicleDistance = distance;
          selectedVehicleForSplitter = candidate;
        }
      });

      const splitterVehicle = selectedVehicleForSplitter as ResourceDeploymentDto | null;
      if (splitterVehicle?.vehicle_dictionary_id) {
        baseResourceData.linked_vehicle_id = splitterVehicle.vehicle_dictionary_id;
        baseResourceData.linked_vehicle_deployment_id = splitterVehicle.id;
      }
      if (typeof baseResourceData.chain_id !== 'string' || baseResourceData.chain_id.trim().length === 0) {
        baseResourceData.chain_id = `splitter_${crypto.randomUUID()}`;
      }
      baseResourceData.max_branches = 3;
    }

    if (pendingPlacement.resourceKind === 'NOZZLE') {
      const roleTag = normalizeDeploymentRoleTag(baseResourceData.role ?? pendingPlacement.roleLabel);
      const hoseCandidates = visibleDeployments
        .filter((deployment) => deployment.resource_kind === 'HOSE_LINE' && deployment.status !== 'COMPLETED')
        .filter((deployment) => {
          const data = toRecord(deployment.resource_data);
          return data?.plan_only !== true;
        })
        .filter((deployment) => {
          if (!roleTag) {
            return true;
          }
          const deploymentRole = getDeploymentRoleTag(deployment);
          return !deploymentRole || deploymentRole === roleTag;
        });

      if (hoseCandidates.length === 0) {
        setPlacementError('Для ствола сначала разместите рукавную линию');
        return;
      }

      let selectedHose = hoseCandidates[0];
      let bestDistance = Number.POSITIVE_INFINITY;
      hoseCandidates.forEach((candidate) => {
        const center = extractGeometryCenter(candidate.geometry_type, candidate.geometry);
        if (!center) {
          return;
        }
        const distance = distanceSquared(center, worldPoint);
        if (distance < bestDistance) {
          bestDistance = distance;
          selectedHose = candidate;
        }
      });

      const hoseData = toRecord(selectedHose.resource_data);
      const linkedVehicleIdFromHose = numberOrNull(hoseData?.linked_vehicle_id);
      const linkedVehicleIdFromRuntime = fireRuntime.hoseRuntimeById.get(selectedHose.id)?.linkedVehicleId ?? null;

      baseResourceData.strict_chain = true;
      baseResourceData.linked_hose_line_id = selectedHose.id;
      if (hoseData && typeof hoseData.chain_id === 'string' && hoseData.chain_id.trim().length > 0) {
        baseResourceData.linked_hose_line_chain_id = hoseData.chain_id;
      }

      const linkedVehicleId = linkedVehicleIdFromHose ?? linkedVehicleIdFromRuntime;
      if (linkedVehicleId !== null && linkedVehicleId > 0) {
        baseResourceData.linked_vehicle_id = linkedVehicleId;
      }
    }

    setPlacementError('');
    setIsPlacing(true);

    try {
      await sendRealtimeCommand(
        'create_resource_deployment',
        {
          resource_kind: pendingPlacement.resourceKind,
          status: pendingPlacement.status,
          vehicle_dictionary_id: pendingPlacement.vehicleId,
          label: pendingPlacement.label,
          geometry_type: pendingPlacement.geometryType,
          geometry: geometryPayload,
          resource_data: baseResourceData,
        },
        sessionId,
      );

      showTransientMessage(
        `${pendingPlacement.roleLabel}: ${pendingPlacement.label.toUpperCase()} размещено`,
      );
      clearPendingPlacement();
      setHoverPlacementPoint(null);
      setLinePlacementStart(null);
    } catch (error) {
      setPlacementError(getErrorMessage(error, 'Не удалось разместить ресурс на карте'));
    } finally {
      setIsPlacing(false);
    }
  };

  const roleStatusLabel = activeRole === 'ШТАБ'
    ? 'ШТАБ'
    : activeRole === 'РТП'
      ? 'РТП'
      : activeRole ?? 'ОПЕРКАРТА';

  const showAreaStats = isBuRole || isDispatcherRole;
  const showTacticalCounts = isBuRole;
  const showChainPanel = isBuRole && tacticalChainGraph.links.length > 0;
  const showLatestHint = !isRtpRole && !isHqRole;

  return (
    <div className="relative w-full h-full bg-[#111] overflow-hidden">
      {!isReadOnly ? (
        <div className="absolute top-4 right-4 z-10 flex flex-col items-end gap-2 max-w-[55%]">
        {transientMessage || dispatcherBannerText ? (
          <PixelButton variant="green" className="text-[9px] px-3 py-2 tracking-wide max-w-full truncate">
            {transientMessage || dispatcherBannerText}
          </PixelButton>
        ) : null}

        {buActivationLockMessage ? (
          <PixelButton variant="default" className="text-[8px] px-3 py-1.5 tracking-wide max-w-full truncate">
            {buActivationLockMessage}
          </PixelButton>
        ) : null}

        {pendingPlacement ? (
          <PixelButton variant="default" className="text-[8px] px-3 py-1.5 tracking-wide max-w-full truncate">
            РЕЖИМ РАЗМЕЩЕНИЯ: {pendingPlacement.label.toUpperCase()} ({pendingPlacement.roleLabel})
          </PixelButton>
        ) : null}

        {pendingPlacement ? (
          <PixelButton variant="default" className="text-[7px] px-3 py-1 max-w-full truncate">
            {pendingPlacement.geometryType === 'LINESTRING'
              ? linePlacementStart
                ? 'ШАГ 2: ВЫБЕРИТЕ КОНЕЧНУЮ ТОЧКУ'
                : 'ШАГ 1: ВЫБЕРИТЕ НАЧАЛЬНУЮ ТОЧКУ'
              : 'КЛИКНИТЕ НА КАРТЕ ДЛЯ РАЗМЕЩЕНИЯ'}
          </PixelButton>
        ) : null}

        {lessonTiming ? (
          <PixelButton
            variant={lessonTiming.timeoutReached ? 'active' : lessonTiming.inProgress ? 'green' : 'default'}
            className="text-[8px] px-3 py-1.5 tracking-wide"
          >
            {lessonTiming.remainingSec !== null
              ? `УРОК: ${formatDurationMmSs(lessonTiming.remainingSec)}`
              : 'УРОК: БЕЗ ЛИМИТА'}
            {' | '}ИГРА: {formatGameClock(lessonTiming.gameClockSec)}
          </PixelButton>
        ) : null}

        {showAreaStats ? (
          <PixelButton variant={activeFireCount > 0 ? 'green' : 'default'} className="text-[8px] px-3 py-1.5 tracking-wide">
            {roleStatusLabel}: ОЧАГИ {fireStats.activeFireCount} | ДЫМ {fireStats.activeSmokeCount}
          </PixelButton>
        ) : null}

        {showAreaStats ? (
          <PixelButton variant="default" className="text-[7px] px-3 py-1 tracking-wide">
            ПЛОЩАДЬ: ОГОНЬ {Math.round(fireStats.activeFireAreaM2)} м2
            {fireStats.activeFireCapAreaM2 > 0 ? ` / ${Math.round(fireStats.activeFireCapAreaM2)} м2` : ''}
            {' | '}ДЫМ {Math.round(fireStats.activeSmokeAreaM2)} м2
          </PixelButton>
        ) : null}

        {showAreaStats ? (
          <PixelButton variant="default" className="text-[7px] px-3 py-1 tracking-wide">
            ТЕХНИКА: ПЛАН {deploymentCounts.PLANNED} | ПУТЬ {deploymentCounts.EN_ROUTE} | ПОЗИЦИЯ {deploymentCounts.DEPLOYED + deploymentCounts.ACTIVE}
          </PixelButton>
        ) : null}

        {showTacticalCounts ? (
          <PixelButton variant="default" className="text-[7px] px-3 py-1 tracking-wide">
            ТУШЕНИЕ: РУКАВА {tacticalResourceCounts.hoseLines} | СТВОЛЫ {tacticalResourceCounts.nozzles} | ВОДОИСТОЧНИКИ {tacticalResourceCounts.waterSources}
          </PixelButton>
        ) : null}

        {showChainPanel ? (
          <div className="bg-[#161616] border-2 border-black px-2 py-2 text-[7px] text-cyan-100 w-[320px] max-w-full">
            <div className="text-[7px] text-cyan-300 uppercase mb-1">цепочка тушения</div>
            <div className="text-[6px] uppercase leading-relaxed">
              Машина→рукав: {tacticalChainGraph.vehicleToHoseLinks} | Рукав→ствол: {tacticalChainGraph.hoseToNozzleLinks}
            </div>
            <div className="text-[6px] uppercase leading-relaxed">
              Активные: {tacticalChainGraph.activeLinks} | Сухие: {tacticalChainGraph.dryLinks} | Разрывы: {tacticalChainGraph.brokenLinks}
            </div>
            <div className="text-[6px] uppercase leading-relaxed">
              Жесткая схема: {tacticalChainGraph.strictLinks} | Прямая машина→ствол: {tacticalChainGraph.vehicleToNozzleLinks}
            </div>
            <div className="text-[6px] text-gray-300 normal-case leading-relaxed mt-1">
              Голубая стрелка - подача воды, серая/оранжевая - без воды, красная - разрыв цепи.
            </div>
          </div>
        ) : null}

        {buHydraulicPanel ? (
          <div className="bg-[#1b1b1b] border-2 border-black px-2 py-2 text-[7px] text-cyan-100 w-[320px] max-w-full">
            <div className="text-[7px] text-cyan-300 uppercase mb-1">гидравлика {currentBuLabel}</div>
            <div className="text-[6px] uppercase leading-relaxed">
              Рукава: {buHydraulicPanel.hosesWet}/{buHydraulicPanel.hosesTotal} под давлением
            </div>
            <div className="text-[6px] uppercase leading-relaxed">
              Стволы: {buHydraulicPanel.nozzlesWet}/{buHydraulicPanel.nozzlesTotal} с подачей
            </div>
            <div className="text-[6px] uppercase leading-relaxed">
              Расход БУ: {buHydraulicPanel.flowLps.toFixed(1)} л/с
            </div>
            <div className="text-[6px] uppercase leading-relaxed">
              Вода БУ: {buHydraulicPanel.trackedVehicles > 0
                ? `${formatLiters(buHydraulicPanel.waterRemainingL)} / ${formatLiters(buHydraulicPanel.waterCapacityL)} л (${Math.round(buHydraulicPanel.waterPercent ?? 0)}%)`
                : 'нет данных'}
            </div>
            <div className="text-[6px] uppercase leading-relaxed">
              Пустые машины БУ: {buHydraulicPanel.emptyVehicles}
            </div>
          </div>
        ) : null}

        {showLatestHint && latestDeploymentHint ? (
          <PixelButton variant="default" className="text-[7px] px-3 py-1 max-w-full truncate">
            {latestDeploymentHint}
          </PixelButton>
        ) : null}

        {selectedDeployment ? (
          <div className="bg-[#1b1b1b] border-2 border-black px-2 py-2 text-[7px] text-gray-100 w-[320px] max-w-full">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="truncate uppercase" title={selectedDeployment.label}>{selectedDeployment.label}</span>
              <span className="text-gray-400">{selectedDeployment.resource_kind}</span>
            </div>
            <div className="text-[6px] text-gray-300 uppercase">
              Статус: {DEPLOYMENT_HINT_LABELS[selectedDeployment.status] ?? selectedDeployment.status.toLowerCase()} | Геометрия: {selectedDeployment.geometry_type}
            </div>
            {selectedDeploymentRuntimeDetails.length > 0 ? (
              <div className="mt-1 text-[6px] text-cyan-200 uppercase leading-relaxed">
                {selectedDeploymentRuntimeDetails.join(' | ')}
              </div>
            ) : null}
            {selectedDeploymentCharacteristics.length > 0 ? (
              <div className="mt-2 border border-black/60 bg-black/30 px-2 py-2">
                <div className="text-[6px] text-gray-300 uppercase mb-1">Характеристики</div>
                <div className="space-y-1 text-[6px] text-cyan-100 uppercase leading-relaxed">
                  {selectedDeploymentCharacteristics.map((row) => (
                    <div key={`${row.label}:${row.value}`} className="flex items-start justify-between gap-2">
                      <span className="text-gray-400 shrink-0">{row.label}</span>
                      <span className="text-right">{row.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {selectedDeployment.resource_kind === 'NOZZLE' ? (
              <div className="mt-2 border border-black/60 bg-black/30 px-2 py-2">
                <div className="text-[6px] text-gray-300 uppercase mb-1">Настройки ствола</div>
                <div className="text-[6px] text-gray-300 uppercase">Угол распыла: {Math.round(nozzleSettings.spray_angle)}°</div>
                <input
                  type="range"
                  min={0}
                  max={90}
                  step={1}
                  value={nozzleSettings.spray_angle}
                  disabled={!canAdjustSelectedNozzle || isApplyingNozzleSettings}
                  onChange={(event) => {
                    setNozzleSettings((previous) => ({ ...previous, spray_angle: Number(event.target.value) || 0 }));
                  }}
                  className="w-full"
                />
                <div className="text-[6px] text-gray-300 uppercase mt-1">Давление: {Math.round(nozzleSettings.pressure)}</div>
                <input
                  type="range"
                  min={20}
                  max={100}
                  step={1}
                  value={nozzleSettings.pressure}
                  disabled={!canAdjustSelectedNozzle || isApplyingNozzleSettings}
                  onChange={(event) => {
                    setNozzleSettings((previous) => ({ ...previous, pressure: Number(event.target.value) || 60 }));
                  }}
                  className="w-full"
                />
                <PixelButton
                  size="sm"
                  variant="green"
                  className="text-[6px] px-2 mt-2"
                  disabled={isApplyingNozzleSettings || !canAdjustSelectedNozzle}
                  onClick={() => {
                    void handleApplyNozzleSettings();
                  }}
                >
                  {isApplyingNozzleSettings ? 'ПРИМЕНЕНИЕ...' : 'ПРИМЕНИТЬ НАСТРОЙКИ'}
                </PixelButton>
                {!canAdjustSelectedNozzle ? (
                  <div className="mt-1 text-[6px] text-amber-300 uppercase leading-relaxed">
                    Только ответственный БУ может менять параметры ствола
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="mt-2 flex items-center gap-2">
              <PixelButton
                size="sm"
                variant="default"
                className="text-[6px] px-2"
                onClick={() => setSelectedDeploymentId(null)}
              >
                ЗАКРЫТЬ
              </PixelButton>
              {selectedDeploymentAction ? (
                <PixelButton
                  size="sm"
                  variant="green"
                  className="text-[6px] px-2"
                  disabled={isUpdatingDeployment}
                  onClick={() => {
                    void handleSelectedDeploymentAction();
                  }}
                >
                  {isUpdatingDeployment ? 'ОБНОВЛЕНИЕ...' : selectedDeploymentAction.label}
                </PixelButton>
              ) : null}
            </div>
          </div>
        ) : null}

        {placementError ? <div className="text-[8px] text-red-400 bg-black/60 px-2 py-1 border border-red-600">{placementError}</div> : null}
        {deploymentActionError ? (
          <div className="text-[8px] text-red-400 bg-black/60 px-2 py-1 border border-red-600">{deploymentActionError}</div>
        ) : null}
        </div>
      ) : null}

      <div className="absolute top-14 left-4 z-10 flex items-center gap-1">
        <PixelButton
          size="sm"
          variant={viewportMode === 'SIM_25D' ? 'active' : 'default'}
          onClick={() => {
            setViewportMode('SIM_25D');
          }}
        >
          2.5D
        </PixelButton>
        <PixelButton
          size="sm"
          variant={viewportMode === 'SIM_3D' ? 'active' : 'default'}
          onClick={() => {
            setViewportMode('SIM_3D');
          }}
        >
          3D
        </PixelButton>
        <PixelButton
          size="sm"
          variant={viewportMode === 'RETRO' ? 'active' : 'default'}
          onClick={() => {
            setViewportMode('RETRO');
          }}
        >
          RETRO
        </PixelButton>
        <PixelButton
          size="sm"
          variant={viewportMode === 'TACTICAL' ? 'active' : 'default'}
          onClick={() => {
            setViewportMode('TACTICAL');
          }}
        >
          КАРТА
        </PixelButton>
        {!isLessonLive ? (
          <PixelButton variant="default" size="sm" className="text-[6px] px-2">
            PRE-LESSON
          </PixelButton>
        ) : null}
        {!isReadOnly && isTacticalViewport && miniMapFitsLayout && !isLessonCompleted ? (
          <PixelButton
            size="sm"
            variant={shouldRenderMiniMap ? 'active' : 'default'}
            onClick={() => {
              setIsMiniMapVisible((previous) => !previous);
            }}
          >
            {shouldRenderMiniMap ? 'МИНИ ON' : 'МИНИ OFF'}
          </PixelButton>
        ) : null}
        {!isReadOnly && !isFullscreenSimulation ? (
          <>
            <PixelButton
              size="sm"
              onClick={() => {
                const canvas = canvasRef.current;
                if (!canvas) {
                  return;
                }
                zoomAtCanvasPoint(viewZoom / 1.2, { x: canvas.width / 2, y: canvas.height / 2 });
              }}
            >
              -
            </PixelButton>
            <PixelButton
              size="sm"
              onClick={() => {
                const canvas = canvasRef.current;
                if (!canvas) {
                  return;
                }
                zoomAtCanvasPoint(viewZoom * 1.2, { x: canvas.width / 2, y: canvas.height / 2 });
              }}
            >
              +
            </PixelButton>
            <PixelButton
              size="sm"
              onClick={() => {
                setViewZoom(1);
                setViewPan({ x: 0, y: 0 });
              }}
            >
              100%
            </PixelButton>
            {pendingPlacement ? (
              <PixelButton
                size="sm"
                onClick={() => {
                  clearPendingPlacement();
                  setHoverPlacementPoint(null);
                  setLinePlacementStart(null);
                }}
              >
                ОТМЕНА
              </PixelButton>
            ) : null}
          </>
        ) : !isReadOnly && isFullscreenSimulation && pendingPlacement ? (
          <PixelButton
            size="sm"
            onClick={() => {
              setViewportMode('TACTICAL');
            }}
          >
            НА КАРТУ
          </PixelButton>
        ) : null}
      </div>

      {viewportMode === 'SIM_25D' ? (
        <div className="absolute inset-3 top-16 border-2 border-black bg-[#151515] overflow-hidden">
          <PhysicsIsometricView
            bundle={bundle}
            title={`2.5D ${roleStatusLabel}`}
            className="w-full h-full border-0"
            mode="fullscreen"
            lod="fine"
            voxelStepM={0.85}
          />
          {pendingPlacement && !isReadOnly ? (
            <div className="absolute left-3 bottom-3 bg-black/70 border border-cyan-700 px-2 py-1 text-[7px] text-cyan-100 uppercase">
              Для размещения ресурса переключитесь в режим КАРТА
            </div>
          ) : null}
        </div>
      ) : viewportMode === 'SIM_3D' ? (
        <div className="absolute inset-3 top-16 border-2 border-black bg-[#0a0e18] overflow-hidden">
          <ThreeSimView bundle={bundle} className="w-full h-full" quality="medium" autoQuality />
          {pendingPlacement && !isReadOnly ? (
            <div className="absolute left-3 bottom-3 bg-black/70 border border-cyan-700 px-2 py-1 text-[7px] text-cyan-100 uppercase">
              Для размещения ресурса переключитесь в режим КАРТА
            </div>
          ) : null}
        </div>
      ) : viewportMode === 'RETRO' ? (
        <div className="absolute inset-3 top-16 border-2 border-black bg-[#0a0e18] overflow-hidden">
          <RetroSimView bundle={bundle} className="w-full h-full" quality="balanced" />
          {pendingPlacement && !isReadOnly ? (
            <div className="absolute left-3 bottom-3 bg-black/70 border border-cyan-700 px-2 py-1 text-[7px] text-cyan-100 uppercase">
              Для размещения ресурса переключитесь в режим КАРТА
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <div ref={canvasHolderRef} className="absolute inset-3 top-16 border-2 border-black bg-[#151515] p-2 overflow-hidden">
            <canvas
              ref={canvasRef}
              width={canvasSize.width}
              height={canvasSize.height}
              className={`w-full h-full border border-[#2f2f2f] bg-[#111] ${
                isReadOnly ? 'cursor-default' : isPanning ? 'cursor-grabbing' : pendingPlacement ? 'cursor-crosshair' : 'cursor-grab'
              }`}
              onMouseDown={handleCanvasMouseDown}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={endPan}
              onMouseLeave={() => {
                endPan();
                if (!pendingPlacement) {
                  setHoverPlacementPoint(null);
                }
              }}
              onWheel={handleCanvasWheel}
              onClick={(event) => {
                void handleCanvasClick(event);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
              }}
            />
          </div>

          {shouldRenderMiniMap ? (
            <div
              className="pointer-events-none absolute bottom-4 left-4 z-[6] max-w-[calc(100%-2rem)]"
              style={{ width: `${miniMapPanelWidth}px` }}
            >
              <PhysicsIsometricView
                bundle={bundle}
                title="2.5D"
                className=""
                mode="panel"
                lod="medium"
                voxelStepM={1.6}
              />
            </div>
          ) : null}
        </>
      )}

      {!isReadOnly ? (
        <div className="absolute bottom-4 right-4 z-10 w-[360px] max-w-[calc(100%-2rem)]">
          <RadioConsole activeRole={activeRole} />
        </div>
      ) : null}
    </div>
  );
};
