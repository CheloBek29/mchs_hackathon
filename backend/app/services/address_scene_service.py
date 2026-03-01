from __future__ import annotations

import hashlib
import json
import math
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote_plus, urlparse
from urllib.request import Request, urlopen
from uuid import uuid4

DEFAULT_CENTER_LAT = 55.751244
DEFAULT_CENTER_LON = 37.618423
DEFAULT_RADIUS_M = 200.0
MIN_RADIUS_M = 50.0
MAX_RADIUS_M = 1000.0

HTTP_USER_AGENT = os.getenv("OSM_HTTP_USER_AGENT", "tp-simulator-training/1.0")
OSM_CONTACT_EMAIL = os.getenv("OSM_CONTACT_EMAIL", "dev@example.com")

GEOCODER_TIMEOUT_SECONDS = 8.0
OVERPASS_TIMEOUT_SECONDS = 18.0
OVERPASS_QUERY_TIMEOUT_SECONDS = 20
OVERPASS_QUERY_MAX_RADIUS_M = 700.0
OVERPASS_RETRY_FACTORS = (1.0, 0.72, 0.52)

MAX_SITE_BUILDING_CONTOURS = 24
MAX_SITE_ROAD_LINES = 18
MAX_SITE_HYDRANTS = 18
MAX_SITE_WATER_SOURCES = 10

GEOCODER_ORDER = (
    "NOMINATIM",
    "PHOTON",
)
DEFAULT_OVERPASS_ORDER = (
    ("OVERPASS_MAIN", "https://overpass-api.de/api/interpreter"),
    ("OVERPASS_KUMI", "https://overpass.kumi.systems/api/interpreter"),
)


def _parse_overpass_order() -> tuple[tuple[str, str], ...]:
    raw = os.getenv("OVERPASS_URLS", "").strip()
    if not raw:
        return DEFAULT_OVERPASS_ORDER

    candidates = [item.strip() for item in raw.split(",") if item.strip()]
    parsed: list[tuple[str, str]] = []
    for index, value in enumerate(candidates, start=1):
        if not value.startswith("https://"):
            continue
        parsed.append((f"OVERPASS_CUSTOM_{index}", value))

    if len(parsed) == 0:
        return DEFAULT_OVERPASS_ORDER
    return tuple(parsed)


OVERPASS_ORDER = _parse_overpass_order()


class ProviderRequestError(RuntimeError):
    pass


@dataclass
class GeocodeResult:
    provider: str
    lat: float
    lon: float
    display_name: str
    polygon: list[tuple[float, float]] | None


@dataclass
class AddressSceneBuildResult:
    center_lat: float
    center_lon: float
    site_entities: list[dict[str, Any]]
    floor_objects: list[dict[str, Any]]
    geocode_provider: str
    overpass_provider: str | None
    resolution_mode: str
    warnings: list[str]
    fallback_used: bool


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed):
        return None
    return parsed


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    return {}


def _clean_provider_error_text(raw: str) -> str:
    if not raw:
        return ""
    lowered = raw.lower()
    if "<html" in lowered or "<!doctype" in lowered:
        return ""
    text = re.sub(r"<[^>]+>", " ", raw)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""
    if len(text) > 120:
        text = f"{text[:120].rstrip()}..."
    return text


def web_mercator_to_wgs84(x_m: float, y_m: float) -> tuple[float, float]:
    earth_radius = 6378137.0
    lon = (x_m / earth_radius) * (180 / math.pi)
    lat = (2 * math.atan(math.exp(y_m / earth_radius)) - math.pi / 2) * (180 / math.pi)
    return lat, lon


def parse_center_from_karta01_url(karta01_url: str) -> tuple[float, float] | None:
    def _coords_from_values(values: dict[str, list[str]]) -> tuple[float, float] | None:
        raw_lat = values.get("lat", [None])[0] or values.get("y", [None])[0]
        raw_lon = (
            values.get("lon", [None])[0]
            or values.get("lng", [None])[0]
            or values.get("x", [None])[0]
        )

        if raw_lat is not None and raw_lon is not None:
            lat_value = _safe_float(raw_lat)
            lon_value = _safe_float(raw_lon)
            if lat_value is not None and lon_value is not None:
                if abs(lat_value) <= 90 and abs(lon_value) <= 180:
                    return lat_value, lon_value
                return web_mercator_to_wgs84(lon_value, lat_value)

        raw_center = values.get("center", [None])[0]
        if isinstance(raw_center, str):
            center_parts = [part.strip() for part in raw_center.split(",")]
            if len(center_parts) == 2:
                first = _safe_float(center_parts[0])
                second = _safe_float(center_parts[1])
                if first is not None and second is not None:
                    if abs(first) <= 90 and abs(second) <= 180:
                        return first, second
                    if abs(first) <= 180 and abs(second) <= 90:
                        return second, first

        return None

    try:
        parsed = urlparse(karta01_url)
    except Exception:
        return None

    query_values = parse_qs(parsed.query or "")
    from_query = _coords_from_values(query_values)
    if from_query is not None:
        return from_query

    fragment_values = parse_qs(parsed.fragment or "")
    from_fragment = _coords_from_values(fragment_values)
    if from_fragment is not None:
        return from_fragment

    return None


def stable_center_from_address(address_text: str) -> tuple[float, float]:
    normalized = address_text.strip().lower()
    if not normalized:
        return DEFAULT_CENTER_LAT, DEFAULT_CENTER_LON

    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    seed_a = int(digest[:8], 16)
    seed_b = int(digest[8:16], 16)
    lat = 55.0 + (seed_a % 2000) / 10000.0
    lon = 37.0 + (seed_b % 3000) / 10000.0
    return lat, lon


