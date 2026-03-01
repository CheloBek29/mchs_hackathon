from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .enums import VehicleType
from .models import VehicleDictionary

# Источник: типовые тактико-технические характеристики машин для учебного сценария.
# Храним конкретные единицы, чтобы интерфейсы ролей показывали не "нулевые"
# справочные записи, а рабочий парк техники.
VEHICLES_DICTIONARY_SEED: tuple[dict, ...] = (
    {
        "type": VehicleType.AC,
        "name": "АЦ-40 (130) 63Б",
        "water_capacity": 2400,
        "foam_capacity": 150,
        "crew_size": 6,
        "hose_length": 320,
    },
    {
        "type": VehicleType.AC,
        "name": "АЦ-3,2-40/4 (43253)",
        "water_capacity": 3200,
        "foam_capacity": 180,
        "crew_size": 6,
        "hose_length": 360,
    },
    {
        "type": VehicleType.AC,
        "name": "АЦ-6,0-40/4 (5557)",
        "water_capacity": 6000,
        "foam_capacity": 360,
        "crew_size": 6,
        "hose_length": 450,
    },
    {
        "type": VehicleType.AC,
        "name": "ПНС-110",
        "water_capacity": 0,
        "foam_capacity": 0,
        "crew_size": 3,
        "hose_length": 1200,
    },
    {
        "type": VehicleType.AL,
        "name": "АЛ-30 (131)",
        "water_capacity": 0,
        "foam_capacity": 0,
        "crew_size": 3,
        "hose_length": 60,
    },
    {
        "type": VehicleType.AL,
        "name": "АЛ-50",
        "water_capacity": 0,
        "foam_capacity": 0,
        "crew_size": 3,
        "hose_length": 60,
    },
    {
        "type": VehicleType.ASA,
        "name": "АНР-3,0",
        "water_capacity": 3000,
        "foam_capacity": 180,
        "crew_size": 5,
        "hose_length": 260,
    },
    {
        "type": VehicleType.ASA,
        "name": "АР-2",
        "water_capacity": 500,
        "foam_capacity": 0,
        "crew_size": 5,
        "hose_length": 200,
    },
)


def seed_vehicles_dictionary(db: Session) -> int:
    existing_rows = db.execute(select(VehicleDictionary)).scalars().all()
    existing_map = {(row.type, row.name): row for row in existing_rows}
    inserted = 0
    updated = 0

    for row in VEHICLES_DICTIONARY_SEED:
        key = (row["type"], row["name"])
        existing = existing_map.get(key)
        if existing is None:
            db.add(VehicleDictionary(**row))
            inserted += 1
            continue

        changed = False
        for field in ("water_capacity", "foam_capacity", "crew_size", "hose_length"):
            next_value = row.get(field)
            if next_value is None:
                continue
            current_value = getattr(existing, field)
            if current_value is None or current_value == 0:
                setattr(existing, field, next_value)
                changed = True

        if changed:
            updated += 1

    if inserted or updated:
        db.commit()

    return inserted + updated
