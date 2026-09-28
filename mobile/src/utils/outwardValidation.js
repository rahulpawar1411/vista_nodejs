// Client-side outward validation — mirrors backend/web rules

const REQUIRED_FIELDS = [
  ['outward_entry_date', 'Entry Date'],
  ['outward_client_name', 'Client Name'],
  ['outward_dock_no', 'Dock No.'],
  ['outward_material_type', 'Material Type'],
  ['outward_vehicle_no', 'Vehicle No.'],
  ['outward_invoice_no', 'Invoice No.'],
  ['outward_transporter_name', 'Transporter Name'],
  ['outward_driver_name', 'Driver Name'],
  ['outward_driver_no', 'Driver Phone No.'],
  ['outward_vehicle_reporting_time', 'Vehicle Reporting Time'],
  ['outward_loading_start_time', 'Loading Start Time'],
  ['outward_loading_end_time', 'Loading End Time'],
  ['outward_loading_duration_hours', 'Loading Duration Hours'],
  ['outward_loading_duration_mins', 'Loading Duration Mins'],
  ['outward_pre_vehicle_temp', 'Pre Vehicle Temp'],
  ['outward_material_temp', 'Material Temp'],
  ['outward_pallets_in_qty', 'Pallets Out Qty'],
  ['outward_invoice_qty', 'Invoice Boxes Qty'],
  ['outward_received_boxes_qty', 'Boxes Loaded Qty'],
  ['outward_loading_supervisor_name', 'Loading Supervisor Name'],
];