def _normalize_match_text(value: str) -> str:
    normalized = value.strip().lower().replace("ё", "е")
    normalized = re.sub(r"[^0-9a-zа-я]+", " ", normalized)
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.strip()


def _address_tokens(value: str) -> list[str]:
    return [
        token for token in _normalize_match_text(value).split(" ") if len(token) >= 2
    ]


def _token_overlap_score(address_tokens: list[str], candidate_text: str) -> float:
    if len(address_tokens) == 0:
        return 0.0
    normalized_candidate = _normalize_match_text(candidate_text)
    if not normalized_candidate:
        return 0.0
    hits = sum(1 for token in address_tokens if token in normalized_candidate)
    return hits / len(address_tokens)


def _clean_address_query(raw: str) -> str:
    value = raw.strip().replace("\n", " ").replace("\t", " ")
    value = re.sub(r"\s+", " ", value)
    value = re.sub(r"\s*[,;]+\s*", ", ", value)
    value = re.sub(r"(?:,\s*){2,}", ", ", value)
    return value.strip(" ,")


def _strip_indoor_details(raw: str) -> str:
    value = raw
    value = re.sub(
        r"\b(кв|квартира|офис|подъезд|этаж|стр|строение|корпус|корп|помещение|литер|подвал)\.?\s*[0-9а-яa-z/-]+",
        " ",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(r"#\s*[0-9а-яa-z/-]+", " ", value, flags=re.IGNORECASE)
    return _clean_address_query(value)


def _build_geocode_query_candidates(address_text: str) -> list[str]:
    base = _clean_address_query(address_text)
    if not base:
        return []

    variants: list[str] = [base]
    stripped = _strip_indoor_details(base)
    if stripped and stripped != base:
        variants.append(stripped)

    if "россия" not in _normalize_match_text(base):
        variants.append(f"{base}, Россия")
        if (
            stripped
            and stripped != base
            and "россия" not in _normalize_match_text(stripped)
        ):
            variants.append(f"{stripped}, Россия")

    unique: list[str] = []
    seen: set[str] = set()
    for variant in variants:
        key = _normalize_match_text(variant)
        if not key or key in seen:
            continue
        seen.add(key)
        unique.append(variant)
        if len(unique) >= 5:
            break
    return unique


def _parse_coordinate_number(raw: str) -> float | None:
    return _safe_float(raw.replace(",", "."))


def _extract_center_from_text_coordinates(
    address_text: str,
) -> tuple[float, float] | None:
    labeled_lat = re.search(
        r"(?:lat|latitude|широта)\s*[:=]\s*(-?\d+(?:[\.,]\d+)?)",
        address_text,
        flags=re.IGNORECASE,
    )
    labeled_lon = re.search(
        r"(?:lon|lng|longitude|долгота)\s*[:=]\s*(-?\d+(?:[\.,]\d+)?)",
        address_text,
        flags=re.IGNORECASE,
    )
    if labeled_lat and labeled_lon:
        lat = _parse_coordinate_number(labeled_lat.group(1))
        lon = _parse_coordinate_number(labeled_lon.group(1))
        if lat is not None and lon is not None and abs(lat) <= 90 and abs(lon) <= 180:
            return lat, lon

    pair = re.search(
        r"(-?\d{1,3}(?:[\.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[\.,]\d+)?)",
        address_text,
    )
    if not pair:
        return None

    first = _parse_coordinate_number(pair.group(1))
    second = _parse_coordinate_number(pair.group(2))
    if first is None or second is None:
        return None

    if abs(first) <= 90 and abs(second) <= 180:
        return first, second
    if abs(first) <= 180 and abs(second) <= 90:
        return second, first
    return None


def _score_nominatim_entry(entry: dict[str, Any], address_tokens: list[str]) -> float:
    display_name = str(entry.get("display_name") or "")
    addresstype = str(entry.get("addresstype") or entry.get("type") or "")
    class_name = str(entry.get("class") or "")
    importance = _safe_float(entry.get("importance")) or 0.0
    overlap = _token_overlap_score(
        address_tokens, f"{display_name} {addresstype} {class_name}"
    )
    house_bonus = (
        0.22
        if re.search(r"\b\d+[а-яa-z]?\b", display_name, flags=re.IGNORECASE)
        else 0.0
    )
    locality_penalty = -0.2 if addresstype in {"country", "state", "region"} else 0.0
    return overlap * 4.0 + importance + house_bonus + locality_penalty


def _score_photon_feature(feature: dict[str, Any], address_tokens: list[str]) -> float:
    raw_properties = feature.get("properties")
    properties: dict[str, Any] = (
        raw_properties if isinstance(raw_properties, dict) else {}
    )
    label_parts = [
        str(properties.get("name") or ""),
        str(properties.get("street") or ""),
        str(properties.get("housenumber") or ""),
        str(properties.get("city") or ""),
        str(properties.get("district") or ""),
        str(properties.get("country") or ""),
    ]
    label_text = " ".join(part for part in label_parts if part)
    overlap = _token_overlap_score(address_tokens, label_text)
    rank = _safe_float(properties.get("rank")) or 0.0
    house_bonus = 0.22 if str(properties.get("housenumber") or "").strip() else 0.0
    return overlap * 4.0 + (rank / 30.0) + house_bonus


def _fetch_json(
    provider_label: str,
    url: str,
    *,
    method: str = "GET",
    timeout_seconds: float,
    body: str | None = None,
    extra_headers: dict[str, str] | None = None,
) -> Any:
    headers = {
        "Accept": "application/json",
        "User-Agent": HTTP_USER_AGENT,
    }
    if extra_headers:
        headers.update(extra_headers)

    encoded_body = body.encode("utf-8") if body is not None else None
    request = Request(url=url, data=encoded_body, method=method, headers=headers)

    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        raw_body = ""
        try:
            raw_body = exc.read().decode("utf-8", errors="replace")
        except Exception:
            raw_body = ""
        details = _clean_provider_error_text(raw_body)
        suffix = f" {details}" if details else ""
        raise ProviderRequestError(
            f"{provider_label}: HTTP {exc.code}{suffix}"
        ) from exc
    except URLError as exc:
        raise ProviderRequestError(f"{provider_label}: {exc.reason}") from exc
    except TimeoutError as exc:
        raise ProviderRequestError(f"{provider_label}: timeout") from exc

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ProviderRequestError(f"{provider_label}: invalid JSON response") from exc


def _geojson_to_outer_ring(geojson_value: Any) -> list[tuple[float, float]] | None:
    if not isinstance(geojson_value, dict):
        return None

    geo_type = str(geojson_value.get("type") or "")
    coordinates = geojson_value.get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) == 0:
        return None

    ring_raw: Any = None
    if geo_type == "Polygon":
        ring_raw = coordinates[0] if coordinates else None
    elif geo_type == "MultiPolygon":
        first_polygon = coordinates[0] if coordinates else None
        if isinstance(first_polygon, list) and first_polygon:
            ring_raw = first_polygon[0]

    if not isinstance(ring_raw, list):
        return None

    ring: list[tuple[float, float]] = []
    for point in ring_raw:
        if not isinstance(point, list) or len(point) < 2:
            continue
        lon = _safe_float(point[0])
        lat = _safe_float(point[1])
        if lon is None or lat is None:
            continue
        ring.append((lat, lon))

    if len(ring) < 3:
        return None
    return ring


