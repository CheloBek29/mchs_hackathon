# Sprint Plan: Main + Sim Integration (Detailed)

Дата: 2026-03-01  
Контекст: интеграция `mchs-simulator-submission-main` (база) + `sim-mchs-simulator-submission` (донор физики/визуализации)

## 1. Текущее состояние (факт)

Уже выполнено:
1. `Stage 0` (manifest + инварианты merge): `docs/MERGE_MANIFEST_SIM_INTEGRATION.md`.
2. `Stage 1` (контракт `fire_runtime` v2):
   - backend: schema version + runtime health + Q/forecast + environment + minutes until empty;
   - frontend: типы `fire_runtime`, typed extraction, обновление DTO, парсинг в `SimulationBoard`.

Выполненные изменения Stage 1:
1. `backend/app/ws.py`
2. `backend/app/schemas.py`
3. `frontend/src/shared/api/fireRuntimeTypes.ts`
4. `frontend/src/shared/api/types.ts`
5. `frontend/src/widgets/SimulationBoard/SimulationBoard.tsx`

Остается сделать (крупные блоки):
1. Backend selective merge физического ядра из `sim` без потери radio/splitter фич `main`.
2. Frontend импорт и интеграция 2.5D/3D/Retro визуализации в board-shell `main`.
3. Role UI merge (RTP/BU/Staff/TrainingLead) с сохранением текущих action-flow.
4. Полный regression gate по runtime, splitter, radio, completion-report.

## 2. Целевая архитектура (TO-BE)

```text
[WS Command Layer]
  -> [Session Runtime Loop (authoritative, backend)]
      -> Physics Kernel (fire/smoke/water/nozzle/hydraulics factors)
      -> Lifecycle FSM (DRAFT/RUNNING/PAUSED/COMPLETED)
      -> Runtime Health + Schema versioning
      -> Snapshot writer
  -> snapshot_data:
      - fire_runtime(v2+)
      - training_lesson
      - training_lead_scene
  -> [Frontend Snapshot Adapter]
      -> Tactical/2.5D/3D/Retro render payload
      -> HUD metrics (Q_required/Q_effective/forecast/lag)
  -> [Role Workspaces]
      -> existing command flows (main)
      -> enhanced visualization modes (sim)
```

Ключевые архитектурные правила:
1. Источник истины для физики и состояния сессии только backend.
2. Frontend не считает физику, только рендерит snapshot и отправляет команды.
3. `main` остается приоритетом по splitter/radio/admin/completion.
4. Новые поля должны быть backward-compatible для существующих клиентов.
5. Любой merge в `ws.py` только блочный (ручной cherry-pick), не file replace.

## 3. План по этапам (дальше)

### Stage 2. Backend Physics Consolidation (Selective)

Цель:
1. Подключить внешний `physics_config.py`.
2. Перенести weather/fire/smoke/nozzle коэффициенты в конфиг.
3. Добавить lifecycle `pause_lesson`/`resume_lesson` из `sim`.
4. Сохранить весь контур `main` для radio/LLM/splitter.

Файлы:
1. `backend/app/physics_config.py` (`IMPORT_NEW`).
2. `backend/app/ws.py` (`CHERRY_PICK_PARTIAL`):
   - import `physics_config` и подмена magic constants;
   - normalize lifecycle статус + команды pause/resume;
   - runtime tick guard по lifecycle;
   - сохранить `main`-логику гидравлики и radio hooks.
3. `backend/app/main.py` (`CHERRY_PICK_PARTIAL`):
   - обеспечить совместимость API/сериализации с pause/resume/lifecycle_status.
4. `backend/app/schemas.py` (`CHERRY_PICK_PARTIAL`):
   - при необходимости дополнить response models lifecycle-полями.

Критерии приемки:
1. Команды `start -> pause -> resume -> finish` отрабатывают корректно.
2. Runtime loop не тикает в paused состоянии.
3. Поля `fire_runtime` v2 стабильно присутствуют на каждом тике.
4. Радио и LLM endpoints работают без регресса.
5. Splitter цепочки работают без изменения поведения.

Риски:
1. Конфликт lifecycle-логики `sim` с текущим flow `main`.
2. Частичный перенос `ws.py` может затронуть права/доступы команд.

Снижение риска:
1. Переносить только локальные функции и command handlers.
2. После каждого блока прогонять smoke тест на WS-команды.

---

### Stage 3. Frontend Visualization Modules Import

Цель:
1. Импортировать новые рендер-модули из `sim` без затрагивания текущих страниц/ролей.

Файлы (`IMPORT_NEW`):
1. `frontend/src/lib/bundleToRenderSnapshot.ts`
2. `frontend/src/lib/retroBundleToSnapshot.ts`
3. `frontend/src/lib/renderer-three/**`
4. `frontend/src/lib/renderer-retro/**`
5. `frontend/src/shared/visualization/PhysicsIsometricView.tsx`
6. `frontend/src/shared/visualization/SimViewPanel.tsx`
7. `frontend/src/shared/visualization/ThreeSimView.tsx`
8. `frontend/src/shared/visualization/RetroSimView.tsx`
9. `frontend/src/store/useSimulationCameraStore.ts`
10. `frontend/src/widgets/FireMetricsHUD/FireMetricsHUD.tsx`
11. `frontend/src/widgets/FireTimelineChart/FireTimelineChart.tsx`

