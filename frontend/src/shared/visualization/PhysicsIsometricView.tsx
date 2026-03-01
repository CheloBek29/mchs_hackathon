import React, { useEffect, useMemo, useRef } from 'react';
import type {
  DeploymentStatus,
  GeometryType,
  ResourceDeploymentDto,
  SessionStateBundleDto,
} from '../api/types';
import { useSimulationCameraStore } from '../../store/useSimulationCameraStore';

type Point = { x: number; y: number };

type VehicleNode = {
  id: string;
  center: Point;
  status: DeploymentStatus;
  waterRatio: number | null;
};

type HoseNode = {
  id: string;
  points: Point[];
  hasWater: boolean;
  blockedReason?: string | null;
};

type NozzleNode = {
  id: string;
  center: Point;
  hasWater: boolean;
  flowLps: number;
  radiusM: number;
  blockedReason?: string | null;
};

type FireNode = {
  id: string;
  center: Point;
  areaM2: number;
  kind: 'FIRE' | 'SMOKE';
  rank: number;
  power: number;
};

type SceneLayerItem = {
  id: string;
  kind: string;
  geometryType: GeometryType;
  geometry: Record<string, unknown>;
  props: Record<string, unknown>;
};

type SceneVoxel = {
  id: string;
  center: Point;
  size: number;
  height: number;
  top: string;
  left: string;
  right: string;
  priority: number;
};

type RuntimeData = {
  hoseWet: Set<string>;
  nozzleWet: Set<string>;
  vehicleWaterRatioById: Map<number, number | null>;
  hoseBlockedReason: Map<string, string | null>;
  nozzleBlockedReason: Map<string, string | null>;
};

