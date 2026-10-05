/**
 * Offline dock upload builders (src/utils/offlineLogFormData.js).
 * WHAT: Turns queued SQLite inward/outward rows into multipart FormData for syncEngine.
 * WHY: syncEngine should not duplicate field lists and photo attachment logic.
 * HOW: JSON.parse form/photos, append fields, appendLocalFile for each image URI.
 */
import { convertYYYYMMDDToDDMMYYYY } from './inwardValidation';
import { buildPhotoMetadataPayload } from './photoCaptureMeta';
import { appendLocalFile, localFileExists } from './formDataAppendFile';

/** WHAT: Inward form photo keys for sync and metadata. WHY: Single list for append + validation. */
export const INWARD_PHOTO_FIELDS = [
  { key: 'inward_invoice_photos', multi: true },
  { key: 'inward_pod_photo', multi: false },
  { key: 'inward_vehicle_seal_photo', multi: false },
  { key: 'inward_vehicle_temp_photo', multi: false },
  { key: 'inward_material_temp_photo', multi: false },
  { key: 'inward_vehicle_back_side_photo', multi: false },
  { key: 'inward_vehicle_back_side_photo_with_material', multi: false },
  { key: 'inward_count_sheet_photo', multi: true },
  { key: 'inward_damage_boxes_photo', multi: true },
];

/** WHAT: Outward form photo keys for sync and metadata. WHY: Mirror inward field list. */
export const OUTWARD_PHOTO_FIELDS = [
  { key: 'outward_invoice_photos', multi: true },
  { key: 'outward_pre_vehicle_temp_photo', multi: false },
  { key: 'outward_material_temp_photo', multi: false },
  { key: 'outward_vehicle_back_side_photo', multi: false },
  { key: 'outward_vehicle_back_side_photo_with_material', multi: false },
  { key: 'outward_count_sheet_photo', multi: true },
  { key: 'outward_pod_photo', multi: false },
  { key: 'outward_vehicle_seal_photo', multi: false },
  { key: 'outward_damage_boxes_photo', multi: true },
];

function appendPhotoToFormData(formData, fieldKey, photoValue, multi) {
  if (multi) {
    (photoValue || []).forEach((item, idx) => {
      if (!item?.uri) return;
      appendLocalFile(formData, fieldKey, item.uri, {
        name: `${fieldKey}-${idx + 1}.jpg`,
        type: 'image/jpeg',
      });
    });
    return;
  }
  if (photoValue?.uri) {
    appendLocalFile(formData, fieldKey, photoValue.uri, {
      name: `${fieldKey}.jpg`,
      type: 'image/jpeg',
    });
  }
}

function extractClockTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.includes(' ') ? raw.split(' ').pop() : raw;
}

/**
 * WHAT: Finds photo URIs in a map that no longer exist on disk.
 * WHY: Sync must fail early instead of uploading empty parts.
 * HOW: localFileExists on each uri in arrays or single photo objects.
 */
export async function collectMissingPhotoUris(photos = {}) {
  const missing = [];
  if (!photos || typeof photos !== 'object') return missing;

  for (const value of Object.values(photos)) {
    const items = Array.isArray(value) ? value : value?.uri ? [value] : [];
    for (const item of items) {
      if (!item?.uri) continue;
      const ok = await localFileExists(item.uri);
      if (!ok) missing.push(String(item.uri));
    }
  }
  return missing;
}

/**
 * Preflight for sync queue — throw if any photo file is gone.
 * Mirrors inspection sensor-photo existence check.
 */
export async function assertQueuePhotosExist(record) {
  let photos = {};
  try {
    photos = JSON.parse(record?.photos_json || '{}');
  } catch (_) {
    photos = {};
  }
  const missing = await collectMissingPhotoUris(photos);
  if (missing.length) {
    throw new Error(
      'Photo file(s) missing on device. Open the form, capture photos again, then sync.'
    );
  }
}

/**
 * WHAT: Builds FormData for POST /api/inward from a local_inward_logs row.
 * WHY: syncEngine calls this inside the upload loop.
 * HOW: Flatten form keys, format dates, append photos and metadata JSON.
 */
