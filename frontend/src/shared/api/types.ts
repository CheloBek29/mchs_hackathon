import type { SnapshotDataRuntimeDto } from './fireRuntimeTypes';

export type SessionStatus = 'CREATED' | 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED';
export type TimeOfDay = 'DAY' | 'EVENING' | 'NIGHT';
export type WaterSupplyStatus = 'OK' | 'DEGRADED' | 'FAILED';
export type FireZoneKind = 'FIRE_SEAT' | 'FIRE_ZONE' | 'SMOKE_ZONE' | 'TEMP_IMPACT_ZONE';
export type GeometryType = 'POINT' | 'LINESTRING' | 'POLYGON';
export type ResourceKind = 'VEHICLE' | 'HOSE_LINE' | 'HOSE_SPLITTER' | 'NOZZLE' | 'WATER_SOURCE' | 'CREW' | 'MARKER';
export type HoseType = 'H51' | 'H66' | 'H77' | 'H150';
export type DeploymentStatus = 'PLANNED' | 'EN_ROUTE' | 'DEPLOYED' | 'ACTIVE' | 'COMPLETED';
export type VehicleType = 'AC' | 'AL' | 'ASA';

export interface SimulationSessionDto {
  id: string;
  status: SessionStatus;
  scenario_name: string;
  map_image_url: string | null;
  map_scale: number | null;
  weather: Record<string, unknown>;
  time_multiplier: number;
  created_at: string;
}

export interface RoleDto {
  id: number;
  name: string;
  description?: string | null;
}

export interface UserDto {
  id: string;
  username: string;
  email?: string;
  avatar_url: string | null;
  is_active: boolean;
  session_id: string | null;
  is_mfa_enabled: boolean;
  roles: RoleDto[];
  created_at: string;
  updated_at: string;
}

export interface SessionStateSnapshotDto {
  id: string;
  session_id: string;
  sim_time_seconds: number;
  time_of_day: TimeOfDay;
  water_supply_status: WaterSupplyStatus;
  is_current: boolean;
  snapshot_data: SnapshotDataRuntimeDto;
  notes: string | null;
  captured_at: string;
}

export interface WeatherSnapshotDto {
  id: string;
  state_id: string;
  wind_speed: number;
  wind_dir: number;
  temperature: number;
  humidity: number | null;
  precipitation: string | null;
  visibility_m: number | null;
  weather_data: Record<string, unknown>;
  created_at: string;
}

export interface FireObjectDto {
  id: string;
  state_id: string;
  name: string;
  kind: FireZoneKind;
  geometry_type: GeometryType;
  geometry: Record<string, unknown>;
  area_m2: number | null;
  perimeter_m: number | null;
  spread_speed_m_min: number | null;
  spread_azimuth: number | null;
  is_active: boolean;
  extra: Record<string, unknown>;
  created_at: string;
}

export interface ResourceDeploymentDto {
  id: string;
  state_id: string;
  resource_kind: ResourceKind;
  status: DeploymentStatus;
  vehicle_dictionary_id: number | null;
  user_id: string | null;
  label: string;
  geometry_type: GeometryType;
  geometry: Record<string, unknown>;
  rotation_deg: number | null;
  resource_data: Record<string, unknown>;
  created_at: string;
}

export interface VehicleDictionaryDto {
  id: number;
  type: VehicleType;
  name: string;
  water_capacity: number | null;
  foam_capacity: number | null;
  crew_size: number | null;
  hose_length: number | null;
}

export interface SessionStateBundleDto {
  session: SimulationSessionDto;
  snapshot: SessionStateSnapshotDto | null;
  weather: WeatherSnapshotDto | null;
  fire_objects: FireObjectDto[];
  resource_deployments: ResourceDeploymentDto[];
  snapshots_history: SessionStateSnapshotDto[];
}

export interface LessonLlmEvaluationRequestDto {
  session_id?: string | null;
  model?: string | null;
  max_radio_transmissions?: number;
  max_journal_entries?: number;
}

export interface LessonLlmEvaluationDto {
  session_id: string;
  generated_at: string;
  provider: string;
  model: string;
  request_stats: Record<string, unknown>;
  result_json: Record<string, unknown> | null;
  result_text: string | null;
}
