/**
 * WHAT: Fake native module for Firebase-style topic subscribe/unsubscribe APIs.
 * WHY: Expo Go has no ExpoTopicSubscriptionModule binary, but expo-notifications still imports it.
 * HOW: Export empty listeners and Promise.resolve stubs so imports succeed without crashing.
 */
const module = {
  addListener: () => {},
  removeListeners: () => {},
  subscribeToTopicAsync: () => Promise.resolve(null),
  unsubscribeFromTopicAsync: () => Promise.resolve(null)
};

export default module;
