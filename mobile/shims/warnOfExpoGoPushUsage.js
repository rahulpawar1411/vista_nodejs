import { isRunningInExpoGo } from 'expo';
import { Platform } from 'expo-modules-core';

let didWarn = false;

/**
 * WHAT: Logs a one-time warning about Android push limits in Expo Go.
 * WHY: Remote push tokens are not supported there — developers need a dev/production build instead.
 * HOW: Metro redirects expo-notifications to this file; we check isRunningInExpoGo() and warn once.
 */
export const warnOfExpoGoPushUsage = () => {
  if (isRunningInExpoGo() && !didWarn) {
    didWarn = true;
    const message =
      'expo-notifications: Android remote push is not available in Expo Go (SDK 53+). ' +
      'Local notifications still work. Use a development build for remote push: ' +
      'https://docs.expo.dev/develop/development-builds/introduction/';
    if (Platform.OS === 'android' || __DEV__) {
      console.warn(message);
    }
  }
};
