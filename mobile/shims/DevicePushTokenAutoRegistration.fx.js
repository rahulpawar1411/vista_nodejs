/**
 * WHAT: No-op replacement for expo-notifications auto push registration.
 * WHY: The real module registers listeners on import and crashes Android Expo Go.
 * HOW: Metro resolves imports to this file; async functions return without doing work.
 */
export async function setAutoServerRegistrationEnabledAsync(_enabled) {
  /* no-op in this shim */
}

export async function __handlePersistedRegistrationInfoAsync(_registrationInfo) {
  /* no-op in this shim */
}
