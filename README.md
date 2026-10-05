# ReeferON CRM & DO Temperature Monitor

**English:** Modern reefer logistics CRM with Super Admin (web), Sub Admin (mobile), Data Operator (mobile), and Customer (mobile).  
**Hinglish:** Reefer logistics CRM — Super Admin web pe, Sub Admin / DO / Customer mobile pe.

**Stack:** React (Vite) · Express.js · MySQL (`reeferon_crm_db`) · Expo React Native

---

## Read this first / Pehle yeh padho (mental model)

Keep this picture in mind — **code + product same story**:

```
Catalog masters          Operational masters              Daily work
warehouse_master    →    chambers                         DO morning/evening tasks
client_master       →    chamber_client_assignments  →    inward / outward / reports
                         (scoped by warehouse_name)       customer sees allowed scope only
```

**English**
1. **Catalog** = names + codes (WH- / CL-). Super Admin web or Sub Admin → Admin → Master.
2. **Assignments** = which clients sit in which chamber **for that warehouse**. This is what DO tasks use.
3. **DO** logs data (offline SQLite → sync). Changing chambers/clients usually needs **permission**.
4. **Sub Admin / Super Admin** approve/deny. Deny needs a **remark**. Push works even if the app is closed.
5. **Customer** never edits masters — only reads allowed warehouses/clients.

**Hinglish**
1. **Catalog** = warehouse + client list (codes ke saath).
2. **Assignments** = us warehouse ke chamber mein kaunse clients active — yahi DO ki daily list hai.
3. **DO** field pe log karta hai; master change pe allow maangta hai.
4. **Sub Admin / SA** approve/deny (deny pe remark). App band ho to bhi push.
5. **Customer** sirf apna data dekhta hai, master nahi badalta.

**Do not mix:** Master Data panel ≠ DO Master Setup.  
Catalog CRUD ≠ chamber–client assignments.

---

## Where to look in code / Code mein kahan dekho

| Topic | English | File |
|-------|---------|------|
| Login → which screen | Role routes to one mobile screen | `mobile/App.js` |
| DO field app | Tasks, inward/outward, offline | `mobile/src/screens/DashboardScreen.js` |
| Sub Admin | Overview, permissions, DO masters | `mobile/src/screens/SubAdminScreen.js` |
| Customer | Scoped logs / inventory | `mobile/src/screens/CustomerScreen.js` |
| Web Super Admin | Full control + Role & Permission | `frontend/src/pages/SuperAdminSecureWindow/` |
| Catalog APIs | Warehouses / clients | `backend/controllers/masterController.js` |
| Chambers / assignments | DO graph + inspections | `backend/controllers/chamberController.js` |
| Log codes | Name → WH-/CL- code | `backend/utils/masterResolver.js` |
| API errors | Safe client message + checkpoint log | `backend/utils/errorHandler.js` |
| Mobile errors | Network/session → Retry UI | `mobile/src/utils/userFacingError.js` |
| Push | Token refresh + dead cleanup | `mobile/src/services/expoPushRegistration.js`, `backend/utils/expoPush.js` |

Roles detail: [`docs/ROLES.md`](docs/ROLES.md)

Comment style for new code (simple English, why + how): [`docs/CODE_COMMENTS.md`](docs/CODE_COMMENTS.md)

---

## Features / Features kya hain

| Area | English | Hinglish |
|------|---------|----------|
| **Web Super Admin** | Dashboard, logs, Role & Permission, masters, audit | Dashboard, logs, permission approve/deny, masters, audit trail |
| **Mobile Sub Admin** | Full overview, DO profiles, chambers & clients, reports | DOs monitor, chambers/clients edit, inventory reports, permission bell |
| **Mobile DO** | Morning/evening chamber tasks, inward/outward, offline sync | Daily temp logs, inward/outward, offline queue + sync |
| **Mobile Customer** | Scoped warehouses/clients, logs & inventory | Sirf allowed WH/clients ka data |
| **Push** | Permission alerts (app closed supported) | App band ho tab bhi Sub Admin / DO ko permission notify |

---

## Roles (who does what) / Kaun kya karta hai

| Role | English | Hinglish |
|------|---------|----------|
| `super_admin` | Web control center; approve permissions; master catalog | Web se sab control; permission allow; warehouse/client master |
| `sub_admin` | Mobile mini-admin; approve permissions; edit DO masters | Mobile pe DOs + permissions + chambers/clients |
| `do_operator` | Field logging + master-setup *requests* | Field pe logs; chamber/client change pe allow maangta hai |
| `customer` | Read-scoped portal | Sirf apna scope dekhta hai |

