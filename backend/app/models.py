from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, Enum, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base
from .enums import (
    DeploymentStatus,
    FireZoneKind,
    GeometryType,
    ResourceKind,
    SessionStatus,
    TimeOfDay,
    VehicleType,
    WaterSupplyStatus,
)


class SimulationSession(Base):
    __tablename__ = "simulation_sessions"
    __table_args__ = (
        CheckConstraint("map_scale IS NULL OR map_scale > 0", name="ck_simulation_sessions_map_scale_positive"),
        CheckConstraint(
            "time_multiplier > 0",
            name="ck_simulation_sessions_time_multiplier_positive",
        ),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    status: Mapped[SessionStatus] = mapped_column(
        Enum(SessionStatus, name="session_status"),
        nullable=False,
        default=SessionStatus.CREATED,
    )
    scenario_name: Mapped[str] = mapped_column(String(255), nullable=False)
    map_image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    map_scale: Mapped[float | None] = mapped_column(Float, nullable=True)
    weather: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        default=lambda: {"wind_speed": 5, "wind_dir": 90, "temp": 20},
    )
    time_multiplier: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    users: Mapped[list["User"]] = relationship(back_populates="session")
    state_snapshots: Mapped[list["SessionStateSnapshot"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )

    def __str__(self) -> str:
        return f"{self.scenario_name} ({self.id})"


class Role(Base):
    __tablename__ = "roles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(50), nullable=False, unique=True)
    description: Mapped[str | None] = mapped_column(Text)

    users: Mapped[list["User"]] = relationship(
        secondary="user_roles", back_populates="roles"
    )

class UserRoleAssoc(Base):
    __tablename__ = "user_roles"

    user_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    role_id: Mapped[int] = mapped_column(Integer, ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True)
    assigned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

class User(Base):
    __tablename__ = "users"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    username: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    avatar_url: Mapped[str | None] = mapped_column(String(512))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_mfa_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    mfa_secret: Mapped[str | None] = mapped_column(String(255))
    failed_login_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lockout_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    session_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("simulation_sessions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    session: Mapped[SimulationSession | None] = relationship(back_populates="users")
    deployments: Mapped[list["ResourceDeployment"]] = relationship(back_populates="user")
    roles: Mapped[list["Role"]] = relationship(
        secondary="user_roles", back_populates="users"
    )
    admin_lock_owned: Mapped["SystemAdminLock | None"] = relationship(
        back_populates="admin_user", uselist=False, foreign_keys="SystemAdminLock.admin_user_id"
    )
    auth_sessions: Mapped[list["Session"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    audit_logs: Mapped[list["AuditLog"]] = relationship(back_populates="user", cascade="all, delete-orphan")

    def __str__(self) -> str:
        return f"{self.username} ({self.email})"


class SystemAdminLock(Base):
    __tablename__ = "system_admin_lock"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_system_admin_lock_singleton_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    admin_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        unique=True,
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    admin_user: Mapped["User | None"] = relationship(
        back_populates="admin_lock_owned", foreign_keys=[admin_user_id]
    )


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    device_id: Mapped[str | None] = mapped_column(String(255))
    ip_address: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(Text)
    is_revoked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    user: Mapped["User"] = relationship(back_populates="auth_sessions")

class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), index=True)
    action: Mapped[str] = mapped_column(String(255), nullable=False)
    target_resource: Mapped[str | None] = mapped_column(String(255))
    ip_address: Mapped[str | None] = mapped_column(INET)
    details: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), index=True)

    user: Mapped["User"] = relationship(back_populates="audit_logs")