type SceneModel = {
  fires: FireNode[];
  smokes: FireNode[];
  vehicles: VehicleNode[];
  hoses: HoseNode[];
  nozzles: NozzleNode[];
  sceneVoxels: SceneVoxel[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

type PhysicsViewMode = 'panel' | 'fullscreen';
type RenderLod = 'auto' | 'coarse' | 'medium' | 'fine';
type ResolvedRenderLod = Exclude<RenderLod, 'auto'>;

type RenderSignatures = {
  scene: string;
  runtime: string;
  deployments: string;
  lod: string;
};

type RenderDelta = {
  sceneChanged: boolean;
  runtimeChanged: boolean;
  deploymentsChanged: boolean;
  lodChanged: boolean;
};

type RenderPayload = {
  model: SceneModel;
  sceneItems: SceneLayerItem[];
  lod: ResolvedRenderLod;
  voxelStepM: number;
  signatures: RenderSignatures;
  delta: RenderDelta;
};

type PhysicsIsometricViewProps = {
  bundle: SessionStateBundleDto | null;
  title?: string;
  className?: string;
  mode?: PhysicsViewMode;
  voxelStepM?: number;
  lod?: RenderLod;
};

type ProjectPoint = (point: Point, elevation: number) => Point;

type PointerDragState = {
  active: boolean;
  lastX: number;
  lastY: number;
  intent: 'pan' | 'orbit';
};

const TILE_W = 22;
const TILE_H = 11;
const HEIGHT_PX = 18;
const SAFE_PADDING_PX = 20;
const HASH_SEED = 0x811c9dc5;

const STATUS_COLORS: Record<DeploymentStatus, string> = {
  PLANNED: '#858b93',
  EN_ROUTE: '#ca7b2f',
  DEPLOYED: '#36a76f',
  ACTIVE: '#22c0d1',
  COMPLETED: '#6b7280',
};

const SCENE_VOXEL_STYLE: Record<string, Omit<SceneVoxel, 'id' | 'center'>> = {
  BUILDING_CONTOUR: {
    size: 0.92,
    height: 1.15,
    top: 'rgba(83, 96, 119, 0.9)',
    left: 'rgba(48, 62, 82, 0.93)',
    right: 'rgba(63, 77, 97, 0.93)',
    priority: 1,
  },
  ROAD_ACCESS: {
    size: 0.84,
    height: 0.35,
    top: 'rgba(133, 146, 162, 0.58)',
    left: 'rgba(84, 98, 117, 0.55)',
    right: 'rgba(101, 114, 129, 0.55)',
    priority: 1,
  },
  ROOM: {
    size: 0.92,
    height: 0.72,
    top: 'rgba(67, 84, 104, 0.82)',
    left: 'rgba(42, 56, 73, 0.86)',
    right: 'rgba(56, 71, 88, 0.86)',
    priority: 2,
  },
  WALL: {
    size: 0.74,
    height: 1.55,
    top: 'rgba(207, 219, 232, 0.9)',
    left: 'rgba(118, 130, 142, 0.95)',
    right: 'rgba(155, 167, 180, 0.95)',
    priority: 5,
  },
  DOOR: {
    size: 0.68,
    height: 0.72,
    top: 'rgba(126, 186, 228, 0.9)',
    left: 'rgba(68, 128, 170, 0.95)',
    right: 'rgba(86, 150, 192, 0.95)',
    priority: 4,
  },
  EXIT: {
    size: 0.78,
    height: 0.95,
    top: 'rgba(79, 213, 132, 0.95)',
    left: 'rgba(40, 148, 86, 0.95)',
    right: 'rgba(56, 174, 105, 0.95)',
    priority: 4,
  },
  STAIR: {
    size: 0.82,
    height: 1.2,
    top: 'rgba(123, 168, 245, 0.9)',
    left: 'rgba(76, 120, 196, 0.95)',
    right: 'rgba(97, 143, 220, 0.95)',
    priority: 4,
  },
  HYDRANT: {
    size: 0.66,
    height: 1.1,
    top: 'rgba(84, 214, 243, 0.95)',
    left: 'rgba(26, 152, 188, 0.95)',
    right: 'rgba(40, 176, 208, 0.95)',
    priority: 6,
  },
  WATER_SOURCE: {
    size: 0.66,
    height: 1.1,
    top: 'rgba(54, 138, 255, 0.95)',
    left: 'rgba(25, 92, 190, 0.95)',
    right: 'rgba(33, 111, 220, 0.95)',
    priority: 6,
  },
  FIRE_SOURCE: {
    size: 0.88,
    height: 1.25,
    top: 'rgba(255, 125, 52, 0.95)',
    left: 'rgba(192, 73, 27, 0.95)',
    right: 'rgba(226, 92, 36, 0.95)',
    priority: 7,
  },
  SMOKE_ZONE: {
    size: 0.92,
    height: 0.92,
    top: 'rgba(145, 159, 174, 0.72)',
    left: 'rgba(81, 95, 112, 0.78)',
    right: 'rgba(106, 120, 138, 0.78)',
    priority: 3,
  },
};

const toRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const toNumber = (value: unknown): number | null => {
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

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const toPoint = (value: unknown): Point | null => {
  const raw = toRecord(value);
  if (!raw) {
    return null;
  }
  const x = toNumber(raw.x);
  const y = toNumber(raw.y);
  if (x === null || y === null) {
    return null;
  }
  return { x, y };
};

const geometryPoints = (geometryType: GeometryType, geometry: Record<string, unknown>): Point[] => {
  if (geometryType === 'POINT') {
    const point = toPoint(geometry);
    return point ? [point] : [];
  }
  const rawPoints = geometry.points;
  if (!Array.isArray(rawPoints)) {
    return [];
  }
  return rawPoints.map((entry) => toPoint(entry)).filter((entry): entry is Point => entry !== null);
};

const geometryCenter = (geometryType: GeometryType, geometry: Record<string, unknown>): Point | null => {
  const points = geometryPoints(geometryType, geometry);
  if (points.length === 0) {
    return null;
  }
  if (geometryType === 'POINT') {
    return points[0];
  }
  const sum = points.reduce(
    (accumulator, point) => ({ x: accumulator.x + point.x, y: accumulator.y + point.y }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / points.length, y: sum.y / points.length };
};

const latestVehiclesByDictionary = (deployments: ResourceDeploymentDto[]): ResourceDeploymentDto[] => {
  const byVehicleId = new Map<number, ResourceDeploymentDto>();
  const fallback: ResourceDeploymentDto[] = [];

  deployments.forEach((deployment) => {
    if (deployment.resource_kind !== 'VEHICLE') {
      return;
    }
    const dictionaryId = deployment.vehicle_dictionary_id;
    if (!dictionaryId) {
      fallback.push(deployment);
      return;
    }
    const previous = byVehicleId.get(dictionaryId);
    if (!previous) {
      byVehicleId.set(dictionaryId, deployment);
      return;
    }
    const prevTime = new Date(previous.created_at).getTime();
    const nextTime = new Date(deployment.created_at).getTime();
    if (nextTime >= prevTime) {
      byVehicleId.set(dictionaryId, deployment);
    }
  });

  return [...byVehicleId.values(), ...fallback];
};

const resolveFlow = (deployment: ResourceDeploymentDto): number => {
  const data = toRecord(deployment.resource_data);
  const raw = toNumber(data?.nozzle_flow_l_s ?? data?.flow_l_s ?? data?.intensity_l_s);
  if (raw === null) {
    return 3.5;
  }
  return clamp(raw, 1, 12);
};

const parseRuntime = (bundle: SessionStateBundleDto | null): RuntimeData => {
  const result: RuntimeData = {
    hoseWet: new Set<string>(),
    nozzleWet: new Set<string>(),
    vehicleWaterRatioById: new Map<number, number | null>(),
    hoseBlockedReason: new Map<string, string | null>(),
    nozzleBlockedReason: new Map<string, string | null>(),
  };

  const snapshotData = toRecord(bundle?.snapshot?.snapshot_data);
  const fireRuntime = toRecord(snapshotData?.fire_runtime);
  if (!fireRuntime) {
    return result;
  }

  const hoseRuntime = toRecord(fireRuntime.hose_runtime);
  if (hoseRuntime) {
    Object.entries(hoseRuntime).forEach(([deploymentId, value]) => {
      const runtimeNode = toRecord(value);
      if (runtimeNode?.has_water === true) {
        result.hoseWet.add(deploymentId);
      }
      if (runtimeNode?.blocked_reason && typeof runtimeNode.blocked_reason === 'string') {
        result.hoseBlockedReason.set(deploymentId, runtimeNode.blocked_reason);
      }
    });
  }

  const nozzleRuntime = toRecord(fireRuntime.nozzle_runtime);
  if (nozzleRuntime) {
    Object.entries(nozzleRuntime).forEach(([deploymentId, value]) => {
      const runtimeNode = toRecord(value);
      if (runtimeNode?.has_water === true) {
        result.nozzleWet.add(deploymentId);
      }
      if (runtimeNode?.blocked_reason && typeof runtimeNode.blocked_reason === 'string') {
        result.nozzleBlockedReason.set(deploymentId, runtimeNode.blocked_reason);
      }
    });
  }

  const vehicleRuntime = toRecord(fireRuntime.vehicle_runtime);
  if (vehicleRuntime) {
    Object.entries(vehicleRuntime).forEach(([vehicleIdKey, value]) => {
      const vehicleId = Number.parseInt(vehicleIdKey, 10);
      if (!Number.isFinite(vehicleId) || vehicleId <= 0) {
        return;
      }
      const node = toRecord(value);
      if (!node) {
        return;
      }
      const capacity = toNumber(node.water_capacity_l);
      const remaining = toNumber(node.water_remaining_l);
      if (capacity === null || capacity <= 0 || remaining === null) {
        result.vehicleWaterRatioById.set(vehicleId, null);
        return;
      }
      const ratio = clamp(remaining / capacity, 0, 1);
      result.vehicleWaterRatioById.set(vehicleId, ratio);
    });
  }

  return result;
};

const parseSceneItems = (bundle: SessionStateBundleDto | null): SceneLayerItem[] => {
  const snapshotData = toRecord(bundle?.snapshot?.snapshot_data);
  const scene = toRecord(snapshotData?.training_lead_scene);
  if (!scene) {
    return [];
  }

  const parseItem = (
    itemRaw: Record<string, unknown>,
    fallbackKind = 'SCENE_OBJECT',
  ): SceneLayerItem | null => {
    const geometryTypeRaw = typeof itemRaw.geometry_type === 'string' ? itemRaw.geometry_type.toUpperCase() : '';
    if (geometryTypeRaw !== 'POINT' && geometryTypeRaw !== 'LINESTRING' && geometryTypeRaw !== 'POLYGON') {
      return null;
    }

    const geometry = toRecord(itemRaw.geometry);
    if (!geometry) {
      return null;
    }

    const kind = typeof itemRaw.kind === 'string' ? itemRaw.kind.toUpperCase() : fallbackKind;
    const fallbackSeed = JSON.stringify(geometry).slice(0, 48);
    const id = typeof itemRaw.id === 'string' ? itemRaw.id : `${kind}:${fallbackSeed}`;

    return {
      id,
      kind,
      geometryType: geometryTypeRaw,
      geometry,
      props: toRecord(itemRaw.props) ?? {},
    };
  };

  const items: SceneLayerItem[] = [];

  const siteEntities = Array.isArray(scene.site_entities) ? scene.site_entities : [];
  siteEntities.forEach((entry) => {
    const raw = toRecord(entry);
    if (!raw) {
      return;
    }
    const item = parseItem(raw, 'SITE_ENTITY');
    if (item) {
      items.push(item);
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
    return items;
  }

  const objects = Array.isArray(floorRaw.objects) ? floorRaw.objects : [];
  objects.forEach((entry) => {
    const raw = toRecord(entry);
    if (!raw) {
      return;
    }
    const item = parseItem(raw, 'SCENE_OBJECT');
    if (item) {
      items.push(item);
    }
  });

  return items;
};

const hashString = (value: string): string => {
  let hash = HASH_SEED;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
};

const hashValue = (value: unknown): string => {
  try {
    return hashString(JSON.stringify(value) ?? '');
  } catch {
    return '0';
  }
};

const countSceneObjects = (sceneRaw: Record<string, unknown> | null): number => {
  if (!sceneRaw) {
    return 0;
  }

  const siteEntities = Array.isArray(sceneRaw.site_entities) ? sceneRaw.site_entities.length : 0;
  const floors = Array.isArray(sceneRaw.floors) ? sceneRaw.floors : [];
  const floorObjects = floors.reduce((accumulator, floorEntry) => {
    const floor = toRecord(floorEntry);
    if (!floor) {
      return accumulator;
    }
    const objects = Array.isArray(floor.objects) ? floor.objects.length : 0;
    return accumulator + objects;
  }, 0);

  return siteEntities + floorObjects;
};

const resolveLodLevel = (
  lod: RenderLod,
  mode: PhysicsViewMode,
  sceneObjectCount: number,
  deploymentCount: number,
): ResolvedRenderLod => {
  if (lod !== 'auto') {
    return lod;
  }

  const complexity = sceneObjectCount + deploymentCount * 2;
  if (mode === 'fullscreen') {
    if (complexity > 240) {
      return 'coarse';
    }
    if (complexity > 120) {
      return 'medium';
    }
    return 'fine';
  }

  if (complexity > 150) {
    return 'coarse';
  }
  if (complexity > 70) {
    return 'medium';
  }
  return 'fine';
};

const resolveVoxelStepByLod = (
  mode: PhysicsViewMode,
  lod: ResolvedRenderLod,
  requestedStep: number | null,
): number => {
  if (requestedStep !== null && Number.isFinite(requestedStep)) {
    return clamp(requestedStep, 0.35, 4.2);
  }

  if (mode === 'fullscreen') {
    if (lod === 'coarse') {
      return 1.6;
    }
    if (lod === 'medium') {
      return 1.15;
    }
    return 0.85;
  }

  if (lod === 'coarse') {
    return 2.2;
  }
  if (lod === 'medium') {
    return 1.6;
  }
  return 1.2;
};

const buildDeploymentsSignature = (deployments: ResourceDeploymentDto[]): string => {
  const compact = deployments.map((deployment) => {
    return [
      deployment.id,
      deployment.resource_kind,
      deployment.status,
      deployment.vehicle_dictionary_id ?? 0,
      deployment.geometry_type,
      deployment.created_at,
    ];
  });
  return hashValue(compact);
};

const pointInPolygon = (point: Point, polygon: Point[]): boolean => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects = yi > point.y !== yj > point.y
      && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
};

const sampleLine = (points: Point[], step: number): Point[] => {
  if (points.length < 2) {
    return [];
  }

  const samples: Point[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const segments = Math.max(1, Math.ceil(length / Math.max(0.35, step)));
    for (let segment = 0; segment <= segments; segment += 1) {
      const t = segment / segments;
      samples.push({
        x: from.x + dx * t,
        y: from.y + dy * t,
      });
    }
  }
  return samples;
};

const samplePolygon = (polygon: Point[], step: number, maxPoints: number): Point[] => {
  if (polygon.length < 3) {
    return [];
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  polygon.forEach((point) => {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  });

  const collectWithStep = (adaptiveStep: number): Point[] => {
    const points: Point[] = [];
    for (let y = minY; y <= maxY; y += adaptiveStep) {
      for (let x = minX; x <= maxX; x += adaptiveStep) {
        const candidate = { x, y };
        if (pointInPolygon(candidate, polygon)) {
          points.push(candidate);
        }
      }
    }
    return points;
  };

  let adaptiveStep = Math.max(0.35, step);
  let sampled = collectWithStep(adaptiveStep);

  // Avoid "partial strips": increase step until full-shape sampling fits budget.
  for (let attempt = 0; attempt < 5 && sampled.length > maxPoints; attempt += 1) {
    const ratio = Math.sqrt(sampled.length / Math.max(1, maxPoints));
    adaptiveStep = adaptiveStep * Math.max(1.12, ratio);
    sampled = collectWithStep(adaptiveStep);
  }

  if (sampled.length <= maxPoints) {
    return sampled;
  }

  // Final fallback: uniform decimation across the whole shape.
  const stride = Math.max(1, Math.ceil(sampled.length / maxPoints));
  const reduced: Point[] = [];
  for (let index = 0; index < sampled.length && reduced.length < maxPoints; index += stride) {
    reduced.push(sampled[index]);
  }
  return reduced;
};

const voxelFromPoint = (
  kind: string,
  point: Point,
  mode: PhysicsViewMode,
  id: string,
): SceneVoxel | null => {
  const style = SCENE_VOXEL_STYLE[kind];
  if (!style) {
    return null;
  }

  const scale = mode === 'fullscreen' ? 1 : 0.78;

  return {
    id,
    center: point,
    size: style.size * scale,
    height: style.height * scale,
    top: style.top,
    left: style.left,
    right: style.right,
    priority: style.priority,
  };
};

const buildSceneVoxels = (
  items: SceneLayerItem[],
  mode: PhysicsViewMode,
  requestedStep: number | null,
): SceneVoxel[] => {
  const dedup = new Map<string, SceneVoxel>();
  const baseStep = requestedStep ?? (mode === 'fullscreen' ? 1 : 2);
  const lineStep = Math.max(0.55, baseStep);
  const areaStep = Math.max(0.7, baseStep);
  const maxVoxels = mode === 'fullscreen' ? 22000 : 3200;
  const maxPolygonSamples = mode === 'fullscreen' ? 12000 : 1200;

  const upsertVoxel = (voxel: SceneVoxel | null) => {
    if (!voxel) {
      return;
    }
    if (dedup.size >= maxVoxels && !dedup.has(voxel.id)) {
      return;
    }

    const key = `${Math.round(voxel.center.x * 2) / 2}:${Math.round(voxel.center.y * 2) / 2}:${voxel.priority}`;
    const existing = dedup.get(key);
    if (!existing || voxel.priority >= existing.priority) {
      dedup.set(key, voxel);
    }
  };

  items.forEach((item) => {
    const points = geometryPoints(item.geometryType, item.geometry);
    if (points.length === 0) {
      return;
    }

    if (item.geometryType === 'POINT') {
      upsertVoxel(voxelFromPoint(item.kind, points[0], mode, `${item.id}:pt`));
      return;
    }

    if (item.geometryType === 'LINESTRING') {
      const sampled = sampleLine(points, lineStep);
      sampled.forEach((point, index) => {
        upsertVoxel(voxelFromPoint(item.kind, point, mode, `${item.id}:ln:${index}`));
      });
      return;
    }

    const sampledPolygon = samplePolygon(points, areaStep, maxPolygonSamples);
    sampledPolygon.forEach((point, index) => {
      upsertVoxel(voxelFromPoint(item.kind, point, mode, `${item.id}:poly:${index}`));
    });
  });

  return Array.from(dedup.values()).sort((left, right) => {
    const leftSort = left.center.x + left.center.y + left.priority * 0.2;
    const rightSort = right.center.x + right.center.y + right.priority * 0.2;
    return leftSort - rightSort;
  });
};

const buildSceneModel = (
  bundle: SessionStateBundleDto | null,
  mode: PhysicsViewMode,
  requestedStep: number | null,
  staticLayer?: {
    sceneItems: SceneLayerItem[];
    sceneVoxels: SceneVoxel[];
  },
): SceneModel => {
  const runtime = parseRuntime(bundle);
  const sceneItems = staticLayer?.sceneItems ?? parseSceneItems(bundle);
  const snapshotData = toRecord(bundle?.snapshot?.snapshot_data);
  const fireRuntime = toRecord(snapshotData?.fire_runtime);
  const fireDirections = toRecord(fireRuntime?.fire_directions);

  const fires: FireNode[] = [];
  const smokes: FireNode[] = [];
  const vehicles: VehicleNode[] = [];
  const hoses: HoseNode[] = [];
  const nozzles: NozzleNode[] = [];
  const scenePoints: Point[] = [];

  const runtimeFires = bundle?.fire_objects ?? [];
  if (runtimeFires.length > 0) {
    runtimeFires.forEach((fire) => {
      if (!fire.is_active) {
        return;
      }
      const center = geometryCenter(fire.geometry_type, fire.geometry);
      if (!center) {
        return;
      }
      const runtimeDirection = fireDirections ? toRecord(fireDirections[fire.id]) : null;
      const runtimeArea = toNumber(runtimeDirection?.area_m2);
      const area = Math.max(1, runtimeArea ?? toNumber(fire.area_m2) ?? (fire.kind === 'SMOKE_ZONE' ? 32 : 24));
      scenePoints.push(center);
      if (fire.kind === 'SMOKE_ZONE') {
        smokes.push({
          id: fire.id,
          center,
          areaM2: area,
          kind: 'SMOKE',
          rank: 1,
          power: 1,
        });
        return;
      }
      fires.push({
        id: fire.id,
        center,
        areaM2: area,
        kind: 'FIRE',
        rank: Math.max(1, Math.min(5, Math.round(toNumber(fire.extra?.fire_rank) ?? 2))),
        power: Math.max(0.35, Math.min(4, toNumber(fire.extra?.fire_power) ?? 1)),
      });
    });
  } else {
    sceneItems
      .filter((item) => item.kind === 'FIRE_SOURCE' || item.kind === 'SMOKE_ZONE')
      .forEach((item) => {
        if (item.props.is_active === false) {
          return;
        }
        const center = geometryCenter(item.geometryType, item.geometry);
        if (!center) {
          return;
        }
        const area = Math.max(
          1,
          toNumber(item.props.fire_area_m2 ?? item.props.area_m2) ?? (item.kind === 'SMOKE_ZONE' ? 32 : 24),
        );
        scenePoints.push(center);
        if (item.kind === 'SMOKE_ZONE') {
          smokes.push({
            id: item.id,
            center,
            areaM2: area,
            kind: 'SMOKE',
            rank: 1,
            power: 1,
          });
        } else {
          fires.push({
            id: item.id,
            center,
            areaM2: area,
            kind: 'FIRE',
            rank: Math.max(1, Math.min(5, Math.round(toNumber(item.props.fire_rank) ?? 2))),
            power: Math.max(0.35, Math.min(4, toNumber(item.props.fire_power) ?? 1)),
          });
        }
      });
  }

  latestVehiclesByDictionary(bundle?.resource_deployments ?? []).forEach((deployment) => {
    const center = geometryCenter(deployment.geometry_type, deployment.geometry);
    if (!center) {
      return;
    }
    scenePoints.push(center);
    const vehicleDictionaryId = deployment.vehicle_dictionary_id ?? 0;
    vehicles.push({
      id: deployment.id,
      center,
      status: deployment.status,
      waterRatio: vehicleDictionaryId > 0 ? runtime.vehicleWaterRatioById.get(vehicleDictionaryId) ?? null : null,
    });
  });

  (bundle?.resource_deployments ?? []).forEach((deployment) => {
    if (deployment.resource_kind === 'HOSE_LINE') {
      const points = geometryPoints(deployment.geometry_type, deployment.geometry);
      if (points.length < 2) {
        return;
      }
      points.forEach((point) => scenePoints.push(point));
      hoses.push({
        id: deployment.id,
        points,
        hasWater: runtime.hoseWet.has(deployment.id),
        blockedReason: runtime.hoseBlockedReason.get(deployment.id) ?? null,
      });
      return;
    }

    if (deployment.resource_kind === 'NOZZLE') {
      if (deployment.status !== 'ACTIVE' && deployment.status !== 'DEPLOYED') {
        return;
      }
      const center = geometryCenter(deployment.geometry_type, deployment.geometry);
      if (!center) {
        return;
      }
      scenePoints.push(center);
      nozzles.push({
        id: deployment.id,
        center,
        hasWater: runtime.nozzleWet.has(deployment.id),
        flowLps: resolveFlow(deployment),
        radiusM: Math.max(3, Math.min(30, toNumber(
          (deployment.resource_data as Record<string, unknown> | null)?.nozzle_radius_m
          ?? (deployment.resource_data as Record<string, unknown> | null)?.radius_m
        ) ?? 10)),
        blockedReason: runtime.nozzleBlockedReason.get(deployment.id) ?? null,
      });
    }
  });

  const sceneVoxels = staticLayer?.sceneVoxels ?? buildSceneVoxels(sceneItems, mode, requestedStep);
  sceneVoxels.forEach((voxel) => scenePoints.push(voxel.center));

  const fallbackBounds = {
    minX: -40,
    maxX: 40,
    minY: -40,
    maxY: 40,
  };

  if (scenePoints.length === 0) {
    return {
      fires,
      smokes,
      vehicles,
      hoses,
      nozzles,
      sceneVoxels,
      ...fallbackBounds,
    };
  }

  const minX = Math.min(...scenePoints.map((point) => point.x));
  const maxX = Math.max(...scenePoints.map((point) => point.x));
  const minY = Math.min(...scenePoints.map((point) => point.y));
  const maxY = Math.max(...scenePoints.map((point) => point.y));

  return {
    fires,
    smokes,
    vehicles,
    hoses,
    nozzles,
    sceneVoxels,
    minX,
    maxX,
    minY,
    maxY,
  };
};

const drawIsoPrism = (
  context: CanvasRenderingContext2D,
  baseCenter: Point,
  size: number,
  height: number,
  topColor: string,
  leftColor: string,
  rightColor: string,
) => {
  const halfW = size;
  const halfH = size * 0.5;
  const h = height;

  const bottomTop = { x: baseCenter.x, y: baseCenter.y - halfH };
  const bottomRight = { x: baseCenter.x + halfW, y: baseCenter.y };
  const bottomBottom = { x: baseCenter.x, y: baseCenter.y + halfH };
  const bottomLeft = { x: baseCenter.x - halfW, y: baseCenter.y };

  const topTop = { x: bottomTop.x, y: bottomTop.y - h };
  const topRight = { x: bottomRight.x, y: bottomRight.y - h };
  const topBottom = { x: bottomBottom.x, y: bottomBottom.y - h };
  const topLeft = { x: bottomLeft.x, y: bottomLeft.y - h };

  context.beginPath();
  context.moveTo(bottomLeft.x, bottomLeft.y);
  context.lineTo(topLeft.x, topLeft.y);
  context.lineTo(topBottom.x, topBottom.y);
  context.lineTo(bottomBottom.x, bottomBottom.y);
  context.closePath();
  context.fillStyle = leftColor;
  context.fill();

  context.beginPath();
  context.moveTo(bottomRight.x, bottomRight.y);
  context.lineTo(topRight.x, topRight.y);
  context.lineTo(topBottom.x, topBottom.y);
  context.lineTo(bottomBottom.x, bottomBottom.y);
  context.closePath();
  context.fillStyle = rightColor;
  context.fill();

  context.beginPath();
  context.moveTo(topTop.x, topTop.y);
  context.lineTo(topRight.x, topRight.y);
  context.lineTo(topBottom.x, topBottom.y);
  context.lineTo(topLeft.x, topLeft.y);
  context.closePath();
  context.fillStyle = topColor;
  context.fill();
};

const drawGrid = (
  context: CanvasRenderingContext2D,
  projectPoint: ProjectPoint,
  span: number,
  mode: PhysicsViewMode,
) => {
  const half = Math.max(12, Math.min(mode === 'fullscreen' ? 120 : 60, Math.ceil(span / 2) + 6));
  const step = mode === 'fullscreen' ? 1 : 2;
  context.strokeStyle = mode === 'fullscreen' ? 'rgba(108, 161, 210, 0.22)' : 'rgba(125, 170, 205, 0.18)';
  context.lineWidth = 1;

  for (let index = -half; index <= half; index += step) {
    const startA = projectPoint({ x: -half, y: index }, 0);
    const endA = projectPoint({ x: half, y: index }, 0);
    context.beginPath();
    context.moveTo(startA.x, startA.y);
    context.lineTo(endA.x, endA.y);
    context.stroke();

    const startB = projectPoint({ x: index, y: -half }, 0);
    const endB = projectPoint({ x: index, y: half }, 0);
    context.beginPath();
    context.moveTo(startB.x, startB.y);
    context.lineTo(endB.x, endB.y);
    context.stroke();
  }
};

const buildProjector = (
  cameraMode: 'ISO_LOCKED' | 'TOP_DOWN' | 'ORBIT_FREE',
  target: Point,
  yaw: number,
  pitch: number,
  scale: number,
  cssWidth: number,
  cssHeight: number,
): ProjectPoint => {
  if (cameraMode === 'TOP_DOWN') {
    const unit = 8 * scale;
    const centerX = cssWidth / 2;
    const centerY = cssHeight / 2;
    return (point, elevation) => {
      return {
        x: centerX + (point.x - target.x) * unit,
        y: centerY + (point.y - target.y) * unit - elevation * HEIGHT_PX * scale * 0.45,
      };
    };
  }

  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const centerX = cssWidth / 2;
  const centerY = cssHeight * 0.62;
  const worldToScreenX = TILE_W * 0.58 * scale;
  const worldToScreenY = TILE_H * 0.9 * scale;

  return (point, elevation) => {
    const wx = point.x - target.x;
    const wy = point.y - target.y;
    const wz = elevation * 3.2;

    const xYaw = wx * cosYaw - wy * sinYaw;
    const yYaw = wx * sinYaw + wy * cosYaw;
    const yPitch = yYaw * cosPitch - wz * sinPitch;

    return {
      x: centerX + xYaw * worldToScreenX,
      y: centerY + yPitch * worldToScreenY,
    };
  };
};

const nearestFire = (source: Point, targets: FireNode[]): FireNode | null => {
  if (targets.length === 0) {
    return null;
  }
  let best = targets[0];
  let bestDistanceSq = Number.POSITIVE_INFINITY;
  targets.forEach((target) => {
    const dx = target.center.x - source.x;
    const dy = target.center.y - source.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      best = target;
    }
  });
  return best;
};

const drawStaticSceneLayer = (
  context: CanvasRenderingContext2D,
  mode: PhysicsViewMode,
  model: SceneModel,
  scale: number,
  projectPoint: ProjectPoint,
  cssWidth: number,
  cssHeight: number,
) => {
  const gradient = context.createLinearGradient(0, 0, 0, cssHeight);
  gradient.addColorStop(0, mode === 'fullscreen' ? '#0d1823' : '#0c141d');
  gradient.addColorStop(1, mode === 'fullscreen' ? '#0a111a' : '#0a0f16');
  context.fillStyle = gradient;
  context.fillRect(0, 0, cssWidth, cssHeight);

  const spanX = Math.max(20, model.maxX - model.minX);
  const spanY = Math.max(20, model.maxY - model.minY);
  drawGrid(context, projectPoint, Math.max(spanX, spanY), mode);

  for (let index = 0; index < model.sceneVoxels.length; index += 1) {
    const voxel = model.sceneVoxels[index];
    const iso = projectPoint(voxel.center, 0.12);
    const sizePx = Math.max(1.5, voxel.size * scale * 6.6);
    const heightPx = Math.max(1.5, voxel.height * scale * 7.4);
    drawIsoPrism(context, iso, sizePx, heightPx, voxel.top, voxel.left, voxel.right);
  }
};

const buildRenderPayload = (
  bundle: SessionStateBundleDto | null,
  mode: PhysicsViewMode,
  requestedVoxelStepM: number | undefined,
  requestedLod: RenderLod,
  previous: RenderPayload | null,
): RenderPayload => {
  const snapshotData = toRecord(bundle?.snapshot?.snapshot_data);
  const sceneRaw = toRecord(snapshotData?.training_lead_scene);
  const fireRuntimeRaw = toRecord(snapshotData?.fire_runtime);
  const deployments = bundle?.resource_deployments ?? [];

  const sceneObjectCount = countSceneObjects(sceneRaw);
  const deploymentCount = deployments.length;
  const resolvedLod = resolveLodLevel(requestedLod, mode, sceneObjectCount, deploymentCount);
  const normalizedStep = typeof requestedVoxelStepM === 'number' && Number.isFinite(requestedVoxelStepM)
    ? requestedVoxelStepM
    : null;
  const voxelStep = resolveVoxelStepByLod(mode, resolvedLod, normalizedStep);

  const sceneSignature = hashValue(sceneRaw);
  const runtimeSignature = hashValue({
    runtime: fireRuntimeRaw,
    fire_objects: bundle?.fire_objects ?? [],
  });
  const deploymentsSignature = buildDeploymentsSignature(deployments);
  const lodSignature = `${mode}:${resolvedLod}:${voxelStep.toFixed(2)}`;

  const signatures: RenderSignatures = {
    scene: sceneSignature,
    runtime: runtimeSignature,
    deployments: deploymentsSignature,
    lod: lodSignature,
  };

  const delta: RenderDelta = {
    sceneChanged: previous ? previous.signatures.scene !== sceneSignature : true,
    runtimeChanged: previous ? previous.signatures.runtime !== runtimeSignature : true,
    deploymentsChanged: previous ? previous.signatures.deployments !== deploymentsSignature : true,
    lodChanged: previous ? previous.signatures.lod !== lodSignature : true,
  };

  let sceneItems: SceneLayerItem[];
  let sceneVoxels: SceneVoxel[];
  if (previous && !delta.sceneChanged && !delta.lodChanged) {
    sceneItems = previous.sceneItems;
    sceneVoxels = previous.model.sceneVoxels;
  } else {
    sceneItems = parseSceneItems(bundle);
    sceneVoxels = buildSceneVoxels(sceneItems, mode, voxelStep);
  }

  const model = buildSceneModel(bundle, mode, voxelStep, {
    sceneItems,
    sceneVoxels,
  });

  return {
    model,
    sceneItems,
    lod: resolvedLod,
    voxelStepM: voxelStep,
    signatures,
    delta,
  };
};

export const PhysicsIsometricView: React.FC<PhysicsIsometricViewProps> = ({
  bundle,
  title = 'SIMULATION 2.5D',
  className = '',
  mode = 'panel',
  voxelStepM,
  lod = 'auto',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerStateRef = useRef<PointerDragState>({
    active: false,
    lastX: 0,
    lastY: 0,
    intent: 'pan',
  });
  const cameraBasisRef = useRef<{
    vx: Point;
    vy: Point;
  } | null>(null);
  const wasFullscreenRef = useRef(false);
  const staticLayerCacheRef = useRef<{
    key: string;
    canvas: HTMLCanvasElement | null;
  }>({
    key: '',
    canvas: null,
  });

  const renderPayload = useMemo(
    () => buildRenderPayload(bundle, mode, voxelStepM, lod, null),
    [bundle, lod, mode, voxelStepM],
  );

  const model = renderPayload.model;
  const isInteractive = mode === 'fullscreen';

  const cameraMode = useSimulationCameraStore((state) => state.mode);
  const cameraZoom = useSimulationCameraStore((state) => state.zoom);
  const cameraTarget = useSimulationCameraStore((state) => state.target);
  const cameraYaw = useSimulationCameraStore((state) => state.yaw);
  const cameraPitch = useSimulationCameraStore((state) => state.pitch);
  const setCameraMode = useSimulationCameraStore((state) => state.setMode);
  const zoomCameraBy = useSimulationCameraStore((state) => state.zoomBy);
  const panCameraBy = useSimulationCameraStore((state) => state.panBy);
  const orbitCameraBy = useSimulationCameraStore((state) => state.orbitBy);
  const fitCameraToBounds = useSimulationCameraStore((state) => state.fitToBounds);

  const counters = useMemo(() => {
    return {
      fires: model.fires.length,
      smokes: model.smokes.length,
      vehicles: model.vehicles.length,
      wetNozzles: model.nozzles.filter((nozzle) => nozzle.hasWater).length,
      mapVoxels: model.sceneVoxels.length,
    };
  }, [model.fires.length, model.nozzles, model.sceneVoxels.length, model.smokes.length, model.vehicles.length]);

  useEffect(() => {
    if (isInteractive && !wasFullscreenRef.current) {
      fitCameraToBounds({
        minX: model.minX,
        maxX: model.maxX,
        minY: model.minY,
        maxY: model.maxY,
      });
    }
    wasFullscreenRef.current = isInteractive;
  }, [fitCameraToBounds, isInteractive, model.maxX, model.maxY, model.minX, model.minY]);

  useEffect(() => {
    if (!isInteractive) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target?.isContentEditable) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === '1') {
        setCameraMode('ISO_LOCKED');
        event.preventDefault();
        return;
      }
      if (key === '2') {
        setCameraMode('TOP_DOWN');
        event.preventDefault();
        return;
      }
      if (key === '3') {
        setCameraMode('ORBIT_FREE');
        event.preventDefault();
        return;
      }
      if (key === 'f') {
        fitCameraToBounds({
          minX: model.minX,
          maxX: model.maxX,
          minY: model.minY,
          maxY: model.maxY,
        });
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [fitCameraToBounds, isInteractive, model.maxX, model.maxY, model.minX, model.minY, setCameraMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    let animationFrameId = 0;
    let mounted = true;

    const renderFrame = (timestamp: number) => {
      if (!mounted) {
        return;
      }

      const cssWidth = Math.max(1, canvas.clientWidth || 640);
      const cssHeight = Math.max(1, canvas.clientHeight || (mode === 'fullscreen' ? 560 : 240));
      const dpr = window.devicePixelRatio || 1;
      const targetWidth = Math.max(1, Math.floor(cssWidth * dpr));
      const targetHeight = Math.max(1, Math.floor(cssHeight * dpr));

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, cssWidth, cssHeight);

      const spanX = Math.max(20, model.maxX - model.minX);
      const spanY = Math.max(20, model.maxY - model.minY);
      const boundsCenter = {
        x: (model.minX + model.maxX) / 2,
        y: (model.minY + model.maxY) / 2,
      };
      const activeCameraMode = isInteractive ? cameraMode : 'ISO_LOCKED';
      const activeZoom = isInteractive ? cameraZoom : 1;
      const target = isInteractive ? cameraTarget : boundsCenter;
      const yaw = activeCameraMode === 'ORBIT_FREE'
        ? cameraYaw
        : activeCameraMode === 'TOP_DOWN'
          ? -Math.PI / 2
          : -Math.PI / 4;
      const pitch = activeCameraMode === 'ORBIT_FREE'
        ? cameraPitch
        : activeCameraMode === 'TOP_DOWN'
          ? 1.45
          : 0.78;

      let baseScale = 1;
      if (activeCameraMode === 'TOP_DOWN') {
        const worldSpan = Math.max(spanX, spanY) + 8;
        const worldToPx = 8;
        baseScale = Math.max(
          mode === 'fullscreen' ? 0.48 : 0.4,
          Math.min(
            mode === 'fullscreen' ? 2.5 : 1.7,
            Math.min(
              (cssWidth - SAFE_PADDING_PX * 2) / Math.max(1, worldSpan * worldToPx),
              (cssHeight - SAFE_PADDING_PX * 2) / Math.max(1, worldSpan * worldToPx),
            ),
          ),
        );
      } else {
        const diagonalSpan = spanX + spanY + 6;
        const isoWidthPx = Math.max(1, diagonalSpan * TILE_W * 0.58);
        const isoHeightPx = Math.max(1, diagonalSpan * TILE_H * 0.9 + HEIGHT_PX * 12);
        const baseMinScale = mode === 'fullscreen' ? 0.55 : 0.45;
        const baseMaxScale = mode === 'fullscreen' ? 3.9 : 2.6;
        baseScale = Math.max(
          baseMinScale,
          Math.min(
            baseMaxScale,
            Math.min(
              (cssWidth - SAFE_PADDING_PX * 2) / isoWidthPx,
              (cssHeight - SAFE_PADDING_PX * 2) / isoHeightPx,
            ),
          ),
        );
      }

      const scale = clamp(baseScale * activeZoom, 0.25, mode === 'fullscreen' ? 5.2 : 3.5);
      const projectPoint = buildProjector(activeCameraMode, target, yaw, pitch, scale, cssWidth, cssHeight);
      const origin = projectPoint(target, 0);
      const axisX = projectPoint({ x: target.x + 1, y: target.y }, 0);
      const axisY = projectPoint({ x: target.x, y: target.y + 1 }, 0);
      cameraBasisRef.current = {
        vx: {
          x: axisX.x - origin.x,
          y: axisX.y - origin.y,
        },
        vy: {
          x: axisY.x - origin.x,
          y: axisY.y - origin.y,
        },
      };

      const staticLayerKey = [
        renderPayload.signatures.scene,
        renderPayload.signatures.lod,
        targetWidth,
        targetHeight,
        activeCameraMode,
        Math.round(scale * 1000),
        Math.round(yaw * 1000),
        Math.round(pitch * 1000),
        Math.round(target.x * 100),
        Math.round(target.y * 100),
      ].join('|');

      if (staticLayerCacheRef.current.key !== staticLayerKey || !staticLayerCacheRef.current.canvas) {
        const staticCanvas = document.createElement('canvas');
        staticCanvas.width = targetWidth;
        staticCanvas.height = targetHeight;
        const staticContext = staticCanvas.getContext('2d');
        if (staticContext) {
          staticContext.setTransform(dpr, 0, 0, dpr, 0, 0);
          staticContext.clearRect(0, 0, cssWidth, cssHeight);
          drawStaticSceneLayer(staticContext, mode, model, scale, projectPoint, cssWidth, cssHeight);
          staticLayerCacheRef.current = {
            key: staticLayerKey,
            canvas: staticCanvas,
          };
        }
      }

      if (staticLayerCacheRef.current.canvas) {
        context.drawImage(staticLayerCacheRef.current.canvas, 0, 0, cssWidth, cssHeight);
      } else {
        drawStaticSceneLayer(context, mode, model, scale, projectPoint, cssWidth, cssHeight);
      }

      // Fire overlay: runtime-driven burn map on top of scene voxels.
      if (model.fires.length > 0 && model.sceneVoxels.length > 0) {
        const wetNozzles = model.nozzles.filter((nozzle) => nozzle.hasWater);

        model.sceneVoxels.forEach((voxel) => {
          let strongestHeat = 0;
          let dominantFire: FireNode | null = null;

          for (const fire of model.fires) {
            const fireRadius = Math.sqrt(Math.max(0.5, fire.areaM2) / Math.PI);
            const distance = Math.hypot(voxel.center.x - fire.center.x, voxel.center.y - fire.center.y);
            if (distance > fireRadius) {
              continue;
            }
            const heat = Math.max(0, 1 - distance / Math.max(1e-6, fireRadius));
            if (heat > strongestHeat) {
              strongestHeat = heat;
              dominantFire = fire;
            }
          }

          if (!dominantFire || strongestHeat <= 0) {
            return;
          }

          const hasWaterHere = wetNozzles.some(
            (nozzle) => Math.hypot(voxel.center.x - nozzle.center.x, voxel.center.y - nozzle.center.y) <= nozzle.radiusM,
          );

          const burnCollapse = Math.max(0, strongestHeat - (hasWaterHere ? 0.8 : 0.72));
          const pulse = 0.86 + 0.14 * Math.sin(timestamp * 0.007 + strongestHeat * 5 + dominantFire.rank * 0.31);
          const iso = projectPoint(voxel.center, voxel.height * 0.12 + 0.2);
          const sizePx = Math.max(voxel.size, 1) * scale;

          if (burnCollapse > 0) {
            // Core burn zone: visually "collapsed" voxel (burnt out / destroyed).
            const collapsedHeight = Math.max(0.7, voxel.height * scale * (0.18 + (1 - burnCollapse) * 0.22));
            drawIsoPrism(
              context,
              iso,
              sizePx * 0.98,
              collapsedHeight,
              'rgba(26, 29, 34, 0.94)',
              'rgba(14, 16, 21, 0.96)',
              'rgba(19, 22, 27, 0.96)',
            );
            return;
          }

          const heatedHeight = voxel.height * scale * pulse;
          const g = Math.round(130 - strongestHeat * 104);
          drawIsoPrism(
            context,
            iso,
            sizePx,
            heatedHeight,
            `rgba(255, ${g + 46}, ${hasWaterHere ? 118 : 0}, ${0.8 + strongestHeat * 0.16})`,
            `rgba(186, ${g}, ${hasWaterHere ? 84 : 0}, 0.9)`,
            `rgba(228, ${g + 22}, ${hasWaterHere ? 102 : 0}, 0.93)`,
          );
        });
      }

      model.hoses.forEach((hose) => {
        if (hose.points.length < 2) {
          return;
        }
        context.beginPath();
        hose.points.forEach((point, index) => {
          const projected = projectPoint(point, 0.12);
          if (index === 0) {
            context.moveTo(projected.x, projected.y);
          } else {
            context.lineTo(projected.x, projected.y);
          }
        });
        context.strokeStyle = hose.blockedReason
          ? 'rgba(211, 47, 47, 0.9)'
          : hose.hasWater
            ? 'rgba(69, 190, 255, 0.88)'
            : 'rgba(204, 124, 63, 0.62)';
        context.lineWidth = Math.max(1.2, 2.2 * scale);
        context.stroke();
      });

      model.fires.forEach((fire, index) => {
        const pulse = 0.85 + 0.2 * Math.sin(timestamp * 0.008 + index * 0.9);
        const base = projectPoint(fire.center, 0.2);
        const size = Math.max(5, Math.min(18, (Math.sqrt(fire.areaM2) * 0.52 + 4.1) * scale));
        const height = Math.max(8, Math.min(32, size * 1.25 * pulse));

        // Intensity coloring based on rank and power
        const intensity = Math.min(1, ((fire.rank - 1) / 4) * 0.55 + ((fire.power - 0.35) / 3.65) * 0.45);
        // Low intensity = yellow/amber, high intensity = deep red
        const rTop = Math.round(255 - intensity * 40);
        const gTop = Math.round(200 - intensity * 155);
        const bTop = Math.round(80 - intensity * 50);
        const rLeft = Math.round(200 - intensity * 80);
        const gLeft = Math.round(90 - intensity * 60);
        const bLeft = Math.round(40 - intensity * 20);
        const rRight = Math.round(240 - intensity * 60);
        const gRight = Math.round(110 - intensity * 80);
        const bRight = Math.round(50 - intensity * 25);

        const glowRadius = Math.max(14, Math.min(80, Math.sqrt(fire.areaM2) * 3.2 * scale));
        const glow = context.createRadialGradient(
          base.x,
          base.y - size * 0.35,
          2,
          base.x,
          base.y - size * 0.35,
          glowRadius,
        );
        glow.addColorStop(0, `rgba(255, ${Math.round(170 - intensity * 70)}, 54, 0.32)`);
        glow.addColorStop(0.45, `rgba(255, ${Math.round(128 - intensity * 58)}, 34, 0.14)`);
        glow.addColorStop(1, 'rgba(255, 95, 24, 0)');
        context.fillStyle = glow;
        context.beginPath();
        context.ellipse(base.x, base.y - size * 0.25, glowRadius, glowRadius * 0.5, 0, 0, Math.PI * 2);
        context.fill();

        drawIsoPrism(
          context,
          base,
          size,
          height,
          `rgba(${rTop},${gTop},${bTop},0.95)`,
          `rgba(${rLeft},${gLeft},${bLeft},0.92)`,
          `rgba(${rRight},${gRight},${bRight},0.94)`,
        );

        context.beginPath();
        context.moveTo(base.x, base.y - height - size * 1.2);
        context.lineTo(base.x + size * 0.5, base.y - height - size * 0.2);
        context.lineTo(base.x - size * 0.5, base.y - height - size * 0.2);
        context.closePath();
        const tipR = Math.round(255 - intensity * 20);
        const tipG = Math.round(220 - intensity * 120);
        const tipB = Math.round(110 - intensity * 60);
        context.fillStyle = `rgba(${tipR}, ${tipG}, ${tipB}, 0.95)`;
        context.fill();
      });

      model.smokes.forEach((smoke, index) => {
        const centerIso = projectPoint(smoke.center, 1.8);
        const spread = Math.max(10, Math.min(44, Math.sqrt(smoke.areaM2) * 1.4 * scale));
        const drift = Math.sin(timestamp * 0.0018 + index) * 4.5;
        const drift2 = Math.cos(timestamp * 0.0012 + index * 1.3) * 3.2;

        // Primary smoke cloud
        const radial = context.createRadialGradient(
          centerIso.x + drift,
          centerIso.y - spread * 0.2,
          3,
          centerIso.x + drift,
          centerIso.y - spread * 0.2,
          spread,
        );
        radial.addColorStop(0, 'rgba(176, 186, 200, 0.52)');
        radial.addColorStop(0.5, 'rgba(130, 142, 158, 0.28)');
        radial.addColorStop(1, 'rgba(55, 63, 74, 0.04)');
        context.fillStyle = radial;
        context.beginPath();
        context.arc(centerIso.x + drift, centerIso.y - spread * 0.2, spread, 0, Math.PI * 2);
        context.fill();

        // Secondary smoke puff offset 
        const radial2 = context.createRadialGradient(
          centerIso.x + drift2 * 2.5,
          centerIso.y - spread * 0.55,
          2,
          centerIso.x + drift2 * 2.5,
          centerIso.y - spread * 0.55,
          spread * 0.65,
        );
        radial2.addColorStop(0, 'rgba(155, 165, 178, 0.36)');
        radial2.addColorStop(1, 'rgba(55, 63, 74, 0.02)');
        context.fillStyle = radial2;
        context.beginPath();
        context.arc(centerIso.x + drift2 * 2.5, centerIso.y - spread * 0.55, spread * 0.65, 0, Math.PI * 2);
        context.fill();
      });

      model.vehicles.forEach((vehicle) => {
        const iso = projectPoint(vehicle.center, 0.16);
        const topColor = STATUS_COLORS[vehicle.status] ?? '#7f858f';

        drawIsoPrism(
          context,
          iso,
          7 * scale,
          12 * scale,
          topColor,
          'rgba(24, 37, 53, 0.92)',
          'rgba(45, 59, 79, 0.92)',
        );

        if (vehicle.waterRatio !== null) {
          const barWidth = 16 * scale;
          const barHeight = 3.5 * scale;
          const x = iso.x - barWidth / 2;
          const y = iso.y - 20 * scale;
          context.fillStyle = 'rgba(19, 26, 34, 0.88)';
          context.fillRect(x, y, barWidth, barHeight);
          context.fillStyle = vehicle.waterRatio > 0.2 ? '#4db5ff' : '#ff8f4d';
          context.fillRect(x + 0.7, y + 0.7, (barWidth - 1.4) * vehicle.waterRatio, barHeight - 1.4);
        }
      });

      model.nozzles.forEach((nozzle, index) => {
        const nozzleIso = projectPoint(nozzle.center, 0.2);
        const size = 4 * scale;
        const nozzleIsBlocked = Boolean(nozzle.blockedReason);
        drawIsoPrism(
          context,
          nozzleIso,
          size,
          6 * scale,
          nozzleIsBlocked ? 'rgba(211, 47, 47, 0.95)' : nozzle.hasWater ? 'rgba(101, 225, 255, 0.95)' : 'rgba(208, 150, 82, 0.9)',
          nozzleIsBlocked ? 'rgba(150, 20, 20, 0.9)' : nozzle.hasWater ? 'rgba(54, 152, 193, 0.9)' : 'rgba(148, 96, 38, 0.85)',
          nozzleIsBlocked ? 'rgba(180, 32, 32, 0.9)' : nozzle.hasWater ? 'rgba(66, 177, 224, 0.9)' : 'rgba(170, 111, 48, 0.9)',
        );

        if (nozzleIsBlocked) {
          // Draw "!" warning indicator above blocked nozzle
          context.fillStyle = 'rgba(255, 80, 80, 0.95)';
          context.font = `bold ${Math.max(8, 9 * scale)}px monospace`;
          context.textAlign = 'center';
          context.fillText('!', nozzleIso.x, nozzleIso.y - 10 * scale);
          return;
        }

        if (!nozzle.hasWater) {
          return;
        }

        // Suppression zone overlay - ellipse showing effective radius
        const zoneRadiusPx = Math.max(6, nozzle.radiusM * scale * 1.8);
        const zonePulse = 0.7 + 0.15 * Math.sin(timestamp * 0.003 + index * 0.7);
        context.save();
        context.globalAlpha = 0.2 * zonePulse;
        context.beginPath();
        context.ellipse(
          nozzleIso.x,
          nozzleIso.y,
          zoneRadiusPx,
          zoneRadiusPx * 0.5,
          0,
          0,
          Math.PI * 2,
        );
        context.fillStyle = 'rgba(80, 200, 255, 0.45)';
        context.fill();
        context.strokeStyle = 'rgba(120, 220, 255, 0.55)';
        context.lineWidth = 1;
        context.stroke();
        context.restore();

        const target = nearestFire(nozzle.center, model.fires);
        if (!target) {
          return;
        }

        const targetIso = projectPoint(target.center, 0.8);
        const curvature = 10 * scale + Math.sin(timestamp * 0.002 + index) * 3;

        context.beginPath();
        context.moveTo(nozzleIso.x, nozzleIso.y - 4 * scale);
        context.quadraticCurveTo(
          (nozzleIso.x + targetIso.x) / 2,
          Math.min(nozzleIso.y, targetIso.y) - curvature,
          targetIso.x,
          targetIso.y,
        );
        context.strokeStyle = 'rgba(110, 219, 255, 0.8)';
        context.lineWidth = Math.max(1.2, 1.8 * scale);
        context.stroke();

        const droplets = Math.max(2, Math.min(6, Math.round(nozzle.flowLps / 2.2)));
        for (let dropletIndex = 0; dropletIndex < droplets; dropletIndex += 1) {
          const t = (((timestamp * 0.0012 + dropletIndex * 0.18 + index * 0.31) % 1) + 1) % 1;
          const qx = (1 - t) * (1 - t) * nozzleIso.x
            + 2 * (1 - t) * t * ((nozzleIso.x + targetIso.x) / 2)
            + t * t * targetIso.x;
          const qy = (1 - t) * (1 - t) * (nozzleIso.y - 4 * scale)
            + 2 * (1 - t) * t * (Math.min(nozzleIso.y, targetIso.y) - curvature)
            + t * t * targetIso.y;
          context.fillStyle = 'rgba(187, 241, 255, 0.9)';
          context.fillRect(qx - 1, qy - 1, 2, 2);
        }
      });

      animationFrameId = window.requestAnimationFrame(renderFrame);
    };

    animationFrameId = window.requestAnimationFrame(renderFrame);

    return () => {
      mounted = false;
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [
    cameraMode,
    cameraPitch,
    cameraTarget,
    cameraYaw,
    cameraZoom,
    isInteractive,
    model,
    mode,
    renderPayload.signatures.lod,
    renderPayload.signatures.scene,
  ]);

  useEffect(() => {
    if (!isInteractive) {
      pointerStateRef.current.active = false;
    }
  }, [isInteractive]);

  const handleCanvasMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isInteractive) {
      return;
    }
    if (event.button !== 0 && event.button !== 2) {
      return;
    }

    const intent = cameraMode === 'ORBIT_FREE' && event.button === 0 && !event.shiftKey ? 'orbit' : 'pan';
    pointerStateRef.current = {
      active: true,
      lastX: event.clientX,
      lastY: event.clientY,
      intent,
    };
    event.preventDefault();
  };

  const handleCanvasMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isInteractive || !pointerStateRef.current.active) {
      return;
    }

    const deltaX = event.clientX - pointerStateRef.current.lastX;
    const deltaY = event.clientY - pointerStateRef.current.lastY;
    pointerStateRef.current.lastX = event.clientX;
    pointerStateRef.current.lastY = event.clientY;

    if (pointerStateRef.current.intent === 'orbit') {
      orbitCameraBy(deltaX * 0.0085, -deltaY * 0.0075);
      event.preventDefault();
      return;
    }

    const basis = cameraBasisRef.current;
    if (!basis) {
      return;
    }

    const det = basis.vx.x * basis.vy.y - basis.vx.y * basis.vy.x;
    if (Math.abs(det) < 1e-5) {
      return;
    }

    const worldX = (deltaX * basis.vy.y - deltaY * basis.vy.x) / det;
    const worldY = (basis.vx.x * deltaY - basis.vx.y * deltaX) / det;
    panCameraBy(-worldX, -worldY);
    event.preventDefault();
  };

  const stopDrag = () => {
    pointerStateRef.current.active = false;
  };

  const handleCanvasWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    if (!isInteractive) {
      return;
    }
    zoomCameraBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
    event.preventDefault();
  };

  const hasSceneData = counters.fires + counters.smokes + counters.vehicles + model.hoses.length + model.nozzles.length + counters.mapVoxels > 0;

  const canvasHeightClass = mode === 'fullscreen' ? 'h-full min-h-[420px]' : 'h-[210px]';

  return (
    <div className={`bg-[#11161d] border-2 border-black ${mode === 'fullscreen' ? 'h-full flex flex-col' : ''} ${className}`}>
      <div className="px-2 py-1 border-b border-black bg-[#1a222b] flex items-center justify-between gap-2">
        <span className="text-[7px] uppercase text-cyan-200 tracking-wide">{title}</span>
        <span className="text-[6px] text-gray-300 uppercase">
          map {counters.mapVoxels} | fire {counters.fires} | smoke {counters.smokes} | veh {counters.vehicles} | noz {counters.wetNozzles} | lod {renderPayload.lod} {renderPayload.voxelStepM.toFixed(2)}m | cam {(isInteractive ? cameraMode : 'ISO_LOCKED').toLowerCase()} z{(isInteractive ? cameraZoom : 1).toFixed(2)}
        </span>
      </div>

      <div className={`relative ${canvasHeightClass} bg-[#0d131a]`}>
        <canvas
          ref={canvasRef}
          className={`w-full h-full ${isInteractive ? 'cursor-grab active:cursor-grabbing' : ''}`}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={stopDrag}
          onMouseLeave={stopDrag}
          onWheel={handleCanvasWheel}
          onContextMenu={(event) => {
            if (isInteractive) {
              event.preventDefault();
            }
          }}
        />
        {!hasSceneData ? (
          <div className="absolute inset-0 flex items-center justify-center text-[7px] text-gray-400 uppercase tracking-wide">
            waiting for simulation data
          </div>
        ) : null}
        {isInteractive ? (
          <div className="absolute left-2 bottom-2 text-[6px] uppercase tracking-wide text-cyan-100/80 bg-black/40 border border-cyan-900/70 px-2 py-1">
            1 ISO | 2 TOP | 3 ORBIT | F FIT | WHEEL ZOOM | LMB/RMB DRAG
          </div>
        ) : null}
      </div>
    </div>
  );
};