More detail: [`docs/ROLES.md`](docs/ROLES.md)

---

## Masters usage / Masters kaise use karein

Masters ke **do layers** hain:

```
1) Catalog (codes + names)
   warehouse_master  → sites (WH-CODE)
   client_master     → companies (CL-CODE)

2) Operational (daily DO work)
   chambers + chamber_client_assignments
   → “is warehouse pe is chamber mein ye clients active”
```

| Step | English | Hinglish |
|------|---------|----------|
| 1 | Create warehouse + clients in **Master Data** (web or Sub Admin → Master) | Pehle warehouse + client catalog banao |
| 2 | Assign DO to a warehouse + `chamber_limit` | DO ko warehouse + chamber limit do |
| 3 | Sub Admin / DO Master Setup: chambers + assign clients | Chambers banao, clients assign karo |
| 4 | DO tasks / inward / outward use those assignments | Daily kaam usi list se chalta hai |

**Tip:** Chamber names are globally unique in DB — prefer names like `Bhopal Chamber 1` (not only `Chamber 1` across every warehouse).  
**Tip:** DB mein chamber name globally unique hai — har warehouse pe alag clear naam rakho.

---

## Working process / Kaam kaise chalta hai (end-to-end flow)

### Big picture / Poora flow ek nazar mein

```
┌─────────────┐     JWT login      ┌──────────────────┐
│  Mobile /   │ ─────────────────► │  Express API     │
│  Web app    │ ◄───────────────── │  :5000           │
└─────────────┘   JSON + photos    └────────┬─────────┘
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    ▼                       ▼                       ▼
              MySQL DB              Cloudinary (images)      Expo Push (alerts)
         reeferon_crm_db            temp / POD photos        Sub Admin + DO
```

**English — daily business flow**
1. Super Admin / Sub Admin set up **warehouse + clients** (catalog) and assign a **DO** to a warehouse.
2. Sub Admin (or DO after allow) sets **chambers + which clients** live in each chamber.
3. Every day the DO opens the app → sees Morning / Evening **tasks** from those assignments.
4. DO fills chamber temp / inward / outward (photos + GPS). If offline, data sits in **SQLite** until sync.
5. Sub Admin / Super Admin watch **Dashboard, Logs, Reports**. Customers only see their allowed WH/clients.
6. If DO needs to change a chamber/client setup → **permission request** → approve/deny → DO notified.

**Hinglish — daily business flow**
1. Pehle masters + DO warehouse setup.
2. Chambers ke andar clients assign.
3. DO daily tasks complete karta hai (offline bhi chal sakta hai).
4. Sync online aate hi server pe jaata hai.
5. Sub Admin / SA monitor; Customer sirf apna data.
6. Master change = pehle permission, phir apply.

### Login process / Login kaise hota hai

| Step | English | Hinglish |
|------|---------|----------|
| 1 | User enters email + password | Email/password |
| 2 | Backend checks role table (`super_admin` / `sub_admins` / `do_operators` / `customers`) | Role ke hisaab se table |
| 3 | Password checked with **bcrypt**; **JWT** returned | Hash match → token |
| 4 | Web → Super Admin window; Mobile → one screen by role | App role se screen kholta hai |

### Data write process / Data save kaise hoti hai

| Action | English | Hinglish |
|--------|---------|----------|
| Chamber temp / inward / outward | DO form → API (or SQLite first if offline) → MySQL + Cloudinary photo | Pehle local queue ho sakta hai, phir sync |
| Catalog master create | SA / Sub Admin → `/api/masters/*` | Direct (no DO permission) |
| Chamber / client assignment change by DO | Request → activity row Pending → Approve → apply | Allow ke baad apply |
| Reports / inventory | Read from logs + masters codes via `masterResolver` | Codes se filter / reconcile |

---

## Permissions — full flow / Permission poora flow

Permissions are **not a separate table**. They live in `do_operator_activities` as request / grant / deny / use rows.

### Who needs allow? / Kis ko allow chahiye?

| Change | DO needs allow? | Sub Admin / Super Admin |
|--------|-----------------|-------------------------|
| Open Master Setup screen | No | Can edit freely |
| Add / rename / delete chamber | Yes (usually) | Direct save |
| Add / rename / remove client on chamber | Yes (usually) | Direct save |
| Change chamber type (Frozen/Chilled/Dry) | Yes | Direct / approve |
| Edit/delete an existing daily log | Yes | SA can direct-edit on web |