def _geocode_via_nominatim(address_text: str) -> GeocodeResult:
    address_tokens = _address_tokens(address_text)
    query = quote_plus(address_text)
    base = (
        "https://nominatim.openstreetmap.org/search"
        f"?format=jsonv2&limit=5&addressdetails=1&polygon_geojson=1&dedupe=1&accept-language=ru&q={query}"
    )
    if OSM_CONTACT_EMAIL.strip():
        base = f"{base}&email={quote_plus(OSM_CONTACT_EMAIL.strip())}"

    payload = _fetch_json(
        "Nominatim",
        base,
        timeout_seconds=GEOCODER_TIMEOUT_SECONDS,
    )

    if not isinstance(payload, list) or len(payload) == 0:
        raise ProviderRequestError("Nominatim: address not found")

    best_entry: dict[str, Any] | None = None
    best_score = float("-inf")

    for item in payload[:5]:
        if not isinstance(item, dict):
            continue
        lat = _safe_float(item.get("lat"))
        lon = _safe_float(item.get("lon"))
        if lat is None or lon is None:
            continue
        score = _score_nominatim_entry(item, address_tokens)
        if score > best_score:
            best_score = score
            best_entry = item

    if best_entry is None:
        raise ProviderRequestError("Nominatim: invalid payload")

    lat = _safe_float(best_entry.get("lat"))
    lon = _safe_float(best_entry.get("lon"))
    if lat is None or lon is None:
        raise ProviderRequestError("Nominatim: invalid coordinates")

    return GeocodeResult(
        provider="NOMINATIM",
        lat=lat,
        lon=lon,
        display_name=str(best_entry.get("display_name") or ""),
        polygon=_geojson_to_outer_ring(best_entry.get("geojson")),
    )


def _geocode_via_photon(address_text: str) -> GeocodeResult:
    address_tokens = _address_tokens(address_text)
    query = quote_plus(address_text)
    url = f"https://photon.komoot.io/api/?q={query}&limit=5&lang=ru"
    payload = _fetch_json(
        "Photon",
        url,
        timeout_seconds=GEOCODER_TIMEOUT_SECONDS,
    )

    if not isinstance(payload, dict):
        raise ProviderRequestError("Photon: invalid payload")
    features = payload.get("features")
    if not isinstance(features, list) or len(features) == 0:
        raise ProviderRequestError("Photon: address not found")

    best_feature: dict[str, Any] | None = None
    best_score = float("-inf")
    for item in features[:5]:
        if not isinstance(item, dict):
            continue
        geometry = item.get("geometry")
        if not isinstance(geometry, dict):
            continue
        coordinates = geometry.get("coordinates")
        if not isinstance(coordinates, list) or len(coordinates) < 2:
            continue

        lon = _safe_float(coordinates[0])
        lat = _safe_float(coordinates[1])
        if lat is None or lon is None:
            continue

        score = _score_photon_feature(item, address_tokens)
        if score > best_score:
            best_score = score
            best_feature = item

    if best_feature is None:
        raise ProviderRequestError("Photon: invalid feature")

    geometry = best_feature.get("geometry")
    if not isinstance(geometry, dict):
        raise ProviderRequestError("Photon: invalid geometry")
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        raise ProviderRequestError("Photon: coordinates missing")

    lon = _safe_float(coordinates[0])
    lat = _safe_float(coordinates[1])
    if lat is None or lon is None:
        raise ProviderRequestError("Photon: invalid coordinates")

    raw_properties = best_feature.get("properties")
    properties: dict[str, Any] = (
        raw_properties if isinstance(raw_properties, dict) else {}
    )
    display_name = str(
        properties.get("name") or properties.get("street") or address_text
    )

    return GeocodeResult(
        provider="PHOTON",
        lat=lat,
        lon=lon,
        display_name=display_name,
        polygon=None,
    )


