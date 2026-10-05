# Code comments guide (ReeferON / VISTA)

Use **simple English** so new developers understand **why** and **how**, not only **what**.

## Coverage (done)

| Area | What was commented |
|------|--------------------|
| **Backend** | `server.js`, `config/`, `middleware/`, all `controllers/`, all `routes/`, all `utils/`, `validators/`, `database/` scripts, `scripts/` |
| **Frontend** | All `src/` `.js` / `.jsx` (~53 files): `App.jsx`, `services/api.js`, pages, components, utils |
| **Mobile** | All app JS (~52 files): `App.js`, screens, components, utils, services, database, shims, config |

Large screens (e.g. `SuperAdminSecureWindow.jsx`, `DashboardScreen.js`) use **file overview + major sections**, not a comment on every JSX line.

## When to comment (new code)

| Do comment | Skip |
|------------|------|
| Every **exported function** (1–3 lines above it) | Obvious one-liners (`const x = 1`) |
| **Business rules** (formulas, permissions, filters) | Restating the code line-by-line |
| **Non-obvious** workarounds (Expo Go, browser Back, merge logic) | Every variable name |
| **API endpoints** (query params, response shape) | Generated / lock files |

## Comment style

```javascript
/**
 * WHAT: Short name of what this does.
 * WHY: Business reason (optional but preferred).
 * HOW: One sentence on the approach (if not obvious).
 */
function example() { ... }
```

Inside a long function (JavaScript only), use section headers:

```javascript
// --- Step 1: Load inward totals from DB ---
```

**Never use `//` comments inside JSX children** (between `<div>`, `<>`, etc.) — React shows them as text on the page. Use this instead:

```jsx
{/* --- Menu: Dashboard --- */}
```

## Main flows (quick map)

| Feature | Backend | Frontend / Mobile |
|---------|---------|-------------------|
| Daily Box Tracker + day history | `dashboardController.js` → `getClientMonthBoxSheet` | `SuperAdminSecureWindow.jsx` |
| Hide SA edit time from Customer | `utils/stripCustomerEditAudit.js` | used in chamber/inward/outward controllers |
| Photo preview zoom | — | `SuperAdminSecureWindow.jsx` lightbox |
| Mobile report In/Out from readings | — | `mobile/src/utils/buildReportReadingRows.js` |
| Role → screen | — | `mobile/App.js` |

When you add a new feature, add the same style of comments before opening a PR.
