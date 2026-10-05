/**
 * WHAT: Default FlatList props tuned for long log lists on mid-range phones.
 * WHY: Rendering thousands of rows at once causes jank and memory pressure.
 * HOW: Spread {...FLATLIST_PERF_PROPS} onto FlatList in screen components.
 */
export const FLATLIST_PERF_PROPS = {
  initialNumToRender: 12,
  maxToRenderPerBatch: 8,
  windowSize: 7,
  updateCellsBatchingPeriod: 50,
  removeClippedSubviews: true,
};

/**
 * WHAT: Decides if the UI should show a full-screen loading state.
 * WHY: First fetch with zero rows feels empty without a spinner; refresh should not blank the list.
 * HOW: loading true, not refreshing, and itemCount is zero.
 */
export function isBlockingListLoad(loading, refreshing, itemCount) {
  return Boolean(loading && !refreshing && !(itemCount > 0));
}

/**
 * WHAT: Decides if a soft overlay spinner should show over an existing list.
 * WHY: Pull-to-refresh should keep visible rows to avoid flicker.
 * HOW: loading true, not refreshing, but itemCount already greater than zero.
 */
export function isSoftListLoad(loading, refreshing, itemCount) {
  return Boolean(loading && !refreshing && itemCount > 0);
}
