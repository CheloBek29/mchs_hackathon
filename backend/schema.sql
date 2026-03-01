CREATE EXTENSION IF NOT EXISTS pgcrypto;



DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'session_status') THEN
        CREATE TYPE session_status AS ENUM ('CREATED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vehicle_type') THEN
        CREATE TYPE vehicle_type AS ENUM ('AC', 'AL', 'ASA');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'time_of_day') THEN
        CREATE TYPE time_of_day AS ENUM ('DAY', 'EVENING', 'NIGHT');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'water_supply_status') THEN
        CREATE TYPE water_supply_status AS ENUM ('OK', 'DEGRADED', 'FAILED');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fire_zone_kind') THEN
        CREATE TYPE fire_zone_kind AS ENUM ('FIRE_SEAT', 'FIRE_ZONE', 'SMOKE_ZONE', 'TEMP_IMPACT_ZONE');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'geometry_type') THEN
        CREATE TYPE geometry_type AS ENUM ('POINT', 'LINESTRING', 'POLYGON');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'resource_kind') THEN
        CREATE TYPE resource_kind AS ENUM ('VEHICLE', 'HOSE_LINE', 'NOZZLE', 'WATER_SOURCE', 'CREW', 'MARKER');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'deployment_status') THEN
        CREATE TYPE deployment_status AS ENUM ('PLANNED', 'EN_ROUTE', 'DEPLOYED', 'ACTIVE', 'COMPLETED');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS simulation_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status session_status NOT NULL DEFAULT 'CREATED',
    scenario_name VARCHAR(255) NOT NULL,
    map_image_url VARCHAR(500),
    map_scale DOUBLE PRECISION CHECK (map_scale IS NULL OR map_scale > 0),
    weather JSONB NOT NULL DEFAULT '{"wind_speed": 5, "wind_dir": 90, "temp": 20}'::jsonb,
    time_multiplier DOUBLE PRECISION NOT NULL DEFAULT 1.0 CHECK (time_multiplier > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    avatar_url VARCHAR(512),
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_mfa_enabled BOOLEAN NOT NULL DEFAULT false,
    mfa_secret VARCHAR(255),
    failed_login_attempts INT NOT NULL DEFAULT 0,
    lockout_until TIMESTAMPTZ,
    session_id UUID REFERENCES simulation_sessions(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_session_id ON users(session_id);

CREATE TABLE IF NOT EXISTS system_admin_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    admin_user_id UUID UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_admin_lock (id, admin_user_id)
SELECT 1, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM system_admin_lock WHERE id = 1
);

CREATE TABLE IF NOT EXISTS system_settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_settings (key, value)
SELECT
    'global',
    '{
      "tick_rate_hz": 30,
      "voice_server_url": "wss://voice.simulator.local",
      "enforce_admin_2fa": true,
      "ip_whitelist_enabled": false,
      "entity_limit": 50000
    }'::jsonb
WHERE NOT EXISTS (
    SELECT 1 FROM system_settings WHERE key = 'global'
);

CREATE TABLE IF NOT EXISTS roles (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT
);

INSERT INTO roles (name, description)
SELECT r.name, r.description
FROM (
    VALUES
        ('ADMIN', 'Root administrator'),
        ('COMBAT_AREA_1', 'Combat area 1'),
        ('COMBAT_AREA_2', 'Combat area 2'),
        ('DISPATCHER', 'Dispatcher role'),
        ('HQ', 'Headquarters role'),
        ('RTP', 'Incident commander'),
        ('TRAINING_LEAD', 'Training lead role')
) AS r(name, description)
WHERE NOT EXISTS (
    SELECT 1
    FROM roles existing
    WHERE existing.name = r.name
);

CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    device_id VARCHAR(255),
    ip_address INET,
    user_agent TEXT,
    is_revoked BOOLEAN NOT NULL DEFAULT false,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(255) NOT NULL,
    target_resource VARCHAR(255),
    ip_address INET,
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS vehicles_dictionary (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type vehicle_type NOT NULL,
    name VARCHAR(255) NOT NULL,
    water_capacity INTEGER CHECK (water_capacity IS NULL OR water_capacity >= 0),
    foam_capacity INTEGER CHECK (foam_capacity IS NULL OR foam_capacity >= 0),
    crew_size INTEGER CHECK (crew_size IS NULL OR crew_size >= 0),
    hose_length INTEGER CHECK (hose_length IS NULL OR hose_length >= 0)
);

CREATE INDEX IF NOT EXISTS idx_vehicles_dictionary_type ON vehicles_dictionary(type);

