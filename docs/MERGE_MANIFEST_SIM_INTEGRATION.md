# Merge Manifest: Main + Sim Integration

Дата фиксации: 2026-03-01  
База интеграции: `mchs-simulator-submission-main` (main)  
Донор улучшений: `mchs-simulator-submission-main/sim-mchs-simulator-submission` (sim)

## 1. Цель

Интегрировать улучшения симуляции физики, визуализации и метрик из `sim` в `main` без регресса существующего продуктового функционала `main`.

## 2. Non-Negotiable Invariants (нельзя ломать)

1. Сохраняется поддержка `HOSE_SPLITTER` в доменной модели, API и runtime-логике.
2. Сохраняется текущий радио-контур `main`:
   `push_radio_message`, `set_radio_interference`, хранение `RadioTransmission`,
   playback/PTT UI, server-side транскрипция и LLM-оценка урока.
3. Сохраняется админ-функциональность `main` (включая radio section в `/admin`).
4. Сохраняется `TrainingCompletionReport` и текущий flow завершения тренировки.
5. Слияние выполняется selective/cherry-pick, а не полной заменой `backend/app/*` и `frontend/src/*`.

## 3. Архитектурная стратегия merge

1. **Backend source-of-truth** остается `main`.
2. **Physics/runtime upgrade** переносится из `sim` в `main` в `ws.py` модульно:
   добавляем lifecycle (`pause/resume`), runtime health, нормативные метрики, weather factors, `physics_config.py`.
3. **Hydraulics/splitter/radio** остаются из `main` как базовый контур.
4. **Frontend board shell** остается `main`, в него встраиваются `PhysicsIsometricView`, `Three/Retro` режимы и HUD-виджеты.
5. Расширение контрактов делается backward-compatible: новые поля `fire_runtime` optional.

## 4. Файл-матрица: Frontend

### 4.1 Полный перенос из `sim` (новые модули)

1. `frontend/src/lib/bundleToRenderSnapshot.ts`
2. `frontend/src/lib/retroBundleToSnapshot.ts`
3. `frontend/src/lib/renderer-three/**`
4. `frontend/src/lib/renderer-retro/**`
5. `frontend/src/shared/visualization/PhysicsIsometricView.tsx`
6. `frontend/src/shared/visualization/SimViewPanel.tsx`
7. `frontend/src/shared/visualization/ThreeSimView.tsx`
8. `frontend/src/shared/visualization/RetroSimView.tsx`
9. `frontend/src/store/useSimulationCameraStore.ts`
10. `frontend/src/shared/api/fireRuntimeTypes.ts`
11. `frontend/src/widgets/FireMetricsHUD/FireMetricsHUD.tsx`
12. `frontend/src/widgets/FireTimelineChart/FireTimelineChart.tsx`

Решение: **IMPORT_NEW**.

### 4.2 Частичный merge (ручной)

1. `frontend/src/widgets/SimulationBoard/SimulationBoard.tsx`
2. `frontend/src/features/RoleControls/RtpSidebar.tsx`
3. `frontend/src/features/RoleControls/BuSidebar.tsx`
4. `frontend/src/features/RoleControls/StaffSidebar.tsx`
5. `frontend/src/features/TrainingLeadControls/TrainingLeadWorkspace.tsx`
6. `frontend/src/shared/api/types.ts`

Решение: **CHERRY_PICK_PARTIAL**.

Правило для этих файлов:

1. Добавляем 2.5D/3D/Retro интеграцию и HUD-метрики.
2. Не удаляем существующие в `main` поля и фичи управления (splitter, nozzle settings, completion flow).
3. Не сужаем типы `ResourceKind` и прочие enum/union из `main`.

### 4.3 Оставить `main` (не перезаписывать из `sim`)

1. `frontend/src/features/Radio/ui/RadioConsole.tsx`
2. `frontend/src/features/TrainingLeadControls/TrainingCompletionReport.tsx`
3. `frontend/src/store/useTacticalStore.ts`
4. `frontend/src/features/DispatcherControls/DispatcherSidebar.tsx` (косметическая разница, логика `main` приоритетна)

Решение: **KEEP_MAIN**.

## 5. Файл-матрица: Backend

