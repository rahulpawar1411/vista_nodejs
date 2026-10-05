import { Platform } from 'react-native';
import { isRunningInExpoGo } from 'expo';

/**
 * WHAT: True when the app runs inside Expo Go on Android (not a standalone build).
 * WHY: Remote push and some channel APIs fail there — we skip those code paths.
 * HOW: Combines Platform.OS === 'android' with isRunningInExpoGo() from expo.
 */
export function isExpoGoAndroid() {
  return Platform.OS === 'android' && isRunningInExpoGo();
}
