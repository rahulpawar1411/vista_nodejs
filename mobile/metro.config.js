/**
 * Metro bundler config (metro.config.js).
 * WHAT: Customizes how Metro resolves JavaScript modules when you run the app.
 * WHY: expo-notifications pulls in native modules that crash on Android Expo Go — we swap in safe shims.
 * HOW: When a file inside expo-notifications imports certain modules, resolveRequest returns our shim paths.
 */
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const shims = {
  warnOfExpoGoPushUsage: path.resolve(__dirname, 'shims/warnOfExpoGoPushUsage.js'),
  DevicePushTokenAutoRegistration: path.resolve(
    __dirname,
    'shims/DevicePushTokenAutoRegistration.fx.js'
  ),
  TopicSubscriptionModule: path.resolve(
    __dirname,
    'shims/TopicSubscriptionModule.js'
  )
};

const defaultResolveRequest = config.resolver.resolveRequest;

/** Strip query strings and backslashes so module paths compare reliably on Windows. */
function normalize(moduleName) {
  return moduleName.split('?')[0].replace(/\\/g, '/');
}

/** True when an import path refers to a given expo-notifications internal module name. */
function endsWithModule(base, name) {
  return (
    base === `./${name}` ||
    base === `./${name}.js` ||
    base === `./${name}.android` ||
    base === `./${name}.android.js` ||
    base.endsWith(`/${name}`) ||
    base.endsWith(`/${name}.js`) ||
    base.endsWith(`/${name}.android`) ||
    base.endsWith(`/${name}.android.js`)
  );
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromNotifications = context.originModulePath?.includes(
    `${path.sep}expo-notifications${path.sep}`
  );

  if (fromNotifications) {
    const base = normalize(moduleName);

    if (endsWithModule(base, 'warnOfExpoGoPushUsage')) {
      return { filePath: shims.warnOfExpoGoPushUsage, type: 'sourceFile' };
    }

    if (
      endsWithModule(base, 'DevicePushTokenAutoRegistration.fx') ||
      base.includes('DevicePushTokenAutoRegistration.fx')
    ) {
      return {
        filePath: shims.DevicePushTokenAutoRegistration,
        type: 'sourceFile'
      };
    }

    // Expo Go Android has no ExpoTopicSubscriptionModule native binary
    if (endsWithModule(base, 'TopicSubscriptionModule')) {
      return { filePath: shims.TopicSubscriptionModule, type: 'sourceFile' };
    }
  }

  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
