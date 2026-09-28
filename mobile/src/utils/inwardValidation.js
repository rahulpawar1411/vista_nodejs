// Client-side inward validation — mirrors backend/web rules

const REQUIRED_FIELDS = [
  ['inward_entry_date', 'Entry Date'],
  ['inward_client_name', 'Client Name'],
  ['inward_dock_no', 'Dock No.'],
  ['inward_material_type', 'Material Type'],
  ['inward_vehicle_no', 'Vehicle No.'],
  ['inward_invoice_no', 'Invoice No.'],
  ['inward_transporter_name', 'Transporter Name'],
  ['inward_driver_name', 'Driver Name'],
  ['inward_driver_no', 'Driver Phone No.'],
  ['inward_vehicle_reporting_time', 'Vehicle Reporting Time'],
  ['inward_unloading_start_time', 'Unloading Start Time'],
  ['inward_unloading_end_time', 'Unloading End Time'],
  ['inward_unloading_duration_hours', 'Unloading Duration Hours'],
  ['inward_unloading_duration_mins', 'Unloading Duration Mins'],
  ['inward_vehicle_temp', 'Vehicle Temp'],
  ['inward_material_temp', 'Material Temp'],
  ['inward_pallets_in_qty', 'Pallets In Qty'],
  ['inward_invoice_qty', 'Invoice Boxes Qty'],
  ['inward_received_boxes_qty', 'Boxes Received Qty'],
  ['inward_unloading_supervisor_name', 'Unloading Supervisor Name'],
];

const PHOTO_RULES = [
  { key: 'inward_invoice_photos', label: 'Invoice Photo', multi: true },
  { key: 'inward_vehicle_temp_photo', label: 'Vehicle Temp Photo', multi: false },
  { key: 'inward_material_temp_photo', label: 'Material Temp Photo', multi: false },
  { key: 'inward_vehicle_back_side_photo', label: 'Vehicle Back Photo', multi: false },
  { key: 'inward_vehicle_back_side_photo_with_material', label: 'Vehicle Back Photo With Material', multi: false },
  { key: 'inward_count_sheet_photo', label: 'Count Sheet Photo', multi: true },
];

function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

function normalizeEntryDate(val) {
  if (isBlank(val)) return null;
  const s = String(val).trim();
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const dmMatch = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (dmMatch) return `${dmMatch[3]}-${dmMatch[2]}-${dmMatch[1]}`;
  return s;
}

function cleanTimePart(t) {
  if (!t) return '';
  const s = String(t).trim();
  return s.includes(' ') ? s.split(/\s+/).pop() : s;
}

function extractDateAndTime(timeVal, fallbackEntryDate) {
  if (isBlank(timeVal)) return { date: null, time: null };
  const s = String(timeVal).trim();
  const dmMatch = s.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2}:\d{2})/);
  if (dmMatch) {
    return { date: `${dmMatch[3]}-${dmMatch[2]}-${dmMatch[1]}`, time: dmMatch[4].slice(0, 5) };
  }
  const fallbackDate = normalizeEntryDate(fallbackEntryDate);
  return { date: fallbackDate, time: cleanTimePart(s).slice(0, 5) };
}

