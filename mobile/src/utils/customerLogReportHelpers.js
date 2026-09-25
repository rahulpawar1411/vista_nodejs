export const DOCK_REPORT_PAGE_SIZE = 20;

export function splitLogPhotoPaths(value) {
  if (!value) return [];
  const raw = String(value).trim();
  if (!raw) return [];
  // Multiple Cloudinary/HTTP URLs joined by comma
  if (/^https?:\/\//i.test(raw)) {
    return raw
      .split(/,\s*(?=https?:\/\/)/i)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'null' && s !== 'undefined');
}

/** Map a Cloudinary CRM asset URL back to local uploads/crm/… path. */
export function cloudinaryUrlToUploadsPath(raw) {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!/^https?:\/\/res\.cloudinary\.com\//i.test(value)) return null;
  const match = value.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\?|$)/i);
  if (!match) return null;
  let rest = match[1];
  if (rest.startsWith('crm/')) rest = rest.slice(4);
  if (
    !/^(outward_images|inward_images|daily_temp_monitor_images)\//i.test(rest)
  ) {
    return null;
  }
  return `uploads/crm/${rest}`;
}

/** Map uploads/… path → Cloudinary CDN URL (same public_id / folder). */
export function uploadsPathToCloudinaryUrl(raw, cloudName = 'de9ba8bpk') {
  if (raw == null) return null;
  const value = String(raw).trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!value.startsWith('uploads/')) return null;
  const match = value.match(
    /^uploads\/(?:crm\/)?(outward_images|inward_images|daily_temp_monitor_images)\/(.+)$/i
  );
  if (!match || !match[2]) return null;
  const file = String(match[2]).replace(/\.(jpe?g|png|webp|gif)$/i, '');
  return `https://res.cloudinary.com/${cloudName}/image/upload/crm/${match[1]}/${file}`;
}

/** Default Cloudinary cloud (production photos live here, not on Render disk). */
const DEFAULT_CLOUDINARY_CLOUD =
  (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME) ||
  'de9ba8bpk';

/**
 * Resolve image URL for React Native.
 * Prefer Cloudinary CDN — Render ephemeral disk often 404s on /uploads/*.
 */
