# Stage 5 Regression Report

Дата: 2026-03-01  
Контекст: интеграция `mchs-simulator-submission-main` + selective physics/visualization merge из `sim-mchs-simulator-submission`.

## 1. Итог

- Статус: `PASS`
- Backend regression: `48 passed` (после добавления новых сценариев: `50 passed`)
- Frontend build: `PASS` (`npm run build`)
- Критических блокеров Stage 5: нет

## 2. Проверки Backend

### 2.1 Unit

Команда:

```bash
.venv-local/bin/python -m pytest tests/unit -q
```

Результат:
- `39 passed`

### 2.2 Integration (PostgreSQL)

Команда:

```bash
TEST_DATABASE_URL=$DATABASE_URL .venv-local/bin/python -m pytest tests/integration -q
```

Результат до добавления новых сценариев:
- `8 passed`

### 2.3 Новый Stage 5 coverage

Добавленные тесты:
- `backend/tests/integration/test_ws_lifecycle.py`
- `backend/tests/integration/test_ws_resilience.py`

Покрытые сценарии:
- lifecycle command chain: `start -> pause -> resume -> finish`
- проверка `snapshot_data.fire_runtime.schema_version == "2.0"` после первого runtime-тиka
- reconnect WS в состояниях `RUNNING` и `PAUSED`
- emulated soak runtime: серия forced-тиков, проверка `runtime_health` и стабильности FSM

Команды и результат:

```bash
TEST_DATABASE_URL=$DATABASE_URL .venv-local/bin/python -m pytest tests/integration/test_ws_lifecycle.py -q
TEST_DATABASE_URL=$DATABASE_URL .venv-local/bin/python -m pytest tests/integration/test_ws_resilience.py -q
TEST_DATABASE_URL=$DATABASE_URL .venv-local/bin/python -m pytest -q
```

Итог:
- `50 passed`

## 3. Проверки Frontend

Команда:

```bash
cd frontend && npm run build
```

Результат:
- сборка успешна
- предупреждение о размере bundle (`>500 kB`) без функциональной ошибки

## 4. Нефункциональные проверки Stage 5

- Build backend/frontend: `PASS`
- Reconnect WS (`RUNNING`/`PAUSED`): `PASS` (автотест)
- Soak тест:
  - выполнен в emulated-режиме (forced runtime ticks через сдвиг `last_tick_at`)
  - покрывает устойчивость runtime/FSM без ожидания 15 минут wall-clock
  - статус: `PASS`

## 5. Риски/ограничения

1. Soak выполнен как emulated tick-load, а не непрерывный 15-минутный wall-clock прогон.
2. Имеются только warning-и зависимости (`passlib`/`FastAPI on_event` deprecation), на текущую функциональность не влияют.

## 6. Рекомендации после Stage 5

1. Добавить отдельный nightly wall-clock soak (15+ минут real-time) на CI/стенде.
2. Вынести test-зависимости в отдельный bootstrap pipeline (`requirements-dev.txt` уже добавлен).
