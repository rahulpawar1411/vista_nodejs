/**
 * Multipart uploads for Expo SDK 53+.
 * Expo's winter `fetch` rejects RN `{ uri, name, type }` FormData parts.
 * XMLHttpRequest still uses React Native's native multipart encoder.
 */
import * as FileSystem from 'expo-file-system/legacy';

/**
 * WHAT: Ensures a photo path is a valid React Native file/content URI.
 * WHY: Camera and cache paths arrive in mixed formats before FormData upload.
 * HOW: Prefix file:// when given a bare absolute path.
 */
export function normalizeLocalFileUri(uri) {
  const path = String(uri || '').trim();
  if (!path) return '';
  if (
    path.startsWith('file://') ||
    path.startsWith('content://') ||
    path.startsWith('ph://') ||
    path.startsWith('asset:')
  ) {
    return path;
  }
  if (path.startsWith('/')) return `file://${path}`;
  return path;
}

/** WHAT: Checks if a local URI still points at a file on disk. WHY: Preflight before sync. HOW: FileSystem.getInfoAsync. */
export async function localFileExists(uri) {
  const path = normalizeLocalFileUri(uri);
  if (!path) return false;
  try {
    const info = await FileSystem.getInfoAsync(path);
    return Boolean(info?.exists);
  } catch (_) {
    return false;
  }
}

/**
 * WHAT: Adds one image file to FormData for multipart upload.
 * WHY: React Native expects { uri, name, type } objects, not Blob.
 * HOW: normalizeLocalFileUri then formData.append with JPEG defaults.
 */
export function appendLocalFile(formData, fieldName, uri, opts = {}) {
  if (!formData || !fieldName) return;
  const path = normalizeLocalFileUri(uri);
  if (!path) return;
  const name = opts.name || path.split('/').pop() || 'photo.jpg';
  const type = opts.type || 'image/jpeg';
  formData.append(fieldName, { uri: path, name, type });
}

/**
 * WHAT: HTTP client that uploads FormData with local file URIs on Expo.
 * WHY: fetch() in newer Expo builds rejects RN-style multipart parts.
 * HOW: XMLHttpRequest with same ok/status/json/text shape as fetch Response.
 */
export function multipartRequest(url, { method = 'POST', headers = {}, body, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      xhr.timeout = timeoutMs;

      Object.entries(headers || {}).forEach(([key, value]) => {
        if (value == null) return;
        // Let XHR set multipart boundary automatically
        if (String(key).toLowerCase() === 'content-type') return;
        xhr.setRequestHeader(String(key), String(value));
      });

      xhr.onload = () => {
        const status = xhr.status || 0;
        const responseText = xhr.responseText || '';
        resolve({
          ok: status >= 200 && status < 300,
          status,
          async text() {
            return responseText;
          },
          async json() {
            try {
              return responseText ? JSON.parse(responseText) : {};
            } catch (_) {
              return {};
            }
          },
        });
      };

      xhr.onerror = () => reject(new Error('Network request failed'));
      xhr.ontimeout = () => reject(new Error('Upload timed out'));
      xhr.send(body);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