CREATE TABLE IF NOT EXISTS session_state_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES simulation_sessions(id) ON DELETE CASCADE,
    sim_time_seconds INTEGER NOT NULL DEFAULT 0 CHECK (sim_time_seconds >= 0),
    time_of_day time_of_day NOT NULL DEFAULT 'DAY',
    water_supply_status water_supply_status NOT NULL DEFAULT 'OK',
    is_current BOOLEAN NOT NULL DEFAULT FALSE,
    snapshot_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    notes TEXT,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_state_snapshots_session_id ON session_state_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_session_state_snapshots_captured_at ON session_state_snapshots(captured_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_session_state_snapshots_current_per_session
    ON session_state_snapshots(session_id)
    WHERE is_current = TRUE;

CREATE TABLE IF NOT EXISTS weather_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state_id UUID NOT NULL UNIQUE REFERENCES session_state_snapshots(id) ON DELETE CASCADE,
    wind_speed DOUBLE PRECISION NOT NULL CHECK (wind_speed >= 0),
    wind_dir INTEGER NOT NULL CHECK (wind_dir >= 0 AND wind_dir <= 359),
    temperature DOUBLE PRECISION NOT NULL,
    humidity INTEGER CHECK (humidity IS NULL OR (humidity >= 0 AND humidity <= 100)),
    precipitation VARCHAR(32),
    visibility_m INTEGER CHECK (visibility_m IS NULL OR visibility_m >= 0),
    weather_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_weather_snapshots_state_id ON weather_snapshots(state_id);

CREATE TABLE IF NOT EXISTS fire_objects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state_id UUID NOT NULL REFERENCES session_state_snapshots(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    kind fire_zone_kind NOT NULL,
    geometry_type geometry_type NOT NULL DEFAULT 'POLYGON',
    geometry JSONB NOT NULL,
    area_m2 DOUBLE PRECISION CHECK (area_m2 IS NULL OR area_m2 >= 0),
    perimeter_m DOUBLE PRECISION CHECK (perimeter_m IS NULL OR perimeter_m >= 0),
    spread_speed_m_min DOUBLE PRECISION CHECK (spread_speed_m_min IS NULL OR spread_speed_m_min >= 0),
    spread_azimuth INTEGER CHECK (spread_azimuth IS NULL OR (spread_azimuth >= 0 AND spread_azimuth <= 359)),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    extra JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fire_objects_state_id ON fire_objects(state_id);
CREATE INDEX IF NOT EXISTS idx_fire_objects_kind ON fire_objects(kind);

CREATE TABLE IF NOT EXISTS resource_deployments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state_id UUID NOT NULL REFERENCES session_state_snapshots(id) ON DELETE CASCADE,
    resource_kind resource_kind NOT NULL,
    status deployment_status NOT NULL DEFAULT 'PLANNED',
    vehicle_dictionary_id INTEGER REFERENCES vehicles_dictionary(id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    label VARCHAR(255) NOT NULL,
    geometry_type geometry_type NOT NULL DEFAULT 'POINT',
    geometry JSONB NOT NULL,
    rotation_deg INTEGER CHECK (rotation_deg IS NULL OR (rotation_deg >= 0 AND rotation_deg <= 359)),
    resource_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resource_deployments_state_id ON resource_deployments(state_id);
CREATE INDEX IF NOT EXISTS idx_resource_deployments_vehicle_id ON resource_deployments(vehicle_dictionary_id);
CREATE INDEX IF NOT EXISTS idx_resource_deployments_user_id ON resource_deployments(user_id);
CREATE INDEX IF NOT EXISTS idx_resource_deployments_kind ON resource_deployments(resource_kind);
CREATE INDEX IF NOT EXISTS idx_resource_deployments_status ON resource_deployments(status);

INSERT INTO vehicles_dictionary (type, name, water_capacity, foam_capacity, crew_size, hose_length)
SELECT
    v.type::vehicle_type,
    v.name,
    v.water_capacity::integer,
    v.foam_capacity::integer,
    v.crew_size::integer,
    v.hose_length::integer
FROM (
    VALUES
        ('AC', 'АЦ — пожарные автоцистерны', NULL, NULL, NULL, NULL),
        ('AC', 'АЦ 40 (130) 63Б-ЗИЛ', NULL, NULL, NULL, NULL),
        ('AC', 'АЦ на шасси ЗИЛ', NULL, NULL, NULL, NULL),
        ('AC', 'АЦ на шасси Камаз', NULL, NULL, NULL, NULL),
        ('AC', 'АЦ на шасси Урал', NULL, NULL, NULL, NULL),
        ('AC', 'АЦ на шасси автомобилей иностранного производства', NULL, NULL, NULL, NULL),
        ('AC', 'Пожарная автоцистерна', NULL, NULL, NULL, NULL),
        ('AL', 'АЛ — пожарные автолестницы', NULL, NULL, NULL, NULL),
        ('AL', 'Пожарная автолестница', NULL, NULL, NULL, NULL),
        ('ASA', 'АСА — пожарные аварийно-спасательные автомобили', NULL, NULL, NULL, NULL),
        ('ASA', 'Пожарный аварийно-спасательный автомобиль', NULL, NULL, NULL, NULL)
) AS v(type, name, water_capacity, foam_capacity, crew_size, hose_length)
WHERE NOT EXISTS (
    SELECT 1
    FROM vehicles_dictionary vd
    WHERE vd.type = v.type::vehicle_type AND vd.name = v.name
);
