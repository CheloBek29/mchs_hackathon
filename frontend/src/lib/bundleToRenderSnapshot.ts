import type { RenderSnapshot, RenderVoxel, RenderWaterSource, RenderWeather } from './renderer-three/types.js';
import type { SessionStateBundleDto } from '../shared/api/types';
import { extractFireRuntime } from '../shared/api/fireRuntimeTypes';

const VOXEL_STEP_M = 1.5;

function toNum(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

function toRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function toArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ── Geometry parsing (backend format) ─────────────────────────────────────────
// POINT:   geometry = {x: float, y: float}
// POLYGON: geometry = {points: [{x: float, y: float}, ...]}

function parsePointCenter(geometry: unknown): [number, number] | null {
  const g = toRecord(geometry);
  if (!g) return null;
  const x = toNum(g.x, NaN);
  const y = toNum(g.y, NaN);
  if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
  return null;
}

function parsePolygonPoints(geometry: unknown): [number, number][] | null {
  const g = toRecord(geometry);
  if (!g) return null;
  const pts = toArray(g.points);
  if (pts.length < 2) return null;
  return pts.map((pt) => {
    const p = toRecord(pt);
    return [toNum(p?.x ?? 0), toNum(p?.y ?? 0)] as [number, number];
  });
}

function parseGeometryCenter(geometryType: unknown, geometry: unknown): [number, number] | null {
  const gType = String(geometryType ?? '').toUpperCase();
  if (gType === 'POINT') {
    return parsePointCenter(geometry);
  }
  if (gType === 'POLYGON' || gType === 'LINESTRING') {
    const pts = parsePolygonPoints(geometry);
    if (!pts || pts.length === 0) return null;
    let sx = 0, sy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; }
    return [sx / pts.length, sy / pts.length];
  }
  return null;
}

