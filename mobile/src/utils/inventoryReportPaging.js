/**
 * Inventory report paging (src/utils/inventoryReportPaging.js).
 * WHAT: Builds API query strings and parses paged inventory reconciliation responses.
 * WHY: Large warehouses need load-more instead of one giant fetch.
 * HOW: offset/limit constants plus helpers for has-more detection.
 */
export const INVENTORY_REPORT_FIRST_PAGE = 15;
export const INVENTORY_REPORT_MORE_PAGE = 15;

/**
 * WHAT: URLSearchParams for GET /inventory reconciliation with filters.
 * WHY: Screens share the same paging and filter encoding.
 * HOW: Sets offset, limit, optional warehouse, client, and mismatch view.
 */
export function buildInventoryReconciliationQuery({
  offset = 0,
  limit = INVENTORY_REPORT_FIRST_PAGE,
  warehouse,
  client,
  view
} = {}) {
  const qs = new URLSearchParams({
    offset: String(Math.max(0, Number(offset) || 0)),
    limit: String(limit)
  });
  if (warehouse && warehouse !== 'All') qs.set('warehouse', String(warehouse).trim());
  if (client && client !== 'All') qs.set('client', String(client).trim());
  if (view === 'mismatch') qs.set('view', 'mismatch');
  return qs;
}

/** WHAT: Normalizes API JSON into { rows, total }. WHY: Backend shape varies slightly. HOW: Prefer data.items array. */
export function parseInventoryReconciliationPayload(data) {
  const rows = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data)
      ? data
      : [];
  const total = Number(data?.total ?? rows.length) || 0;
  return { rows, total };
}

/** WHAT: True if another page of inventory rows exists. HOW: offset + fetchedCount < total. */
export function inventoryReportHasMore(offset, fetchedCount, total) {
  const nextOffset = Number(offset) + Number(fetchedCount);
  return nextOffset < Number(total || 0);
}