export function resolveLogImageUrl(raw, baseUrl, folderHint = 'daily_temp_monitor_images') {
  if (raw == null) return null;
  let value = String(raw).trim();
  if (!value || value === 'null' || value === 'undefined') return null;
  if (value.startsWith('file://') || value.startsWith('content://') || value.startsWith('data:')) {
    return value;
  }
  const looksBase64 =
    value.length > 200 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    /^[A-Za-z0-9+/=\s]+$/.test(value.slice(0, 200));
  if (looksBase64 || value.startsWith('/9j/') || value.startsWith('iVBOR')) {
    const mime = value.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${value.replace(/\s/g, '')}`;
  }

  const base = String(baseUrl || '').replace(/\/$/, '');

  // Full Cloudinary URL → use CDN directly (do NOT rewrite to Render /uploads)
  if (/^https?:\/\/res\.cloudinary\.com\//i.test(value)) {
    return value;
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  value = value.replace(/\\/g, '/').replace(/^\/+/, '');

  // Relative uploads/… → Cloudinary public URL first
  if (value.startsWith('uploads/')) {
    const cdn = uploadsPathToCloudinaryUrl(value, DEFAULT_CLOUDINARY_CLOUD);
    if (cdn) return cdn;
    if (!base) return null;
    return `${base}/${value}`;
  }

  if (!base) {
    const asUploads = `uploads/crm/${folderHint}/${value}`.replace(/\/+/g, '/');
    const cdn = uploadsPathToCloudinaryUrl(
      value.includes('/') ? `uploads/${value}` : asUploads,
      DEFAULT_CLOUDINARY_CLOUD
    );
    if (cdn) return cdn;
    return null;
  }

  if (!value.includes('/')) {
    const relative = `uploads/crm/${folderHint}/${value}`;
    const cdn = uploadsPathToCloudinaryUrl(relative, DEFAULT_CLOUDINARY_CLOUD);
    if (cdn) return cdn;
    return `${base}/uploads/${folderHint}/${value}`;
  }

  const maybeUploads = value.startsWith('crm/') ? `uploads/${value}` : value;
  const cdn = uploadsPathToCloudinaryUrl(
    maybeUploads.startsWith('uploads/') ? maybeUploads : `uploads/${maybeUploads}`,
    DEFAULT_CLOUDINARY_CLOUD
  );
  if (cdn) return cdn;
  return `${base}/${value}`;
}

/** Ordered candidates: Cloudinary first, then API /uploads fallback. */
export function resolveLogImageUrlCandidates(raw, baseUrl, folderHint = 'daily_temp_monitor_images') {
  const out = [];
  const push = (u) => {
    if (u && !out.includes(u)) out.push(u);
  };
  if (raw == null) return out;
  const value = String(raw).trim();
  if (!value) return out;

  const base = String(baseUrl || '').replace(/\/$/, '');
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');

  if (/^https?:\/\/res\.cloudinary\.com\//i.test(value)) {
    push(value);
    const local = cloudinaryUrlToUploadsPath(value);
    if (local && base) push(`${base}/${local}`);
    return out;
  }

  if (/^https?:\/\//i.test(value)) {
    push(value);
    return out;
  }

  if (normalized.startsWith('uploads/')) {
    push(uploadsPathToCloudinaryUrl(normalized, DEFAULT_CLOUDINARY_CLOUD));
    if (base) push(`${base}/${normalized}`);
  } else if (!normalized.includes('/')) {
    const relative = `uploads/crm/${folderHint}/${normalized}`;
    push(uploadsPathToCloudinaryUrl(relative, DEFAULT_CLOUDINARY_CLOUD));
    if (base) push(`${base}/uploads/${folderHint}/${normalized}`);
  } else {
    push(resolveLogImageUrl(value, baseUrl, folderHint));
    if (base) push(`${base}/${normalized}`);
  }

  return out;
}

export function parsePhotoCaptureMetadata(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    let parsed = JSON.parse(String(raw));
    if (typeof parsed === 'string') {
      parsed = JSON.parse(parsed);
    }
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function formatPhotoGps(lat, lng, accuracy) {
  const latitude = parseFloat(lat);
  const longitude = parseFloat(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
  const acc =
    accuracy != null && Number.isFinite(parseFloat(accuracy))
      ? ` (±${Math.round(parseFloat(accuracy))}m)`
      : '';
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}${acc}`;
}

export function formatPhotoCaptureMetadataLines(raw) {
  const meta = parsePhotoCaptureMetadata(raw);
  if (!meta || typeof meta !== 'object') return [];
  return Object.entries(meta).flatMap(([field, val]) => {
    const entries = Array.isArray(val) ? val : val && typeof val === 'object' ? [val] : [];
    return entries
      .map((entry, idx) => {
        if (!entry || typeof entry !== 'object') return null;
        const label = field.replace(/^(inward_|outward_)/, '').replace(/_/g, ' ');
        const time = entry.capturedAt ? String(entry.capturedAt) : '';
        const gps = formatPhotoGps(entry.latitude, entry.longitude, entry.accuracy);
        const parts = [`${label}${entries.length > 1 ? ` ${idx + 1}` : ''}`];
        if (time) parts.push(time);
        if (gps) parts.push(gps);
        return parts.length > 1 ? parts.join(' · ') : null;
      })
      .filter(Boolean);
  });
}

/** Resolve one photo's capture metadata entry from the stored JSON payload. */
export function resolvePhotoMetaEntry(raw, fieldKey, index = 0) {
  const meta = parsePhotoCaptureMetadata(raw);
  if (!meta || !fieldKey) return null;
  const val = meta[fieldKey];
  if (!val) return null;
  if (Array.isArray(val)) return val[index] || null;
  return index === 0 ? val : null;
}

/** Human-readable time + GPS lines for a single photo metadata entry. */
export function formatPhotoMetaCaption(entry) {
  if (!entry || typeof entry !== 'object') return { time: '', gps: '', hasGps: false };
  const time = entry.capturedAt ? String(entry.capturedAt) : '';
  const gps = formatPhotoGps(entry.latitude, entry.longitude, entry.accuracy);
  const hasGps = Boolean(gps);
  return { time, gps, hasGps };
}

export function formatChamberPhotoGps(log) {
  if (!log) return '';
  return formatPhotoGps(log.photo_capture_latitude, log.photo_capture_longitude, log.photo_capture_accuracy);
}

/** Open coordinates via OS map intent (Android app chooser / iOS Maps). */
export function openLocationInMaps(lat, lng) {
  const latitude = parseFloat(lat);
  const longitude = parseFloat(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

  const { Linking, Platform } = require('react-native');

  const label = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  const googleWeb = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
  const url =
    Platform.OS === 'android'
      ? `geo:${latitude},${longitude}?q=${latitude},${longitude}(${encodeURIComponent(label)})`
      : Platform.OS === 'ios'
        ? `http://maps.apple.com/?ll=${latitude},${longitude}&q=${encodeURIComponent(label)}`
        : googleWeb;

  Linking.openURL(url).catch(() => Linking.openURL(googleWeb).catch(() => {}));
}

export function resolveDockImageUrl(raw, apiUrl, productionApiUrl, folderHint) {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value || value === 'null' || value === 'undefined') return null;

  const bases = [apiUrl, productionApiUrl]
    .filter(Boolean)
    .map((b) => String(b).replace(/\/$/, ''));

  for (const base of bases) {
    const resolved = resolveLogImageUrl(value, base, folderHint);
    if (resolved) return resolved;
  }
  return resolveLogImageUrl(value, bases[0] || '', folderHint);
}

/** Shared inward/outward photo grid items (Sub-Admin + Customer log detail). */
export function buildInwardOutwardPhotoItems(log) {
  if (!log) return [];
  const isInward = log._logType === 'inward';
  const groups = isInward
    ? [
        { label: 'Invoice', fieldKey: 'inward_invoice_photos', paths: splitLogPhotoPaths(log.inward_invoice_photos) },
        { label: 'Vehicle temp', fieldKey: 'inward_vehicle_temp_photo', paths: splitLogPhotoPaths(log.inward_vehicle_temp_photo) },
        { label: 'Material temp', fieldKey: 'inward_material_temp_photo', paths: splitLogPhotoPaths(log.inward_material_temp_photo) },
        { label: 'Vehicle back', fieldKey: 'inward_vehicle_back_side_photo', paths: splitLogPhotoPaths(log.inward_vehicle_back_side_photo) },
        {
          label: 'Back with material',
          fieldKey: 'inward_vehicle_back_side_photo_with_material',
          paths: splitLogPhotoPaths(log.inward_vehicle_back_side_photo_with_material)
        },
        { label: 'Count sheet', fieldKey: 'inward_count_sheet_photo', paths: splitLogPhotoPaths(log.inward_count_sheet_photo) },
        { label: 'Seal', fieldKey: 'inward_vehicle_seal_photo', paths: splitLogPhotoPaths(log.inward_vehicle_seal_photo) },
        { label: 'POD', fieldKey: 'inward_pod_photo', paths: splitLogPhotoPaths(log.inward_pod_photo) },
        { label: 'Damage boxes', fieldKey: 'inward_damage_boxes_photo', paths: splitLogPhotoPaths(log.inward_damage_boxes_photo) }
      ]
    : [
        { label: 'Invoice', fieldKey: 'outward_invoice_photos', paths: splitLogPhotoPaths(log.outward_invoice_photos) },
        {
          label: 'Pre vehicle temp',
          fieldKey: 'outward_pre_vehicle_temp_photo',
          paths: splitLogPhotoPaths(log.outward_pre_vehicle_temp_photo || log.outward_vehicle_temp_photo)
        },
        { label: 'Material temp', fieldKey: 'outward_material_temp_photo', paths: splitLogPhotoPaths(log.outward_material_temp_photo) },
        { label: 'Vehicle back', fieldKey: 'outward_vehicle_back_side_photo', paths: splitLogPhotoPaths(log.outward_vehicle_back_side_photo) },
        {
          label: 'Back with material',
          fieldKey: 'outward_vehicle_back_side_photo_with_material',
          paths: splitLogPhotoPaths(log.outward_vehicle_back_side_photo_with_material)
        },
        { label: 'Count sheet', fieldKey: 'outward_count_sheet_photo', paths: splitLogPhotoPaths(log.outward_count_sheet_photo) },
        { label: 'Seal', fieldKey: 'outward_vehicle_seal_photo', paths: splitLogPhotoPaths(log.outward_vehicle_seal_photo) },
        { label: 'POD', fieldKey: 'outward_pod_photo', paths: splitLogPhotoPaths(log.outward_pod_photo) },
        { label: 'Damage boxes', fieldKey: 'outward_damage_boxes_photo', paths: splitLogPhotoPaths(log.outward_damage_boxes_photo) }
      ];

  return groups
    .filter((g) => g.paths.length > 0)
    .flatMap((group) =>
      group.paths.map((path, idx) => ({
        key: `${group.fieldKey}-${idx}`,
        label: group.paths.length > 1 ? `${group.label} ${idx + 1}` : group.label,
        path,
        fieldKey: group.fieldKey,
        photoIndex: idx
      }))
    );
}
