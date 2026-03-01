from __future__ import annotations

from datetime import datetime
import re
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from .enums import (
    DeploymentStatus,
    FireZoneKind,
    GeometryType,
    PUBLIC_REGISTRATION_ROLES,
    ResourceKind,
    SessionStatus,
    TimeOfDay,
    UserRole,
    VehicleType,
    WaterSupplyStatus,
)


class SimulationSessionBase(BaseModel):
    status: SessionStatus = SessionStatus.CREATED
    scenario_name: str = Field(min_length=1, max_length=255)
    map_image_url: str | None = None
    map_scale: float | None = Field(default=None, gt=0)
    weather: dict[str, Any] = Field(
        default_factory=lambda: {"wind_speed": 5, "wind_dir": 90, "temp": 20}
    )
    time_multiplier: float = Field(default=1.0, gt=0)


class SimulationSessionCreate(SimulationSessionBase):
    pass


class SimulationSessionUpdate(BaseModel):
    status: SessionStatus | None = None
    scenario_name: str | None = Field(default=None, min_length=1, max_length=255)
    map_image_url: str | None = None
    map_scale: float | None = Field(default=None, gt=0)
    weather: dict[str, Any] | None = None
    time_multiplier: float | None = Field(default=None, gt=0)


class SimulationSessionRead(SimulationSessionBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime


class RoleBase(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    description: str | None = None


class RoleCreate(RoleBase):
    pass


class RoleRead(RoleBase):
    model_config = ConfigDict(from_attributes=True)
    id: int


class UserRolesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    roles: list[UserRole] = Field(min_length=1, max_length=5)


PASSWORD_POLICY_PATTERN = re.compile(
    r"^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$"
)


class UserBase(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    username: str = Field(min_length=1, max_length=255)
    email: EmailStr
    avatar_url: str | None = None


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    username: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=8, max_length=128)
    requested_role: UserRole = UserRole.COMBAT_AREA_1

    @field_validator("password")
    @classmethod
    def validate_password_policy(cls, value: str) -> str:
        if not PASSWORD_POLICY_PATTERN.match(value):
            raise ValueError(
                "Password must include lower/upper letters, number and special character"
            )
        return value

    @field_validator("requested_role")
    @classmethod
    def validate_requested_role(cls, value: UserRole) -> UserRole:
        if value not in PUBLIC_REGISTRATION_ROLES:
            raise ValueError("Requested role is not allowed for public registration")
        return value


class UserLogin(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    login: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("login", mode="before")
    @classmethod
    def normalize_login(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip().lower()
        return value


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    refresh_token: str | None = None
    session_id: UUID | None = None


class RefreshTokenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    refresh_token: str = Field(min_length=20, max_length=4096)


class SessionRevokeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: UUID


class CurrentUserSessionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: UUID | None = None


class AuthSessionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    device_id: str | None = None
    ip_address: str | None = None
    user_agent: str | None = None
    is_revoked: bool
    expires_at: datetime
    created_at: datetime


class SystemSettingsRead(BaseModel):
    tick_rate_hz: int = Field(default=30, ge=1, le=120)
    voice_server_url: str = Field(
        default="wss://voice.simulator.local", min_length=1, max_length=1024
    )
    enforce_admin_2fa: bool = True
    ip_whitelist_enabled: bool = False
    entity_limit: int = Field(default=50000, ge=1000, le=2_000_000)

    @field_validator("tick_rate_hz")
    @classmethod
    def validate_tick_rate(cls, value: int) -> int:
        if value not in {15, 30, 60}:
            raise ValueError("tick_rate_hz must be one of 15, 30, 60")
        return value


class SystemSettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tick_rate_hz: int | None = Field(default=None, ge=1, le=120)
    voice_server_url: str | None = Field(default=None, min_length=1, max_length=1024)
    enforce_admin_2fa: bool | None = None
    ip_whitelist_enabled: bool | None = None
    entity_limit: int | None = Field(default=None, ge=1000, le=2_000_000)

    @field_validator("tick_rate_hz")
    @classmethod
    def validate_tick_rate(cls, value: int | None) -> int | None:
        if value is None:
            return value
        if value not in {15, 30, 60}:
            raise ValueError("tick_rate_hz must be one of 15, 30, 60")
        return value


class AdminTransferRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    new_admin_user_id: UUID


class AdminLockRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    admin_user_id: UUID | None = None
    created_at: datetime
    updated_at: datetime


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    username: str | None = Field(default=None, min_length=1, max_length=255)
    email: EmailStr | None = None
    avatar_url: str | None = None
    is_active: bool | None = None
    session_id: UUID | None = None

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip().lower()
        return value


class UserRead(UserBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    is_active: bool
    session_id: UUID | None = None
    is_mfa_enabled: bool
    roles: list[RoleRead] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class VehicleDictionaryBase(BaseModel):
    type: VehicleType
    name: str = Field(min_length=1, max_length=255)
    water_capacity: int | None = Field(default=None, ge=0)
    foam_capacity: int | None = Field(default=None, ge=0)
    crew_size: int | None = Field(default=None, ge=0)
    hose_length: int | None = Field(default=None, ge=0)


class VehicleDictionaryCreate(VehicleDictionaryBase):
    pass


class VehicleDictionaryUpdate(BaseModel):
    type: VehicleType | None = None
    name: str | None = Field(default=None, min_length=1, max_length=255)
    water_capacity: int | None = Field(default=None, ge=0)
    foam_capacity: int | None = Field(default=None, ge=0)
    crew_size: int | None = Field(default=None, ge=0)
    hose_length: int | None = Field(default=None, ge=0)


class VehicleDictionaryRead(VehicleDictionaryBase):
    model_config = ConfigDict(from_attributes=True)

    id: int


class FireRuntimeVehicleRead(BaseModel):
    water_capacity_l: float = Field(ge=0)
    water_remaining_l: float = Field(ge=0)
    is_empty: bool
    minutes_until_empty: float | None = Field(default=None, ge=0)
    updated_at: datetime | None = None


class FireRuntimeHoseRead(BaseModel):
    has_water: bool
    blocked_reason: str | None = None
    linked_vehicle_id: int | None = Field(default=None, ge=1)
    linked_splitter_id: str | None = None
    parent_chain_id: str | None = None
    chain_id: str | None = None
    strict_chain: bool | None = None
    hose_type: str | None = None
    length_m: float | None = Field(default=None, ge=0)
    updated_at: datetime | None = None


class FireRuntimeNozzleRead(BaseModel):
    has_water: bool
    blocked_reason: str | None = None
    effective_flow_l_s: float | None = Field(default=None, ge=0)
    suppression_factor: float | None = Field(default=None, ge=0)
    linked_vehicle_id: int | None = Field(default=None, ge=1)
    linked_hose_line_id: str | None = None
    linked_hose_line_chain_id: str | None = None
    strict_chain: bool | None = None
    pressure: float | None = Field(default=None, ge=0)
    spray_angle: float | None = Field(default=None, ge=0, le=180)
    available_pressure_bar: float | None = Field(default=None, ge=0)
    line_loss_bar: float | None = Field(default=None, ge=0)
    pressure_factor: float | None = Field(default=None, ge=0)
    line_length_m: float | None = Field(default=None, ge=0)
    hose_type: str | None = None
    updated_at: datetime | None = None


class FireRuntimeDirectionRead(BaseModel):
    direction_deg: float
    area_m2: float = Field(ge=0)


class FireRuntimeEnvironmentRead(BaseModel):
    wind_speed: float = Field(ge=0)
    wind_dir: float = Field(ge=0, le=359)
    temperature: float
    humidity: float = Field(ge=0, le=100)
    precipitation: str | None = None
    weather_growth_factor: float | None = Field(default=None, ge=0)
    suppression_weather_boost: float | None = Field(default=None, ge=0)


class FireRuntimeHealthRead(BaseModel):
    ticks_total: int = Field(ge=0)
    dropped_ticks_total: int = Field(ge=0)
    tick_lag_sec: float = Field(ge=0)
    last_tick_at: datetime | None = None
    loop_interval_sec: float = Field(gt=0)
    max_step_real_sec: int = Field(ge=1)
    dropped_ticks_last: int | None = Field(default=None, ge=0)
    last_delta_real_sec: int | None = Field(default=None, ge=0)
    last_delta_game_sec: int | None = Field(default=None, ge=0)


class FireRuntimeSnapshotRead(BaseModel):
    schema_version: str | None = None
    vehicle_runtime: dict[str, FireRuntimeVehicleRead] = Field(default_factory=dict)
    hose_runtime: dict[str, FireRuntimeHoseRead] = Field(default_factory=dict)
    nozzle_runtime: dict[str, FireRuntimeNozzleRead] = Field(default_factory=dict)
    fire_directions: dict[str, FireRuntimeDirectionRead] = Field(default_factory=dict)
    q_required_l_s: float | None = Field(default=None, ge=0)
    q_effective_l_s: float | None = Field(default=None, ge=0)
    suppression_ratio: float | None = Field(default=None, ge=0)
    forecast: Literal["growing", "stable", "suppressed"] | None = None
    effective_flow_l_s: float | None = Field(default=None, ge=0)
    consumed_water_l_tick: float | None = Field(default=None, ge=0)
    active_fire_objects: int | None = Field(default=None, ge=0)
    active_smoke_objects: int | None = Field(default=None, ge=0)
    active_nozzles: int | None = Field(default=None, ge=0)
    wet_nozzles: int | None = Field(default=None, ge=0)
    wet_hose_lines: int | None = Field(default=None, ge=0)
    updated_at: datetime | None = None
    environment: FireRuntimeEnvironmentRead | None = None
    runtime_health: FireRuntimeHealthRead | None = None


class SessionStateSnapshotBase(BaseModel):
    session_id: UUID
    sim_time_seconds: int = Field(default=0, ge=0)
    time_of_day: TimeOfDay = TimeOfDay.DAY
    water_supply_status: WaterSupplyStatus = WaterSupplyStatus.OK
    is_current: bool = False
    snapshot_data: dict[str, Any] = Field(default_factory=dict)
    notes: str | None = None


class SessionStateSnapshotCreate(SessionStateSnapshotBase):
    pass


class SessionStateSnapshotUpdate(BaseModel):
    session_id: UUID | None = None
    sim_time_seconds: int | None = Field(default=None, ge=0)
    time_of_day: TimeOfDay | None = None
    water_supply_status: WaterSupplyStatus | None = None
    is_current: bool | None = None
    snapshot_data: dict[str, Any] | None = None
    notes: str | None = None


class SessionStateSnapshotRead(SessionStateSnapshotBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    captured_at: datetime


class WeatherSnapshotBase(BaseModel):
    state_id: UUID
    wind_speed: float = Field(ge=0)
    wind_dir: int = Field(ge=0, le=359)
    temperature: float
    humidity: int | None = Field(default=None, ge=0, le=100)
    precipitation: str | None = Field(default=None, max_length=32)
    visibility_m: int | None = Field(default=None, ge=0)
    weather_data: dict[str, Any] = Field(default_factory=dict)


class WeatherSnapshotCreate(WeatherSnapshotBase):
    pass


class WeatherSnapshotUpdate(BaseModel):
    state_id: UUID | None = None
    wind_speed: float | None = Field(default=None, ge=0)
    wind_dir: int | None = Field(default=None, ge=0, le=359)
    temperature: float | None = None
    humidity: int | None = Field(default=None, ge=0, le=100)
    precipitation: str | None = Field(default=None, max_length=32)
    visibility_m: int | None = Field(default=None, ge=0)
    weather_data: dict[str, Any] | None = None


class WeatherSnapshotRead(WeatherSnapshotBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime


class FireObjectBase(BaseModel):
    state_id: UUID
    name: str = Field(min_length=1, max_length=255)
    kind: FireZoneKind
    geometry_type: GeometryType = GeometryType.POLYGON
    geometry: dict[str, Any]
    area_m2: float | None = Field(default=None, ge=0)
    perimeter_m: float | None = Field(default=None, ge=0)
    spread_speed_m_min: float | None = Field(default=None, ge=0)
    spread_azimuth: int | None = Field(default=None, ge=0, le=359)
    is_active: bool = True
    extra: dict[str, Any] = Field(default_factory=dict)


class FireObjectCreate(FireObjectBase):
    pass


class FireObjectUpdate(BaseModel):
    state_id: UUID | None = None
    name: str | None = Field(default=None, min_length=1, max_length=255)
    kind: FireZoneKind | None = None
    geometry_type: GeometryType | None = None
    geometry: dict[str, Any] | None = None
    area_m2: float | None = Field(default=None, ge=0)
    perimeter_m: float | None = Field(default=None, ge=0)
    spread_speed_m_min: float | None = Field(default=None, ge=0)
    spread_azimuth: int | None = Field(default=None, ge=0, le=359)
    is_active: bool | None = None
    extra: dict[str, Any] | None = None


class FireObjectRead(FireObjectBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime


class ResourceDeploymentBase(BaseModel):
    state_id: UUID
    resource_kind: ResourceKind
    status: DeploymentStatus = DeploymentStatus.PLANNED
    vehicle_dictionary_id: int | None = Field(default=None, ge=1)
    user_id: UUID | None = None
    label: str = Field(min_length=1, max_length=255)
    geometry_type: GeometryType = GeometryType.POINT
    geometry: dict[str, Any]
    rotation_deg: int | None = Field(default=None, ge=0, le=359)
    resource_data: dict[str, Any] = Field(default_factory=dict)


class ResourceDeploymentCreate(ResourceDeploymentBase):
    pass


class ResourceDeploymentUpdate(BaseModel):
    state_id: UUID | None = None
    resource_kind: ResourceKind | None = None
    status: DeploymentStatus | None = None
    vehicle_dictionary_id: int | None = Field(default=None, ge=1)
    user_id: UUID | None = None
    label: str | None = Field(default=None, min_length=1, max_length=255)
    geometry_type: GeometryType | None = None
    geometry: dict[str, Any] | None = None
    rotation_deg: int | None = Field(default=None, ge=0, le=359)
    resource_data: dict[str, Any] | None = None


class ResourceDeploymentRead(ResourceDeploymentBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime


class RadioTransmissionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    session_id: UUID
    snapshot_id: UUID | None = None
    sender_user_id: UUID | None = None
    sender_username: str
    sender_role: str
    channel: str
    transmission_id: str
    chunk_index: int | None = None
    is_live_chunk: bool = False
    mime_type: str
    duration_ms: int | None = None
    audio_b64: str
    transcript_text: str | None = None
    transcript_source: str | None = None
    extra: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class LessonLlmEvaluationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: UUID | None = None
    model: str | None = Field(default=None, min_length=1, max_length=200)
    max_radio_transmissions: int = Field(default=80, ge=10, le=500)
    max_journal_entries: int = Field(default=120, ge=10, le=600)


class LessonLlmEvaluationRead(BaseModel):
    session_id: UUID
    generated_at: datetime
    provider: str
    model: str
    request_stats: dict[str, Any] = Field(default_factory=dict)
    result_json: dict[str, Any] | None = None
    result_text: str | None = None


class SessionStateBundleRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    session: SimulationSessionRead
    snapshot: SessionStateSnapshotRead | None = None
    weather: WeatherSnapshotRead | None = None
    fire_objects: list[FireObjectRead] = Field(default_factory=list)
    resource_deployments: list[ResourceDeploymentRead] = Field(default_factory=list)
    snapshots_history: list[SessionStateSnapshotRead] = Field(default_factory=list)
