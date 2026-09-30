/**
 * Build report reading rows with correct In / Out / Qty.
 * Example: prev 65 → next 60 ⇒ Out 5, Qty 60 (stock left).
 *
 * Computes deltas in oldest→newest order, then returns newest-first for UI.
 */
export function buildReportReadingRows(items) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const dateOf = (row) => String(row.formatted_date || row.entry_date || '').slice(0, 10);

  const shiftRank = (row) => {
    const s = String(row.shift || row.inspection_time || '').toLowerCase();
    if (s.includes('evening') || s.startsWith('16') || s.startsWith('18') || s.includes('04:00')) {
      return 2;
    }
    if (s.includes('morning') || s.startsWith('10') || s.includes('10:00')) return 1;
    return 0;
  };

  const timeKey = (row) => {
    const candidates = [
      row.created_at,
      row.submit_time,
      row.photo_capture_time,
      row.inspection_time
    ];
    for (const c of candidates) {
      if (c == null || c === '') continue;
      const raw = String(c).trim();
      if (/^\d{1,2}:\d{2}/.test(raw)) {
        const m = raw.match(/^(\d{1,2}):(\d{2})/);
        if (m) return `${String(parseInt(m[1], 10)).padStart(2, '0')}:${m[2]}:00`;
      }
      const d = new Date(c);
      if (!Number.isNaN(d.getTime())) {
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      }
    }
    return '';
  };

  const qtyOf = (row) => {
    if (!row) return null;
    const raw = row.box_count ?? row.physical_audit_count ?? row.count;
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, n) : null;
  };

  // Oldest → newest (so step = current - previous)
  const chrono = [...items].sort((a, b) => {
    const da = dateOf(a);
    const db = dateOf(b);
    if (da !== db) return da.localeCompare(db);
    const sa = shiftRank(a);
    const sb = shiftRank(b);
    if (sa !== sb) return sa - sb;
    const ta = timeKey(a);
    const tb = timeKey(b);
    if (ta && tb && ta !== tb) return ta.localeCompare(tb);
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });

  // Prefer rows with box count for stock trail; keep others after
  const withQty = chrono.filter((r) => qtyOf(r) != null);
  const trail = withQty.length ? withQty : chrono;

  const enriched = trail.map((row, idx) => {
    const qty = qtyOf(row);
    // Previous reading that also had a qty (skip nulls)
    let prevQty = null;
    for (let i = idx - 1; i >= 0; i -= 1) {
      const q = qtyOf(trail[i]);
      if (q != null) {
        prevQty = q;
        break;
      }
    }
    let inQty = '—';
    let outQty = '—';
    if (qty != null && prevQty != null) {
      const step = qty - prevQty;
      if (step > 0) {
        inQty = String(step);
        outQty = '—';
      } else if (step < 0) {
        inQty = '—';
        outQty = String(Math.abs(step));
      } else {
        inQty = '0';
        outQty = '0';
      }
    }
    return {
      ...row,
      _qty: qty,
      _inQty: inQty,
      _outQty: outQty
    };
  });

  // Newest first for reading UI
  return enriched.reverse();
}

/** Latest stock left from reading rows (newest qty). */
export function latestReadingQty(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const q = rows[0]?._qty;
  return q == null ? null : q;
}