function buildDateTime(dateStr, timeStr) {
  const date = normalizeEntryDate(dateStr);
  const time = cleanTimePart(timeStr);
  if (!date || !time) return null;
  const normalized = time.length === 5 ? `${time}:00` : time;
  const d = new Date(`${date}T${normalized}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getExpectedPhoneDigits(countryCode) {
  if (countryCode === '+91') return 10;
  if (['+971', '+966', '+61'].includes(countryCode)) return 9;
  if (countryCode === '+65') return 8;
  return 10;
}

/** Vehicle no — uppercase + auto hyphens (e.g. MH-12-QW-1234), max 10 alnum. */
export function formatVehicleNumber(value) {
  const raw = String(value ?? '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 10);
  if (raw.length <= 2) return raw;
  if (raw.length <= 4) return `${raw.slice(0, 2)}-${raw.slice(2)}`;
  if (raw.length <= 6) return `${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4)}`;
  return `${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`;
}

export function sanitizeSealNumber(value) {
  return String(value ?? '').toUpperCase();
}

export function sanitizePersonName(value) {
  return String(value ?? '').replace(/[^a-zA-Z\s]/g, '');
}

export function sanitizeClientName(value) {
  return String(value ?? '').replace(/[^a-zA-Z\s.\-]/g, '');
}

export function sanitizePhoneDigits(value, countryCode = '+91') {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.slice(0, getExpectedPhoneDigits(countryCode));
}

export function sanitizeIntegerField(value) {
  return String(value ?? '').replace(/\D/g, '');
}

export function sanitizeTemperature(value) {
  let clean = String(value ?? '').replace(/[^\d.\-]/g, '');
  if (clean.includes('-')) {
    const parts = clean.split('-');
    clean = (clean.startsWith('-') ? '-' : '') + parts.join('');
  }
  if (clean.includes('.')) {
    const parts = clean.split('.');
    clean = `${parts[0]}.${parts.slice(1).join('')}`;
  }
  return clean;
}

export function sanitizeTimeHHMM(value) {
  const digits = String(value ?? '').replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

export function sanitizeDateYYYYMMDD(value) {
  return String(value ?? '')
    .replace(/[^\d-]/g, '')
    .slice(0, 10);
}

export function clampUnloadingStartDate(value, entryDate) {
  const clean = sanitizeDateYYYYMMDD(value);
  if (!entryDate || !clean) return clean;
  return clean < entryDate ? entryDate : clean;
}

export function clampUnloadingEndDate(value, startDate, entryDate) {
  const minDate = startDate || entryDate;
  const clean = sanitizeDateYYYYMMDD(value);
  if (!minDate || !clean) return clean;
  return clean < minDate ? minDate : clean;
}

/** Mirror web InwardMonitor handleInputChange sanitizers. */
export function sanitizeInwardField(fieldName, value, context = {}) {
  const { driverCountryCode = '+91', entryDate = '', startDate = '' } = context;

  switch (fieldName) {
    case 'inward_vehicle_no':
      return formatVehicleNumber(value);
    case 'inward_seal_no':
      return sanitizeSealNumber(value);
    case 'inward_invoice_no':
      return sanitizeSealNumber(value);
    case 'inward_client_name':
      return sanitizeClientName(value);
    case 'inward_driver_name':
    case 'inward_transporter_name':
    case 'inward_unloading_supervisor_name':
      return sanitizePersonName(value);
    case 'inward_driver_no':
      return sanitizePhoneDigits(value, driverCountryCode);
    case 'inward_pallets_in_qty':
    case 'inward_invoice_qty':
    case 'inward_received_qty':
    case 'inward_received_boxes_qty':
    case 'inward_damage_received_boxes_qty':
    case 'inward_mens_power':
      return sanitizeIntegerField(value);
    case 'inward_vehicle_temp':
    case 'inward_material_temp':
      return sanitizeTemperature(value);
    case 'inward_vehicle_reporting_time':
    case 'inward_unloading_start_time':
    case 'inward_unloading_end_time':
      return sanitizeTimeHHMM(value);
    case 'inward_unloading_start_date':
      return clampUnloadingStartDate(value, entryDate);
    case 'inward_unloading_end_date':
      return clampUnloadingEndDate(value, startDate, entryDate);
    default:
      return value;
  }
}

function hasPhotoValue(val, multi) {
  if (multi) return Array.isArray(val) && val.length > 0;
  return !!val;
}

export function validateInwardForm(form, photos, driverCountryCode = '+91') {
  const missing = [];
  const missingKeys = [];

  const record = {
    ...form,
    inward_entry_date: normalizeEntryDate(form.inward_entry_date),
    inward_driver_no: form.inward_driver_no
      ? `${driverCountryCode} ${String(form.inward_driver_no).replace(/\D/g, '')}`
      : '',
    inward_received_boxes_qty:
      !isBlank(form.inward_received_boxes_qty) ? form.inward_received_boxes_qty : form.inward_received_qty,
  };

  for (const [key, label] of REQUIRED_FIELDS) {
    if (isBlank(record[key])) {
      missingKeys.push(key);
      missing.push(label);
    }
  }

  for (const rule of PHOTO_RULES) {
    if (!hasPhotoValue(photos[rule.key], rule.multi)) {
      missingKeys.push(rule.key);
      missing.push(rule.label);
    }
  }

  const damageQty = parseInt(record.inward_damage_received_boxes_qty, 10) || 0;
  if (damageQty > 0 && !hasPhotoValue(photos.inward_damage_boxes_photo, true)) {
    missingKeys.push('inward_damage_boxes_photo');
    missing.push('Damage Boxes Photo');
  }

  if (missing.length > 0) {
    return { ok: false, missing, missingKeys, message: 'Please fill all required fields.' };
  }

  const digits = String(form.inward_driver_no || '').replace(/\D/g, '');
  const expectedDigits = getExpectedPhoneDigits(driverCountryCode);
  if (digits.length < expectedDigits) {
    const message = `Invalid Phone Number: Please enter a valid ${expectedDigits}-digit mobile number for country code ${driverCountryCode}.`;
    return { ok: false, missing: [message], missingKeys: ['inward_driver_no'], message };
  }

  const entryDate = record.inward_entry_date;
  const startDate =
    normalizeEntryDate(form.inward_unloading_start_date) ||
    extractDateAndTime(form.inward_unloading_start_time, entryDate).date ||
    entryDate;
  const endDate =
    normalizeEntryDate(form.inward_unloading_end_date) ||
    extractDateAndTime(form.inward_unloading_end_time, entryDate).date ||
    entryDate;

  const reportingTime = cleanTimePart(form.inward_vehicle_reporting_time);
  const startTime = extractDateAndTime(form.inward_unloading_start_time, entryDate).time;
  const endTime = extractDateAndTime(form.inward_unloading_end_time, entryDate).time;

  if (entryDate && startDate === entryDate && reportingTime && startTime && startTime <= reportingTime) {
    const message = `Unloading Start Time must be later than Vehicle Reporting Time. Reporting: ${reportingTime}, Start: ${startTime}`;
    return { ok: false, missing: [message], missingKeys: ['inward_unloading_start_time'], message };
  }

  const startDateTime = buildDateTime(startDate, startTime);
  const endDateTime = buildDateTime(endDate, endTime);
  if (startDateTime && endDateTime && endDateTime.getTime() <= startDateTime.getTime()) {
    const message =
      startDate === endDate
        ? `Unloading End Time must be later than Unloading Start Time. Start: ${startTime}, End: ${endTime}`
        : 'Unloading End Date/Time must be later than Unloading Start Date/Time.';
    return { ok: false, missing: [message], missingKeys: ['inward_unloading_end_time'], message };
  }

  return { ok: true, missing: [], missingKeys: [] };
}

export const INWARD_STEP_COUNT = 7;

const STEP_REQUIRED_FIELDS = {
  1: [
    ['inward_client_name', 'Client Name'],
    ['inward_dock_no', 'Dock No.'],
    ['inward_material_type', 'Material Type'],
    ['inward_vehicle_no', 'Vehicle No.'],
    ['inward_invoice_no', 'Invoice No.'],
    ['inward_transporter_name', 'Transporter Name'],
    ['inward_driver_name', 'Driver Name'],
    ['inward_driver_no', 'Driver Phone No.'],
  ],
  2: [['inward_vehicle_reporting_time', 'Vehicle Reporting Time']],
  3: [
    ['inward_vehicle_temp', 'Vehicle Temp'],
    ['inward_material_temp', 'Material Temp'],
  ],
  4: [
    ['inward_unloading_start_date', 'Unloading Start Date'],
    ['inward_unloading_start_time', 'Unloading Start Time'],
  ],
  5: [],
  6: [
    ['inward_unloading_end_date', 'Unloading End Date'],
    ['inward_unloading_end_time', 'Unloading End Time'],
    ['inward_unloading_duration_hours', 'Unloading Duration Hours'],
    ['inward_unloading_duration_mins', 'Unloading Duration Mins'],
  ],
  7: [
    ['inward_pallets_in_qty', 'Pallets In Qty'],
    ['inward_invoice_qty', 'Invoice Boxes Qty'],
    ['inward_received_boxes_qty', 'Boxes Received Qty'],
    ['inward_unloading_supervisor_name', 'Unloading Supervisor Name'],
  ],
};

const STEP_REQUIRED_PHOTOS = {
  3: [
    { key: 'inward_vehicle_temp_photo', label: 'Vehicle Temp Photo', multi: false },
    { key: 'inward_vehicle_back_side_photo', label: 'Vehicle Back Photo', multi: false },
    {
      key: 'inward_vehicle_back_side_photo_with_material',
      label: 'Vehicle Back With Material',
      multi: false,
    },
  ],
  5: [
    { key: 'inward_material_temp_photo', label: 'Material Temp Photo', multi: false },
    { key: 'inward_invoice_photos', label: 'Invoice Photo', multi: true },
  ],
  7: [{ key: 'inward_count_sheet_photo', label: 'Count Sheet Photo', multi: true }],
};

const FIELD_TO_STEP = {
  inward_client_name: 1,
  inward_dock_no: 1,
  inward_material_type: 1,
  inward_vehicle_no: 1,
  inward_seal_no: 1,
  inward_invoice_no: 1,
  inward_mens_power: 1,
  inward_transporter_name: 1,
  inward_driver_name: 1,
  inward_driver_no: 1,
  inward_vehicle_reporting_time: 2,
  inward_vehicle_temp: 3,
  inward_material_temp: 3,
  inward_vehicle_seal_photo: 3,
  inward_vehicle_back_side_photo: 3,
  inward_vehicle_temp_photo: 3,
  inward_vehicle_back_side_photo_with_material: 3,
  inward_unloading_start_date: 4,
  inward_unloading_start_time: 4,
  inward_material_temp_photo: 5,
  inward_invoice_photos: 5,
  inward_pod_photo: 5,
  inward_unloading_end_date: 6,
  inward_unloading_end_time: 6,
  inward_unloading_duration_hours: 6,
  inward_unloading_duration_mins: 6,
  inward_pallets_in_qty: 7,
  inward_invoice_qty: 7,
  inward_received_boxes_qty: 7,
  inward_short_received_boxes_qty: 7,
  inward_excess_received_boxes_qty: 7,
  inward_damage_received_boxes_qty: 7,
  inward_count_sheet_photo: 7,
  inward_damage_boxes_photo: 7,
  inward_unloading_supervisor_name: 7,
  inward_remarks: 7,
};

export function getInwardStepForKey(key) {
  return FIELD_TO_STEP[key] || 1;
}

function buildStepRecord(form, driverCountryCode) {
  return {
    ...form,
    inward_entry_date: normalizeEntryDate(form.inward_entry_date),
    inward_driver_no: form.inward_driver_no
      ? `${driverCountryCode} ${String(form.inward_driver_no).replace(/\D/g, '')}`
      : '',
    inward_received_boxes_qty:
      !isBlank(form.inward_received_boxes_qty) ? form.inward_received_boxes_qty : form.inward_received_qty,
  };
}

export function validateInwardStep(step, form, photos, driverCountryCode = '+91') {
  const missing = [];
  const missingKeys = [];
  const record = buildStepRecord(form, driverCountryCode);
  const fields = STEP_REQUIRED_FIELDS[step] || [];

  for (const [key, label] of fields) {
    if (isBlank(record[key])) {
      missingKeys.push(key);
      missing.push(label);
    }
  }

  const photoRules = STEP_REQUIRED_PHOTOS[step] || [];
  for (const rule of photoRules) {
    if (!hasPhotoValue(photos[rule.key], rule.multi)) {
      missingKeys.push(rule.key);
      missing.push(rule.label);
    }
  }

  if (step === 1) {
    const digits = String(form.inward_driver_no || '').replace(/\D/g, '');
    const expectedDigits = getExpectedPhoneDigits(driverCountryCode);
    if (digits.length > 0 && digits.length < expectedDigits) {
      const message = `Invalid Phone Number: Please enter a valid ${expectedDigits}-digit mobile number for country code ${driverCountryCode}.`;
      return { ok: false, missing: [message], missingKeys: ['inward_driver_no'], message };
    }
  }

  if (step === 7) {
    const damageQty = parseInt(record.inward_damage_received_boxes_qty, 10) || 0;
    if (damageQty > 0 && !hasPhotoValue(photos.inward_damage_boxes_photo, true)) {
      missingKeys.push('inward_damage_boxes_photo');
      missing.push('Damage Boxes Photo');
    }
  }

  if (missing.length > 0) {
    return { ok: false, missing, missingKeys, message: 'Please complete required fields on this step.' };
  }

  return { ok: true, missing: [], missingKeys: [] };
}

export function getInwardStepFillStatus(step, form, photos, driverCountryCode = '+91') {
  const validation = validateInwardStep(step, form, photos, driverCountryCode);
  if (validation.ok) return 'done';

  const record = buildStepRecord(form, driverCountryCode);
  const fields = STEP_REQUIRED_FIELDS[step] || [];
  let hasAny = false;

  for (const [key] of fields) {
    if (!isBlank(record[key])) {
      hasAny = true;
      break;
    }
  }

  if (!hasAny) {
    const photoRules = STEP_REQUIRED_PHOTOS[step] || [];
    for (const rule of photoRules) {
      if (hasPhotoValue(photos[rule.key], rule.multi)) {
        hasAny = true;
        break;
      }
    }
  }

  if (!hasAny && step === 7) {
    const damageQty = parseInt(record.inward_damage_received_boxes_qty, 10) || 0;
    if (damageQty > 0 && hasPhotoValue(photos.inward_damage_boxes_photo, true)) {
      hasAny = true;
    }
  }

  if (!hasAny && step === 1) {
    const digits = String(form.inward_driver_no || '').replace(/\D/g, '');
    if (digits.length > 0) hasAny = true;
  }

  return hasAny ? 'partial' : 'empty';
}

export function convertYYYYMMDDToDDMMYYYY(yyyymmdd) {
  if (!yyyymmdd || !String(yyyymmdd).includes('-')) return '';
  const parts = String(yyyymmdd).split('-');
  if (parts.length !== 3) return '';
  const [yyyy, mm, dd] = parts;
  return `${dd}-${mm}-${yyyy}`;
}

export function sanitizeNameText(value) {
  return sanitizeClientName(value);
}

export function getLocalTodayStr(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function getLocalTimeStr(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${min}`;
}

export function getLocalEntryDateTime(date = new Date()) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(date.getDate()).padStart(2, '0');
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  const entryDate = getLocalTodayStr(date);
  const timeStr = getLocalTimeStr(date);
  return {
    entryDate,
    timeStr,
    display: `${day} ${month} ${year} · ${timeStr}`,
  };
}

