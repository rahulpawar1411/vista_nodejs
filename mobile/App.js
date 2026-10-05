// ====================================================================
// ReeferON Mobile Entry (mobile/App.js)
// --------------------------------------------------------------------
// After login, ONE screen per role (do not mix their jobs):
//   do_operator → DashboardScreen  — field logs + offline SQLite sync
//   customer    → CustomerScreen   — read-only allowed WH/clients
//   sub_admin   → SubAdminScreen   — overview, permissions, DO masters
//
// API URL:
//   - Local: getLocalApiUrl() → http://LAN-IP:5000 (same DB as Render)
//   - Live:  PRODUCTION_API_URL (Render)
//   - FALLBACK_LOCAL_IP: update if Wi‑Fi IPv4 changes (ipconfig)
// ====================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, View, NativeModules, Platform, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import LoginScreen from './src/screens/LoginScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import CustomerScreen from './src/screens/CustomerScreen';
import SubAdminScreen from './src/screens/SubAdminScreen';
import SplashScreen from './src/screens/SplashScreen';
import { clearSyncedInspectionsLocally, initDatabase } from './src/database/db';

/**
 * WHAT: Reads the production API base URL from env or app config.
 * WHY: The app must know where to send login and data requests when not using a local PC server.
 * HOW: Checks EXPO_PUBLIC_API_URL and expo config, then strips trailing slashes and /api suffix.
 */
function readProductionApiUrl() {
  const raw =
    process.env.EXPO_PUBLIC_API_URL ||
    Constants.expoConfig?.extra?.apiUrl ||
    'https://reeferon-crm-backend.onrender.com';
  return String(raw)
    .trim()
    .replace(/\/$/, '')
    .replace(/\/api$/i, '');
}

export const PRODUCTION_API_URL = readProductionApiUrl();

/** Used only when Metro host IP cannot be detected — keep in sync with PC Wi‑Fi IPv4. */
const FALLBACK_LOCAL_IP = '192.168.64.129';

/**
 * WHAT: Finds a Wi‑Fi/LAN IP address inside a debugger or script URL string.
 * WHY: Local development needs http://YOUR-PC-IP:5000 instead of localhost on a physical phone.
 * HOW: Regex match for dotted IPv4; ignores loopback and emulator-only addresses.
 */
function extractLanIp(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.trim();
  // Prefer first IPv4 in the string (handles host:port, URLs, debuggerHost)
  const m = text.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  if (!m) return null;
  const ip = m[1];
  if (ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '10.0.2.2') return null;
  return ip;
}

/**
 * WHAT: Builds the URL for a backend running on your PC (port 5000).
 * WHY: DO operators testing against a local server must hit the PC’s LAN IP, not localhost.
 * HOW: Reads Metro/Expo host from native SourceCode or Constants, else uses FALLBACK_LOCAL_IP.
 * @returns {string} e.g. http://192.168.x.x:5000
 */
export function getLocalApiUrl() {
  try {
    const scriptURL = NativeModules.SourceCode?.scriptURL || '';
    const fromScript = extractLanIp(scriptURL);
    if (fromScript) return `http://${fromScript}:5000`;

    const address = scriptURL.split('://')[1] || '';
    const host = (address.split('/')[0] || '').split(':')[0];
    if (host === 'localhost' || host === '127.0.0.1' || host === '10.0.2.2' || host === '::1') {
      return Platform.OS === 'android' ? 'http://10.0.2.2:5000' : 'http://localhost:5000';
    }
  } catch (e) {
    console.warn('Failed to detect local API host from SourceCode:', e);
  }

  try {
    const hostUri =
      Constants.expoConfig?.hostUri ||
      Constants.manifest2?.extra?.expoGo?.debuggerHost ||
      Constants.manifest?.debuggerHost ||
      Constants.linkingUri ||
      '';
    const fromExpo = extractLanIp(String(hostUri));
    if (fromExpo) return `http://${fromExpo}:5000`;
  } catch (e) {
    console.warn('Failed to detect local API host from Expo Constants:', e);
  }

  return `http://${FALLBACK_LOCAL_IP}:5000`;
}

