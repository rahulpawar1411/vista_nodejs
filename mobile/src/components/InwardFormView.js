/**
 * InwardFormView — multi-step inward (receiving) dock form for DO.
 * WHAT: Wizard UI to capture inward truck unload data, photos, and submit or queue offline.
 * WHY: Inward logs are large; steps + drafts reduce errors and support syncEngine upload.
 * HOW: Seven steps, inwardValidation, saveInwardLocally or multipart POST when online.
 */
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  Alert,
  Image,
  ActivityIndicator,
  StyleSheet,
  Platform,
  AppState,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import FastTouchable from './FastTouchable';
import DatePickerField from './DatePickerField';
import TimePickerField from './TimePickerField';
import {
  captureVerificationPhoto,
  recoverPendingVerificationPhoto,
} from '../utils/captureVerificationPhoto';
import {
  validateInwardForm,
  validateInwardStep,
  getInwardStepForKey,
  getInwardStepFillStatus,
  INWARD_STEP_COUNT,
  convertYYYYMMDDToDDMMYYYY,
  getLocalTodayStr,
  getDefaultInwardForm,
  getEmptyInwardPhotos,
  sanitizeInwardField,
  sanitizePhoneDigits,
  buildInwardSubmitVerification,
  formatInwardClockTime,
  INWARD_PHOTO_VARIANCE_LIMIT_MINS,
} from '../utils/inwardValidation';
import { saveInwardLocally, markInwardAsSynced, markInwardSyncError, markInwardSyncing } from '../database/db';
import { buildInwardFormData, collectMissingPhotoUris } from '../utils/offlineLogFormData';
import { appendLocalFile, multipartRequest } from '../utils/formDataAppendFile';
import { saveFormDraft, loadFormDraft, clearFormDraft, stabilizePhotosForDraft } from '../utils/formDraftStorage';

const TouchableOpacity = FastTouchable;
const INWARD_DRAFT_KEY = 'inward_form_draft_v1';

const MATERIAL_DROPDOWN_OPTIONS = [
  { value: 'Frozen', label: 'Frozen' },
  { value: 'dry', label: 'dry' },
  { value: 'chiller', label: 'chiller' },
  { value: '__other__', label: 'Other (custom)' },
];
const DEFAULT_COUNTRY_CODE = '+91';
const COUNTRY_CODES = [DEFAULT_COUNTRY_CODE, '+971', '+966', '+65', '+61', '+1', '+44'];

function resolveCountryCode(code) {
  const raw = String(code || '').trim();
  const normalized = raw.startsWith('+') ? raw : raw ? `+${raw}` : DEFAULT_COUNTRY_CODE;
  return COUNTRY_CODES.includes(normalized) ? normalized : DEFAULT_COUNTRY_CODE;
}

const PHOTO_FIELDS = [
  { key: 'inward_invoice_photos', label: 'Invoice Photo', required: true, multi: true },
  { key: 'inward_vehicle_temp_photo', label: 'Vehicle Temp Photo', required: true, multi: false },
  { key: 'inward_material_temp_photo', label: 'Material Temp Photo', required: true, multi: false },
  { key: 'inward_vehicle_back_side_photo', label: 'Vehicle Back Photo', required: true, multi: false },
  {
    key: 'inward_vehicle_back_side_photo_with_material',
    label: 'Vehicle Back With Material',
    required: true,
    multi: false,
  },
  { key: 'inward_count_sheet_photo', label: 'Count Sheet Photo', required: true, multi: true },
  { key: 'inward_pod_photo', label: 'POD Photo (optional)', required: false, multi: false },
  { key: 'inward_vehicle_seal_photo', label: 'Seal Photo (optional)', required: false, multi: false },
  { key: 'inward_damage_boxes_photo', label: 'Damage Boxes Photo', required: false, multi: true, conditional: true },
];

/** Process-order photo groups (mobile form UX only) */
const PRE_UNLOAD_PHOTO_KEYS = [
  'inward_vehicle_seal_photo',
  'inward_vehicle_back_side_photo',
  'inward_vehicle_back_side_photo_with_material',
  'inward_vehicle_temp_photo',
];
const DURING_UNLOAD_PHOTO_KEYS = [
  'inward_material_temp_photo',
  'inward_invoice_photos',
  'inward_pod_photo',
];
const CLOSE_PHOTO_KEYS = ['inward_count_sheet_photo', 'inward_damage_boxes_photo'];

const INWARD_STEPS = [
  { id: 1, icon: 'log-in-outline', title: 'Arrival Details', short: 'Arrival' },
  { id: 2, icon: 'time-outline', title: 'Vehicle Reporting', short: 'Report' },
  { id: 3, icon: 'thermometer-outline', title: 'Pre-Unload Check', short: 'Pre-check' },
  { id: 4, icon: 'play-circle-outline', title: 'Unloading Start', short: 'Start' },
  { id: 5, icon: 'images-outline', title: 'During Unload Photos', short: 'Unload' },
  { id: 6, icon: 'stop-circle-outline', title: 'Unloading End', short: 'End' },
  { id: 7, icon: 'checkbox-outline', title: 'Quantity & Close', short: 'Close' },
];

function getPhotoField(key) {
  return PHOTO_FIELDS.find((f) => f.key === key);
}

const PHOTO_ICONS = {
  inward_invoice_photos: 'document-text-outline',
  inward_vehicle_temp_photo: 'thermometer-outline',
  inward_material_temp_photo: 'snow-outline',
  inward_vehicle_back_side_photo: 'car-outline',
  inward_vehicle_back_side_photo_with_material: 'cube-outline',
  inward_count_sheet_photo: 'clipboard-outline',
  inward_pod_photo: 'receipt-outline',
  inward_vehicle_seal_photo: 'lock-closed-outline',
  inward_damage_boxes_photo: 'warning-outline',
};

function photoFieldHasValue(value, multi) {
  if (multi) return Array.isArray(value) && value.length > 0;
  return !!value?.uri;
}

