// ====================================================================
// Offline SQLite Layer (mobile/src/database/db.js)
// --------------------------------------------------------------------
// Stores:
//   local_assignments  → chamber/client master cache + pending add/delete
//   local_inspections  → DO temperature logs waiting for upload
//   local_inward_logs  → inward forms waiting for upload
//   local_outward_logs → outward forms waiting for upload
//   client_lot_master  → suggestion names for Add Client UI
//
// RULES FOR DEVELOPERS:
//   1) Prefer ALTER TABLE ADD COLUMN for schema changes
//   2) NEVER DROP tables that may hold pending sync rows
//   3) saveInspectionLocally / addLocalAssignment write sync_status='pending'
//   4) markInspectionAsSynced / markAssignmentSynced clear the queue after API OK
// ====================================================================

import * as SQLite from 'expo-sqlite';

let db = null;
try {
  // Single on-device DB file (Expo SQLite sync API)
  db = SQLite.openDatabaseSync('reeferon_offline.db');
} catch (err) {
  console.error('❌ Error opening SQLite database:', err);
}

/**
 * Create tables if needed + additive migrations.
 * Safe to call on every app start.
 */
export const initDatabase = () => {
  if (!db) return;

  /** @returns {{ name: string }[]} */
  const tableColumns = (table) => {
    try {
      return db.getAllSync(`PRAGMA table_info(${table});`) || [];
    } catch (_) {
      return [];
    }
  };

  const hasColumn = (cols, name) => cols.some((c) => c.name === name);

  /**
   * Add a missing column without wiping data.
   * @param {string} table
   * @param {string} column - column name to check
   * @param {string} ddlFragment - e.g. "box_count INTEGER" (no "ADD COLUMN" prefix)
   */
  const ensureColumn = (table, column, ddlFragment) => {
    try {
      const cols = tableColumns(table);
      if (cols.length === 0) return; // CREATE TABLE has not run yet for this name
      if (hasColumn(cols, column)) return;
      db.execSync(`ALTER TABLE ${table} ADD COLUMN ${ddlFragment};`);
      console.log(`🌱 SQLite: Added ${table}.${column}`);
    } catch (err) {
      if (!/duplicate column/i.test(String(err?.message || err))) {
        console.warn(`⚠️ SQLite migrate ${table}.${column}:`, err?.message || err);
      }
    }
  };

  try {
    // ------------------------------------------------------------------
    // 1) Assignments cache (server copy + local pending mutations)
    // ------------------------------------------------------------------
    db.execSync(`
      CREATE TABLE IF NOT EXISTS local_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chamber_id INTEGER NOT NULL,
        chamber_name TEXT NOT NULL,
        client_name TEXT NOT NULL,
        remark TEXT,
        chamber_type TEXT DEFAULT 'Frozen',
        status TEXT DEFAULT 'active',
        sync_status TEXT DEFAULT 'synced',
        action TEXT DEFAULT 'none',
        warehouse_name TEXT,
        UNIQUE(chamber_id, client_name) ON CONFLICT REPLACE
      );
    `);
    ensureColumn('local_assignments', 'remark', 'remark TEXT');
    ensureColumn('local_assignments', 'chamber_type', "chamber_type TEXT DEFAULT 'Frozen'");
    ensureColumn('local_assignments', 'status', "status TEXT DEFAULT 'active'");
    ensureColumn('local_assignments', 'sync_status', "sync_status TEXT DEFAULT 'synced'");
    ensureColumn('local_assignments', 'action', "action TEXT DEFAULT 'none'");
    ensureColumn('local_assignments', 'warehouse_name', "warehouse_name TEXT");
    ensureColumn('local_assignments', 'warehouse_code', 'warehouse_code TEXT');
    ensureColumn('local_assignments', 'client_code', 'client_code TEXT');

    // ------------------------------------------------------------------
    // 2) Inspection upload queue (offline DO logs)
    // ------------------------------------------------------------------
    db.execSync(`
      CREATE TABLE IF NOT EXISTS local_inspections (
        id TEXT PRIMARY KEY,
        monitor_supervisor_name TEXT NOT NULL,
        chamber_id INTEGER NOT NULL,
        chamber_name TEXT NOT NULL,
        client_name TEXT NOT NULL,
        box_temp REAL NOT NULL,
        temp_sensor_image TEXT NOT NULL,
        entry_date TEXT NOT NULL,
        inspection_time TEXT NOT NULL,
        box_count INTEGER,
        chamber_type TEXT,
        overdue_time TEXT DEFAULT 'same day',
        photo_capture_time TEXT,
        sync_status TEXT NOT NULL DEFAULT 'pending',
        shift TEXT DEFAULT 'Morning',
        reference_no TEXT,
        server_log_id INTEGER,
        created_at TEXT DEFAULT NULL,
        updated_at TEXT DEFAULT NULL,
        UNIQUE(entry_date, chamber_id, client_name, inspection_time) ON CONFLICT FAIL
      );
    `);

    // Older app builds used different column names — copy values, do not DROP
    const inspCols = tableColumns('local_inspections');
    if (inspCols.length > 0) {
      ensureColumn('local_inspections', 'box_temp', 'box_temp REAL');
      ensureColumn('local_inspections', 'monitor_supervisor_name', 'monitor_supervisor_name TEXT');
      ensureColumn('local_inspections', 'inspection_time', 'inspection_time TEXT');
      ensureColumn('local_inspections', 'temp_sensor_image', 'temp_sensor_image TEXT');
      ensureColumn('local_inspections', 'box_count', 'box_count INTEGER');
      ensureColumn('local_inspections', 'chamber_type', 'chamber_type TEXT');
      ensureColumn('local_inspections', 'overdue_time', "overdue_time TEXT DEFAULT 'same day'");
      ensureColumn('local_inspections', 'photo_capture_time', 'photo_capture_time TEXT');
      ensureColumn('local_inspections', 'shift', "shift TEXT DEFAULT 'Morning'");
      ensureColumn('local_inspections', 'reference_no', 'reference_no TEXT');
      ensureColumn('local_inspections', 'server_log_id', 'server_log_id INTEGER');
      ensureColumn('local_inspections', 'created_at', 'created_at TEXT DEFAULT NULL');
      ensureColumn('local_inspections', 'updated_at', 'updated_at TEXT DEFAULT NULL');
      ensureColumn('local_inspections', 'sync_status', "sync_status TEXT DEFAULT 'pending'");
      ensureColumn('local_inspections', 'warehouse_name', 'warehouse_name TEXT');
      ensureColumn('local_inspections', 'warehouse_code', 'warehouse_code TEXT');
      ensureColumn('local_inspections', 'client_code', 'client_code TEXT');
      ensureColumn('local_inspections', 'operator_email', 'operator_email TEXT');
      ensureColumn('local_inspections', 'photo_capture_latitude', 'photo_capture_latitude REAL');
      ensureColumn('local_inspections', 'photo_capture_longitude', 'photo_capture_longitude REAL');
      ensureColumn('local_inspections', 'photo_capture_accuracy', 'photo_capture_accuracy REAL');

      try {
        if (hasColumn(inspCols, 'temperature')) {
          db.execSync(
            `UPDATE local_inspections SET box_temp = temperature WHERE box_temp IS NULL AND temperature IS NOT NULL;`
          );
        }
        if (hasColumn(inspCols, 'operator_name')) {
          db.execSync(
            `UPDATE local_inspections SET monitor_supervisor_name = operator_name WHERE (monitor_supervisor_name IS NULL OR monitor_supervisor_name = '') AND operator_name IS NOT NULL;`
          );
        }
        if (hasColumn(inspCols, 'entry_time')) {
          db.execSync(
            `UPDATE local_inspections SET inspection_time = entry_time WHERE (inspection_time IS NULL OR inspection_time = '') AND entry_time IS NOT NULL;`
          );
        }
        if (hasColumn(inspCols, 'photo_uri')) {
          db.execSync(
            `UPDATE local_inspections SET temp_sensor_image = photo_uri WHERE (temp_sensor_image IS NULL OR temp_sensor_image = '') AND photo_uri IS NOT NULL;`
          );
        }
      } catch (copyErr) {
        console.warn('⚠️ SQLite legacy column copy skipped:', copyErr?.message || copyErr);
      }
    }

    // ------------------------------------------------------------------
    // 3) Inward / Outward upload queues (offline dock forms)
    // ------------------------------------------------------------------
    db.execSync(`
      CREATE TABLE IF NOT EXISTS local_inward_logs (
        id TEXT PRIMARY KEY,
        form_json TEXT NOT NULL,
        photos_json TEXT NOT NULL,
        driver_country_code TEXT DEFAULT '+91',
        warehouse_name TEXT,
        operator_email TEXT,
        sync_status TEXT NOT NULL DEFAULT 'pending',
        reference_no TEXT,
        server_log_id INTEGER,
        sync_error TEXT,
        created_at TEXT,
        updated_at TEXT
      );
    `);
    db.execSync(`
      CREATE TABLE IF NOT EXISTS local_outward_logs (
        id TEXT PRIMARY KEY,
        form_json TEXT NOT NULL,
        photos_json TEXT NOT NULL,
        driver_country_code TEXT DEFAULT '+91',
        warehouse_name TEXT,
        operator_email TEXT,
        sync_status TEXT NOT NULL DEFAULT 'pending',
        reference_no TEXT,
        server_log_id INTEGER,
        sync_error TEXT,
        created_at TEXT,
        updated_at TEXT
      );
    `);
    ensureColumn('local_inward_logs', 'warehouse_code', 'warehouse_code TEXT');
    ensureColumn('local_outward_logs', 'warehouse_code', 'warehouse_code TEXT');

    // ------------------------------------------------------------------
    // 4) Client lot name suggestions (UI picker only)
    // ------------------------------------------------------------------
    db.execSync(`
      CREATE TABLE IF NOT EXISTS client_lot_master (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const DEFAULT_LOTS = [
      'Reliance Fresh',
      'BigBasket Cold',
      'Mother Dairy',
      'Amul Logistics',
      'ITC Foods Lot',
      'FreshToHome',
      'Licious Cold Chain',
      'Amazon Fresh Lot'
    ];
    for (const name of DEFAULT_LOTS) {
      try {
        db.runSync(
          'INSERT OR IGNORE INTO client_lot_master (client_name) VALUES (?);',
          [name]
        );
      } catch (_) {}
    }

    // ------------------------------------------------------------------
    // 5) Operator activity / remark queue (flush to MySQL on sync)
    // ------------------------------------------------------------------
    db.execSync(`
      CREATE TABLE IF NOT EXISTS local_activity_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        log_type TEXT DEFAULT 'DO_CHANGE',
        description TEXT NOT NULL,
        remark TEXT,
        permission_req INTEGER,
        sync_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✅ SQLite Database Tables initialized successfully.');
  } catch (error) {
    console.error('❌ Failed to initialize SQLite database tables:', error);
  }
};

/** Default seeded client lot names (also in client_lot_master). */
export const DEFAULT_CLIENT_LOT_MASTER = [
  'Reliance Fresh',
  'BigBasket Cold',
  'Mother Dairy',
  'Amul Logistics',
  'ITC Foods Lot',
  'FreshToHome',
  'Licious Cold Chain',
  'Amazon Fresh Lot'
];

/**
 * Returns suggestion names for the add-client picker (not forced onto chambers).
 */
export const getClientLotMaster = () => {
  if (!db) return [...DEFAULT_CLIENT_LOT_MASTER];
  try {
    const rows = db.getAllSync(
      "SELECT client_name FROM client_lot_master ORDER BY client_name COLLATE NOCASE ASC;"
    );
    const names = (rows || []).map((r) => r.client_name).filter(Boolean);
    // Prefer DB suggestions; fall back to defaults for quick-pick UI only
    const merged = [...names];
    DEFAULT_CLIENT_LOT_MASTER.forEach((n) => {
      if (!merged.some((x) => x.toLowerCase() === n.toLowerCase())) merged.push(n);
    });
    return merged;
  } catch (error) {
    console.error('❌ Failed to read client lot master:', error);
    return [...DEFAULT_CLIENT_LOT_MASTER];
  }
};

/**
 * Adds a client name to the shared client lot master (appears in all chamber dropdowns).
 * @returns {boolean} true if inserted or already present
 */
export const addClientLotMaster = (clientName) => {
  if (!db) return false;
  const name = String(clientName || '').trim();
  if (!name) return false;
  try {
    db.runSync(
      "INSERT OR IGNORE INTO client_lot_master (client_name) VALUES (?);",
      [name]
    );
    console.log(`🌱 Client lot master: ensured "${name}"`);
    return true;
  } catch (error) {
    console.error('❌ Failed to add client lot master:', error);
    return false;
  }
};

/**
 * Caches the client assignments retrieved from the server.
 * Keeps local pending / awaiting-approval rows so a DO-added client still
 * appears in today's temperature tasks until Super Admin approves.
 * @param {Array} assignments - Array of client assignments [{ chamber_id, chamber_name, client_name }]
 */
export const cacheAssignments = (assignments, warehouseName, warehouseCode = null) => {
  if (!db) return;
  try {
    const wh = String(warehouseName || '').trim();
    const whCode = String(warehouseCode || '').trim();
    // Capture before wipe — pending sync + DO adds waiting for SA approval
    const preserve = db.getAllSync(
      `SELECT * FROM local_assignments
       WHERE sync_status = 'pending'
          OR LOWER(TRIM(IFNULL(action, ''))) = 'awaiting_approval';`
    );

    db.execSync('DELETE FROM local_assignments;');

    const serverKeys = new Set();
    for (const item of assignments) {
      const key = `${Number(item.chamber_id)}|${String(item.client_name || '').trim().toLowerCase()}`;
      serverKeys.add(key);
      db.runSync(
        "INSERT INTO local_assignments (chamber_id, chamber_name, client_name, client_code, chamber_type, status, sync_status, action, warehouse_name, warehouse_code) VALUES (?, ?, ?, ?, ?, ?, 'synced', 'none', ?, ?);",
        [
          item.chamber_id,
          item.chamber_name,
          item.client_name,
          item.client_code || null,
          item.chamber_type || 'Frozen',
          String(item.status || 'active').toLowerCase() === 'inactive' ? 'inactive' : 'active',
          item.warehouse_name || wh,
          item.warehouse_code || whCode || null
        ]
      );
    }

    for (const item of preserve) {
      const remark = String(item.remark || '').trim().toLowerCase();
      // Skip only true auto-seed junk — do NOT drop real clients that share demo names
      if (remark === 'default client master' || remark === 'master client lot') {
        continue;
      }
      const key = `${Number(item.chamber_id)}|${String(item.client_name || '').trim().toLowerCase()}`;
      if (serverKeys.has(key) && String(item.action || '').toLowerCase() !== 'delete') {
        // Server already has this client; keep server row
        continue;
      }
      if (item.action === 'delete') {
        db.runSync(
          "INSERT OR REPLACE INTO local_assignments (chamber_id, chamber_name, client_name, remark, status, sync_status, action, warehouse_name) VALUES (?, ?, ?, ?, 'inactive', 'pending', 'delete', ?);",
          [item.chamber_id, item.chamber_name, item.client_name, item.remark, item.warehouse_name || wh]
        );
      } else {
        const action = String(item.action || '').toLowerCase() === 'awaiting_approval'
          ? 'awaiting_approval'
          : (item.action || 'add');
        const syncStatus = action === 'awaiting_approval' ? 'synced' : 'pending';
        db.runSync(
          "INSERT OR REPLACE INTO local_assignments (chamber_id, chamber_name, client_name, client_code, remark, chamber_type, status, sync_status, action, warehouse_name, warehouse_code) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?);",
          [
            item.chamber_id,
            item.chamber_name,
            item.client_name,
            item.client_code || null,
            item.remark,
            item.chamber_type || 'Frozen',
            syncStatus,
            action,
            item.warehouse_name || wh,
            item.warehouse_code || whCode || null
          ]
        );
      }
    }
    console.log('🌱 Successfully cached assignments locally in SQLite (preserved pending/awaiting).');
  } catch (error) {
    console.error('❌ Failed to cache assignments:', error);
  }
};

/**
 * Retrieves cached client assignments from the local SQLite database.
 * @returns {Array} List of local assignments
 */
export const getLocalAssignments = (warehouseName, warehouseCode = null) => {
  if (!db) return [];
  try {
    const wh = String(warehouseName || '').trim().toLowerCase();
    const code = String(warehouseCode || '').trim().toLowerCase();
    const rows = db.getAllSync("SELECT chamber_id, chamber_name, client_name, client_code, remark, chamber_type, status, warehouse_name, warehouse_code FROM local_assignments;");
    return rows.filter((r) => {
      if (r.status === 'inactive') return false;
      if (!wh && !code) return true;
      const rowWh = String(r.warehouse_name || '').trim().toLowerCase();
      const rowCode = String(r.warehouse_code || '').trim().toLowerCase();
      if (code && rowCode) return rowCode === code;
      if (wh) return !rowWh || rowWh === wh;
      return true;
    });
  } catch (error) {
    console.error('❌ Failed to read local assignments:', error);
    return [];
  }
};

/**
 * Saves a new inspection log locally to the SQLite queue.
 * @param {Object} log - Log details to save
 */
export const saveInspectionLocally = (log) => {
  if (!db) return false;
  try {
    db.runSync(
      `INSERT INTO local_inspections 
      (id, monitor_supervisor_name, chamber_id, chamber_name, client_name, client_code, box_temp, temp_sensor_image, entry_date, inspection_time, box_count, chamber_type, overdue_time, photo_capture_time, photo_capture_latitude, photo_capture_longitude, photo_capture_accuracy, sync_status, shift, created_at, warehouse_name, warehouse_code, operator_email) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?);`,
      [
        log.id,
        log.monitor_supervisor_name,
        parseInt(log.chamber_id),
        log.chamber_name,
        log.client_name,
        log.client_code || null,
        parseFloat(log.box_temp),
        log.temp_sensor_image,
        log.entry_date,
        log.inspection_time,
        log.box_count !== undefined && log.box_count !== null ? parseInt(log.box_count) : null,
        log.chamber_type || 'Frozen',
        log.overdue_time || 'same day',
        log.photo_capture_time || null,
        log.photo_capture_latitude != null ? parseFloat(log.photo_capture_latitude) : null,
        log.photo_capture_longitude != null ? parseFloat(log.photo_capture_longitude) : null,
        log.photo_capture_accuracy != null ? parseFloat(log.photo_capture_accuracy) : null,
        log.shift || 'Morning',
        log.created_at || null,
        log.warehouse_name || null,
        log.warehouse_code || null,
        log.operator_email || null
      ]
    );
    console.log(`💾 Saved inspection locally in SQLite queue: ${log.client_name} - ${log.chamber_name} (${log.chamber_type || 'Frozen'}, Overdue: ${log.overdue_time || 'same day'})`);
    return true;
  } catch (error) {
    console.error('❌ Failed to save inspection locally:', error);
    return false;
  }
};

/**
 * Verifies if an inspection has already been recorded for the given client, chamber and date.
 * Enforces the business logic: "Prevent duplicate submissions for the same client on the same day".
 */
export const checkDuplicateInspection = (date, chamberId, clientName, entryTime) => {
  if (!db) return false;
  try {
    const row = db.getFirstSync(
      'SELECT COUNT(*) as count FROM local_inspections WHERE entry_date = ? AND chamber_id = ? AND client_name = ? AND inspection_time = ?;',
      [date, parseInt(chamberId), clientName, entryTime]
    );
    return row && row.count > 0;
  } catch (error) {
    console.error('❌ Failed to check duplicate inspection:', error);
    return false;
  }
};

/**
 * Fetches all local inspections pending sync.
 */
export const getPendingInspections = (operatorName) => {
  if (!db) return [];
  try {
    if (operatorName) {
      return db.getAllSync(
        "SELECT * FROM local_inspections WHERE sync_status = 'pending' AND monitor_supervisor_name = ? ORDER BY entry_date DESC, COALESCE(updated_at, created_at) DESC, id DESC;",
        [operatorName]
      );
    }
    return db.getAllSync(
      "SELECT * FROM local_inspections WHERE sync_status = 'pending' ORDER BY entry_date DESC, COALESCE(updated_at, created_at) DESC, id DESC;"
    );
  } catch (error) {
    console.error('❌ Failed to fetch pending sync inspections:', error);
    return [];
  }
};

/**
 * Fetches local inspections for a date (optionally scoped to operator name and/or email).
 * Email match lets live DO data show after server→phone pull even if supervisor label differs.
 */
export const getTodaysInspections = (date, operatorName, operatorEmail) => {
  if (!db) return [];
  try {
    const day = String(date || '').slice(0, 10);
    const name = String(operatorName || '').trim();
    const email = String(operatorEmail || '').trim();
    const dateClause = 'substr(entry_date, 1, 10) = ?';
    if (name && email) {
      return db.getAllSync(
        `SELECT * FROM local_inspections
         WHERE ${dateClause}
           AND (monitor_supervisor_name = ? OR LOWER(IFNULL(operator_email, '')) = LOWER(?))
         ORDER BY COALESCE(updated_at, created_at) DESC, id DESC;`,
        [day, name, email]
      );
    }
    if (name) {
      return db.getAllSync(
        `SELECT * FROM local_inspections WHERE ${dateClause} AND monitor_supervisor_name = ? ORDER BY COALESCE(updated_at, created_at) DESC, id DESC;`,
        [day, name]
      );
    }
    if (email) {
      return db.getAllSync(
        `SELECT * FROM local_inspections WHERE ${dateClause} AND LOWER(IFNULL(operator_email, '')) = LOWER(?) ORDER BY COALESCE(updated_at, created_at) DESC, id DESC;`,
        [day, email]
      );
    }
    return db.getAllSync(
      `SELECT * FROM local_inspections WHERE ${dateClause} ORDER BY COALESCE(updated_at, created_at) DESC, id DESC;`,
      [day]
    );
  } catch (error) {
    console.error('❌ Failed to fetch today\'s inspections:', error);
    return [];
  }
};

/**
 * Fetches all local inspections logged on the device.
 */
export const getAllLocalInspections = (operatorName, operatorEmail) => {
  if (!db) return [];
  try {
    const name = String(operatorName || '').trim();
    const email = String(operatorEmail || '').trim();
    if (name && email) {
      return db.getAllSync(
        `SELECT * FROM local_inspections
         WHERE monitor_supervisor_name = ? OR LOWER(IFNULL(operator_email, '')) = LOWER(?)
         ORDER BY entry_date DESC, COALESCE(updated_at, created_at) DESC, id DESC;`,
        [name, email]
      );
    }
    if (name) {
      return db.getAllSync(
        "SELECT * FROM local_inspections WHERE monitor_supervisor_name = ? ORDER BY entry_date DESC, COALESCE(updated_at, created_at) DESC, id DESC;",
        [name]
      );
    }
    if (email) {
      return db.getAllSync(
        "SELECT * FROM local_inspections WHERE LOWER(IFNULL(operator_email, '')) = LOWER(?) ORDER BY entry_date DESC, COALESCE(updated_at, created_at) DESC, id DESC;",
        [email]
      );
    }
    return db.getAllSync(
      "SELECT * FROM local_inspections ORDER BY entry_date DESC, COALESCE(updated_at, created_at) DESC, id DESC;"
    );
  } catch (error) {
    console.error('❌ Failed to fetch all inspections:', error);
    return [];
  }
};

const toLocalYmd = (value) => {
  if (value == null || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return s.slice(0, 10);
};

const resolveShiftFromServerLog = (log) => {
  const s = String(log?.shift || '').trim();
  if (s === 'Morning' || s === 'Evening') return s;
  const t = String(log?.inspection_time || '').trim();
  if (t.startsWith('10:00')) return 'Morning';
  if (t.startsWith('16:00') || t.startsWith('18:00')) return 'Evening';
  const hm = t.match(/^(\d{1,2}):(\d{2})/);
  if (hm) {
    const h = parseInt(hm[1], 10);
    return h < 14 ? 'Morning' : 'Evening';
  }
  return 'Morning';
};

/**
 * Mirror a server chamber-temp row into local SQLite as synced (does not touch pending uploads).
 * Used so live DO completed tasks appear on a new/local device after login sync.
 * @returns {boolean} true if inserted or updated
 */
export const upsertSyncedInspectionFromServer = (serverLog, opts = {}) => {
  if (!db || !serverLog) return false;
  try {
    const formatted = String(serverLog.formatted_date || '').trim().slice(0, 10);
    const entryDate = /^\d{4}-\d{2}-\d{2}$/.test(formatted)
      ? formatted
      : toLocalYmd(serverLog.entry_date);
    const clientName = String(serverLog.client_name || '').trim();
    if (!entryDate || !clientName) return false;

    const shift = resolveShiftFromServerLog(serverLog);
    const inspectionTime =
      String(serverLog.inspection_time || '').trim() ||
      (shift === 'Evening' ? '16:00' : '10:00');

    let chamberId = parseInt(serverLog.chamber_id, 10);
    if (!Number.isFinite(chamberId) || chamberId <= 0) {
      const chamberName = String(serverLog.chamber_name || '').trim();
      if (chamberName) {
        const row = db.getFirstSync(
          `SELECT chamber_id FROM local_assignments
           WHERE LOWER(chamber_name) = LOWER(?) AND (status IS NULL OR status = 'active')
           LIMIT 1;`,
          [chamberName]
        );
        chamberId = row?.chamber_id != null ? parseInt(row.chamber_id, 10) : NaN;
      }
    }
    if (!Number.isFinite(chamberId) || chamberId <= 0) {
      const m = String(serverLog.chamber_name || '').match(/(\d+)/);
      chamberId = m ? parseInt(m[1], 10) : NaN;
    }
    if (!Number.isFinite(chamberId) || chamberId <= 0) return false;

    const pending = db.getFirstSync(
      `SELECT id FROM local_inspections
       WHERE entry_date = ? AND chamber_id = ? AND client_name = ? AND shift = ?
         AND sync_status = 'pending'
       LIMIT 1;`,
      [entryDate, chamberId, clientName, shift]
    );
    // Never overwrite a pending local upload queue row
    if (pending) return false;

    const serverLogId =
      serverLog.id != null && serverLog.id !== ''
        ? parseInt(serverLog.id, 10)
        : null;
    const localId =
      Number.isFinite(serverLogId) && serverLogId > 0
        ? `srv_${serverLogId}`
        : `srv_${entryDate}_${chamberId}_${clientName.replace(/\s+/g, '')}_${shift}`;

    const displayName = String(opts.displayName || '').trim();
    const operatorEmail = String(
      serverLog.operator_email || opts.operatorEmail || ''
    ).trim();
    const monitorName =
      String(serverLog.monitor_supervisor_name || '').trim() ||
      displayName ||
      operatorEmail ||
      'Data Operator';
    const nowIso = new Date().toISOString();
    const boxTemp = parseFloat(serverLog.box_temp ?? serverLog.chamber_temp);
    const tempImage = String(
      serverLog.temp_sensor_image || serverLog.photo_url || ''
    ).trim() || 'server';

    const existing =
      (Number.isFinite(serverLogId) &&
        db.getFirstSync(
          'SELECT id FROM local_inspections WHERE server_log_id = ? LIMIT 1;',
          [serverLogId]
        )) ||
      db.getFirstSync(
        `SELECT id FROM local_inspections
         WHERE entry_date = ? AND chamber_id = ? AND client_name = ? AND shift = ?
         LIMIT 1;`,
        [entryDate, chamberId, clientName, shift]
      ) ||
      db.getFirstSync('SELECT id FROM local_inspections WHERE id = ? LIMIT 1;', [
        localId,
      ]);

    if (existing?.id) {
      db.runSync(
        `UPDATE local_inspections SET
          monitor_supervisor_name = ?,
          chamber_id = ?,
          chamber_name = ?,
          client_name = ?,
          box_temp = ?,
          temp_sensor_image = CASE
            WHEN temp_sensor_image IS NOT NULL AND temp_sensor_image != '' AND temp_sensor_image != 'server'
              THEN temp_sensor_image
            ELSE ?
          END,
          entry_date = ?,
          inspection_time = ?,
          box_count = ?,
          chamber_type = ?,
          overdue_time = ?,
          photo_capture_time = ?,
          photo_capture_latitude = COALESCE(?, photo_capture_latitude),
          photo_capture_longitude = COALESCE(?, photo_capture_longitude),
          photo_capture_accuracy = COALESCE(?, photo_capture_accuracy),
          sync_status = 'synced',
          shift = ?,
          reference_no = COALESCE(?, reference_no),
          server_log_id = COALESCE(?, server_log_id),
          warehouse_name = COALESCE(?, warehouse_name),
          operator_email = COALESCE(?, operator_email),
          updated_at = ?
         WHERE id = ?;`,
        [
          monitorName,
          chamberId,
          serverLog.chamber_name || `Chamber ${chamberId}`,
          clientName,
          Number.isFinite(boxTemp) ? boxTemp : 0,
          tempImage,
          entryDate,
          inspectionTime,
          serverLog.box_count != null ? parseInt(serverLog.box_count, 10) : null,
          serverLog.chamber_type || 'Frozen',
          serverLog.overdue_time || 'same day',
          serverLog.photo_capture_time || null,
          serverLog.photo_capture_latitude != null ? parseFloat(serverLog.photo_capture_latitude) : null,
          serverLog.photo_capture_longitude != null ? parseFloat(serverLog.photo_capture_longitude) : null,
          serverLog.photo_capture_accuracy != null ? parseFloat(serverLog.photo_capture_accuracy) : null,
          shift,
          serverLog.reference_no || null,
          Number.isFinite(serverLogId) ? serverLogId : null,
          serverLog.warehouse_name || opts.warehouseName || null,
          operatorEmail || null,
          nowIso,
          existing.id,
        ]
      );
      return true;
    }

    db.runSync(
      `INSERT INTO local_inspections
      (id, monitor_supervisor_name, chamber_id, chamber_name, client_name, box_temp, temp_sensor_image,
       entry_date, inspection_time, box_count, chamber_type, overdue_time, photo_capture_time,
       photo_capture_latitude, photo_capture_longitude, photo_capture_accuracy,
       sync_status, shift, reference_no, server_log_id, created_at, updated_at, warehouse_name, operator_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?, ?, ?, ?, ?, ?);`,
      [
        localId,
        monitorName,
        chamberId,
        serverLog.chamber_name || `Chamber ${chamberId}`,
        clientName,
        Number.isFinite(boxTemp) ? boxTemp : 0,
        tempImage,
        entryDate,
        inspectionTime,
        serverLog.box_count != null ? parseInt(serverLog.box_count, 10) : null,
        serverLog.chamber_type || 'Frozen',
        serverLog.overdue_time || 'same day',
        serverLog.photo_capture_time || null,
        serverLog.photo_capture_latitude != null ? parseFloat(serverLog.photo_capture_latitude) : null,
        serverLog.photo_capture_longitude != null ? parseFloat(serverLog.photo_capture_longitude) : null,
        serverLog.photo_capture_accuracy != null ? parseFloat(serverLog.photo_capture_accuracy) : null,
        shift,
        serverLog.reference_no || null,
        Number.isFinite(serverLogId) ? serverLogId : null,
        serverLog.created_at || nowIso,
        nowIso,
        serverLog.warehouse_name || opts.warehouseName || null,
        operatorEmail || null,
      ]
    );
    return true;
  } catch (error) {
    if (!/UNIQUE|constraint/i.test(String(error?.message || error))) {
      console.warn(
        '⚠️ upsertSyncedInspectionFromServer:',
        error?.message || error
      );
    }
    return false;
  }
};

/**
 * After a successful chamber-temp pull: remove local *synced* rows in the date range
 * that no longer exist on the server (e.g. Super Admin deleted from MySQL).
 * Never deletes pending offline uploads.
 * @returns {number} rows deleted
 */
export const reconcileSyncedInspectionsFromServer = (serverItems, opts = {}) => {
  if (!db) return 0;
  const fromDate = String(opts.fromDate || '').slice(0, 10);
  const toDate = String(opts.toDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return 0;
  }

  try {
    const serverIds = new Set();
    const serverKeys = new Set();

    (Array.isArray(serverItems) ? serverItems : []).forEach((item) => {
      if (!item) return;
      const sid = item.id != null && item.id !== '' ? parseInt(item.id, 10) : NaN;
      if (Number.isFinite(sid) && sid > 0) serverIds.add(sid);

      const formatted = String(item.formatted_date || '').trim().slice(0, 10);
      const entryDate = /^\d{4}-\d{2}-\d{2}$/.test(formatted)
        ? formatted
        : toLocalYmd(item.entry_date);
      const clientName = String(item.client_name || '').trim();
      if (!entryDate || !clientName) return;

      let chamberId = parseInt(item.chamber_id, 10);
      if (!Number.isFinite(chamberId) || chamberId <= 0) {
        const m = String(item.chamber_name || '').match(/(\d+)/);
        chamberId = m ? parseInt(m[1], 10) : NaN;
      }
      if (!Number.isFinite(chamberId) || chamberId <= 0) return;

      const shift = resolveShiftFromServerLog(item);
      serverKeys.add(
        `${entryDate}|${chamberId}|${clientName.toLowerCase()}|${shift}`
      );
    });

    const email = String(opts.operatorEmail || '').trim();
    const rows = email
      ? db.getAllSync(
          `SELECT id, server_log_id, entry_date, chamber_id, client_name, shift
           FROM local_inspections
           WHERE IFNULL(sync_status, 'synced') != 'pending'
             AND substr(entry_date, 1, 10) >= ?
             AND substr(entry_date, 1, 10) <= ?
             AND (
               operator_email IS NULL OR TRIM(operator_email) = ''
               OR LOWER(operator_email) = LOWER(?)
             );`,
          [fromDate, toDate, email]
        )
      : db.getAllSync(
          `SELECT id, server_log_id, entry_date, chamber_id, client_name, shift
           FROM local_inspections
           WHERE IFNULL(sync_status, 'synced') != 'pending'
             AND substr(entry_date, 1, 10) >= ?
             AND substr(entry_date, 1, 10) <= ?;`,
          [fromDate, toDate]
        );

    let deleted = 0;
    (rows || []).forEach((row) => {
      const sid =
        row.server_log_id != null && row.server_log_id !== ''
          ? parseInt(row.server_log_id, 10)
          : NaN;
      let keep = false;
      if (Number.isFinite(sid) && sid > 0) {
        keep = serverIds.has(sid);
      } else {
        const key = `${String(row.entry_date || '').slice(0, 10)}|${parseInt(row.chamber_id, 10)}|${String(row.client_name || '').trim().toLowerCase()}|${String(row.shift || 'Morning').trim() || 'Morning'}`;
        keep = serverKeys.has(key);
      }
      if (keep) return;
      db.runSync(
        `DELETE FROM local_inspections WHERE id = ? AND IFNULL(sync_status, 'synced') != 'pending';`,
        [row.id]
      );
      deleted += 1;
    });

    if (deleted > 0) {
      console.log(
        `🗑️ Reconciled SQLite: removed ${deleted} synced inspection(s) missing on server (${fromDate}→${toDate})`
      );
    }
    return deleted;
  } catch (error) {
    console.warn(
      '⚠️ reconcileSyncedInspectionsFromServer:',
      error?.message || error
    );
    return 0;
  }
};

/**
 * Logout / fresh session: drop mirrored server inspections so next login re-reads MySQL.
 * Keeps pending offline upload queue rows.
 * @returns {number} rows deleted
 */
export const clearSyncedInspectionsLocally = () => {
  if (!db) return 0;
  try {
    const before = db.getFirstSync(
      `SELECT COUNT(*) AS c FROM local_inspections
       WHERE IFNULL(sync_status, 'synced') != 'pending';`
    );
    db.runSync(
      `DELETE FROM local_inspections WHERE IFNULL(sync_status, 'synced') != 'pending';`
    );
    const n = Number(before?.c) || 0;
    if (n > 0) {
      console.log(`🗑️ Cleared ${n} synced local inspection(s) (pending queue kept)`);
    }
    return n;
  } catch (error) {
    console.warn('⚠️ clearSyncedInspectionsLocally:', error?.message || error);
    return 0;
  }
};

/**
 * Marks a queued inspection as synced in the local database.
 * @param {string} id - Local Log ID
 * @param {string} referenceNo - Server reference number
 * @param {number|string|null} serverLogId - Server daily_chamber_temp_logs.id
 */
export const markInspectionAsSynced = (id, referenceNo, serverLogId = null) => {
  if (!db) return;
  try {
    db.runSync(
      "UPDATE local_inspections SET sync_status = 'synced', reference_no = ?, server_log_id = COALESCE(?, server_log_id) WHERE id = ?;",
      [referenceNo || null, serverLogId != null ? parseInt(serverLogId, 10) : null, id]
    );
    console.log(`🚀 Marked inspection ${id} as SYNCED with Ref: ${referenceNo}, server_log_id: ${serverLogId} in local SQLite.`);
  } catch (error) {
    console.error('❌ Failed to mark inspection as synced:', error);
  }
};

/**
 * Updates an existing local inspection after Super Admin approved edit.
 */
export const updateInspectionLocally = (localId, updates = {}) => {
  if (!db || !localId) return false;
  try {
    db.runSync(
      `UPDATE local_inspections SET
        box_temp = COALESCE(?, box_temp),
        box_count = COALESCE(?, box_count),
        temp_sensor_image = COALESCE(?, temp_sensor_image),
        photo_capture_time = COALESCE(?, photo_capture_time),
        photo_capture_latitude = COALESCE(?, photo_capture_latitude),
        photo_capture_longitude = COALESCE(?, photo_capture_longitude),
        photo_capture_accuracy = COALESCE(?, photo_capture_accuracy),
        chamber_type = COALESCE(?, chamber_type),
        inspection_time = COALESCE(?, inspection_time),
        updated_at = COALESCE(?, updated_at),
        sync_status = COALESCE(?, sync_status)
      WHERE id = ?;`,
      [
        updates.box_temp != null ? parseFloat(updates.box_temp) : null,
        updates.box_count != null ? parseInt(updates.box_count, 10) : null,
        updates.temp_sensor_image || null,
        updates.photo_capture_time || null,
        updates.photo_capture_latitude != null ? parseFloat(updates.photo_capture_latitude) : null,
        updates.photo_capture_longitude != null ? parseFloat(updates.photo_capture_longitude) : null,
        updates.photo_capture_accuracy != null ? parseFloat(updates.photo_capture_accuracy) : null,
        updates.chamber_type || null,
        updates.inspection_time || null,
        updates.updated_at || null,
        updates.sync_status || null,
        localId
      ]
    );
    return true;
  } catch (error) {
    console.error('❌ Failed to update local inspection:', error);
    return false;
  }
};

/**
 * Deletes a local inspection by entry_date, chamber_id, client_name, and shift.
 */
export const deleteInspectionLocally = (date, chamberId, clientName, shift) => {
  if (!db) return false;
  try {
    db.runSync(
      "DELETE FROM local_inspections WHERE entry_date = ? AND chamber_id = ? AND client_name = ? AND shift = ?;",
      [date, parseInt(chamberId), clientName, shift]
    );
    console.log(`🗑️ Deleted local inspection: ${clientName} in Chamber ${chamberId} for date ${date} for shift ${shift}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to delete local inspection:', error);
    return false;
  }
};

/**
 * Adds a new client assignment locally with a remark/reason.
 */
export const addLocalAssignment = (chamberId, chamberName, clientName, remark, chamberType, warehouseName, warehouseCode = null, clientCode = null) => {
  if (!db) return false;
  try {
    const wh = String(warehouseName || '').trim();
    db.runSync(
      "INSERT OR REPLACE INTO local_assignments (chamber_id, chamber_name, client_name, client_code, remark, chamber_type, status, sync_status, action, warehouse_name, warehouse_code) VALUES (?, ?, ?, ?, ?, ?, 'active', 'pending', 'add', ?, ?);",
      [parseInt(chamberId), chamberName, clientName, clientCode || null, remark || '', chamberType || 'Frozen', wh, warehouseCode || null]
    );
    console.log(`➕ Added local client assignment: ${clientName} in ${chamberName} with type: ${chamberType}, remark: ${remark}, warehouse: ${wh}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to add local assignment:', error);
    return false;
  }
};

/**
 * Show client on today's temp tasks immediately (DO add / after SA approve).
 * Uses awaiting_approval so sync does not POST until server has the row.
 */
export const upsertLocalActiveAssignment = (
  chamberId,
  chamberName,
  clientName,
  remark,
  chamberType,
  warehouseName,
  warehouseCode = null,
  clientCode = null,
  { awaitingApproval = false } = {}
) => {
  if (!db) return false;
  try {
    const wh = String(warehouseName || '').trim();
    const action = awaitingApproval ? 'awaiting_approval' : 'none';
    db.runSync(
      `INSERT OR REPLACE INTO local_assignments
       (chamber_id, chamber_name, client_name, client_code, remark, chamber_type, status, sync_status, action, warehouse_name, warehouse_code)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 'synced', ?, ?, ?);`,
      [
        parseInt(chamberId, 10),
        chamberName,
        clientName,
        clientCode || null,
        remark || '',
        chamberType || 'Frozen',
        action,
        wh,
        warehouseCode || null
      ]
    );
    return true;
  } catch (error) {
    console.error('❌ Failed to upsert local assignment:', error);
    return false;
  }
};

/** Hard-remove a local chamber client (e.g. SA denied an add). */
export const removeLocalAssignmentHard = (chamberId, clientName) => {
  if (!db) return false;
  try {
    db.runSync(
      'DELETE FROM local_assignments WHERE chamber_id = ? AND LOWER(TRIM(client_name)) = LOWER(TRIM(?));',
      [parseInt(chamberId, 10), String(clientName || '').trim()]
    );
    return true;
  } catch (error) {
    console.error('❌ Failed to remove local assignment:', error);
    return false;
  }
};

/** Keep local row for tasks; stop retrying POST until SA approves. */
export const markAssignmentAwaitingApproval = (chamberId, clientName) => {
  if (!db) return;
  try {
    db.runSync(
      `UPDATE local_assignments
       SET sync_status = 'synced', action = 'awaiting_approval', status = 'active'
       WHERE chamber_id = ? AND LOWER(TRIM(client_name)) = LOWER(TRIM(?));`,
      [parseInt(chamberId, 10), String(clientName || '').trim()]
    );
  } catch (error) {
    console.error('❌ Failed to mark assignment awaiting approval:', error);
  }
};

/**
 * For each chamber with no active clients yet, seed the default client master list.
 * After that, DO customizes per chamber (add/edit/delete) and those changes stick.
 * @returns {number} how many client rows inserted
 */
export const seedDefaultClientsForEmptyChambers = (chambers) => {
  if (!db || !Array.isArray(chambers) || !chambers.length) return 0;
  let added = 0;
  for (const ch of chambers) {
    if (ch?.id == null) continue;
    const cid = parseInt(ch.id, 10);
    if (!Number.isFinite(cid)) continue;
    try {
      const rows = db.getAllSync(
        `SELECT client_name FROM local_assignments
         WHERE chamber_id = ? AND (status IS NULL OR status = 'active')
         LIMIT 1;`,
        [cid]
      );
      if (rows && rows.length > 0) continue;

      const chamberName = ch.name || `Chamber ${cid}`;
      for (const name of DEFAULT_CLIENT_LOT_MASTER) {
        try {
          db.runSync(
            `INSERT OR REPLACE INTO local_assignments
             (chamber_id, chamber_name, client_name, remark, chamber_type, status, sync_status, action)
             VALUES (?, ?, ?, ?, ?, 'active', 'pending', 'add');`,
            [cid, chamberName, name, 'Default client master', 'Frozen']
          );
          added += 1;
        } catch (_) {}
      }
    } catch (err) {
      console.warn('⚠️ seedDefaultClientsForEmptyChambers failed for chamber', cid, err?.message || err);
    }
  }
  if (added > 0) {
    console.log(`🌱 Seeded ${added} default client master row(s) on empty chambers.`);
  }
  return added;
};

/**
 * Remove auto-seeded example client rows (by seed remark only).
 * Do not delete by demo display names — real clients may reuse those names.
 */
export const purgeAutoSeededMasterLotsOnce = () => {
  if (!db) return 0;
  try {
    const byRemark = db.runSync(
      `DELETE FROM local_assignments
       WHERE remark IN (?, ?)
          OR LOWER(TRIM(IFNULL(remark, ''))) = 'default client master';`,
      ['Master client lot', 'Default client master']
    );
    const n = Number(byRemark?.changes || 0);
    if (n > 0) console.log(`🧹 Purged ${n} auto-seeded chamber client lots.`);
    return n;
  } catch (error) {
    console.error('❌ Failed to purge auto-seeded lots:', error);
    return 0;
  }
};

/**
 * Renames a client assignment on one chamber only (edit client master for that chamber).
 * User remark is stored on both rows so MySQL chamber_client_assignments.remark is updated on sync.
 */
export const renameLocalAssignment = (chamberId, chamberName, oldClientName, newClientName, remark = '') => {
  if (!db) return false;
  const oldName = String(oldClientName || '').trim();
  const newName = String(newClientName || '').trim();
  const note = String(remark || '').trim();
  if (!oldName || !newName) return false;
  if (oldName.toLowerCase() === newName.toLowerCase()) return true;
  try {
    const cid = parseInt(chamberId, 10);
    const dup = db.getFirstSync(
      "SELECT id FROM local_assignments WHERE chamber_id = ? AND LOWER(client_name) = LOWER(?) AND (status IS NULL OR status = 'active') LIMIT 1;",
      [cid, newName]
    );
    if (dup) return false;

    const row = db.getFirstSync(
      "SELECT * FROM local_assignments WHERE chamber_id = ? AND LOWER(client_name) = LOWER(?) LIMIT 1;",
      [cid, oldName]
    );
    if (!row) return false;

    const deleteRemark = note || `Renamed to ${newName}`;
    const addRemark = note || `Renamed from ${oldName}`;

    if (row.sync_status === 'pending' && (row.action === 'add' || row.action === 'rename_add')) {
      db.runSync(
        "UPDATE local_assignments SET client_name = ?, chamber_name = COALESCE(?, chamber_name), remark = COALESCE(?, remark) WHERE chamber_id = ? AND LOWER(client_name) = LOWER(?);",
        [newName, chamberName || null, note || null, cid, oldName]
      );
    } else {
      // Soft-delete old + pending add new (sync-friendly rename)
      db.runSync(
        "UPDATE local_assignments SET status = 'inactive', remark = ?, sync_status = 'pending', action = 'rename_delete' WHERE chamber_id = ? AND LOWER(client_name) = LOWER(?);",
        [deleteRemark, cid, oldName]
      );
      db.runSync(
        `INSERT OR REPLACE INTO local_assignments
          (chamber_id, chamber_name, client_name, remark, chamber_type, status, sync_status, action, warehouse_name)
         VALUES (?, ?, ?, ?, ?, 'active', 'pending', 'rename_add', ?);`,
        [
          cid,
          chamberName || row.chamber_name,
          newName,
          addRemark,
          row.chamber_type || 'Frozen',
          row.warehouse_name || ''
        ]
      );
    }
    console.log(`✏️ Renamed client on chamber ${cid}: "${oldName}" → "${newName}"`);
    return true;
  } catch (error) {
    console.error('❌ Failed to rename local assignment:', error);
    return false;
  }
};

/**
 * Updates the chamber_type for all active assignments of a specific chamber.
 */
export const updateLocalChamberType = (chamberId, chamberType) => {
  if (!db) return false;
  try {
    const cid = parseInt(chamberId, 10);
    const type = String(chamberType || 'Frozen').trim();

    db.runSync(
      "UPDATE local_assignments SET chamber_type = ?, sync_status = 'pending', action = 'add' WHERE chamber_id = ? AND (status IS NULL OR status = 'active');",
      [type, cid]
    );

    console.log(`✏️ Updated chamber ${cid} assignments type to: ${type}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to update local chamber type:', error);
    return false;
  }
};

/**
 * Deletes a client assignment locally by marking it inactive with a deletion remark.
 */
export const deleteLocalAssignment = (chamberId, clientName, remark) => {
  if (!db) return false;
  try {
    // Check if the assignment exists and was already synced
    const row = db.getFirstSync("SELECT * FROM local_assignments WHERE chamber_id = ? AND client_name = ? LIMIT 1;", [parseInt(chamberId), clientName]);
    
    if (row && row.sync_status === 'pending' && row.action === 'add') {
      // If it was just added locally and not yet synced, we can delete it directly!
      db.runSync(
        "DELETE FROM local_assignments WHERE chamber_id = ? AND client_name = ?;",
        [parseInt(chamberId), clientName]
      );
      console.log(`🗑️ Deleted local pending assignment: ${clientName} from chamber ${chamberId}`);
    } else {
      // Otherwise mark it inactive and pending deletion sync
      db.runSync(
        "UPDATE local_assignments SET status = 'inactive', remark = ?, sync_status = 'pending', action = 'delete' WHERE chamber_id = ? AND client_name = ?;",
        [remark || '', parseInt(chamberId), clientName]
      );
      console.log(`➖ Soft-deleted client assignment for sync: ${clientName} from chamber ${chamberId}`);
    }
    return true;
  } catch (error) {
    console.error('❌ Failed to soft-delete local assignment:', error);
    return false;
  }
};

export const getPendingAssignments = (warehouseName) => {
  if (!db) return [];
  try {
    const wh = String(warehouseName || '').trim().toLowerCase();
    const rows = db.getAllSync("SELECT * FROM local_assignments WHERE sync_status = 'pending';");
    return rows.filter((r) => {
      if (!wh) return true;
      const rowWh = String(r.warehouse_name || '').trim().toLowerCase();
      return !rowWh || rowWh === wh;
    });
  } catch (error) {
    console.error('❌ Failed to fetch pending assignments:', error);
    return [];
  }
};

/**
 * Marks a queued client assignment as synced or deletes it if it was a deletion request.
 */
export const markAssignmentSynced = (chamberId, clientName, action) => {
  if (!db) return;
  try {
    if (action === 'delete' || action === 'rename_delete') {
      db.runSync(
        "DELETE FROM local_assignments WHERE chamber_id = ? AND client_name = ?;",
        [parseInt(chamberId), clientName]
      );
      console.log(`🚀 Cleaned up synced deletion assignment: ${clientName} in Chamber ${chamberId}`);
    } else {
      db.runSync(
        "UPDATE local_assignments SET sync_status = 'synced', action = 'none' WHERE chamber_id = ? AND client_name = ?;",
        [parseInt(chamberId), clientName]
      );
      console.log(`🚀 Marked assignment synced: ${clientName} in Chamber ${chamberId}`);
    }
  } catch (error) {
    console.error('❌ Failed to mark assignment synced:', error);
  }
};

// ------------------------------------------------------------------
// Inward / Outward offline queue
// ------------------------------------------------------------------

export const saveInwardLocally = ({
  form,
  photos,
  driverCountryCode = '+91',
  warehouse_name = null,
  warehouse_code = null,
  operator_email = null,
}) => {
  if (!db) return null;
  try {
    const id = `in_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();
    db.runSync(
      `INSERT INTO local_inward_logs
      (id, form_json, photos_json, driver_country_code, warehouse_name, warehouse_code, operator_email, sync_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?);`,
      [
        id,
        JSON.stringify(form || {}),
        JSON.stringify(photos || {}),
        driverCountryCode,
        warehouse_name,
        warehouse_code,
        operator_email,
        now,
        now,
      ]
    );
    console.log(`💾 Saved inward log locally: ${id}`);
    return { id, created_at: now };
  } catch (error) {
    console.error('❌ Failed to save inward locally:', error);
    return null;
  }
};

export const saveOutwardLocally = ({
  form,
  photos,
  driverCountryCode = '+91',
  warehouse_name = null,
  warehouse_code = null,
  operator_email = null,
}) => {
  if (!db) return null;
  try {
    const id = `out_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();
    db.runSync(
      `INSERT INTO local_outward_logs
      (id, form_json, photos_json, driver_country_code, warehouse_name, warehouse_code, operator_email, sync_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?);`,
      [
        id,
        JSON.stringify(form || {}),
        JSON.stringify(photos || {}),
        driverCountryCode,
        warehouse_name,
        warehouse_code,
        operator_email,
        now,
        now,
      ]
    );
    console.log(`💾 Saved outward log locally: ${id}`);
    return { id, created_at: now };
  } catch (error) {
    console.error('❌ Failed to save outward locally:', error);
    return null;
  }
};

export const getPendingInwardLogs = (operatorEmail = null) => {
  if (!db) return [];
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  try {
    db.runSync(
      "UPDATE local_inward_logs SET sync_status = 'synced', sync_error = NULL WHERE server_log_id IS NOT NULL AND server_log_id != 0 AND sync_status != 'synced';"
    );
    const where =
      "(sync_status = 'pending' OR (sync_status = 'syncing' AND updated_at < ?)) AND (server_log_id IS NULL OR server_log_id = 0)";
    if (operatorEmail) {
      return db.getAllSync(
        `SELECT * FROM local_inward_logs WHERE ${where} AND LOWER(operator_email) = LOWER(?) ORDER BY created_at ASC;`,
        [staleBefore, operatorEmail]
      );
    }
    return db.getAllSync(
      `SELECT * FROM local_inward_logs WHERE ${where} ORDER BY created_at ASC;`,
      [staleBefore]
    );
  } catch (error) {
    console.error('❌ Failed to fetch pending inward logs:', error);
    return [];
  }
};

export const getPendingOutwardLogs = (operatorEmail = null) => {
  if (!db) return [];
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  try {
    db.runSync(
      "UPDATE local_outward_logs SET sync_status = 'synced', sync_error = NULL WHERE server_log_id IS NOT NULL AND server_log_id != 0 AND sync_status != 'synced';"
    );
    const where =
      "(sync_status = 'pending' OR (sync_status = 'syncing' AND updated_at < ?)) AND (server_log_id IS NULL OR server_log_id = 0)";
    if (operatorEmail) {
      return db.getAllSync(
        `SELECT * FROM local_outward_logs WHERE ${where} AND LOWER(operator_email) = LOWER(?) ORDER BY created_at ASC;`,
        [staleBefore, operatorEmail]
      );
    }
    return db.getAllSync(
      `SELECT * FROM local_outward_logs WHERE ${where} ORDER BY created_at ASC;`,
      [staleBefore]
    );
  } catch (error) {
    console.error('❌ Failed to fetch pending outward logs:', error);
    return [];
  }
};

export const getPendingSyncFailures = (operatorEmail = null) => {
  if (!db) return [];
  try {
    const inward = operatorEmail
      ? db.getAllSync(
          "SELECT id, sync_error, created_at, 'inward' AS queue_type FROM local_inward_logs WHERE sync_status = 'pending' AND sync_error IS NOT NULL AND sync_error != '' AND LOWER(operator_email) = LOWER(?) ORDER BY updated_at DESC LIMIT 10;",
          [operatorEmail]
        )
      : db.getAllSync(
          "SELECT id, sync_error, created_at, 'inward' AS queue_type FROM local_inward_logs WHERE sync_status = 'pending' AND sync_error IS NOT NULL AND sync_error != '' ORDER BY updated_at DESC LIMIT 10;"
        );
    const outward = operatorEmail
      ? db.getAllSync(
          "SELECT id, sync_error, created_at, 'outward' AS queue_type FROM local_outward_logs WHERE sync_status = 'pending' AND sync_error IS NOT NULL AND sync_error != '' AND LOWER(operator_email) = LOWER(?) ORDER BY updated_at DESC LIMIT 10;",
          [operatorEmail]
        )
      : db.getAllSync(
          "SELECT id, sync_error, created_at, 'outward' AS queue_type FROM local_outward_logs WHERE sync_status = 'pending' AND sync_error IS NOT NULL AND sync_error != '' ORDER BY updated_at DESC LIMIT 10;"
        );
    return [...inward, ...outward];
  } catch (error) {
    console.error('❌ Failed to fetch sync failures:', error);
    return [];
  }
};

export const markInwardSyncing = (id) => {
  if (!db || !id) return;
  try {
    db.runSync(
      "UPDATE local_inward_logs SET sync_status = 'syncing', updated_at = ? WHERE id = ? AND sync_status != 'synced';",
      [new Date().toISOString(), id]
    );
  } catch (error) {
    console.error('❌ Failed to mark inward as syncing:', error);
  }
};

export const markOutwardSyncing = (id) => {
  if (!db || !id) return;
  try {
    db.runSync(
      "UPDATE local_outward_logs SET sync_status = 'syncing', updated_at = ? WHERE id = ? AND sync_status != 'synced';",
      [new Date().toISOString(), id]
    );
  } catch (error) {
    console.error('❌ Failed to mark outward as syncing:', error);
  }
};

export const markInwardAsSynced = (id, referenceNo, serverLogId = null) => {
  if (!db || !id) return;
  try {
    db.runSync(
      "UPDATE local_inward_logs SET sync_status = 'synced', reference_no = ?, server_log_id = COALESCE(?, server_log_id), sync_error = NULL, updated_at = ? WHERE id = ?;",
      [referenceNo || null, serverLogId != null ? parseInt(serverLogId, 10) : null, new Date().toISOString(), id]
    );
  } catch (error) {
    console.error('❌ Failed to mark inward as synced:', error);
  }
};

export const markOutwardAsSynced = (id, referenceNo, serverLogId = null) => {
  if (!db || !id) return;
  try {
    db.runSync(
      "UPDATE local_outward_logs SET sync_status = 'synced', reference_no = ?, server_log_id = COALESCE(?, server_log_id), sync_error = NULL, updated_at = ? WHERE id = ?;",
      [referenceNo || null, serverLogId != null ? parseInt(serverLogId, 10) : null, new Date().toISOString(), id]
    );
  } catch (error) {
    console.error('❌ Failed to mark outward as synced:', error);
  }
};

export const markInwardSyncError = (id, message) => {
  if (!db || !id) return;
  try {
    db.runSync(
      "UPDATE local_inward_logs SET sync_status = 'pending', sync_error = ?, updated_at = ? WHERE id = ?;",
      [String(message || 'Upload failed').slice(0, 500), new Date().toISOString(), id]
    );
  } catch (error) {
    console.error('❌ Failed to record inward sync error:', error);
  }
};

export const markOutwardSyncError = (id, message) => {
  if (!db || !id) return;
  try {
    db.runSync(
      "UPDATE local_outward_logs SET sync_status = 'pending', sync_error = ?, updated_at = ? WHERE id = ?;",
      [String(message || 'Upload failed').slice(0, 500), new Date().toISOString(), id]
    );
  } catch (error) {
    console.error('❌ Failed to record outward sync error:', error);
  }
};

export const queueLocalActivity = ({ action, logType, description, remark, permissionReq } = {}) => {
  if (!db) return null;
  const act = String(action || '').trim();
  const desc = String(description || '').trim();
  if (!act || !desc) return null;
  try {
    const result = db.runSync(
      `INSERT INTO local_activity_queue (action, log_type, description, remark, permission_req, sync_status)
       VALUES (?, ?, ?, ?, ?, 'pending');`,
      [
        act,
        String(logType || 'DO_CHANGE'),
        desc,
        String(remark || '').trim() || null,
        permissionReq != null && Number.isFinite(Number(permissionReq)) ? Number(permissionReq) : null
      ]
    );
    return result?.lastInsertRowId || result?.lastInsertRowid || null;
  } catch (error) {
    console.error('❌ Failed to queue operator activity:', error);
    return null;
  }
};

export const getPendingActivities = () => {
  if (!db) return [];
  try {
    return db.getAllSync("SELECT * FROM local_activity_queue WHERE sync_status = 'pending' ORDER BY id ASC;") || [];
  } catch (error) {
    console.error('❌ Failed to fetch pending activities:', error);
    return [];
  }
};

export const markActivitySynced = (id) => {
  if (!db || id == null) return;
  try {
    db.runSync("DELETE FROM local_activity_queue WHERE id = ?;", [id]);
  } catch (error) {
    console.error('❌ Failed to mark activity synced:', error);
  }
};

export const countPendingSyncItems = (warehouseName, operatorName, operatorEmail) => {
  return (
    getPendingAssignments(warehouseName).length +
    getPendingInspections(operatorName).length +
    getPendingInwardLogs(operatorEmail).length +
    getPendingOutwardLogs(operatorEmail).length +
    getPendingActivities().length
  );
};