/**
 * WHAT: Checks if a URL points at the hosted (HTTPS / Render) backend.
 * WHY: Local URLs need refresh on Wi‑Fi change; production URLs stay stable.
 * HOW: Looks for onrender.com or https:// prefix after trimming.
 */
export function isProductionApiUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim().toLowerCase();
  return u.includes('onrender.com') || u.startsWith('https://');
}

/**
 * WHAT: Detects a local development server URL (HTTP on LAN IP or port 5000).
 * WHY: Stored api_url may be stale after DHCP — App refreshes it on session restore.
 * HOW: Excludes HTTPS/Render, then matches localhost, 10.0.2.2, or private IPv4 patterns.
 */
export function isLocalApiUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim().toLowerCase();
  if (u.includes('onrender.com') || u.startsWith('https://')) return false;
  return (
    u.startsWith('http://') &&
    (/:\s*5000\/?$/.test(u) ||
      u.includes('localhost') ||
      u.includes('127.0.0.1') ||
      u.includes('10.0.2.2') ||
      /^\s*http:\/\/\d+\.\d+\.\d+\.\d+/.test(u))
  );
}

/**
 * WHAT: Root app shell — splash, login, then one main screen per user role.
 * WHY: Keeps DO, Customer, and Sub-Admin flows separate with shared session and API URL state.
 * HOW: Restores token from AsyncStorage, validates with /api/auth/me, renders the matching screen.
 */