const PHOTO_RULES = [
  { key: 'outward_invoice_photos', label: 'Invoice Photo', multi: true },
  { key: 'outward_pre_vehicle_temp_photo', label: 'Pre Vehicle Temp Photo', multi: false },
  { key: 'outward_material_temp_photo', label: 'Material Temp Photo', multi: false },
  { key: 'outward_vehicle_back_side_photo', label: 'Vehicle Back Photo', multi: false },
  { key: 'outward_vehicle_back_side_photo_with_material', label: 'Vehicle Back Photo With Material', multi: false },
  { key: 'outward_count_sheet_photo', label: 'Count Sheet Photo', multi: true },
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

export function clampLoadingStartDate(value, entryDate) {
  const clean = sanitizeDateYYYYMMDD(value);
  if (!entryDate || !clean) return clean;
  return clean < entryDate ? entryDate : clean;
}

export function clampLoadingEndDate(value, startDate, entryDate) {
  const minDate = startDate || entryDate;
  const clean = sanitizeDateYYYYMMDD(value);
  if (!minDate || !clean) return clean;
  return clean < minDate ? minDate : clean;
}

/** Mirror web OutwardMonitor handleInputChange sanitizers. */
export function sanitizeOutwardField(fieldName, value, context = {}) {
  const { driverCountryCode = '+91', entryDate = '', startDate = '' } = context;

  switch (fieldName) {
    case 'outward_vehicle_no':
      return formatVehicleNumber(value);
    case 'outward_seal_no':
      return sanitizeSealNumber(value);
    case 'outward_invoice_no':
      return sanitizeSealNumber(value);
    case 'outward_client_name':
      return sanitizeClientName(value);
    case 'outward_driver_name':
    case 'outward_transporter_name':
    case 'outward_loading_supervisor_name':
      return sanitizePersonName(value);
    case 'outward_driver_no':
      return sanitizePhoneDigits(value, driverCountryCode);
    case 'outward_pallets_in_qty':
    case 'outward_invoice_qty':
    case 'outward_received_qty':
    case 'outward_received_boxes_qty':
    case 'outward_damage_received_boxes_qty':
    case 'outward_mens_power':
      return sanitizeIntegerField(value);
    case 'outward_pre_vehicle_temp':
    case 'outward_material_temp':
      return sanitizeTemperature(value);
    case 'outward_vehicle_reporting_time':
    case 'outward_loading_start_time':
    case 'outward_loading_end_time':
      return sanitizeTimeHHMM(value);
    case 'outward_loading_start_date':
      return clampLoadingStartDate(value, entryDate);
    case 'outward_loading_end_date':
      return clampLoadingEndDate(value, startDate, entryDate);
    default:
      return value;
  }
}

function hasPhotoValue(val, multi) {
  if (multi) return Array.isArray(val) && val.length > 0;
  return !!val;
}

export function validateOutwardForm(form, photos, driverCountryCode = '+91') {
  const missing = [];
  const missingKeys = [];

  const record = {
    ...form,
    outward_entry_date: normalizeEntryDate(form.outward_entry_date),
    outward_driver_no: form.outward_driver_no
      ? `${driverCountryCode} ${String(form.outward_driver_no).replace(/\D/g, '')}`
      : '',
    outward_received_boxes_qty:
      !isBlank(form.outward_received_boxes_qty) ? form.outward_received_boxes_qty : form.outward_received_qty,
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

  const damageQty = parseInt(record.outward_damage_received_boxes_qty, 10) || 0;
  if (damageQty > 0 && !hasPhotoValue(photos.outward_damage_boxes_photo, true)) {
    missingKeys.push('outward_damage_boxes_photo');
    missing.push('Damage Boxes Photo');
  }

  if (missing.length > 0) {
    return { ok: false, missing, missingKeys, message: 'Please fill all required fields.' };
  }

  const digits = String(form.outward_driver_no || '').replace(/\D/g, '');
  const expectedDigits = getExpectedPhoneDigits(driverCountryCode);
  if (digits.length < expectedDigits) {
    const message = `Invalid Phone Number: Please enter a valid ${expectedDigits}-digit mobile number for country code ${driverCountryCode}.`;
    return { ok: false, missing: [message], missingKeys: ['outward_driver_no'], message };
  }

  const entryDate = record.outward_entry_date;
  const startDate =
    normalizeEntryDate(form.outward_loading_start_date) ||
    extractDateAndTime(form.outward_loading_start_time, entryDate).date ||
    entryDate;
  const endDate =
    normalizeEntryDate(form.outward_loading_end_date) ||
    extractDateAndTime(form.outward_loading_end_time, entryDate).date ||
    entryDate;

  const reportingTime = cleanTimePart(form.outward_vehicle_reporting_time);
  const startTime = extractDateAndTime(form.outward_loading_start_time, entryDate).time;
  const endTime = extractDateAndTime(form.outward_loading_end_time, entryDate).time;

  if (entryDate && startDate === entryDate && reportingTime && startTime && startTime <= reportingTime) {
    const message = `Loading Start Time must be later than Vehicle Reporting Time. Reporting: ${reportingTime}, Start: ${startTime}`;
    return { ok: false, missing: [message], missingKeys: ['outward_loading_start_time'], message };
  }

  const startDateTime = buildDateTime(startDate, startTime);
  const endDateTime = buildDateTime(endDate, endTime);
  if (startDateTime && endDateTime && endDateTime.getTime() <= startDateTime.getTime()) {
    const message =
      startDate === endDate
        ? `Loading End Time must be later than Loading Start Time. Start: ${startTime}, End: ${endTime}`
        : 'Loading End Date/Time must be later than Loading Start Date/Time.';
    return { ok: false, missing: [message], missingKeys: ['outward_loading_end_time'], message };
  }

  return { ok: true, missing: [], missingKeys: [] };
}

export const OUTWARD_STEP_COUNT = 7;

const STEP_REQUIRED_FIELDS = {
  1: [
    ['outward_client_name', 'Client Name'],
    ['outward_dock_no', 'Dock No.'],
    ['outward_material_type', 'Material Type'],
    ['outward_vehicle_no', 'Vehicle No.'],
    ['outward_invoice_no', 'Invoice No.'],
    ['outward_transporter_name', 'Transporter Name'],
    ['outward_driver_name', 'Driver Name'],
    ['outward_driver_no', 'Driver Phone No.'],
  ],
  2: [['outward_vehicle_reporting_time', 'Vehicle Reporting Time']],
  3: [
    ['outward_pre_vehicle_temp', 'Pre Vehicle Temp'],
    ['outward_material_temp', 'Material Temp'],
  ],
  4: [
    ['outward_loading_start_date', 'Loading Start Date'],
    ['outward_loading_start_time', 'Loading Start Time'],
  ],
  5: [],
  6: [
    ['outward_loading_end_date', 'Loading End Date'],
    ['outward_loading_end_time', 'Loading End Time'],
    ['outward_loading_duration_hours', 'Loading Duration Hours'],
    ['outward_loading_duration_mins', 'Loading Duration Mins'],
  ],
  7: [
    ['outward_pallets_in_qty', 'Pallets Out Qty'],
    ['outward_invoice_qty', 'Invoice Boxes Qty'],
    ['outward_received_boxes_qty', 'Boxes Loaded Qty'],
    ['outward_loading_supervisor_name', 'Loading Supervisor Name'],
  ],
};

const STEP_REQUIRED_PHOTOS = {
  3: [
    { key: 'outward_pre_vehicle_temp_photo', label: 'Pre Vehicle Temp Photo', multi: false },
    { key: 'outward_vehicle_back_side_photo', label: 'Vehicle Back Photo', multi: false },
    {
      key: 'outward_vehicle_back_side_photo_with_material',
      label: 'Vehicle Back With Material',
      multi: false,
    },
  ],
  5: [
    { key: 'outward_material_temp_photo', label: 'Material Temp Photo', multi: false },
    { key: 'outward_invoice_photos', label: 'Invoice Photo', multi: true },
  ],
  6: [],
  7: [{ key: 'outward_count_sheet_photo', label: 'Count Sheet Photo', multi: true }],
};

const FIELD_TO_STEP = {
  outward_client_name: 1,
  outward_dock_no: 1,
  outward_material_type: 1,
  outward_vehicle_no: 1,
  outward_seal_no: 1,
  outward_invoice_no: 1,
  outward_mens_power: 1,
  outward_transporter_name: 1,
  outward_driver_name: 1,
  outward_driver_no: 1,
  outward_vehicle_reporting_time: 2,
  outward_pre_vehicle_temp: 3,
  outward_material_temp: 3,
  outward_vehicle_back_side_photo: 3,
  outward_pre_vehicle_temp_photo: 3,
  outward_vehicle_back_side_photo_with_material: 3,
  outward_loading_start_date: 4,
  outward_loading_start_time: 4,
  outward_material_temp_photo: 5,
  outward_invoice_photos: 5,
  outward_pod_photo: 5,
  outward_loading_end_date: 6,
  outward_loading_end_time: 6,
  outward_loading_duration_hours: 6,
  outward_loading_duration_mins: 6,
  outward_vehicle_seal_photo: 6,
  outward_pallets_in_qty: 7,
  outward_invoice_qty: 7,
  outward_received_boxes_qty: 7,
  outward_short_received_boxes_qty: 7,
  outward_excess_received_boxes_qty: 7,
  outward_damage_received_boxes_qty: 7,
  outward_count_sheet_photo: 7,
  outward_damage_boxes_photo: 7,
  outward_loading_supervisor_name: 7,
  outward_remarks: 7,
};

export function getOutwardStepForKey(key) {
  return FIELD_TO_STEP[key] || 1;
}

function buildStepRecord(form, driverCountryCode) {
  return {
    ...form,
    outward_entry_date: normalizeEntryDate(form.outward_entry_date),
    outward_driver_no: form.outward_driver_no
      ? `${driverCountryCode} ${String(form.outward_driver_no).replace(/\D/g, '')}`
      : '',
    outward_received_boxes_qty:
      !isBlank(form.outward_received_boxes_qty) ? form.outward_received_boxes_qty : form.outward_received_qty,
  };
}

export function validateOutwardStep(step, form, photos, driverCountryCode = '+91') {
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
    const digits = String(form.outward_driver_no || '').replace(/\D/g, '');
    const expectedDigits = getExpectedPhoneDigits(driverCountryCode);
    if (digits.length > 0 && digits.length < expectedDigits) {
      const message = `Invalid Phone Number: Please enter a valid ${expectedDigits}-digit mobile number for country code ${driverCountryCode}.`;
      return { ok: false, missing: [message], missingKeys: ['outward_driver_no'], message };
    }
  }

  if (step === 7) {
    const damageQty = parseInt(record.outward_damage_received_boxes_qty, 10) || 0;
    if (damageQty > 0 && !hasPhotoValue(photos.outward_damage_boxes_photo, true)) {
      missingKeys.push('outward_damage_boxes_photo');
      missing.push('Damage Boxes Photo');
    }
  }

  if (missing.length > 0) {
    return { ok: false, missing, missingKeys, message: 'Please complete required fields on this step.' };
  }

  return { ok: true, missing: [], missingKeys: [] };
}

export function getOutwardStepFillStatus(step, form, photos, driverCountryCode = '+91') {
  const validation = validateOutwardStep(step, form, photos, driverCountryCode);
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
    const damageQty = parseInt(record.outward_damage_received_boxes_qty, 10) || 0;
    if (damageQty > 0 && hasPhotoValue(photos.outward_damage_boxes_photo, true)) {
      hasAny = true;
    }
  }

  if (!hasAny && step === 1) {
    const digits = String(form.outward_driver_no || '').replace(/\D/g, '');
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

export function getDefaultOutwardForm(todayStr, supervisorName = '') {
  return {
    outward_entry_date: todayStr,
    outward_vehicle_no: '',
    outward_seal_no: '',
    outward_invoice_no: '',
    outward_mens_power: '',
    outward_pre_vehicle_temp: '',
    outward_material_temp: '',
    outward_transporter_name: '',
    outward_driver_name: '',
    outward_driver_no: '',
    outward_client_name: '',
    outward_dock_no: '',
    outward_vehicle_reporting_time: '',
    outward_loading_start_date: todayStr,
    outward_loading_start_time: '',
    outward_loading_end_date: todayStr,
    outward_loading_end_time: '',
    outward_loading_duration_hours: '',
    outward_loading_duration_mins: '',
    outward_pallets_in_qty: '',
    outward_invoice_qty: '',
    outward_received_qty: '',
    outward_received_boxes_qty: '',
    outward_short_received_boxes_qty: '0',
    outward_excess_received_boxes_qty: '0',
    outward_damage_received_boxes_qty: '',
    outward_material_type: 'Frozen',
    outward_loading_supervisor_name: supervisorName,
    outward_remarks: '',
  };
}

export function getEmptyOutwardPhotos() {
  return {
    outward_invoice_photos: [],
    outward_pod_photo: null,
    outward_vehicle_seal_photo: null,
    outward_pre_vehicle_temp_photo: null,
    outward_material_temp_photo: null,
    outward_vehicle_back_side_photo: null,
    outward_vehicle_back_side_photo_with_material: null,
    outward_count_sheet_photo: [],
    outward_damage_boxes_photo: [],
  };
}

export const OUTWARD_PHOTO_VARIANCE_LIMIT_MINS = 10;

const OUTWARD_PHOTO_REF_ORDER = [
  ['outward_pre_vehicle_temp_photo', 'Pre Vehicle Temp Photo', false],
  ['outward_material_temp_photo', 'Material Temp Photo', false],
  ['outward_pod_photo', 'POD Photo', false],
  ['outward_vehicle_seal_photo', 'Seal Photo', false],
  ['outward_vehicle_back_side_photo', 'Vehicle Back Photo', false],
  ['outward_vehicle_back_side_photo_with_material', 'Vehicle Back With Material', false],
  ['outward_count_sheet_photo', 'Count Sheet Photo', true],
  ['outward_invoice_photos', 'Invoice Photo', true],
  ['outward_damage_boxes_photo', 'Damage Boxes Photo', true],
];

function flattenOutwardPhotoEntries(photos) {
  const entries = [];
  OUTWARD_PHOTO_REF_ORDER.forEach(([key, label, multi]) => {
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

export function formatOutwardClockTime(timestamp) {
  if (!timestamp) return '—';
  const dateObj = new Date(timestamp);
  if (Number.isNaN(dateObj.getTime())) return '—';
  const hh = String(dateObj.getHours()).padStart(2, '0');
  const min = String(dateObj.getMinutes()).padStart(2, '0');
  const ss = String(dateObj.getSeconds()).padStart(2, '0');
  return `${hh}:${min}:${ss}`;
}

export function buildOutwardSubmitVerification(photos, submitTs = Date.now()) {
  const entries = flattenOutwardPhotoEntries(photos);
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
    if (diff > OUTWARD_PHOTO_VARIANCE_LIMIT_MINS) mismatchedCount += 1;
  });

  const refDiffMins = refEntry.capturedAt
    ? Math.floor(Math.abs(submitTs - refEntry.capturedAt) / 60000)
    : null;

  const isVarianceAlert =
    missingTimestampCount > 0 ||
    maxDiffMins == null ||
    maxDiffMins > OUTWARD_PHOTO_VARIANCE_LIMIT_MINS;

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
