# LAN Demo Deployment (4 PCs)

Документ для быстрого и предсказуемого разворачивания симулятора в локальной сети перед защитой/показом.

## 1. Что важно заранее

- Backend host: один ПК в сети, доступный по IP (пример: `192.168.1.10`).
- 4 клиентских ПК открывают frontend по этому IP.
- Голосовая рация (микрофон) в браузерах работает только в secure context:
  - `https://...` (рекомендуется для LAN-демо), или
  - `http://localhost` (только на той же машине).

Итог: по `http://<LAN-IP>` realtime/карта/команды работают, но микрофон может быть заблокирован браузером.

## 2. Backend (FastAPI)

Каталог: `hackaton web/sql`

```bash
cp .env.example .env
```

Минимум настроек в `.env`:

```env
SECRET_KEY=<long-random-secret>
DATABASE_URL=postgresql+psycopg://app:app@localhost:5432/mchs
ALLOWED_ORIGINS=http://192.168.1.10:5173,http://192.168.1.11:5173,http://192.168.1.12:5173,http://192.168.1.13:5173
```

Запуск:

```bash
python3.11 -m venv .venv-local
source .venv-local/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## 3. Frontend (Vite)

Каталог: `angelina_ux/mchs-simulator`

```bash
cp .env.example .env
```

Вариант A (быстро, но без гарантии микрофона на LAN):

```env
VITE_API_URL=http://192.168.1.10:8000/api
VITE_WS_URL=ws://192.168.1.10:8000/api/ws
```

Запуск:

```bash
npm install
npm run dev -- --host 0.0.0.0 --port 5173
```

## 4. Роли и demo-учетки

На backend выполнить:

```bash
python3 -m app.demo_access_seed
```

Скрипт создаст/обновит и привяжет к общей сессии `DEMO 4PC`:

- `demo_training_lead` / `DemoTl#2026`
- `demo_dispatcher` / `DemoDisp#2026`
- `demo_rtp` / `DemoRtp#2026`
- `demo_hq` / `DemoHq#2026`
- `demo_bu1` / `DemoBu1#2026`
- `demo_bu2` / `DemoBu2#2026`

## 5. Раскладка по 4 ПК

- ПК1: `ADMIN` + `demo_dispatcher` (в разных профилях браузера)
- ПК2: `demo_training_lead`
- ПК3: `demo_rtp` + `demo_hq`
- ПК4: `demo_bu1` + `demo_bu2`

## 6. HTTPS/WSS для рабочей голосовой рации

Если нужна гарантированная демонстрация микрофона между ПК, заверни frontend и backend за HTTPS reverse proxy.

Минимальная целевая схема:

- `https://sim.local` -> frontend
- `https://sim.local/api/*` -> backend
- `wss://sim.local/api/ws` -> backend websocket

После этого в frontend `.env`:

```env
VITE_API_URL=https://sim.local/api
VITE_WS_URL=wss://sim.local/api/ws
```

## 7. Чек-лист перед защитой

- `npm run lint` и `npm run build` проходят.
- Backend стартует без ошибок, `/health` -> `ok`.
- Все demo-аккаунты логинятся.
- Роли видят корректные панели.
- В `BU` можно принять машину, поставить на позицию, потом поставить рукав.
- Для голоса в LAN используется HTTPS/WSS.