function SectionCard({ icon, title, children }) {
  return (
    <View style={styles.sectionCard}>
      <View style={styles.sectionHeader}>
        <Ionicons name={icon} size={16} color="#003580" />
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function FieldLabel({ label, required, invalid }) {
  return (
    <Text style={[styles.fieldLabel, invalid && styles.fieldLabelInvalid]}>
      {label}
      {required ? <Text style={styles.reqStar}> *</Text> : null}
    </Text>
  );
}

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

function waitForSubmitUiPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/**
 * WHAT: Renders the full inward form wizard and handles submit/draft/sync.
 * WHY: Dashboard embeds this view inside inward navigation section.
 * HOW: Local state for form, photos, step index; props supply API and callbacks.
 */
export default function InwardFormView({
  apiUrl,
  token,
  displayName = '',
  user = null,
  clientSuggestions = [],
  onRememberClient,
  onSubmitted,
}) {
  const todayStr = useMemo(() => getLocalTodayStr(), []);
  const [form, setForm] = useState(() => getDefaultInwardForm(todayStr, displayName));
  const [photos, setPhotos] = useState(getEmptyInwardPhotos);
  const [driverCountryCode, setDriverCountryCode] = useState(DEFAULT_COUNTRY_CODE);
  const [invalidFields, setInvalidFields] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [pickingPhoto, setPickingPhoto] = useState(null);
  const [clientNameFocused, setClientNameFocused] = useState(false);
  const [materialDropdownOpen, setMaterialDropdownOpen] = useState(false);
  const [materialCustomMode, setMaterialCustomMode] = useState(false);
  const [phoneCodeDropdownOpen, setPhoneCodeDropdownOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const scrollRef = useRef(null);
  const draftReadyRef = useRef(false);
  const draftTimerRef = useRef(null);
  const captureInFlightRef = useRef(false);
  const draftStateRef = useRef({
    form,
    photos,
    driverCountryCode,
    currentStep,
    materialCustomMode,
  });
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [submitVerification, setSubmitVerification] = useState(null);
  const pendingSubmitFormRef = useRef(null);

  const clearInwardDraft = useCallback(async () => {
    try {
      await clearFormDraft(INWARD_DRAFT_KEY);
    } catch (_) {
      // ignore
    }
  }, []);

  const saveInwardDraftNow = useCallback(async () => {
    if (!draftReadyRef.current) return;
    try {
      await saveFormDraft(INWARD_DRAFT_KEY, draftStateRef.current);
    } catch (_) {
      // ignore
    }
  }, []);

  const applyCurrentEntryDate = useCallback((now = new Date()) => {
    const entryDate = getLocalTodayStr(now);
    setForm((prev) => {
      if (prev.inward_entry_date === entryDate) return prev;
      return {
        ...prev,
        inward_entry_date: entryDate,
      };
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const draft = await loadFormDraft(INWARD_DRAFT_KEY);
        if (cancelled) return;
        if (draft) {
          if (draft.form && typeof draft.form === 'object') {
            setForm((prev) => ({
              ...prev,
              ...draft.form,
              inward_entry_date: getLocalTodayStr(),
            }));
          }
          if (draft.photos && typeof draft.photos === 'object') {
            setPhotos((prev) => ({ ...prev, ...draft.photos }));
          }
          setDriverCountryCode(resolveCountryCode(draft.driverCountryCode));
          if (draft.currentStep) {
            setCurrentStep(Math.min(Math.max(Number(draft.currentStep) || 1, 1), INWARD_STEP_COUNT));
          }
          if (typeof draft.materialCustomMode === 'boolean') {
            setMaterialCustomMode(draft.materialCustomMode);
          }
        }
      } catch (_) {
        // ignore corrupt draft
      } finally {
        if (!cancelled) {
          draftReadyRef.current = true;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    draftStateRef.current = {
      form,
      photos,
      driverCountryCode,
      currentStep,
      materialCustomMode,
    };
  }, [form, photos, driverCountryCode, currentStep, materialCustomMode]);

  useEffect(() => {
    const updateEntryDate = () => applyCurrentEntryDate(new Date());
    updateEntryDate();
    const timerInterval = setInterval(updateEntryDate, 15000);
    return () => clearInterval(timerInterval);
  }, [applyCurrentEntryDate]);

  // Autosave draft so app close / tab switch / remount does not wipe filled data
  useEffect(() => {
    if (!draftReadyRef.current) return undefined;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      saveInwardDraftNow();
    }, 400);
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, [form, photos, driverCountryCode, currentStep, materialCustomMode, saveInwardDraftNow]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        saveInwardDraftNow();
      }
    });
    return () => {
      sub.remove();
      saveInwardDraftNow();
    };
  }, [saveInwardDraftNow]);

  const uniqueClients = useMemo(() => {
    const set = new Set();
    (clientSuggestions || []).forEach((name) => {
      const trimmed = String(name || '').trim();
      if (trimmed) set.add(trimmed);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [clientSuggestions]);

  const filteredClientSuggestions = useMemo(() => {
    const query = String(form.inward_client_name || '').trim().toLowerCase();
    if (!query) return uniqueClients.slice(0, 8);
    return uniqueClients
      .filter((name) => name.toLowerCase().includes(query))
      .slice(0, 8);
  }, [form.inward_client_name, uniqueClients]);

  const updateField = useCallback((key, value) => {
    setForm((prev) => {
      const context = {
        driverCountryCode,
        entryDate: prev.inward_entry_date,
        startDate: prev.inward_unloading_start_date || prev.inward_entry_date,
      };
      const sanitized = sanitizeInwardField(key, value, context);

      if (key === 'inward_unloading_start_date') {
        return {
          ...prev,
          inward_unloading_start_date: sanitized,
          inward_unloading_end_date: sanitized,
        };
      }

      if (key === 'inward_received_boxes_qty') {
        return {
          ...prev,
          inward_received_boxes_qty: sanitized,
          inward_received_qty: sanitized,
        };
      }

      return { ...prev, [key]: sanitized };
    });
    setInvalidFields((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, [driverCountryCode]);

  useEffect(() => {
    const inv = parseInt(form.inward_invoice_qty, 10) || 0;
    const rec = parseInt(form.inward_received_boxes_qty, 10) || 0;
    const shortQty = String(inv > rec ? inv - rec : 0);
    const excessQty = String(rec > inv ? rec - inv : 0);
    setForm((prev) => {
      if (
        prev.inward_short_received_boxes_qty === shortQty &&
        prev.inward_excess_received_boxes_qty === excessQty
      ) {
        return prev;
      }
      return {
        ...prev,
        inward_short_received_boxes_qty: shortQty,
        inward_excess_received_boxes_qty: excessQty,
      };
    });
  }, [form.inward_invoice_qty, form.inward_received_boxes_qty]);

  useEffect(() => {
    const startTime = form.inward_unloading_start_time;
    const endTime = form.inward_unloading_end_time;
    const startDate = form.inward_unloading_start_date || form.inward_entry_date;
    const endDate = form.inward_unloading_end_date || form.inward_entry_date;
    if (!startTime || !endTime || !startDate || !endDate) return;

    const startDateTime = new Date(`${startDate}T${startTime}:00`);
    const endClean = endTime.includes(' ') ? endTime.split(' ')[1] : endTime;
    const endDateTime = new Date(`${endDate}T${endClean}:00`);
    if (Number.isNaN(startDateTime.getTime()) || Number.isNaN(endDateTime.getTime())) return;

    const diffMs = endDateTime.getTime() - startDateTime.getTime();
    const diffMins = diffMs > 0 ? Math.floor(diffMs / 60000) : 0;
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;

    setForm((prev) => {
      if (
        prev.inward_unloading_duration_hours === String(hours) &&
        prev.inward_unloading_duration_mins === String(mins)
      ) {
        return prev;
      }
      return {
        ...prev,
        inward_unloading_duration_hours: String(hours),
        inward_unloading_duration_mins: String(mins),
      };
    });
  }, [
    form.inward_unloading_start_time,
    form.inward_unloading_end_time,
    form.inward_unloading_start_date,
    form.inward_unloading_end_date,
    form.inward_entry_date,
  ]);

  useEffect(() => {
    const damageQty = parseInt(form.inward_damage_received_boxes_qty, 10) || 0;
    if (damageQty === 0) {
      setPhotos((prev) => ({ ...prev, inward_damage_boxes_photo: [] }));
    }
  }, [form.inward_damage_received_boxes_qty]);

  const applyCapturedPhoto = useCallback((fieldKey, multi, asset) => {
    if (!asset?.uri || !fieldKey) return;

    setPhotos((prev) => {
      if (multi) {
        return { ...prev, [fieldKey]: [...(prev[fieldKey] || []), asset] };
      }
      return { ...prev, [fieldKey]: asset };
    });

    setInvalidFields((prev) => {
      if (!prev[fieldKey]) return prev;
      const next = { ...prev };
      delete next[fieldKey];
      return next;
    });

    // Defer alert so photo UI paints first (avoids crash-feeling freeze)
    if (asset.latitude == null || asset.longitude == null) {
      setTimeout(() => {
        Alert.alert(
          'Location not saved',
          'Photo saved, but GPS was unavailable. Turn on Location/GPS and capture again if coordinates are required.'
        );
      }, 300);
    }
  }, []);

  const capturePhoto = async (fieldKey, multi) => {
    try {
      captureInFlightRef.current = true;
      setPickingPhoto(fieldKey);
      const existingCount = multi ? (photos[fieldKey] || []).length : 0;
      const captured = await captureVerificationPhoto({
        formType: 'inward',
        fieldKey,
        multi,
        existingCount,
      });
      if (!captured?.asset) return;
      applyCapturedPhoto(captured.fieldKey, captured.multi, captured.asset);
    } catch (_) {
      Alert.alert('Camera Error', 'Could not capture photo.');
    } finally {
      captureInFlightRef.current = false;
      setPickingPhoto(null);
    }
  };

  // Android may kill the app while the system camera is open — recover the photo on return
  useEffect(() => {
    let cancelled = false;

    const tryRecover = async () => {
      if (captureInFlightRef.current) return;
      try {
        const recovered = await recoverPendingVerificationPhoto(
          'inward',
          draftStateRef.current?.photos || {}
        );
        if (cancelled || !recovered?.asset) return;
        applyCapturedPhoto(recovered.fieldKey, recovered.multi, recovered.asset);
      } catch (_) {
        /* ignore */
      }
    };

    tryRecover();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') tryRecover();
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [applyCapturedPhoto]);

  const removePhoto = (fieldKey, multi, index) => {
    setPhotos((prev) => {
      if (multi) {
        const list = [...(prev[fieldKey] || [])];
        list.splice(index, 1);
        return { ...prev, [fieldKey]: list };
      }
      return { ...prev, [fieldKey]: null };
    });
  };

  const resetForm = () => {
    const entryDate = getLocalTodayStr();
    setForm(getDefaultInwardForm(entryDate, displayName));
    setPhotos(getEmptyInwardPhotos());
    setDriverCountryCode(DEFAULT_COUNTRY_CODE);
    setInvalidFields({});
    setCurrentStep(1);
    setClientNameFocused(false);
    setMaterialDropdownOpen(false);
    setMaterialCustomMode(false);
    setPhoneCodeDropdownOpen(false);
    clearInwardDraft();
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  };

  const closeTransientUi = useCallback(() => {
    setClientNameFocused(false);
    setMaterialDropdownOpen(false);
    setPhoneCodeDropdownOpen(false);
  }, []);

  const goToStep = useCallback(
    (step) => {
      const next = Math.min(Math.max(step, 1), INWARD_STEP_COUNT);
      setCurrentStep(next);
      closeTransientUi();
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    },
    [closeTransientUi]
  );

  const handleNextStep = () => {
    const validation = validateInwardStep(currentStep, form, photos, driverCountryCode);
    if (!validation.ok) {
      const keyMap = Object.fromEntries(validation.missingKeys.map((k) => [k, true]));
      setInvalidFields(keyMap);
      Alert.alert('Step incomplete', validation.missing.map((m) => `• ${m}`).join('\n'));
      return;
    }
    setInvalidFields({});
    goToStep(currentStep + 1);
  };

  const handlePreviousStep = () => {
    setInvalidFields({});
    goToStep(currentStep - 1);
  };

  const handleSubmit = () => {
    if (submitting) return;

    const entryDate = getLocalTodayStr();
    const submitForm = {
      ...form,
      inward_entry_date: entryDate,
      inward_unloading_start_date: form.inward_unloading_start_date || entryDate,
      inward_unloading_end_date: form.inward_unloading_end_date || entryDate,
    };

    const validation = validateInwardForm(submitForm, photos, driverCountryCode);
    if (!validation.ok) {
      const keyMap = Object.fromEntries(validation.missingKeys.map((k) => [k, true]));
      setInvalidFields(keyMap);
      const firstKey = validation.missingKeys[0];
      if (firstKey) {
        goToStep(getInwardStepForKey(firstKey));
      }
      Alert.alert('Validation Error', validation.missing.map((m) => `• ${m}`).join('\n'));
      return;
    }

    if (!user?.email) {
      Alert.alert('Session', 'Operator profile is missing. Please log in again.');
      return;
    }

    const submitTs = Date.now();
    pendingSubmitFormRef.current = submitForm;
    setSubmitVerification(buildInwardSubmitVerification(photos, submitTs));
    setShowSubmitConfirm(true);
  };

  const performSubmit = async () => {
    const submitForm = pendingSubmitFormRef.current;
    if (!submitForm || submitting) return;

    setSubmitting(true);
    await waitForSubmitUiPaint();
    const warehouseName = String(user?.warehouse_name || '').trim();
    const warehouseCode = String(user?.warehouse_code || '').trim();
    const operatorEmail = String(user?.email || '').trim();

    try {
      const stablePhotos = await stabilizePhotosForDraft(photos);
      const missing = await collectMissingPhotoUris(stablePhotos);
      if (missing.length) {
        throw new Error(
          'One or more photos are missing on this device. Please recapture them and submit again.'
        );
      }

      const savedLocal = saveInwardLocally({
        form: submitForm,
        photos: stablePhotos,
        driverCountryCode,
        warehouse_name: warehouseName || null,
        warehouse_code: warehouseCode || null,
        operator_email: operatorEmail || null,
      });
      const localId = savedLocal?.id || savedLocal;
      if (!localId) {
        throw new Error('Could not save inward record to device queue.');
      }
      markInwardSyncing(localId);

      let syncedNow = false;
      let referenceNo = null;

      if (apiUrl && token) {
        try {
          const formData = buildInwardFormData({
            id: localId,
            created_at: savedLocal?.created_at,
            form_json: JSON.stringify(submitForm),
            photos_json: JSON.stringify(stablePhotos),
            driver_country_code: driverCountryCode,
            warehouse_name: warehouseName,
            warehouse_code: warehouseCode,
            operator_email: operatorEmail,
          });

          const res = await multipartRequest(`${apiUrl}/api/inward-logs`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
            },
            body: formData,
          });

          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            referenceNo = data.reference_no || null;
            markInwardAsSynced(localId, referenceNo, data.id);
            syncedNow = true;
          } else {
            const msg = data.message || data.error || `Upload failed (${res.status})`;
            markInwardSyncError(localId, msg);
            console.warn('Inward immediate upload deferred to sync queue:', msg);
          }
        } catch (uploadErr) {
          markInwardSyncError(localId, uploadErr.message || String(uploadErr));
          console.warn('Inward immediate upload deferred to sync queue:', uploadErr.message || uploadErr);
        }
      }

      setShowSubmitConfirm(false);
      setSubmitVerification(null);
      pendingSubmitFormRef.current = null;

      const savedClient = String(submitForm.inward_client_name || '').trim();
      if (savedClient && typeof onRememberClient === 'function') {
        onRememberClient(savedClient);
      }
      if (typeof onSubmitted === 'function') {
        onSubmitted({ syncedNow, localId, referenceNo });
      }
      await clearInwardDraft();
      resetForm();

      Alert.alert(
        syncedNow ? 'Inward Saved' : 'Saved on Device',
        syncedNow
          ? referenceNo
            ? `Uploaded to server.\nReference: ${referenceNo}`
            : 'Inward record uploaded to server.'
          : 'Record saved on this phone. It will upload automatically when you are online — tap Sync in More if needed.'
      );
    } catch (err) {
      Alert.alert('Submit Failed', err.message || 'Could not save inward record.');
    } finally {
      setSubmitting(false);
    }
  };

  const renderSubmitConfirmModal = () => {
    if (!showSubmitConfirm || !submitVerification) return null;

    const {
      submitTs,
      refLabel,
      refCapturedAt,
      refDiffMins,
      maxDiffMins,
      missingTimestampCount,
      mismatchedCount,
      photoCount,
      isVarianceAlert,
    } = submitVerification;

    const photoClock = formatInwardClockTime(refCapturedAt);
    const submitClock = formatInwardClockTime(submitTs);

    return (
      <Modal
        visible={showSubmitConfirm}
        animationType="fade"
        transparent
        statusBarTranslucent
        onRequestClose={() => {
          if (!submitting) setShowSubmitConfirm(false);
        }}
      >
        <View style={[styles.submitModalOverlay, submitting && styles.submitModalOverlayBusy]}>
          <View style={[styles.submitModalCard, submitting && styles.submitModalCardBusy]}>
            {submitting ? (
              <View style={styles.submitModalLoadingWrap}>
                <ActivityIndicator size="large" color="#003580" />
                <Text style={styles.submitModalLoadingTitle}>Submitting inward record</Text>
                <Text style={styles.submitModalLoadingText}>
                  Uploading photos and saving data. Please wait…
                </Text>
              </View>
            ) : (
              <>
                <View style={styles.submitModalIconWrap}>
                  <View
                    style={[
                      styles.submitModalIconCircle,
                      isVarianceAlert ? styles.submitModalIconWarn : styles.submitModalIconOk,
                    ]}
                  >
                    <Ionicons
                      name={isVarianceAlert ? 'warning' : 'checkmark-circle'}
                      size={30}
                      color={isVarianceAlert ? '#ef4444' : '#16a34a'}
                    />
                  </View>
                  <Text style={styles.submitModalTitle}>Confirm Inward Submit</Text>
                </View>

                <View style={styles.submitModalInfoBox}>
                  <View style={styles.submitModalInfoRow}>
                    <Text style={styles.submitModalInfoLabel}>Reference photo</Text>
                    <Text style={styles.submitModalInfoValue} numberOfLines={1}>
                      {refLabel || '—'}
                    </Text>
                  </View>
                  <View style={styles.submitModalInfoRow}>
                    <Text style={styles.submitModalInfoLabel}>Photo capture</Text>
                    <Text style={styles.submitModalInfoValue}>{photoClock}</Text>
                  </View>
                  <View style={styles.submitModalInfoRow}>
                    <Text style={styles.submitModalInfoLabel}>Submit time</Text>
                    <Text style={styles.submitModalInfoValue}>{submitClock}</Text>
                  </View>
                  <View style={styles.submitModalInfoRow}>
                    <Text style={styles.submitModalInfoLabel}>Difference</Text>
                    <Text
                      style={[
                        styles.submitModalInfoValue,
                        isVarianceAlert ? styles.submitModalWarnText : styles.submitModalOkText,
                      ]}
                    >
                      {refDiffMins == null ? 'N/A' : `${refDiffMins} min`}
                    </Text>
                  </View>
                  <View style={styles.submitModalInfoRow}>
                    <Text style={styles.submitModalInfoLabel}>Max photo diff</Text>
                    <Text
                      style={[
                        styles.submitModalInfoValue,
                        isVarianceAlert ? styles.submitModalWarnText : styles.submitModalOkText,
                      ]}
                    >
                      {maxDiffMins == null ? 'N/A' : `${maxDiffMins} min`}
                    </Text>
                  </View>
                  <View style={[styles.submitModalInfoRow, { marginBottom: 0 }]}>
                    <Text style={styles.submitModalInfoLabel}>Photos checked</Text>
                    <Text style={styles.submitModalInfoValue}>{photoCount}</Text>
                  </View>
                </View>

                <Text style={styles.submitModalMessage}>
                  {missingTimestampCount > 0 ? (
                    <Text style={styles.submitModalWarnText}>
                      {missingTimestampCount} photo(s) have no capture timestamp. Retake those photos before submit.
                    </Text>
                  ) : isVarianceAlert ? (
                    <Text style={styles.submitModalWarnText}>
                      Warning: {mismatchedCount > 0 ? `${mismatchedCount} photo(s)` : 'Photo time'} differ from submit time by more than {INWARD_PHOTO_VARIANCE_LIMIT_MINS} minutes.
                    </Text>
                  ) : (
                    <Text style={styles.submitModalOkText}>
                      Photo time vs submit is within {INWARD_PHOTO_VARIANCE_LIMIT_MINS} minutes.
                    </Text>
                  )}
                </Text>

                <Text style={styles.submitModalHint}>Continue to save this inward record?</Text>

                <View style={styles.submitModalActions}>
                  <TouchableOpacity
                    style={styles.submitModalCancelBtn}
                    onPress={() => {
                      setShowSubmitConfirm(false);
                      pendingSubmitFormRef.current = null;
                    }}
                  >
                    <Text style={styles.submitModalCancelText}>Back</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.submitModalContinueBtn,
                      isVarianceAlert ? styles.submitModalContinueWarn : null,
                    ]}
                    onPress={performSubmit}
                  >
                    <Text style={styles.submitModalContinueText}>Continue</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    );
  };

  const damageQty = parseInt(form.inward_damage_received_boxes_qty, 10) || 0;

  const photoProgress = useMemo(() => {
    let total = 0;
    let done = 0;
    PHOTO_FIELDS.forEach((field) => {
      if (field.conditional && damageQty <= 0) return;
      const isRequired = field.required || (field.conditional && damageQty > 0);
      if (!isRequired) return;
      total += 1;
      if (photoFieldHasValue(photos[field.key], field.multi)) done += 1;
    });
    return { total, done };
  }, [photos, damageQty]);

  const renderPhotoProgress = () => {
    const { total, done } = photoProgress;
    if (total === 0) return null;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const complete = done >= total;
    return (
      <View style={styles.photoProgressCard}>
        <View style={styles.photoProgressTop}>
          <View style={styles.photoProgressLeft}>
            <Ionicons
              name={complete ? 'checkmark-circle' : 'images-outline'}
              size={14}
              color={complete ? '#16a34a' : '#003580'}
            />
            <Text style={styles.photoProgressTitle} numberOfLines={1}>
              {complete ? 'All min photos captured' : `Min ${total} photos required`}
            </Text>
          </View>
          <Text style={[styles.photoProgressCount, complete && styles.photoProgressCountDone]}>
            {done}/{total}
          </Text>
        </View>
        <View style={styles.photoProgressTrack}>
          <View style={[styles.photoProgressFill, { width: `${pct}%` }, complete && styles.photoProgressFillDone]} />
        </View>
      </View>
    );
  };

  const renderClientNameField = () => {
    const invalid = !!invalidFields.inward_client_name;
    const query = String(form.inward_client_name || '').trim();
    const exactMatch = uniqueClients.some((c) => c.toLowerCase() === query.toLowerCase());
    const showSuggestions =
      clientNameFocused && filteredClientSuggestions.length > 0 && !exactMatch;

    return (
      <View style={[
        styles.fieldWrap,
        styles.dropdownField,
        showSuggestions && styles.dropdownFieldRaised,
      ]}>
        <FieldLabel label="Client Name" required invalid={invalid} />
        <View style={styles.autocompleteInputWrap}>
          <TextInput
            style={[
              styles.input,
              styles.autocompleteInput,
              form.inward_client_name ? styles.autocompleteInputFilled : null,
              invalid && styles.inputInvalid,
            ]}
            value={form.inward_client_name}
            onChangeText={(v) => updateField('inward_client_name', v)}
            placeholder="Type client name…"
            placeholderTextColor="#94a3b8"
            onFocus={() => {
              setClientNameFocused(true);
              setMaterialDropdownOpen(false);
              setPhoneCodeDropdownOpen(false);
            }}
            onBlur={() => setTimeout(() => setClientNameFocused(false), 180)}
            autoCorrect={false}
            autoCapitalize="words"
            keyboardType="default"
          />
          {form.inward_client_name ? (
            <>
              <Ionicons name="checkmark-circle" size={18} color="#16a34a" style={styles.autocompleteFilledIcon} />
              <TouchableOpacity
                style={styles.autocompleteClearBtn}
                onPress={() => updateField('inward_client_name', '')}
              >
                <Ionicons name="close-circle" size={18} color="#94a3b8" />
              </TouchableOpacity>
            </>
          ) : null}
          {showSuggestions ? (
            <View style={styles.suggestDropdown}>
              {filteredClientSuggestions.map((name) => (
                <TouchableOpacity
                  key={name}
                  style={styles.suggestItem}
                  onPress={() => {
                    updateField('inward_client_name', name);
                    setClientNameFocused(false);
                  }}
                >
                  <Ionicons name="business-outline" size={16} color="#64748b" />
                  <Text style={styles.suggestItemText} numberOfLines={1}>
                    {name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
        </View>
        {clientNameFocused && uniqueClients.length === 0 ? (
          <Text style={styles.suggestHint}>No saved clients — type a new client name.</Text>
        ) : null}
      </View>
    );
  };

  const renderMaterialTypeField = () => {
    const invalid = !!invalidFields.inward_material_type;
    const displayValue = materialCustomMode
      ? form.inward_material_type || 'Other (custom)'
      : form.inward_material_type || 'Select material type';

    return (
      <View style={[
        styles.fieldWrap,
        styles.dropdownField,
        materialDropdownOpen && styles.dropdownFieldRaised,
      ]}>
        <FieldLabel label="Material Type" required invalid={invalid} />
        <View style={styles.dropdownAnchor}>
        <TouchableOpacity
          style={[styles.dropdownTrigger, invalid && styles.inputInvalid]}
          onPress={() => {
            setClientNameFocused(false);
            setPhoneCodeDropdownOpen(false);
            setMaterialDropdownOpen((open) => !open);
          }}
          activeOpacity={0.8}
        >
          <Text
            style={[
              styles.dropdownTriggerText,
              !form.inward_material_type && materialCustomMode && styles.dropdownPlaceholder,
              !form.inward_material_type && !materialCustomMode && styles.dropdownPlaceholder,
            ]}
            numberOfLines={1}
          >
            {materialCustomMode && !form.inward_material_type
              ? 'Other — enter below'
              : displayValue}
          </Text>
          <Ionicons
            name={materialDropdownOpen ? 'chevron-up' : 'chevron-down'}
            size={18}
            color="#64748b"
          />
        </TouchableOpacity>
        {materialDropdownOpen ? (
          <View style={styles.suggestDropdown}>
            {MATERIAL_DROPDOWN_OPTIONS.map((opt) => {
              const isActive =
                opt.value === '__other__'
                  ? materialCustomMode
                  : form.inward_material_type === opt.value && !materialCustomMode;
              return (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.suggestItem, isActive && styles.dropdownItemActive]}
                  onPress={() => {
                    if (opt.value === '__other__') {
                      setMaterialCustomMode(true);
                      updateField('inward_material_type', '');
                    } else {
                      setMaterialCustomMode(false);
                      updateField('inward_material_type', opt.value);
                    }
                    setMaterialDropdownOpen(false);
                  }}
                >
                  <Text style={[styles.suggestItemText, isActive && styles.dropdownItemTextActive]}>
                    {opt.label}
                  </Text>
                  {isActive ? <Ionicons name="checkmark" size={16} color="#003580" /> : null}
                </TouchableOpacity>
              );
            })}
          </View>
        ) : null}
        </View>
        {materialCustomMode ? (
          <TextInput
            style={[styles.input, styles.materialCustomInput, invalid && styles.inputInvalid]}
            value={form.inward_material_type}
            onChangeText={(v) => updateField('inward_material_type', v)}
            placeholder="Enter custom material type"
            placeholderTextColor="#94a3b8"
            autoCapitalize="words"
          />
        ) : null}
      </View>
    );
  };

  const renderInput = (key, label, options = {}) => {
    const {
      required = false,
      placeholder = '',
      keyboardType = 'default',
      multiline = false,
      editable = true,
      autoCapitalize = 'sentences',
      highlightStyle = null,
    } = options;
    const invalid = !!invalidFields[key];
    const hasValue = String(form[key] ?? '').trim() !== '';
    return (
      <View style={styles.fieldWrap}>
        <FieldLabel label={label} required={required} invalid={invalid} />
        <View style={styles.inputIconWrap}>
          <TextInput
            style={[
              styles.input,
              multiline && styles.inputMultiline,
              invalid && styles.inputInvalid,
              !editable && styles.inputReadonly,
              highlightStyle,
              hasValue && editable && styles.inputWithIconPad,
            ]}
            value={String(form[key] ?? '')}
            onChangeText={(v) => updateField(key, v)}
            placeholder={placeholder}
            placeholderTextColor="#94a3b8"
            keyboardType={keyboardType}
            autoCapitalize={autoCapitalize}
            multiline={multiline}
            editable={editable}
          />
          {hasValue && !invalid ? (
            <Ionicons name="checkmark-circle" size={18} color="#16a34a" style={styles.inputFilledIcon} />
          ) : null}
        </View>
      </View>
    );
  };

  const renderPhotoBlock = (field) => {
    if (!field) return null;
    if (field.conditional && damageQty <= 0) return null;

    const value = photos[field.key];
    const isMulti = field.multi;
    const list = isMulti ? value || [] : value ? [value] : [];
    const hasPhotos = list.length > 0;
    const isRequired = field.required || (field.conditional && damageQty > 0);
    const invalid = !!invalidFields[field.key];
    const isLoading = pickingPhoto === field.key;
    const iconName = PHOTO_ICONS[field.key] || 'camera-outline';

    return (
      <View
        key={field.key}
        style={[styles.photoCard, invalid && styles.photoCardInvalid, hasPhotos && styles.photoCardDone]}
      >
        <View style={styles.photoCardHeader}>
          <View style={[styles.photoIconBadge, hasPhotos && styles.photoIconBadgeDone]}>
            <Ionicons name={iconName} size={14} color={hasPhotos ? '#16a34a' : '#003580'} />
          </View>
          <View style={styles.photoCardHeaderText}>
            <Text style={styles.photoCardTitle}>
              {field.label}
              {isRequired ? <Text style={styles.reqStar}> *</Text> : null}
            </Text>
            <Text style={styles.photoCardSub}>
              {isMulti ? 'Multiple photos allowed' : 'Single photo'}
              {!isRequired ? ' · Optional' : ''}
            </Text>
          </View>
          {hasPhotos ? (
            <View style={styles.photoStatusBadge}>
              <Ionicons name="checkmark-circle" size={14} color="#16a34a" />
              <Text style={styles.photoStatusBadgeText}>
                {isMulti ? `${list.length}` : 'OK'}
              </Text>
            </View>
          ) : null}
        </View>

        {!hasPhotos ? (
          <TouchableOpacity
            style={[styles.photoCaptureArea, invalid && styles.photoCaptureAreaInvalid]}
            onPress={() => capturePhoto(field.key, isMulti)}
            disabled={!!pickingPhoto}
            activeOpacity={0.85}
          >
            {isLoading ? (
              <ActivityIndicator color="#003580" size="small" />
            ) : (
              <>
                <View style={styles.photoCaptureIconWrap}>
                  <Ionicons name="camera" size={20} color="#003580" />
                </View>
                <Text style={styles.photoCaptureTitle}>
                  {isMulti ? 'Capture first photo' : 'Tap to capture'}
                </Text>
                <Text style={styles.photoCaptureHint}>Opens device camera</Text>
              </>
            )}
          </TouchableOpacity>
        ) : isMulti ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.photoMultiRow}
          >
            {list.map((item, idx) => (
              <View key={`${field.key}-${idx}`} style={styles.photoMultiItem}>
                <View style={styles.photoMultiFrame}>
                  <Image source={{ uri: item.uri }} style={styles.photoMultiThumb} />
                  <View style={styles.photoMultiIndex}>
                    <Text style={styles.photoMultiIndexText}>{idx + 1}</Text>
                  </View>
                  <TouchableOpacity
                    style={styles.photoMultiRemove}
                    onPress={() => removePhoto(field.key, true, idx)}
                  >
                    <Ionicons name="trash-outline" size={14} color="#fff" />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
            <TouchableOpacity
              style={[styles.photoMultiAdd, isLoading && styles.photoMultiAddLoading]}
              onPress={() => capturePhoto(field.key, true)}
              disabled={!!pickingPhoto}
            >
              {isLoading ? (
                <ActivityIndicator color="#003580" size="small" />
              ) : (
                <>
                  <Ionicons name="add-circle-outline" size={28} color="#003580" />
                  <Text style={styles.photoMultiAddText}>Add</Text>
                </>
              )}
            </TouchableOpacity>
          </ScrollView>
        ) : (
          <>
            <View style={styles.photoPreviewWrap}>
              <Image source={{ uri: list[0].uri }} style={styles.photoPreviewImage} />
              <View style={styles.photoPreviewOverlay}>
                <TouchableOpacity
                  style={styles.photoPreviewAction}
                  onPress={() => capturePhoto(field.key, false)}
                  disabled={!!pickingPhoto}
                >
                  {isLoading ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Ionicons name="camera-reverse-outline" size={16} color="#fff" />
                      <Text style={styles.photoPreviewActionText}>Retake</Text>
                    </>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.photoPreviewAction, styles.photoPreviewActionDanger]}
                  onPress={() => removePhoto(field.key, false, 0)}
                >
                  <Ionicons name="trash-outline" size={16} color="#fff" />
                  <Text style={styles.photoPreviewActionText}>Remove</Text>
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}
      </View>
    );
  };

  const stepStatuses = useMemo(() => {
    return INWARD_STEPS.map((step) =>
      getInwardStepFillStatus(step.id, form, photos, driverCountryCode)
    );
  }, [form, photos, driverCountryCode]);

  const activeStepMeta = INWARD_STEPS[currentStep - 1];

  const renderDriverPhoneField = () => (
    <>
      <FieldLabel label="Driver Phone" required invalid={!!invalidFields.inward_driver_no} />
      <View style={[
        styles.fieldWrap,
        styles.phoneFieldWrap,
        phoneCodeDropdownOpen && styles.dropdownFieldRaised,
      ]}>
        <View style={styles.phoneInputRow}>
          <View style={styles.dropdownAnchor}>
          <TouchableOpacity
            style={[
              styles.countryCodeBox,
              phoneCodeDropdownOpen && styles.countryCodeBoxOpen,
              invalidFields.inward_driver_no && styles.inputInvalid,
            ]}
            onPress={() => {
              setMaterialDropdownOpen(false);
              setPhoneCodeDropdownOpen((open) => !open);
            }}
            activeOpacity={0.8}
          >
            <Text style={styles.countryCodeText} numberOfLines={1}>
              {resolveCountryCode(driverCountryCode)}
            </Text>
            <Ionicons
              name={phoneCodeDropdownOpen ? 'chevron-up' : 'chevron-down'}
              size={16}
              color="#64748b"
            />
          </TouchableOpacity>
          {phoneCodeDropdownOpen ? (
            <Modal
              visible
              transparent
              animationType="fade"
              statusBarTranslucent
              onRequestClose={() => setPhoneCodeDropdownOpen(false)}
            >
              <View style={styles.phoneCodeModalOverlay}>
                <TouchableOpacity
                  style={StyleSheet.absoluteFill}
                  activeOpacity={1}
                  onPress={() => setPhoneCodeDropdownOpen(false)}
                />
                <View style={styles.phoneCodeModalCard}>
                  <Text style={styles.phoneCodeModalTitle}>Country code</Text>
                  {COUNTRY_CODES.map((code) => {
                    const active = driverCountryCode === code;
                    return (
                      <TouchableOpacity
                        key={code}
                        style={[styles.suggestItem, active && styles.dropdownItemActive]}
                        onPress={() => {
                          setDriverCountryCode(code);
                          setForm((prev) => ({
                            ...prev,
                            inward_driver_no: sanitizePhoneDigits(prev.inward_driver_no, code),
                          }));
                          setPhoneCodeDropdownOpen(false);
                        }}
                      >
                        <Text style={[styles.suggestItemText, active && styles.dropdownItemTextActive]}>
                          {code}
                        </Text>
                        {active ? <Ionicons name="checkmark" size={16} color="#003580" /> : null}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            </Modal>
          ) : null}
          </View>
          <TextInput
            style={[
              styles.input,
              styles.phoneNumberInput,
              invalidFields.inward_driver_no && styles.inputInvalid,
            ]}
            value={form.inward_driver_no}
            onChangeText={(v) => updateField('inward_driver_no', v)}
            placeholder="9876543210"
            placeholderTextColor="#94a3b8"
            keyboardType="phone-pad"
            onFocus={() => setPhoneCodeDropdownOpen(false)}
          />
        </View>
      </View>
    </>
  );

  const renderStepIndicator = () => (
    <View style={styles.stepWizardCard}>
      <View style={styles.stepWizardHeader}>
        <Text style={styles.stepWizardTitle} numberOfLines={1}>
          {activeStepMeta.title}
        </Text>
        <Text style={styles.stepWizardLabel}>
          {currentStep}/{INWARD_STEP_COUNT}
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.stepTabsRow}
      >
        {INWARD_STEPS.map((step, idx) => {
          const status = stepStatuses[idx];
          const isActive = currentStep === step.id;
          return (
            <TouchableOpacity
              key={step.id}
              style={[
                styles.stepTab,
                isActive && styles.stepTabActive,
                status === 'done' && !isActive && styles.stepTabDone,
                status === 'partial' && !isActive && styles.stepTabPartial,
              ]}
              onPress={() => goToStep(step.id)}
              activeOpacity={0.85}
            >
              <View style={styles.stepTabInner}>
                <Text style={[styles.stepTabNum, isActive && styles.stepTabNumActive]}>{step.id}</Text>
                {status === 'done' ? (
                  <View style={styles.stepTabDoneMark}>
                    <Ionicons name="checkmark" size={8} color="#fff" />
                  </View>
                ) : null}
              </View>
              <Text
                style={[styles.stepTabText, isActive && styles.stepTabTextActive]}
                numberOfLines={1}
              >
                {step.short}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <SectionCard icon="log-in-outline" title="1. Arrival Details">
            {renderClientNameField()}
            {renderInput('inward_dock_no', 'Dock No.', { required: true, placeholder: 'e.g. Dock-1' })}
            {renderMaterialTypeField()}
            {renderInput('inward_vehicle_no', 'Vehicle No.', {
              required: true,
              placeholder: 'e.g. MH-12-QW-1234',
              autoCapitalize: 'characters',
            })}
            {renderInput('inward_seal_no', 'Seal No. (optional)', {
              placeholder: 'e.g. SL-998822',
              autoCapitalize: 'characters',
            })}
            {renderInput('inward_invoice_no', 'Invoice No.', {
              required: true,
              placeholder: 'e.g. INV-12345',
              autoCapitalize: 'characters',
            })}
            {renderInput('inward_mens_power', 'Mens Power (optional)', {
              placeholder: 'e.g. 4',
              keyboardType: 'number-pad',
            })}
            {renderInput('inward_transporter_name', 'Transporter Name', {
              required: true,
              placeholder: 'e.g. BlueDart Express',
              autoCapitalize: 'words',
            })}
            {renderInput('inward_driver_name', 'Driver Name', {
              required: true,
              placeholder: 'e.g. Rajesh Kumar',
              autoCapitalize: 'words',
            })}
            {renderDriverPhoneField()}
          </SectionCard>
        );
      case 2:
        return (
          <SectionCard icon="time-outline" title="2. Vehicle Reporting">
            <TimePickerField
              label="Vehicle Reporting Time"
              value={form.inward_vehicle_reporting_time}
              onChange={(v) => updateField('inward_vehicle_reporting_time', v)}
              required
              invalid={!!invalidFields.inward_vehicle_reporting_time}
              placeholder="Select reporting time"
            />
          </SectionCard>
        );
      case 3:
        return (
          <SectionCard icon="thermometer-outline" title="3. Pre-Unload Check">
            <View style={styles.row2}>
              <View style={styles.row2Item}>
                {renderInput('inward_vehicle_temp', 'Vehicle Temp (°C)', {
                  required: true,
                  keyboardType: 'decimal-pad',
                })}
              </View>
              <View style={styles.row2Item}>
                {renderInput('inward_material_temp', 'Material Temp (°C)', {
                  required: true,
                  keyboardType: 'decimal-pad',
                })}
              </View>
            </View>
            {PRE_UNLOAD_PHOTO_KEYS.map((key) => renderPhotoBlock(getPhotoField(key)))}
          </SectionCard>
        );
      case 4:
        return (
          <SectionCard icon="play-circle-outline" title="4. Unloading Start">
            <DatePickerField
              label="Unloading Start Date"
              value={form.inward_unloading_start_date}
              onChange={(v) => updateField('inward_unloading_start_date', v)}
              required
              invalid={!!invalidFields.inward_unloading_start_date}
              minDate={form.inward_entry_date}
              placeholder="Select start date"
            />
            <TimePickerField
              label="Unloading Start Time"
              value={form.inward_unloading_start_time}
              onChange={(v) => updateField('inward_unloading_start_time', v)}
              required
              invalid={!!invalidFields.inward_unloading_start_time}
              placeholder="Select start time"
            />
          </SectionCard>
        );
      case 5:
        return (
          <SectionCard icon="images-outline" title="5. During Unload Photos">
            {DURING_UNLOAD_PHOTO_KEYS.map((key) => renderPhotoBlock(getPhotoField(key)))}
          </SectionCard>
        );
      case 6:
        return (
          <SectionCard icon="stop-circle-outline" title="6. Unloading End">
            <DatePickerField
              label="Unloading End Date"
              value={form.inward_unloading_end_date}
              onChange={(v) => updateField('inward_unloading_end_date', v)}
              required
              invalid={!!invalidFields.inward_unloading_end_date}
              minDate={form.inward_unloading_start_date || form.inward_entry_date}
              placeholder="Select end date"
            />
            <TimePickerField
              label="Unloading End Time"
              value={form.inward_unloading_end_time}
              onChange={(v) => updateField('inward_unloading_end_time', v)}
              required
              invalid={!!invalidFields.inward_unloading_end_time}
              placeholder="Select end time"
            />
            <View style={styles.row2}>
              <View style={styles.row2Item}>
                {renderInput('inward_unloading_duration_hours', 'Duration (hrs)', {
                  required: true,
                  editable: false,
                })}
              </View>
              <View style={styles.row2Item}>
                {renderInput('inward_unloading_duration_mins', 'Duration (mins)', {
                  required: true,
                  editable: false,
                })}
              </View>
            </View>
          </SectionCard>
        );
      case 7:
        return (
          <SectionCard icon="checkbox-outline" title="7. Quantity & Close">
            <View style={styles.row2}>
              <View style={styles.row2Item}>
                {renderInput('inward_pallets_in_qty', 'Pallets In', {
                  required: true,
                  keyboardType: 'number-pad',
                })}
              </View>
              <View style={styles.row2Item}>
                {renderInput('inward_invoice_qty', 'Invoice Boxes', {
                  required: true,
                  keyboardType: 'number-pad',
                })}
              </View>
            </View>
            {renderInput('inward_received_boxes_qty', 'Boxes Received', {
              required: true,
              keyboardType: 'number-pad',
            })}
            <View style={styles.row2}>
              <View style={styles.row2Item}>
                {renderInput('inward_short_received_boxes_qty', 'Short Qty', {
                  editable: false,
                  highlightStyle:
                    (parseInt(form.inward_short_received_boxes_qty, 10) || 0) > 0
                      ? styles.inputShortActive
                      : null,
                })}
              </View>
              <View style={styles.row2Item}>
                {renderInput('inward_excess_received_boxes_qty', 'Excess Qty', {
                  editable: false,
                  highlightStyle:
                    (parseInt(form.inward_excess_received_boxes_qty, 10) || 0) > 0
                      ? styles.inputExcessActive
                      : null,
                })}
              </View>
            </View>
            {renderInput('inward_damage_received_boxes_qty', 'Damage Qty (optional)', {
              keyboardType: 'number-pad',
              placeholder: '0',
            })}
            {CLOSE_PHOTO_KEYS.map((key) => renderPhotoBlock(getPhotoField(key)))}
            {renderInput('inward_unloading_supervisor_name', 'Supervisor Name', {
              required: true,
              placeholder: displayName || 'Supervisor name',
              autoCapitalize: 'words',
            })}
            {renderInput('inward_remarks', 'Remarks (optional)', {
              multiline: true,
              placeholder: 'Any notes…',
            })}
          </SectionCard>
        );
      default:
        return null;
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.formHead}>
        {renderStepIndicator()}
        {renderPhotoProgress()}
      </View>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        removeClippedSubviews={false}
      >
        {renderStepContent()}

        <View style={styles.bottomSpacer} />
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity style={styles.resetBtn} onPress={resetForm} disabled={submitting}>
          <Ionicons name="refresh-outline" size={14} color="#475569" />
          <Text style={styles.resetBtnText}>Reset</Text>
        </TouchableOpacity>
        {currentStep > 1 ? (
          <TouchableOpacity
            style={styles.navBtn}
            onPress={handlePreviousStep}
            disabled={submitting}
          >
            <Ionicons name="chevron-back" size={14} color="#003580" />
            <Text style={styles.navBtnText}>Previous</Text>
          </TouchableOpacity>
        ) : null}
        {currentStep < INWARD_STEP_COUNT ? (
          <TouchableOpacity
            style={[styles.nextBtn, currentStep === 1 && styles.nextBtnWide]}
            onPress={handleNextStep}
            disabled={submitting}
          >
            <Text style={styles.nextBtnText}>Next</Text>
            <Ionicons name="chevron-forward" size={14} color="#fff" />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={submitting}
            activeOpacity={0.88}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={14} color="#fff" />
                <Text style={styles.submitBtnText}>Submit Inward</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>
      {renderSubmitConfirmModal()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 12,
    paddingBottom: 20,
  },
  formHead: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
    backgroundColor: '#f8fafc',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  stepWizardCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
  },
  stepWizardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
    gap: 8,
  },
  stepWizardLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b',
  },
  stepWizardTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
  },
  stepTabsRow: {
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 0,
  },
  stepTab: {
    minWidth: 52,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    alignItems: 'center',
  },
  stepTabActive: {
    borderColor: '#003580',
    backgroundColor: '#eff6ff',
  },
  stepTabDone: {
    borderColor: '#bbf7d0',
    backgroundColor: '#f0fdf4',
  },
  stepTabPartial: {
    borderColor: '#fde68a',
    backgroundColor: '#fffbeb',
  },
  stepTabInner: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 0,
  },
  stepTabDoneMark: {
    position: 'absolute',
    top: -3,
    right: -8,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#16a34a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepTabNum: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748b',
  },
  stepTabNumActive: {
    color: '#003580',
  },
  stepTabText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#64748b',
    textAlign: 'center',
  },
  stepTabTextActive: {
    color: '#003580',
  },
  sectionCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'visible',
    zIndex: 1,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#003580',
  },
  fieldWrap: {
    marginBottom: 8,
    zIndex: 1,
  },
  dropdownField: {
    zIndex: 2,
    overflow: 'visible',
  },
  dropdownFieldRaised: {
    zIndex: 60,
    elevation: 16,
  },
  autocompleteWrap: {
    overflow: 'visible',
  },
  autocompleteInputWrap: {
    position: 'relative',
    justifyContent: 'center',
    zIndex: 2,
    overflow: 'visible',
  },
  autocompleteInput: {
    paddingRight: 12,
  },
  autocompleteInputFilled: {
    paddingRight: 64,
  },
  autocompleteFilledIcon: {
    position: 'absolute',
    right: 34,
  },
  autocompleteClearBtn: {
    position: 'absolute',
    right: 10,
    padding: 2,
  },
  dropdownAnchor: {
    position: 'relative',
    zIndex: 4,
    overflow: 'visible',
  },
  suggestDropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: 4,
    zIndex: 80,
    elevation: 20,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    overflow: 'hidden',
    maxHeight: 220,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
  },
  suggestItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  suggestItemText: {
    flex: 1,
    fontSize: 13,
    color: '#0f172a',
    fontWeight: '500',
  },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'ios' ? 8 : 7,
  },
  dropdownTriggerText: {
    flex: 1,
    fontSize: 13,
    color: '#0f172a',
    fontWeight: '500',
    marginRight: 8,
  },
  dropdownPlaceholder: {
    color: '#94a3b8',
    fontWeight: '400',
  },
  dropdownItemActive: {
    backgroundColor: '#eff6ff',
  },
  dropdownItemTextActive: {
    color: '#003580',
    fontWeight: '700',
  },
  materialCustomInput: {
    marginTop: 8,
  },
  suggestHint: {
    marginTop: 6,
    fontSize: 11,
    color: '#64748b',
    fontStyle: 'italic',
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#475569',
    marginBottom: 4,
  },
  fieldLabelInvalid: {
    color: '#dc2626',
  },
  reqStar: {
    color: '#ef4444',
  },
  inputIconWrap: {
    position: 'relative',
    justifyContent: 'center',
  },
  inputWithIconPad: {
    paddingRight: 40,
  },
  inputFilledIcon: {
    position: 'absolute',
    right: 12,
  },
  input: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'ios' ? 8 : 6,
    fontSize: 13,
    color: '#0f172a',
  },
  inputMultiline: {
    minHeight: 56,
    textAlignVertical: 'top',
  },
  inputInvalid: {
    borderColor: '#fca5a5',
    backgroundColor: '#fef2f2',
  },
  inputReadonly: {
    backgroundColor: '#f1f5f9',
    color: '#64748b',
  },
  inputShortActive: {
    borderColor: '#ef4444',
    borderWidth: 1.5,
    backgroundColor: '#fef2f2',
    color: '#b91c1c',
  },
  inputExcessActive: {
    borderColor: '#22c55e',
    borderWidth: 1.5,
    backgroundColor: '#f0fdf4',
    color: '#15803d',
  },
  chipScroll: {
    marginBottom: 12,
    maxHeight: 36,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 16,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    maxWidth: 140,
  },
  chipActive: {
    backgroundColor: '#dbeafe',
    borderColor: '#93c5fd',
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#475569',
  },
  chipTextActive: {
    color: '#003580',
  },
  phoneFieldWrap: {
    marginBottom: 8,
    zIndex: 2,
    overflow: 'visible',
  },
  phoneInputRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 8,
    overflow: 'visible',
    zIndex: 2,
  },
  countryCodeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    width: 86,
    flexShrink: 0,
    paddingHorizontal: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingVertical: Platform.OS === 'ios' ? 8 : 7,
  },
  countryCodeBoxOpen: {
    borderColor: '#93c5fd',
    backgroundColor: '#eff6ff',
  },
  countryCodeText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    flexShrink: 0,
  },
  phoneNumberInput: {
    flex: 1,
    marginBottom: 0,
  },
  phoneCodeModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  phoneCodeModalCard: {
    width: '100%',
    maxWidth: 280,
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 6,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 12,
  },
  phoneCodeModalTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 6,
  },
  row2: {
    flexDirection: 'row',
    gap: 10,
  },
  row2Item: {
    flex: 1,
  },
  photoProgressCard: {
    backgroundColor: '#eff6ff',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 0,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  photoProgressTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  photoProgressLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  photoProgressTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0f172a',
  },
  photoProgressCount: {
    fontSize: 12,
    fontWeight: '800',
    color: '#003580',
  },
  photoProgressCountDone: {
    color: '#16a34a',
  },
  photoProgressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: '#dbeafe',
    overflow: 'hidden',
  },
  photoProgressFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: '#003580',
  },
  photoProgressFillDone: {
    backgroundColor: '#16a34a',
  },
  photoCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 8,
    marginBottom: 8,
  },
  photoCardInvalid: {
    borderColor: '#fca5a5',
    backgroundColor: '#fffafb',
  },
  photoCardDone: {
    borderColor: '#bbf7d0',
  },
  photoCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    gap: 8,
  },
  photoIconBadge: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoIconBadgeDone: {
    backgroundColor: '#dcfce7',
  },
  photoCardHeaderText: {
    flex: 1,
  },
  photoCardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
  },
  photoCardSub: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 1,
  },
  photoStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#dcfce7',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 20,
  },
  photoStatusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#15803d',
  },
  photoCaptureArea: {
    borderWidth: 1.5,
    borderColor: '#93c5fd',
    borderStyle: 'dashed',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    paddingVertical: 12,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoCaptureAreaInvalid: {
    borderColor: '#fca5a5',
    backgroundColor: '#fef2f2',
  },
  photoCaptureIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#dbeafe',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  photoCaptureTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#003580',
  },
  photoCaptureHint: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 4,
  },
  photoPreviewWrap: {
    width: '100%',
    height: 120,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  photoPreviewImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  photoPreviewOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    padding: 10,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
  },
  photoPreviewAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.25)',
  },
  photoPreviewActionDanger: {
    backgroundColor: 'rgba(239, 68, 68, 0.35)',
    borderColor: 'rgba(252, 165, 165, 0.5)',
  },
  photoPreviewActionText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#fff',
  },
  photoMultiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 2,
  },
  photoMultiItem: {
    width: 148,
    overflow: 'visible',
  },
  photoMultiFrame: {
    width: 80,
    height: 80,
    borderRadius: 10,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: '#e2e8f0',
    borderWidth: 1,
    borderColor: '#bbf7d0',
  },
  photoMultiThumb: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  photoMultiIndex: {
    position: 'absolute',
    top: 6,
    left: 6,
    backgroundColor: 'rgba(15, 23, 42, 0.65)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  photoMultiIndexText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#fff',
  },
  photoMultiRemove: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(239, 68, 68, 0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoCaptureTimeBadge: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    backgroundColor: 'rgba(15, 23, 42, 0.78)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
    maxWidth: '88%',
  },
  photoCaptureTimeBadgeNoGps: {
    backgroundColor: 'rgba(180, 83, 9, 0.88)',
  },
  photoCaptureTimeBadgeWarn: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    backgroundColor: 'rgba(220, 38, 38, 0.88)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  photoCaptureTimeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
  },
  photoMultiAdd: {
    width: 80,
    height: 80,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#93c5fd',
    borderStyle: 'dashed',
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  photoMultiAddLoading: {
    opacity: 0.7,
  },
  photoMultiAddText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#003580',
  },
  bottomSpacer: {
    height: 80,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    paddingBottom: Platform.OS === 'ios' ? 88 : 76,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  navBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    minHeight: 34,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  navBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#003580',
  },
  nextBtn: {
    flex: 1,
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#003580',
  },
  nextBtnWide: {
    flex: 1,
  },
  nextBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#fff',
  },
  resetBtn: {
    flexGrow: 0,
    flexShrink: 0,
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
  },
  resetBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#475569',
  },
  submitBtn: {
    flex: 1,
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#0d7a4f',
    borderWidth: 1,
    borderColor: '#0a6640',
  },
  submitBtnDisabled: {
    opacity: 0.65,
  },
  submitBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#fff',
  },
  submitModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  submitModalOverlayBusy: {
    backgroundColor: 'rgba(15, 23, 42, 0.72)',
  },
  submitModalCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 18,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
  },
  submitModalCardBusy: {
    minHeight: 180,
    justifyContent: 'center',
  },
  submitModalIconWrap: {
    alignItems: 'center',
    marginBottom: 14,
  },
  submitModalIconCircle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  submitModalIconOk: {
    backgroundColor: '#dcfce7',
  },
  submitModalIconWarn: {
    backgroundColor: '#fee2e2',
  },
  submitModalTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0f172a',
    textAlign: 'center',
  },
  submitModalInfoBox: {
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  submitModalInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
    gap: 10,
  },
  submitModalInfoLabel: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '600',
    flex: 1,
  },
  submitModalInfoValue: {
    fontSize: 12,
    color: '#0f172a',
    fontWeight: '800',
    flex: 1,
    textAlign: 'right',
  },
  submitModalMessage: {
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 8,
    lineHeight: 18,
  },
  submitModalHint: {
    fontSize: 12,
    color: '#64748b',
    textAlign: 'center',
    marginBottom: 16,
  },
  submitModalWarnText: {
    color: '#dc2626',
    fontWeight: '700',
  },
  submitModalOkText: {
    color: '#16a34a',
    fontWeight: '700',
  },
  submitModalActions: {
    flexDirection: 'row',
    gap: 10,
  },
  submitModalCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
  },
  submitModalCancelText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#475569',
  },
  submitModalContinueBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#003580',
    alignItems: 'center',
  },
  submitModalContinueWarn: {
    backgroundColor: '#dc2626',
  },
  submitModalContinueText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
  },
  submitModalLoadingWrap: {
    alignItems: 'center',
    paddingVertical: 24,
    paddingHorizontal: 8,
  },
  submitModalLoadingTitle: {
    marginTop: 16,
    fontSize: 16,
    fontWeight: '800',
    color: '#0f172a',
    textAlign: 'center',
  },
  submitModalLoadingText: {
    marginTop: 8,
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 20,
  },
});