class SystemSetting(Base):
    __tablename__ = "system_settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class VehicleDictionary(Base):
    __tablename__ = "vehicles_dictionary"
    __table_args__ = (
        CheckConstraint(
            "water_capacity IS NULL OR water_capacity >= 0",
            name="ck_vehicles_dictionary_water_capacity_non_negative",
        ),
        CheckConstraint(
            "foam_capacity IS NULL OR foam_capacity >= 0",
            name="ck_vehicles_dictionary_foam_capacity_non_negative",
        ),
        CheckConstraint(
            "crew_size IS NULL OR crew_size >= 0",
            name="ck_vehicles_dictionary_crew_size_non_negative",
        ),
        CheckConstraint(
            "hose_length IS NULL OR hose_length >= 0",
            name="ck_vehicles_dictionary_hose_length_non_negative",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    type: Mapped[VehicleType] = mapped_column(
        Enum(VehicleType, name="vehicle_type"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    water_capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    foam_capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    crew_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    hose_length: Mapped[int | None] = mapped_column(Integer, nullable=True)

    deployments: Mapped[list["ResourceDeployment"]] = relationship(back_populates="vehicle")

    def __str__(self) -> str:
        return f"{self.name} ({self.type.value})"


class SessionStateSnapshot(Base):
    __tablename__ = "session_state_snapshots"
    __table_args__ = (
        CheckConstraint(
            "sim_time_seconds >= 0",
            name="ck_session_state_snapshots_sim_time_non_negative",
        ),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    session_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("simulation_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    sim_time_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    time_of_day: Mapped[TimeOfDay] = mapped_column(
        Enum(TimeOfDay, name="time_of_day"),
        nullable=False,
        default=TimeOfDay.DAY,
    )
    water_supply_status: Mapped[WaterSupplyStatus] = mapped_column(
        Enum(WaterSupplyStatus, name="water_supply_status"),
        nullable=False,
        default=WaterSupplyStatus.OK,
    )
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    snapshot_data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    captured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )

    session: Mapped[SimulationSession] = relationship(back_populates="state_snapshots")
    weather: Mapped["WeatherSnapshot | None"] = relationship(
        back_populates="state_snapshot", uselist=False, cascade="all, delete-orphan"
    )
    fire_objects: Mapped[list["FireObject"]] = relationship(
        back_populates="state_snapshot", cascade="all, delete-orphan"
    )
    deployments: Mapped[list["ResourceDeployment"]] = relationship(
        back_populates="state_snapshot", cascade="all, delete-orphan"
    )

    def __str__(self) -> str:
        return f"Снимок t={self.sim_time_seconds}s ({self.id})"


class WeatherSnapshot(Base):
    __tablename__ = "weather_snapshots"
    __table_args__ = (
        CheckConstraint("wind_speed >= 0", name="ck_weather_snapshots_wind_speed_non_negative"),
        CheckConstraint("wind_dir >= 0 AND wind_dir <= 359", name="ck_weather_snapshots_wind_dir_range"),
        CheckConstraint("humidity IS NULL OR (humidity >= 0 AND humidity <= 100)", name="ck_weather_snapshots_humidity_range"),
        CheckConstraint(
            "visibility_m IS NULL OR visibility_m >= 0",
            name="ck_weather_snapshots_visibility_non_negative",
        ),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    state_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("session_state_snapshots.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )
    wind_speed: Mapped[float] = mapped_column(Float, nullable=False)
    wind_dir: Mapped[int] = mapped_column(Integer, nullable=False)
    temperature: Mapped[float] = mapped_column(Float, nullable=False)
    humidity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    precipitation: Mapped[str | None] = mapped_column(String(32), nullable=True)
    visibility_m: Mapped[int | None] = mapped_column(Integer, nullable=True)
    weather_data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    state_snapshot: Mapped[SessionStateSnapshot] = relationship(back_populates="weather")

    def __str__(self) -> str:
        return f"Погода: {self.temperature}C, ветер {self.wind_speed} м/с ({self.id})"


class FireObject(Base):
    __tablename__ = "fire_objects"
    __table_args__ = (
        CheckConstraint("area_m2 IS NULL OR area_m2 >= 0", name="ck_fire_objects_area_non_negative"),
        CheckConstraint("perimeter_m IS NULL OR perimeter_m >= 0", name="ck_fire_objects_perimeter_non_negative"),
        CheckConstraint(
            "spread_speed_m_min IS NULL OR spread_speed_m_min >= 0",
            name="ck_fire_objects_spread_speed_non_negative",
        ),
        CheckConstraint(
            "spread_azimuth IS NULL OR (spread_azimuth >= 0 AND spread_azimuth <= 359)",
            name="ck_fire_objects_spread_azimuth_range",
        ),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    state_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("session_state_snapshots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[FireZoneKind] = mapped_column(
        Enum(FireZoneKind, name="fire_zone_kind"),
        nullable=False,
    )
    geometry_type: Mapped[GeometryType] = mapped_column(
        Enum(GeometryType, name="geometry_type"),
        nullable=False,
        default=GeometryType.POLYGON,
    )
    geometry: Mapped[dict] = mapped_column(JSONB, nullable=False)
    area_m2: Mapped[float | None] = mapped_column(Float, nullable=True)
    perimeter_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    spread_speed_m_min: Mapped[float | None] = mapped_column(Float, nullable=True)
    spread_azimuth: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    extra: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    state_snapshot: Mapped[SessionStateSnapshot] = relationship(back_populates="fire_objects")

    def __str__(self) -> str:
        return f"{self.name} [{self.kind.value}]"


class ResourceDeployment(Base):
    __tablename__ = "resource_deployments"
    __table_args__ = (
        CheckConstraint(
            "rotation_deg IS NULL OR (rotation_deg >= 0 AND rotation_deg <= 359)",
            name="ck_resource_deployments_rotation_range",
        ),
    )

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid4)
    state_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("session_state_snapshots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    resource_kind: Mapped[ResourceKind] = mapped_column(
        Enum(ResourceKind, name="resource_kind"),
        nullable=False,
    )
    status: Mapped[DeploymentStatus] = mapped_column(
        Enum(DeploymentStatus, name="deployment_status"),
        nullable=False,
        default=DeploymentStatus.PLANNED,
    )
    vehicle_dictionary_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("vehicles_dictionary.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    geometry_type: Mapped[GeometryType] = mapped_column(
        Enum(GeometryType, name="geometry_type"),
        nullable=False,
        default=GeometryType.POINT,
    )
    geometry: Mapped[dict] = mapped_column(JSONB, nullable=False)
    rotation_deg: Mapped[int | None] = mapped_column(Integer, nullable=True)
    resource_data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    state_snapshot: Mapped[SessionStateSnapshot] = relationship(back_populates="deployments")
    vehicle: Mapped[VehicleDictionary | None] = relationship(back_populates="deployments")
    user: Mapped[User | None] = relationship(back_populates="deployments")

    def __str__(self) -> str:
        return f"{self.label} [{self.resource_kind.value}]"
