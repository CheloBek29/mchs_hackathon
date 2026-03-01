# MCHS Sprint 1 - PostgreSQL schema + web CRUD

## Что внутри

- `schema.sql` - чистый PostgreSQL DDL
- `app/` - FastAPI + SQLAlchemy
- `/admin` - готовый web CRUD через SQLAdmin
- `/api/...` - REST CRUD для таблиц сессий, пользователей, техники и состояния обстановки

## Быстрый старт (без Docker)

```bash
# 1) backend dependencies
cp .env.example .env
python3.11 -m venv .venv-local
source .venv-local/bin/activate
pip install -r requirements.txt
# optional: test dependencies
python -m pip install -r requirements-dev.txt

# 2) локальная PostgreSQL (выполняется один раз)
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
createuser app || true
psql -d postgres -c "ALTER USER app WITH PASSWORD 'app';"
createdb -O app mchs || true
psql postgresql://app:app@localhost:5432/mchs -f schema.sql

# 3) запуск backend
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

После запуска:

- API: `http://localhost:8000`
- Swagger: `http://localhost:8000/docs`
- Web CRUD: `http://localhost:8000/admin`

`DATABASE_URL` и `ALLOWED_ORIGINS` настраиваются через `.env`.
Для адресной генерации можно переопределить список Overpass endpoint-ов через `OVERPASS_URLS` (CSV HTTPS URL-ов).

## Тесты

```bash
# unit tests
.venv-local/bin/python -m pytest tests/unit -q

# integration tests (PostgreSQL)
export TEST_DATABASE_URL=postgresql+psycopg://app:app@localhost:5432/mchs
.venv-local/bin/python -m pytest tests/integration -q

# full regression
.venv-local/bin/python -m pytest -q
```

## Демонстрация по локальной сети + защита

Минимальный безопасный набор для показа на нескольких ПК:

1. Используй сильный `SECRET_KEY` в `.env`.
2. Ограничь CORS только нужными адресами в `ALLOWED_ORIGINS` (без `*`, без лишних IP).
3. Если нужен голос в рации между ПК, поднимай frontend/backend за HTTPS/WSS (secure context для микрофона обязателен).
4. Раздавай доступы через demo-seed, а не через ручные регистрации.

Пример `ALLOWED_ORIGINS` для 4 рабочих мест:

```env
ALLOWED_ORIGINS=http://192.168.1.10:5173,http://192.168.1.11:5173,http://192.168.1.12:5173,http://192.168.1.13:5173
```

Если переходишь на HTTPS, укажи HTTPS-origin'ы и `wss://` endpoint для WS на фронте.

Подробный сценарий развертывания на 4 ПК: `angelina_ux/DEPLOY_LAN_DEMO.md`.

## REST endpoints

### Учебные сессии

- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/{id}`
- `GET /api/sessions/{id}/state` (агрегированное состояние: snapshot + погода + огонь + расстановка)
- `PATCH /api/sessions/{id}`
- `DELETE /api/sessions/{id}`

### Авторизация

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `POST /api/auth/logout-all`
- `GET /api/auth/sessions`
- `POST /api/auth/revoke`
- `PATCH /api/auth/session` (смена текущей симуляционной сессии пользователя)
- `GET /api/auth/me`

### Realtime (WebSocket)

- `WS /api/ws`
- Первый кадр обязателен: `{"type":"auth","accessToken":"<jwt>","sessionId":"<uuid|null>"}`.
- Подписка на сессию: `{"type":"subscribe_session","sessionId":"<uuid>"}`.
- Команда: `{"type":"command","commandId":"<uuid>","command":"<name>","sessionId":"<uuid>","payload":{...}}`.
- Поддерживаемые команды:
  - `update_weather`
  - `create_fire_object`
  - `create_resource_deployment`
  - `update_snapshot`
  - `set_scene_address`
  - `upsert_scene_floor`
  - `set_active_scene_floor`
  - `upsert_scene_object`
  - `remove_scene_object`
  - `sync_scene_to_fire_objects`
  - `save_scene_checkpoint`
  - `start_lesson`
  - `pause_lesson`
  - `resume_lesson`
  - `finish_lesson`
- Повтор `commandId` обрабатывается идемпотентно (`status: duplicate`).

### Пользователи

- `GET /api/users`
- `GET /api/roles`
- `PATCH /api/users/{id}/roles`
- `PATCH /api/users/{id}`
- `DELETE /api/users/{id}`

### Системные настройки

- `GET /api/system-settings` (только ADMIN)
- `PATCH /api/system-settings` (только ADMIN)

### Админ-инвариант

- `GET /api/admin/lock` (только ADMIN)
- `POST /api/admin/transfer` (только текущий ADMIN)

### Справочник техники

- `GET /api/vehicles`
- `POST /api/vehicles`
- `GET /api/vehicles/{id}`
- `PATCH /api/vehicles/{id}`
- `DELETE /api/vehicles/{id}`

### Снимки состояния сессии

- `GET /api/state-snapshots`
- `POST /api/state-snapshots`
- `GET /api/state-snapshots/{id}`
- `PATCH /api/state-snapshots/{id}`
- `DELETE /api/state-snapshots/{id}`

### Погодные срезы

- `GET /api/weather-snapshots`
- `POST /api/weather-snapshots`
- `GET /api/weather-snapshots/{id}`
- `PATCH /api/weather-snapshots/{id}`
- `DELETE /api/weather-snapshots/{id}`

### Объекты пожара/дыма

- `GET /api/fire-objects`
- `POST /api/fire-objects`
- `GET /api/fire-objects/{id}`
- `PATCH /api/fire-objects/{id}`
- `DELETE /api/fire-objects/{id}`

### Расстановка сил и средств

- `GET /api/resource-deployments`
- `POST /api/resource-deployments`
- `GET /api/resource-deployments/{id}`
- `PATCH /api/resource-deployments/{id}`
- `DELETE /api/resource-deployments/{id}`

### Радиожурнал

- `GET /api/radio/transmissions` (query: `session_id`, `limit`, `include_audio`)

В `/admin` добавлен раздел `Радиожурнал (аудио + расшифровка)`:

- хранит все chunk-сообщения рации
- показывает канал, отправителя, `transmission_id`, длительность, base64-аудио и текст расшифровки

Опциональная авто-расшифровка (server-side) включается через переменную:

- `RADIO_TRANSCRIBE_CMD` — shell-команда с шаблоном `{file}` (путь к временному аудиофайлу)
- в репозитории есть готовый скрипт `scripts/transcribe.py` (сначала пробует `faster-whisper`, затем fallback на `whisper` CLI)
- если `RADIO_TRANSCRIBE_CMD` не задан, backend автоматически использует `scripts/transcribe.py` (если файл существует)

Пример:

```env
RADIO_TRANSCRIBE_CMD=python3 scripts/transcribe.py {file}
RADIO_TRANSCRIBE_TIMEOUT_SEC=8
RADIO_STT_MODEL=tiny
RADIO_STT_LANGUAGE=ru
RADIO_CHANNEL_HOLD_TIMEOUT_SEC=0.9
RADIO_LOG_LIMIT=320
RADIO_LOG_AUDIO_WINDOW=48
RADIO_AUDIO_TRANSCODE_ENABLED=1
RADIO_AUDIO_TRANSCODE_FFMPEG_BIN=/opt/homebrew/bin/ffmpeg
RADIO_AUDIO_TRANSCODE_TIMEOUT_SEC=4
RADIO_AUDIO_TRANSCODE_TARGET_MIME=audio/wav
```

Минимальная установка для встроенного скрипта:

```bash
pip install faster-whisper
```

Также нужен `ffmpeg` в системе (например, `brew install ffmpeg` на macOS).

По умолчанию backend транскодирует входящие `webm/ogg` радиофрагменты в `audio/wav` для кросс-браузерного воспроизведения (Safari/Chrome/Firefox).

### Оценка урока через LLM (LM Studio / OpenAI-compatible)

- `GET /api/lessons/evaluate?session_id=...` — получить последнюю сохраненную оценку
- `POST /api/lessons/evaluate` — пересчитать оценку по расшифровкам радио, журналу диспетчера и deployments

Пример `POST /api/lessons/evaluate`:

```json
{
  "session_id": "<uuid>",
  "model": "<имя_модели_из_LM_Studio>",
  "max_radio_transmissions": 80,
  "max_journal_entries": 120
}
```

Переменные окружения:

```env
LLM_EVAL_BASE_URL=http://127.0.0.1:1234/v1
LLM_EVAL_API_KEY=lm-studio
LLM_EVAL_MODEL=
LLM_EVAL_TIMEOUT_SEC=45
LLM_EVAL_MAX_TOKENS=1200
```

Если `LLM_EVAL_MODEL` не задан, передай `model` в `POST /api/lessons/evaluate`.

## Пример payload для `simulation_sessions`

```json
{
  "status": "CREATED",
  "scenario_name": "Пожар на складе ГСМ",
  "map_image_url": "/uploads/maps/warehouse.png",
  "map_scale": 0.5,
  "weather": {
    "wind_speed": 5,
    "wind_dir": 90,
    "temp": 20
  },
  "time_multiplier": 1.0
}
```

## Пример payload для `auth/register`

```json
{
  "username": "dispatcher_01",
  "email": "dispatcher@example.com",
  "password": "StrongPassw0rd!",
  "requested_role": "DISPATCHER"
}
```

`ADMIN` нельзя создать через публичный `/api/auth/register`.

`/api/auth/login` возвращает `access_token`, `refresh_token`, `token_type`, `session_id`.
Для device fingerprint можно передать заголовок `X-Device-Id`.

## Пример payload для `auth/refresh`

```json
{
  "refresh_token": "<jwt>"
}
```

## Пример payload для `auth/revoke`

```json
{
  "session_id": "00000000-0000-0000-0000-000000000000"
}
```

## Пример payload для `admin/transfer`

```json
{
  "new_admin_user_id": "00000000-0000-0000-0000-000000000000"
}
```

## Bootstrap первого admin

```bash
python -m app.bootstrap_admin \
  --username admin \
  --email admin@example.com \
  --password "StrongPassw0rd!"