export default function App() {
  // Session + server URL (persisted in AsyncStorage)
  const [apiUrl, setApiUrl] = useState(PRODUCTION_API_URL);
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [splashDone, setSplashDone] = useState(false);

  const handleSplashComplete = useCallback(() => {
    setSplashDone(true);
  }, []);

  useEffect(() => {
    const restoreSession = async () => {
      let resolvedApiUrl = PRODUCTION_API_URL;
      try {
        const storedToken = await AsyncStorage.getItem('user_token');
        const storedUser = await AsyncStorage.getItem('user_profile');
        const storedApiUrl = await AsyncStorage.getItem('api_url');

        if (storedApiUrl && storedApiUrl.trim()) {
          let nextApi = storedApiUrl.replace(/\/$/, '').replace(/\/api$/i, '');
          if (/railway\.app/i.test(nextApi)) {
            nextApi = PRODUCTION_API_URL;
            console.log('[api] dropped unused Railway URL → Render');
          }
          if (isLocalApiUrl(nextApi)) {
            nextApi = getLocalApiUrl();
            await AsyncStorage.setItem('api_url', nextApi);
            console.log('[api] refreshed local server URL →', nextApi);
          }
          resolvedApiUrl = nextApi;
          setApiUrl(nextApi);
          await AsyncStorage.setItem('api_url', nextApi);
        } else {
          setApiUrl(PRODUCTION_API_URL);
          await AsyncStorage.setItem('api_url', PRODUCTION_API_URL);
        }

        if (storedToken && storedUser) {
          const parsed = JSON.parse(storedUser);
          const role = parsed?.role;
          const isMobileRole =
            role === 'do_operator' || role === 'customer' || role === 'sub_admin';

          if (!isMobileRole) {
            await AsyncStorage.multiRemove(['user_token', 'user_profile']);
          } else {
            let nextUser = parsed;
            let keepSession = true;
            try {
              const meRes = await fetch(`${resolvedApiUrl}/api/auth/me`, {
                headers: {
                  Authorization: `Bearer ${storedToken}`,
                  Accept: 'application/json'
                }
              });
              if (meRes.status === 401 || meRes.status === 403) {
                keepSession = false;
                await AsyncStorage.multiRemove(['user_token', 'user_profile']);
                console.warn('[auth] Stored session expired or revoked — login required.');
              } else if (meRes.ok) {
                const meData = await meRes.json().catch(() => ({}));
                if (meData?.user) {
                  nextUser = {
                    ...parsed,
                    ...meData.user,
                    role: meData.user.role || parsed.role
                  };
                  await AsyncStorage.setItem('user_profile', JSON.stringify(nextUser));
                }
              }
            } catch (networkErr) {
              console.warn('[auth] Session check skipped (offline):', networkErr.message);
            }

            if (keepSession) {
              setToken(storedToken);
              setUser(nextUser);
            }
          }
        }
      } catch (err) {
        console.warn('Failed to restore session:', err);
      } finally {
        // Session ready — app still waits until splash animation finishes
        setSessionReady(true);
      }
    };
    restoreSession();
  }, []);

  useEffect(() => {
    const handleUrl = (url) => {
      if (!url) return;
      console.log('[deep-link]', url);
    };

    Linking.getInitialURL().then(handleUrl).catch(() => { });
    const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    return () => sub.remove();
  }, []);

  /** WHAT: Saves user + JWT after LoginScreen succeeds. WHY: Stay signed in and route by role. HOW: setState + AsyncStorage. */
  const handleLoginSuccess = async (sessionData) => {
    const nextUser = sessionData?.user || null;
    const nextToken = sessionData?.token || null;
    const role = nextUser?.role;
    if (role !== 'do_operator' && role !== 'customer' && role !== 'sub_admin') {
      console.warn('Blocked non-mobile role from session:', role);
      return;
    }
    setUser(nextUser);
    setToken(nextToken);
    try {
      await AsyncStorage.setItem('user_token', nextToken);
      await AsyncStorage.setItem('user_profile', JSON.stringify(nextUser));
    } catch (err) {
      console.warn('Failed to cache session data:', err);
    }
  };

  /** WHAT: Updates which backend the app talks to. WHY: Dev/test against local or Render. HOW: Normalize URL and persist. */
  const handleUpdateApiUrl = async (newUrl) => {
    try {
      const clean = String(newUrl || '')
        .trim()
        .replace(/\/$/, '')
        .replace(/\/api$/i, '');
      const next = /railway\.app/i.test(clean) ? PRODUCTION_API_URL : clean;
      setApiUrl(next);
      await AsyncStorage.setItem('api_url', next);
    } catch (err) {
      console.warn('Failed to save API URL:', err);
    }
  };

  /** WHAT: Signs the user out and clears cached data. WHY: Security and fresh login. HOW: Clear storage + local SQLite synced rows. */
  const handleLogout = async () => {
    // Clear in-memory session first so UI returns to login immediately
    setUser(null);
    setToken(null);
    try {
      await AsyncStorage.multiRemove([
        'user_token',
        'user_profile',
        'active_mobile_nav_tab',
        'active_mobile_nav_section'
      ]);
    } catch (err) {
      console.warn('Failed to clear session cache:', err);
    }
    try {
      initDatabase();
      clearSyncedInspectionsLocally();
    } catch (err) {
      console.warn('Failed to clear synced SQLite inspections:', err);
    }
  };

  if (!sessionReady || !splashDone) {
    return (
      <SplashScreen
        onAnimationComplete={handleSplashComplete}
        waitingForSession={!sessionReady}
      />
    );
  }

  const role = user?.role;

  return (
    <View style={styles.container}>
      {!user || !token ? (
        <LoginScreen
          onLoginSuccess={handleLoginSuccess}
          apiUrl={apiUrl}
          onUpdateApiUrl={handleUpdateApiUrl}
          productionApiUrl={PRODUCTION_API_URL}
          localApiUrl={getLocalApiUrl()}
        />
      ) : role === 'do_operator' ? (
        <DashboardScreen
          user={user}
          token={token}
          apiUrl={apiUrl}
          onLogout={handleLogout}
          onUserUpdate={setUser}
        />
      ) : role === 'customer' ? (
        <CustomerScreen
          user={user}
          token={token}
          apiUrl={apiUrl}
          onLogout={handleLogout}
          onUserUpdate={async (nextUser) => {
            setUser(nextUser);
            try {
              await AsyncStorage.setItem('user_profile', JSON.stringify(nextUser));
            } catch (err) {
              console.warn('Failed to cache updated profile:', err);
            }
          }}
        />
      ) : role === 'sub_admin' ? (
        <SubAdminScreen
          user={user}
          token={token}
          apiUrl={apiUrl}
          onLogout={handleLogout}
        />
      ) : (
        <LoginScreen
          onLoginSuccess={handleLoginSuccess}
          apiUrl={apiUrl}
          onUpdateApiUrl={handleUpdateApiUrl}
          productionApiUrl={PRODUCTION_API_URL}
          localApiUrl={getLocalApiUrl()}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
});
