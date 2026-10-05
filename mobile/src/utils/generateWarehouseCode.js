/**
 * Warehouse master codes (src/utils/generateWarehouseCode.js).
 * WHAT: Auto-suggest WH-CITY-01 style warehouse codes.
 * WHY: Sub-Admin master setup needs non-colliding codes per site name.
 * HOW: Slug warehouse name and increment suffix against existingCodes list.
 */

function slugPart(value, maxLen = 12) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, maxLen);
}

/** WHAT: Slug from warehouse name only (city ignored). WHY: Stable code from display name. */
export function warehouseCodeSlug(warehouseName, _city) {
  return slugPart(warehouseName, 12);
}

/**
 * WHAT: Next available WH-{slug}-NN code for a new warehouse row.
 * WHY: Avoid duplicate master codes when adding similar site names.
 * HOW: Regex-scan existingCodes for highest suffix and add one.
 */
export function generateWarehouseCode(warehouseName, city, existingCodes = []) {
  const slug = warehouseCodeSlug(warehouseName, city);
  if (!slug) return '';
  const prefix = `WH-${slug}`;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}(?:-(\\d+))?$`, 'i');
  let max = 0;
  (existingCodes || []).forEach((raw) => {
    const code = String(raw || '').trim().toUpperCase();
    const m = code.match(re);
    if (!m) return;
    const n = m[1] ? parseInt(m[1], 10) : 1;
    if (Number.isFinite(n) && n > max) max = n;
  });
  const next = max + 1;
  return `${prefix}-${String(next).padStart(2, '0')}`.slice(0, 48);
}
