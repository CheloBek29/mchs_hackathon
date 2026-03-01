export const FIRE_RUNTIME_SCHEMA_VERSION = '2.0';

export type FireRuntimeForecast = 'growing' | 'stable' | 'suppressed';

export type NozzleBlockedReason =
  | 'NO_LINKED_HOSE'
  | 'NO_LINKED_SPLITTER'
  | 'NO_LINKED_VEHICLE'
  | 'NO_WATER_SOURCE'
  | 'NO_PRESSURE'
  | string;

export interface NozzleRuntimeItem {
  has_water: boolean;
  blocked_reason: NozzleBlockedReason | null;
  effective_flow_l_s?: number;
  suppression_factor?: number;
  linked_vehicle_id?: number | null;
  linked_hose_line_id?: string | null;
  linked_hose_line_chain_id?: string | null;
  strict_chain?: boolean;
  pressure?: number;
  spray_angle?: number;
  available_pressure_bar?: number;
  line_loss_bar?: number;
  pressure_factor?: number;
  line_length_m?: number;
  hose_type?: string;
  updated_at?: string;
}

export interface HoseRuntimeItem {
  has_water: boolean;
  blocked_reason?: string | null;
  linked_vehicle_id?: number | null;
  linked_splitter_id?: string | null;
  parent_chain_id?: string | null;
  chain_id?: string;
  strict_chain?: boolean;
  hose_type?: string;
  length_m?: number;
  updated_at?: string;
}

export interface VehicleRuntimeItem {
  water_capacity_l: number;
  water_remaining_l: number;
  is_empty: boolean;
  minutes_until_empty?: number | null;
  updated_at: string;
}

export interface FireDirectionItem {
  direction_deg: number;
  area_m2: number;
}

export interface FireRuntimeEnvironment {
  wind_speed: number;
  wind_dir: number;
  temperature: number;
  humidity: number;
  precipitation: string | null;
  weather_growth_factor: number;
  suppression_weather_boost: number;
}

export interface FireRuntimeHealth {
  ticks_total: number;
  dropped_ticks_total: number;
  tick_lag_sec: number;
  last_tick_at: string | null;
  loop_interval_sec: number;
  max_step_real_sec: number;
  dropped_ticks_last?: number;
  last_delta_real_sec?: number;
  last_delta_game_sec?: number;
}

export interface FireRuntimeSnapshot {
  schema_version?: string;
  vehicle_runtime: Record<string, VehicleRuntimeItem>;
  hose_runtime: Record<string, HoseRuntimeItem>;
  nozzle_runtime: Record<string, NozzleRuntimeItem>;
  fire_directions?: Record<string, FireDirectionItem>;
  q_required_l_s?: number;
  q_effective_l_s?: number;
  suppression_ratio?: number;
  forecast?: FireRuntimeForecast;
  effective_flow_l_s?: number;
  consumed_water_l_tick?: number;
  active_fire_objects?: number;
  active_smoke_objects?: number;
  active_nozzles?: number;
  wet_nozzles?: number;
  wet_hose_lines?: number;
  updated_at?: string;
  environment?: FireRuntimeEnvironment;
  runtime_health?: FireRuntimeHealth;
}

export interface SnapshotDataRuntimeDto extends Record<string, unknown> {
  snapshot_schema_version?: string;
  fire_runtime?: FireRuntimeSnapshot;
}

export function extractFireRuntime(
  snapshotData: Record<string, unknown> | null | undefined,
): FireRuntimeSnapshot {
  const raw = snapshotData?.fire_runtime;
  if (!raw || typeof raw !== 'object') {
    return { vehicle_runtime: {}, hose_runtime: {}, nozzle_runtime: {} };
  }
  const typed = raw as FireRuntimeSnapshot;
  return {
    ...typed,
    vehicle_runtime: typed.vehicle_runtime ?? {},
    hose_runtime: typed.hose_runtime ?? {},
    nozzle_runtime: typed.nozzle_runtime ?? {},
  };
}

export function forecastLabel(
  forecast: FireRuntimeSnapshot['forecast'],
): string {
  switch (forecast) {
    case 'growing':
      return 'Рост';
    case 'stable':
      return 'Стабилизация';
    case 'suppressed':
      return 'Подавление';
    default:
      return '—';
  }
}

export function forecastColorClass(
  forecast: FireRuntimeSnapshot['forecast'],
): string {
  switch (forecast) {
    case 'growing':
      return 'bg-red-800 text-red-100';
    case 'stable':
      return 'bg-yellow-700 text-yellow-100';
    case 'suppressed':
      return 'bg-green-800 text-green-100';
    default:
      return 'bg-gray-700 text-gray-100';
  }
}
