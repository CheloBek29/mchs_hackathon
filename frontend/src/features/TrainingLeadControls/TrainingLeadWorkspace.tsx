import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiClient } from '../../shared/api/client';
import type {
  ResourceDeploymentDto,
  SessionStateBundleDto,
  SimulationSessionDto,
  VehicleDictionaryDto,
  WeatherSnapshotDto,
} from '../../shared/api/types';
import { PhysicsIsometricView } from '../../shared/visualization/PhysicsIsometricView';
import { PixelButton } from '../../shared/ui/PixelButton';
import { PixelInput } from '../../shared/ui/PixelInput';
import { StatusIndicator } from '../../shared/ui/StatusIndicator';
import { useAuthStore, type UserProfile } from '../../store/useAuthStore';
import { useDispatcherStore } from '../../store/useDispatcherStore';
import { useRealtimeStore } from '../../store/useRealtimeStore';
import { useTacticalStore } from '../../store/useTacticalStore';
import { TrainingCompletionReport } from './TrainingCompletionReport';

type Point = { x: number; y: number };
type GeometryType = 'POINT' | 'LINESTRING' | 'POLYGON';
type SceneKind =
  | 'WALL'
  | 'EXIT'
  | 'STAIR'
  | 'ROOM'
  | 'DOOR'
  | 'FIRE_SOURCE'
  | 'SMOKE_ZONE'
  | 'HYDRANT'
  | 'WATER_SOURCE';

type SiteEntityKind = 'BUILDING_CONTOUR' | 'ROAD_ACCESS' | 'HYDRANT' | 'WATER_SOURCE';

type SceneObject = {
  id: string;
  kind: SceneKind;
  geometry_type: GeometryType;
  geometry: {
    x?: number;
    y?: number;
    points?: Point[];
  };
  label?: string;
  props?: Record<string, unknown>;
  created_at?: string;
};

type SiteEntity = {
  id: string;
  kind: SiteEntityKind;
  geometry_type: GeometryType;
  geometry: {
    x?: number;
    y?: number;
    points?: Point[];
  };
};

type SceneFloor = {
  floor_id: string;
  elevation_m: number;
  objects: SceneObject[];
};

type SceneAddress = {
  address_text: string;
  karta01_url: string;
  radius_m: number;
  center: { lat: number; lon: number } | null;
  generated_at: string;
  geocode_provider?: string;
  overpass_provider?: string | null;
  resolution_mode?: string;
  fallback_used?: boolean;
  warnings?: string[];
};

type WorldViewport = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
};

type TrainingLeadSceneDraft = {
  version: number;
  address: SceneAddress;
  site_entities: SiteEntity[];
  floors: SceneFloor[];
  active_floor_id: string;
  scale_m_per_grid: number;
  updated_at: string;
};

type ToolMode =
  | 'NONE'
  | 'WALL'
  | 'EXIT'
  | 'STAIR'
  | 'ROOM'
  | 'DOOR'
  | 'FIRE_SOURCE'
  | 'SMOKE_ZONE'
  | 'HYDRANT'
  | 'WATER_SOURCE'
  | 'ERASE';

type AddressDraft = {
  addressText: string;
  karta01Url: string;
  radiusM: number;
};

type WeatherDraft = {
  wind_speed: number;
  wind_dir: number;
  temperature: number;
};

type VehicleSpecDraft = {
  crew_size: number;
  water_capacity: number;
  foam_capacity: number;
  hose_length: number;
};

type FirePropsDraft = {
  fireAreaM2: number;
  spreadSpeedMMin: number;
  spreadAzimuth: number;
  smokeDensity: number;
  fireRank: number;
  firePower: number;
  isActive: boolean;
};

type ViewStatePan = {
  x: number;
  y: number;
};

type ActiveVehicleDeployment = {
  deploymentId: string;
  vehicleId: number;
  label: string;
  status: ResourceDeploymentDto['status'];
  geometry_type: ResourceDeploymentDto['geometry_type'];
  geometry: ResourceDeploymentDto['geometry'];
  resource_data: ResourceDeploymentDto['resource_data'];
  created_at: string;
};

type SidebarSectionKey =
  | 'session'
  | 'lesson'
  | 'vehicle'
  | 'address'
  | 'floors'
  | 'object'
  | 'conditions'
  | 'events';

const INITIAL_SIDEBAR_SECTIONS: Record<SidebarSectionKey, boolean> = {
  session: true,
  lesson: true,
  vehicle: false,
  address: false,
  floors: true,
  object: false,
  conditions: false,
  events: true,
};

const DEFAULT_WORLD_WIDTH_M = 240;
const DEFAULT_WORLD_HEIGHT_M = 160;
const MIN_VIEWPORT_WIDTH_M = 120;
const MIN_VIEWPORT_HEIGHT_M = 90;
const VIEWPORT_MARGIN_FACTOR = 0.18;
const VIEWPORT_MIN_MARGIN_M = 18;
const VIEW_MIN_ZOOM = 0.35;
const VIEW_MAX_ZOOM = 6;
const CANVAS_PADDING_PX = 26;

const FIELD_CLASS =
  'w-full h-7 bg-[#454545] border-2 border-black px-2 text-[8px] text-white outline-none focus:border-gray-400';

const TOOL_LABELS: Record<ToolMode, string> = {
  NONE: 'Камера',
  WALL: 'Стена',
  EXIT: 'Выход',
  STAIR: 'Лестница',
  ROOM: 'Комната',
  DOOR: 'Дверь',
  FIRE_SOURCE: 'Очаг',
  SMOKE_ZONE: 'Зона дыма',
  HYDRANT: 'Гидрант',
  WATER_SOURCE: 'Водоисточник',
  ERASE: 'Удалить',
};

const TOOL_ICONS: Record<ToolMode, string> = {
  NONE: 'CAM',
  WALL: 'W',
  EXIT: 'EX',
  STAIR: 'ST',
  ROOM: 'RM',
  DOOR: 'DR',
  FIRE_SOURCE: 'F',
  SMOKE_ZONE: 'SM',
  HYDRANT: 'HY',
  WATER_SOURCE: 'WT',
  ERASE: 'DEL',
};

const QUICK_TOOL_ORDER: ToolMode[] = [
  'NONE',
  'WALL',
  'ROOM',
  'DOOR',
  'EXIT',
  'STAIR',
  'FIRE_SOURCE',
  'SMOKE_ZONE',
  'HYDRANT',
  'WATER_SOURCE',
  'ERASE',
];

const KIND_COLORS: Record<SceneKind, string> = {
  WALL: '#f8fafc',
  EXIT: '#22c55e',
  STAIR: '#60a5fa',
  ROOM: '#f59e0b',
  DOOR: '#93c5fd',
  FIRE_SOURCE: '#f43f5e',
  SMOKE_ZONE: '#9ca3af',
  HYDRANT: '#06b6d4',
  WATER_SOURCE: '#0ea5e9',
};

const KIND_LABELS: Record<SceneKind, string> = {
  WALL: 'Стена',
  EXIT: 'Выход',
  STAIR: 'Лестница',
  ROOM: 'Комната',
  DOOR: 'Дверь',
  FIRE_SOURCE: 'Очаг пожара',
  SMOKE_ZONE: 'Зона дыма',
  HYDRANT: 'Гидрант',
  WATER_SOURCE: 'Водоисточник',
};

const SITE_ENTITY_LABELS: Record<SiteEntityKind, string> = {
  BUILDING_CONTOUR: 'Контур здания',
  ROAD_ACCESS: 'Дорога',
  HYDRANT: 'Гидрант',
  WATER_SOURCE: 'Водоисточник',
};

const VEHICLE_SPEC_DEFAULTS: Record<VehicleDictionaryDto['type'], VehicleSpecDraft> = {
  AC: {
    crew_size: 6,
    water_capacity: 3200,
    foam_capacity: 200,
    hose_length: 360,
  },
  AL: {
    crew_size: 3,
    water_capacity: 1000,
    foam_capacity: 100,
    hose_length: 180,
  },
  ASA: {
    crew_size: 4,
    water_capacity: 1000,
    foam_capacity: 120,
    hose_length: 240,
  },
};

const normalizeFloorId = (value: string): string => {
  const cleaned = value.trim().toUpperCase();
  if (!cleaned) {
    return 'F1';
  }
  return cleaned;
};

const DEFAULT_FIRE_PROPS_DRAFT: FirePropsDraft = {
  fireAreaM2: 32,
  spreadSpeedMMin: 3,
  spreadAzimuth: 0,
  smokeDensity: 0.65,
  fireRank: 2,
  firePower: 1,
  isActive: true,
};

const numberOrFallback = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const positiveNumberOrFallback = (value: unknown, fallback: number): number => {
  const parsed = numberOrFallback(value, fallback);
  return parsed > 0 ? parsed : fallback;
};

const boolOrFallback = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }
  return fallback;
};

const toPoint = (raw: unknown): Point | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const x = numberOrFallback(value.x, Number.NaN);
  const y = numberOrFallback(value.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return { x, y };
};

const parseGeometry = (raw: unknown): { x?: number; y?: number; points?: Point[] } => {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const value = raw as Record<string, unknown>;
  const maybePoint = toPoint(value);
  const pointsRaw = value.points;
  if (Array.isArray(pointsRaw)) {
    const points = pointsRaw.map((entry) => toPoint(entry)).filter((entry): entry is Point => entry !== null);
    return { points };
  }
  if (maybePoint) {
    return { x: maybePoint.x, y: maybePoint.y };
  }
  return {};
};

const parseSceneObject = (raw: unknown): SceneObject | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const id = String(value.id ?? '').trim();
  const kind = String(value.kind ?? '').trim().toUpperCase() as SceneKind;
  const geometryType = String(value.geometry_type ?? 'POINT').trim().toUpperCase() as GeometryType;
  if (!id || !kind || !['POINT', 'LINESTRING', 'POLYGON'].includes(geometryType)) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(KIND_COLORS, kind)) {
    return null;
  }

  return {
    id,
    kind,
    geometry_type: geometryType,
    geometry: parseGeometry(value.geometry),
    label: typeof value.label === 'string' ? value.label : undefined,
    props: value.props && typeof value.props === 'object' ? (value.props as Record<string, unknown>) : undefined,
    created_at: typeof value.created_at === 'string' ? value.created_at : undefined,
  };
};

const parseSiteEntity = (raw: unknown): SiteEntity | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const id = String(value.id ?? '').trim();
  const kind = String(value.kind ?? '').trim().toUpperCase() as SiteEntityKind;
  const geometryType = String(value.geometry_type ?? 'POINT').trim().toUpperCase() as GeometryType;
  if (!id || !['POINT', 'LINESTRING', 'POLYGON'].includes(geometryType)) {
    return null;
  }
  if (!['BUILDING_CONTOUR', 'ROAD_ACCESS', 'HYDRANT', 'WATER_SOURCE'].includes(kind)) {
    return null;
  }
  return {
    id,
    kind,
    geometry_type: geometryType,
    geometry: parseGeometry(value.geometry),
  };
};

const parseSceneDraft = (bundle: SessionStateBundleDto | null): TrainingLeadSceneDraft => {
  const raw = bundle?.snapshot?.snapshot_data?.training_lead_scene;
  const draft = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const floorsRaw = Array.isArray(draft.floors) ? draft.floors : [];
  const floors: SceneFloor[] = floorsRaw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const floorValue = entry as Record<string, unknown>;
      const floorId = normalizeFloorId(String(floorValue.floor_id ?? 'F1'));
      const elevationM = numberOrFallback(floorValue.elevation_m, 0);
      const objects = Array.isArray(floorValue.objects)
        ? floorValue.objects
            .map((objectRaw) => parseSceneObject(objectRaw))
            .filter((item): item is SceneObject => item !== null)
        : [];
      return { floor_id: floorId, elevation_m: elevationM, objects };
    })
    .filter((item): item is SceneFloor => item !== null);

  const uniqueFloors = floors.length > 0 ? floors : [{ floor_id: 'F1', elevation_m: 0, objects: [] }];

  const addressRaw = draft.address && typeof draft.address === 'object' ? (draft.address as Record<string, unknown>) : {};
  const centerRaw = addressRaw.center && typeof addressRaw.center === 'object' ? (addressRaw.center as Record<string, unknown>) : null;
  const activeFloorId = normalizeFloorId(String(draft.active_floor_id ?? uniqueFloors[0].floor_id));

  return {
    version: numberOrFallback(draft.version, 1),
    address: {
      address_text: String(addressRaw.address_text ?? ''),
      karta01_url: String(addressRaw.karta01_url ?? ''),
      radius_m: numberOrFallback(addressRaw.radius_m, 200),
      center: centerRaw
        ? {
            lat: numberOrFallback(centerRaw.lat, 55.751244),
            lon: numberOrFallback(centerRaw.lon, 37.618423),
          }
        : null,
      generated_at: String(addressRaw.generated_at ?? ''),
      geocode_provider: String(addressRaw.geocode_provider ?? ''),
      overpass_provider:
        addressRaw.overpass_provider === null || typeof addressRaw.overpass_provider === 'string'
          ? (addressRaw.overpass_provider as string | null)
          : null,
      resolution_mode: String(addressRaw.resolution_mode ?? ''),
      fallback_used: Boolean(addressRaw.fallback_used),
      warnings: Array.isArray(addressRaw.warnings)
        ? addressRaw.warnings.filter((entry): entry is string => typeof entry === 'string')
        : [],
    },
    site_entities: Array.isArray(draft.site_entities)
      ? draft.site_entities.map((entry) => parseSiteEntity(entry)).filter((item): item is SiteEntity => item !== null)
      : [],
    floors: uniqueFloors,
    active_floor_id: activeFloorId,
    scale_m_per_grid: Math.max(0.5, numberOrFallback(draft.scale_m_per_grid, 2)),
    updated_at: String(draft.updated_at ?? ''),
  };
};

const pointDistance = (a: Point, b: Point): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
};

const distancePointToSegment = (point: Point, a: Point, b: Point): number => {
  const abX = b.x - a.x;
  const abY = b.y - a.y;
  const apX = point.x - a.x;
  const apY = point.y - a.y;
  const abLenSq = abX * abX + abY * abY;
  if (abLenSq <= 1e-6) {
    return pointDistance(point, a);
  }
  const t = Math.max(0, Math.min(1, (apX * abX + apY * abY) / abLenSq));
  const proj = { x: a.x + abX * t, y: a.y + abY * t };
  return pointDistance(point, proj);
};

const getObjectDistance = (point: Point, object: SceneObject): number => {
  if (object.geometry_type === 'POINT') {
    if (typeof object.geometry.x !== 'number' || typeof object.geometry.y !== 'number') {
      return Number.POSITIVE_INFINITY;
    }
    return pointDistance(point, { x: object.geometry.x, y: object.geometry.y });
  }

  const points = object.geometry.points ?? [];
  if (points.length < 2) {
    return Number.POSITIVE_INFINITY;
  }

  if (object.geometry_type === 'LINESTRING') {
    let minDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < points.length - 1; index += 1) {
      minDistance = Math.min(minDistance, distancePointToSegment(point, points[index], points[index + 1]));
    }
    return minDistance;
  }

  let minDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    minDistance = Math.min(minDistance, distancePointToSegment(point, a, b));
  }
  return minDistance;
};

const nearestObject = (point: Point, objects: SceneObject[], maxDistance: number): SceneObject | null => {
  let best: SceneObject | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const object of objects) {
    const distance = getObjectDistance(point, object);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = object;
    }
  }
  if (bestDistance > maxDistance) {
    return null;
  }
  return best;
};

const buildRectanglePolygon = (a: Point, b: Point): Point[] => {
  return [
    { x: a.x, y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y },
    { x: a.x, y: b.y },
  ];
};

const translateGeometry = (
  geometryType: GeometryType,
  geometry: SceneObject['geometry'],
  dx: number,
  dy: number,
): SceneObject['geometry'] => {
  if (geometryType === 'POINT') {
    if (typeof geometry.x !== 'number' || typeof geometry.y !== 'number') {
      return geometry;
    }
    return { x: geometry.x + dx, y: geometry.y + dy };
  }

  const points = geometry.points ?? [];
  return {
    points: points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
  };
};

const updateGeometryVertex = (
  geometryType: GeometryType,
  geometry: SceneObject['geometry'],
  vertexIndex: number,
  nextPoint: Point,
): SceneObject['geometry'] => {
  if (geometryType === 'POINT') {
    return { x: nextPoint.x, y: nextPoint.y };
  }
  const points = [...(geometry.points ?? [])];
  if (vertexIndex < 0 || vertexIndex >= points.length) {
    return geometry;
  }
  points[vertexIndex] = nextPoint;
  return { points };
};

const offsetGeometry = (
  geometryType: GeometryType,
  geometry: SceneObject['geometry'],
  offset: Point,
): SceneObject['geometry'] => {
  return translateGeometry(geometryType, geometry, offset.x, offset.y);
};