export function getDefaultInwardForm(todayStr, supervisorName = '') {
  return {
    inward_entry_date: todayStr,
    inward_vehicle_no: '',
    inward_seal_no: '',
    inward_invoice_no: '',
    inward_mens_power: '',
    inward_vehicle_temp: '',
    inward_material_temp: '',
    inward_transporter_name: '',
    inward_driver_name: '',
    inward_driver_no: '',
    inward_client_name: '',
    inward_dock_no: '',
    inward_vehicle_reporting_time: '',
    inward_unloading_start_date: todayStr,
    inward_unloading_start_time: '',
    inward_unloading_end_date: todayStr,
    inward_unloading_end_time: '',
    inward_unloading_duration_hours: '',
    inward_unloading_duration_mins: '',
    inward_pallets_in_qty: '',
    inward_invoice_qty: '',
    inward_received_qty: '',
    inward_received_boxes_qty: '',
    inward_short_received_boxes_qty: '0',
    inward_excess_received_boxes_qty: '0',
    inward_damage_received_boxes_qty: '',
    inward_material_type: 'Frozen',
    inward_unloading_supervisor_name: supervisorName,
    inward_remarks: '',
  };
}

export function getEmptyInwardPhotos() {
  return {
    inward_invoice_photos: [],
    inward_pod_photo: null,
    inward_vehicle_seal_photo: null,
    inward_vehicle_temp_photo: null,
    inward_material_temp_photo: null,
    inward_vehicle_back_side_photo: null,
    inward_vehicle_back_side_photo_with_material: null,
    inward_count_sheet_photo: [],
    inward_damage_boxes_photo: [],
  };
}