Критерии приемки:
1. `npm run build` проходит без type/runtime ошибок.
2. Ничего в текущем UI не ломается до встраивания в board.
3. Новые модули доступны для подключения в `SimulationBoard`.

Риски:
1. Несовместимые импорты/типы между `main` и `sim`.
2. Лишние demo-артефакты из `sim` могут засорить prod-build.

Снижение риска:
1. Импортировать только whitelist модулей, зафиксированный в manifest.
2. Исключить demo-only коды из production import chain.

---

### Stage 4. Frontend Board/Role Integration (Manual)

Цель:
1. Встроить режимы `SIM_25D`, `SIM_3D`, `RETRO` в основной board.
2. Добавить HUD и графики без слома текущего role-action поведения.

Файлы (`CHERRY_PICK_PARTIAL`):
1. `frontend/src/widgets/SimulationBoard/SimulationBoard.tsx`
2. `frontend/src/features/RoleControls/RtpSidebar.tsx`
3. `frontend/src/features/RoleControls/BuSidebar.tsx`
4. `frontend/src/features/RoleControls/StaffSidebar.tsx`
5. `frontend/src/features/TrainingLeadControls/TrainingLeadWorkspace.tsx`
6. `frontend/src/shared/api/types.ts` (точечные дополнения)

Сохраняем без замены (`KEEP_MAIN`):
1. `frontend/src/features/Radio/ui/RadioConsole.tsx`
2. `frontend/src/features/TrainingLeadControls/TrainingCompletionReport.tsx`
3. `frontend/src/store/useTacticalStore.ts`
4. `frontend/src/features/DispatcherControls/DispatcherSidebar.tsx`

Критерии приемки:
1. Tactical view работает как раньше.
2. Новые сим-режимы переключаются без падений.
3. Камера (`1/2/3/F`, pan/zoom/orbit) работает во fullscreen.
4. HUD отображает runtime метрики (Q/forecast/lag/water) по ролям.
5. Radio UI/flow не изменен.

---

### Stage 5. End-to-End Regression and Hardening

Цель:
1. Закрыть функциональные риски и зафиксировать стабильность перед финалом.

Статус на 2026-03-01:
1. `DONE` (детали: `docs/STAGE5_REGRESSION_REPORT_2026-03-01.md`).

Пакет проверок backend:
1. WS команды: `update_scene`, `update_weather`, `start`, `pause`, `resume`, `finish`.
2. Гидравлика: машина -> рукав -> splitter -> рукав -> ствол.
3. Радио: push/interference/playback/log.
4. LLM/evaluate endpoint доступен.
5. Snapshot содержит `fire_runtime.schema_version`.

Пакет проверок frontend:
1. Board режимы: Tactical/2.5D/3D/Retro.
2. Роли: TrainingLead/RTP/BU/Staff/Dispatcher.
3. Completion report формируется как в `main`.
4. Fallback поведения при ошибке рендера.

Нефункциональные проверки:
1. Build backend/frontend.
2. Минимальный runtime soak тест (>= 15 минут тиков без drift/утечек; допускается emulated tick-load для быстрой регрессии).
3. Проверка reconnect WS в состоянии `RUNNING` и `PAUSED`.

Выходной артефакт:
1. Краткий regression report с pass/fail и списком блокеров.

## 4. Подробный execution order (операционный)

1. Внести `physics_config.py` + точечный импорт в `ws.py`.
2. Привязать lifecycle handler (`pause_lesson`/`resume_lesson`) в `ws.py`.
3. Сверить команды/права/role guards.
4. Прогнать backend smoke.
5. Импортировать whitelist frontend модулей визуализации.
6. Прогнать frontend build.
7. Встроить `SimulationBoard` bridge на новые renderer-view.
8. Домерджить role sidebars/workspace.
9. Прогнать e2e regression набор.
10. Зафиксировать результаты в `docs` и подготовить финальный merge.

## 5. Декомпозиция задач по приоритету

P0 (блокирующие):
1. Backend lifecycle pause/resume.
2. Сохранение radio/splitter/completion flow.
3. Frontend board integration без runtime crash.

P1 (высокий):
1. Three/Retro режимы + камера.
2. HUD + timeline график.
3. Runtime health и forecast в UI для ролей.

P2 (после стабилизации):
1. Оптимизация производительности (LOD/culling/quality profile).
2. Визуальные улучшения retro материалов и water jets.

## 6. Контроль качества merge (checklist)

Перед каждым merge-блоком:
1. Проверить, что не перезаписываются `KEEP_MAIN` файлы.
2. Проверить, что нет удаления `HOSE_SPLITTER` из типов и UI.
3. Проверить, что радио endpoint-ы и модели присутствуют.

После каждого merge-блока:
1. `python3 -m py_compile backend/app/ws.py backend/app/schemas.py backend/app/main.py`
2. `cd frontend && npm run build`
3. Смоук-сценарий WS + UI.

## 7. Definition of Done (финал интеграции)

Интеграция считается завершенной, если:
1. Выполнены Stage 2-5 без регресса инвариантов manifest.
2. Все роли могут вести тренировку в Tactical и новых sim-режимах.
3. Метрики физики/воды/прогноза синхронны между backend и frontend.
4. Радио-контур и completion отчет работают как в `main`.
5. Есть финальный regression report и обновленные `docs`.