const findNearestVertex = (
  point: Point,
  object: SceneObject,
  maxDistance: number,
): { index: number; point: Point } | null => {
  if (object.geometry_type === 'POINT') {
    if (typeof object.geometry.x === 'number' && typeof object.geometry.y === 'number') {
      const vertexPoint = { x: object.geometry.x, y: object.geometry.y };
      const distance = pointDistance(point, vertexPoint);
      if (distance <= maxDistance) {
        return { index: 0, point: vertexPoint };
      }
    }
    return null;
  }

  const points = object.geometry.points ?? [];
  if (points.length === 0) {
    return null;
  }

  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const distance = pointDistance(point, points[index]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  if (bestIndex < 0 || bestDistance > maxDistance) {
    return null;
  }

  return { index: bestIndex, point: points[bestIndex] };
};

const weatherFromBundle = (bundle: SessionStateBundleDto | null): WeatherDraft => {
  const weather = bundle?.weather as WeatherSnapshotDto | null;
  if (!weather) {
    return { wind_speed: 5, wind_dir: 90, temperature: 20 };
  }
  return {
    wind_speed: weather.wind_speed,
    wind_dir: weather.wind_dir,
    temperature: weather.temperature,
  };
};

const worldToCanvas = (point: Point, width: number, height: number, viewport: WorldViewport): Point => {
  const usableWidth = width - CANVAS_PADDING_PX * 2;
  const usableHeight = height - CANVAS_PADDING_PX * 2;
  const safeWidth = Math.max(1e-6, viewport.width);
  const safeHeight = Math.max(1e-6, viewport.height);
  return {
    x: CANVAS_PADDING_PX + ((point.x - viewport.minX) / safeWidth) * usableWidth,
    y: CANVAS_PADDING_PX + ((viewport.maxY - point.y) / safeHeight) * usableHeight,
  };
};

const canvasToWorld = (point: Point, width: number, height: number, viewport: WorldViewport): Point => {
  const usableWidth = width - CANVAS_PADDING_PX * 2;
  const usableHeight = height - CANVAS_PADDING_PX * 2;
  const normalizedX = (point.x - CANVAS_PADDING_PX) / Math.max(1, usableWidth);
  const normalizedY = (point.y - CANVAS_PADDING_PX) / Math.max(1, usableHeight);

  return {
    x: viewport.minX + normalizedX * viewport.width,
    y: viewport.maxY - normalizedY * viewport.height,
  };
};

const collectGeometryPoints = (
  geometryType: GeometryType,
  geometry: SceneObject['geometry'] | SiteEntity['geometry'],
): Point[] => {
  if (geometryType === 'POINT') {
    if (typeof geometry.x === 'number' && typeof geometry.y === 'number') {
      return [{ x: geometry.x, y: geometry.y }];
    }
    return [];
  }
  return geometry.points ?? [];
};

const collectWorldPoints = (
  siteEntities: SiteEntity[],
  objects: SceneObject[],
  pendingPoint: Point | null,
  hoverPoint: Point | null,
): Point[] => {
  const points: Point[] = [];

  for (const entity of siteEntities) {
    points.push(...collectGeometryPoints(entity.geometry_type, entity.geometry));
  }
  for (const object of objects) {
    points.push(...collectGeometryPoints(object.geometry_type, object.geometry));
  }
  if (pendingPoint) {
    points.push(pendingPoint);
  }
  if (hoverPoint) {
    points.push(hoverPoint);
  }

  return points;
};

const buildWorldViewport = (points: Point[]): WorldViewport => {
  if (points.length === 0) {
    const halfWidth = DEFAULT_WORLD_WIDTH_M / 2;
    const halfHeight = DEFAULT_WORLD_HEIGHT_M / 2;
    return {
      minX: -halfWidth,
      maxX: halfWidth,
      minY: -halfHeight,
      maxY: halfHeight,
      width: DEFAULT_WORLD_WIDTH_M,
      height: DEFAULT_WORLD_HEIGHT_M,
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  const rawWidth = Math.max(1, maxX - minX);
  const rawHeight = Math.max(1, maxY - minY);
  const margin = Math.max(VIEWPORT_MIN_MARGIN_M, Math.max(rawWidth, rawHeight) * VIEWPORT_MARGIN_FACTOR);

  let expandedMinX = minX - margin;
  let expandedMaxX = maxX + margin;
  let expandedMinY = minY - margin;
  let expandedMaxY = maxY + margin;

  const expandedWidth = expandedMaxX - expandedMinX;
  if (expandedWidth < MIN_VIEWPORT_WIDTH_M) {
    const delta = (MIN_VIEWPORT_WIDTH_M - expandedWidth) / 2;
    expandedMinX -= delta;
    expandedMaxX += delta;
  }

  const expandedHeight = expandedMaxY - expandedMinY;
  if (expandedHeight < MIN_VIEWPORT_HEIGHT_M) {
    const delta = (MIN_VIEWPORT_HEIGHT_M - expandedHeight) / 2;
    expandedMinY -= delta;
    expandedMaxY += delta;
  }

  return {
    minX: expandedMinX,
    maxX: expandedMaxX,
    minY: expandedMinY,
    maxY: expandedMaxY,
    width: expandedMaxX - expandedMinX,
    height: expandedMaxY - expandedMinY,
  };
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

  let bestLength = base;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const multiplier of multipliers) {
    const candidate = base * multiplier;
    const candidatePx = candidate * pixelsPerMeter;
    if (candidatePx >= minPx && candidatePx <= maxPx) {
      return candidate;
    }
    const distance = Math.abs(candidatePx - targetPx);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestLength = candidate;
    }
  }

  return Math.max(0.5, bestLength);
};

const formatScaleDistance = (meters: number): string => {
  if (meters >= 1000) {
    const kilometers = meters / 1000;
    return Number.isInteger(kilometers) ? `${kilometers} км` : `${kilometers.toFixed(1)} км`;
  }
  return Number.isInteger(meters) ? `${meters} м` : `${meters.toFixed(1)} м`;
};

const clampValue = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const snapPointToGrid = (point: Point, step: number): Point => {
  const safeStep = Math.max(0.0001, step);
  return {
    x: Math.round(point.x / safeStep) * safeStep,
    y: Math.round(point.y / safeStep) * safeStep,
  };
};

const lockPointToAngle = (anchor: Point, target: Point, stepDegrees: number): Point => {
  const dx = target.x - anchor.x;
  const dy = target.y - anchor.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length <= 1e-6) {
    return target;
  }

  const stepRadians = (Math.PI / 180) * Math.max(1, stepDegrees);
  const angle = Math.atan2(dy, dx);
  const lockedAngle = Math.round(angle / stepRadians) * stepRadians;

  return {
    x: anchor.x + Math.cos(lockedAngle) * length,
    y: anchor.y + Math.sin(lockedAngle) * length,
  };
};

const applyViewTransform = (point: Point, width: number, height: number, zoom: number, pan: ViewStatePan): Point => {
  const centerX = width / 2;
  const centerY = height / 2;
  return {
    x: centerX + (point.x - centerX) * zoom + pan.x,
    y: centerY + (point.y - centerY) * zoom + pan.y,
  };
};

const unapplyViewTransform = (point: Point, width: number, height: number, zoom: number, pan: ViewStatePan): Point => {
  const centerX = width / 2;
  const centerY = height / 2;
  const safeZoom = Math.max(1e-6, zoom);
  return {
    x: centerX + (point.x - centerX - pan.x) / safeZoom,
    y: centerY + (point.y - centerY - pan.y) / safeZoom,
  };
};

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
};

type DragPreviewState = {
  objectId: string;
  geometry: SceneObject['geometry'];
};

type CanvasInteraction =
  | {
      type: 'pan';
      startCanvas: Point;
      basePan: ViewStatePan;
      moved: boolean;
    }
  | {
      type: 'move-object';
      objectId: string;
      floorId: string;
      kind: SceneKind;
      geometryType: GeometryType;
      label: string;
      props: Record<string, unknown>;
      startCanvas: Point;
      startWorld: Point;
      originalGeometry: SceneObject['geometry'];
      moved: boolean;
    }
  | {
      type: 'move-vertex';
      objectId: string;
      floorId: string;
      kind: SceneKind;
      geometryType: GeometryType;
      label: string;
      props: Record<string, unknown>;
      startCanvas: Point;
      vertexIndex: number;
      originalGeometry: SceneObject['geometry'];
      moved: boolean;
    };

type SceneHistoryEntry = {
  id: string;
  floorId: string;
  before: SceneObject | null;
  after: SceneObject | null;
  description: string;
  createdAt: string;
};

const MAX_HISTORY_ENTRIES = 80;

const cloneSceneObject = (object: SceneObject): SceneObject => {
  return JSON.parse(JSON.stringify(object)) as SceneObject;
};

