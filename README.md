# MCHS Simulator - Submission Package

Этот каталог подготовлен для загрузки и оценки кода.

## Структура

- `frontend/` - клиентское приложение (React + TypeScript + Vite)
- `backend/` - сервер API/realtime (FastAPI + PostgreSQL)
- `docs/` - инструкции по демонстрации в локальной сети

Пакет является самостоятельной копией для сдачи. Изменения в исходных рабочих каталогах автоматически сюда не попадают.

## Зачем отдельный пакет

- убраны лишние рабочие артефакты и черновые материалы
- директории названы понятно для проверки (`frontend`, `backend`, `docs`)
- внутри оставлен только код и релевантная документация

## Быстрый старт

### 1) Backend

```bash
cd backend
cp .env.example .env
python3.11 -m venv .venv-local
source .venv-local/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### 2) Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev -- --host 0.0.0.0 --port 5173
```

## Demo-учетки (6 ролей, кроме ADMIN)

В backend выполнить:

```bash
python3 -m app.demo_access_seed
```

Скрипт создаст/обновит пользователей и привяжет их к сессии `DEMO 4PC`.

## LAN/рация

Подробная инструкция по разворачиванию на 4 ПК: `docs/DEPLOY_LAN_DEMO.md`.

Важно: для микрофона в браузере нужен secure context (`https/wss` или `localhost`).

Готовые файлы для HTTPS в пакете:

- `Caddyfile` (reverse proxy + TLS internal)
- `frontend/.env.https.example` (переменные `https/wss`)

## Следующий этап (модель огня)

Спецификация по физике пожара и настройке стволов: `docs/FIRE_PHYSICS_NOZZLE_SPEC.md`.
