/**
 * Mobile app bootstrap (index.js).
 * WHAT: Starts the React Native app and tells Expo which root component to show.
 * WHY: Every Expo/React Native project needs one entry file that registers the main UI.
 * HOW: registerRootComponent(App) wires App.js into the native shell (Expo Go or built APK).
 */
import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