export function buildInwardFormData(record) {
  const form = JSON.parse(record.form_json || '{}');
  const photos = JSON.parse(record.photos_json || '{}');
  const driverCountryCode = record.driver_country_code || '+91';
  const formData = new FormData();

  const startDate = form.inward_unloading_start_date || form.inward_entry_date;
  const endDate = form.inward_unloading_end_date || form.inward_entry_date;

  Object.keys(form).forEach((key) => {
    if (key === 'inward_driver_no') {
      const fullPhone = form.inward_driver_no
        ? `${driverCountryCode} ${String(form.inward_driver_no).replace(/\D/g, '')}`
        : '';
      formData.append('inward_driver_no', fullPhone);
    } else if (key === 'inward_unloading_start_time') {
      const startTime = extractClockTime(form.inward_unloading_start_time);
      formData.append(
        'inward_unloading_start_time',
        startTime ? `${convertYYYYMMDDToDDMMYYYY(startDate)} ${startTime}` : ''
      );
    } else if (key === 'inward_unloading_end_time') {
      const rawTime = extractClockTime(form.inward_unloading_end_time);
      formData.append(
        'inward_unloading_end_time',
        rawTime ? `${convertYYYYMMDDToDDMMYYYY(endDate)} ${rawTime}` : ''
      );
    } else if (key === 'inward_unloading_start_date' || key === 'inward_unloading_end_date') {
      // merged into start/end time
    } else {
      formData.append(key, form[key] ?? '');
    }
  });

  INWARD_PHOTO_FIELDS.forEach(({ key, multi }) => {
    appendPhotoToFormData(formData, key, photos[key], multi);
  });

  if (record.warehouse_name) {
    formData.append('warehouse_name', String(record.warehouse_name).trim());
  }
  if (record.warehouse_code) {
    formData.append('warehouse_code', String(record.warehouse_code).trim());
  }
  if (record.operator_email) {
    formData.append('operator_email', String(record.operator_email).trim());
  }

  const photoMeta = buildPhotoMetadataPayload(photos, INWARD_PHOTO_FIELDS);
  if (photoMeta) {
    formData.append('photo_capture_metadata', JSON.stringify(photoMeta));
  }
  if (record.id) {
    formData.append('client_submission_id', String(record.id));
  }
  if (record.created_at) {
    formData.append('client_submitted_at', String(record.created_at));
  }

  return formData;
}

/** WHAT: FormData for POST outward from local_outward_logs. WHY/HOW: Same pattern as buildInwardFormData. */
export function buildOutwardFormData(record) {
  const form = JSON.parse(record.form_json || '{}');
  const photos = JSON.parse(record.photos_json || '{}');
  const driverCountryCode = record.driver_country_code || '+91';
  const formData = new FormData();

  const startDate = form.outward_loading_start_date || form.outward_entry_date;
  const endDate = form.outward_loading_end_date || form.outward_entry_date;

  Object.keys(form).forEach((key) => {
    if (key === 'outward_driver_no') {
      const fullPhone = form.outward_driver_no
        ? `${driverCountryCode} ${String(form.outward_driver_no).replace(/\D/g, '')}`
        : '';
      formData.append('outward_driver_no', fullPhone);
    } else if (key === 'outward_loading_start_time') {
      const startTime = extractClockTime(form.outward_loading_start_time);
      formData.append(
        'outward_loading_start_time',
        startTime ? `${convertYYYYMMDDToDDMMYYYY(startDate)} ${startTime}` : ''
      );
    } else if (key === 'outward_loading_end_time') {
      const rawTime = extractClockTime(form.outward_loading_end_time);
      formData.append(
        'outward_loading_end_time',
        rawTime ? `${convertYYYYMMDDToDDMMYYYY(endDate)} ${rawTime}` : ''
      );
    } else if (key === 'outward_loading_start_date' || key === 'outward_loading_end_date') {
      // merged into start/end time
    } else {
      formData.append(key, form[key] ?? '');
    }
  });

  OUTWARD_PHOTO_FIELDS.forEach(({ key, multi }) => {
    appendPhotoToFormData(formData, key, photos[key], multi);
  });

  const preVehiclePhoto = photos.outward_pre_vehicle_temp_photo;
  if (preVehiclePhoto?.uri) {
    appendPhotoToFormData(formData, 'outward_vehicle_temp_photo', preVehiclePhoto, false);
  }

  if (record.warehouse_name) {
    formData.append('warehouse_name', String(record.warehouse_name).trim());
  }
  if (record.warehouse_code) {
    formData.append('warehouse_code', String(record.warehouse_code).trim());
  }
  if (record.operator_email) {
    formData.append('operator_email', String(record.operator_email).trim());
  }

  const photoMeta = buildPhotoMetadataPayload(photos, OUTWARD_PHOTO_FIELDS);
  if (photoMeta) {
    formData.append('photo_capture_metadata', JSON.stringify(photoMeta));
  }
  if (record.id) {
    formData.append('client_submission_id', String(record.id));
  }
  if (record.created_at) {
    formData.append('client_submitted_at', String(record.created_at));
  }

  return formData;
}

/** WHAT: Short label for sync UI for one inward queue row. HOW: Parse vehicle + client from form_json. */
export function describeInwardQueueItem(record) {
  try {
    const form = JSON.parse(record.form_json || '{}');
    const vehicle = form.inward_vehicle_no || 'Vehicle';
    const client = form.inward_client_name || 'Client';
    return `Inward · ${vehicle} · ${client}`;
  } catch (_) {
    return `Inward · ${record.id}`;
  }
}

/** WHAT: Short label for sync UI for one outward queue row. HOW: Parse vehicle + client from form_json. */
export function describeOutwardQueueItem(record) {
  try {
    const form = JSON.parse(record.form_json || '{}');
    const vehicle = form.outward_vehicle_no || 'Vehicle';
    const client = form.outward_client_name || 'Client';
    return `Outward · ${vehicle} · ${client}`;
  } catch (_) {
    return `Outward · ${record.id}`;
  }
}
