from __future__ import annotations

from app.services.address_scene_service import (
    GeocodeResult,
    build_training_scene_from_address,
    parse_center_from_karta01_url,
    stable_center_from_address,
)


def test_parse_center_from_karta01_url_wgs84() -> None:
    center = parse_center_from_karta01_url(
        "https://karta01.ru/#lat=55.7558&lon=37.6173&zoom=17"
    )
    assert center is not None
    lat, lon = center
    assert abs(lat - 55.7558) < 1e-6
    assert abs(lon - 37.6173) < 1e-6


def test_parse_center_from_karta01_url_web_mercator() -> None:
    center = parse_center_from_karta01_url(
        "https://karta01.ru/#lat=7500000&lon=4180000"
    )
    assert center is not None
    lat, lon = center
    assert -90 <= lat <= 90
    assert -180 <= lon <= 180


def test_parse_center_from_karta01_url_query_params() -> None:
    center = parse_center_from_karta01_url(
        "https://karta01.ru/map?lat=55.7601&lon=37.6180&zoom=16"
    )
    assert center is not None
    lat, lon = center
    assert abs(lat - 55.7601) < 1e-6
    assert abs(lon - 37.6180) < 1e-6


def test_stable_center_from_address_is_deterministic() -> None:
    value_a = stable_center_from_address("Москва, Тверская 1")
    value_b = stable_center_from_address("Москва, Тверская 1")
    value_c = stable_center_from_address("Москва, Тверская 2")
    assert value_a == value_b
    assert value_a != value_c


def test_build_training_scene_from_address_with_mocked_services(monkeypatch) -> None:
    geocode = GeocodeResult(
        provider="NOMINATIM",
        lat=55.7558,
        lon=37.6173,
        display_name="Москва, Тверская улица",
        polygon=None,
    )

    elements = [
        {
            "type": "way",
            "tags": {"building": "yes", "name": "Учебный корпус"},
            "geometry": [
                {"lat": 55.75570, "lon": 37.61710},
                {"lat": 55.75570, "lon": 37.61760},
                {"lat": 55.75600, "lon": 37.61760},
                {"lat": 55.75600, "lon": 37.61710},
                {"lat": 55.75570, "lon": 37.61710},
            ],
        },
        {
            "type": "way",
            "tags": {"highway": "service"},
            "geometry": [
                {"lat": 55.75550, "lon": 37.61680},
                {"lat": 55.75550, "lon": 37.61790},
            ],
        },
        {
            "type": "node",
            "lat": 55.75562,
            "lon": 37.61698,
            "tags": {"emergency": "fire_hydrant"},
        },
        {
            "type": "node",
            "lat": 55.75564,
            "lon": 37.61795,
            "tags": {"natural": "water"},
        },
        {
            "type": "node",
            "lat": 55.75586,
            "lon": 37.61735,
            "tags": {"entrance": "main"},
        },
    ]

    monkeypatch.setattr(
        "app.services.address_scene_service._geocode_with_fallback",
        lambda address_text: (geocode, []),
    )
    monkeypatch.setattr(
        "app.services.address_scene_service._fetch_overpass_elements",
        lambda center_lat, center_lon, radius_m: (elements, "OVERPASS_MAIN", []),
    )

    result = build_training_scene_from_address(
        address_text="Москва, Тверская 1",
        karta01_url="",
        radius_m=220,
    )

    assert result.geocode_provider == "NOMINATIM"
    assert result.overpass_provider == "OVERPASS_MAIN"
    assert result.fallback_used is False
    assert any(entity["kind"] == "BUILDING_CONTOUR" for entity in result.site_entities)
    assert any(obj["kind"] == "WALL" for obj in result.floor_objects)
    assert any(obj["kind"] == "EXIT" for obj in result.floor_objects)


def test_build_training_scene_from_address_fallback(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.services.address_scene_service._geocode_with_fallback",
        lambda address_text: (None, ["Nominatim down", "Photon down"]),
    )
    monkeypatch.setattr(
        "app.services.address_scene_service._fetch_overpass_elements",
        lambda center_lat, center_lon, radius_m: ([], None, ["Overpass down"]),
    )

    result = build_training_scene_from_address(
        address_text="Сочи, Парусная улица",
        karta01_url="",
        radius_m=200,
    )

    assert result.fallback_used is True
    assert result.geocode_provider in {"NONE", "KARTA01"}
    assert any("Overpass" in warning or "OSM" in warning for warning in result.warnings)
    assert len(result.site_entities) >= 1
    assert any(obj["kind"] == "WALL" for obj in result.floor_objects)