### Step-by-step permission / Step by step

```
DO taps Save / Edit / Delete
        │
        ▼
POST /api/permission-requests
  → activity: REQUEST_EDIT or REQUEST_DELETE  (status Pending)
        │
        ├─► Expo push → all Sub Admins (app closed OK)
        │
        ▼
Sub Admin (mobile) or Super Admin (web)
  → Approve  → GRANT_*   (optional remark)
  → Deny     → DENY_*    (remark REQUIRED)
        │
        ├─► Expo push → that DO
        │
        ▼
DO app: bell / popup
  → Approved: apply change / open edit
  → Denied: show Admin remark clearly
```

### Activity actions (names in DB)

| Action | Meaning |
|--------|---------|
| `REQUEST_EDIT` / `REQUEST_DELETE` | DO asked |
| `GRANT_PERMISSION` / `GRANT_DELETE` | Approved |
| `DENY_PERMISSION` / `DENY_DELETE` | Denied |
| `USE_EDIT_PERMISSION` / `USE_DELETE_PERMISSION` | DO used the allow |
| Description often includes | `Admin remark: …` · `Decided by: Sub-Admin Name (email)` |

**English:** Audit trail shows **who** (name + email) approved/denied — Super Admin web Role & Permission + Activity.  
**Hinglish:** Web pe dikhta hai kaunse Sub Admin / SA ne decide kiya (naam + email).

### Push rules (important)

| Event | Who gets notify | Overdue tasks? |
|-------|-----------------|----------------|
| New permission request | Sub Admin | **No** overdue push |
| Approved / Denied | That DO | — |
| Token | Refresh on every app open; dead tokens cleared on server | — |

---

## Tech stack & libraries / Tech aur libraries — kya + kyun

### Architecture layers

| Layer | Tech | Why / Kyun |
|-------|------|------------|
| **Web UI** | React 18 + Vite | Fast Super Admin SPA; Vite = quick build/dev |
| **Mobile UI** | Expo + React Native | One codebase Android/iOS; Expo Go + EAS APK |
| **API** | Node.js + Express | Simple REST; same language as tooling |
| **DB** | MySQL (`mysql2` pool) | Relational logs, roles, masters; WAMP/local + cloud |
| **Auth** | JWT (`jsonwebtoken`) + bcryptjs | Stateless mobile/web login; hashed passwords |
| **Files** | Multer + Cloudinary | Photos off-server CDN; EXIF via `exifr` |
| **Offline (DO)** | expo-sqlite + AsyncStorage | Cold rooms / weak network — queue then sync |
| **Push** | expo-notifications + Expo Push HTTP API | Alerts when app closed; no full FCM SDK required |
| **Email** | Nodemailer (SMTP) / Resend optional | Login / alerts when configured |
| **Security** | helmet, cors, express-rate-limit, cookie-parser | Headers, origin control, login flood limit |

### Backend libraries (detail)

| Library | Role | Why |
|---------|------|-----|
| `express` | HTTP API | Standard Node web framework |
| `mysql2` | DB queries + pool | Fast MySQL; promises |
| `dotenv` | `.env` config | Secrets out of code |
| `bcryptjs` | Password hash | Safe storage; no plain passwords |
| `jsonwebtoken` | Session token | Mobile Bearer + web cookie/Bearer |
| `multer` | Multipart upload | Chamber/inward/outward photos |
| `cloudinary` | Image host | Reliable photo URLs in production |
| `exifr` | Read photo EXIF / GPS | Verify capture metadata |
| `nodemailer` | SMTP email | Local Gmail / any SMTP |
| `helmet` | Security headers | Harden HTTP |
| `cors` | Cross-origin | Web `:3000` → API `:5000` |
| `express-rate-limit` | Login throttle | Brute-force protection |
| `cookie-parser` | Cookies | Web HttpOnly session support |

### Frontend (web) libraries

| Library | Role | Why |
|---------|------|-----|
| `react` / `react-dom` | UI | Component Super Admin window |
| `vite` | Bundler | Faster than CRA for this app |
| `lucide-react` | Icons | Clean admin icons |
| `exifr` | Photo meta in browser | Align with mobile photo checks |

### Mobile libraries

