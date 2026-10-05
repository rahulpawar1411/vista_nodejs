/**
 * Verification camera flow (src/utils/captureVerificationPhoto.js).
 * WHAT: Opens camera, compresses image, attaches GPS, and stabilizes URI for drafts/sync.
 * WHY: Inward/outward and temp logs share one safe Android-friendly capture path.
 * HOW: Pending AsyncStorage marker + getPendingResultAsync if the app was killed mid-capture.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { ensureCameraPermission } from './permissions';
import { compressImageOnly } from './compressImage';
import { buildPhotoCaptureMeta } from './photoCaptureMeta';
import { stabilizePhotoForDraft } from './formDraftStorage';

const PENDING_KEY = 'pending_camera_capture_v1';

/** Camera JPEG quality — avoid 1.0 (OOM risk on Android). */
const CAMERA_QUALITY = 0.7;

function mediaTypeImages() {
  // Prefer new SDK 57 API: MediaType array
  if (ImagePicker.MediaType?.Images) return [ImagePicker.MediaType.Images];
  if (typeof ImagePicker.MediaType === 'string') return ['images'];
  return ['images'];
}

/** WHAT: Marks which form field is waiting for a camera result. WHY: Recover after Android kills the app. HOW: AsyncStorage JSON. */
export async function savePendingCameraCapture({ formType, fieldKey, multi }) {
  try {
    await AsyncStorage.setItem(
      PENDING_KEY,
      JSON.stringify({
        formType,
        fieldKey,
        multi: !!multi,
        at: Date.now(),
      })
    );
  } catch (_) {
    /* ignore */
  }
}

/** WHAT: Clears pending camera marker. WHY: After success, cancel, or error. */
export async function clearPendingCameraCapture() {
  try {
    await AsyncStorage.removeItem(PENDING_KEY);
  } catch (_) {
    /* ignore */
  }
}

/** WHAT: Reads pending field metadata if still fresh (< 30 min). WHY: Resume interrupted capture. */
export async function loadPendingCameraCapture() {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.formType || !parsed?.fieldKey) return null;
    if (parsed.at && Date.now() - parsed.at > 30 * 60 * 1000) {
      await clearPendingCameraCapture();
      return null;
    }
    return parsed;
  } catch (_) {
    return null;
  }
}

/** WHAT: Asks ImagePicker for a photo saved while the app was dead. WHY: Android process death recovery. */
export async function getPendingCameraResult() {
  try {
    if (typeof ImagePicker.getPendingResultAsync !== 'function') return null;
    return await ImagePicker.getPendingResultAsync();
  } catch (err) {
    console.warn('getPendingResultAsync failed:', err?.message || err);
    return null;
  }
}

/** WHAT: Opens the system camera for one JPEG. WHY: Shared options (quality, no crop). HOW: launchCameraAsync. */
export async function launchVerificationCamera() {
  const options = {
    mediaTypes: mediaTypeImages(),
    allowsEditing: false,
    quality: CAMERA_QUALITY,
    exif: true,
  };
  return ImagePicker.launchCameraAsync(options);
}

function gpsFromExif(exif) {
  if (!exif || typeof exif !== 'object') return null;
  const lat = parseFloat(exif.GPSLatitude ?? exif.gpsLatitude);
  const lng = parseFloat(exif.GPSLongitude ?? exif.gpsLongitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) return null;
  return { latitude: lat, longitude: lng, accuracy: null };
}

/**
 * Compress + GPS meta + draft-stable URI from a picker asset.
 * GPS starts only AFTER camera closes (safer on Android).
 */
export async function finalizeCapturedPhotoAsset({
  pickerAsset,
  fieldKey,
  multi,
  existingCount = 0,
}) {
  if (!pickerAsset?.uri) {
    throw new Error('No photo URI from camera');
  }

  const compressedUri = await compressImageOnly(pickerAsset.uri, 0.55, {
    width: pickerAsset.width,
    height: pickerAsset.height,
  });
  const meta = await buildPhotoCaptureMeta(null);

  let latitude = meta.latitude;
  let longitude = meta.longitude;
  let accuracy = meta.accuracy;

  if (latitude == null || longitude == null) {
    const fromExif = gpsFromExif(pickerAsset.exif);
    if (fromExif) {
      latitude = fromExif.latitude;
      longitude = fromExif.longitude;
      accuracy = fromExif.accuracy;
    }
  }

  const stableUri =
    (
      await stabilizePhotoForDraft(
        { uri: compressedUri },
        fieldKey,
        multi ? existingCount : 0
      )
    )?.uri || compressedUri;

  return {
    uri: stableUri,
    capturedAt: meta.capturedAt,
    capturedAtStr: meta.capturedAtStr,
    latitude,
    longitude,
    accuracy,
  };
}

/**
 * WHAT: End-to-end open camera → compress → GPS → stable URI for one form photo field.
 * WHY: Single entry point used by InwardFormView and OutwardFormView.
 * HOW: Permission, pending marker, launchVerificationCamera, finalizeCapturedPhotoAsset.
 */
export async function captureVerificationPhoto({
  formType,
  fieldKey,
  multi,
  existingCount = 0,
}) {
  const allowed = await ensureCameraPermission();
  if (!allowed) return null;

  await savePendingCameraCapture({ formType, fieldKey, multi });

  let result;
  try {
    // No GPS work while system camera is open — that was a crash risk.
    result = await launchVerificationCamera();
  } catch (err) {
    await clearPendingCameraCapture();
    throw err;
  }

  if (result?.canceled || !result?.assets?.length) {
    await clearPendingCameraCapture();
    return null;
  }

  try {
    const asset = await finalizeCapturedPhotoAsset({
      pickerAsset: result.assets[0],
      fieldKey,
      multi,
      existingCount,
    });
    await clearPendingCameraCapture();
    return { asset, fieldKey, multi: !!multi };
  } catch (err) {
    await clearPendingCameraCapture();
    throw err;
  }
}

/**
 * WHAT: Restores a photo into the form after the OS killed the app mid-capture.
 * WHY: Without this, users lose the shot and must retake.
 * HOW: loadPendingCameraCapture + getPendingCameraResult + finalizeCapturedPhotoAsset.
 */
export async function recoverPendingVerificationPhoto(formType, photos = {}) {
  const pending = await loadPendingCameraCapture();
  if (!pending || pending.formType !== formType) return null;

  const pickerResult = await getPendingCameraResult();
  if (!pickerResult || pickerResult.canceled || !pickerResult.assets?.length) {
    await clearPendingCameraCapture();
    return null;
  }

  const { fieldKey, multi } = pending;
  const existingCount = multi ? (photos[fieldKey] || []).length : 0;

  try {
    const asset = await finalizeCapturedPhotoAsset({
      pickerAsset: pickerResult.assets[0],
      fieldKey,
      multi,
      existingCount,
    });
    await clearPendingCameraCapture();
    return { asset, fieldKey, multi: !!multi };
  } catch (err) {
    console.warn('recoverPendingVerificationPhoto failed:', err?.message || err);
    await clearPendingCameraCapture();
    return null;
  }
}
