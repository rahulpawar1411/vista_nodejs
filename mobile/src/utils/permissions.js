/**
 * Device permissions (src/utils/permissions.js).
 * WHAT: Request camera, location, GPS, and notification access before DO features run.
 * WHY: Compliance photos need GPS; reminders need notification permission on Android 13+.
 * HOW: Wrap expo-image-picker, expo-location, and expo-notifications with Alerts and Settings links.
 */
import { Alert, Linking, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { isExpoGoAndroid } from './notificationsEnv';

function openAppSettings() {
  Linking.openSettings().catch(() => {});
}

function openLocationSettings() {
  if (Platform.OS === 'android') {
    Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS').catch(() => {
      openAppSettings();
    });
    return;
  }
  openAppSettings();
}

/**
 * Device GPS / Location toggle must be ON (permission alone is not enough).
 */
export async function ensureLocationServicesEnabled({ required = false } = {}) {
  try {
    if (Platform.OS === 'android' && Location.enableNetworkProviderAsync) {
      try {
        await Location.enableNetworkProviderAsync();
      } catch (_) {
        /* ignore — may still be off */
      }
    }

    const enabled = await Location.hasServicesEnabledAsync();
    if (enabled) return true;

    if (required) {
      Alert.alert(
        'Turn on Location',
        'Phone Location / GPS is OFF. Turn it ON so verification photos can save coordinates. Camera will not open until Location is enabled.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Location Settings', onPress: openLocationSettings },
        ]
      );
    }
    return false;
  } catch (err) {
    console.warn('ensureLocationServicesEnabled failed:', err?.message || err);
    if (required) {
      Alert.alert(
        'Location Error',
        'Could not check Location services. Turn on GPS and try again.'
      );
    }
    return false;
  }
}

/**
 * Camera + location permission + GPS services required before opening camera.
 */
export async function ensureCameraPermission() {
  try {
    const locationOk = await ensureLocationPermission({ required: true });
    if (!locationOk) return false;

    const servicesOk = await ensureLocationServicesEnabled({ required: true });
    if (!servicesOk) return false;

    const current = await ImagePicker.getCameraPermissionsAsync();
    if (current.granted) return true;

    if (current.canAskAgain === false) {
      Alert.alert(
        'Camera permission required',
        'ReeferON needs camera access to capture temperature sensor photos. Please enable Camera in Settings.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: openAppSettings }
        ]
      );
      return false;
    }

    const requested = await ImagePicker.requestCameraPermissionsAsync();
    if (requested.granted) return true;

    Alert.alert(
      'Camera permission denied',
      'Without camera access you cannot capture verification photos for chamber logs.'
    );
    return false;
  } catch (err) {
    console.warn('ensureCameraPermission failed:', err?.message || err);
    Alert.alert('Camera Error', 'Could not request camera permission.');
    return false;
  }
}

/**
 * Ask for location permission (and optionally require GPS on).
 * @param {{ required?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function ensureLocationPermission({ required = false } = {}) {
  try {
    const current = await Location.getForegroundPermissionsAsync();
    if (current.granted) return true;

    if (current.canAskAgain === false) {
      if (required) {
        Alert.alert(
          'Location permission required',
          'Allow Location to open the camera. Verification photos need GPS. Enable Location in Settings.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: openAppSettings },
          ]
        );
      }
      return false;
    }

    const requested = await Location.requestForegroundPermissionsAsync();
    if (requested.granted) return true;

    if (required) {
      Alert.alert(
        'Location permission required',
        'Camera will not open without Location access. Allow Location to capture verification photos.'
      );
    }
    return false;
  } catch (err) {
    console.warn('ensureLocationPermission failed:', err?.message || err);
    if (required) {
      Alert.alert(
        'Location Error',
        'Could not request location permission. Camera will not open.'
      );
    }
    return false;
  }
}

/**
 * Android 8+ notification channel (required before showing notifications).
 */
export async function ensureNotificationChannel() {
  if (Platform.OS !== 'android') return;
  // Expo Go Android: native ChannelsProvider is null — skip (local schedule still works).
  if (isExpoGoAndroid()) return;
  try {
    await Notifications.setNotificationChannelAsync('task-reminders', {
      name: 'Task reminders',
      description: 'Morning and evening chamber task reminders',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 200, 200, 200],
      lightColor: '#003580',
      sound: 'default'
    });
  } catch (err) {
    console.warn('Notification channel setup failed:', err?.message || err);
  }
}

/**
 * Ask for notification permission (local scheduled reminders).
 * @returns {Promise<boolean>}
 */
export async function ensureNotificationPermission() {
  try {
    await ensureNotificationChannel();

    const existing = await Notifications.getPermissionsAsync();
    let finalStatus = existing.status;
    let requested = existing;

    if (finalStatus !== 'granted') {
      requested = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true
        }
      });
      finalStatus = requested.status;
    }

    if (finalStatus !== 'granted') {
      const canAskAgain = requested.canAskAgain !== false;
      if (!canAskAgain) {
        Alert.alert(
          'Notifications disabled',
          'Enable notifications in Settings to get morning/evening task reminders.',
          [
            { text: 'OK', style: 'cancel' },
            { text: 'Open Settings', onPress: openAppSettings }
          ]
        );
      }
      return false;
    }
    return true;
  } catch (err) {
    console.warn('ensureNotificationPermission failed:', err?.message || err);
    return false;
  }
}
