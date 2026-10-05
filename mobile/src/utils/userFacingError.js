/**
 * WHAT: Converts technical errors into short messages for alerts and banners.
 * WHY: Users cannot fix "Network request failed" without a plain-language hint.
 * HOW: Pattern-match common fetch/auth/timeout strings and optionally prefix with context.
 */
export function formatUserError(err, { apiUrl, context } = {}) {
  const raw = String(err?.message || err || '').trim();
  if (!raw) {
    return context ? `${context}. Please try again.` : 'Something went wrong. Please try again.';
  }
  if (raw === 'Network request failed' || /network request failed/i.test(raw)) {
    const host = apiUrl ? String(apiUrl).replace(/\/$/, '') : '';
    return host
      ? `Cannot reach server (${host}). Check WiFi/mobile data or API URL in login settings.`
      : 'Cannot reach server. Check your internet connection and try again.';
  }
  if (/401|unauthorized|session expired|account not found/i.test(raw)) {
    return 'Session expired. Logout and sign in again.';
  }
  if (/timeout|timed out/i.test(raw)) {
    return 'Request timed out. Check connection and retry.';
  }
  if (context && !raw.toLowerCase().includes(context.toLowerCase())) {
    return `${context}: ${raw}`;
  }
  return raw;
}
