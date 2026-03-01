from sqladmin import Admin, ModelView

from .database import engine
from .models import (
    FireObject,
    ResourceDeployment,
    SessionStateSnapshot,
    SimulationSession,
    User,
    VehicleDictionary,
    WeatherSnapshot,
)


class SimulationSessionAdmin(ModelView, model=SimulationSession):
    name = "Учебная сессия"
    name_plural = "Учебные сессии"
    icon = "fa-solid fa-play"
    column_list = [
        SimulationSession.id,
        SimulationSession.status,
        SimulationSession.scenario_name,
        SimulationSession.map_scale,
        SimulationSession.time_multiplier,
        SimulationSession.created_at,
    ]
    form_excluded_columns = [SimulationSession.created_at, SimulationSession.users]
    column_default_sort = [("created_at", True)]
    column_labels = {
        "id": "ID",
        "status": "Статус",
        "scenario_name": "Сценарий",
        "map_image_url": "URL карты",
        "map_scale": "Масштаб карты",
        "weather": "Погода",
        "time_multiplier": "Множитель времени",
        "created_at": "Создано",
    }


class UserAdmin(ModelView, model=User):
    name = "Пользователь"
    name_plural = "Пользователи"
    icon = "fa-solid fa-users"
    column_list = [
        User.id,
        User.username,
        User.roles,
        User.session_id,
        User.created_at,
    ]
    form_excluded_columns = [User.created_at, User.session]
    column_default_sort = [("created_at", True)]
    column_labels = {
        "id": "ID",
        "username": "Логин",
        "roles": "Роли",
        "session_id": "ID сессии",
        "session": "Сессия",
        "created_at": "Создано",
    }


class VehicleDictionaryAdmin(ModelView, model=VehicleDictionary):
    name = "Единица техники"
    name_plural = "Справочник техники"
    icon = "fa-solid fa-truck"
    column_list = [
        VehicleDictionary.id,
        VehicleDictionary.type,
        VehicleDictionary.name,
        VehicleDictionary.water_capacity,
        VehicleDictionary.foam_capacity,
        VehicleDictionary.crew_size,
        VehicleDictionary.hose_length,
    ]
    column_labels = {
        "id": "ID",
        "type": "Тип",
        "name": "Наименование",
        "water_capacity": "Объем воды, л",
        "foam_capacity": "Объем пенообразователя, л",
        "crew_size": "Боевой расчет, чел",
        "hose_length": "Длина рукавной линии, м",
    }


class SessionStateSnapshotAdmin(ModelView, model=SessionStateSnapshot):
    name = "Снимок состояния"
    name_plural = "Снимки состояния"
    icon = "fa-solid fa-timeline"
    column_list = [
        SessionStateSnapshot.id,
        SessionStateSnapshot.session_id,
        SessionStateSnapshot.sim_time_seconds,
        SessionStateSnapshot.time_of_day,
        SessionStateSnapshot.water_supply_status,
        SessionStateSnapshot.is_current,
        SessionStateSnapshot.captured_at,
    ]
    column_default_sort = [("captured_at", True)]
    column_labels = {
        "id": "ID",
        "session_id": "ID сессии",
        "sim_time_seconds": "Время симуляции, с",
        "time_of_day": "Время суток",
        "water_supply_status": "Состояние водоснабжения",
        "is_current": "Текущее состояние",
        "snapshot_data": "Детали состояния (JSON)",
        "notes": "Примечание",
        "captured_at": "Снято",
    }


class WeatherSnapshotAdmin(ModelView, model=WeatherSnapshot):
    name = "Погодный срез"
    name_plural = "Погодные срезы"
    icon = "fa-solid fa-cloud"
    column_list = [
        WeatherSnapshot.id,
        WeatherSnapshot.state_id,
        WeatherSnapshot.wind_speed,
        WeatherSnapshot.wind_dir,
        WeatherSnapshot.temperature,
        WeatherSnapshot.humidity,
        WeatherSnapshot.created_at,
    ]
    column_default_sort = [("created_at", True)]
    column_labels = {
        "id": "ID",
        "state_id": "ID снимка состояния",
        "wind_speed": "Скорость ветра",
        "wind_dir": "Направление ветра",
        "temperature": "Температура",
        "humidity": "Влажность",
        "precipitation": "Осадки",
        "visibility_m": "Видимость, м",
        "weather_data": "Детали погоды (JSON)",
        "created_at": "Создано",
    }


class FireObjectAdmin(ModelView, model=FireObject):
    name = "Зона огня"
    name_plural = "Зоны огня/дыма"
    icon = "fa-solid fa-fire"
    column_list = [
        FireObject.id,
        FireObject.state_id,
        FireObject.name,
        FireObject.kind,
        FireObject.geometry_type,
        FireObject.area_m2,
        FireObject.spread_speed_m_min,
        FireObject.created_at,
    ]
    column_default_sort = [("created_at", True)]
    column_labels = {
        "id": "ID",
        "state_id": "ID снимка состояния",
        "name": "Наименование",
        "kind": "Тип зоны",
        "geometry_type": "Тип геометрии",
        "geometry": "Геометрия (JSON)",
        "area_m2": "Площадь, м2",
        "perimeter_m": "Периметр, м",
        "spread_speed_m_min": "Скорость распространения, м/мин",
        "spread_azimuth": "Азимут распространения",
        "is_active": "Активна",
        "extra": "Дополнительно (JSON)",
        "created_at": "Создано",
    }


class ResourceDeploymentAdmin(ModelView, model=ResourceDeployment):
    name = "Размещение ресурса"
    name_plural = "Расстановка сил и средств"
    icon = "fa-solid fa-location-dot"
    column_list = [
        ResourceDeployment.id,
        ResourceDeployment.state_id,
        ResourceDeployment.resource_kind,
        ResourceDeployment.status,
        ResourceDeployment.label,
        ResourceDeployment.vehicle_dictionary_id,
        ResourceDeployment.user_id,
        ResourceDeployment.created_at,
    ]
    column_default_sort = [("created_at", True)]
    column_labels = {
        "id": "ID",
        "state_id": "ID снимка состояния",
        "resource_kind": "Тип ресурса",
        "status": "Статус",
        "vehicle_dictionary_id": "ID техники",
        "user_id": "ID пользователя",
        "label": "Название/позывной",
        "geometry_type": "Тип геометрии",
        "geometry": "Геометрия (JSON)",
        "rotation_deg": "Поворот, градусы",
        "resource_data": "Доп. данные (JSON)",
        "created_at": "Создано",
    }


def setup_admin(app):
    admin = Admin(app, engine, title="Админ-панель МЧС")
    admin.add_view(SimulationSessionAdmin)
    admin.add_view(UserAdmin)
    admin.add_view(VehicleDictionaryAdmin)
    admin.add_view(SessionStateSnapshotAdmin)
    admin.add_view(WeatherSnapshotAdmin)
    admin.add_view(FireObjectAdmin)
    admin.add_view(ResourceDeploymentAdmin)
    return admin