def _geocode_with_fallback(address_text: str) -> tuple[GeocodeResult | None, list[str]]:
    warnings: list[str] = []
    query_candidates = _build_geocode_query_candidates(address_text)
    for query in query_candidates:
        for provider_name in GEOCODER_ORDER:
            try:
                if provider_name == "NOMINATIM":
                    return _geocode_via_nominatim(query), warnings
                return _geocode_via_photon(query), warnings
            except ProviderRequestError as exc:
                warnings.append(str(exc))

    if len(query_candidates) == 0:
        warnings.append("Geocoder: empty address query")
    return None, warnings


def _distance_meters(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> float:
    to_rad = math.radians
    d_lat = to_rad(lat_b - lat_a)
    d_lon = to_rad(lon_b - lon_a)
    la_1 = to_rad(lat_a)
    la_2 = to_rad(lat_b)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(la_1) * math.cos(la_2) * math.sin(d_lon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return 6371000 * c


def _meters_per_lon_degree(at_lat: float) -> float:
    cosine = math.cos(math.radians(at_lat))
    safe = 1e-6 if abs(cosine) < 1e-6 else abs(cosine)
    return 111320 * safe


def _latlon_to_local(
    lat: float, lon: float, center_lat: float, center_lon: float
) -> dict[str, float]:
    x = (lon - center_lon) * _meters_per_lon_degree(center_lat)
    y = (lat - center_lat) * 110540
    return {"x": round(x, 3), "y": round(y, 3)}


def _way_latlon_points(way: dict[str, Any]) -> list[tuple[float, float]]:
    geometry = way.get("geometry")
    if not isinstance(geometry, list):
        return []
    out: list[tuple[float, float]] = []
    for point in geometry:
        if not isinstance(point, dict):
            continue
        lat = _safe_float(point.get("lat"))
        lon = _safe_float(point.get("lon"))
        if lat is None or lon is None:
            continue
        out.append((lat, lon))
    return out


def _node_latlon(node: dict[str, Any]) -> tuple[float, float] | None:
    lat = _safe_float(node.get("lat"))
    lon = _safe_float(node.get("lon"))
    if lat is None or lon is None:
        return None
    return lat, lon


def _close_local_polygon(points: list[dict[str, float]]) -> list[dict[str, float]]:
    if len(points) < 3:
        return []
    first = points[0]
    last = points[-1]
    if first["x"] == last["x"] and first["y"] == last["y"]:
        return points
    return [*points, {"x": first["x"], "y": first["y"]}]


def _overpass_query(center_lat: float, center_lon: float, radius_m: float) -> str:
    radius = int(round(min(radius_m, OVERPASS_QUERY_MAX_RADIUS_M)))
    highway_radius = int(round(min(radius_m, OVERPASS_QUERY_MAX_RADIUS_M * 0.82)))
    return "\n".join(
        [
            f"[out:json][timeout:{OVERPASS_QUERY_TIMEOUT_SECONDS}];",
            "(",
            f'  node(around:{radius},{center_lat},{center_lon})["emergency"="fire_hydrant"];',
            f'  node(around:{radius},{center_lat},{center_lon})["natural"="water"];',
            f'  node(around:{radius},{center_lat},{center_lon})["waterway"];',
            f'  node(around:{radius},{center_lat},{center_lon})["man_made"="water_well"];',
            f'  node(around:{radius},{center_lat},{center_lon})["man_made"="water_tower"];',
            f'  node(around:{radius},{center_lat},{center_lon})["entrance"];',
            f'  node(around:{radius},{center_lat},{center_lon})["highway"="emergency_access_point"];',
            f'  way(around:{radius},{center_lat},{center_lon})["building"];',
            f'  way(around:{highway_radius},{center_lat},{center_lon})["highway"~"motorway|trunk|primary|secondary|tertiary|residential|service|unclassified|living_street|road|track"];',
            ");",
            "out body geom;",
        ]
    )


def _fetch_overpass_elements(
    center_lat: float,
    center_lon: float,
    radius_m: float,
) -> tuple[list[dict[str, Any]], str | None, list[str]]:
    retry_radii: list[float] = []
    seen_radii: set[int] = set()
    for factor in OVERPASS_RETRY_FACTORS:
        candidate = max(MIN_RADIUS_M, radius_m * factor)
        rounded = int(round(candidate))
        if rounded in seen_radii:
            continue
        seen_radii.add(rounded)
        retry_radii.append(float(rounded))

    warnings: list[str] = []
    for provider_name, provider_url in OVERPASS_ORDER:
        provider_errors: list[str] = []
        for retry_radius in retry_radii:
            query = _overpass_query(center_lat, center_lon, retry_radius)
            try:
                payload = _fetch_json(
                    provider_name,
                    provider_url,
                    method="POST",
                    timeout_seconds=OVERPASS_TIMEOUT_SECONDS,
                    body=query,
                    extra_headers={"Content-Type": "text/plain; charset=utf-8"},
                )
                elements = (
                    payload.get("elements") if isinstance(payload, dict) else None
                )
                if not isinstance(elements, list):
                    raise ProviderRequestError(f"{provider_name}: invalid payload")
                normalized = [item for item in elements if isinstance(item, dict)]
                return normalized, provider_name, warnings
            except ProviderRequestError as exc:
                provider_errors.append(str(exc))
                continue

        if provider_errors:
            last_error = provider_errors[-1]
            delimiter = ": "
            compact_error = (
                last_error.split(delimiter, 1)[1]
                if delimiter in last_error
                else last_error
            )
            warnings.append(
                f"{provider_name}: {compact_error} (после {len(provider_errors)} попыток)"
            )

    return [], None, warnings


def _nearest_building_contour(
    elements: list[dict[str, Any]],
    center_lat: float,
    center_lon: float,
) -> tuple[list[dict[str, float]] | None, str, float | None]:
    best_points: list[dict[str, float]] | None = None
    best_distance = float("inf")

    for element in elements:
        if element.get("type") != "way":
            continue
        tags: dict[str, Any] = _as_dict(element.get("tags"))
        if "building" not in tags or "building:part" in tags:
            continue
        latlon_points = _way_latlon_points(element)
        if len(latlon_points) < 3:
            continue

        avg_lat = sum(point[0] for point in latlon_points) / len(latlon_points)
        avg_lon = sum(point[1] for point in latlon_points) / len(latlon_points)
        distance = _distance_meters(center_lat, center_lon, avg_lat, avg_lon)
        if distance >= best_distance:
            continue

        local = [
            _latlon_to_local(lat, lon, center_lat, center_lon)
            for lat, lon in latlon_points
        ]
        local_ring = _close_local_polygon(local)
        if len(local_ring) < 4:
            continue

        best_distance = distance
        best_points = local_ring

    if best_points is None:
        return None, "", None
    return best_points, "Контур здания", best_distance


def _nearest_road_access(
    elements: list[dict[str, Any]],
    center_lat: float,
    center_lon: float,
) -> list[dict[str, float]] | None:
    best_line: list[dict[str, float]] | None = None
    best_distance = float("inf")

    for element in elements:
        if element.get("type") != "way":
            continue
        tags: dict[str, Any] = _as_dict(element.get("tags"))
        if "highway" not in tags:
            continue
        latlon_points = _way_latlon_points(element)
        if len(latlon_points) < 2:
            continue

        avg_lat = sum(point[0] for point in latlon_points) / len(latlon_points)
        avg_lon = sum(point[1] for point in latlon_points) / len(latlon_points)
        distance = _distance_meters(center_lat, center_lon, avg_lat, avg_lon)
        if distance >= best_distance:
            continue
        local_line = [
            _latlon_to_local(lat, lon, center_lat, center_lon)
            for lat, lon in latlon_points
        ]
        if len(local_line) < 2:
            continue

        best_distance = distance
        best_line = local_line[:60]

    return best_line


def _polygon_area_m2(points: list[dict[str, float]]) -> float:
    if len(points) < 3:
        return 0.0

    area = 0.0
    for index in range(len(points) - 1):
        point_a = points[index]
        point_b = points[index + 1]
        area += point_a["x"] * point_b["y"] - point_b["x"] * point_a["y"]
    return abs(area) / 2.0


def _polyline_length_m(points: list[dict[str, float]]) -> float:
    if len(points) < 2:
        return 0.0

    total = 0.0
    for index in range(1, len(points)):
        prev = points[index - 1]
        curr = points[index]
        dx = curr["x"] - prev["x"]
        dy = curr["y"] - prev["y"]
        total += math.sqrt(dx * dx + dy * dy)
    return total


def _geometry_center(points: list[dict[str, float]]) -> dict[str, float]:
    if len(points) == 0:
        return {"x": 0.0, "y": 0.0}

    sum_x = sum(point["x"] for point in points)
    sum_y = sum(point["y"] for point in points)
    return {
        "x": sum_x / len(points),
        "y": sum_y / len(points),
    }


def _distance_between_points_m(
    point_a: dict[str, float], point_b: dict[str, float]
) -> float:
    dx = point_a["x"] - point_b["x"]
    dy = point_a["y"] - point_b["y"]
    return math.sqrt(dx * dx + dy * dy)


def _bounding_box(
    points: list[dict[str, float]],
) -> tuple[float, float, float, float] | None:
    if len(points) == 0:
        return None

    xs = [point["x"] for point in points]
    ys = [point["y"] for point in points]
    return min(xs), min(ys), max(xs), max(ys)


def _box_overlap_ratio(
    first: tuple[float, float, float, float] | None,
    second: tuple[float, float, float, float] | None,
) -> float:
    if first is None or second is None:
        return 0.0

    ax0, ay0, ax1, ay1 = first
    bx0, by0, bx1, by1 = second

    overlap_w = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    overlap_h = max(0.0, min(ay1, by1) - max(ay0, by0))
    overlap_area = overlap_w * overlap_h
    if overlap_area <= 0:
        return 0.0

    area_a = max(1e-6, (ax1 - ax0) * (ay1 - ay0))
    area_b = max(1e-6, (bx1 - bx0) * (by1 - by0))
    return overlap_area / min(area_a, area_b)


def _collect_nearby_building_contours(
    elements: list[dict[str, Any]],
    center_lat: float,
    center_lon: float,
    radius_m: float,
    primary_contour: list[dict[str, float]] | None,
    *,
    limit: int,
) -> list[list[dict[str, float]]]:
    ranked: list[tuple[float, list[dict[str, float]]]] = []
    max_distance = max(140.0, radius_m * 1.2)
    primary_center = (
        _geometry_center(
            primary_contour[:-1] if len(primary_contour) > 1 else primary_contour
        )
        if primary_contour
        else None
    )
    primary_box = _bounding_box(primary_contour or [])

    for element in elements:
        if element.get("type") != "way":
            continue
        tags: dict[str, Any] = _as_dict(element.get("tags"))
        if "building" not in tags or "building:part" in tags:
            continue

        latlon_points = _way_latlon_points(element)
        if len(latlon_points) < 3:
            continue

        avg_lat = sum(point[0] for point in latlon_points) / len(latlon_points)
        avg_lon = sum(point[1] for point in latlon_points) / len(latlon_points)
        distance = _distance_meters(center_lat, center_lon, avg_lat, avg_lon)
        if distance > max_distance:
            continue

        local_ring = _close_local_polygon(
            [
                _latlon_to_local(lat, lon, center_lat, center_lon)
                for lat, lon in latlon_points
            ]
        )
        if len(local_ring) < 4:
            continue

        area_m2 = _polygon_area_m2(local_ring)
        if area_m2 < 30.0:
            continue

        if primary_center is not None:
            candidate_center = _geometry_center(
                local_ring[:-1] if len(local_ring) > 1 else local_ring
            )
            if _distance_between_points_m(primary_center, candidate_center) < 24.0:
                continue

        if _box_overlap_ratio(primary_box, _bounding_box(local_ring)) > 0.16:
            continue

        ranked.append((distance, local_ring))

    ranked.sort(key=lambda item: item[0])

    selected: list[list[dict[str, float]]] = []
    seen_keys: set[tuple[int, int]] = set()
    for _, ring in ranked:
        center = _geometry_center(ring[:-1] if len(ring) > 1 else ring)
        dedupe_key = (round(center["x"] / 10), round(center["y"] / 10))
        if dedupe_key in seen_keys:
            continue
        seen_keys.add(dedupe_key)
        selected.append(ring[:120])
        if len(selected) >= limit:
            break

    return selected


def _collect_nearby_road_lines(
    elements: list[dict[str, Any]],
    center_lat: float,
    center_lon: float,
    radius_m: float,
    *,
    limit: int,
) -> list[list[dict[str, float]]]:
    ranked: list[tuple[float, list[dict[str, float]]]] = []
    max_distance = max(160.0, radius_m * 1.2)

    for element in elements:
        if element.get("type") != "way":
            continue
        tags: dict[str, Any] = _as_dict(element.get("tags"))
        if "highway" not in tags:
            continue

        latlon_points = _way_latlon_points(element)
        if len(latlon_points) < 2:
            continue

        avg_lat = sum(point[0] for point in latlon_points) / len(latlon_points)
        avg_lon = sum(point[1] for point in latlon_points) / len(latlon_points)
        distance = _distance_meters(center_lat, center_lon, avg_lat, avg_lon)
        if distance > max_distance:
            continue

        local_line = [
            _latlon_to_local(lat, lon, center_lat, center_lon)
            for lat, lon in latlon_points
        ]
        if len(local_line) < 2:
            continue

        line_length = _polyline_length_m(local_line)
        if line_length < 24.0:
            continue

        ranked.append((distance, local_line[:140]))

    ranked.sort(key=lambda item: item[0])

    selected: list[list[dict[str, float]]] = []
    seen_keys: set[tuple[int, int, int]] = set()
    for _, line in ranked:
        center = _geometry_center(line)
        first = line[0]
        last = line[-1]
        heading = math.atan2(last["y"] - first["y"], last["x"] - first["x"])
        dedupe_key = (
            round(center["x"] / 14),
            round(center["y"] / 14),
            round(heading * 2 / math.pi),
        )
        if dedupe_key in seen_keys:
            continue
        seen_keys.add(dedupe_key)
        selected.append(line)
        if len(selected) >= limit:
            break

    return selected


def _collect_node_points(
    elements: list[dict[str, Any]],
    center_lat: float,
    center_lon: float,
    *,
    predicate,
    limit: int,
) -> list[dict[str, float]]:
    ranked: list[tuple[float, dict[str, float]]] = []
    for element in elements:
        if element.get("type") != "node":
            continue
        tags = element.get("tags") if isinstance(element.get("tags"), dict) else {}
        if not predicate(tags):
            continue

        latlon = _node_latlon(element)
        if latlon is None:
            continue
        lat, lon = latlon
        distance = _distance_meters(center_lat, center_lon, lat, lon)
        ranked.append((distance, _latlon_to_local(lat, lon, center_lat, center_lon)))

    ranked.sort(key=lambda item: item[0])
    return [entry[1] for entry in ranked[:limit]]


def _fallback_contour(radius_m: float) -> list[dict[str, float]]:
    half_width = max(20.0, min(radius_m * 0.28, 75.0))
    half_height = max(14.0, min(radius_m * 0.20, 52.0))
    return [
        {"x": -half_width, "y": -half_height},
        {"x": half_width, "y": -half_height},
        {"x": half_width, "y": half_height},
        {"x": -half_width, "y": half_height},
        {"x": -half_width, "y": -half_height},
    ]


def _fallback_road_from_contour(
    contour: list[dict[str, float]],
) -> list[dict[str, float]]:
    x_values = [point["x"] for point in contour]
    y_values = [point["y"] for point in contour]
    min_x = min(x_values)
    max_x = max(x_values)
    min_y = min(y_values)
    road_y = min_y - 12.0
    return [
        {"x": min_x - 14.0, "y": road_y},
        {"x": max_x + 14.0, "y": road_y},
    ]


def _to_object(
    kind: str, geometry_type: str, geometry: dict[str, Any], label: str
) -> dict[str, Any]:
    return {
        "id": f"obj_{uuid4().hex[:10]}",
        "kind": kind,
        "geometry_type": geometry_type,
        "geometry": geometry,
        "label": label,
        "props": {},
        "created_at": utcnow_iso(),
    }


def _contour_edges(
    contour: list[dict[str, float]],
) -> list[tuple[dict[str, float], dict[str, float]]]:
    if len(contour) < 4:
        return []
    edges: list[tuple[dict[str, float], dict[str, float]]] = []
    for idx in range(len(contour) - 1):
        edges.append((contour[idx], contour[idx + 1]))
    return edges


def _midpoint(point_a: dict[str, float], point_b: dict[str, float]) -> dict[str, float]:
    return {
        "x": round((point_a["x"] + point_b["x"]) / 2, 3),
        "y": round((point_a["y"] + point_b["y"]) / 2, 3),
    }


def _seed_floor_objects(
    contour: list[dict[str, float]],
    exits: list[dict[str, float]],
    hydrants: list[dict[str, float]],
    water_sources: list[dict[str, float]],
) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []

    for start, finish in _contour_edges(contour):
        objects.append(
            _to_object(
                "WALL",
                "LINESTRING",
                {"points": [start, finish]},
                "Стена",
            )
        )

    resolved_exits = exits[:2]
    if len(resolved_exits) == 0 and len(contour) >= 4:
        resolved_exits = [
            _midpoint(contour[0], contour[1]),
            _midpoint(contour[2], contour[3]),
        ]

    for index, exit_point in enumerate(resolved_exits, start=1):
        objects.append(_to_object("EXIT", "POINT", exit_point, f"Выход {index}"))

    for index, hydrant_point in enumerate(hydrants[:4], start=1):
        objects.append(
            _to_object("HYDRANT", "POINT", hydrant_point, f"Гидрант {index}")
        )

    for index, water_point in enumerate(water_sources[:2], start=1):
        objects.append(
            _to_object("WATER_SOURCE", "POINT", water_point, f"Водоисточник {index}")
        )

    return objects


def _build_site_entities(
    contour: list[dict[str, float]],
    road: list[dict[str, float]] | None,
    hydrants: list[dict[str, float]],
    water_sources: list[dict[str, float]],
    nearby_buildings: list[list[dict[str, float]]],
    nearby_roads: list[list[dict[str, float]]],
) -> list[dict[str, Any]]:
    entities: list[dict[str, Any]] = [
        {
            "id": f"site_{uuid4().hex[:10]}",
            "kind": "BUILDING_CONTOUR",
            "geometry_type": "POLYGON",
            "geometry": {"points": contour},
            "label": "Контур здания",
        }
    ]

    primary_building_center = _geometry_center(
        contour[:-1] if len(contour) > 1 else contour
    )
    building_count = 1
    next_building_label = 1
    for building_contour in nearby_buildings:
        if len(building_contour) < 4:
            continue
        building_center = _geometry_center(
            building_contour[:-1] if len(building_contour) > 1 else building_contour
        )
        if _distance_between_points_m(primary_building_center, building_center) < 10.0:
            continue

        entities.append(
            {
                "id": f"site_{uuid4().hex[:10]}",
                "kind": "BUILDING_CONTOUR",
                "geometry_type": "POLYGON",
                "geometry": {"points": building_contour},
                "label": f"Соседнее здание {next_building_label}",
            }
        )
        building_count += 1
        next_building_label += 1
        if building_count >= MAX_SITE_BUILDING_CONTOURS:
            break

    if road and len(road) >= 2:
        entities.append(
            {
                "id": f"site_{uuid4().hex[:10]}",
                "kind": "ROAD_ACCESS",
                "geometry_type": "LINESTRING",
                "geometry": {"points": road},
                "label": "Подъезд",
            }
        )

    primary_road_center = _geometry_center(road) if road and len(road) >= 2 else None
    road_count = 1 if road and len(road) >= 2 else 0
    road_index = 1
    for road_line in nearby_roads:
        if len(road_line) < 2:
            continue

        road_center = _geometry_center(road_line)
        if (
            primary_road_center is not None
            and _distance_between_points_m(primary_road_center, road_center) < 12.0
        ):
            continue

        entities.append(
            {
                "id": f"site_{uuid4().hex[:10]}",
                "kind": "ROAD_ACCESS",
                "geometry_type": "LINESTRING",
                "geometry": {"points": road_line},
                "label": f"Дорога {road_index}",
            }
        )
        road_count += 1
        road_index += 1
        if road_count >= MAX_SITE_ROAD_LINES:
            break

    for index, point in enumerate(hydrants[:MAX_SITE_HYDRANTS], start=1):
        entities.append(
            {
                "id": f"site_{uuid4().hex[:10]}",
                "kind": "HYDRANT",
                "geometry_type": "POINT",
                "geometry": point,
                "label": f"Гидрант {index}",
            }
        )

    for index, point in enumerate(water_sources[:MAX_SITE_WATER_SOURCES], start=1):
        entities.append(
            {
                "id": f"site_{uuid4().hex[:10]}",
                "kind": "WATER_SOURCE",
                "geometry_type": "POINT",
                "geometry": point,
                "label": f"Водоисточник {index}",
            }
        )

    return entities


def _normalize_radius(radius_m: float | int | None) -> float:
    parsed = _safe_float(radius_m)
    if parsed is None:
        return DEFAULT_RADIUS_M
    return max(MIN_RADIUS_M, min(MAX_RADIUS_M, parsed))


def _local_polygon_from_geocode(
    geocode_polygon: list[tuple[float, float]] | None,
    center_lat: float,
    center_lon: float,
) -> list[dict[str, float]] | None:
    if not geocode_polygon:
        return None
    local_points = [
        _latlon_to_local(lat, lon, center_lat, center_lon)
        for lat, lon in geocode_polygon
    ]
    local_ring = _close_local_polygon(local_points)
    if len(local_ring) < 4:
        return None
    return local_ring


def build_training_scene_from_address(
    address_text: str,
    karta01_url: str,
    radius_m: float,
) -> AddressSceneBuildResult:
    address = address_text.strip()
    karta = karta01_url.strip()
    radius = _normalize_radius(radius_m)

    warnings: list[str] = []
    fallback_used = False

    center_lat: float | None = None
    center_lon: float | None = None
    geocode_provider = "NONE"
    resolution_mode = "fallback"
    geocode_polygon: list[tuple[float, float]] | None = None

    if karta:
        parsed_center = parse_center_from_karta01_url(karta)
        if parsed_center is not None:
            center_lat, center_lon = parsed_center
            geocode_provider = "KARTA01"
            resolution_mode = "karta01_url"
        else:
            warnings.append("Karta01 URL не содержит корректные координаты")

    if center_lat is None or center_lon is None:
        if address:
            text_center = _extract_center_from_text_coordinates(address)
            if text_center is not None:
                center_lat, center_lon = text_center
                geocode_provider = "TEXT_COORDS"
                resolution_mode = "text_coordinates"
            else:
                geocode_result, geocode_warnings = _geocode_with_fallback(address)
                warnings.extend(geocode_warnings)
                if geocode_result is not None:
                    center_lat = geocode_result.lat
                    center_lon = geocode_result.lon
                    geocode_provider = geocode_result.provider
                    geocode_polygon = geocode_result.polygon
                    resolution_mode = "geocoding"
                else:
                    fallback_used = True
                    warnings.append("Не удалось определить координаты через geocoding")
                    center_lat, center_lon = stable_center_from_address(address)
        else:
            fallback_used = True
            warnings.append("Адрес не задан. Использован резервный центр.")
            center_lat, center_lon = DEFAULT_CENTER_LAT, DEFAULT_CENTER_LON

    elements, overpass_provider, overpass_warnings = _fetch_overpass_elements(
        center_lat, center_lon, radius
    )
    warnings.extend(overpass_warnings)
    if overpass_provider is None:
        fallback_used = True
        warnings.append("Не удалось получить данные OSM через Overpass")

    contour, contour_label, contour_distance = _nearest_building_contour(
        elements, center_lat, center_lon
    )

    if (
        contour is not None
        and contour_distance is not None
        and contour_distance > max(radius * 0.85, 140.0)
    ):
        geocoder_contour = _local_polygon_from_geocode(
            geocode_polygon, center_lat, center_lon
        )
        if geocoder_contour is not None:
            contour = geocoder_contour
            contour_label = "Контур по геокодеру"
            warnings.append(
                "OSM-контур слишком далеко от адресного центра. Использован контур геокодера"
            )

    if contour is None:
        contour = _local_polygon_from_geocode(geocode_polygon, center_lat, center_lon)
        contour_label = "Контур по геокодеру"
    if contour is None:
        contour = _fallback_contour(radius)
        contour_label = "Контур (резервный)"
        fallback_used = True
        warnings.append("Контур здания не найден, использован резервный прямоугольник")

    road = _nearest_road_access(elements, center_lat, center_lon)
    if road is None:
        road = _fallback_road_from_contour(contour)
        warnings.append("Подъездная дорога не найдена, построена резервная линия")

    nearby_buildings = _collect_nearby_building_contours(
        elements,
        center_lat,
        center_lon,
        radius,
        contour,
        limit=MAX_SITE_BUILDING_CONTOURS,
    )
    nearby_roads = _collect_nearby_road_lines(
        elements,
        center_lat,
        center_lon,
        radius,
        limit=MAX_SITE_ROAD_LINES,
    )

    hydrants = _collect_node_points(
        elements,
        center_lat,
        center_lon,
        predicate=lambda tags: tags.get("emergency") == "fire_hydrant",
        limit=MAX_SITE_HYDRANTS,
    )
    water_sources = _collect_node_points(
        elements,
        center_lat,
        center_lon,
        predicate=lambda tags: tags.get("natural") == "water"
        or bool(tags.get("waterway"))
        or tags.get("man_made") in {"water_well", "water_tower"},
        limit=MAX_SITE_WATER_SOURCES,
    )
    exits = _collect_node_points(
        elements,
        center_lat,
        center_lon,
        predicate=lambda tags: bool(tags.get("entrance"))
        or tags.get("highway") == "emergency_access_point"
        or bool(tags.get("exit"))
        or bool(tags.get("addr:exit")),
        limit=4,
    )

    if len(hydrants) == 0:
        warnings.append("Гидранты рядом не найдены в OSM")
    if len(water_sources) == 0:
        warnings.append("Водоисточники рядом не найдены в OSM")

    site_entities = _build_site_entities(
        contour,
        road,
        hydrants,
        water_sources,
        nearby_buildings,
        nearby_roads,
    )
    if contour_label and len(site_entities) > 0:
        site_entities[0]["label"] = contour_label

    floor_objects = _seed_floor_objects(contour, exits, hydrants, water_sources)

    return AddressSceneBuildResult(
        center_lat=center_lat,
        center_lon=center_lon,
        site_entities=site_entities,
        floor_objects=floor_objects,
        geocode_provider=geocode_provider,
        overpass_provider=overpass_provider,
        resolution_mode=resolution_mode,
        warnings=warnings,
        fallback_used=fallback_used,
    )