| Library | Role | Why |
|---------|------|-----|
| `expo` | App platform | Build, permissions, OTA-friendly |
| `react-native` | Native UI | Real device camera/GPS/notifications |
| `expo-sqlite` | Local DB | Offline DO queue |
| `@react-native-async-storage/async-storage` | Key-value | Token, drafts, last API URL, caches |
| `@react-native-community/netinfo` | Online/offline | Banners + retry behaviour |
| `expo-notifications` | Local + remote push | Task reminders + permission alerts |
| `expo-image-picker` | Camera / gallery | Sensor & POD photos |
| `expo-image-manipulator` | Compress/resize | Smaller uploads |
| `expo-location` | GPS on capture | Prove where photo was taken |
| `expo-file-system` | Files on device | Download / share images |
| `expo-status-bar` | Status bar style | UI polish |

### Why this mix (short) / Ye combo kyun

**English:** Field DOs need **offline-first mobile**; managers need a **fast web console**; one **MySQL** source of truth; photos on **Cloudinary** so the API server stays light; **JWT** so mobile and web share the same API securely; **Expo Push** so permission decisions reach people even when the app is closed.

**Hinglish:** DO ko offline chahiye → SQLite. Boss ko web dashboard → React/Vite. Sab data ek DB → MySQL. Photos heavy hain → Cloudinary. Mobile + web same API → JWT. App band pe bhi alert → Expo Push.

---

## Installation & run / Install kaise karein

### Backend
```bash
cd backend
npm install
# Configure backend/.env (DB_*, JWT_SECRET, Cloudinary, email)
npm start
```
API: `http://localhost:5000`

### Frontend (Super Admin web)
```bash
cd frontend
npm install
npm run dev
```
Web: `http://localhost:3000`

### Mobile (Expo)
```bash
cd mobile
npm install
npm start
```
Then open on device / emulator. Login screen can point at production API or local LAN IP.

**DB import (optional clean schema):**
```bash
mysql -u root -p < backend/database/schema.sql
```
> Note: live schema also auto-migrates on server start via `backend/config/db.js`.

---

## Project structure / Folder structure

```
CRM/
├── backend/                 # Express API + MySQL
│   ├── controllers/
│   ├── routes/
│   ├── utils/               # errorHandler, masterResolver, expoPush, …
│   ├── logs/                # error.log + daily error files
│   └── server.js
├── frontend/                # Super Admin (Vite React)
├── mobile/                  # Expo app (DO / Sub Admin / Customer)
└── docs/                    # ROLES, BACKUP, …
```

---

## Error handling / Errors kaise handle hote hain

### Backend pattern (English)
Controllers catch errors with `handleControllerError` so clients get a **safe message**, while details go to:
- console (`[ERROR] …`)
- `backend/logs/error.log` (+ daily file)
- Super Admin activity as `[CHECKPOINT]` rows

### Backend pattern (Hinglish)
API fail hone pe user ko **seedha SQL/stack mat dikhao**.  
`handleControllerError` safe message bhejta hai, asal detail log + Super Admin checkpoint mein save hoti hai.

**Example — backend controller:**
```js
try {
  // … business logic …
} catch (err) {
  return handleControllerError(res, err, {
    checkpoint: 'createPermissionRequest',      // where it failed
    req,
    clientMessage: 'Failed to create permission request.' // user-safe
  });
}
```

**Example — what Super Admin may see in Activity:**
```text
[CHECKPOINT] | type=DatabaseError | status=500 | file=permissionController.js
| line=612 | checkpoint=createPermissionRequest | method=POST
| url=/api/permission-requests | msg=…
```

### Mobile pattern (English)
Use `formatUserError` + `InlineErrorState` (Retry) so network/session errors are actionable.

### Mobile pattern (Hinglish)
Raw `Network request failed` mat dikhao — `formatUserError` se clear message + Retry button.

**Example — mobile screen:**
```js
import { formatUserError } from '../utils/userFacingError';
import InlineErrorState from '../components/InlineErrorState';

try {
  await loadLogs();
} catch (err) {
  setLogsError(formatUserError(err, {
    apiUrl,
    context: 'Failed to load logs'
  }));
}

// UI
{logsError ? (
  <InlineErrorState message={logsError} onRetry={loadLogs} />
) : null}
```

**Example — what user sees:**

| Raw error | Shown message |
|-----------|----------------|
| `Network request failed` | `Cannot reach server (http://…). Check WiFi…` |
| `401 Unauthorized` | `Session expired. Logout and sign in again.` |
| Timeout | `Request timed out. Check connection and retry.` |

