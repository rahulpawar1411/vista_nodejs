/**
 * Form draft storage (src/utils/formDraftStorage.js).
 * WHAT: Saves half-finished inward/outward forms and copies photos to app storage.
 * WHY: Camera temp files disappear — drafts must survive app restarts.
 * HOW: AsyncStorage JSON + copyAsync into documentDirectory/form_draft_photos/.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { normalizeLocalFileUri } from './formDataAppendFile';

const DRAFT_PHOTO_DIR = `${FileSystem.documentDirectory}form_draft_photos/`;

async function ensureDraftPhotoDir() {
  const info = await FileSystem.getInfoAsync(DRAFT_PHOTO_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(DRAFT_PHOTO_DIR, { intermediates: true });
  }
}

async function uriExists(uri) {
  if (!uri || typeof uri !== 'string') return false;
  try {
    const path = normalizeLocalFileUri(uri);
    const info = await FileSystem.getInfoAsync(path);
    return Boolean(info.exists);
  } catch (_) {
    return false;
  }
}

/**
 * Copy camera/cache URI into app document storage so drafts + sync survive restart.
 * Accepts file:// and bare absolute paths. content:// copied when FS allows.
 */
export async function stabilizePhotoForDraft(photo, fieldKey, index = 0) {
  if (!photo?.uri) return photo;
  const uri = normalizeLocalFileUri(photo.uri);
  if (!uri) return photo;
  if (uri.startsWith(DRAFT_PHOTO_DIR)) return photo;

  const canCopy =
    uri.startsWith('file://') ||
    uri.startsWith('/') ||
    uri.startsWith('content://');
  if (!canCopy) return photo;

  try {
    await ensureDraftPhotoDir();
    const dest = `${DRAFT_PHOTO_DIR}${fieldKey}-${index}-${Date.now()}.jpg`;
    await FileSystem.copyAsync({ from: uri, to: dest });
    const ok = await uriExists(dest);
    if (!ok) {
      console.warn('stabilizePhotoForDraft: dest missing after copy', dest);
      return photo;
    }
    return { ...photo, uri: dest };
  } catch (err) {
    console.warn('stabilizePhotoForDraft failed:', err?.message || err);
    return photo;
  }
}

/**
 * WHAT: Copies every photo object in a photos map to stable draft storage.
 * WHY: Multi-photo inward steps share one stabilize helper.
 * HOW: Loop keys; handle arrays (invoice photos) and single-uri fields.
 */
export async function stabilizePhotosForDraft(photos = {}) {
  if (!photos || typeof photos !== 'object') return photos;
  const next = { ...photos };

  for (const [fieldKey, value] of Object.entries(photos)) {
    if (Array.isArray(value)) {
      const list = [];
      for (let i = 0; i < value.length; i += 1) {
        list.push(await stabilizePhotoForDraft(value[i], fieldKey, i));
      }
      next[fieldKey] = list;
    } else if (value?.uri) {
      next[fieldKey] = await stabilizePhotoForDraft(value, fieldKey, 0);
    }
  }

  return next;
}

/** WHAT: Drops photo entries whose files were deleted. WHY: Avoid broken thumbnails on load. HOW: uriExists check per item. */
export async function pruneMissingDraftPhotos(photos = {}) {
  if (!photos || typeof photos !== 'object') return photos;
  const next = { ...photos };

  for (const [fieldKey, value] of Object.entries(photos)) {
    if (Array.isArray(value)) {
      const list = [];
      for (const item of value) {
        if (item?.uri && (await uriExists(item.uri))) list.push(item);
      }
      next[fieldKey] = list;
    } else if (value?.uri) {
      next[fieldKey] = (await uriExists(value.uri)) ? value : null;
    }
  }

  return next;
}

/** WHAT: Persists draft form + stabilized photos under a storage key. WHY: Resume wizard later. HOW: AsyncStorage.setItem JSON. */
export async function saveFormDraft(key, payload) {
  if (!key || !payload) return;
  const photos = await stabilizePhotosForDraft(payload.photos);
  await AsyncStorage.setItem(
    key,
    JSON.stringify({
      ...payload,
      photos,
      savedAt: Date.now(),
    })
  );
}

/** WHAT: Loads and cleans a saved draft. WHY: Restore fields on screen mount. HOW: getItem + pruneMissingDraftPhotos. */
export async function loadFormDraft(key) {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return null;
  const draft = JSON.parse(raw);
  if (!draft || typeof draft !== 'object') return null;
  if (draft.photos && typeof draft.photos === 'object') {
    draft.photos = await pruneMissingDraftPhotos(draft.photos);
  }
  return draft;
}

/** WHAT: Deletes a draft from AsyncStorage. WHY: After successful submit. HOW: removeItem. */
export async function clearFormDraft(key) {
  await AsyncStorage.removeItem(key);
}
