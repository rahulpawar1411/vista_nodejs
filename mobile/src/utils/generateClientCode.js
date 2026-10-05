/**
 * Client master codes (src/utils/generateClientCode.js).
 * WHAT: Builds CL-WH-CLIENT style codes for new client master rows.
 * WHY: Super Admin / Sub-Admin catalog needs unique readable identifiers.
 * HOW: Slug client and warehouse names, then prefix with CL-.
 */

/** WHAT: Uppercase hyphen slug from arbitrary text. HOW: Strip non-alphanumerics and trim length. */
function slugPart(value, maxLen = 14) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, maxLen);
}

function warehouseToken(warehouseName, warehouseCode) {
  const code = String(warehouseCode || '').trim().toUpperCase();
  if (code) {
    const stripped = code.replace(/^WH-/i, '');
    if (stripped) return slugPart(stripped, 10);
  }
  const name = String(warehouseName || '').trim();
  if (!name) return '';
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return words
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 8);
  }
  return slugPart(words[0], 10);
}

function clientToken(clientName) {
  const name = String(clientName || '').trim();
  if (!name) return '';
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words[0].length <= 6) {
    return slugPart(words[0], 12);
  }
  return slugPart(name.replace(/\s+/g, '-'), 16);
}

/**
 * WHAT: Produces a new client code string for master data entry.
 * WHY: Tied to warehouse so the same client name at two sites gets distinct codes.
 * HOW: clientToken + warehouseToken joined as CL-{wh}-{client}.
 */
export function generateClientCode(clientName, warehouseName, warehouseCode) {
  const clientPart = clientToken(clientName);
  if (!clientPart) return '';
  const whPart = warehouseToken(warehouseName, warehouseCode);
  const raw = whPart ? `CL-${whPart}-${clientPart}` : `CL-${clientPart}`;
  return raw.replace(/-+/g, '-').slice(0, 48);
}
