/**
 * Sub-Admin push alerts (src/services/subAdminPushAlerts.js).
 * WHAT: Registers Expo push and shows local fallback for new permission requests.
 * WHY: Sub-Admins must know when a DO needs approve/deny even if the app was closed.
 * HOW: Wraps expoPushRegistration; notifySubAdminIfNeeded when pending count rises.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { ensureNotificationPermission } from '../utils/permissions';
import { isExpoGoAndroid } from '../utils/notificationsEnv';
import {
  registerExpoPushToken,
  clearExpoPushToken,
  subscribePushTokenRefresh
} from './expoPushRegistration';

let handlerSet = false;
let lastPendingPermissions = null;
let initialized = false;
/** When true, server Expo push handles alerts (incl. app closed) — skip local overdue/dupes. */
let remotePushReady = false;

function ensureHandler() {
  if (handlerSet) return;
  handlerSet = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true
    })
  });
}

async function ensurePermissionChannel() {
  if (Platform.OS !== 'android' || isExpoGoAndroid()) return;
  try {
    await Notifications.setNotificationChannelAsync('permission-alerts', {
      name: 'Permission requests',
      description: 'Alerts when a DO requests edit/delete permission',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#003580',
      sound: 'default'
    });
  } catch (err) {
    console.warn('permission-alerts channel failed:', err?.message || err);
  }
}

async function pushLocal(title, body, data = {}) {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data,
        sound: 'default',
        ...(Platform.OS === 'android' ? { channelId: 'permission-alerts' } : {})
      },
      trigger: null
    });
  } catch (err) {
    console.warn('Sub-admin local alert failed:', err?.message || err);
  }
}

/**
 * WHAT: Sets notification handler and Android channel on first Sub-Admin mount.
 * WHY: One-time setup before token registration or local alerts.
 * HOW: ensureHandler + ensurePermissionChannel + ensureNotificationPermission.
 */
export async function initSubAdminPushAlerts() {
  ensureHandler();
  await ensurePermissionChannel();
  if (initialized) return;
  initialized = true;
  await ensureNotificationPermission();
}

/**
 * Register / refresh Expo push token (also call on every app open / foreground).
 */
export async function registerSubAdminPushToken({ apiUrl, token, force = true }) {
  ensureHandler();
  await ensurePermissionChannel();
  const result = await registerExpoPushToken({
    apiUrl,
    authToken: token,
    force
  });
  remotePushReady = !!result?.ok;
  return remotePushReady;
}

export async function clearSubAdminPushToken({ apiUrl, token }) {
  remotePushReady = false;
  await clearExpoPushToken({ apiUrl, authToken: token });
}

/** Keep token fresh while Sub-Admin session is open. */
export function subscribeSubAdminPushTokenRefresh({ apiUrl, token }) {
  ensureHandler();
  return subscribePushTokenRefresh({
    apiUrl,
    authToken: token,
    onReady: (result) => {
      remotePushReady = !!result?.ok;
    }
  });
}

/**
 * Local fallback when Expo push token is not registered.
 * Never notifies for overdue — only permission request increases.
 */
export async function notifySubAdminIfNeeded({ pendingPermissions }) {
  ensureHandler();

  const pending = Number(pendingPermissions) || 0;

  if (!remotePushReady && lastPendingPermissions != null && pending > lastPendingPermissions) {
    const delta = pending - lastPendingPermissions;
    await pushLocal(
      'New permission request',
      delta === 1
        ? '1 DO permission needs your review — open Admin'
        : `${delta} new permission requests — open Admin`,
      { screen: 'Admin', section: 'permissions', type: 'permission_request' }
    );
  }

  lastPendingPermissions = pending;
}

/** Reset counters when user logs out. */
export function resetSubAdminPushAlerts() {
  lastPendingPermissions = null;
  initialized = false;
  remotePushReady = false;
}

/**
 * When Sub-Admin taps a permission push (app open or from killed), open Admin → permissions.
 */
export function subscribePermissionNotificationOpen(onOpen) {
  ensureHandler();
  const handledIds = new Set();

  const maybeOpen = (response) => {
    if (!response || typeof onOpen !== 'function') return;
    const id = String(response?.notification?.request?.identifier || '');
    if (id && handledIds.has(id)) return;
    if (id) handledIds.add(id);

    const data = response?.notification?.request?.content?.data || {};
    const isPermission =
      data.type === 'permission_request' ||
      data.section === 'permissions' ||
      data.screen === 'Admin';
    if (!isPermission) return;
    onOpen(data);
  };

  const sub = Notifications.addNotificationResponseReceivedListener(maybeOpen);

  Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (!response) return;
      const rawDate = response.notification?.date;
      const when =
        typeof rawDate === 'number'
          ? rawDate < 1e12
            ? rawDate * 1000
            : rawDate
          : Date.parse(String(rawDate || '')) || 0;
      if (when && Date.now() - when > 90_000) return;
      maybeOpen(response);
    })
    .catch(() => {});

  return () => {
    try {
      sub.remove();
    } catch (_) {
      /* ignore */
    }
  };
}