def test_build_training_scene_from_text_coordinates(monkeypatch) -> None:
    def _fail_geocoder(address_text: str):
        raise AssertionError(
            f"geocoder must not be called for coordinate input: {address_text}"
        )

    monkeypatch.setattr(
        "app.services.address_scene_service._geocode_with_fallback",
        _fail_geocoder,
    )
    monkeypatch.setattr(
        "app.services.address_scene_service._fetch_overpass_elements",
        lambda center_lat, center_lon, radius_m: ([], None, ["Overpass down"]),
    )

    result = build_training_scene_from_address(
        address_text="55.7558, 37.6173",
        karta01_url="",
        radius_m=200,
    )

    assert result.geocode_provider == "TEXT_COORDS"
    assert result.resolution_mode == "text_coordinates"
    assert abs(result.center_lat - 55.7558) < 1e-5
    assert abs(result.center_lon - 37.6173) < 1e-5


def test_build_training_scene_collects_multiple_site_entities(monkeypatch) -> None:
    geocode = GeocodeResult(
        provider="NOMINATIM",
        lat=55.7558,
        lon=37.6173,
        display_name="Москва, Тверская улица",
        polygon=None,
    )

    elements = [
        {
            "type": "way",
            "tags": {"building": "yes", "name": "Корпус А"},
            "geometry": [
                {"lat": 55.75570, "lon": 37.61710},
                {"lat": 55.75570, "lon": 37.61745},
                {"lat": 55.75595, "lon": 37.61745},
                {"lat": 55.75595, "lon": 37.61710},
                {"lat": 55.75570, "lon": 37.61710},
            ],
        },
        {
            "type": "way",
            "tags": {"building": "yes", "name": "Корпус Б"},
            "geometry": [
                {"lat": 55.75605, "lon": 37.61752},
                {"lat": 55.75605, "lon": 37.61780},
                {"lat": 55.75625, "lon": 37.61780},
                {"lat": 55.75625, "lon": 37.61752},
                {"lat": 55.75605, "lon": 37.61752},
            ],
        },
        {
            "type": "way",
            "tags": {"highway": "service"},
            "geometry": [
                {"lat": 55.75550, "lon": 37.61680},
                {"lat": 55.75550, "lon": 37.61790},
            ],
        },
        {
            "type": "way",
            "tags": {"highway": "residential"},
            "geometry": [
                {"lat": 55.75630, "lon": 37.61685},
                {"lat": 55.75630, "lon": 37.61795},
            ],
        },
        {
            "type": "node",
            "lat": 55.75562,
            "lon": 37.61698,
            "tags": {"emergency": "fire_hydrant"},
        },
        {
            "type": "node",
            "lat": 55.75580,
            "lon": 37.61795,
            "tags": {"emergency": "fire_hydrant"},
        },
        {
            "type": "node",
            "lat": 55.75564,
            "lon": 37.61795,
            "tags": {"natural": "water"},
        },
    ]

    monkeypatch.setattr(
        "app.services.address_scene_service._geocode_with_fallback",
        lambda address_text: (geocode, []),
    )
    monkeypatch.setattr(
        "app.services.address_scene_service._fetch_overpass_elements",
        lambda center_lat, center_lon, radius_m: (elements, "OVERPASS_MAIN", []),
    )

    result = build_training_scene_from_address(
        address_text="Москва, Тверская 1",
        karta01_url="",
        radius_m=300,
    )

    building_contours = [
        entity
        for entity in result.site_entities
        if entity.get("kind") == "BUILDING_CONTOUR"
    ]
    road_lines = [
        entity for entity in result.site_entities if entity.get("kind") == "ROAD_ACCESS"
    ]
    hydrants = [
        entity for entity in result.site_entities if entity.get("kind") == "HYDRANT"
    ]

    assert len(building_contours) >= 2
    assert len(road_lines) >= 2
    assert len(hydrants) >= 2