export const INWARD_PHOTO_VARIANCE_LIMIT_MINS = 10;

const INWARD_PHOTO_REF_ORDER = [
  ['inward_vehicle_temp_photo', 'Vehicle Temp Photo', false],
  ['inward_material_temp_photo', 'Material Temp Photo', false],
  ['inward_pod_photo', 'POD Photo', false],
  ['inward_vehicle_seal_photo', 'Seal Photo', false],
  ['inward_vehicle_back_side_photo', 'Vehicle Back Photo', false],
  ['inward_vehicle_back_side_photo_with_material', 'Vehicle Back With Material', false],
  ['inward_count_sheet_photo', 'Count Sheet Photo', true],
  ['inward_invoice_photos', 'Invoice Photo', true],
  ['inward_damage_boxes_photo', 'Damage Boxes Photo', true],
];

function flattenInwardPhotoEntries(photos) {
  const entries = [];
  INWARD_PHOTO_REF_ORDER.forEach(([key, label, multi]) => {
    const val = photos?.[key];
    if (multi) {
      (val || []).forEach((item, idx) => {
        if (item?.uri) {
          entries.push({
            key,
            label: `${label}${(val || []).length > 1 ? ` ${idx + 1}` : ''}`,
            capturedAt: item.capturedAt ?? null,
          });
        }
      });
      return;
    }
    if (val?.uri) {
      entries.push({ key, label, capturedAt: val.capturedAt ?? null });
    }
  });
  return entries;
}