### 5.1 Полный перенос из `sim`

1. `backend/app/physics_config.py`

Решение: **IMPORT_NEW**.

### 5.2 Частичный merge (ручной, высокий риск)

1. `backend/app/ws.py`
2. `backend/app/main.py`
3. `backend/app/schemas.py`
4. `backend/requirements.txt` (union-зависимостей)
5. `backend/.env.example` (только новые безопасные переменные)

Решение: **CHERRY_PICK_PARTIAL**.

Что переносим из `sim` в backend:

1. Нормализация lifecycle (`lifecycle_status`, `pause_lesson`, `resume_lesson`).
2. Расширенный `fire_runtime`:
   `schema_version`, `runtime_health`, `environment`,
   `fire_directions`, `q_required_l_s`, `q_effective_l_s`, `suppression_ratio`, `forecast`.
3. `minutes_until_empty` в `vehicle_runtime`.
4. Weather-aware growth/suppression факторы и вынесенные физ.константы из `physics_config.py`.
5. Генерация дыма для всех активных очагов, не только первого.

Что сохраняем из `main` и не удаляем:

1. `HOSE_SPLITTER`-цепочка и связанная гидравлика (line loss, pressure factors, branch logic).
2. Радио-трансмиссии, транскрипция, LLM evaluate endpoints и связанная сериализация.
3. Инициализация и env-переменные, связанные с радио/LLM.

### 5.3 Оставить `main` (не перезаписывать из `sim`)

1. `backend/app/models.py` (в `sim` отсутствует `RadioTransmission`).
2. `backend/app/enums.py` (в `sim` удален `HOSE_SPLITTER`).
3. `backend/app/admin.py` (в `sim` удален `RadioTransmissionAdmin`).

Решение: **KEEP_MAIN**.

## 6. Контракт merge-порядка (execution order)

1. Контракт типов `fire_runtime` и schema versioning.
2. Backend `physics_config.py` + selective merge `ws.py`.
3. Backend `main.py/schemas.py` совместимость новых полей и команд.
4. Frontend импорт новых visualization/renderer модулей.
5. Frontend selective merge `SimulationBoard` и role sidebars.
6. Проверка runtime + UI regression.

## 7. Regression Gates (обязательные проверки)

### 7.1 Backend

1. `start_lesson -> pause_lesson -> resume_lesson -> finish_lesson`.
2. `HOSE_SPLITTER` цепочка: машина -> рукав -> разветвление -> рукав -> ствол.
3. Радио: запись/воспроизведение, журнал, interference.
4. LLM endpoints (`/api/lessons/evaluate`) не пропадают.
5. `fire_runtime` содержит новые поля и не ломает старых клиентов.

### 7.2 Frontend

1. `TACTICAL` режим не сломан.
2. `SIM_25D` работает fullscreen, камера (`1/2/3/F`, pan/zoom/orbit).
3. `SIM_3D` и `RETRO` включаются как опциональные режимы (fallback при ошибке рендера).
4. HUD метрики отображаются для ролей без потери существующих action-flow.
5. Radio console поведение идентично `main`.

## 8. Known Conflict Hotspots

1. `ws.py`: в `sim` добавлены физические улучшения, но удален ряд функций `main` (радио/транскрипция/env helpers/splitter-detail).
2. `main.py`: в `sim` удалены LLM/radio API секции.
3. `types.ts`: в `sim` сужен `ResourceKind` (нет `HOSE_SPLITTER`).
4. `BuSidebar.tsx`: в `sim` убраны UI-потоки splitter/hose type.
5. `useTacticalStore.ts`: в `sim` убран `maxHoseLength`.

## 9. Команда merge-политики (для исполнения)

1. Никогда не делать `cp -R sim/... -> main/...` для `backend/app` и `frontend/src`.
2. Для конфликтных файлов использовать только ручной patch/cherry-pick блоками.
3. Каждую merged-подсистему проверять smoke-тестом до перехода к следующей.

## 10. Done-критерии Этапа 0

1. Зафиксирован файл-манifest с решениями по всем конфликтным файлам.
2. Зафиксированы архитектурные инварианты и merge-order.
3. Подготовлен baseline для Этапа 1 (контракты + schema versioning).

