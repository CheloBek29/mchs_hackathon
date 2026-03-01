import { adaptBundleToRenderSnapshot } from './bundleToRenderSnapshot.js';
import type {
  GeometryType,
  SessionStateBundleDto,
} from '../shared/api/types';
import { extractFireRuntime } from '../shared/api/fireRuntimeTypes';
import type {
  RetroBurnCell,
  RetroEmitter,
  RetroRenderSnapshot,
  RetroShape,
  RetroVehicleRenderState,
  RetroWaterJetRenderState,
} from './renderer-retro/types.js';
import type { RenderVoxel } from './renderer-three/types.js';

type Point = { x: number; y: number };

function toNumber(value: unknown): number | null {
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
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toPoint(value: unknown): Point | null {
  const node = toRecord(value);
  if (!node) {
    return null;
  }
  const x = toNumber(node.x);
  const y = toNumber(node.y);
  if (x === null || y === null) {
    return null;
  }
  return { x, y };
}

function parseGeometryPoints(geometryType: GeometryType, geometry: Record<string, unknown>): Point[] {
  if (geometryType === 'POINT') {
    const point = toPoint(geometry);
    return point ? [point] : [];
  }
  const pointsRaw = geometry.points;
  if (!Array.isArray(pointsRaw)) {
    return [];
  }
  return pointsRaw
    .map((entry) => toPoint(entry))
    .filter((entry): entry is Point => entry !== null);
}

function parseGeometryCenter(geometryType: GeometryType, geometry: Record<string, unknown>): Point | null {
  const points = parseGeometryPoints(geometryType, geometry);
  if (points.length === 0) {
    return null;
  }
  if (geometryType === 'POINT') {
    return points[0];
  }
  const sum = points.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function resolveBaseHeightM(kind: string): number {
  switch (kind) {
    case 'BUILDING_CONTOUR':
      return 5.0;
    case 'WALL':
      return 3.2;
    case 'ROOM':
      return 2.8;
    case 'STAIR':
      return 3.0;
    case 'DOOR':
      return 2.2;
    case 'EXIT':
      return 2.4;
    case 'ROAD_ACCESS':
      return 0.2;
    case 'HYDRANT':
    case 'WATER_SOURCE':
      return 1.4;
    default:
      return 1.0;
  }
}

function resolveHeightM(
  kind: string,
  props: Record<string, unknown> | null,
): number {
  if (props) {
    const heightCandidates = [
      props.height_m,
      props.wall_height_m,
      props.object_height_m,
      props.elevation_m,
    ];
    for (const candidate of heightCandidates) {
      const value = toNumber(candidate);
      if (value !== null && value > 0) {
        return value;
      }
    }
    const levels = toNumber(props.levels);
    if (levels !== null && levels > 0) {
      return Math.max(1.5, levels * 2.8);
    }
  }
  return resolveBaseHeightM(kind);
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
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
}

function sampleLine(points: Point[], step: number): Point[] {
  if (points.length < 2) {
    return [];
  }

  const samples: Point[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const segments = Math.max(1, Math.ceil(length / Math.max(0.45, step)));
    for (let segment = 0; segment <= segments; segment += 1) {
      const t = segment / segments;
      samples.push({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
      });
    }
  }
  return samples;
}

function samplePolygon(points: Point[], step: number): Point[] {
  if (points.length < 3) {
    return [];
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

  const sampled: Point[] = [];
  const safeStep = Math.max(0.65, step);
  for (let y = minY; y <= maxY; y += safeStep) {
    for (let x = minX; x <= maxX; x += safeStep) {
      const point = { x, y };
      if (pointInPolygon(point, points)) {
        sampled.push(point);
      }
    }
  }
  return sampled;
}

function materialByKind(kind: string): string {
  if (kind === 'BUILDING_CONTOUR' || kind === 'WALL' || kind === 'ROOM') {
    return 'CONCRETE';
  }
  if (kind === 'ROAD_ACCESS') {
    return 'OIL';
  }
  if (kind === 'HYDRANT' || kind === 'WATER_SOURCE' || kind === 'STAIR' || kind === 'DOOR' || kind === 'EXIT') {
    return 'WOOD';
  }
  return 'UNKNOWN';
}

function pushStackedVoxelColumn(
  target: RenderVoxel[],
  x: number,
  y: number,
  elevationM: number,
  heightM: number,
  materialType: string,
): void {
  const safeElevation = Math.max(0, elevationM);
  const safeHeight = Math.max(0.2, heightM);
  const verticalStep = 1;
  const levels = Math.max(1, Math.ceil(safeHeight / verticalStep));
  const baseZ = safeElevation;

  for (let level = 0; level < levels; level += 1) {
    target.push({
      x,
      y,
      z: baseZ + level * verticalStep,
      materialType,
      isBurning: false,
      temperature: 20,
    });
  }
}

function compileShapeToVoxels(shape: RetroShape): RenderVoxel[] {
  const material = materialByKind(shape.kind);
  const voxels: RenderVoxel[] = [];
  const baseStep = shape.kind === 'BUILDING_CONTOUR' ? 1.2 : 1.0;

  if (shape.geometryType === 'POINT') {
    if (shape.center) {
      pushStackedVoxelColumn(voxels, shape.center.x, shape.center.y, shape.elevationM, shape.heightM, material);
    }
    return voxels;
  }

  if (shape.geometryType === 'LINESTRING') {
    const sampledLine = sampleLine(shape.points, baseStep);
    for (const point of sampledLine) {
      pushStackedVoxelColumn(voxels, point.x, point.y, shape.elevationM, shape.heightM, material);
    }
    return voxels;
  }

  const sampledPoly = samplePolygon(shape.points, baseStep);
  for (const point of sampledPoly) {
    pushStackedVoxelColumn(voxels, point.x, point.y, shape.elevationM, shape.heightM, material);
  }
  return voxels;
}

function compileStaticVoxelsFromShapes(shapes: RetroShape[]): RenderVoxel[] {
  const dedup = new Map<string, RenderVoxel>();
  for (const shape of shapes) {
    const shapeVoxels = compileShapeToVoxels(shape);
    for (const voxel of shapeVoxels) {
      const key = `${Math.round(voxel.x * 10)}:${Math.round(voxel.y * 10)}:${Math.round(voxel.z * 10)}`;
      if (!dedup.has(key)) {
        dedup.set(key, voxel);
      }
    }
  }
  return Array.from(dedup.values());
}

function buildSceneShapes(bundle: SessionStateBundleDto): {
  buildingShells: RetroShape[];
  roads: RetroShape[];
  hydrants: RetroShape[];
  waterSources: RetroShape[];
  rooms: RetroShape[];
  walls: RetroShape[];
  doors: RetroShape[];
  stairs: RetroShape[];
  exits: RetroShape[];
} {
  const snapshotData = toRecord(bundle.snapshot?.snapshot_data);
  const scene = toRecord(snapshotData?.training_lead_scene);
  if (!scene) {
    return {
      buildingShells: [],
      roads: [],
      hydrants: [],
      waterSources: [],
      rooms: [],
      walls: [],
      doors: [],
      stairs: [],
      exits: [],
    };
  }

  const floorElevationById = new Map<string, number>();
  const floorsRaw = Array.isArray(scene.floors) ? scene.floors : [];
  for (const floorEntry of floorsRaw) {
    const floor = toRecord(floorEntry);
    if (!floor) {
      continue;
    }
    const floorId = typeof floor.floor_id === 'string' ? floor.floor_id : '';
    if (!floorId) {
      continue;
    }
    floorElevationById.set(floorId, toNumber(floor.elevation_m) ?? 0);
  }

  const activeFloorId = typeof scene.active_floor_id === 'string' ? scene.active_floor_id : '';
  const activeFloorRaw = floorsRaw.find((entry) => {
    const floor = toRecord(entry);
    return floor && typeof floor.floor_id === 'string' && floor.floor_id === activeFloorId;
  }) ?? floorsRaw[0];
  const activeFloor = toRecord(activeFloorRaw);
  const activeElevation = activeFloor && typeof activeFloor.floor_id === 'string'
    ? floorElevationById.get(activeFloor.floor_id) ?? 0
    : 0;

  const siteItemsRaw = Array.isArray(scene.site_entities) ? scene.site_entities : [];
  const floorItemsRaw = activeFloor && Array.isArray(activeFloor.objects) ? activeFloor.objects : [];

  const allItems = [
    ...siteItemsRaw.map((item) => ({ item, elevationM: 0 })),
    ...floorItemsRaw.map((item) => ({ item, elevationM: activeElevation })),
  ];

  const buildingShells: RetroShape[] = [];
  const roads: RetroShape[] = [];
  const hydrants: RetroShape[] = [];
  const waterSources: RetroShape[] = [];
  const rooms: RetroShape[] = [];
  const walls: RetroShape[] = [];
  const doors: RetroShape[] = [];
  const stairs: RetroShape[] = [];
  const exits: RetroShape[] = [];

  for (const entry of allItems) {
    const item = toRecord(entry.item);
    if (!item) {
      continue;
    }
    const kind = typeof item.kind === 'string' ? item.kind.toUpperCase() : 'SCENE_OBJECT';
    const geometryTypeRaw = typeof item.geometry_type === 'string' ? item.geometry_type.toUpperCase() : '';
    if (geometryTypeRaw !== 'POINT' && geometryTypeRaw !== 'LINESTRING' && geometryTypeRaw !== 'POLYGON') {
      continue;
    }
    const geometryType = geometryTypeRaw as GeometryType;
    const geometry = toRecord(item.geometry);
    if (!geometry) {
      continue;
    }
    const id = typeof item.id === 'string' ? item.id : `${kind}:${JSON.stringify(geometry).slice(0, 30)}`;
    const props = toRecord(item.props);

    const shape: RetroShape = {
      id,
      kind,
      geometryType,
      center: parseGeometryCenter(geometryType, geometry),
      points: parseGeometryPoints(geometryType, geometry),
      elevationM: entry.elevationM,
      heightM: resolveHeightM(kind, props),
    };

    if (kind === 'BUILDING_CONTOUR') {
      buildingShells.push(shape);
    } else if (kind === 'ROAD_ACCESS') {
      roads.push(shape);
    } else if (kind === 'HYDRANT') {
      hydrants.push(shape);
    } else if (kind === 'WATER_SOURCE') {
      waterSources.push(shape);
    } else if (kind === 'ROOM') {
      rooms.push(shape);
    } else if (kind === 'WALL') {
      walls.push(shape);
    } else if (kind === 'DOOR') {
      doors.push(shape);
    } else if (kind === 'STAIR') {
      stairs.push(shape);
    } else if (kind === 'EXIT') {
      exits.push(shape);
    }
  }

  return {
    buildingShells,
    roads,
    hydrants,
    waterSources,
    rooms,
    walls,
    doors,
    stairs,
    exits,
  };
}

function buildFireEmitters(bundle: SessionStateBundleDto, burningVoxels: RenderVoxel[]): RetroEmitter[] {
  const emitters: RetroEmitter[] = [];

  for (const fire of bundle.fire_objects ?? []) {
    if (!fire.is_active || fire.kind === 'SMOKE_ZONE') {
      continue;
    }
    const center = parseGeometryCenter(
      fire.geometry_type,
      toRecord(fire.geometry) ?? {},
    );
    if (!center) {
      continue;
    }

    const rank = Math.max(1, Math.min(5, Math.round(toNumber(fire.extra?.fire_rank) ?? 1)));
    const power = Math.max(0.35, Math.min(4, toNumber(fire.extra?.fire_power) ?? 1));
    const areaM2 = Math.max(1, toNumber(fire.area_m2) ?? 18);
    const intensity = Math.min(1, ((rank - 1) / 4) * 0.55 + ((power - 0.35) / 3.65) * 0.45);

    emitters.push({
      id: fire.id,
      x: center.x,
      y: center.y,
      z: 0,
      areaM2,
      intensity,
    });
  }

  if (emitters.length > 0 || burningVoxels.length === 0) {
    return emitters;
  }

  const fallbackStep = Math.max(1, Math.floor(burningVoxels.length / 32));
  for (let index = 0; index < burningVoxels.length; index += fallbackStep) {
    const voxel = burningVoxels[index];
    emitters.push({
      id: `voxel_fire_${index}`,
      x: voxel.x,
      y: voxel.y,
      z: voxel.z,
      areaM2: 2.25,
      intensity: Math.max(0.2, Math.min(1, voxel.temperature / 1000)),
    });
  }
  return emitters;
}

function buildSmokeEmitters(
  bundle: SessionStateBundleDto,
  fireEmitters: RetroEmitter[],
): RetroEmitter[] {
  const emitters: RetroEmitter[] = [];

  for (const fire of bundle.fire_objects ?? []) {
    if (!fire.is_active || fire.kind !== 'SMOKE_ZONE') {
      continue;
    }
    const center = parseGeometryCenter(
      fire.geometry_type,
      toRecord(fire.geometry) ?? {},
    );
    if (!center) {
      continue;
    }

    emitters.push({
      id: fire.id,
      x: center.x,
      y: center.y,
      z: 0,
      areaM2: Math.max(4, toNumber(fire.area_m2) ?? 24),
      intensity: 0.7,
    });
  }

  if (emitters.length > 0) {
    return emitters;
  }

  return fireEmitters.map((fireEmitter) => ({
    id: `smoke_from_${fireEmitter.id}`,
    x: fireEmitter.x,
    y: fireEmitter.y,
    z: fireEmitter.z,
    areaM2: Math.max(6, fireEmitter.areaM2 * 0.85),
    intensity: Math.min(1, 0.45 + fireEmitter.intensity * 0.5),
  }));
}

function buildBurnCells(burningVoxels: RenderVoxel[]): RetroBurnCell[] {
  return burningVoxels.map((voxel, index) => {
    const intensity = Math.max(0.2, Math.min(1, voxel.temperature / 1000));
    return {
      id: `burn_cell_${index}`,
      x: voxel.x,
      y: voxel.y,
      z: voxel.z,
      state: intensity > 0.35 ? 'burning' : 'charred',
      intensity,
      temperature: voxel.temperature,
    };
  });
}

function nearestEmitter(x: number, y: number, emitters: RetroEmitter[]): RetroEmitter | null {
  if (emitters.length === 0) {
    return null;
  }
  let best = emitters[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const emitter of emitters) {
    const dist = Math.hypot(emitter.x - x, emitter.y - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = emitter;
    }
  }
  return best;
}

function buildVehicles(bundle: SessionStateBundleDto): RetroVehicleRenderState[] {
  const snapshotData = toRecord(bundle.snapshot?.snapshot_data);
  const fireRuntime = extractFireRuntime(snapshotData);
  const vehicleRuntime = fireRuntime.vehicle_runtime ?? {};

  const vehicles: RetroVehicleRenderState[] = [];
  for (const deployment of bundle.resource_deployments ?? []) {
    if (deployment.resource_kind !== 'VEHICLE') {
      continue;
    }
    if (deployment.status === 'COMPLETED') {
      continue;
    }
    const center = parseGeometryCenter(
      deployment.geometry_type,
      toRecord(deployment.geometry) ?? {},
    );
    if (!center) {
      continue;
    }

    let waterRatio: number | null = null;
    const vehicleDictionaryId = deployment.vehicle_dictionary_id;
    if (vehicleDictionaryId) {
      const runtimeEntry = toRecord(vehicleRuntime[String(vehicleDictionaryId)]);
      const cap = toNumber(runtimeEntry?.water_capacity_l);
      const remaining = toNumber(runtimeEntry?.water_remaining_l);
      if (cap !== null && cap > 0 && remaining !== null) {
        waterRatio = Math.max(0, Math.min(1, remaining / cap));
      }
    }

    vehicles.push({
      id: deployment.id,
      x: center.x,
      y: center.y,
      z: 0,
      status: deployment.status,
      waterRatio,
    });
  }

  return vehicles;
}

function buildWaterJets(
  bundle: SessionStateBundleDto,
  fireEmitters: RetroEmitter[],
): RetroWaterJetRenderState[] {
  const snapshotData = toRecord(bundle.snapshot?.snapshot_data);
  const fireRuntime = extractFireRuntime(snapshotData);
  const nozzleRuntime = fireRuntime.nozzle_runtime ?? {};
  const jets: RetroWaterJetRenderState[] = [];

  for (const deployment of bundle.resource_deployments ?? []) {
    if (deployment.resource_kind !== 'NOZZLE') {
      continue;
    }
    if (deployment.status !== 'ACTIVE' && deployment.status !== 'DEPLOYED') {
      continue;
    }
    const runtime = toRecord(nozzleRuntime[deployment.id]);
    if (!runtime || runtime.has_water !== true) {
      continue;
    }

    const center = parseGeometryCenter(
      deployment.geometry_type,
      toRecord(deployment.geometry) ?? {},
    );
    if (!center) {
      continue;
    }

    const resourceData = toRecord(deployment.resource_data);
    const flowRateLs = Math.max(1, toNumber(runtime.effective_flow_l_s ?? resourceData?.flow_l_s) ?? 3.5);
    const radiusM = Math.max(3, toNumber(resourceData?.nozzle_radius_m ?? resourceData?.radius_m) ?? 9);
    const target = nearestEmitter(center.x, center.y, fireEmitters);

    jets.push({
      id: deployment.id,
      x: center.x,
      y: center.y,
      z: 0,
      targetX: target?.x ?? center.x,
      targetY: target?.y ?? center.y,
      targetZ: target?.z ?? 0,
      flowRateLs,
      radiusM,
    });
  }

  return jets;
}

export function adaptBundleToRetroSnapshot(bundle: SessionStateBundleDto): RetroRenderSnapshot {
  const legacyRenderSnapshot = adaptBundleToRenderSnapshot(bundle);
  const legacyStaticVoxels = legacyRenderSnapshot.voxels.filter((voxel) => !voxel.isBurning);
  const burningVoxels = legacyRenderSnapshot.voxels.filter((voxel) => voxel.isBurning);

  const shapes = buildSceneShapes(bundle);
  const staticVoxelsFromShapes = compileStaticVoxelsFromShapes([
    ...shapes.buildingShells,
    ...shapes.roads,
    ...shapes.hydrants,
    ...shapes.waterSources,
    ...shapes.rooms,
    ...shapes.walls,
    ...shapes.doors,
    ...shapes.stairs,
    ...shapes.exits,
  ]);
  const staticVoxels = staticVoxelsFromShapes.length > 0 ? staticVoxelsFromShapes : legacyStaticVoxels;
  const fireEmitters = buildFireEmitters(bundle, burningVoxels);
  const smokeEmitters = buildSmokeEmitters(bundle, fireEmitters);
  const burnCells = buildBurnCells(burningVoxels);
  const vehicles = buildVehicles(bundle);
  const waterJets = buildWaterJets(bundle, fireEmitters);

  const snapshotData = toRecord(bundle.snapshot?.snapshot_data);
  const fireRuntime = extractFireRuntime(snapshotData);
  const updatedAt = fireRuntime.updated_at ?? bundle.snapshot?.captured_at ?? null;
  const tickId = Math.max(0, Math.round(bundle.snapshot?.sim_time_seconds ?? 0));

  return {
    schemaVersion: 'retro-v1',
    tickId,
    updatedAt,
    weather: legacyRenderSnapshot.weather,
    staticScene: {
      voxels: staticVoxels,
      buildingShells: shapes.buildingShells,
      roads: shapes.roads,
      hydrants: shapes.hydrants,
      waterSources: shapes.waterSources,
      rooms: shapes.rooms,
      walls: shapes.walls,
      doors: shapes.doors,
      stairs: shapes.stairs,
      exits: shapes.exits,
    },
    dynamicState: {
      burningVoxels,
      burnCells,
      fireEmitters,
      smokeEmitters,
      vehicles,
      waterJets,
    },
    legacyRenderSnapshot,
  };
}

export function compactVehicleToVoxels(vehicles: RetroVehicleRenderState[]): RenderVoxel[] {
  const vehicleVoxels: RenderVoxel[] = [];

  for (const vehicle of vehicles) {
    const baseTemp = vehicle.status === 'ACTIVE' ? 36 : 24;
    const layout: Array<{ dx: number; dy: number; dz: number }> = [
      { dx: 0, dy: 0, dz: 0 },
      { dx: 1, dy: 0, dz: 0 },
      { dx: -1, dy: 0, dz: 0 },
      { dx: 0, dy: 1, dz: 0 },
      { dx: 0, dy: -1, dz: 0 },
      { dx: 0, dy: 0, dz: 1 },
    ];
    for (const part of layout) {
      vehicleVoxels.push({
        x: vehicle.x + part.dx * 0.8,
        y: vehicle.y + part.dy * 0.8,
        z: vehicle.z + part.dz * 0.7,
        materialType: 'CONCRETE',
        isBurning: false,
        temperature: baseTemp,
      });
    }
  }

  return vehicleVoxels;
}
