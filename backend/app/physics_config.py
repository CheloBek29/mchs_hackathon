"""
Физические константы для симуляции пожара.
Источники: ГОСТ Р 12.3.047, справочник пожарной тактики.
Выделены из ws.py для облегчения настройки и верификации.
"""

# ── Скорости роста очага (м²/с на единицу spread_speed) ─────────────────────
FIRE_GROWTH_RATE: dict[str, float] = {
    "FIRE_SEAT": 0.17,  # Очаг — быстрее прогрессирует
    "FIRE_ZONE": 0.12,  # Зона — медленнее прогрессирует
}
FIRE_GROWTH_RATE_DEFAULT = 0.12

# ── Коэффициенты подавления огня водой ──────────────────────────────────────
SUPPRESSION_FLOW_COEFF = 0.34       # л/с → м²/с подавления (эмпирический)
SMOKE_GROWTH_COEFF = 0.007          # м²(дыма) / (м²(огня) · с)
SMOKE_DRIFT_COEFF = 0.18            # вклад spread_speed в рост дыма
SMOKE_WIND_COEFF = 0.16             # вклад скорости ветра в рост дыма
SMOKE_SUPPRESSION_COEFF = 0.12      # доля подавления, уходящая на дым

# ── Температурный фактор роста ───────────────────────────────────────────────
# f_temp = clamp(1.0 + (T - T_BASE) * TEMP_FACTOR, TEMP_MIN, TEMP_MAX)
TEMP_BASE_C = 20.0
TEMP_FACTOR_PER_C = 0.014
TEMP_FACTOR_MIN = 0.68
TEMP_FACTOR_MAX = 1.45

# ── Влажностный фактор роста ─────────────────────────────────────────────────
# f_hum = clamp(1.0 - (H - H_BASE) * HUM_FACTOR, HUM_MIN, HUM_MAX)
HUMIDITY_BASE_PCT = 40.0
HUMIDITY_FACTOR_PER_PCT = 0.0045
HUMIDITY_FACTOR_MIN = 0.72
HUMIDITY_FACTOR_MAX = 1.22

# ── Ветровой фактор роста ────────────────────────────────────────────────────
# f_wind = 1.0 + min(WIND_CAP, speed / WIND_NORMALIZATION)
WIND_NORMALIZATION_MS = 18.0
WIND_FACTOR_CAP = 0.9

# ── Модификаторы при осадках ─────────────────────────────────────────────────
PRECIPITATION_HEAVY_GROWTH_FACTOR = 0.72   # дождь, снег, град, гроза
PRECIPITATION_LIGHT_GROWTH_FACTOR = 0.9    # туман, морось
PRECIPITATION_HEAVY_SUPPRESSION_BOOST = 1.18  # ускорение тушения при осадках

# ── Ранг и сила огня: мультипликаторы ───────────────────────────────────────
# f_rank = RANK_BASE + rank * RANK_PER_RANK
RANK_GROWTH_BASE = 0.82
RANK_GROWTH_PER_RANK = 0.19
# f_power = POWER_BASE + power * POWER_PER_UNIT
POWER_GROWTH_BASE = 0.75
POWER_GROWTH_PER_UNIT = 0.55

# ── Направление ветра: выравнивание азимута ──────────────────────────────────
# f_align = ALIGN_MIN + ALIGN_RANGE * (1 - |delta_az| / 180)
WIND_ALIGN_MIN = 0.82
WIND_ALIGN_RANGE = 0.36

# ── Ограничения growth_factor ────────────────────────────────────────────────
GROWTH_FACTOR_MIN = 0.45
GROWTH_FACTOR_MAX = 4.2

# ── Вес очага по рангу/силе для распределения подавления ────────────────────
FIRE_WEIGHT_RANK_BASE = 0.85
FIRE_WEIGHT_RANK_COEFF = 0.22
FIRE_WEIGHT_POWER_BASE = 0.75
FIRE_WEIGHT_POWER_COEFF = 0.35
PROXIMITY_DISTANCE_DENOM = 12.0      # знаменатель для proximity_boost
PROXIMITY_SCALE = 10.0               # масштаб близости к нозлу

# ── Сопротивление огня тушению ───────────────────────────────────────────────
SUPPRESSION_RESIST_RANK_BASE = 1.0
SUPPRESSION_RESIST_RANK_PER = 0.16
SUPPRESSION_RESIST_POWER_BASE = 0.8
SUPPRESSION_RESIST_POWER_COEFF = 0.25
SUPPRESSION_RESIST_MIN = 0.35

# ── Нормативный удельный расход воды (л/с на м²) ────────────────────────────
# Источник: нормативы на тушение по категории пожара
Q_NORM_L_S_M2: dict[str, float] = {
    "FIRE_SEAT": 0.08,   # Очаг: 0.08 л/с·м² (открытое горение)
    "FIRE_ZONE": 0.05,   # Зона: 0.05 л/с·м² (тление/распространение)
    "default":   0.06,   # По умолчанию
}
FORECAST_GROWING_THRESHOLD = 0.85   # suppression_ratio < → рост
FORECAST_STABLE_THRESHOLD = 1.05    # suppression_ratio < → стабилизация
# suppression_ratio >= STABLE → подавление

# ── Типы стволов: (min_l_s, max_l_s, default_l_s, efficiency_coeff) ─────────
# Справочник расходов по типам ручных и лафетных стволов
NOZZLE_TYPES: dict[str, tuple[float, float, float, float]] = {
    "RS50":    (1.5,  4.0,  2.8, 1.00),   # РС-50 ручной
    "RS70":    (3.0,  7.5,  5.5, 1.10),   # РС-70 ручной (лучшее покрытие)
    "DELTA":   (5.0, 10.0,  7.0, 1.15),   # DELTA лафетный
    "GPS600":  (2.5,  6.0,  4.0, 1.05),   # ГПС-600 генератор пены
    "DEFAULT": (1.0, 12.0,  3.5, 1.00),   # Без типа (обратная совместимость)
}
NOZZLE_FLOW_MIN = 1.0   # абсолютный минимум л/с
NOZZLE_FLOW_MAX = 12.0  # абсолютный максимум л/с

# ── Значения по умолчанию для очагов ────────────────────────────────────────
FIRE_SEAT_DEFAULT_SPEED = 3.0   # м/мин
FIRE_ZONE_DEFAULT_SPEED = 2.0   # м/мин
FIRE_MIN_AREA = 3.0             # м², минимальная площадь для обработки
FIRE_ACTIVE_AREA_THRESHOLD = 0.8  # м², ниже этого огонь считается потушенным
BUILDING_AREA_FALLBACK_PER = 800.0   # м², запасная площадь на здание
BUILDING_AREA_FALLBACK_GLOBAL = 2000.0  # м², глобальный запас

# ── Дым ─────────────────────────────────────────────────────────────────────
SMOKE_MIN_AREA = 4.0  # м²
SMOKE_MIN_SPEED = 0.55  # м/мин
SMOKE_ACTIVE_FIRE_AREA_THRESHOLD = 0.5  # м²
SMOKE_ACTIVE_AREA_THRESHOLD = 12.0      # м²
