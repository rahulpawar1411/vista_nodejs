/** Reports inventory lists: 15 rows per page (first load + load-more). */
export const INVENTORY_REPORT_FIRST_PAGE = 15;
export const INVENTORY_REPORT_MORE_PAGE = 15;

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

export function parseInventoryReconciliationPayload(data) {
  const rows = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data)
      ? data
      : [];
  const total = Number(data?.total ?? rows.length) || 0;
  return { rows, total };
}

export function inventoryReportHasMore(offset, fetchedCount, total) {
  const nextOffset = Number(offset) + Number(fetchedCount);
  return nextOffset < Number(total || 0);
}