---

## How to resolve errors in future / Future mein error kaise solve karein

| Step | English | Hinglish |
|------|---------|----------|
| 1 | Note the screen + action that failed | Kaunsi screen / button pe fail hua |
| 2 | Check mobile Metro log / backend terminal | Red error / `[ERROR]` line dekho |
| 3 | Open `backend/logs/error.log` or SA **System / Activity** checkpoint | File + line + URL mil jayega |
| 4 | Fix code or config; retry with **Retry** / sync | Fix → app Retry / sync dubara |

**Common fixes / Common solutions:**

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Cannot reach server | Wrong API URL / Render sleep / Wi‑Fi | Login API URL check; backend `npm start` |
| Session expired | Bad/expired JWT | Logout → login; prod `JWT_SECRET` match |
| Permission denied / 403 | Role or pending allow | Approve request; check role |
| Duplicate chamber/client | Unique name/code | Use unique names (`Bhopal Chamber 1`) |
| Sync pending forever | Upload / Cloudinary / network | Check Cloudinary env; retry sync |
| Push not received | No token / notifications off | Re-login; allow notifications; dead tokens auto-clear |

---

## Other important examples / Aur important examples

### 1) Permission flow (DO → Sub Admin / Super Admin)
**English:** DO requests edit → Sub Admin/SA approves or denies (deny needs remark) → DO gets popup + push.  
**Hinglish:** DO allow maangta hai → Sub Admin/SA approve/deny (deny pe remark zaroori) → DO ko popup + push.

### 2) Push token refresh
**English:** On every app open/foreground, mobile registers Expo push token; dead tokens are cleared on server.  
**Hinglish:** App khulte hi token refresh; server dead token hata deta hai.

### 3) Offline DO logging
**English:** Logs save to SQLite when offline; sync engine uploads when online.  
**Hinglish:** Offline pe SQLite queue; online aate hi sync.

### 4) Inventory reports paging
**English:** First page 50 rows, then load +20.  
**Hinglish:** Pehle 50, phir +20 aur.

### 5) Local vs production API (mobile)
```js
// Production default (mobile/App.js)
PRODUCTION_API_URL = 'https://reeferon-crm-backend.onrender.com'

// Local dev uses LAN IP detected from Expo / fallback in App.js
```

---

## Environment checklist / `.env` checklist (backend)

Set at least:
- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `JWT_SECRET` (strong unique value in production)
- Email: SMTP or Resend
- `APP_LOGIN_URL` → live web URL in production (not `localhost`)

### Photos / Cloudinary (important deploy decision)

**English — today (dev):** Cloudinary is ON for easier photo CDN testing.  
**Hinglish — abhi:** Development mein Cloudinary use ho raha hai.

**At deployment (agreed):** We will **not** use Cloudinary on production. Switch to **local disk uploads** (Multer → `uploads/` served by Express).

```env
# Development (current)
UPLOAD_TO_CLOUDINARY=true
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...

# Production / deploy (planned — change at deploy time)
UPLOAD_TO_CLOUDINARY=false
# Cloudinary keys can be omitted when false
# Ensure uploads/ folder is writable and backed up on the server
```

Code already supports this flag in `backend/config/multer.js`:
- `true` → local + Cloudinary (DB stores Cloudinary URL)
- `false` → local disk only (DB stores local `/uploads/...` path)

**Deploy checklist item:** set `UPLOAD_TO_CLOUDINARY=false`, verify photos open in web + mobile, backup `uploads/` with DB.

**Never commit real secrets.** Keep production values on the host (e.g. Render env vars).

---

## Pre-deploy smoke test / Deploy se pehle quick test

1. Login all 4 roles  
2. Create warehouse + client master → assign to DO  
3. DO chamber morning log + inward (online + offline sync)  
4. Permission request → approve/deny with remark → DO popup  
5. Push with app closed (Sub Admin + DO)  
6. Photos appear (**local uploads** on deploy — not Cloudinary)  
7. Customer sees only allowed warehouse/clients  

Backup notes: [`docs/BACKUP.md`](docs/BACKUP.md)

---

## Scripts (backend)

```bash
cd backend
npm start                 # API server (frees port 5000 first)
npm run db:backup         # DB backup helper (see docs/BACKUP.md)
npm run logs:archive      # Archive error logs
```

---

## License / notes

Internal ReeferON CRM project. For role rules see `docs/ROLES.md`.
