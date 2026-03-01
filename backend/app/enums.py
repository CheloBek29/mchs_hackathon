from enum import Enum


class UserRole(str, Enum):
    ADMIN = "ADMIN"
    COMBAT_AREA_1 = "COMBAT_AREA_1"
    COMBAT_AREA_2 = "COMBAT_AREA_2"
    DISPATCHER = "DISPATCHER"
    HQ = "HQ"
    RTP = "RTP"
    TRAINING_LEAD = "TRAINING_LEAD"


ROLE_LABELS_RU: dict[UserRole, str] = {
    UserRole.ADMIN: "Админ",
    UserRole.COMBAT_AREA_1: "Боевой участок 1",
    UserRole.COMBAT_AREA_2: "Боевой участок 2",
    UserRole.DISPATCHER: "Диспетчер",
    UserRole.HQ: "Штаб",
    UserRole.RTP: "РТП",
    UserRole.TRAINING_LEAD: "Руководитель занятий",
}

# Backward-compatible aliases for legacy Russian role names in existing data.
ROLE_ALIASES_TO_CANONICAL: dict[str, UserRole] = {
    UserRole.ADMIN.value: UserRole.ADMIN,
    UserRole.COMBAT_AREA_1.value: UserRole.COMBAT_AREA_1,
    UserRole.COMBAT_AREA_2.value: UserRole.COMBAT_AREA_2,
    UserRole.DISPATCHER.value: UserRole.DISPATCHER,
    UserRole.HQ.value: UserRole.HQ,
    UserRole.RTP.value: UserRole.RTP,
    UserRole.TRAINING_LEAD.value: UserRole.TRAINING_LEAD,
    "АДМИН": UserRole.ADMIN,
    "БОЕВОЙ УЧАСТОК 1": UserRole.COMBAT_AREA_1,
    "БУ1": UserRole.COMBAT_AREA_1,
    "БУ 1": UserRole.COMBAT_AREA_1,
    "БОЕВОЙ УЧАСТОК 2": UserRole.COMBAT_AREA_2,
    "БУ2": UserRole.COMBAT_AREA_2,
    "БУ 2": UserRole.COMBAT_AREA_2,
    "ДИСПЕТЧЕР": UserRole.DISPATCHER,
    "ШТАБ": UserRole.HQ,
    "РТП": UserRole.RTP,
    "РУКОВОДИТЕЛЬ ЗАНЯТИЙ": UserRole.TRAINING_LEAD,
    # Legacy aliases:
    "NSH": UserRole.HQ,
    "НАЧАЛЬНИК ШТАБА": UserRole.HQ,
    "STAFF": UserRole.COMBAT_AREA_1,
    "ПОЖАРНЫЙ": UserRole.COMBAT_AREA_1,
    "СОТРУДНИК": UserRole.COMBAT_AREA_1,
    "FIREFIGHTER": UserRole.COMBAT_AREA_1,
}

PUBLIC_REGISTRATION_ROLES: frozenset[UserRole] = frozenset(
    {
        UserRole.COMBAT_AREA_1,
        UserRole.COMBAT_AREA_2,
        UserRole.DISPATCHER,
        UserRole.HQ,
        UserRole.RTP,
        UserRole.TRAINING_LEAD,
    }
)


class SessionStatus(str, Enum):
    CREATED = "CREATED"
    IN_PROGRESS = "IN_PROGRESS"
    PAUSED = "PAUSED"
    COMPLETED = "COMPLETED"


class VehicleType(str, Enum):
    AC = "AC"
    AL = "AL"
    ASA = "ASA"


class TimeOfDay(str, Enum):
    DAY = "DAY"
    EVENING = "EVENING"
    NIGHT = "NIGHT"


class WaterSupplyStatus(str, Enum):
    OK = "OK"
    DEGRADED = "DEGRADED"
    FAILED = "FAILED"


class FireZoneKind(str, Enum):
    FIRE_SEAT = "FIRE_SEAT"
    FIRE_ZONE = "FIRE_ZONE"
    SMOKE_ZONE = "SMOKE_ZONE"
    TEMP_IMPACT_ZONE = "TEMP_IMPACT_ZONE"


class GeometryType(str, Enum):
    POINT = "POINT"
    LINESTRING = "LINESTRING"
    POLYGON = "POLYGON"


class ResourceKind(str, Enum):
    VEHICLE = "VEHICLE"
    HOSE_LINE = "HOSE_LINE"
    NOZZLE = "NOZZLE"
    WATER_SOURCE = "WATER_SOURCE"
    CREW = "CREW"
    MARKER = "MARKER"


class DeploymentStatus(str, Enum):
    PLANNED = "PLANNED"
    EN_ROUTE = "EN_ROUTE"
    DEPLOYED = "DEPLOYED"
    ACTIVE = "ACTIVE"
    COMPLETED = "COMPLETED"
