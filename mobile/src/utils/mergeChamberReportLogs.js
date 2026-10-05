/**
 * Chamber report merge (src/utils/mergeChamberReportLogs.js).
 * WHAT: Combines server history with local SQLite temp logs for one report list.
 * WHY: Pending offline logs must appear and override stale server copies.
 * HOW: normalizeServerChamberLog + Map keyed by day/chamber/client/shift.
 */

/** WHAT: Parse many date shapes to YYYY-MM-DD. WHY: Sort and filter reports by day. HOW: Date parse or string slice. */
function toLocalYmd(value) {
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
}

/**
 * WHAT: Maps API chamber log fields to the shape Dashboard reports expect.
 * WHY: Server column names differ from local SQLite rows.
 * HOW: Spread with renamed temp/image fields and _source: 'server'.
 */
export function normalizeServerChamberLog(row) {
  if (!row) return null;
  const formatted = String(row.formatted_date || '').trim().slice(0, 10);
  const entryDate = /^\d{4}-\d{2}-\d{2}$/.test(formatted)
    ? formatted
    : toLocalYmd(row.entry_date);
  return {
    id: `server-${row.id}`,
    server_log_id: row.id,
    chamber_id: row.chamber_id,
    chamber_name: row.chamber_name,
    client_name: row.client_name,
    box_temp: row.box_temp ?? row.chamber_temp ?? row.temperature,
    box_count: row.box_count,
    entry_date: entryDate,
    formatted_date: row.formatted_date || entryDate,
    inspection_time: row.inspection_time,
    shift: row.shift,
    monitor_supervisor_name: row.monitor_supervisor_name || row.operator_name,
    temp_sensor_image: row.temp_sensor_image || row.photo_url,
    photo_capture_time: row.photo_capture_time,
    photo_capture_latitude: row.photo_capture_latitude,
    photo_capture_longitude: row.photo_capture_longitude,
    photo_capture_accuracy: row.photo_capture_accuracy,
    time_variance_minutes: row.time_variance_minutes,
    warehouse_name: row.warehouse_name,
    operator_email: row.operator_email,
    reference_no: row.reference_no,
    chamber_type: row.chamber_type,
    overdue_time: row.overdue_time,
    remarks: row.remarks,
    update_count: row.update_count,
    sync_status: 'synced',
    created_at: row.created_at,
    updated_at: row.updated_at,
    _source: 'server'
  };
}

function logMergeKey(log) {
  if (!log) return '';
  if (log.server_log_id != null) return `srv-${log.server_log_id}`;
  const day = String(log.entry_date || '').slice(0, 10);
  const shift = String(log.shift || '').trim().toLowerCase();
  const chamberId = log.chamber_id != null ? String(log.chamber_id) : '';
  const client = String(log.client_name || '').trim().toLowerCase();
  return `loc-${day}|${chamberId}|${client}|${shift}`;
}

/**
 * WHAT: Single merged array for report FlatLists.
 * WHY: DO sees both uploaded history and not-yet-synced entries.
 * HOW: Map by logMergeKey; local pending always wins over server row for same key.
 */
export function mergeChamberReportLogs(serverLogs = [], localLogs = []) {
  const map = new Map();

  for (const row of serverLogs) {
    const normalized = normalizeServerChamberLog(row);
    if (!normalized) continue;
    map.set(logMergeKey(normalized), normalized);
  }

  for (const log of localLogs) {
    if (!log) continue;
    const key = logMergeKey(log);
    const existing = map.get(key);
    if (log.sync_status === 'pending') {
      map.set(key, { ...log, _source: 'local' });
    } else if (!existing) {
      map.set(key, { ...log, _source: 'local' });
    }
  }

  return Array.from(map.values());
}