// ── Point-in-polygon (ray casting) ────────────────────────────────────────────
function pointInPolygon(px: number, py: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function mapToRenderVoxel(
  x: number,
  y: number,
  materialType: string,
  isBurning: boolean,
  temperature: number,
): RenderVoxel {
  // Renderer axis convention:
  // - RenderVoxel.x / .y => ground plane coordinates
  // - RenderVoxel.z      => vertical height
  return { x, y, z: 0, materialType, isBurning, temperature };
}

function voxelKey(voxel: RenderVoxel): string {
  return `${Math.round(voxel.x * 100)}:${Math.round(voxel.y * 100)}:${Math.round(voxel.z * 100)}`;
}

// ── Rasterize a polygon into a grid of voxels ─────────────────────────────────
function rasterizePolygon(
  coords: [number, number][],
  step: number,
  temperature: number,
  isBurning: boolean,
  material: string,
): RenderVoxel[] {
  if (coords.length < 3) return [];
  const xs = coords.map((c) => c[0]);
  const ys = coords.map((c) => c[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const voxels: RenderVoxel[] = [];
  for (let x = minX + step * 0.5; x <= maxX; x += step) {
    for (let y = minY + step * 0.5; y <= maxY; y += step) {
      if (pointInPolygon(x, y, coords)) {
        voxels.push(mapToRenderVoxel(x, y, material, isBurning, temperature));
      }
    }
  }
  return voxels;
}

// ── Rasterize ellipse as fallback for fire without building ───────────────────
function rasterizeEllipse(
  cx: number,
  cy: number,
  radius: number,
  directionDeg: number,
  step: number,
  temperature: number,
): RenderVoxel[] {
  const voxels: RenderVoxel[] = [];
  const dirRad = (directionDeg * Math.PI) / 180;
  const aMajor = radius * 1.4;
  const bMinor = radius * 0.7;
  const cosD = Math.cos(dirRad);
  const sinD = Math.sin(dirRad);
  const searchR = aMajor + step;

  for (let dx = -searchR; dx <= searchR; dx += step) {
    for (let dy = -searchR; dy <= searchR; dy += step) {
      const localX = dx * cosD + dy * sinD;
      const localY = -dx * sinD + dy * cosD;
      if ((localX / aMajor) ** 2 + (localY / bMinor) ** 2 <= 1) {
        voxels.push(mapToRenderVoxel(cx + dx, cy + dy, 'WOOD', true, temperature));
      }
    }
  }
  return voxels;
}

// ── Building extraction and fire→building mapping ─────────────────────────────
interface BuildingEntry {
  coords: [number, number][];
}

function extractBuildings(bundle: SessionStateBundleDto): BuildingEntry[] {
  const snapshotData = toRecord(bundle?.snapshot?.snapshot_data);
  const scene = toRecord(snapshotData?.training_lead_scene);
  const entities = toArray(scene?.site_entities);
  const result: BuildingEntry[] = [];
  for (const entity of entities) {
    const e = toRecord(entity);
    if (!e) continue;
    if (String(e.kind ?? '').toUpperCase() !== 'BUILDING_CONTOUR') continue;
    if (String(e.geometry_type ?? '').toUpperCase() !== 'POLYGON') continue;
    const coords = parsePolygonPoints(e.geometry);
    if (!coords || coords.length < 3) continue;
    result.push({ coords });
  }
  return result;
}

function findBuildingIndexForPoint(cx: number, cy: number, buildings: BuildingEntry[]): number {
  // 1. Building that contains the point
  for (let i = 0; i < buildings.length; i += 1) {
    if (pointInPolygon(cx, cy, buildings[i].coords)) return i;
  }
  // 2. Nearest building by centroid
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < buildings.length; i += 1) {
    const b = buildings[i];
    const bcx = b.coords.reduce((s, p) => s + p[0], 0) / b.coords.length;
    const bcy = b.coords.reduce((s, p) => s + p[1], 0) / b.coords.length;
    const d = Math.hypot(cx - bcx, cy - bcy);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ── Fire voxels sorted from center outward ────────────────────────────────────
function buildFireVoxels(
  cx: number,
  cy: number,
  areaM2: number,
  building: BuildingEntry,
  temperature: number,
): RenderVoxel[] {
  const allV = rasterizePolygon(building.coords, VOXEL_STEP_M, temperature, true, 'WOOD');
  // Sort by distance from fire center
  allV.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
  const voxelArea = VOXEL_STEP_M * VOXEL_STEP_M;
  const count = Math.max(1, Math.ceil(areaM2 / voxelArea));
  return allV.slice(0, count);
}

// ── Main adapter ──────────────────────────────────────────────────────────────
export function adaptBundleToRenderSnapshot(bundle: SessionStateBundleDto): RenderSnapshot {
  const snapshotData = toRecord(bundle?.snapshot?.snapshot_data);
  const fireRuntime = extractFireRuntime(snapshotData);
  const fireDirections = fireRuntime.fire_directions ?? {};

  const weather = buildWeather(bundle);
  const voxels: RenderVoxel[] = [];
  const buildings = extractBuildings(bundle);

  const activeFires = (bundle?.fire_objects ?? []).filter((f) => f.is_active && f.kind !== 'SMOKE_ZONE');
  const burningKeysByBuilding = new Map<number, Set<string>>();
  const fireVoxelsOnBuildings: RenderVoxel[] = [];
  const fireVoxelsOutsideBuildings: RenderVoxel[] = [];

  // 1. Build burning voxels for each active fire first.
  for (const fire of activeFires) {
    const fireId = String(fire.id);
    const dirItem = fireDirections[fireId];
    const areaM2 = toNum(dirItem?.area_m2 ?? fire.area_m2 ?? 0);
    if (areaM2 <= 0) continue;

    const center = parseGeometryCenter(fire.geometry_type, fire.geometry);
    if (!center) continue;

    const rank = toNum(fire.extra?.fire_rank ?? 1, 1);
    const power = toNum(fire.extra?.fire_power ?? 1.0, 1.0);
    const temperature = 300 + (rank - 1) * 120 + (power - 0.35) * 200;

    const buildingIdx = findBuildingIndexForPoint(center[0], center[1], buildings);
    const building = buildingIdx >= 0 ? buildings[buildingIdx] : null;
    if (building) {
      const burningVoxels = buildFireVoxels(center[0], center[1], areaM2, building, temperature);
      fireVoxelsOnBuildings.push(...burningVoxels);

      let buildingBurningSet = burningKeysByBuilding.get(buildingIdx);
      if (!buildingBurningSet) {
        buildingBurningSet = new Set<string>();
        burningKeysByBuilding.set(buildingIdx, buildingBurningSet);
      }
      for (const voxel of burningVoxels) {
        buildingBurningSet.add(voxelKey(voxel));
      }
    } else {
      // Fallback: directional ellipse
      const radius = Math.sqrt(areaM2 / Math.PI);
      const dirDeg = toNum(dirItem?.direction_deg ?? 0);
      fireVoxelsOutsideBuildings.push(...rasterizeEllipse(center[0], center[1], radius, dirDeg, VOXEL_STEP_M, temperature));
    }
  }

  // 2. Buildings remain visible while only currently burning cells are removed.
  buildings.forEach((b, idx) => {
    const buildingConcrete = rasterizePolygon(b.coords, VOXEL_STEP_M, 20, false, 'CONCRETE');
    const burned = burningKeysByBuilding.get(idx);
    if (!burned || burned.size === 0) {
      voxels.push(...buildingConcrete);
      return;
    }
    for (const voxel of buildingConcrete) {
      if (!burned.has(voxelKey(voxel))) {
        voxels.push(voxel);
      }
    }
  });

  // 3. Add active fire voxels on top.
  voxels.push(...fireVoxelsOnBuildings, ...fireVoxelsOutsideBuildings);

  // 4. Water sources from nozzle deployments with water
  const waterSources: RenderWaterSource[] = [];
  const nozzleRuntime = fireRuntime.nozzle_runtime ?? {};
  for (const dep of bundle?.resource_deployments ?? []) {
    if (dep.resource_kind !== 'NOZZLE') continue;
    if (dep.status !== 'ACTIVE' && dep.status !== 'DEPLOYED') continue;
    const rt = nozzleRuntime[dep.id];
    if (!rt?.has_water) continue;

    const center = parseGeometryCenter(dep.geometry_type, dep.geometry);
    if (!center) continue;

    const rd = toRecord(dep.resource_data);
    const radiusM = toNum(rd?.nozzle_radius_m ?? rd?.radius_m ?? 10);
    const flowLs = toNum(rt.effective_flow_l_s ?? rd?.flow_l_s ?? 3.5);
    waterSources.push({
      x: center[0],
      y: center[1],
      z: 0,
      radiusM: Math.max(3, radiusM),
      flowRateLs: Math.max(1, flowLs),
    });
  }

  return { voxels, waterSources, weather };
}

function buildWeather(bundle: SessionStateBundleDto): RenderWeather {
  const w = bundle?.weather as Record<string, unknown> | null | undefined;
  return {
    windSpeedMs: toNum(w?.wind_speed),
    windDirectionDeg: toNum(w?.wind_dir),
    ambientTempC: toNum(w?.temperature, 20),
    humidityPct: toNum(w?.humidity, 50),
  };
}
