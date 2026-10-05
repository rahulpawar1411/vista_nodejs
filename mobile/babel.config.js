/**
 * Babel config for Expo (babel.config.js).
 * WHAT: Tells Babel how to transform modern JavaScript/JSX for React Native.
 * WHY: Phones cannot run JSX or latest syntax directly — Babel compiles it at build time.
 * HOW: babel-preset-expo applies Expo’s default transforms; api.cache(true) speeds rebuilds.
 */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
