# MCHS Simulator Frontend

Frontend клиента симулятора МЧС (React + TypeScript + Vite).

## Что умеет

- ролевые рабочие места (`TRAINING_LEAD`, `DISPATCHER`, `RTP`, `HQ`, `BU1`, `BU2`, `ADMIN`)
- realtime синхронизация состояния через WebSocket `/api/ws`
- карта обстановки (очаги, дым, техника, рукавные линии, стволы, цепочки подачи воды)
- встроенная рация через отдельный сервер `radio 2` (WebSocket + WebRTC signaling)

## Быстрый старт

```bash
npm install
cp .env.example .env
npm run dev -- --host 0.0.0.0 --port 5173
```

По умолчанию фронт подключается к backend:

- `VITE_API_URL=http://localhost:8000/api`
- `VITE_WS_URL=ws://localhost:8000/api/ws`
- `VITE_RADIO_WS_URL=ws://localhost:8080/ws`

## Демо по локальной сети (4 ПК)

Для открытия интерфейса с других ПК запускай dev-server с `--host 0.0.0.0` и используй IP машины-хоста, например `http://192.168.1.10:5173`.

## Важный момент по рации (микрофон)

Рация использует WebRTC + `getUserMedia`. В браузерах микрофон работает только в secure context:

- `https://...` или
- `http://localhost` (локальный хост)

Если открыть UI по `http://<LAN-IP>`, текстовый realtime будет работать, но доступ к микрофону может быть заблокирован браузером.

Для живой демонстрации рации по сети используй HTTPS/WSS (например через reverse proxy с локальным сертификатом).

## Проверка качества

```bash
npm run lint
npm run build
```

## Дополнительные документы

- общий LAN деплой: `angelina_ux/DEPLOY_LAN_DEMO.md`
- план cleanup/rename перед сдачей: `angelina_ux/CODEBASE_CLEANUP_RENAME_PLAN.md`