export function formatInwardClockTime(timestamp) {
  if (!timestamp) return '—';
  const dateObj = new Date(timestamp);
  if (Number.isNaN(dateObj.getTime())) return '—';
  const hh = String(dateObj.getHours()).padStart(2, '0');
  const min = String(dateObj.getMinutes()).padStart(2, '0');
  const ss = String(dateObj.getSeconds()).padStart(2, '0');
  return `${hh}:${min}:${ss}`;
}

export function buildInwardSubmitVerification(photos, submitTs = Date.now()) {
  const entries = flattenInwardPhotoEntries(photos);
  if (entries.length === 0) {
    return {
      submitTs,
      refLabel: null,
      refCapturedAt: null,
      refDiffMins: null,
      maxDiffMins: null,
      missingTimestampCount: 0,
      mismatchedCount: 0,
      photoCount: 0,
      isVarianceAlert: true,
    };
  }

  const refEntry = entries[0];
  const withTs = entries.filter((e) => e.capturedAt);
  const missingTimestampCount = entries.length - withTs.length;

  let maxDiffMins = null;
  let mismatchedCount = 0;
  withTs.forEach((entry) => {
    const diff = Math.floor(Math.abs(submitTs - entry.capturedAt) / 60000);
    if (maxDiffMins == null || diff > maxDiffMins) maxDiffMins = diff;
    if (diff > INWARD_PHOTO_VARIANCE_LIMIT_MINS) mismatchedCount += 1;
  });

  const refDiffMins = refEntry.capturedAt
    ? Math.floor(Math.abs(submitTs - refEntry.capturedAt) / 60000)
    : null;

  const isVarianceAlert =
    missingTimestampCount > 0 ||
    maxDiffMins == null ||
    maxDiffMins > INWARD_PHOTO_VARIANCE_LIMIT_MINS;

  return {
    submitTs,
    refLabel: refEntry.label,
    refCapturedAt: refEntry.capturedAt,
    refDiffMins,
    maxDiffMins,
    missingTimestampCount,
    mismatchedCount,
    photoCount: entries.length,
    isVarianceAlert,
  };
}
