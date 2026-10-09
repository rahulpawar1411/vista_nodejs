# VPS deploy (no Render / Vercel)

This project is meant to run on **one VPS**: Node API + static web (`frontend/dist`) + local `uploads/`.

## Layout on server

```
/var/www/vista/   (example)
  backend/
    .env
    server.js
    uploads/
    …
  frontend/
    dist/         ← from `npm run build`
```

Express serves `../frontend/dist` and `/uploads`.

## Backend `.env` (production)

```env
NODE_ENV=production
PORT=5000

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=…
DB_PASSWORD=…
DB_NAME=…

JWT_SECRET=long_random_secret
APP_LOGIN_URL=https://yourdomain.com
FRONTEND_URL=https://yourdomain.com
MOBILE_DEEP_LINK=reeferon://login

UPLOAD_TO_CLOUDINARY=false
UPLOADS_DIR=
```

## Frontend build

```bash
cd frontend
# .env: VITE_API_BASE_URL=/api   and   VITE_PREFER_CLOUDINARY=false
npm ci
npm run build
# upload frontend/dist to the server
```

## Start

```bash
cd backend
npm ci --omit=dev
pm2 start server.js --name reeferon-api
```

## Nginx (example)

- `/` → proxy to Node `:5000` (API + SPA + uploads), **or**
- `/` → `frontend/dist`, `/api` + `/uploads` → Node `:5000`

Use HTTPS (Certbot).

## Mobile

Set live API in `mobile/app.json` → `extra.apiUrl` and/or `EXPO_PUBLIC_API_URL`:

```text
https://api.yourdomain.com
```

(no `/api` suffix)