```

## Demo-доступы для 4 ПК (6 ролей без ADMIN)

```bash
python3 -m app.demo_access_seed
```

Команда создаст (или обновит) demo-аккаунты и привяжет их к общей сессии `DEMO 4PC`:

- `demo_training_lead` / `DemoTl#2026` - `TRAINING_LEAD`
- `demo_dispatcher` / `DemoDisp#2026` - `DISPATCHER`
- `demo_rtp` / `DemoRtp#2026` - `RTP`
- `demo_hq` / `DemoHq#2026` - `HQ`
- `demo_bu1` / `DemoBu1#2026` - `COMBAT_AREA_1`
- `demo_bu2` / `DemoBu2#2026` - `COMBAT_AREA_2`

Скрипт также сбрасывает lockout/failed attempts, чтобы аккаунты были готовы к демонстрации сразу после запуска.

## Пример payload для `vehicles_dictionary`

```json
{
  "type": "AC",
  "name": "АЦ-3,2-40/4(43253)",
  "water_capacity": 3200,
  "foam_capacity": 200,
  "crew_size": 6,
  "hose_length": 120
}
```

## Пример payload для `state-snapshots`

```json
{
  "session_id": "00000000-0000-0000-0000-000000000000",
  "sim_time_seconds": 600,
  "time_of_day": "DAY",
  "water_supply_status": "OK",
  "is_current": true,
  "snapshot_data": {
    "source": "manual_update"
  },
  "notes": "Состояние на 10-й минуте"
}
```