const makeSceneObjectId = (): string => {
  return `obj_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
};

const findNearestSegment = (
  point: Point,
  points: Point[],
  closed: boolean,
  maxDistance: number,
): { segmentIndex: number; distance: number } | null => {
  if (points.length < 2) {
    return null;
  }

  const segmentCount = closed ? points.length : points.length - 1;
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const a = points[segmentIndex];
    const b = points[(segmentIndex + 1) % points.length];
    const distance = distancePointToSegment(point, a, b);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = segmentIndex;
    }
  }

  if (bestIndex < 0 || bestDistance > maxDistance) {
    return null;
  }

  return {
    segmentIndex: bestIndex,
    distance: bestDistance,
  };
};

const insertPointIntoSegment = (
  points: Point[],
  segmentIndex: number,
  point: Point,
  closed: boolean,
): { points: Point[]; insertIndex: number } => {
  if (points.length === 0) {
    return { points: [point], insertIndex: 0 };
  }

  const insertIndex = closed && segmentIndex === points.length - 1 ? points.length : segmentIndex + 1;
  const nextPoints = [...points.slice(0, insertIndex), point, ...points.slice(insertIndex)];
  return {
    points: nextPoints,
    insertIndex,
  };
};

const buildVehicleSpecDraft = (vehicle: VehicleDictionaryDto): VehicleSpecDraft => {
  const defaults = VEHICLE_SPEC_DEFAULTS[vehicle.type];
  return {
    crew_size: positiveNumberOrFallback(vehicle.crew_size, defaults.crew_size),
    water_capacity: positiveNumberOrFallback(vehicle.water_capacity, defaults.water_capacity),
    foam_capacity: positiveNumberOrFallback(vehicle.foam_capacity, defaults.foam_capacity),
    hose_length: positiveNumberOrFallback(vehicle.hose_length, defaults.hose_length),
  };
};

export const TrainingLeadWorkspace = () => {
  const { user, setUser } = useAuthStore();
  const realtimeBundle = useRealtimeStore((state) => state.bundle);
  const realtimeSessionId = useRealtimeStore((state) => state.sessionId);
  const connectRealtime = useRealtimeStore((state) => state.connect);
  const sendRealtimeCommand = useRealtimeStore((state) => state.sendCommand);
  const showBanner = useDispatcherStore((state) => state.showBanner);

  const [sessions, setSessions] = useState<SimulationSessionDto[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [bundle, setBundle] = useState<SessionStateBundleDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [vehicleDictionary, setVehicleDictionary] = useState<VehicleDictionaryDto[]>([]);
  const [selectedVehicleConfigId, setSelectedVehicleConfigId] = useState<number | null>(null);
  const [vehicleSpecDraft, setVehicleSpecDraft] = useState<VehicleSpecDraft>({
    crew_size: 6,
    water_capacity: 3200,
    foam_capacity: 200,
    hose_length: 360,
  });
  const [lessonTimeLimitMinDraft, setLessonTimeLimitMinDraft] = useState(30);
  const [lessonStartHourDraft, setLessonStartHourDraft] = useState(10);
  const [lessonStartMinuteDraft, setLessonStartMinuteDraft] = useState(0);
  const [timeMultiplierDraft, setTimeMultiplierDraft] = useState(1);

  const [addressDraft, setAddressDraft] = useState<AddressDraft>({
    addressText: '',
    karta01Url: '',
    radiusM: 200,
  });
  const [weatherDraft, setWeatherDraft] = useState<WeatherDraft>({ wind_speed: 5, wind_dir: 90, temperature: 20 });
  const maxHoseLength = useTacticalStore((state) => state.maxHoseLength);
  const setMaxHoseLength = useTacticalStore((state) => state.setMaxHoseLength);

  const [activeFloorIdDraft, setActiveFloorIdDraft] = useState('F1');
  const [newFloorId, setNewFloorId] = useState('F2');
  const [toolMode, setToolMode] = useState<ToolMode>('NONE');
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [selectedVertexIndex, setSelectedVertexIndex] = useState<number | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [lockWallAngle, setLockWallAngle] = useState(true);
  const [selectedLabelDraft, setSelectedLabelDraft] = useState('');
  const [selectedKindDraft, setSelectedKindDraft] = useState<SceneKind>('WALL');
  const [selectedPropsDraft, setSelectedPropsDraft] = useState('{}');
  const [selectedPropsError, setSelectedPropsError] = useState('');
  const [firePropsDraft, setFirePropsDraft] = useState<FirePropsDraft>(DEFAULT_FIRE_PROPS_DRAFT);
  const [hydrantFlowDraft, setHydrantFlowDraft] = useState(25);
  const [hydrantPressureDraft, setHydrantPressureDraft] = useState(6);
  const [hydrantOperationalDraft, setHydrantOperationalDraft] = useState(true);
  const [selectedVehicleFailureId, setSelectedVehicleFailureId] = useState('');
  const [selectedVehicleRepairId, setSelectedVehicleRepairId] = useState('');
  const [insertVertexMode, setInsertVertexMode] = useState(false);
  const [undoStack, setUndoStack] = useState<SceneHistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<SceneHistoryEntry[]>([]);
  const [pendingPoint, setPendingPoint] = useState<Point | null>(null);
  const [hoverPoint, setHoverPoint] = useState<Point | null>(null);
  const [viewZoom, setViewZoom] = useState(1);
  const [viewPan, setViewPan] = useState<ViewStatePan>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [isObjectDragging, setIsObjectDragging] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 960, height: 560 });
  const [sidebarSectionsOpen, setSidebarSectionsOpen] = useState<Record<SidebarSectionKey, boolean>>(
    INITIAL_SIDEBAR_SECTIONS,
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasHolderRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<CanvasInteraction | null>(null);
  const suppressNextClickRef = useRef(false);

  const scene = useMemo(() => parseSceneDraft(bundle), [bundle]);
  const activeFloor = useMemo(
    () => scene.floors.find((floor) => floor.floor_id === scene.active_floor_id) ?? scene.floors[0],
    [scene],
  );

  const selectedObject = useMemo(
    () => (selectedObjectId ? activeFloor.objects.find((object) => object.id === selectedObjectId) ?? null : null),
    [activeFloor.objects, selectedObjectId],
  );

  const isFireObjectDraft = selectedKindDraft === 'FIRE_SOURCE' || selectedKindDraft === 'SMOKE_ZONE';

  const canInsertVertex = useMemo(
    () => toolMode === 'NONE' && Boolean(selectedObject && selectedObject.geometry_type !== 'POINT'),
    [selectedObject, toolMode],
  );

  const worldViewport = useMemo(
    () => buildWorldViewport(collectWorldPoints(scene.site_entities, activeFloor.objects, pendingPoint, hoverPoint)),
    [scene.site_entities, activeFloor.objects, pendingPoint, hoverPoint],
  );

  const displayGridStepM = useMemo(
    () => Math.max(2, Math.round(scene.scale_m_per_grid * 5)),
    [scene.scale_m_per_grid],
  );

  const siteEntityCounts = useMemo(() => {
    const counts: Record<SiteEntityKind, number> = {
      BUILDING_CONTOUR: 0,
      ROAD_ACCESS: 0,
      HYDRANT: 0,
      WATER_SOURCE: 0,
    };

    scene.site_entities.forEach((entity) => {
      counts[entity.kind] += 1;
    });

    return counts;
  }, [scene.site_entities]);

  const savedSceneMeta = useMemo(() => {
    const snapshotData =
      bundle?.snapshot?.snapshot_data && typeof bundle.snapshot.snapshot_data === 'object'
        ? (bundle.snapshot.snapshot_data as Record<string, unknown>)
        : null;

    const checkpointsRaw = snapshotData?.training_lead_scene_checkpoints;
    const checkpointCount = Array.isArray(checkpointsRaw) ? checkpointsRaw.length : 0;

    const lastSavedAtRaw = snapshotData?.training_lead_scene_last_saved_at;
    const lastSavedAt = typeof lastSavedAtRaw === 'string' ? lastSavedAtRaw : '';
    const lastSavedByRaw = snapshotData?.training_lead_scene_last_saved_by;
    const lastSavedBy = typeof lastSavedByRaw === 'string' ? lastSavedByRaw : '';

    return {
      count: checkpointCount,
      lastSavedAt,
      lastSavedBy,
    };
  }, [bundle?.snapshot?.snapshot_data]);

  const snapshotData = useMemo(() => {
    if (bundle?.snapshot?.snapshot_data && typeof bundle.snapshot.snapshot_data === 'object') {
      return bundle.snapshot.snapshot_data as Record<string, unknown>;
    }
    return null;
  }, [bundle?.snapshot?.snapshot_data]);

  const isLessonStarted = useMemo(() => {
    const bySessionStatus = bundle?.session?.status === 'IN_PROGRESS';
    const lessonStateRaw = snapshotData?.training_lesson;
    const lessonState = lessonStateRaw && typeof lessonStateRaw === 'object' ? (lessonStateRaw as Record<string, unknown>) : null;
    const bySnapshotState = lessonState?.status === 'IN_PROGRESS';
    return Boolean(bySessionStatus || bySnapshotState);
  }, [bundle?.session?.status, snapshotData]);

  const isLessonCompleted = useMemo(() => {
    const bySessionStatus = bundle?.session?.status === 'COMPLETED';
    const lessonStateRaw = snapshotData?.training_lesson;
    const lessonState = lessonStateRaw && typeof lessonStateRaw === 'object' ? (lessonStateRaw as Record<string, unknown>) : null;
    const bySnapshotState = lessonState?.status === 'COMPLETED';
    return Boolean(bySessionStatus || bySnapshotState);
  }, [bundle?.session?.status, snapshotData]);

  const selectedHydrantObject = useMemo(() => {
    if (!selectedObject || selectedObject.kind !== 'HYDRANT') {
      return null;
    }
    return selectedObject;
  }, [selectedObject]);

  const selectedVehicleConfig = useMemo(() => {
    if (selectedVehicleConfigId === null) {
      return null;
    }
    return vehicleDictionary.find((vehicle) => vehicle.id === selectedVehicleConfigId) ?? null;
  }, [selectedVehicleConfigId, vehicleDictionary]);

  const activeVehicleDeployments = useMemo<ActiveVehicleDeployment[]>(() => {
    const deployments = bundle?.resource_deployments ?? [];
    const latestByVehicle = new Map<number, ResourceDeploymentDto>();

    deployments.forEach((deployment) => {
      if (deployment.resource_kind !== 'VEHICLE' || !deployment.vehicle_dictionary_id) {
        return;
      }
      const current = latestByVehicle.get(deployment.vehicle_dictionary_id);
      if (!current || new Date(deployment.created_at).getTime() >= new Date(current.created_at).getTime()) {
        latestByVehicle.set(deployment.vehicle_dictionary_id, deployment);
      }
    });

    return Array.from(latestByVehicle.values())
      .filter((deployment) => deployment.status === 'DEPLOYED' || deployment.status === 'ACTIVE')
      .map((deployment) => ({
        deploymentId: deployment.id,
        vehicleId: deployment.vehicle_dictionary_id as number,
        label: deployment.label,
        status: deployment.status,
        geometry_type: deployment.geometry_type,
        geometry: deployment.geometry,
        resource_data: deployment.resource_data,
        created_at: deployment.created_at,
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [bundle?.resource_deployments]);

  const failedVehicleDeployments = useMemo<ActiveVehicleDeployment[]>(() => {
    const deployments = bundle?.resource_deployments ?? [];
    const latestByVehicle = new Map<number, ResourceDeploymentDto>();

    deployments.forEach((deployment) => {
      if (deployment.resource_kind !== 'VEHICLE' || !deployment.vehicle_dictionary_id) {
        return;
      }
      const current = latestByVehicle.get(deployment.vehicle_dictionary_id);
      if (!current || new Date(deployment.created_at).getTime() >= new Date(current.created_at).getTime()) {
        latestByVehicle.set(deployment.vehicle_dictionary_id, deployment);
      }
    });

    return Array.from(latestByVehicle.values())
      .filter((deployment) => {
        if (deployment.status !== 'COMPLETED') {
          return false;
        }
        const resourceData = deployment.resource_data;
        if (!resourceData || typeof resourceData !== 'object') {
          return false;
        }
        return (resourceData as Record<string, unknown>).failure_active === true;
      })
      .map((deployment) => ({
        deploymentId: deployment.id,
        vehicleId: deployment.vehicle_dictionary_id as number,
        label: deployment.label,
        status: deployment.status,
        geometry_type: deployment.geometry_type,
        geometry: deployment.geometry,
        resource_data: deployment.resource_data,
        created_at: deployment.created_at,
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [bundle?.resource_deployments]);

  const canEditHydrantRuntime = Boolean(selectedHydrantObject);
  const canSetVehicleFailure = isLessonStarted && selectedVehicleFailureId.trim().length > 0;
  const canRepairVehicleFailure = isLessonStarted && selectedVehicleRepairId.trim().length > 0;

  useEffect(() => {
    if (!selectedObjectId) {
      return;
    }
    if (activeFloor.objects.some((object) => object.id === selectedObjectId)) {
      return;
    }
    setSelectedObjectId(null);
    setSelectedVertexIndex(null);
    setDragPreview(null);
  }, [activeFloor.objects, selectedObjectId]);

  useEffect(() => {
    if (!selectedObject) {
      setSelectedLabelDraft('');
      setSelectedPropsDraft('{}');
      setSelectedPropsError('');
      setFirePropsDraft(DEFAULT_FIRE_PROPS_DRAFT);
      setInsertVertexMode(false);
      return;
    }

    setSelectedLabelDraft(selectedObject.label || KIND_LABELS[selectedObject.kind]);
    setSelectedKindDraft(selectedObject.kind);
    try {
      setSelectedPropsDraft(JSON.stringify(selectedObject.props ?? {}, null, 2));
      setSelectedPropsError('');
    } catch {
      setSelectedPropsDraft('{}');
      setSelectedPropsError('');
    }

    const props = selectedObject.props ?? {};
    setFirePropsDraft({
      fireAreaM2: Math.max(1, numberOrFallback(props.fire_area_m2 ?? props.area_m2, DEFAULT_FIRE_PROPS_DRAFT.fireAreaM2)),
      spreadSpeedMMin: Math.max(
        0.1,
        numberOrFallback(props.spread_speed_m_min ?? props.fire_spread_speed_m_min, DEFAULT_FIRE_PROPS_DRAFT.spreadSpeedMMin),
      ),
      spreadAzimuth: Math.max(
        0,
        Math.min(359, Math.round(numberOrFallback(props.spread_azimuth, DEFAULT_FIRE_PROPS_DRAFT.spreadAzimuth))),
      ),
      smokeDensity: Math.max(0, Math.min(1, numberOrFallback(props.smoke_density, DEFAULT_FIRE_PROPS_DRAFT.smokeDensity))),
      fireRank: Math.max(1, Math.min(5, Math.round(numberOrFallback(props.fire_rank, DEFAULT_FIRE_PROPS_DRAFT.fireRank)))),
      firePower: Math.max(0.35, Math.min(4, numberOrFallback(props.fire_power, DEFAULT_FIRE_PROPS_DRAFT.firePower))),
      isActive: boolOrFallback(props.is_active, true),
    });

    if (selectedObject.geometry_type === 'POINT') {
      setInsertVertexMode(false);
    }
  }, [selectedObject]);

  useEffect(() => {
    if (!selectedHydrantObject) {
      return;
    }

    const props = selectedHydrantObject.props ?? {};
    setHydrantFlowDraft(numberOrFallback(props.flow_l_s, 25));
    setHydrantPressureDraft(numberOrFallback(props.pressure_bar, 6));
    setHydrantOperationalDraft(boolOrFallback(props.is_operational, true));
  }, [selectedHydrantObject]);

  useEffect(() => {
    if (vehicleDictionary.length === 0) {
      setSelectedVehicleConfigId(null);
      return;
    }

    if (
      selectedVehicleConfigId !== null
      && vehicleDictionary.some((vehicle) => vehicle.id === selectedVehicleConfigId)
    ) {
      return;
    }

    setSelectedVehicleConfigId(vehicleDictionary[0].id);
  }, [selectedVehicleConfigId, vehicleDictionary]);

  useEffect(() => {
    if (!selectedVehicleConfig) {
      return;
    }
    setVehicleSpecDraft(buildVehicleSpecDraft(selectedVehicleConfig));
  }, [selectedVehicleConfig]);

  useEffect(() => {
    const lessonStateRaw = snapshotData?.training_lesson;
    if (!lessonStateRaw || typeof lessonStateRaw !== 'object') {
      return;
    }

    const lessonState = lessonStateRaw as Record<string, unknown>;
    const timeLimitSec = numberOrFallback(lessonState.time_limit_sec, 30 * 60);
    setLessonTimeLimitMinDraft(Math.max(5, Math.min(360, Math.round(timeLimitSec / 60))));

    const startSimSeconds = numberOrFallback(lessonState.start_sim_time_seconds, 10 * 3600);
    const normalized = ((Math.round(startSimSeconds) % 86400) + 86400) % 86400;
    setLessonStartHourDraft(Math.floor(normalized / 3600));
    setLessonStartMinuteDraft(Math.floor((normalized % 3600) / 60));
  }, [snapshotData?.training_lesson]);

  useEffect(() => {
    const multiplier = bundle?.session?.time_multiplier;
    if (typeof multiplier !== 'number' || !Number.isFinite(multiplier)) {
      return;
    }
    setTimeMultiplierDraft(Math.max(0.1, Math.min(30, Math.round(multiplier * 10) / 10)));
  }, [bundle?.session?.time_multiplier]);

  useEffect(() => {
    if (!isLessonStarted) {
      return;
    }
    setToolMode('NONE');
    setPendingPoint(null);
    setHoverPoint(null);
    setInsertVertexMode(false);
    setSelectedVertexIndex(null);
    setDragPreview(null);
  }, [isLessonStarted]);

  useEffect(() => {
    if (activeVehicleDeployments.length === 0) {
      setSelectedVehicleFailureId('');
      return;
    }
    if (activeVehicleDeployments.some((deployment) => deployment.deploymentId === selectedVehicleFailureId)) {
      return;
    }
    setSelectedVehicleFailureId(activeVehicleDeployments[0].deploymentId);
  }, [activeVehicleDeployments, selectedVehicleFailureId]);

  useEffect(() => {
    if (failedVehicleDeployments.length === 0) {
      setSelectedVehicleRepairId('');
      return;
    }
    if (failedVehicleDeployments.some((deployment) => deployment.deploymentId === selectedVehicleRepairId)) {
      return;
    }
    setSelectedVehicleRepairId(failedVehicleDeployments[0].deploymentId);
  }, [failedVehicleDeployments, selectedVehicleRepairId]);

  const loadBundleForSession = useCallback(async (sessionId: string) => {
    if (!sessionId) {
      setBundle(null);
      return;
    }

    try {
      const loadedBundle = await apiClient.get<SessionStateBundleDto>(`/sessions/${sessionId}/state`);
      setBundle(loadedBundle);
      setError('');
    } catch (loadError) {
      setError(getErrorMessage(loadError, 'Не удалось загрузить состояние выбранной сессии'));
    }
  }, []);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError('');

    try {
      const [loadedSessions, loadedVehicles] = await Promise.all([
        apiClient.get<SimulationSessionDto[]>('/sessions'),
        apiClient.get<VehicleDictionaryDto[]>('/vehicles'),
      ]);
      setSessions(loadedSessions);
      setVehicleDictionary(loadedVehicles);

      const preferredSessionId = selectedSessionId || user?.session_id || loadedSessions[0]?.id || '';
      const resolvedSessionId = loadedSessions.some((sessionItem) => sessionItem.id === preferredSessionId)
        ? preferredSessionId
        : loadedSessions[0]?.id || '';

      setSelectedSessionId(resolvedSessionId);

      if (resolvedSessionId) {
        await loadBundleForSession(resolvedSessionId);
      } else {
        setBundle(null);
      }
    } catch (loadError) {
      setError(getErrorMessage(loadError, 'Не удалось загрузить данные руководителя занятий'));
    } finally {
      setIsLoading(false);
    }
  }, [loadBundleForSession, selectedSessionId, user?.session_id]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!selectedSessionId) {
      return;
    }
    connectRealtime(selectedSessionId);
  }, [connectRealtime, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId || !realtimeBundle || realtimeSessionId !== selectedSessionId) {
      return;
    }
    setBundle(realtimeBundle);
  }, [realtimeBundle, realtimeSessionId, selectedSessionId]);

  useEffect(() => {
    if (!bundle?.session) {
      return;
    }

    setSessions((previous) => {
      if (previous.length === 0) {
        return previous;
      }
      let changed = false;
      const next = previous.map((sessionItem) => {
        if (sessionItem.id !== bundle.session.id) {
          return sessionItem;
        }
        changed =
          changed ||
          sessionItem.status !== bundle.session.status ||
          sessionItem.scenario_name !== bundle.session.scenario_name;
        return {
          ...sessionItem,
          status: bundle.session.status,
          scenario_name: bundle.session.scenario_name,
          map_image_url: bundle.session.map_image_url,
          map_scale: bundle.session.map_scale,
          weather: bundle.session.weather,
          time_multiplier: bundle.session.time_multiplier,
          created_at: bundle.session.created_at,
        };
      });
      return changed ? next : previous;
    });
  }, [bundle?.session]);

  useEffect(() => {
    setWeatherDraft(weatherFromBundle(bundle));
  }, [bundle]);

  useEffect(() => {
    setAddressDraft((previous) => ({
      ...previous,
      addressText: scene.address.address_text || previous.addressText,
      karta01Url: scene.address.karta01_url || previous.karta01Url,
      radiusM: Math.round(scene.address.radius_m || previous.radiusM || 200),
    }));
  }, [scene.address.address_text, scene.address.karta01_url, scene.address.radius_m]);

  useEffect(() => {
    setActiveFloorIdDraft(scene.active_floor_id || 'F1');
  }, [scene.active_floor_id]);

  useEffect(() => {
    const holder = canvasHolderRef.current;
    if (!holder) {
      return;
    }

    const updateCanvasSize = () => {
      const nextWidth = Math.max(600, Math.floor(holder.clientWidth - 16));
      const nextHeight = Math.max(360, Math.floor(holder.clientHeight - 16));
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

    return () => {
      observer.disconnect();
    };
  }, []);

  const selectTool = useCallback((nextTool: ToolMode) => {
    setToolMode(nextTool);
    setPendingPoint(null);
    setHoverPoint(null);
    setSelectedVertexIndex(null);
    setDragPreview(null);
  }, []);

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
      return canvasToWorld(basePoint, canvas.width, canvas.height, worldViewport);
    },
    [viewPan, viewZoom, worldViewport],
  );

  const applySnapAndConstraint = useCallback(
    (point: Point, options?: { anchor?: Point; forWall?: boolean }): Point => {
      let nextPoint = point;

      if (snapToGrid) {
        nextPoint = snapPointToGrid(nextPoint, displayGridStepM);
      }

      if (options?.forWall && options.anchor && lockWallAngle) {
        nextPoint = lockPointToAngle(options.anchor, nextPoint, 45);
        if (snapToGrid) {
          nextPoint = snapPointToGrid(nextPoint, displayGridStepM);
        }
      }

      return nextPoint;
    },
    [displayGridStepM, lockWallAngle, snapToGrid],
  );

  const zoomAtCanvasPoint = useCallback(
    (nextZoom: number, anchor: Point) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const targetZoom = clampValue(nextZoom, VIEW_MIN_ZOOM, VIEW_MAX_ZOOM);
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

  const resetView = useCallback(() => {
    setViewZoom(1);
    setViewPan({ x: 0, y: 0 });
  }, []);

  const centerView = useCallback(() => {
    setViewPan({ x: 0, y: 0 });
  }, []);

  const sendRealtime = useCallback(
    async (command: string, payload: Record<string, unknown> = {}) => {
      if (!selectedSessionId) {
        throw new Error('Сессия не выбрана');
      }
      await sendRealtimeCommand(command, payload, selectedSessionId);
    },
    [selectedSessionId, sendRealtimeCommand],
  );

  const handleSetCurrentSession = async (targetSessionId?: string) => {
    const sessionIdToBind = targetSessionId ?? selectedSessionId;

    if (!sessionIdToBind) {
      return;
    }

    setActionError('');
    setActionLoading('set-session');
    try {
      const updatedUser = await apiClient.patch<UserProfile>('/auth/session', { session_id: sessionIdToBind });
      setUser(updatedUser);
    } catch (setSessionError) {
      setActionError(getErrorMessage(setSessionError, 'Не удалось привязать сессию к пользователю'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleApplyAddress = async () => {
    if (isLessonStarted) {
      setActionError('Урок уже запущен. Редактирование схемы по адресу заблокировано');
      return;
    }

    if (!selectedSessionId) {
      setActionError('Сессия не выбрана');
      return;
    }

    setActionError('');
    setActionLoading('set-address');
    try {
      await sendRealtime('set_scene_address', {
        address_text: addressDraft.addressText,
        karta01_url: addressDraft.karta01Url,
        radius_m: addressDraft.radiusM,
      });
      setPendingPoint(null);
      setHoverPoint(null);
      setSelectedObjectId(null);
      setSelectedVertexIndex(null);
      setDragPreview(null);
      setInsertVertexMode(false);
      setUndoStack([]);
      setRedoStack([]);
      resetView();
      setIsPanning(false);
      setIsObjectDragging(false);
      interactionRef.current = null;
      suppressNextClickRef.current = false;
      showBanner('УЧАСТОК ПОСТРОЕН ПО АДРЕСУ');
    } catch (setAddressError) {
      setActionError(getErrorMessage(setAddressError, 'Не удалось построить участок по адресу'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleApplyWeather = async () => {
    setActionError('');
    setActionLoading('update-weather');
    try {
      await sendRealtime('update_weather', {
        wind_speed: Math.max(0, weatherDraft.wind_speed),
        wind_dir: Math.max(0, Math.min(359, Math.round(weatherDraft.wind_dir))),
        temperature: weatherDraft.temperature,
        weather_data: { source: 'training_lead_workspace' },
      });
      showBanner('ПОГОДНЫЕ УСЛОВИЯ ОБНОВЛЕНЫ');
    } catch (weatherError) {
      setActionError(getErrorMessage(weatherError, 'Не удалось обновить погодные условия'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleApplyTimeMultiplier = async () => {
    if (!selectedSessionId) {
      setActionError('Сессия не выбрана');
      return;
    }

    const normalizedMultiplier = Math.max(0.1, Math.min(30, Math.round(timeMultiplierDraft * 10) / 10));

    setActionError('');
    setActionLoading('time-multiplier');
    try {
      const updatedSession = await apiClient.patch<SimulationSessionDto>(
        `/sessions/${selectedSessionId}`,
        { time_multiplier: normalizedMultiplier },
      );

      setSessions((previous) => previous.map((item) => (item.id === updatedSession.id ? updatedSession : item)));
      setBundle((previous) => {
        if (!previous || previous.session.id !== updatedSession.id) {
          return previous;
        }
        return {
          ...previous,
          session: updatedSession,
        };
      });

      setTimeMultiplierDraft(normalizedMultiplier);
      showBanner(`ИГРОВОЕ ВРЕМЯ: x${normalizedMultiplier.toFixed(1)}`);
    } catch (multiplierError) {
      setActionError(getErrorMessage(multiplierError, 'Не удалось изменить ускорение игрового времени'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleAddFloor = async () => {
    if (isLessonStarted) {
      setActionError('Урок уже запущен. Добавление этажей заблокировано');
      return;
    }

    const floorId = normalizeFloorId(newFloorId);
    setActionError('');
    setActionLoading('add-floor');
    try {
      await sendRealtime('upsert_scene_floor', { floor_id: floorId, elevation_m: 0, set_active: true });
      setNewFloorId(`F${scene.floors.length + 2}`);
      setPendingPoint(null);
      setHoverPoint(null);
      setSelectedObjectId(null);
      setSelectedVertexIndex(null);
      setDragPreview(null);
      setInsertVertexMode(false);
    } catch (addFloorError) {
      setActionError(getErrorMessage(addFloorError, 'Не удалось добавить этаж'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleSetActiveFloor = async (floorId: string) => {
    if (isLessonStarted) {
      setActionError('Урок уже запущен. Переключение этажей в редакторе заблокировано');
      return;
    }

    setActionError('');
    setActionLoading('set-floor');
    try {
      await sendRealtime('set_active_scene_floor', { floor_id: floorId });
      setPendingPoint(null);
      setHoverPoint(null);
      setSelectedObjectId(null);
      setSelectedVertexIndex(null);
      setDragPreview(null);
      setInsertVertexMode(false);
    } catch (setFloorError) {
      setActionError(getErrorMessage(setFloorError, 'Не удалось переключить этаж'));
    } finally {
      setActionLoading(null);
    }
  };

  const upsertSceneObject = useCallback(
    async (payload: {
      floor_id: string;
      kind: SceneKind;
      geometry_type: GeometryType;
      geometry: Record<string, unknown>;
      label: string;
      object_id?: string;
      props?: Record<string, unknown>;
    }) => {
      await sendRealtime('upsert_scene_object', payload);
    },
    [sendRealtime],
  );

  const removeSceneObject = useCallback(
    async (objectId: string, floorId?: string) => {
      await sendRealtime('remove_scene_object', {
        floor_id: floorId || activeFloor.floor_id,
        object_id: objectId,
      });
    },
    [activeFloor.floor_id, sendRealtime],
  );

  const pushHistoryEntry = useCallback((entry: SceneHistoryEntry) => {
    setUndoStack((previous) => {
      const next = [...previous, entry];
      if (next.length > MAX_HISTORY_ENTRIES) {
        return next.slice(next.length - MAX_HISTORY_ENTRIES);
      }
      return next;
    });
    setRedoStack([]);
  }, []);

  const buildSceneObjectFromUpsert = useCallback(
    (payload: {
      object_id: string;
      kind: SceneKind;
      geometry_type: GeometryType;
      geometry: Record<string, unknown>;
      label: string;
      props?: Record<string, unknown>;
    }): SceneObject => {
      const existingObject = activeFloor.objects.find((object) => object.id === payload.object_id);
      return {
        id: payload.object_id,
        kind: payload.kind,
        geometry_type: payload.geometry_type,
        geometry: parseGeometry(payload.geometry),
        label: payload.label,
        props: payload.props ?? {},
        created_at: existingObject?.created_at || new Date().toISOString(),
      };
    },
    [activeFloor.objects],
  );

  const commitUpsertSceneObject = useCallback(
    async (
      payload: {
        floor_id: string;
        kind: SceneKind;
        geometry_type: GeometryType;
        geometry: Record<string, unknown>;
        label: string;
        object_id?: string;
        props?: Record<string, unknown>;
      },
      options?: { description?: string; recordHistory?: boolean },
    ): Promise<string> => {
      const objectId = payload.object_id || makeSceneObjectId();
      const floor = scene.floors.find((item) => item.floor_id === payload.floor_id);
      const beforeObject = floor?.objects.find((item) => item.id === objectId) ?? null;

      await upsertSceneObject({
        ...payload,
        object_id: objectId,
      });

      if (options?.recordHistory === false) {
        return objectId;
      }

      const afterObject = buildSceneObjectFromUpsert({
        object_id: objectId,
        kind: payload.kind,
        geometry_type: payload.geometry_type,
        geometry: payload.geometry,
        label: payload.label,
        props: payload.props,
      });

      pushHistoryEntry({
        id: crypto.randomUUID(),
        floorId: payload.floor_id,
        before: beforeObject ? cloneSceneObject(beforeObject) : null,
        after: cloneSceneObject(afterObject),
        description: options?.description || 'upsert-object',
        createdAt: new Date().toISOString(),
      });

      return objectId;
    },
    [buildSceneObjectFromUpsert, pushHistoryEntry, scene.floors, upsertSceneObject],
  );

  const commitRemoveSceneObject = useCallback(
    async (
      object: SceneObject,
      floorId: string,
      options?: { description?: string; recordHistory?: boolean },
    ) => {
      await removeSceneObject(object.id, floorId);

      if (options?.recordHistory === false) {
        return;
      }

      pushHistoryEntry({
        id: crypto.randomUUID(),
        floorId,
        before: cloneSceneObject(object),
        after: null,
        description: options?.description || 'remove-object',
        createdAt: new Date().toISOString(),
      });
    },
    [pushHistoryEntry, removeSceneObject],
  );

  const applyHistorySnapshot = useCallback(
    async (floorId: string, snapshot: SceneObject | null, removeId: string | null) => {
      if (snapshot) {
        await upsertSceneObject({
          floor_id: floorId,
          object_id: snapshot.id,
          kind: snapshot.kind,
          geometry_type: snapshot.geometry_type,
          geometry:
            snapshot.geometry_type === 'POINT'
              ? { x: snapshot.geometry.x ?? 0, y: snapshot.geometry.y ?? 0 }
              : { points: (snapshot.geometry.points ?? []).map((point) => ({ x: point.x, y: point.y })) },
          label: snapshot.label || KIND_LABELS[snapshot.kind],
          props: snapshot.props ?? {},
        });
        return;
      }

      if (removeId) {
        await removeSceneObject(removeId, floorId);
      }
    },
    [removeSceneObject, upsertSceneObject],
  );

  const handleUndo = useCallback(async () => {
    if (isLessonStarted) {
      setActionError('Во время урока undo недоступен');
      return;
    }

    if (undoStack.length === 0 || actionLoading === 'undo' || actionLoading === 'redo') {
      return;
    }

    const entry = undoStack[undoStack.length - 1];
    setActionError('');
    setActionLoading('undo');

    try {
      await applyHistorySnapshot(entry.floorId, entry.before, entry.after?.id ?? null);

      setUndoStack((previous) => previous.slice(0, -1));
      setRedoStack((previous) => {
        const next = [...previous, entry];
        if (next.length > MAX_HISTORY_ENTRIES) {
          return next.slice(next.length - MAX_HISTORY_ENTRIES);
        }
        return next;
      });

      if (entry.before) {
        setSelectedObjectId(entry.before.id);
      } else if (entry.after) {
        setSelectedObjectId((previous) => (previous === entry.after?.id ? null : previous));
      }

      setSelectedVertexIndex(null);
      setDragPreview(null);
      showBanner('ОТМЕНА ВЫПОЛНЕНА');
    } catch (undoError) {
      setActionError(getErrorMessage(undoError, 'Не удалось выполнить отмену'));
    } finally {
      setActionLoading(null);
    }
  }, [actionLoading, applyHistorySnapshot, isLessonStarted, showBanner, undoStack]);

  const handleRedo = useCallback(async () => {
    if (isLessonStarted) {
      setActionError('Во время урока redo недоступен');
      return;
    }

    if (redoStack.length === 0 || actionLoading === 'undo' || actionLoading === 'redo') {
      return;
    }

    const entry = redoStack[redoStack.length - 1];
    setActionError('');
    setActionLoading('redo');

    try {
      await applyHistorySnapshot(entry.floorId, entry.after, entry.before?.id ?? null);

      setRedoStack((previous) => previous.slice(0, -1));
      setUndoStack((previous) => {
        const next = [...previous, entry];
        if (next.length > MAX_HISTORY_ENTRIES) {
          return next.slice(next.length - MAX_HISTORY_ENTRIES);
        }
        return next;
      });

      if (entry.after) {
        setSelectedObjectId(entry.after.id);
      } else if (entry.before) {
        setSelectedObjectId((previous) => (previous === entry.before?.id ? null : previous));
      }

      setSelectedVertexIndex(null);
      setDragPreview(null);
      showBanner('ПОВТОР ВЫПОЛНЕН');
    } catch (redoError) {
      setActionError(getErrorMessage(redoError, 'Не удалось выполнить повтор'));
    } finally {
      setActionLoading(null);
    }
  }, [actionLoading, applyHistorySnapshot, isLessonStarted, redoStack, showBanner]);

  const handleDuplicateObject = useCallback(
    async (object: SceneObject) => {
      if (isLessonStarted) {
        setActionError('Во время урока дублирование объектов отключено');
        return;
      }

      const copyOffset: Point = { x: 4, y: -4 };
      const duplicatedGeometry = offsetGeometry(object.geometry_type, object.geometry, copyOffset);

      setActionError('');
      setActionLoading('duplicate-object');
      try {
        await commitUpsertSceneObject(
          {
          floor_id: activeFloor.floor_id,
          kind: object.kind,
          geometry_type: object.geometry_type,
          geometry: duplicatedGeometry,
          label: `${object.label || KIND_LABELS[object.kind]} (копия)`,
          props: object.props ?? {},
          },
          { description: 'duplicate-object' },
        );
        showBanner('ОБЪЕКТ ДУБЛИРОВАН');
      } catch (duplicateError) {
        setActionError(getErrorMessage(duplicateError, 'Не удалось дублировать объект'));
      } finally {
        setActionLoading(null);
      }
    },
    [activeFloor.floor_id, commitUpsertSceneObject, isLessonStarted, showBanner],
  );

  const handleApplySelectedProperties = useCallback(async () => {
    if (isLessonStarted) {
      setActionError('Во время урока редактирование схемы отключено');
      return;
    }

    if (!selectedObject) {
      return;
    }

    let parsedProps: Record<string, unknown> = {};

    if (selectedKindDraft === 'FIRE_SOURCE' || selectedKindDraft === 'SMOKE_ZONE') {
      parsedProps = {
        fire_area_m2: Math.max(1, Math.round(firePropsDraft.fireAreaM2)),
        spread_speed_m_min: Math.max(0.1, Math.round(firePropsDraft.spreadSpeedMMin * 10) / 10),
        spread_azimuth: Math.max(0, Math.min(359, Math.round(firePropsDraft.spreadAzimuth))),
        smoke_density: Math.max(0, Math.min(1, Math.round(firePropsDraft.smokeDensity * 100) / 100)),
        fire_rank: Math.max(1, Math.min(5, Math.round(firePropsDraft.fireRank))),
        fire_power: Math.max(0.35, Math.min(4, Math.round(firePropsDraft.firePower * 100) / 100)),
        is_active: Boolean(firePropsDraft.isActive),
      };
    } else {
      const normalizedProps = selectedPropsDraft.trim();
      if (normalizedProps) {
        try {
          const parsed = JSON.parse(normalizedProps) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('props must be object');
          }
          parsedProps = parsed as Record<string, unknown>;
        } catch {
          setSelectedPropsError('props: некорректный JSON');
          return;
        }
      }
    }

    setSelectedPropsError('');
    setActionError('');
    setActionLoading('save-properties');

    try {
      const geometry =
        dragPreview && dragPreview.objectId === selectedObject.id ? dragPreview.geometry : selectedObject.geometry;

      await commitUpsertSceneObject(
        {
          floor_id: activeFloor.floor_id,
          object_id: selectedObject.id,
          kind: selectedKindDraft,
          geometry_type: selectedObject.geometry_type,
          geometry,
          label: selectedLabelDraft.trim() || KIND_LABELS[selectedKindDraft],
          props: parsedProps,
        },
        { description: 'update-object-properties' },
      );

      showBanner('СВОЙСТВА ОБЪЕКТА ОБНОВЛЕНЫ');
    } catch (saveError) {
      setActionError(getErrorMessage(saveError, 'Не удалось сохранить свойства объекта'));
    } finally {
      setActionLoading(null);
    }
  }, [
    activeFloor.floor_id,
    dragPreview,
    isLessonStarted,
    selectedKindDraft,
    selectedLabelDraft,
    selectedObject,
    firePropsDraft,
    selectedPropsDraft,
    showBanner,
    commitUpsertSceneObject,
  ]);

  const handleSaveSceneScheme = async () => {
    if (!selectedSessionId) {
      setActionError('Сессия не выбрана');
      return;
    }

    setActionError('');
    setActionLoading('save-scene');
    try {
      await sendRealtime('save_scene_checkpoint', {
        reason: 'manual_save',
      });
      showBanner('СХЕМА СОХРАНЕНА');
    } catch (saveError) {
      setActionError(getErrorMessage(saveError, 'Не удалось сохранить схему занятия'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleStartLesson = async () => {
    if (!selectedSessionId) {
      setActionError('Сессия не выбрана');
      return;
    }

    setActionError('');
    setActionLoading('start-lesson');
    try {
      const normalizedHour = Math.max(0, Math.min(23, Math.round(lessonStartHourDraft)));
      const normalizedMinute = Math.max(0, Math.min(59, Math.round(lessonStartMinuteDraft)));
      const startSimTimeSeconds = normalizedHour * 3600 + normalizedMinute * 60;
      const timeLimitSec = Math.max(5, Math.min(360, Math.round(lessonTimeLimitMinDraft))) * 60;

      await sendRealtime('start_lesson', {
        reason: 'lesson_start',
        time_limit_sec: timeLimitSec,
        start_sim_time_seconds: startSimTimeSeconds,
      });

      showBanner('УРОК ЗАПУЩЕН. ДАННЫЕ ПЕРЕДАНЫ ДИСПЕТЧЕРУ');
    } catch (startError) {
      setActionError(getErrorMessage(startError, 'Не удалось запустить урок'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleFinishLesson = async () => {
    if (!selectedSessionId) {
      setActionError('Сессия не выбрана');
      return;
    }

    setActionError('');
    setActionLoading('finish-lesson');
    try {
      await sendRealtime('finish_lesson', {
        reason: 'lesson_finish',
      });
      showBanner('ТРЕНИРОВКА ЗАВЕРШЕНА');
    } catch (finishError) {
      setActionError(getErrorMessage(finishError, 'Не удалось завершить урок'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleEscalateFire = async () => {
    setActionError('');
    setActionLoading('worsen-fire');

    const now = Date.now();
    const jitter = ((now % 7) - 3) * 2;
    const polygon = [
      { x: -10 + jitter, y: -8 },
      { x: 10 + jitter, y: -8 },
      { x: 12 + jitter, y: 8 },
      { x: -12 + jitter, y: 8 },
    ];

    try {
      await sendRealtime('create_fire_object', {
        name: `ЭСКАЛАЦИЯ ${new Date().toLocaleTimeString('ru-RU')}`,
        kind: 'FIRE_ZONE',
        geometry_type: 'POLYGON',
        geometry: { points: polygon },
        area_m2: 180,
        spread_speed_m_min: 4.5,
        is_active: true,
        extra: {
          source: 'training_lead_runtime',
          event: 'worsen_fire',
          lesson_mode: isLessonStarted,
        },
      });
      showBanner('УСЛОЖНЕНИЕ: ПОЖАР УСИЛЕН');
    } catch (error) {
      setActionError(getErrorMessage(error, 'Не удалось усилить пожарный сценарий'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleCollapseSelectedWall = async () => {
    if (!selectedObject || selectedObject.kind !== 'WALL') {
      setActionError('Выберите объект типа СТЕНА для обрушения');
      return;
    }

    setActionError('');
    setActionLoading('collapse-wall');
    try {
      const geometry = dragPreview && dragPreview.objectId === selectedObject.id ? dragPreview.geometry : selectedObject.geometry;
      const nextProps = {
        ...(selectedObject.props ?? {}),
        collapsed: true,
        integrity: 0,
        collapsed_at: new Date().toISOString(),
      };

      await commitUpsertSceneObject(
        {
          floor_id: activeFloor.floor_id,
          object_id: selectedObject.id,
          kind: selectedObject.kind,
          geometry_type: selectedObject.geometry_type,
          geometry,
          label: selectedObject.label?.includes('обруш') ? selectedObject.label : `${selectedObject.label || 'Стена'} (обрушена)`,
          props: nextProps,
        },
        { description: 'runtime-collapse-wall', recordHistory: false },
      );

      showBanner('УСЛОЖНЕНИЕ: УЧАСТОК СТЕНЫ ОБРУШЕН');
    } catch (error) {
      setActionError(getErrorMessage(error, 'Не удалось применить обрушение стены'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleApplyHydrantRuntime = async () => {
    if (!selectedHydrantObject) {
      setActionError('Выберите гидрант на схеме, чтобы изменить его параметры');
      return;
    }

    setActionError('');
    setActionLoading('hydrant-runtime');
    try {
      const geometry = dragPreview && dragPreview.objectId === selectedHydrantObject.id ? dragPreview.geometry : selectedHydrantObject.geometry;
      const nextProps = {
        ...(selectedHydrantObject.props ?? {}),
        flow_l_s: Math.max(0, Number(hydrantFlowDraft) || 0),
        pressure_bar: Math.max(0, Number(hydrantPressureDraft) || 0),
        is_operational: Boolean(hydrantOperationalDraft),
        runtime_updated_at: new Date().toISOString(),
      };

      await commitUpsertSceneObject(
        {
          floor_id: activeFloor.floor_id,
          object_id: selectedHydrantObject.id,
          kind: selectedHydrantObject.kind,
          geometry_type: selectedHydrantObject.geometry_type,
          geometry,
          label: selectedHydrantObject.label || KIND_LABELS[selectedHydrantObject.kind],
          props: nextProps,
        },
        { description: 'runtime-hydrant-update', recordHistory: false },
      );

      showBanner('ПАРАМЕТРЫ ГИДРАНТА ОБНОВЛЕНЫ');
    } catch (error) {
      setActionError(getErrorMessage(error, 'Не удалось обновить параметры гидранта'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleSetVehicleFailure = async () => {
    const target = activeVehicleDeployments.find((deployment) => deployment.deploymentId === selectedVehicleFailureId);
    if (!target) {
      setActionError('Выберите активную машину для события "поломка"');
      return;
    }

    setActionError('');
    setActionLoading('vehicle-failure');
    try {
      await sendRealtime('create_resource_deployment', {
        resource_kind: 'VEHICLE',
        status: 'COMPLETED',
        vehicle_dictionary_id: target.vehicleId,
        label: target.label.includes('неисправ') ? target.label : `${target.label} (неисправна)`,
        geometry_type: target.geometry_type,
        geometry: target.geometry,
        resource_data: {
          ...(target.resource_data ?? {}),
          source: 'training_lead_runtime',
          event: 'vehicle_failure',
          failure_active: true,
          failure_prev_status: target.status,
          failure_prev_label: target.label,
        },
      });
      showBanner('УСЛОЖНЕНИЕ: МАШИНА ВЫВЕДЕНА ИЗ РАБОТЫ');
    } catch (error) {
      setActionError(getErrorMessage(error, 'Не удалось отметить поломку машины'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleRepairVehicleFailure = async () => {
    const target = failedVehicleDeployments.find((deployment) => deployment.deploymentId === selectedVehicleRepairId);
    if (!target) {
      setActionError('Выберите машину для восстановления');
      return;
    }

    const resourceData = target.resource_data && typeof target.resource_data === 'object'
      ? (target.resource_data as Record<string, unknown>)
      : {};

    const previousStatusRaw = typeof resourceData.failure_prev_status === 'string'
      ? resourceData.failure_prev_status
      : typeof resourceData.previous_status === 'string'
        ? resourceData.previous_status
        : 'DEPLOYED';
    const previousStatus = ['PLANNED', 'EN_ROUTE', 'DEPLOYED', 'ACTIVE', 'COMPLETED'].includes(previousStatusRaw)
      ? previousStatusRaw
      : 'DEPLOYED';

    const restoredLabel = typeof resourceData.failure_prev_label === 'string' && resourceData.failure_prev_label.trim().length > 0
      ? resourceData.failure_prev_label
      : target.label.replace(/\s*\(неисправна\)$/i, '').trim() || target.label;

    setActionError('');
    setActionLoading('vehicle-repair');
    try {
      await sendRealtime('create_resource_deployment', {
        resource_kind: 'VEHICLE',
        status: previousStatus,
        vehicle_dictionary_id: target.vehicleId,
        label: restoredLabel,
        geometry_type: target.geometry_type,
        geometry: target.geometry,
        resource_data: {
          ...resourceData,
          source: 'training_lead_runtime',
          event: 'vehicle_repair',
          failure_active: false,
        },
      });
      showBanner('МАШИНА ВОССТАНОВЛЕНА И ВОЗВРАЩЕНА В РАБОТУ');
    } catch (error) {
      setActionError(getErrorMessage(error, 'Не удалось восстановить машину после поломки'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleSaveVehicleSpecs = async () => {
    if (isLessonStarted) {
      setActionError('Во время урока параметры техники менять нельзя');
      return;
    }

    if (!selectedVehicleConfig) {
      setActionError('Выберите машину для редактирования характеристик');
      return;
    }

    const payload = {
      crew_size: Math.max(1, Math.round(vehicleSpecDraft.crew_size)),
      water_capacity: Math.max(0, Math.round(vehicleSpecDraft.water_capacity)),
      foam_capacity: Math.max(0, Math.round(vehicleSpecDraft.foam_capacity)),
      hose_length: Math.max(0, Math.round(vehicleSpecDraft.hose_length)),
    };

    setActionError('');
    setActionLoading('vehicle-specs');
    try {
      const updated = await apiClient.patch<VehicleDictionaryDto>(`/vehicles/${selectedVehicleConfig.id}`, payload);
      setVehicleDictionary((previous) => previous.map((vehicle) => (vehicle.id === updated.id ? updated : vehicle)));
      showBanner(`ХАРАКТЕРИСТИКИ ${updated.name.toUpperCase()} ОБНОВЛЕНЫ`);
    } catch (error) {
      setActionError(getErrorMessage(error, 'Не удалось сохранить характеристики машины'));
    } finally {
      setActionLoading(null);
    }
  };

  const drawSceneCanvas = useCallback(() => {
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
      const basePoint = worldToCanvas(worldPoint, width, height, worldViewport);
      return applyViewTransform(basePoint, width, height, viewZoom, viewPan);
    };

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#101010';
    ctx.fillRect(0, 0, width, height);

    const origin = toScreen({ x: 0, y: 0 });
    let gridStepM = displayGridStepM;

    const gridStepPixels = (stepM: number) => {
      const xStep = toScreen({ x: stepM, y: 0 });
      const yStep = toScreen({ x: 0, y: stepM });
      return {
        stepX: Math.abs(xStep.x - origin.x),
        stepY: Math.abs(yStep.y - origin.y),
      };
    };

    let { stepX, stepY } = gridStepPixels(gridStepM);

    while ((stepX < 16 || stepY < 16) && gridStepM < 4096) {
      gridStepM *= 2;
      ({ stepX, stepY } = gridStepPixels(gridStepM));
    }
    while ((stepX > 140 || stepY > 140) && gridStepM > 0.5) {
      gridStepM /= 2;
      ({ stepX, stepY } = gridStepPixels(gridStepM));
    }

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
    ctx.strokeStyle = 'rgba(161, 161, 170, 0.15)';
    drawVerticalGrid(false);
    drawHorizontalGrid(false);

    ctx.strokeStyle = 'rgba(161, 161, 170, 0.32)';
    drawVerticalGrid(true);
    drawHorizontalGrid(true);

    for (const entity of scene.site_entities) {
      ctx.save();
      ctx.lineWidth = 2;

      if (entity.geometry_type === 'POINT' && typeof entity.geometry.x === 'number' && typeof entity.geometry.y === 'number') {
        const point = toScreen({ x: entity.geometry.x, y: entity.geometry.y });
        if (entity.kind === 'HYDRANT') {
          ctx.fillStyle = '#ef4444';
          ctx.strokeStyle = '#fee2e2';
          ctx.beginPath();
          ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#ffffff';
          ctx.font = '7px "Press Start 2P", monospace';
          ctx.fillText('H', point.x - 2, point.y + 2);
        } else {
          ctx.fillStyle = '#0ea5e9';
          ctx.strokeStyle = '#dbeafe';
          ctx.beginPath();
          ctx.moveTo(point.x, point.y - 6);
          ctx.lineTo(point.x + 6, point.y);
          ctx.lineTo(point.x, point.y + 6);
          ctx.lineTo(point.x - 6, point.y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#ffffff';
          ctx.font = '7px "Press Start 2P", monospace';
          ctx.fillText('W', point.x - 2, point.y + 2);
        }

        ctx.fillStyle = '#e5e7eb';
        ctx.font = '7px "Press Start 2P", monospace';
        ctx.fillText(entity.kind === 'HYDRANT' ? 'ГИДР' : 'ВОДА', point.x + 8, point.y - 6);
      }

      if (entity.geometry_type === 'LINESTRING' && entity.geometry.points && entity.geometry.points.length >= 2) {
        ctx.strokeStyle = 'rgba(203, 213, 225, 0.85)';
        ctx.lineWidth = 4;
        ctx.setLineDash([]);
        ctx.beginPath();
        entity.geometry.points.forEach((worldPoint, index) => {
          const point = toScreen(worldPoint);
          if (index === 0) {
            ctx.moveTo(point.x, point.y);
          } else {
            ctx.lineTo(point.x, point.y);
          }
        });
        ctx.stroke();

        ctx.strokeStyle = 'rgba(30, 41, 59, 0.95)';
        ctx.lineWidth = 1;
        ctx.setLineDash([8, 4]);
        ctx.beginPath();
        entity.geometry.points.forEach((worldPoint, index) => {
          const point = toScreen(worldPoint);
          if (index === 0) {
            ctx.moveTo(point.x, point.y);
          } else {
            ctx.lineTo(point.x, point.y);
          }
        });
        ctx.stroke();
        ctx.setLineDash([]);

        const firstPoint = toScreen(entity.geometry.points[0]);
        ctx.fillStyle = '#e5e7eb';
        ctx.font = '7px "Press Start 2P", monospace';
        ctx.fillText('ДОРОГА', firstPoint.x + 8, firstPoint.y - 6);
      }

      if (entity.geometry_type === 'POLYGON' && entity.geometry.points && entity.geometry.points.length >= 3) {
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.82)';
        ctx.fillStyle = 'rgba(250, 204, 21, 0.14)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        entity.geometry.points.forEach((worldPoint, index) => {
          const point = toScreen(worldPoint);
          if (index === 0) {
            ctx.moveTo(point.x, point.y);
          } else {
            ctx.lineTo(point.x, point.y);
          }
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

      }
      ctx.restore();
    }

    const resolveGeometry = (object: SceneObject): SceneObject['geometry'] => {
      if (dragPreview && dragPreview.objectId === object.id) {
        return dragPreview.geometry;
      }
      return object.geometry;
    };

    for (const object of activeFloor.objects) {
      const color = KIND_COLORS[object.kind];
      const geometry = resolveGeometry(object);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = object.kind === 'WALL' ? 3 : 2;

      if (object.geometry_type === 'POINT' && typeof geometry.x === 'number' && typeof geometry.y === 'number') {
        const point = toScreen({ x: geometry.x, y: geometry.y });
        ctx.beginPath();
        ctx.arc(point.x, point.y, object.kind === 'EXIT' ? 6 : 5, 0, Math.PI * 2);
        if (object.kind === 'EXIT') {
          ctx.fillStyle = 'rgba(34, 197, 94, 0.2)';
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fill();
        }
      }

      if (object.geometry_type === 'LINESTRING' && geometry.points && geometry.points.length >= 2) {
        ctx.beginPath();
        geometry.points.forEach((worldPoint, index) => {
          const point = toScreen(worldPoint);
          if (index === 0) {
            ctx.moveTo(point.x, point.y);
          } else {
            ctx.lineTo(point.x, point.y);
          }
        });
        ctx.stroke();
      }

      if (object.geometry_type === 'POLYGON' && geometry.points && geometry.points.length >= 3) {
        ctx.beginPath();
        geometry.points.forEach((worldPoint, index) => {
          const point = toScreen(worldPoint);
          if (index === 0) {
            ctx.moveTo(point.x, point.y);
          } else {
            ctx.lineTo(point.x, point.y);
          }
        });
        ctx.closePath();
        ctx.fillStyle = `${color}22`;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.stroke();
      }
      ctx.restore();
    }

    if (selectedObject) {
      const selectedGeometry = dragPreview?.objectId === selectedObject.id ? dragPreview.geometry : selectedObject.geometry;
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.fillStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);

      if (
        selectedObject.geometry_type === 'POINT' &&
        typeof selectedGeometry.x === 'number' &&
        typeof selectedGeometry.y === 'number'
      ) {
        const point = toScreen({ x: selectedGeometry.x, y: selectedGeometry.y });
        ctx.beginPath();
        ctx.arc(point.x, point.y, 9, 0, Math.PI * 2);
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.fillStyle = selectedVertexIndex === 0 ? '#f59e0b' : '#ffffff';
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }

      if (
        (selectedObject.geometry_type === 'LINESTRING' || selectedObject.geometry_type === 'POLYGON') &&
        selectedGeometry.points &&
        selectedGeometry.points.length >= 2
      ) {
        ctx.beginPath();
        selectedGeometry.points.forEach((worldPoint, index) => {
          const point = toScreen(worldPoint);
          if (index === 0) {
            ctx.moveTo(point.x, point.y);
          } else {
            ctx.lineTo(point.x, point.y);
          }
        });
        if (selectedObject.geometry_type === 'POLYGON') {
          ctx.closePath();
        }
        ctx.stroke();

        ctx.setLineDash([]);
        selectedGeometry.points.forEach((worldPoint, index) => {
          const point = toScreen(worldPoint);
          ctx.fillStyle = selectedVertexIndex === index ? '#f59e0b' : '#ffffff';
          ctx.fillRect(point.x - 3, point.y - 3, 6, 6);
          ctx.strokeStyle = '#0f172a';
          ctx.strokeRect(point.x - 3, point.y - 3, 6, 6);
        });
      }

      ctx.restore();
    }

    if (pendingPoint && hoverPoint) {
      ctx.save();
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.95)';
      ctx.fillStyle = 'rgba(245, 158, 11, 0.12)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 4]);
      if (toolMode === 'WALL') {
        const start = toScreen(pendingPoint);
        const finish = toScreen(hoverPoint);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(finish.x, finish.y);
        ctx.stroke();
      }
      if (toolMode === 'ROOM' || toolMode === 'SMOKE_ZONE') {
        const rectPoints = buildRectanglePolygon(pendingPoint, hoverPoint);
        ctx.beginPath();
        rectPoints.forEach((point, index) => {
          const screenPoint = toScreen(point);
          if (index === 0) {
            ctx.moveTo(screenPoint.x, screenPoint.y);
          } else {
            ctx.lineTo(screenPoint.x, screenPoint.y);
          }
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    if (pendingPoint) {
      const pending = toScreen(pendingPoint);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pending.x - 8, pending.y);
      ctx.lineTo(pending.x + 8, pending.y);
      ctx.moveTo(pending.x, pending.y - 8);
      ctx.lineTo(pending.x, pending.y + 8);
      ctx.stroke();
    }

    const pixelsPerMeter = stepX / Math.max(gridStepM, 1e-6);
    const scaleLengthM = pickScaleBarLengthByPixels(pixelsPerMeter);
    const scaleLengthPx = scaleLengthM * pixelsPerMeter;

    const marginRight = 20;
    const marginBottom = 18;
    const barEndX = width - marginRight;
    const barStartX = barEndX - scaleLengthPx;
    const barY = height - marginBottom;

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.58)';
    ctx.fillRect(barStartX - 10, barY - 28, scaleLengthPx + 20, 28);

    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(barStartX, barY);
    ctx.lineTo(barEndX, barY);
    ctx.stroke();

    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(barStartX, barY - 4);
    ctx.lineTo(barStartX, barY + 4);
    ctx.moveTo(barEndX, barY - 4);
    ctx.lineTo(barEndX, barY + 4);
    ctx.stroke();

    ctx.fillStyle = '#e5e7eb';
    ctx.font = '8px "Press Start 2P", monospace';
    ctx.fillText(formatScaleDistance(scaleLengthM), barStartX, barY - 16);
    ctx.fillText(`1 клетка ~ ${Math.round(gridStepM * 10) / 10} м`, barStartX, barY - 6);
    ctx.restore();
  }, [
    activeFloor.objects,
    displayGridStepM,
    dragPreview,
    hoverPoint,
    pendingPoint,
    scene.site_entities,
    selectedObject,
    selectedVertexIndex,
    toolMode,
    viewPan,
    viewZoom,
    worldViewport,
  ]);

  useEffect(() => {
    drawSceneCanvas();
  }, [canvasSize.height, canvasSize.width, drawSceneCanvas]);

  const handleCanvasClick = async (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    if (!selectedSessionId) {
      setActionError('Сначала выберите сессию');
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const localPoint = getCanvasLocalPoint(event);
    const rawWorldPoint = localCanvasToWorld(localPoint);

    setActionError('');

    if (isLessonStarted && toolMode !== 'NONE') {
      setActionError('Урок идет. Инструменты редактирования схемы отключены');
      return;
    }

    if (toolMode === 'NONE') {
      if (
        insertVertexMode &&
        selectedObject &&
        (selectedObject.geometry_type === 'LINESTRING' || selectedObject.geometry_type === 'POLYGON')
      ) {
        const selectedGeometry =
          dragPreview && dragPreview.objectId === selectedObject.id ? dragPreview.geometry : selectedObject.geometry;
        const sourcePoints = selectedGeometry.points ?? [];

        const worldUnitsPerPixel = (worldViewport.width / Math.max(1, canvas.width)) / Math.max(viewZoom, 1e-6);
        const segmentThreshold = Math.max(1.8, worldUnitsPerPixel * 16);
        const segment = findNearestSegment(
          rawWorldPoint,
          sourcePoints,
          selectedObject.geometry_type === 'POLYGON',
          segmentThreshold,
        );

        if (!segment) {
          return;
        }

        const insertPoint = applySnapAndConstraint(rawWorldPoint);
        const insertion = insertPointIntoSegment(
          sourcePoints,
          segment.segmentIndex,
          insertPoint,
          selectedObject.geometry_type === 'POLYGON',
        );

        setActionLoading('insert-vertex');
        try {
          await commitUpsertSceneObject(
            {
              floor_id: activeFloor.floor_id,
              object_id: selectedObject.id,
              kind: selectedObject.kind,
              geometry_type: selectedObject.geometry_type,
              geometry: { points: insertion.points },
              label: selectedObject.label || KIND_LABELS[selectedObject.kind],
              props: selectedObject.props ?? {},
            },
            { description: 'insert-vertex' },
          );

          setSelectedVertexIndex(insertion.insertIndex);
          showBanner('ВЕРШИНА ВСТАВЛЕНА');
        } catch (insertError) {
          setActionError(getErrorMessage(insertError, 'Не удалось вставить вершину'));
        } finally {
          setActionLoading(null);
        }
      }
      return;
    }

    if (toolMode === 'ERASE') {
      const worldUnitsPerPixel = (worldViewport.width / Math.max(1, canvas.width)) / Math.max(viewZoom, 1e-6);
      const eraseThreshold = Math.max(2, worldUnitsPerPixel * 18);
      const target = nearestObject(rawWorldPoint, activeFloor.objects, eraseThreshold);
      if (!target) {
        return;
      }
      setActionLoading('erase');
      try {
        await commitRemoveSceneObject(target, activeFloor.floor_id, { description: 'erase-object' });
      } catch (removeError) {
        setActionError(getErrorMessage(removeError, 'Не удалось удалить объект'));
      } finally {
        setActionLoading(null);
      }
      return;
    }

    if (toolMode === 'WALL' || toolMode === 'ROOM' || toolMode === 'SMOKE_ZONE') {
      if (!pendingPoint) {
        const firstPoint = applySnapAndConstraint(rawWorldPoint);
        setPendingPoint(firstPoint);
        setHoverPoint(firstPoint);
        return;
      }

      const worldPoint = applySnapAndConstraint(rawWorldPoint, {
        anchor: pendingPoint,
        forWall: toolMode === 'WALL',
      });

      const floorId = activeFloor.floor_id;
      setActionLoading('draw');
      try {
        if (toolMode === 'WALL') {
          await commitUpsertSceneObject(
            {
              floor_id: floorId,
              kind: 'WALL',
              geometry_type: 'LINESTRING',
              geometry: { points: [pendingPoint, worldPoint] },
              label: 'Стена',
            },
            { description: 'create-wall' },
          );
        } else {
          const polygon = buildRectanglePolygon(pendingPoint, worldPoint);
          await commitUpsertSceneObject(
            {
              floor_id: floorId,
              kind: toolMode === 'ROOM' ? 'ROOM' : 'SMOKE_ZONE',
              geometry_type: 'POLYGON',
              geometry: { points: polygon },
              label: toolMode === 'ROOM' ? 'Комната' : 'Зона дыма',
            },
            { description: toolMode === 'ROOM' ? 'create-room' : 'create-smoke-zone' },
          );
        }
        setPendingPoint(null);
        setHoverPoint(null);
      } catch (drawError) {
        setActionError(getErrorMessage(drawError, 'Не удалось добавить объект'));
      } finally {
        setActionLoading(null);
      }
      return;
    }

    const kind = toolMode as SceneKind;
    const worldPoint = applySnapAndConstraint(rawWorldPoint);
    const defaultLabels: Record<SceneKind, string> = {
      WALL: 'Стена',
      EXIT: 'Выход',
      STAIR: 'Лестница',
      ROOM: 'Комната',
      DOOR: 'Дверь',
      FIRE_SOURCE: 'Очаг',
      SMOKE_ZONE: 'Зона дыма',
      HYDRANT: 'Гидрант',
      WATER_SOURCE: 'Водоисточник',
    };

    setActionLoading('draw');
    try {
      await commitUpsertSceneObject(
        {
          floor_id: activeFloor.floor_id,
          kind,
          geometry_type: 'POINT',
          geometry: { x: worldPoint.x, y: worldPoint.y },
          label: defaultLabels[kind],
        },
        { description: `create-${kind.toLowerCase()}` },
      );
      setHoverPoint(null);
    } catch (pointError) {
      setActionError(getErrorMessage(pointError, 'Не удалось добавить точечный объект'));
    } finally {
      setActionLoading(null);
    }
  };

  const endCanvasInteraction = useCallback(() => {
    const interaction = interactionRef.current;
    if (!interaction) {
      return;
    }

    interactionRef.current = null;

    if (interaction.type === 'pan') {
      if (interaction.moved) {
        suppressNextClickRef.current = true;
      }
      setIsPanning(false);
      setIsObjectDragging(false);
      return;
    }

    setIsObjectDragging(false);
    if (!interaction.moved) {
      if (interaction.type === 'move-vertex') {
        setSelectedVertexIndex(interaction.vertexIndex);
      }
      setDragPreview(null);
      return;
    }

    suppressNextClickRef.current = true;
    const previewGeometry =
      dragPreview && dragPreview.objectId === interaction.objectId ? dragPreview.geometry : null;
    if (!previewGeometry) {
      setDragPreview(null);
      return;
    }

    setActionLoading('move-object');
    void (async () => {
      try {
        await commitUpsertSceneObject(
          {
            floor_id: interaction.floorId,
            object_id: interaction.objectId,
            kind: interaction.kind,
            geometry_type: interaction.geometryType,
            geometry: previewGeometry,
            label: interaction.label,
            props: interaction.props,
          },
          { description: interaction.type === 'move-vertex' ? 'move-vertex' : 'move-object' },
        );
        showBanner('ОБЪЕКТ ОБНОВЛЕН');
      } catch (updateError) {
        setActionError(getErrorMessage(updateError, 'Не удалось обновить объект'));
      } finally {
        setActionLoading(null);
        setDragPreview(null);
      }
    })();
  }, [commitUpsertSceneObject, dragPreview, showBanner]);

  const handleCanvasMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const localPoint = getCanvasLocalPoint(event);
    const worldPoint = localCanvasToWorld(localPoint);
    const panByModifier = event.button === 1 || event.button === 2 || event.shiftKey || event.altKey;

    if (isLessonStarted) {
      if (panByModifier) {
        event.preventDefault();
        interactionRef.current = {
          type: 'pan',
          startCanvas: localPoint,
          basePan: { ...viewPan },
          moved: false,
        };
        setIsPanning(true);
        return;
      }

      if (event.button !== 0) {
        return;
      }

      const canvasWidth = Math.max(1, canvas.width);
      const worldUnitsPerPixel = (worldViewport.width / canvasWidth) / Math.max(viewZoom, 1e-6);
      const objectPickThreshold = Math.max(2, worldUnitsPerPixel * 18);
      const targetObject = nearestObject(worldPoint, activeFloor.objects, objectPickThreshold);
      if (targetObject) {
        setSelectedObjectId(targetObject.id);
        setSelectedVertexIndex(null);
        setDragPreview(null);
      }
      return;
    }

    if (toolMode !== 'NONE') {
      if (!panByModifier) {
        return;
      }
      event.preventDefault();
      interactionRef.current = {
        type: 'pan',
        startCanvas: localPoint,
        basePan: { ...viewPan },
        moved: false,
      };
      setIsPanning(true);
      return;
    }

    if (panByModifier) {
      event.preventDefault();
      interactionRef.current = {
        type: 'pan',
        startCanvas: localPoint,
        basePan: { ...viewPan },
        moved: false,
      };
      setIsPanning(true);
      return;
    }

    if (insertVertexMode && event.button === 0) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    const worldUnitsPerPixel = (worldViewport.width / Math.max(1, canvas.width)) / Math.max(viewZoom, 1e-6);
    const objectPickThreshold = Math.max(2, worldUnitsPerPixel * 18);
    const vertexPickThreshold = Math.max(1.2, worldUnitsPerPixel * 13);

    if (selectedObject) {
      const selectedGeometry = dragPreview?.objectId === selectedObject.id ? dragPreview.geometry : selectedObject.geometry;
      const vertexCandidate = findNearestVertex(
        worldPoint,
        {
          ...selectedObject,
          geometry: selectedGeometry,
        },
        vertexPickThreshold,
      );
      if (vertexCandidate) {
        interactionRef.current = {
          type: 'move-vertex',
          objectId: selectedObject.id,
          floorId: activeFloor.floor_id,
          kind: selectedObject.kind,
          geometryType: selectedObject.geometry_type,
          label: selectedObject.label || KIND_LABELS[selectedObject.kind],
          props: selectedObject.props ?? {},
          startCanvas: localPoint,
          vertexIndex: vertexCandidate.index,
          originalGeometry: selectedGeometry,
          moved: false,
        };
        setSelectedVertexIndex(vertexCandidate.index);
        setIsObjectDragging(true);
        return;
      }
    }

    const targetObject = nearestObject(worldPoint, activeFloor.objects, objectPickThreshold);
    if (targetObject) {
      setSelectedObjectId(targetObject.id);
      setSelectedVertexIndex(null);
      const dragStartWorld = snapToGrid ? snapPointToGrid(worldPoint, displayGridStepM) : worldPoint;
      interactionRef.current = {
        type: 'move-object',
        objectId: targetObject.id,
        floorId: activeFloor.floor_id,
        kind: targetObject.kind,
        geometryType: targetObject.geometry_type,
        label: targetObject.label || KIND_LABELS[targetObject.kind],
        props: targetObject.props ?? {},
        startCanvas: localPoint,
        startWorld: dragStartWorld,
        originalGeometry: targetObject.geometry,
        moved: false,
      };
      setIsObjectDragging(true);
      return;
    }

    setSelectedObjectId(null);
    setSelectedVertexIndex(null);
    setDragPreview(null);
    setInsertVertexMode(false);
    interactionRef.current = {
      type: 'pan',
      startCanvas: localPoint,
      basePan: { ...viewPan },
      moved: false,
    };
    setIsPanning(true);
  };

  const handleCanvasMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const localPoint = getCanvasLocalPoint(event);
    const interaction = interactionRef.current;
    if (interaction) {
      const dxPixels = localPoint.x - interaction.startCanvas.x;
      const dyPixels = localPoint.y - interaction.startCanvas.y;
      if (Math.abs(dxPixels) > 2 || Math.abs(dyPixels) > 2) {
        interaction.moved = true;
      }

      if (interaction.type === 'pan') {
        setViewPan({
          x: interaction.basePan.x + dxPixels,
          y: interaction.basePan.y + dyPixels,
        });
        return;
      }

      const rawWorldPoint = localCanvasToWorld(localPoint);

      if (interaction.type === 'move-object') {
        const snappedWorldPoint = snapToGrid ? snapPointToGrid(rawWorldPoint, displayGridStepM) : rawWorldPoint;
        const deltaX = snappedWorldPoint.x - interaction.startWorld.x;
        const deltaY = snappedWorldPoint.y - interaction.startWorld.y;
        setDragPreview({
          objectId: interaction.objectId,
          geometry: translateGeometry(
            interaction.geometryType,
            interaction.originalGeometry,
            deltaX,
            deltaY,
          ),
        });
        return;
      }

      if (interaction.type === 'move-vertex') {
        const snappedWorldPoint = snapToGrid ? snapPointToGrid(rawWorldPoint, displayGridStepM) : rawWorldPoint;
        setDragPreview({
          objectId: interaction.objectId,
          geometry: updateGeometryVertex(
            interaction.geometryType,
            interaction.originalGeometry,
            interaction.vertexIndex,
            snappedWorldPoint,
          ),
        });
      }
      return;
    }

    if (pendingPoint && (toolMode === 'WALL' || toolMode === 'ROOM' || toolMode === 'SMOKE_ZONE')) {
      const hoverRawPoint = localCanvasToWorld(localPoint);
      const processedPoint = applySnapAndConstraint(hoverRawPoint, {
        anchor: pendingPoint,
        forWall: toolMode === 'WALL',
      });
      setHoverPoint(processedPoint);
    }
  };

  const handleCanvasMouseUp = () => {
    endCanvasInteraction();
  };

  const handleCanvasMouseLeave = () => {
    endCanvasInteraction();
  };

  const handleCanvasWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const anchor = getCanvasLocalPoint(event);
    if (event.deltaY < 0) {
      zoomAtCanvasPoint(viewZoom * 1.1, anchor);
    } else {
      zoomAtCanvasPoint(viewZoom / 1.1, anchor);
    }
  };

  useEffect(() => {
    const onWindowMouseUp = () => {
      endCanvasInteraction();
    };
    window.addEventListener('mouseup', onWindowMouseUp);
    return () => {
      window.removeEventListener('mouseup', onWindowMouseUp);
    };
  }, [endCanvasInteraction]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inTextControl =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (inTextControl) {
        return;
      }

      if (event.key === 'Escape') {
        setPendingPoint(null);
        setHoverPoint(null);
        setSelectedVertexIndex(null);
        setDragPreview(null);
        setIsPanning(false);
        setIsObjectDragging(false);
        interactionRef.current = null;
        return;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedObject) {
        if (isLessonStarted) {
          event.preventDefault();
          setActionError('Во время урока удаление объектов схемы отключено');
          return;
        }
        event.preventDefault();
        void commitRemoveSceneObject(selectedObject, activeFloor.floor_id, { description: 'remove-selected-object' }).catch((removeError) => {
          setActionError(getErrorMessage(removeError, 'Не удалось удалить объект'));
        });
        return;
      }

      if (event.key.toLowerCase() === 'g' && !isLessonStarted) {
        event.preventDefault();
        setSnapToGrid((previous) => !previous);
        return;
      }

      if (event.key.toLowerCase() === 'a' && !isLessonStarted) {
        event.preventDefault();
        setLockWallAngle((previous) => !previous);
        return;
      }

      if (event.key.toLowerCase() === 'v' && canInsertVertex && !isLessonStarted) {
        event.preventDefault();
        setInsertVertexMode((previous) => !previous);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd' && selectedObject) {
        if (isLessonStarted) {
          event.preventDefault();
          setActionError('Во время урока дублирование схемы отключено');
          return;
        }
        event.preventDefault();
        void handleDuplicateObject(selectedObject);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        if (isLessonStarted) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        if (event.shiftKey) {
          void handleRedo();
        } else {
          void handleUndo();
        }
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        if (isLessonStarted) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        void handleRedo();
        return;
      }

      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        resetView();
        return;
      }

      if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        const canvas = canvasRef.current;
        if (!canvas) {
          return;
        }
        zoomAtCanvasPoint(viewZoom * 1.15, { x: canvas.width / 2, y: canvas.height / 2 });
        return;
      }

      if (event.key === '-') {
        event.preventDefault();
        const canvas = canvasRef.current;
        if (!canvas) {
          return;
        }
        zoomAtCanvasPoint(viewZoom / 1.15, { x: canvas.width / 2, y: canvas.height / 2 });
        return;
      }

      const panStep = 32;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setViewPan((previous) => ({ ...previous, x: previous.x + panStep }));
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        setViewPan((previous) => ({ ...previous, x: previous.x - panStep }));
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setViewPan((previous) => ({ ...previous, y: previous.y + panStep }));
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setViewPan((previous) => ({ ...previous, y: previous.y - panStep }));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    activeFloor.floor_id,
    canInsertVertex,
    commitRemoveSceneObject,
    handleDuplicateObject,
    handleRedo,
    handleUndo,
    isLessonStarted,
    resetView,
    selectedObject,
    viewZoom,
    zoomAtCanvasPoint,
  ]);

  const handleSessionChange = (nextSessionId: string) => {
    setSelectedSessionId(nextSessionId);
    resetView();
    setPendingPoint(null);
    setHoverPoint(null);
    setSelectedObjectId(null);
    setSelectedVertexIndex(null);
    setDragPreview(null);
    setInsertVertexMode(false);
    setUndoStack([]);
    setRedoStack([]);
    setIsPanning(false);
    setIsObjectDragging(false);
    interactionRef.current = null;
    suppressNextClickRef.current = false;
    if (nextSessionId) {
      void handleSetCurrentSession(nextSessionId);
      void loadBundleForSession(nextSessionId);
      connectRealtime(nextSessionId);
    } else {
      setBundle(null);
    }
  };

  const toggleSidebarSection = useCallback((sectionKey: SidebarSectionKey) => {
    setSidebarSectionsOpen((previous) => ({
      ...previous,
      [sectionKey]: !previous[sectionKey],
    }));
  }, []);

  const setAllSidebarSections = useCallback((open: boolean) => {
    setSidebarSectionsOpen((previous) => {
      const next: Record<SidebarSectionKey, boolean> = { ...previous };
      (Object.keys(next) as SidebarSectionKey[]).forEach((sectionKey) => {
        next[sectionKey] = open;
      });
      return next;
    });
  }, []);

  const renderSidebarSection = useCallback(
    (sectionKey: SidebarSectionKey, title: string, children: ReactNode) => {
      const isOpen = sidebarSectionsOpen[sectionKey];

      return (
        <section className="bg-[#303030] border-2 border-black p-3">
          <button
            type="button"
            className="w-full flex items-center justify-between gap-2 text-left"
            onClick={() => {
              toggleSidebarSection(sectionKey);
            }}
          >
            <span className="text-[10px] uppercase text-white">{title}</span>
            <span className="text-[10px] text-gray-300">{isOpen ? '−' : '+'}</span>
          </button>

          {isOpen ? <div className="mt-2 space-y-2">{children}</div> : null}
        </section>
      );
    },
    [sidebarSectionsOpen, toggleSidebarSection],
  );

  if (isLessonCompleted) {
    return <TrainingCompletionReport bundle={bundle} />;
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      <aside className="w-[360px] h-full bg-[#2b2b2b] border-r-2 border-black overflow-y-auto custom-scrollbar p-3 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <PixelButton
            variant="default"
            className="text-[7px]"
            onClick={() => {
              setAllSidebarSections(true);
            }}
          >
            РАЗВЕРНУТЬ ВСЕ
          </PixelButton>
          <PixelButton
            variant="default"
            className="text-[7px]"
            onClick={() => {
              setAllSidebarSections(false);
            }}
          >
            СВЕРНУТЬ ВСЕ
          </PixelButton>
        </div>

        {renderSidebarSection(
          'session',
          'СЕССИЯ',
          <>
            <select
              className={FIELD_CLASS}
              value={selectedSessionId}
              onChange={(event) => {
                handleSessionChange(event.target.value);
              }}
            >
              {sessions.map((sessionItem) => (
                <option key={sessionItem.id} value={sessionItem.id}>
                  {sessionItem.scenario_name} ({sessionItem.status})
                </option>
              ))}
              {sessions.length === 0 ? <option value="">Нет сессий</option> : null}
            </select>

            <div className="text-[7px] text-gray-400">Сессия переключается сразу при выборе.</div>
          </>,
        )}

        {renderSidebarSection(
          'lesson',
          'ПАРАМЕТРЫ УРОКА',
          <>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[7px] text-gray-300 mb-1 uppercase">Лимит, мин</div>
                <PixelInput
                  type="number"
                  min={5}
                  max={360}
                  className={FIELD_CLASS}
                  value={lessonTimeLimitMinDraft}
                  onChange={(event) => {
                    const numeric = Number(event.target.value) || 30;
                    setLessonTimeLimitMinDraft(Math.max(5, Math.min(360, Math.round(numeric))));
                  }}
                  disabled={isLessonStarted}
                />
              </div>
              <div>
                <div className="text-[7px] text-gray-300 mb-1 uppercase">Игровой старт</div>
                <div className="grid grid-cols-[1fr_auto_1fr] gap-1 items-center">
                  <PixelInput
                    type="number"
                    min={0}
                    max={23}
                    className={FIELD_CLASS}
                    value={lessonStartHourDraft}
                    onChange={(event) => {
                      const numeric = Number(event.target.value) || 0;
                      setLessonStartHourDraft(Math.max(0, Math.min(23, Math.round(numeric))));
                    }}
                    disabled={isLessonStarted}
                  />
                  <span className="text-[8px] text-gray-300 text-center">:</span>
                  <PixelInput
                    type="number"
                    min={0}
                    max={59}
                    className={FIELD_CLASS}
                    value={lessonStartMinuteDraft}
                    onChange={(event) => {
                      const numeric = Number(event.target.value) || 0;
                      setLessonStartMinuteDraft(Math.max(0, Math.min(59, Math.round(numeric))));
                    }}
                    disabled={isLessonStarted}
                  />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
              <div>
                <div className="text-[7px] text-gray-300 mb-1 uppercase">Ускорение времени (x)</div>
                <PixelInput
                  type="number"
                  min={0.1}
                  max={30}
                  step={0.1}
                  className={FIELD_CLASS}
                  value={timeMultiplierDraft}
                  onChange={(event) => {
                    const numeric = Number(event.target.value) || 1;
                    setTimeMultiplierDraft(Math.max(0.1, Math.min(30, Math.round(numeric * 10) / 10)));
                  }}
                />
              </div>
              <PixelButton
                variant="green"
                className="text-[7px] h-7 px-2"
                onClick={() => {
                  void handleApplyTimeMultiplier();
                }}
                disabled={!selectedSessionId || actionLoading === 'time-multiplier'}
              >
                {actionLoading === 'time-multiplier' ? '...' : 'ПРИМЕНИТЬ'}
              </PixelButton>
            </div>
            <div className="text-[7px] text-gray-400">После старта отсчет и игровое время идут автоматически на всех экранах.</div>
          </>,
        )}

        {renderSidebarSection(
          'vehicle',
          'ТЕХНИКА: ХАРАКТЕРИСТИКИ',
          <>
            <select
              className={FIELD_CLASS}
              value={selectedVehicleConfigId ?? ''}
              onChange={(event) => {
                const value = Number(event.target.value);
                setSelectedVehicleConfigId(Number.isFinite(value) ? value : null);
              }}
              disabled={vehicleDictionary.length === 0}
            >
              {vehicleDictionary.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.name}
                </option>
              ))}
              {vehicleDictionary.length === 0 ? <option value="">Нет машин</option> : null}
            </select>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[7px] text-gray-300 mb-1 uppercase">Экипаж</div>
                <PixelInput
                  type="number"
                  min={1}
                  className={FIELD_CLASS}
                  value={vehicleSpecDraft.crew_size}
                  onChange={(event) => {
                    setVehicleSpecDraft((previous) => ({
                      ...previous,
                      crew_size: Math.max(1, Math.round(Number(event.target.value) || 1)),
                    }));
                  }}
                  disabled={isLessonStarted || !selectedVehicleConfig}
                />
              </div>
              <div>
                <div className="text-[7px] text-gray-300 mb-1 uppercase">Вода, л</div>
                <PixelInput
                  type="number"
                  min={0}
                  className={FIELD_CLASS}
                  value={vehicleSpecDraft.water_capacity}
                  onChange={(event) => {
                    setVehicleSpecDraft((previous) => ({
                      ...previous,
                      water_capacity: Math.max(0, Math.round(Number(event.target.value) || 0)),
                    }));
                  }}
                  disabled={isLessonStarted || !selectedVehicleConfig}
                />
              </div>
              <div>
                <div className="text-[7px] text-gray-300 mb-1 uppercase">Пена, л</div>
                <PixelInput
                  type="number"
                  min={0}
                  className={FIELD_CLASS}
                  value={vehicleSpecDraft.foam_capacity}
                  onChange={(event) => {
                    setVehicleSpecDraft((previous) => ({
                      ...previous,
                      foam_capacity: Math.max(0, Math.round(Number(event.target.value) || 0)),
                    }));
                  }}
                  disabled={isLessonStarted || !selectedVehicleConfig}
                />
              </div>
              <div>
                <div className="text-[7px] text-gray-300 mb-1 uppercase">Рукава, м</div>
                <PixelInput
                  type="number"
                  min={0}
                  className={FIELD_CLASS}
                  value={vehicleSpecDraft.hose_length}
                  onChange={(event) => {
                    setVehicleSpecDraft((previous) => ({
                      ...previous,
                      hose_length: Math.max(0, Math.round(Number(event.target.value) || 0)),
                    }));
                  }}
                  disabled={isLessonStarted || !selectedVehicleConfig}
                />
              </div>
            </div>

            <PixelButton
              variant="green"
              className="w-full text-[7px]"
              onClick={() => {
                void handleSaveVehicleSpecs();
              }}
              disabled={isLessonStarted || !selectedVehicleConfig || actionLoading === 'vehicle-specs'}
            >
              {actionLoading === 'vehicle-specs' ? 'СОХРАНЕНИЕ...' : 'СОХРАНИТЬ ХАРАКТЕРИСТИКИ'}
            </PixelButton>
          </>,
        )}

        {renderSidebarSection(
          'address',
          'АДРЕС УЧАСТКА',
          <>
            {isLessonStarted ? (
              <div className="text-[7px] text-gray-300 border border-black/50 bg-black/20 px-2 py-2">
                Урок запущен. Адресный редактор скрыт до завершения занятия.
              </div>
            ) : (
              <>
                <PixelInput
                  className={FIELD_CLASS}
                  value={addressDraft.addressText}
                  onChange={(event) => {
                    setAddressDraft((previous) => ({ ...previous, addressText: event.target.value }));
                  }}
                  placeholder="г. Москва, ул..."
                  disabled={actionLoading === 'set-address'}
                />
                <PixelInput
                  className={FIELD_CLASS}
                  value={addressDraft.karta01Url}
                  onChange={(event) => {
                    setAddressDraft((previous) => ({ ...previous, karta01Url: event.target.value }));
                  }}
                  placeholder="https://karta01.ru/#..."
                  disabled={actionLoading === 'set-address'}
                />
                <div>
                  <div className="text-[7px] text-gray-300 mb-1 uppercase">Радиус, м</div>
                  <PixelInput
                    type="number"
                    min={50}
                    max={1000}
                    className={FIELD_CLASS}
                    value={addressDraft.radiusM}
                    onChange={(event) => {
                      const numeric = Number(event.target.value) || 200;
                      setAddressDraft((previous) => ({ ...previous, radiusM: Math.max(50, Math.min(1000, numeric)) }));
                    }}
                    disabled={actionLoading === 'set-address'}
                  />
                </div>

                <PixelButton
                  variant="green"
                  className="w-full text-[8px]"
                  onClick={() => {
                    void handleApplyAddress();
                  }}
                  disabled={!selectedSessionId || actionLoading === 'set-address'}
                >
                  {actionLoading === 'set-address' ? 'ПОСТРОЕНИЕ...' : 'ПОСТРОИТЬ УЧАСТОК'}
                </PixelButton>
              </>
            )}

            <div className="text-[7px] text-gray-300 leading-relaxed">
              После построения участок готов к работе по тактической схеме.
            </div>
          </>,
        )}

        {renderSidebarSection(
          'floors',
          'ЭТАЖИ И ИНСТРУМЕНТЫ',
          <>
            {isLessonStarted ? (
              <>
                <div className="text-[7px] text-gray-300 border border-black/50 bg-black/20 px-2 py-2 leading-relaxed">
                  Редактор схемы скрыт на время урока. Доступны только просмотр и runtime-события.
                </div>
                <div className="text-[7px] text-gray-400">Активный этаж: {activeFloor.floor_id}</div>
                <div className="text-[7px] text-gray-500">
                  Навигация: Shift/Alt + drag (панорама), колесо (+/-), F (сброс масштаба).
                </div>
              </>
            ) : (
              <>
                <div>
                  <div className="text-[7px] text-gray-300 mb-1 uppercase">Активный этаж</div>
                  <select
                    className={FIELD_CLASS}
                    value={activeFloorIdDraft}
                    onChange={(event) => {
                      const value = normalizeFloorId(event.target.value);
                      setActiveFloorIdDraft(value);
                      void handleSetActiveFloor(value);
                    }}
                  >
                    {scene.floors.map((floor) => (
                      <option key={floor.floor_id} value={floor.floor_id}>
                        {floor.floor_id}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <PixelInput
                    className={FIELD_CLASS}
                    value={newFloorId}
                    onChange={(event) => {
                      setNewFloorId(event.target.value);
                    }}
                    placeholder="F2"
                  />
                  <PixelButton
                    variant="default"
                    className="text-[7px] px-2"
                    onClick={() => {
                      void handleAddFloor();
                    }}
                    disabled={actionLoading === 'add-floor'}
                  >
                    {actionLoading === 'add-floor' ? '...' : 'ДОБАВИТЬ'}
                  </PixelButton>
                </div>

                <div className="grid grid-cols-2 gap-1">
                  {QUICK_TOOL_ORDER.map((tool) => (
                    <PixelButton
                      key={tool}
                      variant={toolMode === tool ? 'active' : 'default'}
                      className="text-[7px] h-7"
                      onClick={() => {
                        selectTool(tool);
                      }}
                    >
                      [{TOOL_ICONS[tool]}] {TOOL_LABELS[tool]}
                    </PixelButton>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <PixelButton
                    variant={snapToGrid ? 'active' : 'default'}
                    className="text-[7px]"
                    onClick={() => {
                      setSnapToGrid((previous) => !previous);
                    }}
                  >
                    SNAP СЕТКА
                  </PixelButton>
                  <PixelButton
                    variant={lockWallAngle ? 'active' : 'default'}
                    className="text-[7px]"
                    onClick={() => {
                      setLockWallAngle((previous) => !previous);
                    }}
                  >
                    УГОЛ 45°
                  </PixelButton>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <PixelButton
                    variant="default"
                    className="text-[7px]"
                    onClick={() => {
                      void handleUndo();
                    }}
                    disabled={undoStack.length === 0 || actionLoading === 'undo' || actionLoading === 'redo'}
                  >
                    ОТМЕНА
                  </PixelButton>
                  <PixelButton
                    variant="default"
                    className="text-[7px]"
                    onClick={() => {
                      void handleRedo();
                    }}
                    disabled={redoStack.length === 0 || actionLoading === 'undo' || actionLoading === 'redo'}
                  >
                    ПОВТОР
                  </PixelButton>
                  <PixelButton
                    variant={insertVertexMode ? 'active' : 'default'}
                    className="text-[7px]"
                    onClick={() => {
                      setInsertVertexMode((previous) => !previous);
                    }}
                    disabled={!canInsertVertex}
                  >
                    + ВЕРШИНА
                  </PixelButton>
                </div>

                <div className="text-[7px] text-gray-300 leading-relaxed">
                  {toolMode === 'NONE'
                    ? 'Камера: drag + wheel. ЛКМ по объекту - выделить/переместить, по вершине - правка.'
                    : pendingPoint
                      ? 'Укажите вторую точку.'
                      : toolMode === 'WALL' || toolMode === 'ROOM' || toolMode === 'SMOKE_ZONE'
                        ? 'Инструмент требует 2 клика.'
                        : 'Клик добавляет точечный объект.'}
                </div>
                <div className="text-[7px] text-gray-500">
                  Сетка: {displayGridStepM}м | Горячие клавиши: Del, Ctrl/Cmd+D, Ctrl/Cmd+Z/Y, F, G (snap), A (угол), V (вершина).
                </div>
                <div className="text-[7px] text-gray-500">
                  История: {undoStack.length} шагов | redo: {redoStack.length}
                  {insertVertexMode ? ' | режим вставки вершины: включен' : ''}
                </div>
              </>
            )}
          </>,
        )}

        {renderSidebarSection(
          'object',
          'СВОЙСТВА ОБЪЕКТА',
          <>
            {isLessonStarted ? (
              !selectedObject ? (
                <div className="text-[7px] text-gray-400">Выберите объект для runtime-событий (например, стену или гидрант).</div>
              ) : (
                <div className="space-y-1 text-[7px] text-gray-300">
                  <div>ID: {selectedObject.id}</div>
                  <div>Тип: {KIND_LABELS[selectedObject.kind]} / {selectedObject.geometry_type}</div>
                  <div>Название: {selectedObject.label || KIND_LABELS[selectedObject.kind]}</div>
                </div>
              )
            ) : !selectedObject ? (
              <div className="text-[7px] text-gray-400">Выберите объект на карте или в списке.</div>
            ) : (
              <>
                <div className="text-[7px] text-gray-300">
                  ID: {selectedObject.id} | Геометрия: {selectedObject.geometry_type}
                </div>

                <div>
                  <div className="text-[7px] text-gray-300 mb-1 uppercase">Название</div>
                  <PixelInput
                    className={FIELD_CLASS}
                    value={selectedLabelDraft}
                    onChange={(event) => {
                      setSelectedLabelDraft(event.target.value);
                    }}
                  />
                </div>

                <div>
                  <div className="text-[7px] text-gray-300 mb-1 uppercase">Тип</div>
                  <select
                    className={FIELD_CLASS}
                    value={selectedKindDraft}
                    onChange={(event) => {
                      setSelectedKindDraft(event.target.value as SceneKind);
                    }}
                  >
                    {(Object.keys(KIND_LABELS) as SceneKind[]).map((kind) => (
                      <option key={kind} value={kind}>
                        {KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                </div>

                {isFireObjectDraft ? (
                  <div className="space-y-2 border border-black/50 bg-black/20 p-2">
                    <div className="text-[7px] text-amber-200 uppercase">Параметры огня/дыма</div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className="text-[7px] text-gray-300 mb-1 uppercase">Площадь м2</div>
                        <PixelInput
                          type="number"
                          min={1}
                          className={FIELD_CLASS}
                          value={firePropsDraft.fireAreaM2}
                          onChange={(event) => {
                            setFirePropsDraft((previous) => ({
                              ...previous,
                              fireAreaM2: Math.max(1, Number(event.target.value) || 1),
                            }));
                          }}
                        />
                      </div>
                      <div>
                        <div className="text-[7px] text-gray-300 mb-1 uppercase">Скорость м/мин</div>
                        <PixelInput
                          type="number"
                          min={0.1}
                          step={0.1}
                          className={FIELD_CLASS}
                          value={firePropsDraft.spreadSpeedMMin}
                          onChange={(event) => {
                            setFirePropsDraft((previous) => ({
                              ...previous,
                              spreadSpeedMMin: Math.max(0.1, Number(event.target.value) || 0.1),
                            }));
                          }}
                        />
                      </div>
                      <div>
                        <div className="text-[7px] text-gray-300 mb-1 uppercase">Азимут</div>
                        <PixelInput
                          type="number"
                          min={0}
                          max={359}
                          className={FIELD_CLASS}
                          value={firePropsDraft.spreadAzimuth}
                          onChange={(event) => {
                            const next = Math.max(0, Math.min(359, Math.round(Number(event.target.value) || 0)));
                            setFirePropsDraft((previous) => ({
                              ...previous,
                              spreadAzimuth: next,
                            }));
                          }}
                        />
                      </div>
                      <div>
                        <div className="text-[7px] text-gray-300 mb-1 uppercase">Плотность дыма</div>
                        <PixelInput
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          className={FIELD_CLASS}
                          value={firePropsDraft.smokeDensity}
                          onChange={(event) => {
                            const next = Math.max(0, Math.min(1, Number(event.target.value) || 0));
                            setFirePropsDraft((previous) => ({
                              ...previous,
                              smokeDensity: next,
                            }));
                          }}
                        />
                      </div>
                      <div>
                        <div className="text-[7px] text-gray-300 mb-1 uppercase">Ранг очага</div>
                        <PixelInput
                          type="number"
                          min={1}
                          max={5}
                          step={1}
                          className={FIELD_CLASS}
                          value={firePropsDraft.fireRank}
                          onChange={(event) => {
                            const next = Math.max(1, Math.min(5, Math.round(Number(event.target.value) || 1)));
                            setFirePropsDraft((previous) => ({
                              ...previous,
                              fireRank: next,
                            }));
                          }}
                        />
                      </div>
                      <div>
                        <div className="text-[7px] text-gray-300 mb-1 uppercase">Сила очага</div>
                        <PixelInput
                          type="number"
                          min={0.35}
                          max={4}
                          step={0.05}
                          className={FIELD_CLASS}
                          value={firePropsDraft.firePower}
                          onChange={(event) => {
                            const next = Math.max(0.35, Math.min(4, Number(event.target.value) || 0.35));
                            setFirePropsDraft((previous) => ({
                              ...previous,
                              firePower: next,
                            }));
                          }}
                        />
                      </div>
                    </div>

                    <label className="flex items-center gap-2 text-[7px] text-gray-200 uppercase">
                      <input
                        type="checkbox"
                        className="h-3 w-3 accent-emerald-500"
                        checked={firePropsDraft.isActive}
                        onChange={(event) => {
                          setFirePropsDraft((previous) => ({
                            ...previous,
                            isActive: event.target.checked,
                          }));
                        }}
                      />
                      Активный очаг/дым
                    </label>
                  </div>
                ) : (
                  <div>
                    <div className="text-[7px] text-gray-300 mb-1 uppercase">Props (JSON)</div>
                    <textarea
                      className="w-full min-h-[80px] bg-[#454545] border-2 border-black px-2 py-1 text-[7px] text-white outline-none resize-y focus:border-gray-400"
                      value={selectedPropsDraft}
                      onChange={(event) => {
                        setSelectedPropsDraft(event.target.value);
                        setSelectedPropsError('');
                      }}
                    />
                    {selectedPropsError ? <div className="text-[7px] text-red-400 mt-1">{selectedPropsError}</div> : null}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <PixelButton
                    variant="green"
                    className="text-[7px]"
                    onClick={() => {
                      void handleApplySelectedProperties();
                    }}
                    disabled={actionLoading === 'save-properties'}
                  >
                    {actionLoading === 'save-properties' ? 'СОХРАН...' : 'ПРИМЕНИТЬ'}
                  </PixelButton>
                  <PixelButton
                    variant="default"
                    className="text-[7px]"
                    onClick={() => {
                      if (!selectedObject) {
                        return;
                      }
                      setSelectedLabelDraft(selectedObject.label || KIND_LABELS[selectedObject.kind]);
                      setSelectedKindDraft(selectedObject.kind);
                      const props = selectedObject.props ?? {};
                      setFirePropsDraft({
                        fireAreaM2: Math.max(1, numberOrFallback(props.fire_area_m2 ?? props.area_m2, DEFAULT_FIRE_PROPS_DRAFT.fireAreaM2)),
                        spreadSpeedMMin: Math.max(
                          0.1,
                          numberOrFallback(props.spread_speed_m_min ?? props.fire_spread_speed_m_min, DEFAULT_FIRE_PROPS_DRAFT.spreadSpeedMMin),
                        ),
                        spreadAzimuth: Math.max(
                          0,
                          Math.min(359, Math.round(numberOrFallback(props.spread_azimuth, DEFAULT_FIRE_PROPS_DRAFT.spreadAzimuth))),
                        ),
                        smokeDensity: Math.max(0, Math.min(1, numberOrFallback(props.smoke_density, DEFAULT_FIRE_PROPS_DRAFT.smokeDensity))),
                        fireRank: Math.max(1, Math.min(5, Math.round(numberOrFallback(props.fire_rank, DEFAULT_FIRE_PROPS_DRAFT.fireRank)))),
                        firePower: Math.max(0.35, Math.min(4, numberOrFallback(props.fire_power, DEFAULT_FIRE_PROPS_DRAFT.firePower))),
                        isActive: boolOrFallback(props.is_active, true),
                      });
                      try {
                        setSelectedPropsDraft(JSON.stringify(props, null, 2));
                      } catch {
                        setSelectedPropsDraft('{}');
                      }
                      setSelectedPropsError('');
                    }}
                  >
                    СБРОСИТЬ
                  </PixelButton>
                </div>
              </>
            )}
          </>,
        )}

        {renderSidebarSection(
          'conditions',
          'СТАРТОВЫЕ УСЛОВИЯ',
          <>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[7px] text-gray-300 mb-1 uppercase">Ветер м/с</div>
                <PixelInput
                  type="number"
                  className={FIELD_CLASS}
                  value={weatherDraft.wind_speed}
                  onChange={(event) => {
                    setWeatherDraft((previous) => ({ ...previous, wind_speed: Number(event.target.value) || 0 }));
                  }}
                />
              </div>
              <div>
                <div className="text-[7px] text-gray-300 mb-1 uppercase">Напр. °</div>
                <PixelInput
                  type="number"
                  min={0}
                  max={359}
                  className={FIELD_CLASS}
                  value={weatherDraft.wind_dir}
                  onChange={(event) => {
                    setWeatherDraft((previous) => ({ ...previous, wind_dir: Number(event.target.value) || 0 }));
                  }}
                />
              </div>
            </div>

            <div>
              <div className="text-[7px] text-gray-300 mb-1 uppercase">Температура °C</div>
              <PixelInput
                type="number"
                className={FIELD_CLASS}
                value={weatherDraft.temperature}
                onChange={(event) => {
                  setWeatherDraft((previous) => ({ ...previous, temperature: Number(event.target.value) || 0 }));
                }}
                />
            </div>

            <div>
              <div className="text-[7px] text-gray-300 mb-1 uppercase">Макс. длина рукава (м)</div>
              <PixelInput
                type="number"
                min={10}
                max={200}
                step={1}
                className={FIELD_CLASS}
                value={maxHoseLength}
                onChange={(event) => {
                  setMaxHoseLength(Number(event.target.value) || 40);
                }}
              />
            </div>

            <PixelButton
              variant="green"
              className="w-full text-[7px]"
              onClick={() => {
                void handleApplyWeather();
              }}
              disabled={actionLoading === 'update-weather'}
            >
              {actionLoading === 'update-weather' ? '...' : 'ПРИМЕНИТЬ'}
            </PixelButton>
          </>,
        )}

        {renderSidebarSection(
          'events',
          'ОПЕРАТИВНЫЕ СОБЫТИЯ',
          <>
            <div className="text-[7px] text-gray-300">
              {isLessonStarted
                ? 'Во время урока доступны сценарные события и управление водоснабжением.'
                : 'До старта можно заранее настроить гидранты.'}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <PixelButton
                variant="default"
                className="text-[7px]"
                onClick={() => {
                  void handleEscalateFire();
                }}
                disabled={!isLessonStarted || actionLoading === 'worsen-fire'}
              >
                {actionLoading === 'worsen-fire' ? '...' : 'УСИЛИТЬ ПОЖАР'}
              </PixelButton>
              <PixelButton
                variant="default"
                className="text-[7px]"
                onClick={() => {
                  void handleCollapseSelectedWall();
                }}
                disabled={
                  !isLessonStarted ||
                  !selectedObject ||
                  selectedObject.kind !== 'WALL' ||
                  actionLoading === 'collapse-wall'
                }
              >
                {actionLoading === 'collapse-wall' ? '...' : 'ОБРУШИТЬ СТЕНУ'}
              </PixelButton>
            </div>

            <div className="border-t border-black/50 pt-2 space-y-2">
              <div className="text-[8px] uppercase text-gray-200">Гидрант</div>
              {selectedHydrantObject ? (
                <div className="text-[7px] text-amber-200">
                  Выбран: {selectedHydrantObject.label || KIND_LABELS[selectedHydrantObject.kind]} ({selectedHydrantObject.id})
                </div>
              ) : (
                <div className="text-[7px] text-gray-400">Выберите гидрант на схеме.</div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[7px] text-gray-300 mb-1 uppercase">Расход л/с</div>
                  <PixelInput
                    type="number"
                    min={0}
                    className={FIELD_CLASS}
                    value={hydrantFlowDraft}
                    onChange={(event) => {
                      setHydrantFlowDraft(Math.max(0, Number(event.target.value) || 0));
                    }}
                    disabled={!canEditHydrantRuntime || actionLoading === 'hydrant-runtime'}
                  />
                </div>
                <div>
                  <div className="text-[7px] text-gray-300 mb-1 uppercase">Давление бар</div>
                  <PixelInput
                    type="number"
                    min={0}
                    className={FIELD_CLASS}
                    value={hydrantPressureDraft}
                    onChange={(event) => {
                      setHydrantPressureDraft(Math.max(0, Number(event.target.value) || 0));
                    }}
                    disabled={!canEditHydrantRuntime || actionLoading === 'hydrant-runtime'}
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-[7px] text-gray-200 uppercase">
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-emerald-500"
                  checked={hydrantOperationalDraft}
                  onChange={(event) => {
                    setHydrantOperationalDraft(event.target.checked);
                  }}
                  disabled={!canEditHydrantRuntime || actionLoading === 'hydrant-runtime'}
                />
                Исправен
              </label>

              <PixelButton
                variant="green"
                className="w-full text-[7px]"
                onClick={() => {
                  void handleApplyHydrantRuntime();
                }}
                disabled={!canEditHydrantRuntime || actionLoading === 'hydrant-runtime'}
              >
                {actionLoading === 'hydrant-runtime' ? 'ОБНОВЛЕНИЕ...' : 'ПРИМЕНИТЬ ПАРАМЕТРЫ ГИДРАНТА'}
              </PixelButton>
            </div>

            <div className="border-t border-black/50 pt-2 space-y-2">
              <div className="text-[8px] uppercase text-gray-200">Поломка техники</div>
              {activeVehicleDeployments.length === 0 ? (
                <div className="text-[7px] text-gray-400">Нет машин на позиции для сценария поломки.</div>
              ) : (
                <>
                  <select
                    className={FIELD_CLASS}
                    value={selectedVehicleFailureId}
                    onChange={(event) => {
                      setSelectedVehicleFailureId(event.target.value);
                    }}
                    disabled={!isLessonStarted || actionLoading === 'vehicle-failure'}
                  >
                    {activeVehicleDeployments.map((deployment) => (
                      <option key={deployment.deploymentId} value={deployment.deploymentId}>
                        {deployment.label} ({deployment.status})
                      </option>
                    ))}
                  </select>
                  <PixelButton
                    variant="default"
                    className="w-full text-[7px]"
                    onClick={() => {
                      void handleSetVehicleFailure();
                    }}
                    disabled={!canSetVehicleFailure || actionLoading === 'vehicle-failure'}
                  >
                    {actionLoading === 'vehicle-failure' ? '...' : 'ОТМЕТИТЬ ПОЛОМКУ'}
                  </PixelButton>
                </>
              )}

              <div className="border-t border-black/40 pt-2 space-y-2">
                <div className="text-[8px] uppercase text-gray-200">Восстановление техники</div>
                {failedVehicleDeployments.length === 0 ? (
                  <div className="text-[7px] text-gray-400">Нет машин в статусе поломки.</div>
                ) : (
                  <>
                    <select
                      className={FIELD_CLASS}
                      value={selectedVehicleRepairId}
                      onChange={(event) => {
                        setSelectedVehicleRepairId(event.target.value);
                      }}
                      disabled={!isLessonStarted || actionLoading === 'vehicle-repair'}
                    >
                      {failedVehicleDeployments.map((deployment) => (
                        <option key={deployment.deploymentId} value={deployment.deploymentId}>
                          {deployment.label}
                        </option>
                      ))}
                    </select>
                    <PixelButton
                      variant="green"
                      className="w-full text-[7px]"
                      onClick={() => {
                        void handleRepairVehicleFailure();
                      }}
                      disabled={!canRepairVehicleFailure || actionLoading === 'vehicle-repair'}
                    >
                      {actionLoading === 'vehicle-repair' ? '...' : 'ВОССТАНОВИТЬ МАШИНУ'}
                    </PixelButton>
                  </>
                )}
              </div>
            </div>
          </>,
        )}

        {error ? <div className="text-[8px] text-red-400">{error}</div> : null}
        {actionError ? <div className="text-[8px] text-red-400">{actionError}</div> : null}

        <div className="sticky bottom-0 left-0 pt-2 bg-gradient-to-t from-[#2b2b2b] to-transparent space-y-2">
          <div className="text-[7px] text-gray-300 leading-relaxed">
            Схем сохранено: {savedSceneMeta.count}
            {savedSceneMeta.lastSavedAt
              ? ` | последнее: ${new Date(savedSceneMeta.lastSavedAt).toLocaleString('ru-RU')}${savedSceneMeta.lastSavedBy ? ` (${savedSceneMeta.lastSavedBy})` : ''}`
              : ''}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <PixelButton
              variant="green"
              className="text-[8px]"
              onClick={() => {
                void handleSaveSceneScheme();
              }}
              disabled={
                actionLoading === 'save-scene' ||
                actionLoading === 'start-lesson' ||
                actionLoading === 'finish-lesson'
              }
            >
              {actionLoading === 'save-scene' ? 'СОХРАНЕНИЕ...' : 'СОХРАНИТЬ СХЕМУ'}
            </PixelButton>

            {isLessonStarted ? (
              <PixelButton
                variant="active"
                className="text-[8px]"
                onClick={() => {
                  void handleFinishLesson();
                }}
                disabled={actionLoading === 'finish-lesson' || actionLoading === 'save-scene'}
              >
                {actionLoading === 'finish-lesson' ? 'ЗАВЕРШЕНИЕ...' : 'ЗАВЕРШИТЬ УРОК'}
              </PixelButton>
            ) : isLessonCompleted ? (
              <div className="flex items-center justify-center text-[8px] uppercase text-cyan-200 border border-cyan-400/40 bg-cyan-500/10">
                УРОК ЗАВЕРШЕН
              </div>
            ) : (
              <PixelButton
                variant="active"
                className="text-[8px]"
                onClick={() => {
                  void handleStartLesson();
                }}
                disabled={actionLoading === 'start-lesson' || actionLoading === 'save-scene'}
              >
                {actionLoading === 'start-lesson' ? 'СТАРТ...' : 'НАЧАТЬ УРОК'}
              </PixelButton>
            )}
          </div>
        </div>
      </aside>

      <section className="flex-1 bg-[#111] flex flex-col p-3 gap-3 overflow-hidden">
        <div className="bg-[#1f1f1f] border-2 border-black px-3 py-2 flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase">ПОЛЕ МАКЕТА ({activeFloor.floor_id})</div>
            <div className="text-[7px] text-gray-300 mt-1">
              Область: {Math.round(worldViewport.width)} x {Math.round(worldViewport.height)} м | Объектов:{' '}
              {activeFloor.objects.length}
            </div>
            <div className={`text-[7px] mt-1 ${isLessonStarted ? 'text-emerald-300' : isLessonCompleted ? 'text-cyan-200' : 'text-sky-300'}`}>
              Режим:{' '}
              {isLessonStarted
                ? 'УРОК (редактирование схемы заблокировано)'
                : isLessonCompleted
                  ? 'УРОК ЗАВЕРШЕН (режим разбора)'
                  : 'ПОДГОТОВКА СХЕМЫ'}
            </div>
            {selectedObject ? (
              <div className="text-[7px] text-amber-300 mt-1">
                Выбрано: {selectedObject.label || KIND_LABELS[selectedObject.kind]}
                {selectedVertexIndex !== null ? ` | вершина #${selectedVertexIndex + 1}` : ''}
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-1">
            {!isLessonStarted ? (
              <>
                <PixelButton
                  variant="default"
                  size="sm"
                  onClick={() => {
                    void handleUndo();
                  }}
                  disabled={undoStack.length === 0 || actionLoading === 'undo' || actionLoading === 'redo'}
                >
                  UNDO
                </PixelButton>
                <PixelButton
                  variant="default"
                  size="sm"
                  onClick={() => {
                    void handleRedo();
                  }}
                  disabled={redoStack.length === 0 || actionLoading === 'undo' || actionLoading === 'redo'}
                >
                  REDO
                </PixelButton>
              </>
            ) : null}
            <PixelButton
              variant="default"
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
              variant="default"
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
            <PixelButton variant="default" size="sm" onClick={resetView}>
              100%
            </PixelButton>
            <PixelButton variant="default" size="sm" onClick={centerView}>
              ЦЕНТР
            </PixelButton>
            <div className="text-[7px] min-w-[46px] text-right">{Math.round(viewZoom * 100)}%</div>
          </div>
        </div>

        <div ref={canvasHolderRef} className="flex-1 min-h-[320px] bg-[#171717] border-2 border-black p-2 overflow-hidden">
          {isLoading ? <div className="text-[10px] text-gray-300 p-3">Загрузка редактора...</div> : null}
          <canvas
            ref={canvasRef}
            width={canvasSize.width}
            height={canvasSize.height}
            className={`w-full h-full bg-[#111] border border-[#2f2f2f] ${
              toolMode === 'NONE'
                ? isPanning || isObjectDragging
                  ? 'cursor-grabbing'
                  : 'cursor-grab'
                : 'cursor-crosshair'
            }`}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            onMouseLeave={handleCanvasMouseLeave}
            onWheel={handleCanvasWheel}
            onContextMenu={(event) => {
              event.preventDefault();
            }}
            onClick={(event) => {
              void handleCanvasClick(event);
            }}
          />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 overflow-hidden">
          <div className="bg-[#1f1f1f] border-2 border-black p-3">
            <div className="text-[9px] uppercase mb-2">ЛЕГЕНДА</div>
            <div className="grid grid-cols-2 gap-y-1 gap-x-2 text-[7px]">
              {(Object.keys(KIND_COLORS) as SceneKind[]).map((kind) => (
                <div key={kind} className="flex items-center justify-between gap-2 border-b border-black/30 pb-1">
                  <span>{KIND_LABELS[kind]}</span>
                  <StatusIndicator
                    color={kind === 'FIRE_SOURCE' ? 'red' : kind === 'ROOM' ? 'orange' : kind === 'SMOKE_ZONE' ? 'gray' : 'blue'}
                    size={7}
                  />
                </div>
              ))}
            </div>

            <div className="mt-2 border-t border-black/40 pt-2 space-y-1 text-[7px] text-gray-300">
              {(Object.keys(SITE_ENTITY_LABELS) as SiteEntityKind[]).map((kind) => (
                <div key={kind} className="flex items-center justify-between gap-2">
                  <span>{SITE_ENTITY_LABELS[kind]}</span>
                  <span>{siteEntityCounts[kind]}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-[#1f1f1f] border-2 border-black p-3 overflow-hidden">
            <div className="text-[9px] uppercase mb-2">ОБЪЕКТЫ ЭТАЖА</div>
            <div className="max-h-[180px] overflow-y-auto custom-scrollbar pr-1 space-y-1">
              {activeFloor.objects.length === 0 ? (
                <div className="text-[7px] text-gray-400">Объектов нет</div>
              ) : (
                activeFloor.objects.map((object) => (
                  <div
                    key={object.id}
                    className={`border border-black px-2 py-1 cursor-pointer transition-colors ${
                      selectedObjectId === object.id ? 'bg-[#4b3d23]' : 'bg-[#2d2d2d] hover:bg-[#383838]'
                    }`}
                    onClick={() => {
                      setSelectedObjectId(object.id);
                      setSelectedVertexIndex(null);
                      setDragPreview(null);
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[7px] text-white truncate">{object.label || KIND_LABELS[object.kind]}</div>
                        <div className="text-[6px] text-gray-400">{KIND_LABELS[object.kind]} / {object.geometry_type}</div>
                      </div>
                      {selectedObjectId === object.id ? <StatusIndicator color="orange" size={7} /> : null}
                    </div>

                    {!isLessonStarted ? (
                      <div className="mt-1 flex items-center justify-end gap-1">
                        <PixelButton
                          size="sm"
                          variant="default"
                          className="text-[6px] px-2"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleDuplicateObject(object);
                          }}
                          disabled={actionLoading === 'duplicate-object'}
                        >
                          ДУБЛЬ
                        </PixelButton>
                        <PixelButton
                          size="sm"
                          variant="default"
                          className="text-[6px] px-2"
                          onClick={(event) => {
                            event.stopPropagation();
                            void commitRemoveSceneObject(object, activeFloor.floor_id, { description: 'remove-list-object' }).catch((removeError) => {
                              setActionError(getErrorMessage(removeError, 'Не удалось удалить объект'));
                            });
                          }}
                        >
                          УДАЛИТЬ
                        </PixelButton>
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>

          <PhysicsIsometricView
            bundle={bundle}
            className="h-full min-h-[240px]"
            title="SIMULATION 2.5D"
            lod="medium"
          />
        </div>
      </section>
    </div>
  );
};
