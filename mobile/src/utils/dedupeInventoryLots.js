/**
 * Reports lots: one card per client + chamber + warehouse.
 * Same-day Morning + Evening audits must not create duplicate lots.
 * Same client on Chamber 1 (Frozen) and Chamber 2 (Chilled) stay two lots.
 */
export function inventoryLotKey(row) {
  if (!row) return '';
  const client = String(row.client_name || '')
    .trim()
    .toLowerCase();
  const wh = String(row.warehouse_name || '')
    .trim()
    .toLowerCase();
  const cid =
    row.chamber_id != null && String(row.chamber_id).trim() !== ''
      ? String(Number(row.chamber_id))
      : '';
  const cname = String(row.chamber_name || '')
    .trim()
    .toLowerCase();
  return `${client}|||${wh}|||${cid}|||${cname}`;
}

export function sameInventoryLot(a, b) {
  return inventoryLotKey(a) === inventoryLotKey(b);
}

export function normalizeChamberZone(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/froz/i.test(s)) return 'Frozen';
  if (/chill/i.test(s)) return 'Chilled';
  if (/dry/i.test(s)) return 'Dry';
  if (/other/i.test(s)) return 'Other';
  return s;
}

/** Frozen / Chilled / Dry — ignore stale "Other" from old logs. */
export function isRealComplianceZone(raw) {
  const t = normalizeChamberZone(raw);
  return t === 'Frozen' || t === 'Chilled' || t === 'Dry';
}

export function pickComplianceZone(...candidates) {
  for (const c of candidates) {
    if (isRealComplianceZone(c)) return normalizeChamberZone(c);
  }
  for (const c of candidates) {
    const t = normalizeChamberZone(c);
    if (t) return t;
  }
  return '';
}

export function chamberZoneStyle(raw) {
  const type = normalizeChamberZone(raw) || 'Frozen';
  if (type === 'Frozen') return { type, color: '#1d4ed8', bg: '#dbeafe' };
  if (type === 'Chilled') return { type, color: '#0d9488', bg: '#ccfbf1' };
  if (type === 'Dry') return { type, color: '#16a34a', bg: '#dcfce7' };
  return { type, color: '#64748b', bg: '#f1f5f9' };
}

/** Compliance band for Frozen / Chilled / Dry / Other chamber types. */
export function getChamberTempRange(chamberType) {
  const zone = pickComplianceZone(chamberType) || normalizeChamberZone(chamberType);
  if (zone === 'Frozen') return { zone, min: null, max: -18, label: '≤ -18°C' };
  if (zone === 'Chilled') return { zone, min: -5, max: 5, label: '-5°C to 5°C' };
  if (zone === 'Dry') return { zone, min: 15, max: 25, label: '15°C to 25°C' };
  if (zone === 'Other') return { zone, min: 0, max: 40, label: '0°C to 40°C' };
  return null;
}

/** True when temp is outside the chamber-type compliance band. */
export function isChamberTempOutOfRange(temp, chamberType) {
  return getChamberTempDeviation(temp, chamberType) != null;
}

/**
 * How temp sits vs chamber type band.
 * @returns {'low'|'high'|null} low = kam (<), high = zyada (>)
 */
export function getChamberTempDeviation(temp, chamberType) {
  const range = getChamberTempRange(chamberType);
  if (!range) return null;
  if (temp == null || temp === '') return null;
  const t = Number(temp);
  if (!Number.isFinite(t)) return null;
  // Frozen: only upper limit (colder is OK)
  if (range.min == null) {
    if (t > range.max) return 'high';
    return null;
  }
  if (t < range.min) return 'low';
  if (t > range.max) return 'high';
  return null;
}

export function dedupeInventoryLots(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const map = new Map();
  for (const r of rows) {
    if (!r) continue;
    const key = inventoryLotKey(r);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, r);
      continue;
    }
    const da = String(r.last_audit_date || r.formatted_date || r.entry_date || '').slice(0, 10);
    const db = String(prev.last_audit_date || prev.formatted_date || prev.entry_date || '').slice(
      0,
      10
    );
    if (da > db) {
      map.set(key, r);
      continue;
    }
    if (da < db) continue;
    const idA = Number(r.id) || 0;
    const idB = Number(prev.id) || 0;
    if (idA > idB) {
      map.set(key, r);
      continue;
    }
    const physA = Math.max(0, Number(r.physical_audit_count) || 0);
    const physB = Math.max(0, Number(prev.physical_audit_count) || 0);
    if (idA === idB && physA >= physB) map.set(key, r);
  }
  return Array.from(map.values());
}
