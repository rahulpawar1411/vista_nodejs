// ====================================================================
// DO (Data Operator) — mobile/src/screens/DashboardScreen.js
// --------------------------------------------------------------------
// Field app for role `do_operator`.
// Daily work comes from chamber_client_assignments for THIS DO warehouse
// (not the global catalog). Offline: SQLite queue → syncEngine.
// Chamber / client master edits: request permission; after approve/deny
// a popup (and push) shows — deny includes Admin remark.
// Errors: prefer user-safe Alerts; network/sync failures stay in the queue.
// ====================================================================

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  FlatList,
  Modal,
  TextInput,
  Alert,
  StatusBar,
  SafeAreaView,
  useWindowDimensions,
  Platform,
  Image,
  ActivityIndicator,
  RefreshControl,
  Animated,
  BackHandler,
  Dimensions,
  InteractionManager,
  LayoutAnimation,
  UIManager,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import FastTouchable from '../components/FastTouchable';

if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const BOTTOM_SHEET_MAX_H = Math.round(Dimensions.get('window').height * 0.5);
const BOTTOM_SHEET_SCROLL_H = Math.max(180, BOTTOM_SHEET_MAX_H - 130);

const TouchableOpacity = FastTouchable;

const DOCK_REPORT_PAGE_SIZE = 20;
const PENDING_CHAMBER_TYPE_KEY = 'pending_chamber_type_updates';
const PENDING_CLIENT_MASTER_KEY = 'pending_client_master_ops';

/** Local calendar date YYYY-MM-DD (not UTC). */
function getLocalDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function logDateKey(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return getLocalDateStr(value);
  }
  const s = String(value).trim();
  const ymd = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (ymd) return ymd[1];
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return getLocalDateStr(parsed);
  return s.slice(0, 10);
}

function namesMatch(a, b) {
  return String(a || '').toLowerCase().trim() === String(b || '').toLowerCase().trim();
}

// SQLite database and Sync Engine imports
import { 
  initDatabase, 
  cacheAssignments, 
  getLocalAssignments, 
  saveInspectionLocally, 
  checkDuplicateInspection,
  getPendingInspections,
  getTodaysInspections,
  getAllLocalInspections,
  deleteInspectionLocally,
  updateInspectionLocally,
  updateLocalChamberType,
  purgeAutoSeededMasterLotsOnce,
  getClientLotMaster,
  addClientLotMaster,
  DEFAULT_CLIENT_LOT_MASTER,
  upsertLocalActiveAssignment,
  removeLocalAssignmentHard,
  countPendingSyncItems,
  queueLocalActivity,
  markActivitySynced,
  upsertSyncedInspectionFromServer,
  reconcileSyncedInspectionsFromServer,
  clearSyncedInspectionsLocally,
} from '../database/db';
import { subscribeToSync, triggerSync, formatLastSyncLabel, getLastSyncAt } from '../services/syncEngine';
import { ensureCameraPermission } from '../utils/permissions';
import { compressImageOnly } from '../utils/compressImage';
import { appendLocalFile, multipartRequest } from '../utils/formDataAppendFile';
import { buildPhotoCaptureMeta, beginPhotoLocationCapture } from '../utils/photoCaptureMeta';
import SplashScreen from './SplashScreen';
import { dedupeInventoryLots, chamberZoneStyle, normalizeChamberZone, pickComplianceZone } from '../utils/dedupeInventoryLots';
import { resolveLogImageUrl, resolveLogImageUrlCandidates, splitLogPhotoPaths } from '../utils/customerLogReportHelpers';
import { buildReportReadingRows, latestReadingQty } from '../utils/buildReportReadingRows';
import { mergeChamberReportLogs } from '../utils/mergeChamberReportLogs';
import { refreshTaskReminders } from '../utils/taskNotifications';
import InwardFormView from '../components/InwardFormView';
import OutwardFormView from '../components/OutwardFormView';
import {
  PhotoGridWithLocation,
  ImagePreviewModal,
  GpsDetailRow,
} from '../components/LogDetailPhotoLocation';
import ListLoadingOverlay from '../components/ListLoadingOverlay';
import {
  FLATLIST_PERF_PROPS,
  isBlockingListLoad,
  isSoftListLoad,
} from '../utils/listPerf';
import {
  INVENTORY_REPORT_FIRST_PAGE,
  INVENTORY_REPORT_MORE_PAGE,
  buildInventoryReconciliationQuery,
  parseInventoryReconciliationPayload,
  inventoryReportHasMore
} from '../utils/inventoryReportPaging';
import {
  subscribePushTokenRefresh,
  clearExpoPushToken
} from '../services/expoPushRegistration';

const PRODUCTION_API_URL = 'https://reeferon-crm-backend.onrender.com';

function pickDoLogImage(log) {
  if (!log) return null;
  return log.temp_sensor_image || log.sensor_image || log.photo_uri || null;
}

function resolveDoImageUrl(raw, baseUrl, folderHint = 'daily_temp_monitor_images') {
  return resolveLogImageUrl(raw, baseUrl, folderHint);
}

function DoSensorPhotoView({ rawPath, apiUrl, folderHint = 'daily_temp_monitor_images' }) {
  const candidates = useMemo(() => {
    const list = [
      ...resolveLogImageUrlCandidates(rawPath, apiUrl, folderHint),
      ...resolveLogImageUrlCandidates(rawPath, PRODUCTION_API_URL, folderHint)
    ].filter(Boolean);
    return [...new Set(list)];
  }, [rawPath, apiUrl, folderHint]);
  const [index, setIndex] = useState(0);
  const uri = candidates[index] || null;
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    setIndex(0);
    setFailed(false);
    setLoading(true);
    setPreviewOpen(false);
  }, [rawPath, apiUrl, folderHint]);

  if (!uri) {
    return (
      <View style={styles.doDetailImageEmpty}>
        <Ionicons name="image-outline" size={28} color="#94a3b8" />
        <Text style={styles.reportsStateText}>No photo attached to this log.</Text>
      </View>
    );
  }
  if (failed) {
    return (
      <View style={styles.doDetailImageEmpty}>
        <Ionicons name="alert-circle-outline" size={28} color="#dc2626" />
        <Text style={styles.reportsStateText}>Could not load sensor photo.</Text>
      </View>
    );
  }
  return (
    <>
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={() => setPreviewOpen(true)}
        disabled={loading}
        style={{ position: 'relative' }}
      >
        {loading ? (
          <View style={styles.doDetailImageLoading}>
            <ActivityIndicator color="#003580" />
          </View>
        ) : null}
        <Image
          source={{ uri }}
          style={[styles.doDetailImage, loading && { opacity: 0.2 }]}
          resizeMode="contain"
          onLoadStart={() => setLoading(true)}
          onLoad={() => setLoading(false)}
          onError={() => {
            if (index + 1 < candidates.length) {
              setIndex((i) => i + 1);
              setLoading(true);
              return;
            }
            setLoading(false);
            setFailed(true);
          }}
        />
        {!loading ? (
          <View style={styles.doDetailImageViewHint}>
            <Ionicons name="expand-outline" size={14} color="#fff" />
            <Text style={styles.doDetailImageViewHintText}>Tap to view</Text>
          </View>
        ) : null}
      </TouchableOpacity>
      <ImagePreviewModal
        visible={previewOpen}
        uri={uri}
        label="Sensor photo"
        onClose={() => setPreviewOpen(false)}
      />
    </>
  );
}

// Configure Notifications Handler (SDK 57 requires banner/list flags)
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

function normalizeNavTabForSection(tab, section) {
  if (!tab || !section) return tab;
  if (section === 'inwards') {
    if (tab === 'Outwards' || tab === 'Tasks') return 'Inwards';
    if (tab === 'OutwardReports' || tab === 'Reports') return 'InwardReports';
  } else if (section === 'outwards') {
    if (tab === 'Inwards' || tab === 'Tasks') return 'Outwards';
    if (tab === 'InwardReports' || tab === 'Reports') return 'OutwardReports';
  } else if (section === 'daily') {
    if (tab === 'Inwards' || tab === 'Outwards') return 'Tasks';
    if (tab === 'InwardReports' || tab === 'OutwardReports') return 'Reports';
  }
  return tab;
}

const BOTTOM_TAB_COUNT = 5;

function isMoreMenuTab(tab) {
  return (
    tab === 'More' ||
    tab === 'Profile' ||
    tab === 'Reports' ||
    tab === 'InwardReports' ||
    tab === 'OutwardReports'
  );
}

function getBottomTabIndex(tab) {
  if (tab === 'Dashboard') return 0;
  if (tab === 'Tasks') return 1;
  if (tab === 'Inwards') return 2;
  if (tab === 'Outwards') return 3;
  return 4;
}

const HIDDEN_NAV_TAB_STYLE = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  opacity: 0,
  zIndex: -1,
};

function LazyNavTabPanel({ isActive, isMounted, paintReady, dataLoading, loadingLabel, render }) {
  if (!isActive && !isMounted) return null;
  const showLoader = isActive && (!paintReady || dataLoading);
  return (
    <View
      style={isActive ? { flex: 1 } : HIDDEN_NAV_TAB_STYLE}
      pointerEvents={isActive ? 'auto' : 'none'}
      collapsable={false}
    >
      {isMounted && paintReady ? render() : null}
      {showLoader ? (
        <View
          pointerEvents="none"
          style={
            paintReady
              ? {
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 64,
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 20,
                }
              : {
                  flex: 1,
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingBottom: 64,
                  backgroundColor: '#f1f5f9',
                }
          }
        >
          <Text
            style={{
              fontSize: 14,
              color: '#64748b',
              textAlign: 'center',
              textAlignVertical: 'center',
              includeFontPadding: false,
            }}
          >
            {loadingLabel || 'Loading…'}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * DO field screen — warehouse assignments drive tasks; offline SQLite + sync.
 * Master edits go through permission requests (not direct catalog writes).
 */
export default function DashboardScreen({ user, token, apiUrl, onLogout, onUserUpdate }) {
  const displayName = user.full_name || user.email || 'Data Operator';
  const [chamberLimitOverride, setChamberLimitOverride] = useState(null);
  const [moreProfileOpen, setMoreProfileOpen] = useState(false);
  const [profileClientsTotal, setProfileClientsTotal] = useState(null);
  const [profileClientsLoading, setProfileClientsLoading] = useState(false);
  const moreProfileAnim = useRef(new Animated.Value(0)).current;
  const moreProfileChevron = useRef(new Animated.Value(0)).current;
  const chamberLimit = Math.max(
    1,
    parseInt(chamberLimitOverride ?? user?.chamber_limit ?? 4, 10) || 4
  );

  const persistChamberLimit = async (nextLimit) => {
    const n = parseInt(nextLimit, 10);
    if (!Number.isFinite(n) || n < 1) return;
    setChamberLimitOverride(n);
    try {
      const nextUser = { ...(user || {}), chamber_limit: n };
      await AsyncStorage.setItem('user_profile', JSON.stringify(nextUser));
      if (typeof onUserUpdate === 'function') onUserUpdate(nextUser);
    } catch (_) {}
  };

  /** Shared suggestion names for Add Client picker (not auto-forced on chambers). */
  const [masterClientLots, setMasterClientLots] = useState(() => [...DEFAULT_CLIENT_LOT_MASTER]);
  const [editingClientName, setEditingClientName] = useState(null); // { chamberId, oldName }
  const [editClientDraft, setEditClientDraft] = useState('');

  const refreshMasterClientLots = () => {
    try {
      setMasterClientLots(getClientLotMaster());
    } catch (_) {
      setMasterClientLots([...DEFAULT_CLIENT_LOT_MASTER]);
    }
  };

  /** Remember typed name as a future suggestion; does NOT assign to other chambers. */
  const ensureClientInLotMaster = (rawName) => {
    const name = String(rawName || '').trim();
    if (!name) return '';
    addClientLotMaster(name);
    refreshMasterClientLots();
    return name;
  };

  /** Clients assigned to one chamber only (source of truth for dropdowns / tasks). */
  const getClientsForChamber = (chamberId, list = assignments) => {
    if (chamberId == null) return [];
    return (list || []).filter(
      (a) =>
        Number(a.chamber_id) === Number(chamberId) &&
        a.status !== 'inactive' &&
        String(a.client_name || '').trim() &&
        String(a.client_name).toLowerCase() !== 'general'
    );
  };

  const normalizeChamberTypeValue = (type) => String(type || 'Frozen').trim() || 'Frozen';

  const beginChamberEditSession = (ch) => {
    const draft = buildChamberEditDraft(ch);
    if (!draft) return null;
    setChamberEditDraft(draft);
    setNewClientType(draft.type);
    return draft;
  };

  const ensureChamberEditSession = (ch) => {
    if (!ch?.id) return null;
    setManagerSelectedChamber(ch);
    setEditingChamberId(ch.id);
    if (chamberEditDraft && Number(chamberEditDraft.chamberId) === Number(ch.id)) {
      return chamberEditDraft;
    }
    return beginChamberEditSession(ch);
  };

  const buildChamberEditDraft = (ch) => {
    if (!ch?.id) return null;
    const liveClients = getClientsForChamber(ch.id);
    const type = normalizeChamberTypeValue(
      ch.chamber_type || liveClients[0]?.chamber_type || 'Frozen'
    );
    const clients = liveClients.map((c) => ({
      key: String(c.client_name),
      client_name: c.client_name,
      chamber_type: c.chamber_type || type,
      _op: 'keep'
    }));
    return {
      chamberId: Number(ch.id),
      chamberName: ch.name,
      baselineType: type,
      type,
      baselineClients: clients.map(({ client_name, chamber_type }) => ({ client_name, chamber_type })),
      clients
    };
  };

  const chamberEditHasChanges = (draft = chamberEditDraft) => {
    if (!draft) return false;
    if (normalizeChamberTypeValue(draft.type) !== normalizeChamberTypeValue(draft.baselineType)) {
      return true;
    }
    return (draft.clients || []).some((c) => c._op && c._op !== 'keep');
  };

  const summarizeChamberEditDraft = (draft = chamberEditDraft) => {
    if (!draft) {
      return { typeChanged: false, added: [], deleted: [], renamed: [], summary: '' };
    }
    const typeChanged =
      normalizeChamberTypeValue(draft.type) !== normalizeChamberTypeValue(draft.baselineType);
    const added = (draft.clients || []).filter((c) => c._op === 'add').map((c) => c.client_name);
    const deleted = (draft.clients || []).filter((c) => c._op === 'delete').map((c) => c.client_name);
    const renamed = (draft.clients || []).filter((c) => c._op === 'rename');
    const parts = [];
    if (typeChanged) parts.push(`Type ${draft.baselineType} → ${draft.type}`);
    if (added.length) parts.push(`Add ${added.join(', ')}`);
    if (deleted.length) parts.push(`Delete ${deleted.join(', ')}`);
    if (renamed.length) {
      parts.push(renamed.map((c) => `${c.oldName} → ${c.client_name}`).join(', '));
    }
    return { typeChanged, added, deleted, renamed, summary: parts.join(' · ') };
  };

  const openChamberSetupSavePermission = (chamber) => {
    const draft =
      chamberEditDraft && Number(chamberEditDraft.chamberId) === Number(chamber?.id)
        ? chamberEditDraft
        : chamberEditDraft;
    if (!draft || !chamberEditHasChanges(draft)) return false;
    const info = summarizeChamberEditDraft(draft);
    setPermissionModal({
      isOpen: true,
      status: 'None',
      log: null,
      taskItem: null,
      loading: false,
      mode: 'chamber_setup',
      chamber: chamber || {
        id: draft.chamberId,
        name: draft.chamberName
      },
      nextType: info.typeChanged ? draft.type : null,
      oldType: info.typeChanged ? draft.baselineType : null,
      remark: '',
      setupSummary: info.summary
    });
    return true;
  };

  const closeChamberEditSession = () => {
    setChamberEditDraft(null);
    setManagerSelectedChamber(null);
    setEditingChamberId(null);
    setEditingClientName(null);
    setEditClientDraft('');
    setNewClientInput('');
    setShowClientSuggestions(false);
  };

  const getMasterSetupClients = (chamberId) => {
    if (chamberEditDraft && Number(chamberEditDraft.chamberId) === Number(chamberId)) {
      return chamberEditDraft.clients.filter((c) => c._op !== 'delete');
    }
    return getClientsForChamber(chamberId);
  };

  const requestDiscardChamberEdits = (onDiscard) => {
    if (!chamberEditHasChanges()) {
      onDiscard();
      return;
    }
    Alert.alert(
      'Unsaved changes',
      'Save is required for chamber edits to apply in the app. Discard this setup?',
      [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: onDiscard }
      ]
    );
  };

  const refreshPermissionNotifications = async () => {
    if (!apiUrl || !token) return [];
    try {
      const listRes = await fetch(`${apiUrl}/api/permission-requests?_=${Date.now()}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      });
      if (listRes.ok) {
        const listData = await listRes.json().catch(() => []);
        if (Array.isArray(listData)) {
          setPermissionNotifications(listData);
          return listData;
        }
      }
    } catch (_) {}
    return permissionNotifications;
  };

  /** Chamber completion target = Master Setup client count for that chamber. */
  const getChamberClientTarget = (chamberId) => {
    if (chamberId == null) return null;
    const n = getClientsForChamber(chamberId).length;
    return n >= 1 ? n : null;
  };

  /** Unique clients logged for chamber + shift on a date */
  const countLoggedClientsForChamber = (chamberId, shiftName, dateStr, logs) => {
    const chamber = (chambersList || []).find((c) => Number(c.id) === Number(chamberId));
    const source = logs || getMergedInspectionLogs();
    const names = new Set();
    (source || []).forEach((l) => {
      if (!logOnDate(l, dateStr)) return;
      const logShift = resolveLogShiftName(l) || l.shift;
      if (logShift !== shiftName) return;
      if (!logMatchesChamberRef(l, chamberId, chamber?.name)) return;
      const name = String(l.client_name || '').toLowerCase().trim();
      if (name) names.add(name);
    });
    return names.size;
  };

  /** Keep only first N chambers (same rule as Register DO chamber_limit). */
  const applyChamberLimit = (list) => {
    const rows = Array.isArray(list) ? [...list] : [];
    rows.sort((a, b) => {
      const na = parseInt((String(a.name || '').match(/\d+/) || [a.id])[0], 10);
      const nb = parseInt((String(b.name || '').match(/\d+/) || [b.id])[0], 10);
      return na - nb;
    });
    return rows.slice(0, chamberLimit);
  };

  /** UI number from chamber name (Chamber 1 → 01), never raw DB auto-id. */
  const getChamberDisplayNo = (chamber) => {
    const fromName = String(chamber?.name || '').match(/(\d+)/);
    if (fromName) return String(parseInt(fromName[1], 10)).padStart(2, '0');
    if (chamber?.id != null) return String(chamber.id).padStart(2, '0');
    return '—';
  };

  /** Approval cards must show Chamber 1/2 from the name, never DB id 10/12. */
  const getPermissionChamberLabel = (notif) => {
    const text = `${notif?.request_description || ''} ${notif?.description || ''}`;
    const quoted = (
      text.match(/ADD chamber "([^"]+)"/i) ||
      text.match(/delete chamber "([^"]+)"/i) ||
      text.match(/EDIT chamber type "([^"]+)"/i) ||
      text.match(/EDIT chamber "([^"]+)"/i) ||
      []
    )[1];
    if (quoted && String(quoted).trim()) return String(quoted).trim();

    const lookupId =
      notif?.record_type === 'ChamberMaster'
        ? notif?.record_id
        : notif?.chamber_id;
    const found =
      lookupId != null
        ? chambersList.find((c) => Number(c.id) === Number(lookupId))
        : null;
    if (found?.name) return String(found.name).trim();

    const joined = String(notif?.chamber_name || '').trim();
    const joinedLooksLikeDbId =
      lookupId != null &&
      /^\s*chamber\s*#?\s*\d+\s*$/i.test(joined) &&
      Number((joined.match(/\d+/) || [])[0]) === Number(lookupId);
    if (joined && !joinedLooksLikeDbId && !/^chamber\s*#\s*\d+$/i.test(joined)) {
      return joined;
    }

    const fromPipe = (text.match(/Chamber:\s*([^|]+)/i) || [])[1]?.trim();
    if (fromPipe && !/^#?\d+$/.test(fromPipe)) return fromPipe;

    const grantName = (
      text.match(/(?:Add|Edit|delete)\s+chamber\s*[·:]\s*([^·|]+)/i) || []
    )[1];
    if (grantName && String(grantName).trim() && !/^#?\d+$/.test(grantName.trim())) {
      return String(grantName).trim();
    }

    return 'Chamber';
  };

  /**
   * Tasks = only clients assigned to each chamber (chamber-wise master).
   * Does NOT inject global suggestion names onto every chamber.
   */
  const buildTasksForAssignedChambers = (chambers, rawAssignments) => {
    const chamberRows = Array.isArray(chambers) ? chambers : [];
    const allowedIds = new Set(chamberRows.map((c) => Number(c.id)));
    const active = (Array.isArray(rawAssignments) ? rawAssignments : []).filter(
      (a) =>
        a &&
        a.status !== 'inactive' &&
        allowedIds.has(Number(a.chamber_id)) &&
        String(a.client_name || '').trim() &&
        String(a.client_name).toLowerCase() !== 'general'
    );

    const chamberNameById = new Map(
      chamberRows.map((c) => [Number(c.id), c.name])
    );

    const merged = active.map((a) => ({
      ...a,
      chamber_name: a.chamber_name || chamberNameById.get(Number(a.chamber_id)) || `Chamber ${a.chamber_id}`
    }));

    merged.sort((a, b) => {
      const na = parseInt((String(a.chamber_name || '').match(/\d+/) || [a.chamber_id])[0], 10);
      const nb = parseInt((String(b.chamber_name || '').match(/\d+/) || [b.chamber_id])[0], 10);
      if (na !== nb) return na - nb;
      return String(a.client_name || '').localeCompare(String(b.client_name || ''));
    });
    return merged;
  };

  const formatActivityDateTime = (d = new Date()) => {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  };

  const reportMasterSetupActivity = (chamber, draft, remark) => {
    const when = formatActivityDateTime();
    const info = summarizeChamberEditDraft(draft);
    const chamberName = chamber?.name || draft?.chamberName || 'Chamber';
    const lines = [
      `${when} | ${displayName} saved Master Setup for ${chamberName}`
    ];
    if (info.typeChanged) {
      lines.push(`Chamber type: ${draft.baselineType} → ${draft.type}`);
    }
    if (info.added.length) {
      lines.push(`Client added: ${info.added.join(', ')}`);
    }
    if (info.deleted.length) {
      lines.push(`Client deleted: ${info.deleted.join(', ')}`);
    }
    if (info.renamed.length) {
      lines.push(
        `Client renamed: ${info.renamed.map((c) => `${c.oldName} → ${c.client_name}`).join(', ')}`
      );
    }
    if (remark) {
      lines.push(`Remark: ${remark}`);
    }
    reportDOActivity(
      'MASTER_SETUP',
      lines.join('. '),
      remark,
      chamber?.id || draft?.chamberId || null
    );
  };

  const reportDOActivity = async (action, description, remark = '', recordId = null) => {
    const desc = String(description || '').trim();
    if (!action || !desc) return false;
    const remarkFromDesc = (desc.match(/(?:Remark|Remarks?)\s*:\s*(.+)$/im) || [])[1];
    const resolvedRemark = String(remark || remarkFromDesc || '').trim() || null;
    const logType = [
      'ADD_CLIENT',
      'DELETE_CLIENT',
      'UPDATE_CLIENT',
      'ADD_CHAMBER',
      'DELETE_CHAMBER',
      'UPDATE_CHAMBER',
      'UPDATE_CHAMBER_ZONE',
      'MASTER_SETUP'
    ].includes(String(action))
      ? 'DO_CHANGE'
      : 'activity';

    const queueId = queueLocalActivity({
      action,
      logType,
      description: desc,
      remark: resolvedRemark,
      permissionReq: recordId
    });

    try {
      if (!apiUrl || !token) return false;
      const res = await fetch(`${apiUrl}/api/operator-activities`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        },
        body: JSON.stringify({
          action,
          logType,
          description: desc,
          remark: resolvedRemark,
          record_id: recordId || undefined
        })
      });
      if (res.ok && queueId) markActivitySynced(queueId);
      return res.ok;
    } catch (err) {
      console.warn('⚠️ Failed to report operator activity to backend:', err.message);
      return false;
    }
  };

  // Navigation Tab State: 'Dashboard' | 'Inwards' | 'InwardReports' | 'Outwards' | 'OutwardReports' | 'Profile' | 'Tasks' | 'Reports' | 'More'
  const [currentNavTab, setCurrentNavTab] = useState('Dashboard');
  // Section mode switches bottom tabs: daily (Tasks) vs inwards vs outwards
  const [navSection, setNavSection] = useState('daily'); // 'daily' | 'inwards' | 'outwards'
  const navHistoryRef = useRef([]);
  const handleNavTabChangeRef = useRef(async () => {});
  const mountedNavTabsRef = useRef({ Dashboard: true });
  const [mountedNavTabs, setMountedNavTabs] = useState({ Dashboard: true });
  const tabPaintReadyRef = useRef({ Dashboard: true });
  const [tabPaintReady, setTabPaintReady] = useState({ Dashboard: true });
  const tabIndicatorX = useRef(new Animated.Value(0)).current;
  const tabBarWidthRef = useRef(0);
  const [tabIndicatorWidth, setTabIndicatorWidth] = useState(0);

  // Inward Reports
  const [inwardReportRows, setInwardReportRows] = useState([]);
  const [inwardReportsLoading, setInwardReportsLoading] = useState(false);
  const [inwardReportsError, setInwardReportsError] = useState('');
  const [inwardReportsRefreshing, setInwardReportsRefreshing] = useState(false);
  const [selectedInwardReport, setSelectedInwardReport] = useState(null);
  const [inwardReportSearch, setInwardReportSearch] = useState('');
  const [inwardReportDateFrom, setInwardReportDateFrom] = useState(() => getLocalDateStr());
  const [inwardReportDateTo, setInwardReportDateTo] = useState(() => getLocalDateStr());
  const [inwardReportMissingPod, setInwardReportMissingPod] = useState(false);
  const [inwardReportPage, setInwardReportPage] = useState(1);
  const [inwardReportTotal, setInwardReportTotal] = useState(0);
  const [inwardReportHasMore, setInwardReportHasMore] = useState(false);
  const [dockReportCalendarOpen, setDockReportCalendarOpen] = useState(false);
  const [dockReportCalendarKind, setDockReportCalendarKind] = useState('inward'); // 'inward' | 'outward'
  const [dockReportCalendarPickMode, setDockReportCalendarPickMode] = useState('from');
  const [dockReportCalendarMonth, setDockReportCalendarMonth] = useState(new Date());

  // Outward Reports
  const [outwardReportRows, setOutwardReportRows] = useState([]);
  const [outwardReportsLoading, setOutwardReportsLoading] = useState(false);
  const [outwardReportsError, setOutwardReportsError] = useState('');
  const [outwardReportsRefreshing, setOutwardReportsRefreshing] = useState(false);
  const [selectedOutwardReport, setSelectedOutwardReport] = useState(null);
  const [outwardReportSearch, setOutwardReportSearch] = useState('');
  const [outwardReportDateFrom, setOutwardReportDateFrom] = useState(() => getLocalDateStr());
  const [outwardReportDateTo, setOutwardReportDateTo] = useState(() => getLocalDateStr());
  const [outwardReportMissingPod, setOutwardReportMissingPod] = useState(false);
  const [outwardReportPage, setOutwardReportPage] = useState(1);
  const [outwardReportTotal, setOutwardReportTotal] = useState(0);
  const [outwardReportHasMore, setOutwardReportHasMore] = useState(false);
  const [podUploadBusy, setPodUploadBusy] = useState(false);
  const [imagePreview, setImagePreview] = useState(null); // { uri, label } | null

  // Sub-filter tabs inside Dashboard / Tasks: 'All' | 'Pending' | 'Completed' | 'Failed'
  const [activeTab, setActiveTab] = useState('All'); 

  // Tasks Tab Filters
  const [taskChamberFilter, setTaskChamberFilter] = useState('All');
  const [taskClientFilter, setTaskClientFilter] = useState('All');
  const [taskOpenFilter, setTaskOpenFilter] = useState(null); // 'chamber' | 'client' | null
  const [taskPickerQuery, setTaskPickerQuery] = useState('');

  // DateTime Display States
  const [currentTime, setCurrentTime] = useState('');
  const [currentDateStr, setCurrentDateStr] = useState('');
  const [currentDayStr, setCurrentDayStr] = useState('');

  // View state managers
  const [selectedChamber, setSelectedChamber] = useState(null); // Tapped chamber context
  const [showLogModal, setShowLogModal] = useState(false);
  const [selectedClient, setSelectedClient] = useState(null); // Active client log context
  const [openedFromFab, setOpenedFromFab] = useState(false); // Opened from the central '+' button
  const [isProfileEditable, setIsProfileEditable] = useState(true); // Edit vs Read-only toggle
  const [reportSearchQuery, setReportSearchQuery] = useState('');
  const [reportChamberFilter, setReportChamberFilter] = useState('all'); // 'all' | chamber_id
  const [reportClientFilter, setReportClientFilter] = useState('All');
  const [reportTypeFilter, setReportTypeFilter] = useState('all'); // all | Frozen | Chilled | Dry | Other
  const [reportWarehouseFilter, setReportWarehouseFilter] = useState('All');
  const [reportShiftFilter, setReportShiftFilter] = useState('all'); // legacy temp-log filter
  const [reportView, setReportView] = useState('all'); // all | mismatch (inventory)
  const [reportDrillChamber, setReportDrillChamber] = useState(null); // { id, name } | null
  const [dailyReportChamberFilter, setDailyReportChamberFilter] = useState('all');
  const [dailyReportClientFilter, setDailyReportClientFilter] = useState('All');
  const [dailyReportOpenFilter, setDailyReportOpenFilter] = useState(null); // 'chamber' | 'client' | null
  const [dailyReportPickerQuery, setDailyReportPickerQuery] = useState('');
  const [showDailyReportCalendar, setShowDailyReportCalendar] = useState(false);
  const [dailyReportCalendarMonth, setDailyReportCalendarMonth] = useState(new Date());
  const [reportsMode, setReportsMode] = useState('inventory'); // inventory | temperature
  const [chamberReportLogs, setChamberReportLogs] = useState([]);
  const [chamberReportsLoading, setChamberReportsLoading] = useState(false);
  const [chamberReportsError, setChamberReportsError] = useState('');
  const [showReportChamberDropdown, setShowReportChamberDropdown] = useState(false);
  const [showReportClientDropdown, setShowReportClientDropdown] = useState(false);
  const [showReportTypeDropdown, setShowReportTypeDropdown] = useState(false);
  const [showReportWarehouseDropdown, setShowReportWarehouseDropdown] = useState(false);
  const [inventoryReportRows, setInventoryReportRows] = useState([]);
  const [inventoryReportWarehouses, setInventoryReportWarehouses] = useState([]);
  const [inventoryReportClients, setInventoryReportClients] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportsError, setReportsError] = useState('');
  const [reportsRefreshing, setReportsRefreshing] = useState(false);
  const [reportsLoadingMore, setReportsLoadingMore] = useState(false);
  const [reportHasMore, setReportHasMore] = useState(false);
  const reportOffsetRef = useRef(0);
  const reportsLoadingMoreRef = useRef(false);
  const reportHasMoreRef = useRef(false);
  const [selectedInventoryReport, setSelectedInventoryReport] = useState(null);
  const [inventoryHistory, setInventoryHistory] = useState([]);
  const [inventoryHistoryLoading, setInventoryHistoryLoading] = useState(false);
  const [inventoryHistoryError, setInventoryHistoryError] = useState('');
  const [selectedReportLog, setSelectedReportLog] = useState(null); // Customer-style log detail from inventory day row
  const [editingExistingLog, setEditingExistingLog] = useState(null); // local completed log being edited after SA approval
  const [updateTimeInput, setUpdateTimeInput] = useState(''); // HH:mm on edit form → saved as inspection_time + updated_at
  const [permissionModal, setPermissionModal] = useState({
    isOpen: false,
    status: 'None',
    log: null,
    taskItem: null,
    loading: false,
    mode: 'log',
    chamber: null,
    nextType: null,
    oldType: null,
    remark: '',
    oldName: null,
    newName: null
  });
  const [permissionRequestBusy, setPermissionRequestBusy] = useState(false);
  const [permissionNotifications, setPermissionNotifications] = useState([]);
  
  // Completed Log Metadata for read-only view
  const [logOperatorName, setLogOperatorName] = useState('');
  const [logWarehouseName, setLogWarehouseName] = useState('');
  const [logOperatorEmail, setLogOperatorEmail] = useState('');
  const [logSyncStatus, setLogSyncStatus] = useState('');
  const [logEntryTime, setLogEntryTime] = useState('');
  const [logShift, setLogShift] = useState('');

  // Server URL is configured on Login screen only
  const [selectedShift, setSelectedShift] = useState('10:00');
  const [activeShift, setActiveShift] = useState(new Date().getHours() >= 16 ? 'Evening' : 'Morning');
  
  // Clicked tracking states for red notification
  const [morningClicked, setMorningClicked] = useState(activeShift === 'Morning');
  const [eveningClicked, setEveningClicked] = useState(activeShift === 'Evening');

  useEffect(() => {
    const loadClickedStates = async () => {
      try {
        const todayStr = getLocalDateStr();
        const mKey = `@morning_clicked_${todayStr}`;
        const eKey = `@evening_clicked_${todayStr}`;
        
        const mVal = await AsyncStorage.getItem(mKey);
        const eVal = await AsyncStorage.getItem(eKey);
        
        if (mVal === 'true') {
          setMorningClicked(true);
        }
        if (eVal === 'true') {
          setEveningClicked(true);
        }
      } catch (err) {
        console.warn('Failed to load clicked states:', err);
      }
    };
    loadClickedStates();
  }, []);

  const handleSelectShift = async (shift) => {
    setActiveShift(shift);
    const todayStr = getLocalDateStr();
    if (shift === 'Morning') {
      setMorningClicked(true);
      try {
        await AsyncStorage.setItem(`@morning_clicked_${todayStr}`, 'true');
      } catch (err) {
        console.warn(err);
      }
    } else if (shift === 'Evening') {
      setEveningClicked(true);
      try {
        await AsyncStorage.setItem(`@evening_clicked_${todayStr}`, 'true');
      } catch (err) {
        console.warn(err);
      }
    }
  };
  
  // Inputs & captures state
  const [tempInput, setTempInput] = useState('');
  const [boxCountInput, setBoxCountInput] = useState('');
  const [capturedImage, setCapturedImage] = useState(null);
  const [capturedImageTimestamp, setCapturedImageTimestamp] = useState(null);
  const [capturedImageGeo, setCapturedImageGeo] = useState(null);
  const [showSubmitConfirmModal, setShowSubmitConfirmModal] = useState(false);
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [showDrawer, setShowDrawer] = useState(false);
  const drawerAnim = React.useRef(new Animated.Value(-280)).current;

  useEffect(() => {
    if (showDrawer) {
      Animated.timing(drawerAnim, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }).start();
    }
  }, [showDrawer]);

  const closeDrawer = () => {
    Animated.timing(drawerAnim, {
      toValue: -280,
      duration: 200,
      useNativeDriver: true,
    }).start(() => {
      setShowDrawer(false);
    });
  };
  const [selectedReportDate, setSelectedReportDate] = useState(getLocalDateStr());
  const [reportDateFrom, setReportDateFrom] = useState(getLocalDateStr());
  const [reportDateTo, setReportDateTo] = useState(getLocalDateStr());
  const [calendarPickMode, setCalendarPickMode] = useState('from'); // 'from' | 'to'
  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const [showInventoryModal, setShowInventoryModal] = useState(false);
  const [selectedInventoryItem, setSelectedInventoryItem] = useState(null);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showNotificationsModal, setShowNotificationsModal] = useState(false);
  const [inventoryClientSearch, setInventoryClientSearch] = useState('');
  const [inventoryChamberSearch, setInventoryChamberSearch] = useState('');
  const [showInventoryClientDropdown, setShowInventoryClientDropdown] = useState(false);
  const [showInventoryChamberDropdown, setShowInventoryChamberDropdown] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [detailCalendarOpen, setDetailCalendarOpen] = useState(false);
  const [detailCalendarPickMode, setDetailCalendarPickMode] = useState('from');
  const [detailCalendarMonth, setDetailCalendarMonth] = useState(new Date());
  const [detailDateFrom, setDetailDateFrom] = useState('');
  const [detailDateTo, setDetailDateTo] = useState('');
  const [showClientDropdown, setShowClientDropdown] = useState(false);
  const [showChamberDropdown, setShowChamberDropdown] = useState(false);
  const [showAddClientModal, setShowAddClientModal] = useState(false);
  const [showAddChamberModal, setShowAddChamberModal] = useState(false);
  const [addChamberNameInput, setAddChamberNameInput] = useState('');
  const [addChamberRemarkInput, setAddChamberRemarkInput] = useState('');
  const [addChamberBusy, setAddChamberBusy] = useState(false);
  const [inlineClientInput, setInlineClientInput] = useState('');
  const [inlineRemarkInput, setInlineRemarkInput] = useState('');
  const [selectedChamberType, setSelectedChamberType] = useState('Frozen');
  
  // Custom Client Deletion Reason Modal States
  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState(false);
  const [clientToDelete, setClientToDelete] = useState(null);
  const [deleteRemarkInput, setDeleteRemarkInput] = useState('');
  
  // Client Master Manager Modal States
  const [showClientManagerModal, setShowClientManagerModal] = useState(false);
  const [managerSelectedChamber, setManagerSelectedChamber] = useState(null);
  const [editingChamberId, setEditingChamberId] = useState(null);
  /** Unsaved Master Setup chamber edits. Live Tasks/Dashboard stay on saved data until Save. */
  const [chamberEditDraft, setChamberEditDraft] = useState(null);
  const [masterManagerTab, setMasterManagerTab] = useState('chambers'); // 'chambers' | 'clients'
  const [showManagerChamberDropdown, setShowManagerChamberDropdown] = useState(false);
  const [showClientSuggestions, setShowClientSuggestions] = useState(false);
  const [newClientInput, setNewClientInput] = useState('');
  const [newClientType, setNewClientType] = useState('Frozen');
  const [newChamberNameInput, setNewChamberNameInput] = useState('');
  const [masterAccessLoading, setMasterAccessLoading] = useState(false);

  const masterRecordId = user?.id || 1;  
  // Data lists loaded from DB
  const [chambersList, setChambersList] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [completedLogs, setCompletedLogs] = useState([]); // Today's completed log entries (synced + unsynced)
  const [unsyncedLogs, setUnsyncedLogs] = useState([]); // Offline queue logs (only unsynced)
  const [pendingCount, setPendingCount] = useState(0);
  const [selectedTaskDueDate, setSelectedTaskDueDate] = useState('');
  const [overdueTasks, setOverdueTasks] = useState([]);
  const [overdueCount, setOverdueCount] = useState(0);
  const [syncStatus, setSyncStatus] = useState('idle'); // 'idle' | 'syncing' | 'partial' | 'failed'
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [syncMessage, setSyncMessage] = useState('');
  const [syncPendingCount, setSyncPendingCount] = useState(0);
  const [syncFailures, setSyncFailures] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const countActiveClients = useCallback((list, chamberIds = null) => {
    const allowed =
      chamberIds && chamberIds.size > 0 ? chamberIds : null;
    let total = 0;
    (list || []).forEach((a) => {
      if (!a) return;
      const status = String(a.status || 'active').trim().toLowerCase();
      if (
        status === 'inactive' ||
        status === 'deactive' ||
        status === 'deactivated' ||
        status === 'disabled' ||
        status === '0' ||
        status === 'false'
      ) {
        return;
      }
      const name = String(a.client_name || '').trim();
      if (!name || name.toLowerCase() === 'general') return;
      if (allowed && !allowed.has(Number(a.chamber_id))) return;
      total += 1;
    });
    return total;
  }, []);

  const totalClientsCount = useMemo(() => {
    // Assignments list = one row per chamber–client (Master Setup total)
    return countActiveClients(assignments, null);
  }, [assignments, countActiveClients]);

  const fetchProfileClientsTotal = useCallback(async () => {
    setProfileClientsLoading(true);
    try {
      let nextCount = null;

      if (apiUrl && token) {
        try {
          const res = await fetch(`${apiUrl}/api/chambers/assignments`, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json'
            }
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && Array.isArray(data.data)) {
            // API already scopes to this DO warehouse — count all active clients
            nextCount = countActiveClients(data.data, null);
            try {
              cacheAssignments(data.data, user?.warehouse_name, user?.warehouse_code);
            } catch (_) {}
          }
        } catch (_) {
          /* offline — fall through to local */
        }
      }

      if (nextCount == null) {
        const local = getLocalAssignments(user?.warehouse_name, user?.warehouse_code);
        nextCount = countActiveClients(local, null);
      }

      setProfileClientsTotal(nextCount);
    } catch (_) {
      setProfileClientsTotal(totalClientsCount);
    } finally {
      setProfileClientsLoading(false);
    }
  }, [
    apiUrl,
    token,
    countActiveClients,
    user?.warehouse_name,
    user?.warehouse_code,
    totalClientsCount
  ]);

  const toggleMoreProfile = useCallback(() => {
    LayoutAnimation.configureNext({
      duration: 280,
      update: {
        type: LayoutAnimation.Types.easeInEaseOut
      },
      create: {
        type: LayoutAnimation.Types.easeInEaseOut,
        property: LayoutAnimation.Properties.opacity
      },
      delete: {
        type: LayoutAnimation.Types.easeInEaseOut,
        property: LayoutAnimation.Properties.opacity
      }
    });
    if (moreProfileOpen) {
      Animated.parallel([
        Animated.timing(moreProfileChevron, {
          toValue: 0,
          duration: 240,
          useNativeDriver: true
        }),
        Animated.timing(moreProfileAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true
        })
      ]).start(({ finished }) => {
        if (finished) setMoreProfileOpen(false);
      });
    } else {
      setMoreProfileOpen(true);
      moreProfileAnim.setValue(0);
      fetchProfileClientsTotal();
      Animated.parallel([
        Animated.timing(moreProfileChevron, {
          toValue: 1,
          duration: 280,
          useNativeDriver: true
        }),
        Animated.timing(moreProfileAnim, {
          toValue: 1,
          duration: 280,
          useNativeDriver: true
        })
      ]).start();
    }
  }, [
    moreProfileOpen,
    moreProfileAnim,
    moreProfileChevron,
    fetchProfileClientsTotal
  ]);

  const resolveLogShiftName = (log) => {
    if (!log) return '';
    const s = String(log.shift || '').trim();
    if (s === 'Morning' || s === 'Evening') return s;
    const t = String(log.inspection_time || '').trim();
    if (t.startsWith('10:00') || t === '10:00 AM') return 'Morning';
    if (t.startsWith('16:00') || t.startsWith('18:00') || t.includes('04:00 PM')) return 'Evening';
    const hm = t.match(/^(\d{1,2}):(\d{2})/);
    if (hm) {
      const h = parseInt(hm[1], 10);
      return h < 14 ? 'Morning' : 'Evening';
    }
    return s;
  };

  const logOnDate = (log, dateStr) =>
    logDateKey(log?.formatted_date || log?.entry_date) === logDateKey(dateStr);

  const resolveLogChamberId = (log) => {
    if (log?.chamber_id != null && String(log.chamber_id).trim() !== '') {
      const n = Number(log.chamber_id);
      if (Number.isFinite(n)) return n;
    }
    const found = (chambersList || []).find((c) => namesMatch(c.name, log?.chamber_name));
    return found?.id ?? null;
  };

  const logMatchesChamberRef = (log, chamberId, chamberName) => {
    if (!log) return false;
    if (chamberId != null && log.chamber_id != null && Number(log.chamber_id) === Number(chamberId)) {
      return true;
    }
    if (chamberName && namesMatch(log.chamber_name, chamberName)) return true;
    if (chamberId != null) {
      const resolved = resolveLogChamberId(log);
      if (resolved != null && Number(resolved) === Number(chamberId)) return true;
    }
    return false;
  };

  const getMergedInspectionLogs = () =>
    mergeChamberReportLogs(
      chamberReportLogs || [],
      [...(completedLogs || []), ...getAllLocalInspections(displayName, user?.email)]
    );

  const findShiftLog = (chamberId, clientName, dateStr, shiftName, chamberName) =>
    getMergedInspectionLogs().find(
      (l) =>
        l &&
        logOnDate(l, dateStr) &&
        logMatchesChamberRef(l, chamberId, chamberName) &&
        namesMatch(l.client_name, clientName) &&
        (!shiftName || resolveLogShiftName(l) === shiftName)
    );

  const handleSyncProgress = (payload) => {
    const p = typeof payload === 'string' ? { status: payload } : payload || {};
    if (p.status) setSyncStatus(p.status);
    if (p.lastSyncAt) setLastSyncAt(p.lastSyncAt);
    if (p.message) setSyncMessage(p.message);
    if (p.pendingCount != null) setSyncPendingCount(p.pendingCount);
    if (Array.isArray(p.failures)) setSyncFailures(p.failures);
    if (p.status === 'idle' || p.status === 'partial' || p.status === 'failed') {
      loadInspectionsAndSummary();
      setSyncPendingCount(
        countPendingSyncItems(user?.warehouse_name, displayName, user?.email)
      );
    }
  };

  /** True when every Master Setup client on every chamber is logged for this shift today. */
  const isShiftFullyCompleted = (shiftName) => {
    const todayStr = getLocalDateStr();
    const chambersWithClients = (chambersList || []).filter(
      (ch) => getClientsForChamber(ch.id).length > 0
    );
    if (chambersWithClients.length === 0) return false;

    return chambersWithClients.every((ch) => {
      const clients = getClientsForChamber(ch.id);
      const done = countLoggedClientsForChamber(ch.id, shiftName, todayStr);
      return done >= clients.length;
    });
  };

  const isMorningCompleted = useMemo(
    () => isShiftFullyCompleted('Morning'),
    [assignments, completedLogs, chambersList]
  );

  const isEveningCompleted = useMemo(
    () => isShiftFullyCompleted('Evening'),
    [assignments, completedLogs, chambersList]
  );

  // Handle Android system back button presses
  useEffect(() => {
    const backAction = () => {
      if (showDrawer) {
        closeDrawer();
        return true;
      }
      if (showLogModal) {
        setShowLogModal(false);
        return true;
      }
      if (selectedChamber) {
        setSelectedChamber(null);
        return true;
      }
      if (selectedClient) {
        setSelectedClient(null);
        return true;
      }
      if (showClientManagerModal) {
        setShowClientManagerModal(false);
        return true;
      }
      if (showDeleteConfirmModal) {
        setShowDeleteConfirmModal(false);
        return true;
      }
      if (showAddChamberModal) {
        setShowAddChamberModal(false);
        return true;
      }
      if (showAddClientModal) {
        setShowAddClientModal(false);
        return true;
      }
      if (showSubmitConfirmModal) {
        setShowSubmitConfirmModal(false);
        return true;
      }
      if (permissionModal?.isOpen) {
        setPermissionModal((prev) => ({ ...prev, isOpen: false }));
        return true;
      }
      if (showInventoryModal) {
        setShowInventoryModal(false);
        return true;
      }
      if (showHistoryModal) {
        setShowHistoryModal(false);
        return true;
      }
      if (showNotificationsModal) {
        setShowNotificationsModal(false);
        return true;
      }
      if (dockReportCalendarOpen) {
        setDockReportCalendarOpen(false);
        return true;
      }
      if (showCalendarModal) {
        setShowCalendarModal(false);
        return true;
      }
      if (showDailyReportCalendar) {
        setShowDailyReportCalendar(false);
        return true;
      }
      if (selectedReportLog) {
        setSelectedReportLog(null);
        return true;
      }
      if (selectedInwardReport) {
        setSelectedInwardReport(null);
        return true;
      }
      if (selectedOutwardReport) {
        setSelectedOutwardReport(null);
        return true;
      }
      if (editingExistingLog) {
        setEditingExistingLog(null);
        return true;
      }
      if (taskOpenFilter) {
        setTaskOpenFilter(null);
        setTaskPickerQuery('');
        return true;
      }
      if (dailyReportOpenFilter) {
        setDailyReportOpenFilter(null);
        setDailyReportPickerQuery('');
        return true;
      }
      if (reportDrillChamber) {
        setReportDrillChamber(null);
        setDailyReportChamberFilter('all');
        return true;
      }
      if (navHistoryRef.current.length > 0) {
        const prev = navHistoryRef.current.pop();
        handleNavTabChangeRef.current(prev.tab, prev.section, { fromBack: true });
        return true;
      }
      if (currentNavTab !== 'Dashboard') {
        handleNavTabChangeRef.current('Dashboard', 'daily', { fromBack: true });
        return true;
      }
      return false;
    };

    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => backHandler.remove();
  }, [
    showDrawer,
    showLogModal,
    selectedChamber,
    selectedClient,
    showClientManagerModal,
    showDeleteConfirmModal,
    showAddChamberModal,
    showAddClientModal,
    showSubmitConfirmModal,
    permissionModal,
    showInventoryModal,
    showHistoryModal,
    showNotificationsModal,
    showCalendarModal,
    dockReportCalendarOpen,
    showDailyReportCalendar,
    selectedReportLog,
    selectedInwardReport,
    selectedOutwardReport,
    editingExistingLog,
    taskOpenFilter,
    dailyReportOpenFilter,
    reportDrillChamber,
    currentNavTab
  ]);

  // Schedule morning/evening reminders — skip if that shift is already completed today
  useEffect(() => {
    if (isLoadingData) return undefined;

    let cancelled = false;
    (async () => {
      try {
        if (cancelled) return;
        const activeAssignments = (assignments || []).filter(
          (item) => item.status !== 'inactive'
        );
        const totalClients = activeAssignments.length;
        const { pendingMorning } = getActiveTasksDetails();
        await refreshTaskReminders({
          morningCompleted: isMorningCompleted,
          eveningCompleted: isEveningCompleted,
          morningClientCount: totalClients,
          eveningClientCount: totalClients,
          morningPendingCount: pendingMorning.length
        });
      } catch (err) {
        console.warn('Failed to refresh task reminders:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isMorningCompleted,
    isEveningCompleted,
    isLoadingData,
    assignments,
    completedLogs,
    chambersList
  ]);

  // Expo push token refresh on open / foreground (permission Approved/Denied when app closed)
  useEffect(() => {
    if (!apiUrl || !token) return undefined;
    const unsub = subscribePushTokenRefresh({ apiUrl, authToken: token });
    return () => {
      try {
        unsub?.();
      } catch (_) {
        /* ignore */
      }
    };
  }, [apiUrl, token]);

  // Tap notification → open Tasks (shift reminder) or permission decisions
  useEffect(() => {
    const openFromNotificationData = async (data = {}) => {
      if (data.type === 'permission_decision') {
        setShowNotificationsModal(true);
        return;
      }
      const shiftRaw = String(data.shift || '').trim();
      const isTaskReminder =
        data.type === 'task_reminder' ||
        /^Morning$/i.test(shiftRaw) ||
        /^Evening$/i.test(shiftRaw);
      if (!isTaskReminder) return;

      const shift = /^Evening$/i.test(shiftRaw) ? 'Evening' : 'Morning';
      try {
        await handleSelectShift(shift);
      } catch (_) {
        setActiveShift(shift);
      }
      try {
        await handleNavTabChangeRef.current?.('Tasks', 'daily');
      } catch (_) {
        setCurrentNavTab('Tasks');
      }
    };

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response?.notification?.request?.content?.data || {};
      openFromNotificationData(data);
    });

    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!response) return;
        const data = response?.notification?.request?.content?.data || {};
        openFromNotificationData(data);
      })
      .catch(() => {});

    return () => {
      try {
        sub.remove();
      } catch (_) {
        /* ignore */
      }
    };
  }, []);

  const performLogout = useCallback(() => {
    // End session immediately — never block logout on network / push cleanup
    const done = onLogout?.();
    clearExpoPushToken({ apiUrl, authToken: token }).catch(() => {});
    try {
      clearSyncedInspectionsLocally();
    } catch (_) {
      /* ignore */
    }
    return done;
  }, [apiUrl, token, onLogout]);

  const handleLogout = useCallback(() => {
    Alert.alert('Logout', 'Do you want to end this session and go to login?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: () => {
          performLogout();
        }
      }
    ]);
  }, [performLogout]);

  const completedChambersCount = useMemo(() => {
    const todayStr = getLocalDateStr();
    return chambersList.filter((chamber) => {
      const target = getChamberClientTarget(chamber.id);
      if (target == null) return false;
      const done = countLoggedClientsForChamber(chamber.id, activeShift, todayStr);
      return done >= target;
    }).length;
  }, [chambersList, completedLogs, activeShift, assignments]);

  const getActiveTasksDetails = () => {
    const isEveningUnlocked = new Date().getHours() >= 16;
    const activeAssignments = assignments.filter(item => item.status !== 'inactive');
    const todayStr = getLocalDateStr();

    const isTodayLog = (log, shiftName) =>
      logOnDate(log, todayStr) && resolveLogShiftName(log) === shiftName;

    const completedMorningLogs = completedLogs.filter((log) => isTodayLog(log, 'Morning'));
    const pendingMorning = activeAssignments.filter(
      (task) =>
        !completedMorningLogs.some(
          (log) =>
            logMatchesChamberRef(log, task.chamber_id, task.chamber_name) &&
            namesMatch(log.client_name, task.client_name)
        )
    );

    const completedEveningLogs = completedLogs.filter((log) => isTodayLog(log, 'Evening'));
    const pendingEvening = activeAssignments.filter(
      (task) =>
        !completedEveningLogs.some(
          (log) =>
            logMatchesChamberRef(log, task.chamber_id, task.chamber_name) &&
            namesMatch(log.client_name, task.client_name)
        )
    );

    return {
      pendingMorning,
      pendingEvening,
      isEveningUnlocked
    };
  };

  // Auto-switch activeShift to Evening if Morning tasks are completed and Evening is unlocked
  useEffect(() => {
    const isEveningUnlocked = new Date().getHours() >= 16;
    if (isMorningCompleted && activeShift === 'Morning' && isEveningUnlocked) {
      setActiveShift('Evening');
    }
  }, [isMorningCompleted, activeShift]);

  // Dimensions
  const { width } = useWindowDimensions();
  const isTablet = width > 600;

  // 1. Ticking Time logic
  useEffect(() => {
    const updateDateTime = () => {
      const now = new Date();
      const day = String(now.getDate()).padStart(2, '0');
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const month = months[now.getMonth()];
      const year = now.getFullYear();
      setCurrentDateStr(`${day} ${month} ${year}`);

      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      setCurrentDayStr(days[now.getDay()]);

      const hoursStr = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      setCurrentTime(`${hoursStr}:${minutes}`);
    };

    updateDateTime();
    const timerInterval = setInterval(updateDateTime, 15000); // Update every 15s
    return () => clearInterval(timerInterval);
  }, []);

  // 2. Load Navigation Tab from Storage
  useEffect(() => {
    const loadNavTab = async () => {
      try {
        const savedTab = await AsyncStorage.getItem('active_mobile_nav_tab');
        const savedSection = await AsyncStorage.getItem('active_mobile_nav_section');
        let resolvedSection =
          savedSection === 'inwards' || savedSection === 'daily' || savedSection === 'outwards'
            ? savedSection
            : null;
        if (!resolvedSection && savedTab) {
          if (savedTab === 'Inwards' || savedTab === 'InwardReports') resolvedSection = 'inwards';
          else if (savedTab === 'Outwards' || savedTab === 'OutwardReports') resolvedSection = 'outwards';
          else resolvedSection = 'daily';
        }
        if (resolvedSection) {
          setNavSection(resolvedSection);
        }
        if (savedTab) {
          const normalizedTab = normalizeNavTabForSection(savedTab, resolvedSection || 'daily');
          if (normalizedTab) {
            mountedNavTabsRef.current[normalizedTab] = true;
            tabPaintReadyRef.current[normalizedTab] = true;
            setMountedNavTabs((prev) => ({ ...prev, [normalizedTab]: true }));
            setTabPaintReady((prev) => ({ ...prev, [normalizedTab]: true }));
          }
          setCurrentNavTab(normalizedTab);
        }
      } catch (e) {
        console.warn('Failed to load active navigation tab:', e);
      }
    };
    loadNavTab();
  }, []);

  useEffect(() => {
    if (!mountedNavTabsRef.current[currentNavTab]) {
      mountedNavTabsRef.current[currentNavTab] = true;
      setMountedNavTabs((prev) => (
        prev[currentNavTab] ? prev : { ...prev, [currentNavTab]: true }
      ));
    }
    if (tabPaintReadyRef.current[currentNavTab]) return undefined;

    let cancelled = false;
    const markReady = () => {
      if (cancelled || tabPaintReadyRef.current[currentNavTab]) return;
      tabPaintReadyRef.current[currentNavTab] = true;
      setTabPaintReady((prev) => (
        prev[currentNavTab] ? prev : { ...prev, [currentNavTab]: true }
      ));
    };

    const handle = InteractionManager.runAfterInteractions(markReady);
    const timeout = setTimeout(markReady, 80);
    return () => {
      cancelled = true;
      handle.cancel();
      clearTimeout(timeout);
    };
  }, [currentNavTab]);

  // Handler to switch tabs and save in AsyncStorage
  const handleNavTabChange = async (tab, sectionOverride = null, options = {}) => {
    let nextSection = sectionOverride;
    if (!nextSection) {
      if (tab === 'Inwards' || tab === 'InwardReports') nextSection = 'inwards';
      else if (tab === 'Outwards' || tab === 'OutwardReports') nextSection = 'outwards';
      else if (tab === 'Tasks' || tab === 'Reports') nextSection = 'daily';
      else nextSection = navSection;
    }

    let nextTab = normalizeNavTabForSection(tab, nextSection);

    if (nextTab === currentNavTab && nextSection === navSection) {
      return;
    }

    if (!options.fromBack) {
      navHistoryRef.current = [
        ...navHistoryRef.current.slice(-19),
        { tab: currentNavTab, section: navSection },
      ];
    }

    if (!mountedNavTabsRef.current[nextTab]) {
      mountedNavTabsRef.current[nextTab] = true;
      setMountedNavTabs((prev) => (prev[nextTab] ? prev : { ...prev, [nextTab]: true }));
    }

    setNavSection(nextSection);
    setCurrentNavTab(nextTab);
    if (nextTab !== 'Tasks') {
      setTaskOpenFilter(null);
      setTaskPickerQuery('');
    }
    if (nextTab !== 'Reports') {
      setReportDrillChamber(null);
      setDailyReportChamberFilter('all');
      setDailyReportClientFilter('All');
      setDailyReportOpenFilter(null);
      setDailyReportPickerQuery('');
      setShowDailyReportCalendar(false);
      setSelectedReportDate(getLocalDateStr());
    }
    if (nextTab === 'Tasks' || nextTab === 'Reports') {
      loadInspectionsAndSummary();
    }
    try {
      await AsyncStorage.setItem('active_mobile_nav_tab', nextTab);
      await AsyncStorage.setItem('active_mobile_nav_section', nextSection);
    } catch (e) {
      console.warn('Failed to save active navigation tab:', e);
    }
  };
  handleNavTabChangeRef.current = handleNavTabChange;

  const slideTabIndicator = useCallback((index, barWidth, animated) => {
    if (!barWidth) return;
    const tabW = barWidth / BOTTOM_TAB_COUNT;
    const lineW = Math.max(28, tabW * 0.5);
    const x = index * tabW + (tabW - lineW) / 2;
    if (!animated) {
      tabIndicatorX.setValue(x);
      return;
    }
    Animated.spring(tabIndicatorX, {
      toValue: x,
      useNativeDriver: true,
      friction: 8,
      tension: 90,
    }).start();
  }, [tabIndicatorX]);

  useEffect(() => {
    slideTabIndicator(getBottomTabIndex(currentNavTab), tabBarWidthRef.current, true);
  }, [currentNavTab, slideTabIndicator]);

  // Sync state update when prop changes — removed (IP config is on Login only)

  // Pre-select shift based on active shift filter when modal opens in editable mode
  useEffect(() => {
    if (showLogModal && isProfileEditable) {
      setSelectedShift(activeShift === 'Morning' ? '10:00' : '16:00');
    }
  }, [showLogModal, isProfileEditable, activeShift]);

  // Recalculate pending tasks count whenever activeShift, completedLogs or assignments change
  useEffect(() => {
    const todayStr = getLocalDateStr();
    const activeAssignmentsToday = assignments.filter(item => item.status !== 'inactive');

    const pendingTasksList = activeAssignmentsToday.filter(item => {
      const log = completedLogs.find(l =>
        logMatchesChamberRef(l, item.chamber_id, item.chamber_name) &&
        namesMatch(l.client_name, item.client_name) &&
        logOnDate(l, todayStr) &&
        resolveLogShiftName(l) === activeShift
      );
      return !log;
    });

    setPendingCount(pendingTasksList.length);
  }, [activeShift, completedLogs, assignments]);

  useEffect(() => {
    if (!managerSelectedChamber?.id) return;
    if (chamberEditDraft && Number(chamberEditDraft.chamberId) === Number(managerSelectedChamber.id)) {
      setNewClientType(normalizeChamberTypeValue(chamberEditDraft.type));
      return;
    }
    const chamberClients = getClientsForChamber(managerSelectedChamber.id);
    const currentType =
      managerSelectedChamber.chamber_type ||
      chamberClients[0]?.chamber_type ||
      'Frozen';
    setNewClientType(currentType);
    // Only when switching chambers — do not reset while user taps Frozen/Chilled/Dry
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managerSelectedChamber?.id]);

  // 3. Initialize SQLite DB and Sync Services
  useEffect(() => {
    initDatabase();
    refreshMasterClientLots();

    let unsubscribeSync = null;
    (async () => {
    // Force-clear demo clients so dashboard empty CTA shows (Expo Go SQLite cache)
    try {
      const purgedKey = 'purged_default_client_master_v3';
      const already = await AsyncStorage.getItem(purgedKey);
      const n = purgeAutoSeededMasterLotsOnce();
      if (!already) await AsyncStorage.setItem(purgedKey, '1');
      if (n > 0) console.log(`🧹 Cleared ${n} example client row(s) — DO will add chamber-wise.`);
    } catch (_) {}
    try {
      await AsyncStorage.removeItem('chamber_client_targets');
    } catch (_) {}

      unsubscribeSync = subscribeToSync(apiUrl, token, handleSyncProgress, user);

      const storedSync = await getLastSyncAt();
      if (storedSync) setLastSyncAt(storedSync);
      setSyncPendingCount(
        countPendingSyncItems(user?.warehouse_name, displayName, user?.email)
      );

      await fetchAndLoadAssignments();
    })();

    return () => {
      if (unsubscribeSync) unsubscribeSync();
    };
  }, [apiUrl, token, user?.email, user?.warehouse_name, displayName]);

  // Poll Super Admin permission decisions for notification bell
  useEffect(() => {
    if (!apiUrl || !token) return undefined;

    let cancelled = false;
    const loadPermissionNotifications = async () => {
      try {
        const res = await fetch(`${apiUrl}/api/permission-requests?_=${Date.now()}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json'
          }
        });
        if (!res.ok) return;
        const data = await res.json().catch(() => []);
        if (!cancelled && Array.isArray(data)) {
          setPermissionNotifications(data);
        }
      } catch (err) {
        // Keep last known list if offline
      }
    };

    loadPermissionNotifications();
    const timer = setInterval(loadPermissionNotifications, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [apiUrl, token]);

  const parsePermissionTaskMeta = (notif) => {
    const fromRequest = String(notif.request_description || '');
    const fromDesc = String(notif.description || '');
    const text = `${fromRequest} | ${fromDesc}`;

    const clientFromPipe = (text.match(/Client:\s*([^|]+)/i) || [])[1]?.trim();
    const chamberFromPipe = (text.match(/Chamber:\s*([^|]+)/i) || [])[1]?.trim();
    const shiftFromPipe = (text.match(/Shift:\s*([^|]+)/i) || [])[1]?.trim();

    let shift = notif.shift || shiftFromPipe || '';
    if (!shift) {
      if (/evening/i.test(text)) shift = 'Evening';
      else if (/morning/i.test(text)) shift = 'Morning';
    }
    if (shift && !/^Morning$|^Evening$/i.test(shift)) {
      shift = /evening/i.test(shift) ? 'Evening' : 'Morning';
    }

    return {
      chamber_id: notif.chamber_id != null ? Number(notif.chamber_id) : null,
      chamber_name: getPermissionChamberLabel(notif) || chamberFromPipe || 'Chamber',
      client_name: notif.client_name || clientFromPipe || 'Client',
      shift: shift === 'Evening' ? 'Evening' : (shift === 'Morning' ? 'Morning' : null),
      entry_date: notif.entry_date || null,
      reference_no: notif.log_reference_no || null,
      record_id: notif.record_id
    };
  };

  const getActivePermissionAlerts = () =>
    permissionNotifications.filter(
      (n) =>
        !n.do_action_completed_at &&
        (n.status === 'Approved' || n.status === 'Denied') &&
        (n.record_type === 'Chamber' ||
          n.record_type === 'MasterSetup' ||
          n.record_type === 'ChamberMaster' ||
          n.record_type === 'ChamberType' ||
          n.record_type === 'ClientMaster')
    );

  /** Remark left by Super Admin / Sub Admin when they decide a request. */
  const extractAdminDecisionRemark = (notif) => {
    const fromCol = String(notif?.remark || '').trim();
    const desc = String(notif?.description || '');
    const fromDesc = (
      desc.match(/Admin remark:\s*(.+?)(?:\s*·\s*Decided by:|$)/i) ||
      desc.match(/SA remark:\s*(.+?)(?:\s*·\s*Decided by:|$)/i) ||
      []
    )[1];
    return String(fromCol || fromDesc || '').trim();
  };

  const buildDeniedAlertBody = (fallbackLine, notif) => {
    const base = String(fallbackLine || 'Your permission request was denied.').trim();
    const remark = extractAdminDecisionRemark(notif);
    if (!remark) return base;
    return `${base}\n\nAdmin remark:\n${remark}`;
  };

  const markPermissionNotificationComplete = async (notifId) => {
    if (!notifId || !apiUrl || !token) return;
    try {
      await fetch(`${apiUrl}/api/permission-requests/${notifId}/complete`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      });
      setPermissionNotifications((prev) =>
        prev.map((n) =>
          n.id === notifId
            ? { ...n, do_action_completed_at: new Date().toISOString() }
            : n
        )
      );
    } catch (err) {
      console.warn('Failed to mark permission notification complete:', err?.message || err);
    }
  };

  /** Plus / More → open Chambers & Clients master (add/delete chambers within limit). */
  const openMasterManager = (options = {}) => {
    const preferredChamber = options.chamber || null;
    const tab = options.tab === 'clients' || options.tab === 'chambers' ? options.tab : 'chambers';
    refreshMasterClientLots();
    setManagerSelectedChamber(preferredChamber);
    setMasterManagerTab(tab);
    setShowManagerChamberDropdown(false);
    setShowClientSuggestions(false);
    setNewChamberNameInput('');
    setNewClientInput('');
    setEditingClientName(null);
    setEditClientDraft('');
    setChamberEditDraft(null);
    setEditingChamberId(null);
    setShowClientManagerModal(true);
    if (options.startEdit && preferredChamber?.id) {
      setEditingChamberId(preferredChamber.id);
      beginChamberEditSession(preferredChamber);
    }
  };

  /** Open Master Setup → Clients tab for a chamber (dashboard empty-client CTA). */
  const openMasterSetupAddClients = (chamber = null) => {
    const target =
      chamber ||
      chambersList.find((c) => getClientsForChamber(c.id).length === 0) ||
      chambersList[0] ||
      null;
    openMasterManager({ chamber: target, tab: 'clients' });
  };

  /** Master Setup opens directly — no Super Admin allow gate */
  const openMasterManagerWithPermission = async () => {
    openMasterManager();
  };

  /** Stable INT for ClientMaster permission (must match backend). */
  const clientMasterPermissionId = (chamberId, action, clientName, extra = '') => {
    const s = `client|${chamberId}|${action}|${String(clientName || '').trim().toLowerCase()}|${String(extra || '').trim().toLowerCase()}`;
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % 2000000000 || 1;
  };

  /** Stable INT for ChamberMaster ADD permission (must match backend). */
  const chamberAddPermissionId = (name) => {
    const s = `add|${String(name || '').trim().toLowerCase()}`;
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % 2000000000 || 1;
  };

  const openAddChamberPopup = () => {
    // Always open name + remark form; limit is checked when sending request
    const used = new Set(
      chambersList.map((c) => {
        const m = String(c.name || '').match(/^Chamber\s+(\d+)$/i);
        return m ? parseInt(m[1], 10) : null;
      }).filter((n) => n != null)
    );
    let nextNum = 1;
    while (used.has(nextNum) && nextNum <= chamberLimit) nextNum += 1;
    setAddChamberNameInput(chambersList.length >= chamberLimit ? '' : `Chamber ${nextNum}`);
    setAddChamberRemarkInput('');
    setShowAddChamberModal(true);
  };

  const executeChamberCreate = async (name, remark = '', notifIdToComplete = null, options = {}) => {
    if (!apiUrl || !token) {
      if (!options.silent) Alert.alert('Offline', 'Connect to server to add a chamber.');
      return false;
    }
    const chamberName = String(name || '').trim();
    if (!chamberName) {
      if (!options.silent) Alert.alert('Validation Error', 'Chamber name is required.');
      return false;
    }
    try {
      const res = await fetch(`${apiUrl}/api/chambers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({ name: chamberName, remark: String(remark || '').trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Permission already used after SA approve — still refresh list from server
        if (res.status === 403) {
          await fetchAndLoadAssignments();
          if (notifIdToComplete) await markPermissionNotificationComplete(notifIdToComplete);
          if (!options.silent) {
            Alert.alert(
              'Chamber Updated',
              `"${chamberName}" should now appear in your chamber list.`
            );
          }
          return true;
        }
        throw new Error(data.message || data.error || 'Failed to add chamber');
      }

      if (data.chamber_limit != null) {
        await persistChamberLimit(data.chamber_limit);
      }

      try {
        const raw = await AsyncStorage.getItem('pending_chamber_adds');
        if (raw) {
          const map = JSON.parse(raw) || {};
          delete map[String(chamberAddPermissionId(chamberName))];
          await AsyncStorage.setItem('pending_chamber_adds', JSON.stringify(map));
        }
      } catch (_) {}

      await fetchAndLoadAssignments();
      if (data.data && !options.silent) {
        setManagerSelectedChamber(data.data);
        setMasterManagerTab('clients');
        setShowClientManagerModal(true);
      }
      if (notifIdToComplete) {
        await markPermissionNotificationComplete(notifIdToComplete);
      }
      if (!options.silent) {
        Alert.alert(
          'Chamber Added',
          `"${data.data?.name || chamberName}" is assigned. Tasks will use this chamber name with its client master.`
        );
      }
      return true;
    } catch (err) {
      if (!options.silent) Alert.alert('Add Chamber', err.message || 'Unable to complete this action. Please try again.');
      return false;
    }
  };

  // When Super Admin approves Chamber Add, auto-sync chambers on mobile (no need to open bell)
  const autoSyncedChamberAddsRef = React.useRef(new Set());
  useEffect(() => {
    if (!apiUrl || !token) return undefined;
    const approvedAdds = (permissionNotifications || []).filter((n) => {
      // Even if do_action_completed_at is already set (e.g. user tapped notification),
      // we still want the chamber list / tasks to reflect the Super Admin approval.
      if (n.record_type !== 'ChamberMaster' || n.status !== 'Approved') {
        return false;
      }
      const text = `${n.request_description || ''} ${n.description || ''}`;
      return /ADD chamber/i.test(text);
    });
    if (!approvedAdds.length) return undefined;

    let cancelled = false;
    (async () => {
      for (const notif of approvedAdds) {
        if (cancelled || autoSyncedChamberAddsRef.current.has(notif.id)) continue;
        autoSyncedChamberAddsRef.current.add(notif.id);
        const text = `${notif.request_description || ''} ${notif.description || ''}`;
        const nameMatch = text.match(/ADD chamber "([^"]+)"/i);
        const remarkMatch = text.match(/Remark:\s*(.+)$/i);
        let pending = null;
        try {
          const raw = await AsyncStorage.getItem('pending_chamber_adds');
          const map = raw ? JSON.parse(raw) : {};
          pending = map[String(notif.record_id)] || null;
        } catch (_) {}
        const chamberName = nameMatch?.[1] || pending?.name;
        if (!chamberName) {
          await fetchAndLoadAssignments();
          await markPermissionNotificationComplete(notif.id);
          continue;
        }
        const ok = await executeChamberCreate(
          chamberName,
          remarkMatch?.[1]?.trim() || pending?.remark || '',
          notif.id,
          { silent: true }
        );
        if (ok && !cancelled) {
          Alert.alert(
            'Chamber Added',
            `"${chamberName}" assigned after Super Admin approval.`
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [permissionNotifications, apiUrl, token]);

  const persistPendingChamberType = async (chamberId, payload) => {
    try {
      const raw = await AsyncStorage.getItem(PENDING_CHAMBER_TYPE_KEY);
      const map = raw ? JSON.parse(raw) : {};
      map[String(chamberId)] = payload;
      await AsyncStorage.setItem(PENDING_CHAMBER_TYPE_KEY, JSON.stringify(map));
    } catch (_) {}
  };

  const clearPendingChamberType = async (chamberId) => {
    try {
      const raw = await AsyncStorage.getItem(PENDING_CHAMBER_TYPE_KEY);
      const map = raw ? JSON.parse(raw) : {};
      delete map[String(chamberId)];
      await AsyncStorage.setItem(PENDING_CHAMBER_TYPE_KEY, JSON.stringify(map));
    } catch (_) {}
  };

  const persistPendingClientMasterOp = async (recordId, payload) => {
    try {
      const raw = await AsyncStorage.getItem(PENDING_CLIENT_MASTER_KEY);
      const map = raw ? JSON.parse(raw) : {};
      map[String(recordId)] = payload;
      await AsyncStorage.setItem(PENDING_CLIENT_MASTER_KEY, JSON.stringify(map));
    } catch (_) {}
  };

  const clearPendingClientMasterOp = async (recordId) => {
    try {
      const raw = await AsyncStorage.getItem(PENDING_CLIENT_MASTER_KEY);
      const map = raw ? JSON.parse(raw) : {};
      delete map[String(recordId)];
      await AsyncStorage.setItem(PENDING_CLIENT_MASTER_KEY, JSON.stringify(map));
    } catch (_) {}
  };

  const applyApprovedClientMasterOnDevice = async (recordId, pendingMeta = null) => {
    // Safety fallback: if backend approval row exists but server-side apply missed,
    // replay the add via assignment API using already-approved permission.
    if (
      pendingMeta?.action === 'add' &&
      apiUrl &&
      token &&
      pendingMeta?.chamberId &&
      pendingMeta?.clientName
    ) {
      try {
        await fetch(`${apiUrl}/api/chambers/assignments`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify({
            chamber_id: pendingMeta.chamberId,
            client_name: pendingMeta.clientName,
            chamber_type: pendingMeta.chamberType || 'Frozen',
            remark: pendingMeta.remark || 'Approved by Super Admin'
          })
        });
      } catch (_) {
        // keep flowing to fetch latest snapshot from server/cache
      }
    }

    // Same-day temp tasks: put approved client into local assignments immediately
    if (pendingMeta?.chamberId && pendingMeta?.clientName) {
      const chamber =
        chambersList.find((c) => Number(c.id) === Number(pendingMeta.chamberId)) || {
          id: pendingMeta.chamberId,
          name: pendingMeta.chamberName || `Chamber ${pendingMeta.chamberId}`
        };
      if (pendingMeta.action === 'delete') {
        removeLocalAssignmentHard(pendingMeta.chamberId, pendingMeta.clientName);
      } else if (pendingMeta.action === 'edit' && pendingMeta.newName) {
        removeLocalAssignmentHard(pendingMeta.chamberId, pendingMeta.clientName);
        upsertLocalActiveAssignment(
          chamber.id,
          chamber.name,
          pendingMeta.newName,
          pendingMeta.remark || 'Approved by Super Admin',
          pendingMeta.chamberType || 'Frozen',
          user?.warehouse_name,
          user?.warehouse_code
        );
      } else if (pendingMeta.action === 'add') {
        upsertLocalActiveAssignment(
          chamber.id,
          chamber.name,
          pendingMeta.clientName,
          pendingMeta.remark || 'Approved by Super Admin',
          pendingMeta.chamberType || 'Frozen',
          user?.warehouse_name,
          user?.warehouse_code
        );
      }
      loadLocalAssignmentsData(chambersList);
    }

    await fetchAndLoadAssignments();
    await clearPendingClientMasterOp(recordId);
    loadLocalAssignmentsData(chambersList);
    if (pendingMeta?.action === 'add' && pendingMeta?.clientName && pendingMeta?.chamberId) {
      const onChamber = Number(selectedChamber?.id) === Number(pendingMeta.chamberId);
      if (onChamber) {
        setSelectedClient(pendingMeta.clientName);
        setTempInput('');
        setBoxCountInput('');
        setCapturedImage(null);
        setCapturedImageTimestamp(null);
      }
    }
  };

  const applyApprovedChamberTypeOnDevice = async (chamberId, nextType, remark = '') => {
    const type = normalizeChamberTypeValue(nextType);
    const found = chambersList.find((c) => Number(c.id) === Number(chamberId));
    updateLocalChamberType(chamberId, type);
    setChambersList((prev) =>
      prev.map((ch) => (Number(ch.id) === Number(chamberId) ? { ...ch, chamber_type: type } : ch))
    );
    if (managerSelectedChamber && Number(managerSelectedChamber.id) === Number(chamberId)) {
      setManagerSelectedChamber((prev) => ({ ...prev, chamber_type: type }));
      setNewClientType(type);
    }
    await fetchAndLoadAssignments();
    if (found) {
      reportDOActivity(
        'UPDATE_CHAMBER_ZONE',
        `${displayName} chamber type of ${found.name} updated to "${type}" after Super Admin allow.`,
        remark,
        chamberId
      );
    }
    await clearPendingChamberType(chamberId);
    return true;
  };

  const autoSyncedChamberTypesRef = React.useRef(new Set());
  useEffect(() => {
    if (!apiUrl || !token) return undefined;
    const approvedTypes = (permissionNotifications || []).filter((n) => {
      if (n.status !== 'Approved' || n.do_action_completed_at) return false;
      if (n.record_type === 'ChamberType') return true;
      const text = `${n.request_description || ''} ${n.description || ''}`;
      return n.record_type === 'ChamberMaster' && /EDIT chamber type/i.test(text);
    });
    if (!approvedTypes.length) return undefined;

    let cancelled = false;
    (async () => {
      for (const notif of approvedTypes) {
        if (cancelled || autoSyncedChamberTypesRef.current.has(notif.id)) continue;
        autoSyncedChamberTypesRef.current.add(notif.id);
        const text = `${notif.request_description || ''} ${notif.description || ''}`;
        const fromTo = text.match(/from\s+([A-Za-z]+)\s+to\s+([A-Za-z]+)/i);
        let pending = null;
        try {
          const raw = await AsyncStorage.getItem(PENDING_CHAMBER_TYPE_KEY);
          const map = raw ? JSON.parse(raw) : {};
          pending = map[String(notif.record_id)] || null;
        } catch (_) {}
        const nextType = pending?.nextType || fromTo?.[2];
        const chamberName =
          pending?.chamberName ||
          getPermissionChamberLabel(notif) ||
          chambersList.find((c) => Number(c.id) === Number(notif.record_id))?.name ||
          'Chamber';
        if (nextType) {
          await applyApprovedChamberTypeOnDevice(
            notif.record_id,
            nextType,
            pending?.remark || ''
          );
        } else {
          await fetchAndLoadAssignments();
        }
        await markPermissionNotificationComplete(notif.id);
        if (!cancelled) {
          Alert.alert(
            'Chamber Type Updated',
            `"${chamberName}" is now ${normalizeChamberTypeValue(nextType)} after Super Admin approval.`
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [permissionNotifications, apiUrl, token]);

  const autoSyncedClientMasterRef = React.useRef(new Set());
  useEffect(() => {
    if (!apiUrl || !token) return undefined;
    const approvedClients = (permissionNotifications || []).filter((n) => {
      // Even if do_action_completed_at is already set, ensure assignments are synced.
      if (n.status !== 'Approved') return false;
      return n.record_type === 'ClientMaster';
    });
    if (!approvedClients.length) return undefined;

    let cancelled = false;
    (async () => {
      for (const notif of approvedClients) {
        if (cancelled || autoSyncedClientMasterRef.current.has(notif.id)) continue;
        autoSyncedClientMasterRef.current.add(notif.id);
        let pendingMeta = null;
        try {
          const raw = await AsyncStorage.getItem(PENDING_CLIENT_MASTER_KEY);
          const map = raw ? JSON.parse(raw) : {};
          pendingMeta = map[String(notif.record_id)] || null;
        } catch (_) {}
        await applyApprovedClientMasterOnDevice(notif.record_id, pendingMeta);
        await markPermissionNotificationComplete(notif.id);
        if (!cancelled) {
          const label =
            pendingMeta?.action === 'edit'
              ? `"${pendingMeta.clientName}" → "${pendingMeta.newName}" on ${pendingMeta.chamberName || 'chamber'}`
              : `"${pendingMeta?.clientName || 'Client'}" on ${pendingMeta?.chamberName || 'chamber'}`;
          Alert.alert(
            pendingMeta?.action === 'add' ? 'Client Added' : 'Client Master Updated',
            `${label} ${pendingMeta?.action === 'add' ? 'added' : 'updated'} after Super Admin approval.`
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [permissionNotifications, apiUrl, token]);

  const submitAddChamberRequest = async () => {
    if (!apiUrl || !token) {
      Alert.alert('Offline', 'Connect to server to request chamber add.');
      return;
    }
    // Limit is ignored for the request — Super Admin decides on allow
    const name = String(addChamberNameInput || '').trim();
    const remark = String(addChamberRemarkInput || '').trim();
    if (!name) {
      Alert.alert('Validation Error', 'Please enter a chamber name.');
      return;
    }
    if (!remark) {
      Alert.alert('Validation Error', 'Please enter a remark / reason.');
      return;
    }
    if (chambersList.some((c) => String(c.name).toLowerCase() === name.toLowerCase())) {
      Alert.alert('Already exists', `"${name}" is already in your chamber list.`);
      return;
    }

    setAddChamberBusy(true);
    try {
      const recordId = chamberAddPermissionId(name);

      // If already approved, create immediately
      const checkRes = await fetch(
        `${apiUrl}/api/permission-requests/check?record_type=${encodeURIComponent('ChamberMaster')}&record_id=${encodeURIComponent(recordId)}&action=Edit`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
      );
      const checkData = await checkRes.json().catch(() => ({}));
      if (checkRes.ok && checkData.approved) {
        setShowAddChamberModal(false);
        const list = await refreshPermissionNotifications();
        const granted = (list || []).find(
          (n) =>
            n.record_type === 'ChamberMaster' &&
            Number(n.record_id) === Number(recordId) &&
            n.status === 'Approved' &&
            !n.do_action_completed_at
        );
        await executeChamberCreate(name, remark, granted?.id || null);
        return;
      }
      if (checkRes.ok && checkData.status === 'Pending') {
        Alert.alert(
          'Waiting for Super Admin',
          `Add request for "${name}" is already pending.`
        );
        return;
      }

      try {
        const raw = await AsyncStorage.getItem('pending_chamber_adds');
        const map = raw ? JSON.parse(raw) : {};
        map[String(recordId)] = { name, remark };
        await AsyncStorage.setItem('pending_chamber_adds', JSON.stringify(map));
      } catch (_) {}

      const res = await fetch(`${apiUrl}/api/permission-requests`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          record_type: 'ChamberMaster',
          record_id: recordId,
          action: 'Edit',
          remark,
          description:
            `${displayName} requested Super Admin allow to ADD chamber "${name}". Remark: ${remark}`
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.request?.status === 'Approved') {
          setShowAddChamberModal(false);
          await executeChamberCreate(name, remark, null);
          return;
        }
        throw new Error(data.error || data.message || 'Failed to request approval.');
      }

      setShowAddChamberModal(false);
      setAddChamberNameInput('');
      setAddChamberRemarkInput('');
      await refreshPermissionNotifications();
      Alert.alert(
        'Request sent to Super Admin',
        `Super Admin approval is required to add "${name}". After approval, open Notifications — the chamber will be assigned automatically.`
      );
    } catch (err) {
      Alert.alert('Add Chamber', err.message || 'Could not send request.');
    } finally {
      setAddChamberBusy(false);
    }
  };

  /** @deprecated — use openAddChamberPopup */
  const handleCreateChamber = () => {
    openAddChamberPopup();
  };

  const executeChamberDelete = async (chamber, notifIdToComplete = null) => {
    if (!chamber?.id) return false;
    try {
      const res = await fetch(`${apiUrl}/api/chambers/${chamber.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to delete');
      if (managerSelectedChamber?.id === chamber.id) setManagerSelectedChamber(null);
      await fetchAndLoadAssignments();
      if (notifIdToComplete) {
        await markPermissionNotificationComplete(notifIdToComplete);
      }
      reportDOActivity(
        'DELETE_CHAMBER',
        `${displayName} deleted chamber "${chamber.name}" (id: ${chamber.id}) after Super Admin allow.`,
        '',
        chamber.id
      );
      Alert.alert('Deleted', `"${chamber.name}" removed.`);
      return true;
    } catch (err) {
      Alert.alert('Delete Chamber', err.message || 'Unable to complete this action. Please try again.');
      return false;
    }
  };

  const requestChamberDeletePermission = async (chamber, remark = '') => {
    if (!apiUrl || !token || !chamber?.id) {
      Alert.alert('Offline', 'Connect to server to request delete permission.');
      return;
    }
    const resolvedRemark = String(remark || '').trim();
    try {
      const res = await fetch(`${apiUrl}/api/permission-requests`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          record_type: 'ChamberMaster',
          record_id: chamber.id,
          action: 'Delete',
          remark: resolvedRemark || undefined,
          description:
            `${displayName} requested Super Admin allow to delete chamber "${chamber.name}" (id: ${chamber.id}).` +
            (resolvedRemark ? ` Remark: ${resolvedRemark}` : '')
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.request?.status === 'Approved') {
          Alert.alert(
            'Already Approved',
            `Delete of "${chamber.name}" is already allowed. Tap Delete again to remove it.`
          );
          return;
        }
        throw new Error(data.error || data.message || 'Failed to request delete permission.');
      }
      Alert.alert(
        'Request sent to Super Admin',
        `Super Admin approval is required to delete "${chamber.name}". After approval, open Notifications or tap Delete again.`
      );
      // Refresh permission notifications
      try {
        const listRes = await fetch(`${apiUrl}/api/permission-requests?_=${Date.now()}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
        });
        if (listRes.ok) {
          const listData = await listRes.json().catch(() => []);
          if (Array.isArray(listData)) setPermissionNotifications(listData);
        }
      } catch (_) {}
    } catch (err) {
      Alert.alert('Delete Permission', err.message || 'Could not send request.');
    }
  };

  const requestChamberEditPermission = async (chamber, remark = '') => {
    if (!apiUrl || !token || !chamber?.id) {
      Alert.alert('Offline', 'Connect to server to request edit permission.');
      return;
    }
    const resolvedRemark = String(remark || '').trim();
    try {
      const res = await fetch(`${apiUrl}/api/permission-requests`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          record_type: 'ChamberMaster',
          record_id: chamber.id,
          action: 'Edit',
          remark: resolvedRemark || undefined,
          description:
            `${displayName} requested Super Admin allow to EDIT chamber "${chamber.name}" (id: ${chamber.id}).` +
            (resolvedRemark ? ` Remark: ${resolvedRemark}` : '')
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.request?.status === 'Approved') {
          Alert.alert(
            'Already Approved',
            `Edit of "${chamber.name}" is already allowed. Tap Edit again to make changes.`
          );
          return;
        }
        throw new Error(data.error || data.message || 'Failed to request edit permission.');
      }
      Alert.alert(
        'Request sent to Super Admin',
        `Super Admin approval is required to edit "${chamber.name}". After approval, open Notifications or tap Edit again.`
      );
      refreshPermissionNotifications();
    } catch (err) {
      Alert.alert('Request Edit', err.message || 'Unable to request edit permission. Please try again.');
    }
  };

  const requestChamberTypePermission = async (chamber, nextType, oldType, remark = '') => {
    if (!apiUrl || !token || !chamber?.id) {
      Alert.alert('Offline', 'Connect to server to request chamber type change.');
      return false;
    }
    const resolvedNext = normalizeChamberTypeValue(nextType);
    const resolvedOld = normalizeChamberTypeValue(
      oldType ||
      chamber.chamber_type ||
      chambersList.find((c) => Number(c.id) === Number(chamber.id))?.chamber_type
    );
    const resolvedRemark = String(remark || '').trim();
    if (resolvedNext === resolvedOld) return true;
    if (!resolvedRemark) {
      Alert.alert('Remark required', 'Please enter a remark to request this chamber type change.');
      return false;
    }

    const pendingPayload = {
      chamberId: chamber.id,
      chamberName: chamber.name,
      nextType: resolvedNext,
      oldType: resolvedOld,
      remark: resolvedRemark
    };

    try {
      const checkRes = await fetch(
        `${apiUrl}/api/permission-requests/check?record_type=${encodeURIComponent('ChamberType')}&record_id=${encodeURIComponent(chamber.id)}&action=Edit`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
      );
      const checkData = await checkRes.json().catch(() => ({}));
      if (checkRes.ok && checkData.approved) {
        const ok = await applyChamberZoneChange(chamber, resolvedNext, resolvedRemark);
        await clearPendingChamberType(chamber.id);
        if (ok) {
          Alert.alert('Chamber Type Updated', `"${chamber.name}" is now ${resolvedNext}.`);
        }
        return ok;
      }
      if (checkRes.ok && checkData.status === 'Pending') {
        await persistPendingChamberType(chamber.id, pendingPayload);
        Alert.alert(
          'Waiting for Super Admin',
          `Type change for "${chamber.name}" (${resolvedOld} → ${resolvedNext}) is already pending. It will update automatically after Super Admin allows.`
        );
        return false;
      }

      const res = await fetch(`${apiUrl}/api/permission-requests`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          record_type: 'ChamberType',
          record_id: chamber.id,
          action: 'Edit',
          remark: resolvedRemark,
          description:
            `${displayName} requested Super Admin allow to EDIT chamber type "${chamber.name}" (id: ${chamber.id}) from ${resolvedOld} to ${resolvedNext}.` +
            ` Remark: ${resolvedRemark}`
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.request?.status === 'Approved') {
          const ok = await applyChamberZoneChange(chamber, resolvedNext, resolvedRemark);
          await clearPendingChamberType(chamber.id);
          return ok;
        }
        if (data.request?.status === 'Pending') {
          await persistPendingChamberType(chamber.id, pendingPayload);
          Alert.alert(
            'Waiting for Super Admin',
            `Type change for "${chamber.name}" is already pending approval.`
          );
          return false;
        }
        throw new Error(data.error || data.message || 'Failed to request chamber type permission.');
      }

      await persistPendingChamberType(chamber.id, pendingPayload);
      Alert.alert(
        'Request sent to Super Admin',
        `"${chamber.name}" will change from ${resolvedOld} to ${resolvedNext} after Super Admin allows. It will update automatically.`
      );
      refreshPermissionNotifications();
      return true;
    } catch (err) {
      Alert.alert('Chamber Type', err.message || 'Could not send type change request.');
      return false;
    }
  };

  const requestClientMasterPermission = async ({
    chamber,
    action,
    clientName,
    newName = '',
    chamberType = 'Frozen',
    remark = '',
    silent = false
  }) => {
    if (!apiUrl || !token || !chamber?.id || !clientName) {
      Alert.alert('Offline', 'Connect to server to request client master change.');
      return false;
    }
    const resolvedRemark = String(remark || '').trim();
    if (!resolvedRemark) {
      Alert.alert('Remark required', 'Please enter a remark for this client change.');
      return false;
    }
    const permAction = action === 'delete' ? 'delete' : action === 'edit' ? 'edit' : 'add';
    const apiAction = permAction === 'delete' ? 'Delete' : 'Edit';
    const recordId =
      permAction === 'edit'
        ? clientMasterPermissionId(chamber.id, 'edit', clientName, newName)
        : clientMasterPermissionId(chamber.id, permAction, clientName);

    const pendingPayload = {
      chamberId: chamber.id,
      chamberName: chamber.name,
      action: permAction,
      clientName,
      newName: newName || null,
      chamberType: normalizeChamberTypeValue(chamberType),
      remark: resolvedRemark
    };

    let description = '';
    if (permAction === 'add') {
      description =
        `${displayName} requested Super Admin allow to ADD client "${clientName}" (${pendingPayload.chamberType}) on chamber "${chamber.name}" (id: ${chamber.id}). Remark: ${resolvedRemark}`;
    } else if (permAction === 'delete') {
      description =
        `${displayName} requested Super Admin allow to DELETE client "${clientName}" from chamber "${chamber.name}" (id: ${chamber.id}). Remark: ${resolvedRemark}`;
    } else {
      description =
        `${displayName} requested Super Admin allow to EDIT client "${clientName}" → "${newName}" on chamber "${chamber.name}" (id: ${chamber.id}). Remark: ${resolvedRemark}`;
    }

    try {
      const checkRes = await fetch(
        `${apiUrl}/api/permission-requests/check?record_type=${encodeURIComponent('ClientMaster')}&record_id=${encodeURIComponent(recordId)}&action=${encodeURIComponent(apiAction)}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
      );
      const checkData = await checkRes.json().catch(() => ({}));
      if (checkRes.ok && checkData.approved) {
        // Only auto-apply if THIS change was already requested (pending stored).
        // Live DBs often have leftover GRANTs — applying without pending would
        // update Master Setup without a new Super Admin allow.
        let pendingMeta = null;
        let hadPending = false;
        try {
          const raw = await AsyncStorage.getItem(PENDING_CLIENT_MASTER_KEY);
          const map = raw ? JSON.parse(raw) : {};
          pendingMeta = map[String(recordId)] || null;
          hadPending = !!pendingMeta;
        } catch (_) {
          pendingMeta = null;
        }
        if (hadPending) {
          await applyApprovedClientMasterOnDevice(recordId, pendingMeta || pendingPayload);
          if (checkData.request?.id) {
            await markPermissionNotificationComplete(checkData.request.id);
          }
          if (!silent) {
            Alert.alert(
              'Client Updated',
              `"${clientName}"${permAction === 'edit' ? ` renamed to "${newName}"` : ''} on ${chamber.name} after Super Admin approval.`
            );
          }
          return true;
        }
        // Stale allow — fall through and send a fresh request
      }
      if (checkRes.ok && checkData.status === 'Pending') {
        await persistPendingClientMasterOp(recordId, pendingPayload);
        if (permAction === 'add') {
          upsertLocalActiveAssignment(
            chamber.id,
            chamber.name,
            clientName,
            resolvedRemark,
            pendingPayload.chamberType,
            user?.warehouse_name,
            user?.warehouse_code,
            null,
            { awaitingApproval: true }
          );
          loadLocalAssignmentsData(chambersList);
        }
        if (!silent) {
          Alert.alert(
            'Waiting for Super Admin',
            `Client change for "${clientName}" on ${chamber.name} is already pending approval.`
          );
        }
        return false;
      }

      const res = await fetch(`${apiUrl}/api/permission-requests`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          record_type: 'ClientMaster',
          record_id: recordId,
          action: apiAction,
          remark: resolvedRemark,
          description
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.request?.status === 'Approved') {
          // Stale GRANT without a stored pending request — do not apply silently.
          // Backend now consumes leftover ClientMaster grants; send a fresh request below
          // only if this is not ClientMaster. For safety, still refuse silent apply.
          let hadPending = false;
          try {
            const raw = await AsyncStorage.getItem(PENDING_CLIENT_MASTER_KEY);
            const map = raw ? JSON.parse(raw) : {};
            hadPending = !!map[String(recordId)];
          } catch (_) {}
          if (hadPending) {
            await applyApprovedClientMasterOnDevice(recordId, pendingPayload);
            return true;
          }
        }
        if (data.request?.status === 'Pending') {
          await persistPendingClientMasterOp(recordId, pendingPayload);
          if (!silent) {
            Alert.alert('Waiting for Super Admin', 'This client change is already pending approval.');
          }
          return false;
        }
        throw new Error(data.error || data.message || 'Failed to request client master permission.');
      }

      await persistPendingClientMasterOp(recordId, pendingPayload);
      // Same day: show new client on temperature tasks as soon as DO requests add
      if (permAction === 'add') {
        upsertLocalActiveAssignment(
          chamber.id,
          chamber.name,
          clientName,
          resolvedRemark,
          pendingPayload.chamberType,
          user?.warehouse_name,
          user?.warehouse_code,
          null,
          { awaitingApproval: true }
        );
        loadLocalAssignmentsData(chambersList);
      }
      refreshPermissionNotifications();
      if (!silent) {
        Alert.alert(
          'Request sent to Super Admin',
          `"${clientName}" on ${chamber.name} will update automatically after Super Admin allows.`
        );
      }
      return true;
    } catch (err) {
      Alert.alert('Client Master', err.message || 'Could not send client change request.');
      return false;
    }
  };

  const handleEditChamberPress = (ch) => {
    if (!ch?.id) return;
    setManagerSelectedChamber(ch);
    setEditingChamberId(ch.id);
    setNewClientInput('');
    setEditingClientName(null);
    setShowClientSuggestions(false);
    beginChamberEditSession(ch);
  };

  const handleUpdateChamberType = async (chamberId, type, remark = '') => {
    if (!apiUrl || !token) {
      Alert.alert('Offline', 'Connect to server to change chamber type.');
      return false;
    }
    const nextType = normalizeChamberTypeValue(type);
    const current = chambersList.find((c) => Number(c.id) === Number(chamberId));
    if (current && normalizeChamberTypeValue(current.chamber_type) === nextType) {
      return true;
    }
    try {
      const res = await fetch(`${apiUrl}/api/chambers/${chamberId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          chamber_type: nextType,
          remark: String(remark || '').trim() || undefined
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || 'Failed to update chamber type');
      }
      
      setChambersList(prev => prev.map(ch => 
        Number(ch.id) === Number(chamberId) ? { ...ch, chamber_type: nextType } : ch
      ));
      
      if (managerSelectedChamber && Number(managerSelectedChamber.id) === Number(chamberId)) {
        setManagerSelectedChamber(prev => ({ ...prev, chamber_type: nextType }));
      }
      return true;
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not update chamber type.');
      return false;
    }
  };

  const handleDeleteChamberMaster = (chamber) => {
    if (!chamber?.id) return;

    const chamberClients = getClientsForChamber(chamber.id);
    if (chamberClients.length === 0) {
      Alert.alert(
        'Delete Chamber',
        `"${chamber.name}" has no clients. Delete it now? Super Admin permission is not required.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => executeChamberDelete(chamber, null)
          }
        ]
      );
      return;
    }

    if (!apiUrl || !token) {
      Alert.alert('Offline', 'Connect to server to delete a chamber.');
      return;
    }

    (async () => {
      try {
        const checkRes = await fetch(
          `${apiUrl}/api/permission-requests/check?record_type=${encodeURIComponent('ChamberMaster')}&record_id=${encodeURIComponent(chamber.id)}&action=Delete`,
          { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
        );
        const checkData = await checkRes.json().catch(() => ({}));
        if (!checkRes.ok) {
          throw new Error(checkData.error || checkData.message || 'Permission check failed');
        }

        if (checkData.approved) {
          Alert.alert(
            'Delete Chamber',
            `Super Admin allowed delete. Remove "${chamber.name}" and deactivate its clients?`,
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                  const granted = permissionNotifications.find(
                    (n) =>
                      n.record_type === 'ChamberMaster' &&
                      Number(n.record_id) === Number(chamber.id) &&
                      n.status === 'Approved' &&
                      !n.do_action_completed_at
                  );
                  await executeChamberDelete(chamber, granted?.id || null);
                }
              }
            ]
          );
          return;
        }

        if (checkData.status === 'Pending') {
          Alert.alert(
            'Waiting for Super Admin',
            `Delete request for "${chamber.name}" is pending. Super Admin will approve in Role & Permission.`
          );
          return;
        }

        Alert.alert(
          'Super Admin Permission Required',
          `Deleting "${chamber.name}" needs Super Admin allow. Enter remark and send request.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Continue',
              onPress: () => {
                setClientToDelete({
                  type: 'chamber_delete_request',
                  chamberId: chamber.id,
                  chamberName: chamber.name,
                  clientName: chamber.name
                });
                setDeleteRemarkInput('');
                setShowDeleteConfirmModal(true);
              }
            }
          ]
        );
      } catch (err) {
        Alert.alert('Delete Chamber', err.message || 'Could not check permission.');
      }
    })();
  };

  const openPermissionNotificationTask = async (notif) => {
    setShowNotificationsModal(false);

    // Master Setup — no allow gate; open manager and dismiss stale allow notifs
    if (notif.record_type === 'MasterSetup') {
      openMasterManager();
      await markPermissionNotificationComplete(notif.id);
      return;
    }

    // Chamber type allow — apply automatically after Super Admin allows
    if (notif.record_type === 'ChamberType') {
      const desc = `${notif.request_description || ''} ${notif.description || ''}`;
      const fromTo = desc.match(/from\s+([A-Za-z]+)\s+to\s+([A-Za-z]+)/i);
      let pending = null;
      try {
        const raw = await AsyncStorage.getItem(PENDING_CHAMBER_TYPE_KEY);
        const map = raw ? JSON.parse(raw) : {};
        pending = map[String(notif.record_id)] || null;
      } catch (_) {}
      const nextType = pending?.nextType || fromTo?.[2];
      const chamberName = pending?.chamberName || getPermissionChamberLabel(notif) || 'Chamber';

      if (notif.status === 'Approved') {
        if (nextType) {
          await applyApprovedChamberTypeOnDevice(notif.record_id, nextType, pending?.remark || '');
        } else {
          await fetchAndLoadAssignments();
        }
        await markPermissionNotificationComplete(notif.id);
        Alert.alert(
          'Chamber Type Updated',
          `"${chamberName}" is now ${normalizeChamberTypeValue(nextType)} after Super Admin approval.`
        );
      } else {
        await clearPendingChamberType(notif.record_id);
        await markPermissionNotificationComplete(notif.id);
        Alert.alert(
          'Type Change Denied',
          buildDeniedAlertBody(
            `Your chamber type change for "${chamberName}" was denied.`,
            notif
          )
        );
      }
      return;
    }

    // Chamber master add/delete allow
    if (notif.record_type === 'ChamberMaster') {
      const desc = `${notif.request_description || ''} ${notif.description || ''}`;
      const isAdd = /ADD chamber/i.test(desc);
      const isTypeCh = /EDIT chamber type/i.test(desc);
      const isEditCh = /EDIT chamber/i.test(desc) && !isTypeCh;

      if (isTypeCh) {
        const fromTo = desc.match(/from\s+([A-Za-z]+)\s+to\s+([A-Za-z]+)/i);
        let pending = null;
        try {
          const raw = await AsyncStorage.getItem(PENDING_CHAMBER_TYPE_KEY);
          const map = raw ? JSON.parse(raw) : {};
          pending = map[String(notif.record_id)] || null;
        } catch (_) {}
        const nextType = pending?.nextType || fromTo?.[2];
        const chamberName = pending?.chamberName || getPermissionChamberLabel(notif) || 'Chamber';
        if (notif.status === 'Approved') {
          if (nextType) {
            await applyApprovedChamberTypeOnDevice(notif.record_id, nextType, pending?.remark || '');
          } else {
            await fetchAndLoadAssignments();
          }
          await markPermissionNotificationComplete(notif.id);
          Alert.alert(
            'Chamber Type Updated',
            `"${chamberName}" is now ${normalizeChamberTypeValue(nextType)} after Super Admin approval.`
          );
        } else {
          await clearPendingChamberType(notif.record_id);
          await markPermissionNotificationComplete(notif.id);
          Alert.alert(
            'Type Change Denied',
            buildDeniedAlertBody('Your chamber type change was denied.', notif)
          );
        }
        return;
      }

      if (isEditCh) {
        if (notif.status === 'Approved') {
          const found = chambersList.find((c) => Number(c.id) === Number(notif.record_id));
          openMasterManager({ chamber: found || null, tab: 'chambers', startEdit: !!found });
        } else {
          Alert.alert(
            'Edit Denied',
            buildDeniedAlertBody('Your chamber edit request was denied.', notif)
          );
          await markPermissionNotificationComplete(notif.id);
        }
        return;
      }

      if (isAdd) {
        const nameMatch = desc.match(/ADD chamber "([^"]+)"/i);
        const remarkMatch = desc.match(/Remark:\s*(.+)$/i);
        let pending = null;
        try {
          const raw = await AsyncStorage.getItem('pending_chamber_adds');
          const map = raw ? JSON.parse(raw) : {};
          pending = map[String(notif.record_id)] || null;
        } catch (_) {}
        const chamberName = nameMatch?.[1] || pending?.name;
        const remark = remarkMatch?.[1]?.trim() || pending?.remark || '';

        if (notif.status === 'Approved') {
          if (!chamberName) {
            await fetchAndLoadAssignments();
            Alert.alert('Chamber Updated', 'Your chamber list was refreshed after Super Admin approval.');
            await markPermissionNotificationComplete(notif.id);
            return;
          }
          // SA already created chamber + bumped limit; POST is idempotent and refreshes mobile
          await executeChamberCreate(chamberName, remark, notif.id);
        } else {
          Alert.alert(
            'Add Denied',
            buildDeniedAlertBody(
              `Your request to add "${chamberName || 'chamber'}" was denied.`,
              notif
            )
          );
          await markPermissionNotificationComplete(notif.id);
        }
        return;
      }

      const chamberId = Number(notif.record_id);
      const found = chambersList.find((c) => Number(c.id) === chamberId);
      const chamber = {
        id: chamberId,
        name: getPermissionChamberLabel(notif) || found?.name || 'Chamber'
      };

      if (notif.status === 'Approved') {
        Alert.alert(
          'Delete Approved',
          `Super Admin allowed delete of "${chamber.name}". Remove it now?`,
          [
            { text: 'Later', style: 'cancel' },
            {
              text: 'Delete Now',
              style: 'destructive',
              onPress: () => executeChamberDelete(chamber, notif.id)
            }
          ]
        );
      } else {
        Alert.alert(
          'Delete Denied',
          buildDeniedAlertBody(
            `Your request to delete "${chamber.name}" was denied.`,
            notif
          )
        );
        await markPermissionNotificationComplete(notif.id);
      }
      return;
    }

    // Client master — apply after Super Admin approval (same as chamber type)
    if (notif.record_type === 'ClientMaster') {
      const desc = `${notif.request_description || ''} ${notif.description || ''}`;
      const clientMatch =
        desc.match(/ADD client "([^"]+)"/i) ||
        desc.match(/DELETE client "([^"]+)"/i) ||
        desc.match(/EDIT client "([^"]+)"/i);
      const chamberMatch = desc.match(/on chamber "([^"]+)"/i);
      const clientLabel = clientMatch?.[1] || 'Client';
      const chamberLabel = chamberMatch?.[1] || getPermissionChamberLabel(notif) || 'Chamber';

      if (notif.status === 'Approved') {
        let pendingMeta = null;
        try {
          const raw = await AsyncStorage.getItem(PENDING_CLIENT_MASTER_KEY);
          const map = raw ? JSON.parse(raw) : {};
          pendingMeta = map[String(notif.record_id)] || null;
        } catch (_) {}
        await applyApprovedClientMasterOnDevice(notif.record_id, pendingMeta);
        await markPermissionNotificationComplete(notif.id);
        Alert.alert(
          pendingMeta?.action === 'add' ? 'Client Added' : 'Client Master Updated',
          `"${clientLabel}" on ${chamberLabel} ${pendingMeta?.action === 'add' ? 'added' : 'updated'} after Super Admin approval.`
        );
      } else {
        let pendingMeta = null;
        try {
          const raw = await AsyncStorage.getItem(PENDING_CLIENT_MASTER_KEY);
          const map = raw ? JSON.parse(raw) : {};
          pendingMeta = map[String(notif.record_id)] || null;
        } catch (_) {}
        if (pendingMeta?.action === 'add' && pendingMeta?.chamberId && pendingMeta?.clientName) {
          removeLocalAssignmentHard(pendingMeta.chamberId, pendingMeta.clientName);
          loadLocalAssignmentsData(chambersList);
        }
        await clearPendingClientMasterOp(notif.record_id);
        await markPermissionNotificationComplete(notif.id);
        Alert.alert(
          'Client Change Denied',
          buildDeniedAlertBody(
            `Your client change for "${clientLabel}" on ${chamberLabel} was denied.`,
            notif
          )
        );
      }
      return;
    }

    const meta = parsePermissionTaskMeta(notif);
    const shiftName = meta.shift || 'Morning';
    const shiftTime = shiftName === 'Evening' ? '16:00' : '10:00';

    await handleSelectShift(shiftName);
    setCurrentNavTab('Tasks');
    setActiveTab('Completed');
    try {
      await AsyncStorage.setItem('active_mobile_nav_tab', 'Tasks');
    } catch (e) {
      /* ignore */
    }

    const localByServerId = completedLogs.find(
      (l) => Number(l.server_log_id) === Number(notif.record_id)
    ) || completedLogs.find(
      (l) =>
        String(l.client_name) === String(meta.client_name) &&
        l.shift === shiftName &&
        (!meta.chamber_id || Number(l.chamber_id) === Number(meta.chamber_id))
    );

    const taskItem = {
      chamber_id: meta.chamber_id || localByServerId?.chamber_id,
      chamber_name: meta.chamber_name || localByServerId?.chamber_name || 'Chamber',
      client_name: meta.client_name || localByServerId?.client_name || 'Client',
      shift_time: shiftTime,
      shift_label: shiftName === 'Morning' ? 'Morning (10:00)' : 'Evening (16:00)',
      due_date: meta.entry_date || localByServerId?.entry_date || undefined
    };

    await markPermissionNotificationComplete(notif.id);

    if (notif.status === 'Approved') {
      if (localByServerId) {
        // Open edit form immediately — permission already approved
        openEditableLogForm(taskItem, localByServerId);
      } else {
        handleEditCompletedLog(taskItem);
      }
    } else {
      Alert.alert(
        'Edit Denied',
        buildDeniedAlertBody(
          `Your edit request for ${taskItem.chamber_name} · ${taskItem.client_name} · ${shiftName} was denied.`,
          notif
        )
      );
    }
  };
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await triggerSync(apiUrl, token, handleSyncProgress, user);
      await fetchAndLoadAssignments();
    } catch (err) {
      console.warn('Failed to refresh data', err);
    } finally {
      setRefreshing(false);
    }
  };

  const fetchAndLoadAssignments = async () => {
    let loadedChambers = null;
    let sessionRevoked = false;
    try {
      const response = await fetch(`${apiUrl}/api/chambers/assignments`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.status === 401 || response.status === 403) {
        sessionRevoked = true;
        Alert.alert(
          'Session Revoked',
          'Your account has been deleted or disabled. Logging you out.',
          [{ text: 'OK', onPress: performLogout }]
        );
        return;
      }

      const data = await response.json();
      
      if (data.success && Array.isArray(data.data)) {
        // Keep all server clients (including names that match suggestion defaults)
        cacheAssignments(data.data, user?.warehouse_name);
        purgeAutoSeededMasterLotsOnce();
      }

      // Load Chamber 1..N; create any missing so dashboard always has tasks
      loadedChambers = await ensureAssignedChambersFromServer();
    } catch (err) {
      console.log('📶 Device is offline or server unreachable. Using cached assignments.');
    } finally {
      if (!sessionRevoked) {
        loadLocalAssignmentsData(loadedChambers);
      } else {
        setIsLoadingData(false);
      }
    }
  };

  /** Fetch chambers for this DO; create Chamber 1..limit if missing; never return empty if limit > 0. */
  const ensureAssignedChambersFromServer = async () => {
    const limit = chamberLimit;
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    };

    const parseChamberRows = (chData) => {
      const rows = Array.isArray(chData?.data) ? chData.data : (Array.isArray(chData) ? chData : []);
      return rows.map((c) => ({
        id: Number(c.id),
        name: c.name || c.chamber_name || `Chamber ${c.id}`,
        chamber_type: c.chamber_type || c.chamberType || null
      }));
    };

    const fetchChambers = async () => {
      const chRes = await fetch(`${apiUrl}/api/chambers`, { headers: authHeaders });
      if (!chRes.ok) return [];
      const chData = await chRes.json().catch(() => ({}));
      const serverLimit = parseInt(chData?.chamber_limit, 10);
      const effectiveLimit =
        Number.isFinite(serverLimit) && serverLimit > 0 ? serverLimit : limit;
      if (Number.isFinite(serverLimit) && serverLimit > 0 && serverLimit !== chamberLimit) {
        persistChamberLimit(serverLimit);
      }
      const sorted = parseChamberRows(chData).sort((a, b) => {
        const na = parseInt((String(a.name || '').match(/\d+/) || [a.id])[0], 10);
        const nb = parseInt((String(b.name || '').match(/\d+/) || [b.id])[0], 10);
        return na - nb;
      });
      return { chambers: sorted.slice(0, effectiveLimit), effectiveLimit };
    };

    let chambers = [];
    let effectiveLimit = limit;
    try {
      const first = await fetchChambers();
      chambers = first.chambers || [];
      effectiveLimit = first.effectiveLimit || limit;
    } catch (_) {
      chambers = [];
    }

    // Bootstrap only when empty — do not recreate chambers the user deleted
    if (!chambers.length && effectiveLimit > 0) {
      for (let i = 1; i <= effectiveLimit; i++) {
        try {
          const res = await fetch(`${apiUrl}/api/chambers`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ name: `Chamber ${i}` })
          });
          const body = await res.json().catch(() => ({}));
          if (res.ok && body?.data?.id) {
            chambers.push({
              id: Number(body.data.id),
              name: body.data.name || `Chamber ${i}`
            });
          }
        } catch (_) {}
      }
      try {
        const again = await fetchChambers();
        if (again.chambers?.length) {
          chambers = again.chambers;
          effectiveLimit = again.effectiveLimit || effectiveLimit;
        }
      } catch (_) {}
    }

    // Last resort: local placeholders so dashboard is never empty for assigned limit
    if (!chambers.length && effectiveLimit > 0) {
      chambers = Array.from({ length: effectiveLimit }, (_, idx) => ({
        id: idx + 1,
        name: `Chamber ${idx + 1}`
      }));
    }

    return applyChamberLimit(chambers).slice(0, effectiveLimit);
  };

  const loadLocalAssignmentsData = (chambersOverride = null) => {
    let chambers = applyChamberLimit(
      Array.isArray(chambersOverride) && chambersOverride.length
        ? chambersOverride
        : (chambersList || [])
    );

    let cachedData = getLocalAssignments(user?.warehouse_name, user?.warehouse_code);

    if (chambers.length === 0) {
      const fromAssign = [];
      const tracker = new Set();
      cachedData.forEach((item) => {
        if (!tracker.has(Number(item.chamber_id))) {
          tracker.add(Number(item.chamber_id));
          fromAssign.push({
            id: item.chamber_id,
            name: item.chamber_name,
            chamber_type: item.chamber_type || null
          });
        }
      });
      chambers = applyChamberLimit(fromAssign);
    }

    // Still empty → show Chamber 1..limit so tasks appear on dashboard
    if (chambers.length === 0 && chamberLimit > 0) {
      chambers = Array.from({ length: chamberLimit }, (_, idx) => ({
        id: idx + 1,
        name: `Chamber ${idx + 1}`
      }));
    }

    // Empty chambers stay empty — DO adds clients chamber-wise in Master Setup
    // (no auto-seed of example clients)

    const lots = getClientLotMaster();
    setMasterClientLots(lots);

    const finalTasks = buildTasksForAssignedChambers(chambers, cachedData);

    chambers = chambers.map((ch) => {
      if (ch.chamber_type) return ch;
      const fromTask = (finalTasks || cachedData || []).find(
        (a) => Number(a.chamber_id) === Number(ch.id) && a.chamber_type
      );
      return { ...ch, chamber_type: fromTask?.chamber_type || 'Frozen' };
    });

    const typeByChamber = new Map(
      chambers.map((ch) => [Number(ch.id), String(ch.chamber_type || 'Frozen').trim() || 'Frozen'])
    );
    const alignedTasks = (finalTasks || []).map((a) => {
      const chamberType = typeByChamber.get(Number(a.chamber_id));
      if (!chamberType) return a;
      return { ...a, chamber_type: chamberType };
    });

    setChambersList(chambers);
    setAssignments(alignedTasks);
    loadInspectionsAndSummary(alignedTasks, chambers);
  };

  const loadInspectionsAndSummary = (currAssignments = assignments, currChambers = chambersList) => {
    const todayStr = getLocalDateStr();
    const operatorEmail = user?.email || null;
    const allInspections = getAllLocalInspections(displayName, operatorEmail);
    const exactToday = getTodaysInspections(todayStr, displayName, operatorEmail);
    const seenIds = new Set((exactToday || []).map((l) => l?.id).filter(Boolean));
    const todaysInspections = [...(exactToday || [])];
    (allInspections || []).forEach((l) => {
      if (!l) return;
      if (!logOnDate(l, todayStr)) return;
      if (l.id && seenIds.has(l.id)) return;
      if (l.id) seenIds.add(l.id);
      todaysInspections.push(l);
    });
    setCompletedLogs(todaysInspections);

    const pendingInspections = getPendingInspections(displayName);
    setUnsyncedLogs(pendingInspections);

    const activeAssignmentsToday = currAssignments.filter(item => item.status !== 'inactive');
    const currentHour = new Date().getHours();
    const activeShiftTasks = [];
    activeAssignmentsToday.forEach(item => {
      activeShiftTasks.push({ ...item, shift_time: '10:00' });
      if (currentHour >= 16) {
        activeShiftTasks.push({ ...item, shift_time: '16:00' });
      }
    });

    const pendingTasksList = activeShiftTasks.filter(item => {
      const wantShift = item.shift_time === '10:00' ? 'Morning' : 'Evening';
      const log = todaysInspections.find((l) =>
        logMatchesChamberRef(l, item.chamber_id, item.chamber_name) &&
        namesMatch(l.client_name, item.client_name) &&
        resolveLogShiftName(l) === wantShift
      );
      return !log;
    });
    setPendingCount(pendingTasksList.length);

    const getPastDates = (numDays) => {
      const dates = [];
      for (let i = 1; i <= numDays; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dates.push(getLocalDateStr(d));
      }
      return dates;
    };

    const past2Days = getPastDates(2);
    const overdueList = [];

    past2Days.forEach(date => {
      currAssignments.forEach(item => {
        if (item.status === 'inactive') return;

        const hasMorningLog = allInspections.some(l =>
          logMatchesChamberRef(l, item.chamber_id, item.chamber_name) &&
          namesMatch(l.client_name, item.client_name) &&
          logOnDate(l, date) &&
          resolveLogShiftName(l) === 'Morning'
        );

        if (!hasMorningLog) {
          overdueList.push({
            ...item,
            id: `overdue_${item.chamber_id}_${item.client_name.replace(/\s+/g, '')}_${date}_Morning`,
            due_date: date,
            is_overdue: true,
            shift: 'Morning',
            shift_time: '10:00',
            shift_label: 'Morning'
          });
        }

        const hasEveningLog = allInspections.some(l =>
          logMatchesChamberRef(l, item.chamber_id, item.chamber_name) &&
          namesMatch(l.client_name, item.client_name) &&
          logOnDate(l, date) &&
          resolveLogShiftName(l) === 'Evening'
        );

        if (!hasEveningLog) {
          overdueList.push({
            ...item,
            id: `overdue_${item.chamber_id}_${item.client_name.replace(/\s+/g, '')}_${date}_Evening`,
            due_date: date,
            is_overdue: true,
            shift: 'Evening',
            shift_time: '16:00',
            shift_label: 'Evening'
          });
        }
      });
    });

    setOverdueTasks(overdueList);
    setOverdueCount(overdueList.length);
    setIsLoadingData(false);
  };

  const refreshCompletedFromServer = async () => {
    loadInspectionsAndSummary();
    if (!apiUrl || !token) return;
    try {
      const todayStr = getLocalDateStr();
      const selected = selectedReportDate || todayStr;
      const from = new Date();
      from.setDate(from.getDate() - 2);
      let fromStr = getLocalDateStr(from);
      if (selected && selected < fromStr) fromStr = selected;
      const qs = new URLSearchParams({
        page: '1',
        limit: '300',
        fromDate: fromStr,
        toDate: todayStr < selected ? selected : todayStr
      });
      if (user?.warehouse_name) {
        qs.set('warehouse', String(user.warehouse_name).trim());
      }
      const res = await fetch(`${apiUrl}/api/chamber-temp?${qs.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      setChamberReportLogs((prev) => {
        const incomingDays = new Set(
          items.map((row) => logDateKey(row.formatted_date || row.entry_date)).filter(Boolean)
        );
        const keep = (prev || []).filter((log) => {
          const day = logDateKey(log.formatted_date || log.entry_date);
          return day && !incomingDays.has(day);
        });
        return [...keep, ...items];
      });
      items.forEach((item) => {
        upsertSyncedInspectionFromServer(item, {
          displayName,
          operatorEmail: user?.email,
          warehouseName: user?.warehouse_name
        });
      });
      reconcileSyncedInspectionsFromServer(items, {
        fromDate: fromStr,
        toDate: todayStr < selected ? selected : todayStr,
        operatorEmail: user?.email
      });
      loadInspectionsAndSummary();
    } catch (_) {}
  };

  const fetchChamberLogsForDate = async (dateStr) => {
    if (!apiUrl || !token || !dateStr) return;
    try {
      const qs = new URLSearchParams({
        page: '1',
        limit: '150',
        fromDate: dateStr,
        toDate: dateStr
      });
      if (user?.warehouse_name) {
        qs.set('warehouse', String(user.warehouse_name).trim());
      }
      const res = await fetch(`${apiUrl}/api/chamber-temp?${qs.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      setChamberReportLogs((prev) => {
        const keep = (prev || []).filter((log) => {
          const day = logDateKey(log.formatted_date || log.entry_date);
          return day !== dateStr;
        });
        return [...keep, ...items];
      });
      items.forEach((item) => {
        upsertSyncedInspectionFromServer(item, {
          displayName,
          operatorEmail: user?.email,
          warehouseName: user?.warehouse_name
        });
      });
      reconcileSyncedInspectionsFromServer(items, {
        fromDate: dateStr,
        toDate: dateStr,
        operatorEmail: user?.email
      });
      loadInspectionsAndSummary();
    } catch (_) {}
  };

  useEffect(() => {
    if (currentNavTab === 'Tasks' || currentNavTab === 'Reports') {
      refreshCompletedFromServer();
    }
  }, [currentNavTab]);

  useEffect(() => {
    if (currentNavTab !== 'Reports') return;
    const dateStr = selectedReportDate || getLocalDateStr();
    fetchChamberLogsForDate(dateStr);
  }, [currentNavTab, selectedReportDate]);

  // Launch phone camera — then compress only (no resize)
  const handleLaunchCamera = async () => {
    try {
      // Permission + GPS services first (blocks camera if Location is OFF)
      const allowed = await ensureCameraPermission();
      if (!allowed) return;

      const locationPromise = beginPhotoLocationCapture();

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions?.Images
          ? ImagePicker.MediaTypeOptions.Images
          : ImagePicker.MediaType?.Images || 'images',
        allowsEditing: false,
        quality: 1,
        exif: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const originalUri = result.assets[0].uri;
        const compressedUri = await compressImageOnly(originalUri, 0.5);
        const meta = await buildPhotoCaptureMeta(locationPromise);

        // EXIF GPS fallback (some devices embed coords in the photo)
        let geo =
          meta.latitude != null && meta.longitude != null
            ? {
                latitude: meta.latitude,
                longitude: meta.longitude,
                accuracy: meta.accuracy,
              }
            : null;
        if (!geo) {
          const exif = result.assets[0].exif || {};
          const lat = parseFloat(exif.GPSLatitude ?? exif.gpsLatitude);
          const lng = parseFloat(exif.GPSLongitude ?? exif.gpsLongitude);
          if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
            geo = { latitude: lat, longitude: lng, accuracy: null };
          }
        }

        setCapturedImage(compressedUri);
        setCapturedImageTimestamp(meta.capturedAt);
        setCapturedImageGeo(geo);

        if (!geo) {
          Alert.alert(
            'Location not saved',
            'Photo saved, but GPS coordinates were not available. Turn on Location/GPS, wait a few seconds, and capture again if coordinates are required.'
          );
        }
      }
    } catch (error) {
      Alert.alert('Camera Error', 'Could not access device camera.');
    }
  };

  // Open Log Form for a specific client
  const handleOpenClientLogForm = (clientName) => {
    const todayStr = getLocalDateStr();
    
    const existingLog = completedLogs.find(l => 
      logMatchesChamberRef(l, selectedChamber.id, selectedChamber.name) && 
      namesMatch(l.client_name, clientName) && 
      logOnDate(l, todayStr) &&
      resolveLogShiftName(l) === activeShift
    );

    setSelectedClient(clientName);
    if (existingLog) {
      setTempInput(existingLog.box_temp.toString());
      setBoxCountInput(existingLog.box_count ? existingLog.box_count.toString() : '');
      setCapturedImage(existingLog.temp_sensor_image);
      applyPhotoCaptureFromLog(existingLog);
    } else {
      setTempInput('');
      setBoxCountInput('');
      setCapturedImage(null);
      setCapturedImageTimestamp(null);
    }
    setIsProfileEditable(true);
    setShowLogModal(true);
  };

  // Variance (minutes) between photo capture time and submit/now time
  const getImageTimeDifferenceInMinutes = (submitTs = Date.now()) => {
    if (!capturedImageTimestamp) return null;
    const diffMs = Math.abs(submitTs - capturedImageTimestamp);
    return Math.floor(diffMs / (1000 * 60));
  };

  // Helper to format Date into standard YYYY-MM-DD HH:mm:ss string
  const formatDateTime = (timestamp) => {
    if (!timestamp) return '';
    const dateObj = new Date(timestamp);
    if (isNaN(dateObj.getTime())) return '';
    const yyyy = dateObj.getFullYear();
    const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
    const dd = String(dateObj.getDate()).padStart(2, '0');
    const hh = String(dateObj.getHours()).padStart(2, '0');
    const min = String(dateObj.getMinutes()).padStart(2, '0');
    const ss = String(dateObj.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  };

  const applyPhotoCaptureFromLog = (log) => {
    if (log?.photo_capture_time) {
      try {
        const parsedDate = new Date(String(log.photo_capture_time).replace(' ', 'T'));
        setCapturedImageTimestamp(isNaN(parsedDate.getTime()) ? null : parsedDate.getTime());
      } catch (e) {
        setCapturedImageTimestamp(null);
      }
    } else {
      setCapturedImageTimestamp(null);
    }
    const lat = log?.photo_capture_latitude;
    const lng = log?.photo_capture_longitude;
    if (
      lat != null &&
      lng != null &&
      !Number.isNaN(parseFloat(lat)) &&
      !Number.isNaN(parseFloat(lng))
    ) {
      setCapturedImageGeo({
        latitude: parseFloat(lat),
        longitude: parseFloat(lng),
        accuracy:
          log.photo_capture_accuracy != null ? parseFloat(log.photo_capture_accuracy) : null,
      });
    } else {
      setCapturedImageGeo(null);
    }
  };

  const formatClockTime = (timestamp) => {
    if (!timestamp) return '-';
    const dateObj = new Date(timestamp);
    if (isNaN(dateObj.getTime())) return '-';
    const hh = String(dateObj.getHours()).padStart(2, '0');
    const min = String(dateObj.getMinutes()).padStart(2, '0');
    const ss = String(dateObj.getSeconds()).padStart(2, '0');
    return `${hh}:${min}:${ss}`;
  };

  const handleTempInputChange = (text) => {
    if (text === '') {
      setTempInput('');
      return;
    }
    if (text === '-') {
      setTempInput('-');
      return;
    }
    const regex = /^-?[0-9]{0,2}\.?[0-9]{0,2}$/;
    if (regex.test(text)) {
      setTempInput(text);
    }
  };

  // Validate log form and trigger confirmation popup
  const handleSaveInspection = () => {
    if (!selectedChamber) {
      Alert.alert('Validation Error', 'Please select a Chamber.');
      return;
    }
    if (!selectedClient) {
      Alert.alert('Validation Error', 'Please select a Client.');
      return;
    }
    if (!editingExistingLog && getClientsForChamber(selectedChamber.id).length === 0) {
      Alert.alert(
        'Add Clients First',
        'Add clients for this chamber in Master Setup before submitting a task.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Open Master Setup',
            onPress: () => {
              setShowLogModal(false);
              openMasterSetupAddClients(selectedChamber);
            }
          }
        ]
      );
      return;
    }
    if (!tempInput || isNaN(parseFloat(tempInput))) {
      Alert.alert('Validation Error', 'Please enter a valid numeric temperature value (e.g. -12.25).');
      return;
    }
    if (!boxCountInput) {
      Alert.alert('Validation Error', 'Please enter a valid box count.');
      return;
    }
    const parsedBoxCount = parseInt(boxCountInput, 10);
    if (isNaN(parsedBoxCount) || parsedBoxCount < 0) {
      Alert.alert('Validation Error', 'Box quantity cannot be negative. Enter 0 or a positive count.');
      return;
    }
    if (!capturedImage) {
      Alert.alert('Validation Error', 'Please capture a photo of the sensor/box.');
      return;
    }
    // Edit + new: photo capture time must exist so it can be compared with submit time
    if (!capturedImageTimestamp) {
      Alert.alert(
        'Retake Photo Required',
        editingExistingLog
          ? 'On edit, the photo capture time is compared with the submit time. Please take a new verification photo.'
          : 'Photo capture time is missing. Please retake the verification photo.'
      );
      return;
    }

    setShowSubmitConfirmModal(true);
  };

  const handleSelectClientPill = (clientName) => {
    // Already submitted for this shift → do not re-open for new entry
    if (
      selectedChamber &&
      isClientCompletedToday(selectedChamber.id, clientName, selectedShift) &&
      !editingExistingLog
    ) {
      return;
    }
    setSelectedClient(clientName);
    const todayStr = getLocalDateStr();
    const targetShift = normalizeShiftLabel(selectedShift);
    const log = completedLogs.find(l => 
      logMatchesChamberRef(l, selectedChamber.id, selectedChamber.name) && 
      namesMatch(l.client_name, clientName) && 
      logOnDate(l, todayStr) &&
      resolveLogShiftName(l) === targetShift
    );
    if (log) {
      setTempInput(log.box_temp.toString());
      setBoxCountInput(log.box_count ? log.box_count.toString() : '');
      setCapturedImage(log.temp_sensor_image);
      setSelectedChamberType(log.chamber_type || getChamberTypeAndDefault(selectedChamber.id).type);
      applyPhotoCaptureFromLog(log);
    } else {
      setTempInput('');
      setBoxCountInput('');
      setCapturedImage(null);
      setCapturedImageTimestamp(null);
      setCapturedImageGeo(null);
      setSelectedChamberType(getChamberTypeAndDefault(selectedChamber.id).type);
    }
  };

  // Save the logged inspection to SQLite and trigger sync after confirmation
  const handleConfirmSaveInspection = async () => {
    setShowSubmitConfirmModal(false);

    const todayStr = getLocalDateStr();
    const targetDate = selectedTaskDueDate || todayStr;
    const submitNowMs = Date.now();
    // Always use real photo capture time (never fake as submit) — compared with submitNowMs
    const captureTimeStr = formatDateTime(capturedImageTimestamp);
    const photoVsSubmitMins = getImageTimeDifferenceInMinutes(submitNowMs);

    // Approved edit of an existing completed log
    if (editingExistingLog) {
      if (!captureTimeStr) {
        Alert.alert(
          'Retake Photo Required',
          'Photo capture time must be compared with the submit time. Please retake the photo, then update.'
        );
        return;
      }

      const serverLogId = getServerLogIdForPermission(editingExistingLog);
      const nowTs = formatDateTime(submitNowMs);
      // Keep original inspection time — Update Time / client name are not editable on edit
      const keepInspectionTime =
        editingExistingLog.inspection_time ||
        (editingExistingLog.shift === 'Evening' ? '16:00' : '10:00');

      const localOk = updateInspectionLocally(editingExistingLog.id, {
        box_temp: parseFloat(tempInput),
        box_count: parseInt(boxCountInput, 10),
        temp_sensor_image: capturedImage,
        photo_capture_time: captureTimeStr,
        photo_capture_latitude: capturedImageGeo?.latitude ?? null,
        photo_capture_longitude: capturedImageGeo?.longitude ?? null,
        photo_capture_accuracy: capturedImageGeo?.accuracy ?? null,
        chamber_type: selectedChamberType,
        inspection_time: keepInspectionTime,
        client_name: editingExistingLog.client_name || selectedClient,
        updated_at: nowTs,
        sync_status: 'synced'
      });

      if (!localOk) {
        Alert.alert('Update Failed', 'Could not update the local log.');
        return;
      }

      try {
        if (serverLogId && apiUrl && token) {
          const formData = new FormData();
          formData.append('box_temp', String(parseFloat(tempInput)));
          formData.append('box_count', String(parseInt(boxCountInput, 10)));
          formData.append('chamber_type', selectedChamberType || 'Frozen');
          formData.append('inspection_time', keepInspectionTime);
          formData.append('photo_capture_time', captureTimeStr);
          if (capturedImageGeo?.latitude != null) {
            formData.append('photo_capture_latitude', String(capturedImageGeo.latitude));
          }
          if (capturedImageGeo?.longitude != null) {
            formData.append('photo_capture_longitude', String(capturedImageGeo.longitude));
          }
          if (capturedImageGeo?.accuracy != null) {
            formData.append('photo_capture_accuracy', String(capturedImageGeo.accuracy));
          }
          formData.append('monitor_supervisor_name', displayName);
          formData.append(
            'remarks',
            `Mobile edit after SA allow. Photo vs submit: ${photoVsSubmitMins ?? '?'} min`
          );
          if (capturedImage && !String(capturedImage).startsWith('http') && !String(capturedImage).startsWith('uploads/')) {
            const filename = String(capturedImage).split('/').pop() || `edit-${serverLogId}.jpg`;
            appendLocalFile(formData, 'temp_sensor_image', capturedImage, {
              name: filename,
              type: 'image/jpeg',
            });
          }

          const res = await multipartRequest(`${apiUrl}/api/chamber-temp/${serverLogId}`, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json'
            },
            body: formData
          });
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.message || data.error || `Update failed (${res.status})`);
          }
        }

        setShowLogModal(false);
        const refLabel = editingExistingLog.reference_no || serverLogId || editingExistingLog.id;
        setEditingExistingLog(null);
        setUpdateTimeInput('');
        setSelectedClient(null);
        setCapturedImage(null);
        setCapturedImageTimestamp(null);
        loadInspectionsAndSummary();
        Alert.alert(
          'Log Updated',
          'Inspection updated. For another edit, request Super Admin permission again.'
        );
        reportDOActivity(
          'UPDATE',
          `Mobile: updated Chamber log ${refLabel}`
        );
      } catch (err) {
        Alert.alert('Cloud Update Failed', err.message || 'Local copy was updated; cloud sync failed.');
        loadInspectionsAndSummary();
      }
      return;
    }

    // Save the actual current submission time in HH:mm 24-hour format
    const nowTime = new Date();
    const hh = String(nowTime.getHours()).padStart(2, '0');
    const min = String(nowTime.getMinutes()).padStart(2, '0');
    const timeStr = `${hh}:${min}`;

    const targetShiftName = selectedShift === '10:00' ? 'Morning' : 'Evening';

    // If it's already logged for targetDate and shift, delete the old record first to allow overwrite
    deleteInspectionLocally(targetDate, selectedChamber.id, selectedClient, targetShiftName);

    // Calculate overdue_time
    let overdueTimeStr = 'same day';
    if (targetDate !== todayStr) {
      try {
        const dueDateObj = new Date(targetDate + 'T18:00:00'); // Standard 6:00 PM shift end
        const nowObj = new Date();
        const diffMs = nowObj - dueDateObj;
        if (diffMs > 0) {
          const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
          const days = Math.floor(diffHours / 24);
          const hours = diffHours % 24;
          overdueTimeStr = days > 0 ? `${days}d ${hours}h later` : `${hours}h later`;
        }
      } catch (err) {
        overdueTimeStr = 'completed later';
      }
    }

    const newLog = {
      id: `${selectedChamber.id}_${selectedClient.replace(/\s+/g, '')}_${Date.now()}`,
      monitor_supervisor_name: displayName,
      chamber_id: selectedChamber.id,
      chamber_name: selectedChamber.name,
      client_name: selectedClient,
      client_code: (assignments || []).find((a) =>
        String(a.client_name || '').trim().toLowerCase() === String(selectedClient || '').trim().toLowerCase()
      )?.client_code || null,
      box_temp: parseFloat(tempInput),
      box_count: parseInt(boxCountInput, 10),
      temp_sensor_image: capturedImage,
      entry_date: targetDate,
      inspection_time: timeStr,
      chamber_type: selectedChamberType,
      overdue_time: overdueTimeStr,
      photo_capture_time: captureTimeStr,
      photo_capture_latitude: capturedImageGeo?.latitude ?? null,
      photo_capture_longitude: capturedImageGeo?.longitude ?? null,
      photo_capture_accuracy: capturedImageGeo?.accuracy ?? null,
      shift: targetShiftName,
      created_at: formatDateTime(new Date()),
      warehouse_name: user?.warehouse_name || null,
      warehouse_code: user?.warehouse_code || null,
      operator_email: user?.email || null
    };

    const success = saveInspectionLocally(newLog);
    if (success) {
      setShowLogModal(false);
      setCapturedImage(null);
      setCapturedImageTimestamp(null);
      setCapturedImageGeo(null);

      const target = getChamberClientTarget(selectedChamber.id);
      const todaysAfterSave = getTodaysInspections(targetDate, displayName, user?.email);
      const doneAfter = countLoggedClientsForChamber(
        selectedChamber.id,
        targetShiftName,
        targetDate,
        todaysAfterSave
      );
      const totalClients = target != null ? target : 0;
      const chamberFullyDone = target != null && doneAfter >= target;
      const remaining = target != null ? Math.max(0, target - doneAfter) : 0;

      if (currentNavTab === 'Dashboard' || openedFromFab) {
        setSelectedChamber(null);
        setOpenedFromFab(false);
        setSelectedClient(null);
      }

      if (chamberFullyDone) {
        setActiveTab('Completed');
        setSelectedClient(null);
      } else {
        setActiveTab('Pending');
      }

      loadInspectionsAndSummary();

      Alert.alert(
        'Inspection Saved',
        chamberFullyDone
          ? `All ${totalClients} client(s) logged for ${selectedChamber.name}. Chamber completed.`
          : `Saved "${selectedClient}". ${doneAfter}/${totalClients || '?'} done — ${remaining} more needed.`,
        [
          { text: 'OK' },
          ...(!chamberFullyDone && target != null && remaining > 0 && currentNavTab === 'Tasks'
            ? [
                {
                  text: 'Next Client',
                  onPress: () => handleOpenChamberLogFormDirect(selectedChamber)
                }
              ]
            : [])
        ]
      );

      triggerSync(apiUrl, token, handleSyncProgress, user);
    } else {
      Alert.alert('Database Error', 'Failed to save log to local SQLite queue.');
    }
  };

  const handleCloseModal = () => {
    setShowLogModal(false);
    setSelectedClient(null);
    setCapturedImageTimestamp(null);
    setEditingExistingLog(null);
    setUpdateTimeInput('');
    setShowChamberDropdown(false);
    setShowClientDropdown(false);
    if (currentNavTab === 'Dashboard' || openedFromFab) {
      setSelectedChamber(null);
      setOpenedFromFab(false);
    }
  };

  // Dynamic Client Master Management methods
  const applyChamberZoneChange = async (chamber, nextType, remark) => {
    const type = normalizeChamberTypeValue(nextType);
    const note = String(remark || '').trim();
    if (!chamber?.id) return false;

    const apiOk = await handleUpdateChamberType(chamber.id, type, note);
    if (!apiOk) return false;

    setNewClientType(type);
    setManagerSelectedChamber((prev) => (prev ? { ...prev, chamber_type: type } : prev));
    updateLocalChamberType(chamber.id, type);
    loadLocalAssignmentsData(chambersList);
    reportDOActivity(
      'UPDATE_CHAMBER_ZONE',
      `${displayName} changed temperature zone of ${chamber.name} to "${type}" on ${formatActivityDateTime()}. Remark: ${note}`,
      note,
      chamber.id
    );
    if (apiUrl && token) triggerSync(apiUrl, token, handleSyncProgress, user);
    await clearPendingChamberType(chamber.id);
    return true;
  };

  const applyChamberEditDraft = async (typeRemark = '') => {
    const draft = chamberEditDraft;
    if (!draft) {
      closeChamberEditSession();
      return false;
    }
    if (!chamberEditHasChanges(draft)) {
      closeChamberEditSession();
      return false;
    }

    const note = String(typeRemark || '').trim();
    if (!note) return false;

    const chamber = chambersList.find((c) => Number(c.id) === Number(draft.chamberId)) || {
      id: draft.chamberId,
      name: draft.chamberName
    };
    const typeChanged =
      normalizeChamberTypeValue(draft.type) !== normalizeChamberTypeValue(draft.baselineType);
    let requested = 0;

    for (const row of draft.clients || []) {
      if (row._op === 'add') {
        const ok = await requestClientMasterPermission({
          chamber,
          action: 'add',
          clientName: row.client_name,
          chamberType: draft.type,
          remark: note,
          silent: true
        });
        if (ok) requested += 1;
      } else if (row._op === 'delete') {
        const ok = await requestClientMasterPermission({
          chamber,
          action: 'delete',
          clientName: row.client_name,
          remark: note,
          silent: true
        });
        if (ok) requested += 1;
      } else if (row._op === 'rename' && row.oldName) {
        const ok = await requestClientMasterPermission({
          chamber,
          action: 'edit',
          clientName: row.oldName,
          newName: row.client_name,
          remark: note,
          silent: true
        });
        if (ok) requested += 1;
      }
    }

    if (typeChanged) {
      await requestChamberTypePermission(chamber, draft.type, draft.baselineType, note);
    }

    closeChamberEditSession();
    if (requested > 0 || typeChanged) {
      Alert.alert(
        'Request Sent',
        typeChanged && requested > 0
          ? `Client changes and chamber type for "${chamber.name}" were sent to Super Admin. They will apply automatically after approval.`
          : typeChanged
            ? `Chamber type for "${chamber.name}" will update after Super Admin allows.`
            : `Client changes for "${chamber.name}" were sent to Super Admin. New clients appear in today's temperature tasks now; Super Admin approval confirms them on the server.`
      );
    }
    return requested > 0 || typeChanged;
  };

  const handleChangeChamberZone = (type) => {
    const nextType = normalizeChamberTypeValue(type);
    if (chamberEditDraft && Number(chamberEditDraft.chamberId) === Number(managerSelectedChamber?.id)) {
      if (normalizeChamberTypeValue(chamberEditDraft.type) === nextType) return;
      setChamberEditDraft((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          type: nextType,
          clients: (prev.clients || []).map((c) => ({ ...c, chamber_type: nextType }))
        };
      });
      setNewClientType(nextType);
      return;
    }
    if (!managerSelectedChamber) return;
    if (nextType === newClientType) return;

    const draft = ensureChamberEditSession(managerSelectedChamber);
    if (!draft) return;
    setChamberEditDraft((prev) => {
      const base = prev && Number(prev.chamberId) === Number(managerSelectedChamber.id) ? prev : draft;
      return {
        ...base,
        type: nextType,
        clients: (base.clients || []).map((c) => ({ ...c, chamber_type: nextType }))
      };
    });
    setNewClientType(nextType);
  };

  const handleAddNewClient = () => {
    if (!managerSelectedChamber) {
      Alert.alert('Validation Error', 'Please select a Chamber first.');
      return;
    }
    if (!newClientInput || !newClientInput.trim()) {
      Alert.alert('Validation Error', 'Please enter a Client Lot Name.');
      return;
    }
    const clientName = ensureClientInLotMaster(newClientInput);
    if (!clientName) {
      Alert.alert('Validation Error', 'Please enter a Client Lot Name.');
      return;
    }

    if (chamberEditDraft && Number(chamberEditDraft.chamberId) === Number(managerSelectedChamber.id)) {
      const duplicateExists = getMasterSetupClients(managerSelectedChamber.id).some(
        (item) => String(item.client_name).toLowerCase() === clientName.toLowerCase()
      );
      if (duplicateExists) {
        Alert.alert('Already on chamber', `"${clientName}" is already on ${managerSelectedChamber.name}.`);
        return;
      }
      setChamberEditDraft((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          clients: [
            ...prev.clients,
            {
              key: `add_${clientName}_${Date.now()}`,
              client_name: clientName,
              chamber_type: prev.type,
              _op: 'add'
            }
          ]
        };
      });
      setNewClientInput('');
      setShowClientSuggestions(false);
      return;
    }

    const duplicateExists = getMasterSetupClients(managerSelectedChamber.id).some(
      (item) => item.client_name.toLowerCase() === clientName.toLowerCase()
    );
    if (duplicateExists) {
      Alert.alert('Already on chamber', `"${clientName}" is already on ${managerSelectedChamber.name}.`);
      return;
    }

    const draft = ensureChamberEditSession(managerSelectedChamber);
    if (!draft) return;
    setChamberEditDraft((prev) => {
      const base = prev && Number(prev.chamberId) === Number(managerSelectedChamber.id) ? prev : draft;
      const already = (base.clients || []).some(
        (c) => String(c.client_name).toLowerCase() === clientName.toLowerCase() && c._op !== 'delete'
      );
      if (already) return base;
      return {
        ...base,
        clients: [
          ...base.clients,
          {
            key: `add_${clientName}_${Date.now()}`,
            client_name: clientName,
            chamber_type: base.type,
            _op: 'add'
          }
        ]
      };
    });
    setNewClientInput('');
    setShowClientSuggestions(false);
  };

  const handleRenameChamberClient = async () => {
    if (!managerSelectedChamber || !editingClientName) return;
    const oldName = editingClientName.oldName;
    const newName = String(editClientDraft || '').trim();
    if (!newName) {
      Alert.alert('Validation Error', 'Enter a new client name.');
      return;
    }
    if (newName.toLowerCase() === String(oldName).toLowerCase()) {
      setEditingClientName(null);
      setEditClientDraft('');
      return;
    }

    if (chamberEditDraft && Number(chamberEditDraft.chamberId) === Number(managerSelectedChamber.id)) {
      const duplicateExists = getMasterSetupClients(managerSelectedChamber.id).some(
        (item) =>
          String(item.client_name).toLowerCase() === newName.toLowerCase() &&
          String(item.client_name).toLowerCase() !== String(oldName).toLowerCase()
      );
      if (duplicateExists) {
        Alert.alert('Already on chamber', `"${newName}" is already on ${managerSelectedChamber.name}.`);
        return;
      }
      setChamberEditDraft((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          clients: prev.clients.map((c) => {
            const match =
              String(c.client_name) === String(oldName) ||
              String(c.oldName || '') === String(oldName);
            if (!match) return c;
            if (c._op === 'add') return { ...c, client_name: newName };
            return { ...c, client_name: newName, oldName: c.oldName || oldName, _op: 'rename' };
          })
        };
      });
      setEditingClientName(null);
      setEditClientDraft('');
      return;
    }

    setEditingClientName(null);
    setEditClientDraft('');
    const draft = ensureChamberEditSession(managerSelectedChamber);
    if (!draft) return;
    setChamberEditDraft((prev) => {
      const base = prev && Number(prev.chamberId) === Number(managerSelectedChamber.id) ? prev : draft;
      return {
        ...base,
        clients: base.clients.map((c) => {
          const match =
            String(c.client_name) === String(oldName) ||
            String(c.oldName || '') === String(oldName);
          if (!match) return c;
          if (c._op === 'add') return { ...c, client_name: newName };
          return { ...c, client_name: newName, oldName: c.oldName || oldName, _op: 'rename' };
        })
      };
    });
  };

  const handleDeleteClient = (clientName, chamberOverride = null) => {
    const chamber = chamberOverride || managerSelectedChamber;
    if (!chamber || !clientName) return;
    if (chamberEditDraft && Number(chamberEditDraft.chamberId) === Number(chamber.id)) {
      setChamberEditDraft((prev) => {
        if (!prev) return prev;
        const nextClients = [];
        for (const c of prev.clients) {
          const match = String(c.client_name) === String(clientName);
          if (!match) {
            nextClients.push(c);
            continue;
          }
          if (c._op === 'add') continue;
          nextClients.push({ ...c, _op: 'delete' });
        }
        return { ...prev, clients: nextClients };
      });
      return;
    }
    const draft = ensureChamberEditSession(chamber);
    if (!draft) return;
    setChamberEditDraft((prev) => {
      const base = prev && Number(prev.chamberId) === Number(chamber.id) ? prev : draft;
      const nextClients = [];
      for (const c of base.clients) {
        const match = String(c.client_name) === String(clientName);
        if (!match) {
          nextClients.push(c);
          continue;
        }
        if (c._op === 'add') continue;
        nextClients.push({ ...c, _op: 'delete' });
      }
      return { ...base, clients: nextClients };
    });
  };

  /** Delete client master from task form (same flow as Master Setup). */
  const openDeleteClientFromTaskForm = (clientName) => {
    if (!selectedChamber || !clientName) return;
    setShowClientDropdown(false);
    handleDeleteClient(clientName, selectedChamber);
  };

  // Chamber type is the source of truth — every client on that chamber uses the same compliance.
  const getChamberTypeAndDefault = (chamberId, clientName) => {
    const foundCh = chambersList.find((c) => Number(c.id) === Number(chamberId));
    let dbType = foundCh?.chamber_type || null;

    if (!dbType && clientName) {
      const foundAssign = (assignments || []).find(
        (a) =>
          Number(a.chamber_id) === Number(chamberId) &&
          a.client_name &&
          String(a.client_name).toLowerCase().trim() === String(clientName).toLowerCase().trim()
      );
      dbType = foundAssign?.chamber_type;
    }

    if (!dbType) {
      const anyAssign = (assignments || []).find(
        (a) => Number(a.chamber_id) === Number(chamberId) && a.chamber_type
      );
      dbType = anyAssign?.chamber_type;
    }

    let type = dbType || 'Frozen';

    if (type === 'Frozen') {
      return { type: 'Frozen', defaultTemp: -20.0, icon: 'snow', color: '#1d4ed8', bg: '#dbeafe' };
    } else if (type === 'Chilled') {
      return { type: 'Chilled', defaultTemp: 2.0, icon: 'thermometer', color: '#0d9488', bg: '#ccfbf1' };
    } else if (type === 'Dry') {
      return { type: 'Dry', defaultTemp: 18.0, icon: 'leaf', color: '#16a34a', bg: '#dcfce7' };
    } else {
      return { type: 'Other', defaultTemp: 25.0, icon: 'options', color: '#64748b', bg: '#f1f5f9' };
    }
  };

  // Details for Chamber Grid cards
  const getChamberDetails = (chamber) => {
    const pattern = getChamberTypeAndDefault(chamber.id);
    const chamberLogs = completedLogs.filter(log => Number(log.chamber_id) === Number(chamber.id) && log.shift === activeShift);
    const hasLogs = chamberLogs.length > 0;
    
    const tempVal = hasLogs ? chamberLogs[chamberLogs.length - 1].box_temp : null;

    let displayTemp = '--.-°C';
    let status = 'Pending';
    let statusColor = '#f59e0b';
    let type = pattern.type;
    let icon = pattern.icon;
    let pillColor = pattern.color;
    let pillBg = pattern.bg;
    let hasAlert = false;

    const chamberAssignments = assignments.filter(item => Number(item.chamber_id) === Number(chamber.id));
    const completedCount = chamberLogs.length;
    const totalCount = chamberAssignments.length;

    if (hasLogs) {
      chamberLogs.forEach(log => {
        const currentType = log.chamber_type || type;
        if (currentType === 'Frozen' && log.box_temp > -18) hasAlert = true;
        if (currentType === 'Chilled' && (log.box_temp < -5 || log.box_temp > 5)) hasAlert = true;
        if (currentType === 'Dry' && (log.box_temp < 15 || log.box_temp > 25)) hasAlert = true;
        // 'Other' type has no alert constraints
      });
    }

    if (completedCount > 0 && completedCount === totalCount) {
      status = 'Done';
      statusColor = '#16a34a';
    } else {
      status = 'Normal';
      statusColor = '#f59e0b';
    }

    if (tempVal !== null) {
      displayTemp = `${tempVal.toFixed(1)}°C`;
    }

    return { displayTemp, status, statusColor, type, icon, pillColor, pillBg, hasAlert };
  };

  // Filters Chambers List based on stats tab clicks
  const getFilteredChambers = () => {
    const todayStr = getLocalDateStr();
    if (activeTab === 'All') return chambersList;
    return chambersList.filter(chamber => {
      const target = getChamberClientTarget(chamber.id);
      const done = countLoggedClientsForChamber(chamber.id, activeShift, todayStr);
      const isCompleted = target != null && done >= target;

      if (activeTab === 'Pending') {
        return !isCompleted;
      }
      if (activeTab === 'Completed') {
        return isCompleted;
      }
      if (activeTab === 'Failed') {
        const pattern = getChamberTypeAndDefault(chamber.id);
        const chamberLogs = completedLogs.filter(
          (log) => Number(log.chamber_id) === Number(chamber.id) && resolveLogShiftName(log) === activeShift
        );
        return chamberLogs.some(log => {
          if (pattern.type === 'Frozen') return log.box_temp > -18;
          if (pattern.type === 'Chilled') return log.box_temp < -5 || log.box_temp > 5;
          return log.box_temp <= 0;
        });
      }
      return true;
    });
  };

  const getFilteredAssignments = (targetTab = activeTab) => {
    if (targetTab === 'Overdue') {
      return overdueTasks;
    }
    
    // Duplicate active assignments for the two shifts (10:00 AM and 04:00 PM)
    const shiftTasks = [];
    const currentHour = new Date().getHours();
    const includeEvening = currentHour >= 16 || targetTab === 'Completed';
    assignments.forEach(item => {
      if (item.status === 'inactive') return;
      
      shiftTasks.push({
        ...item,
        shift_time: '10:00',
        shift_label: 'Morning Task'
      });
      
      if (includeEvening) {
        shiftTasks.push({
          ...item,
          shift_time: '16:00',
          shift_label: 'Evening Task'
        });
      }
    });

    return shiftTasks.filter(item => {
      const todayStr = getLocalDateStr();
      const wantShift = item.shift_time === '10:00' ? 'Morning' : 'Evening';
      const log = completedLogs.find(l =>
        logMatchesChamberRef(l, item.chamber_id, item.chamber_name) &&
        namesMatch(l.client_name, item.client_name) &&
        logOnDate(l, todayStr) &&
        resolveLogShiftName(l) === wantShift
      );
      const isCompleted = !!log;
      const pattern = getChamberTypeAndDefault(item.chamber_id, item.client_name);
      
      let hasWarning = false;
      if (isCompleted) {
        const checkType = log.chamber_type || pattern.type;
        if (checkType === 'Frozen' && log.box_temp > -18) hasWarning = true;
        if (checkType === 'Chilled' && (log.box_temp < -5 || log.box_temp > 5)) hasWarning = true;
        if (checkType === 'Dry' && (log.box_temp < 15 || log.box_temp > 25)) hasWarning = true;
      }

      if (targetTab === 'Pending') {
        return !isCompleted;
      }
      if (targetTab === 'Completed') {
        return isCompleted;
      }
      return true;
    });
  };

  /**
   * Tasks screen list:
   * - All / Pending / Overdue → one row per chamber (+ shift)
   * - Completed → one row per client lot (logged)
   */
  const getTasksScreenList = (targetTab = activeTab) => {
    let list = [];

    // Completed = every submitted client log today (Morning + Evening), from SQLite
    if (targetTab === 'Completed') {
      const todayStr = getLocalDateStr();
      const seen = new Set();
      list = [];
      const mergedLogs = getMergedInspectionLogs().filter((log) => logOnDate(log, todayStr));
      mergedLogs.forEach((log) => {
        const shiftName = resolveLogShiftName(log) === 'Evening' ? 'Evening' : 'Morning';
        const chamberId = resolveLogChamberId(log) ?? log.chamber_id;
        const clientKey = String(log.client_name || '').toLowerCase().trim();
        const key = `${chamberId || log.chamber_name || ''}|${clientKey}|${shiftName}`;
        if (!clientKey || seen.has(key)) return;
        seen.add(key);
        const assign = (assignments || []).find(
          (a) =>
            logMatchesChamberRef(log, a.chamber_id, a.chamber_name) &&
            namesMatch(a.client_name, log.client_name) &&
            a.status !== 'inactive'
        );
        list.push({
          ...(assign || {}),
          ...log,
          chamber_id: chamberId ?? assign?.chamber_id,
          chamber_name: log.chamber_name || assign?.chamber_name,
          client_name: log.client_name || assign?.client_name,
          shift_time: shiftName === 'Evening' ? '16:00' : '10:00',
          shift_label: shiftName === 'Evening' ? 'Evening Task' : 'Morning Task',
          _view: 'client',
          is_chamber_task: false,
          is_completed: true
        });
      });
      list.sort((a, b) => {
        const na = parseInt((String(a.chamber_name || '').match(/\d+/) || [a.chamber_id])[0], 10);
        const nb = parseInt((String(b.chamber_name || '').match(/\d+/) || [b.chamber_id])[0], 10);
        if (na !== nb) return na - nb;
        if (String(a.shift_time) !== String(b.shift_time)) {
          return String(a.shift_time).localeCompare(String(b.shift_time));
        }
        return String(a.client_name || '').localeCompare(String(b.client_name || ''));
      });
    } else if (targetTab === 'Overdue') {
      // Overdue
      if (taskChamberFilter !== 'All') {
        // If a chamber filter is active, return individual client-wise overdue tasks!
        list = overdueTasks.map(item => ({
          ...item,
          _view: 'client',
          is_chamber_task: false,
          is_overdue: true
        }));
      } else {
        // Overdue = chamber-wise (group missed client rows)
        const map = new Map();
        overdueTasks.forEach((t) => {
          const key = `${t.chamber_id}_${t.due_date}_${t.shift_time || t.shift || ''}`;
          if (!map.has(key)) {
            map.set(key, {
              _view: 'chamber',
              is_chamber_task: true,
              is_overdue: true,
              chamber_id: t.chamber_id,
              chamber_name: t.chamber_name,
              client_name: null,
              due_date: t.due_date,
              shift_time: t.shift_time || (t.shift === 'Evening' ? '16:00' : '10:00'),
              shift_label: t.shift_label || (t.shift === 'Evening' ? 'Evening Task' : 'Morning Task'),
              clients_total: 0,
              clients_done: 0,
              is_completed: false
            });
          }
          map.get(key).clients_total += 1;
        });
        list = Array.from(map.values()).sort((a, b) => {
          const na = parseInt((String(a.chamber_name || '').match(/\d+/) || [a.chamber_id])[0], 10);
          const nb = parseInt((String(b.chamber_name || '').match(/\d+/) || [b.chamber_id])[0], 10);
          if (String(a.due_date) !== String(b.due_date)) {
            return String(b.due_date).localeCompare(String(a.due_date));
          }
          return na - nb;
        });
      }
    } else {
      // All / Pending
      if (taskChamberFilter !== 'All') {
        // If a chamber filter is active, return individual client-wise tasks!
        list = getFilteredAssignments(targetTab).map((item) => ({
          ...item,
          _view: 'client',
          is_chamber_task: false
        }));
      } else {
        // All / Pending = chamber-wise for active shift slots
        const todayStr = getLocalDateStr();
        const currentHour = new Date().getHours();
        const shifts = [{ time: '10:00', label: 'Morning Task', name: 'Morning' }];
        if (currentHour >= 16) {
          shifts.push({ time: '16:00', label: 'Evening Task', name: 'Evening' });
        }

        const rows = [];
        chambersList.forEach((ch) => {
          shifts.forEach((shift) => {
            const target = getChamberClientTarget(ch.id);
            const doneCount = countLoggedClientsForChamber(ch.id, shift.name, todayStr);
            // User-typed total (1,2,3,4…) — chamber complete only when logged >= target
            const clientsTotal = target != null ? target : 0;
            const isDone = target != null && doneCount >= target;

            if (targetTab === 'Pending' && isDone) return;
            if (targetTab === 'All' || targetTab === 'Pending') {
              rows.push({
                _view: 'chamber',
                is_chamber_task: true,
                chamber_id: ch.id,
                chamber_name: ch.name,
                client_name: null,
                shift_time: shift.time,
                shift_label: shift.label,
                clients_total: clientsTotal,
                clients_done: doneCount,
                target_set: target != null,
                is_completed: isDone,
                is_overdue: false
              });
            }
          });
        });

        list = rows.sort((a, b) => {
          const na = parseInt((String(a.chamber_name || '').match(/\d+/) || [a.chamber_id])[0], 10);
          const nb = parseInt((String(b.chamber_name || '').match(/\d+/) || [b.chamber_id])[0], 10);
          if (na !== nb) return na - nb;
          return String(a.shift_time).localeCompare(String(b.shift_time));
        });
      }
    }

    // Apply chamber and client filters
    if (taskChamberFilter !== 'All') {
      const selectedChamber = chambersList.find((c) => Number(c.id) === Number(taskChamberFilter));
      list = list.filter((item) =>
        Number(item.chamber_id) === Number(taskChamberFilter) ||
        namesMatch(item.chamber_name, selectedChamber?.name)
      );
    }
    if (taskClientFilter !== 'All') {
      list = list.filter(item => {
        if (item.is_chamber_task) {
          return assignments.some(
            a => Number(a.chamber_id) === Number(item.chamber_id) &&
            namesMatch(a.client_name, taskClientFilter) &&
            a.status !== 'inactive'
          );
        }
        return namesMatch(item.client_name, taskClientFilter);
      });
    }

    return list;
  };

  // Check if a client log exists today for a specific chamber + shift
  const normalizeShiftLabel = (shiftOrTime) => {
    if (!shiftOrTime) return activeShift;
    if (shiftOrTime === 'Morning' || shiftOrTime === 'Evening') return shiftOrTime;
    if (shiftOrTime === '10:00' || String(shiftOrTime).startsWith('10')) return 'Morning';
    if (shiftOrTime === '16:00' || String(shiftOrTime).startsWith('16')) return 'Evening';
    return shiftOrTime;
  };

  const isClientCompletedToday = (chamberId, clientName, entryTime = null) => {
    const todayStr = getLocalDateStr();
    const targetShift = normalizeShiftLabel(entryTime || activeShift);
    const chamber = (chambersList || []).find((c) => Number(c.id) === Number(chamberId));
    return completedLogs.some((log) =>
      logMatchesChamberRef(log, chamberId, chamber?.name) &&
      namesMatch(log.client_name, clientName) &&
      logOnDate(log, todayStr) &&
      resolveLogShiftName(log) === targetShift
    );
  };

  // Open task profile detail in unified modal
  const openCompletedTaskProfile = (item, existingLog = null) => {
    const todayStr = getLocalDateStr();
    const wantShift =
      item.shift_time === '16:00' || /evening/i.test(String(item.shift_label || item.shift || ''))
        ? 'Evening'
        : 'Morning';
    const targetDate = logDateKey(item.due_date || item.entry_date || item.formatted_date) || todayStr;

    const matchLog = (l) =>
      l &&
      logMatchesChamberRef(l, item.chamber_id, item.chamber_name) &&
      namesMatch(l.client_name, item.client_name) &&
      logOnDate(l, targetDate) &&
      (item.shift_time || item.shift_label ? resolveLogShiftName(l) === wantShift : true);

    const itemLooksLikeLog =
      item &&
      (item.box_temp != null || item.temp_sensor_image || item.inspection_time || item.shift);
    const log =
      existingLog ||
      completedLogs.find(matchLog) ||
      (itemLooksLikeLog ? item : null) ||
      (chamberReportLogs || []).find(matchLog);

    if (!log) {
      Alert.alert('Task details', 'Log details are not available for this task yet.');
      return;
    }

    setSelectedChamber({
      id: log.chamber_id ?? item.chamber_id,
      name: log.chamber_name || item.chamber_name
    });
    setSelectedClient(log.client_name || item.client_name);
    setTempInput(log.box_temp != null ? String(log.box_temp) : '');
    setBoxCountInput(log.box_count != null ? String(log.box_count) : '');
    setCapturedImage(log.temp_sensor_image || log.photo_url || null);
    setSelectedChamberType(
      log.chamber_type || getChamberTypeAndDefault(item.chamber_id, item.client_name).type
    );
    setLogOperatorName(log.monitor_supervisor_name || displayName);
    setLogWarehouseName(log.warehouse_name || user?.warehouse_name || '—');
    setLogOperatorEmail(log.operator_email || user?.email || '—');
    setLogSyncStatus(log.sync_status || 'synced');
    setLogEntryDate(logDateKey(log.entry_date || log.formatted_date) || targetDate);
    setLogEntryTime(log.inspection_time || item.shift_time || '');
    setLogShift(resolveLogShiftName(log) || wantShift);

    applyPhotoCaptureFromLog(log);

    setEditingExistingLog(null);
    setIsProfileEditable(false);
    setOpenedFromFab(false);
    setShowLogModal(true);
  };

  const handleOpenTaskDetail = (item, existingLog = null) => {
    if (item?.is_chamber_task) {
      const wantShift =
        item.shift_time === '16:00' || /evening/i.test(String(item.shift_label || item.shift || ''))
          ? 'Evening'
          : 'Morning';
      const targetDate = logDateKey(item.due_date || item.entry_date) || getLocalDateStr();
      const firstLog = completedLogs.find(
        (l) =>
          logMatchesChamberRef(l, item.chamber_id, item.chamber_name) &&
          logOnDate(l, targetDate) &&
          resolveLogShiftName(l) === wantShift
      );
      if (!firstLog) {
        Alert.alert('Task details', 'No completed client log found for this chamber task yet.');
        return;
      }
      openCompletedTaskProfile({ ...item, ...firstLog, is_chamber_task: false }, firstLog);
      return;
    }
    openCompletedTaskProfile(item, existingLog);
  };

  const handleOpenTaskLogForm = (item) => {
    const targetDate = item.due_date || getLocalDateStr();
    setSelectedTaskDueDate(targetDate);
    setEditingExistingLog(null);
    
    const wantShift =
      item.shift_time === '16:00' || /evening/i.test(String(item.shift_label || item.shift || ''))
        ? 'Evening'
        : 'Morning';
    setSelectedShift(wantShift === 'Evening' ? '16:00' : '10:00');
    const matchLog = (l) =>
      Number(l.chamber_id) === Number(item.chamber_id) &&
      namesMatch(l.client_name, item.client_name) &&
      logDateKey(l.entry_date) === logDateKey(targetDate) &&
      resolveLogShiftName(l) === wantShift;
    const existingLog = completedLogs.find(matchLog) || (item.is_overdue ? unsyncedLogs.find(matchLog) : null);

    const chamber = chambersList.find(c => c.id === item.chamber_id) || { id: item.chamber_id, name: item.chamber_name };
    setSelectedChamber(chamber);
    setSelectedClient(item.client_name);
    
    if (existingLog) {
      setTempInput(existingLog.box_temp.toString());
      setBoxCountInput(existingLog.box_count ? existingLog.box_count.toString() : '');
      setCapturedImage(existingLog.temp_sensor_image);
      setSelectedChamberType(existingLog.chamber_type || getChamberTypeAndDefault(item.chamber_id, item.client_name).type);
      applyPhotoCaptureFromLog(existingLog);
    } else {
      setTempInput('');
      setBoxCountInput('');
      setCapturedImage(null);
      setCapturedImageTimestamp(null);
      setCapturedImageGeo(null);
      setSelectedChamberType(getChamberTypeAndDefault(item.chamber_id, item.client_name).type);
    }
    
    setIsProfileEditable(true);
    setOpenedFromFab(false);
    setShowLogModal(true);
  };

  /** Resolve server log id for permission (synced native chamber temp log). */
  const getServerLogIdForPermission = (log) => {
    if (!log) return null;
    if (log.server_log_id) return Number(log.server_log_id);
    // Fallback: parse RF-CH-26-0042 → 42
    const ref = String(log.reference_no || '');
    const m = ref.match(/(\d+)\s*$/);
    return m ? parseInt(m[1], 10) : null;
  };

  const openEditableLogForm = (item, existingLog) => {
    const targetDate = item.due_date || existingLog?.entry_date || getLocalDateStr();
    setSelectedTaskDueDate(targetDate);
    const targetShift = item.shift_time || (existingLog?.shift === 'Evening' ? '16:00' : '10:00');
    setSelectedShift(targetShift);

    const chamber = chambersList.find(c => c.id === item.chamber_id) || { id: item.chamber_id, name: item.chamber_name };
    setSelectedChamber(chamber);
    setSelectedClient(item.client_name);
    setEditingExistingLog(existingLog);

    setTempInput(existingLog.box_temp != null ? String(existingLog.box_temp) : '');
    setBoxCountInput(existingLog.box_count ? String(existingLog.box_count) : '');
    setCapturedImage(existingLog.temp_sensor_image);
    setSelectedChamberType(existingLog.chamber_type || getChamberTypeAndDefault(item.chamber_id, item.client_name).type);
    setUpdateTimeInput('');
    setShowClientDropdown(false);
    applyPhotoCaptureFromLog(existingLog);

    setIsProfileEditable(true);
    setOpenedFromFab(false);
    setShowLogModal(true);
  };

  /**
   * Completed task → Edit requires Super Admin permission.
   * Approved → open edit form; otherwise show permission request popup (SA Role & Permission gets notification).
   */
  const handleEditCompletedLog = async (item) => {
    const todayStr = getLocalDateStr();
    const targetDate = item.due_date || todayStr;
    const targetShiftName = item.shift_time === '10:00' || item.shift_time === '10:00 AM' ? 'Morning' : 'Evening';

    const existingLog = completedLogs.find(l =>
      logMatchesChamberRef(l, item.chamber_id, item.chamber_name) &&
      namesMatch(l.client_name, item.client_name) &&
      logOnDate(l, targetDate) &&
      resolveLogShiftName(l) === targetShiftName
    ) || completedLogs.find(l =>
      logMatchesChamberRef(l, item.chamber_id, item.chamber_name) &&
      namesMatch(l.client_name, item.client_name) &&
      logOnDate(l, targetDate)
    );

    if (!existingLog) {
      Alert.alert('Not Found', 'Completed log was not found on this device.');
      return;
    }

    if (existingLog.sync_status !== 'synced') {
      Alert.alert(
        'Sync Required',
        'This log is still in the device queue. Wait until it syncs to the cloud, then request edit permission.'
      );
      triggerSync(apiUrl, token, handleSyncProgress, user);
      return;
    }

    const serverLogId = getServerLogIdForPermission(existingLog);
    if (!serverLogId) {
      Alert.alert(
        'Permission Unavailable',
        'Server log ID is missing. Pull to refresh / sync again, then retry Edit.'
      );
      return;
    }

    try {
      setPermissionModal(prev => ({ ...prev, loading: true }));
      const res = await fetch(
        `${apiUrl}/api/permission-requests/check?record_type=${encodeURIComponent('Chamber')}&record_id=${encodeURIComponent(serverLogId)}&action=Edit`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json'
          }
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || 'Failed to verify permission.');
      }

      if (data.approved) {
        setPermissionModal({ isOpen: false, status: 'None', log: null, taskItem: null, loading: false });
        openEditableLogForm(item, existingLog);
        return;
      }

      setPermissionModal({
        isOpen: true,
        status: data.status || 'None',
        log: { ...existingLog, server_log_id: serverLogId },
        taskItem: item,
        loading: false
      });
    } catch (err) {
      setPermissionModal(prev => ({ ...prev, loading: false }));
      Alert.alert('Permission Check Failed', err.message || 'Please try again.');
    }
  };

  const closePermissionModal = () => {
    setPermissionModal({
      isOpen: false,
      status: 'None',
      log: null,
      taskItem: null,
      loading: false,
      mode: 'log',
      chamber: null,
      nextType: null,
      oldType: null,
      remark: '',
      oldName: null,
      newName: null
    });
  };

  const handleRequestEditPermission = async () => {
    const mode = permissionModal.mode || 'log';

    if (mode === 'chamber_type' || mode === 'chamber_setup') {
      const remark = String(permissionModal.remark || '').trim();
      if (!remark) {
        Alert.alert('Remark required', 'Please enter a remark to request these chamber changes.');
        return;
      }
      const chamber = permissionModal.chamber;
      const nextType = permissionModal.nextType;
      const oldType = permissionModal.oldType;
      closePermissionModal();
      if (chamberEditDraft && Number(chamberEditDraft.chamberId) === Number(chamber?.id)) {
        await applyChamberEditDraft(remark);
        return;
      }
      if (mode === 'chamber_type') {
        await requestChamberTypePermission(chamber, nextType, oldType, remark);
      }
      return;
    }

    if (mode === 'client_rename') {
      const remark = String(permissionModal.remark || '').trim();
      if (!remark) {
        Alert.alert('Remark required', 'Please add a remark for this client edit.');
        return;
      }
      const chamber = permissionModal.chamber;
      const oldName = permissionModal.oldName;
      const newName = permissionModal.newName;
      closePermissionModal();
      setEditingClientName(null);
      setEditClientDraft('');
      await requestClientMasterPermission({
        chamber,
        action: 'edit',
        clientName: oldName,
        newName,
        remark
      });
      return;
    }

    if (mode === 'client_add') {
      const remark = String(permissionModal.remark || '').trim();
      if (!remark) {
        Alert.alert('Remark required', 'Please add a remark for this client add.');
        return;
      }
      const chamber = permissionModal.chamber;
      const clientName = permissionModal.pendingClientName;
      const clientType = permissionModal.pendingClientType || newClientType;
      closePermissionModal();
      setNewClientInput('');
      setShowClientSuggestions(false);
      const ok = await requestClientMasterPermission({
        chamber,
        action: 'add',
        clientName,
        chamberType: clientType,
        remark
      });
      if (ok) ensureClientInLotMaster(clientName);
      return;
    }

    if (mode === 'chamber_edit') {
      const remark = String(permissionModal.remark || '').trim();
      if (!remark) {
        Alert.alert('Remark required', 'Please enter a remark to request edit permission.');
        return;
      }
      const chamber = permissionModal.chamber;
      setPermissionRequestBusy(true);
      await requestChamberEditPermission(chamber, remark);
      setPermissionModal((prev) => ({ ...prev, status: 'Pending', remark: '' }));
      setPermissionRequestBusy(false);
      return;
    }

    const log = permissionModal.log;
    const serverLogId = getServerLogIdForPermission(log);
    if (!log || !serverLogId) return;

    setPermissionRequestBusy(true);
    try {
      const descText =
        `Requested permission to edit Chamber log (Ref: ${log.reference_no || ('ID: ' + serverLogId)})` +
        ` | Client: ${log.client_name || 'N/A'} | Chamber: ${log.chamber_name || 'N/A'}` +
        ` | Shift: ${log.shift || 'N/A'} | Temp: ${log.box_temp ?? 'N/A'}°C` +
        ` | Mobile native app`;

      const res = await fetch(`${apiUrl}/api/permission-requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        },
        body: JSON.stringify({
          record_type: 'Chamber',
          record_id: serverLogId,
          action: 'Edit',
          description: descText
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || 'Failed to request permission.');
      }

      setPermissionModal(prev => ({ ...prev, status: 'Pending' }));
      try {
        const listRes = await fetch(`${apiUrl}/api/permission-requests?_=${Date.now()}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
        });
        if (listRes.ok) {
          const listData = await listRes.json().catch(() => []);
          if (Array.isArray(listData)) setPermissionNotifications(listData);
        }
      } catch (e) {
        /* ignore */
      }
      Alert.alert(
        'Request Sent',
        'Edit permission request sent to Super Admin. When approved, a message will appear on the notification bell.'
      );
    } catch (err) {
      Alert.alert('Request Failed', err.message || 'Could not send permission request.');
    } finally {
      setPermissionRequestBusy(false);
    }
  };

  const handleOpenChamberLogFormDirect = (chamber) => {
    if (!chamber) return;

    const masterClients = getClientsForChamber(chamber.id);
    if (masterClients.length === 0) {
      Alert.alert(
        'Add Clients First',
        `No clients are assigned to "${chamber.name}". Add them in Master Setup.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Master Setup', onPress: () => openMasterSetupAddClients(chamber) }
        ]
      );
      return;
    }

    const todayStr = getLocalDateStr();
    const target = getChamberClientTarget(chamber.id);
    const done = countLoggedClientsForChamber(chamber.id, activeShift, todayStr);
    if (target != null && done >= target) {
      Alert.alert('Chamber Completed', `All ${target} client(s) already logged for this chamber.`);
      return;
    }
    
    const unloggedClient =
      masterClients.find(item => !isClientCompletedToday(chamber.id, item.client_name)) ||
      masterClients[0];
    
    setSelectedChamber(chamber);
    setSelectedClient(unloggedClient.client_name);
    setTempInput('');
    setBoxCountInput('');
    setCapturedImage(null);
    setCapturedImageTimestamp(null);
    setSelectedChamberType(getChamberTypeAndDefault(chamber.id).type);
    setIsProfileEditable(true);
    setOpenedFromFab(false);
    setEditingExistingLog(null);
    setShowClientDropdown(false);
    setShowLogModal(true);
  };

  // Opens Log Form when selected chamber is active
  const handleOpenChamberLogForm = () => {
    if (!selectedChamber) return;
    
    const chamberClients = assignments.filter(item => item.chamber_id === selectedChamber.id);
    const unloggedClient = chamberClients.find(item => !isClientCompletedToday(selectedChamber.id, item.client_name));
    
    if (!unloggedClient) {
      Alert.alert('Chamber Completed', 'All clients in this chamber have already been logged today.');
      return;
    }
    
    setSelectedClient(unloggedClient.client_name);
    setTempInput('');
    setBoxCountInput('');
    setCapturedImage(null);
    setCapturedImageTimestamp(null);
    setSelectedChamberType(getChamberTypeAndDefault(selectedChamber.id).type);
    setIsProfileEditable(true);
    setOpenedFromFab(false);
    setShowClientDropdown(false);
    setShowLogModal(true);
  };

  // ==========================================
  // VIEW RENDERERS
  // ==========================================

  // A. DASHBOARD VIEW
  const renderDashboardView = () => {
    const alertCount = completedLogs.filter(log => {
      const pattern = getChamberTypeAndDefault(log.chamber_id);
      if (pattern.type === 'Frozen') return log.box_temp > -18;
      if (pattern.type === 'Chilled' && (log.box_temp < -5 || log.box_temp > 5)) return true;
      if (pattern.type === 'Plus' && log.box_temp <= 0) return true;
      return false;
    }).length;

    return (
      <ScrollView 
        contentContainerStyle={styles.scrollContainer} 
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={["#003580"]} />
        }
      >
        {/* Welcome Greeting Banner */}
        <View style={styles.welcomeCard}>
          <View style={styles.welcomeInfo}>
            <Text style={styles.welcomeText}>Welcome, {displayName}</Text>
            <Text style={styles.roleText}>Operator</Text>
            
            <View style={styles.warehouseRow}>
              <Ionicons name="business-outline" size={16} color="#93c5fd" />
              <Text style={styles.warehouseText}>Warehouse: {user.warehouse_name || 'Generic'}</Text>
            </View>
          </View>
          
          {/* Calendar Widget Card */}
          <View style={styles.dateContainer}>
            <Text style={styles.dateText}>{currentDateStr || '01 Aug 2026'}</Text>
            <View style={styles.dateSub}>
              <Ionicons name="calendar-outline" size={12} color="#64748b" style={{ marginRight: 4 }} />
              <Text style={styles.dayText}>{currentDayStr || 'Saturday'}</Text>
            </View>
            <Text style={styles.timeText}>{currentTime || '01:39 PM'}</Text>
          </View>
        </View>

        {/* Offline Queue Indicator */}
        {unsyncedLogs.length > 0 && (
          <View style={styles.offlineAlertCard}>
            <Ionicons name="cloud-offline-outline" size={24} color="#ea580c" />
            <View style={styles.offlineAlertTextContainer}>
              <Text style={styles.offlineAlertTitle}>Offline Queue ({unsyncedLogs.length} logs)</Text>
              <Text style={styles.offlineAlertSubtitle}>Inspection logs queued locally on SQLite.</Text>
            </View>
            <TouchableOpacity 
              style={styles.syncBtn}
              onPress={() => triggerSync(apiUrl, token, handleSyncProgress, user)}
            >
              <Text style={styles.syncBtnText}>Upload Queue</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Today's Tasks Shift Selector */}
        <View style={{ paddingHorizontal: 15, marginBottom: 15 }}>
          <Text style={{ fontSize: 11, fontWeight: '800', color: '#64748b', textTransform: 'uppercase', marginBottom: 8, letterSpacing: 0.5 }}>
            Today's Tasks
          </Text>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            {/* Morning Shift Card */}
            {(() => {
              const showMorningRed = activeShift !== 'Morning' && !morningClicked && !isMorningCompleted;
              return (
                <TouchableOpacity
                  style={{
                    flex: 1,
                    backgroundColor: isMorningCompleted
                      ? '#f0fdf4'
                      : (activeShift === 'Morning' ? '#fffbeb' : '#ffffff'),
                    borderColor: isMorningCompleted
                      ? '#86efac'
                      : (activeShift === 'Morning' ? '#eab308' : '#e2e8f0'),
                    borderWidth: activeShift === 'Morning' || isMorningCompleted ? 1.5 : 1,
                    borderRadius: 8,
                    padding: 8,
                    alignItems: 'center',
                    flexDirection: 'row',
                    marginRight: 4,
                    elevation: 1,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: 0.05,
                    shadowRadius: 2,
                  }}
                  activeOpacity={0.8}
                  onPress={() => handleSelectShift('Morning')}
                >
                  <View style={{
                    width: 26,
                    height: 26,
                    borderRadius: 13,
                    backgroundColor: isMorningCompleted
                      ? '#16a34a'
                      : (activeShift === 'Morning' ? '#eab308' : '#f1f5f9'),
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: 6
                  }}>
                    <Ionicons
                      name={isMorningCompleted ? 'checkmark' : 'sunny'}
                      size={13}
                      color={isMorningCompleted || activeShift === 'Morning' ? '#ffffff' : '#475569'}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ 
                      fontSize: 11.5, 
                      fontWeight: showMorningRed ? '900' : '800', 
                      color: isMorningCompleted
                        ? '#15803d'
                        : (showMorningRed ? '#ef4444' : (activeShift === 'Morning' ? '#ca8a04' : '#334155'))
                    }}>
                      Morning Task
                    </Text>
                    <Text style={{
                      fontSize: 8.5,
                      color: isMorningCompleted ? '#16a34a' : (activeShift === 'Morning' ? '#ca8a04' : '#64748b'),
                      fontWeight: '700',
                      marginTop: 0.5,
                      opacity: isMorningCompleted ? 1 : 0.85
                    }}>
                      {isMorningCompleted ? 'Completed' : 'Morning Slot'}
                    </Text>
                  </View>
                  {isMorningCompleted ? (
                    <Ionicons name="checkmark-circle" size={22} color="#16a34a" />
                  ) : null}
                </TouchableOpacity>
              );
            })()}

            {/* Evening Shift Card */}
            {(() => {
              const isEveningUnlocked = new Date().getHours() >= 16;
              const showEveningRed = activeShift !== 'Evening' && isEveningUnlocked && !eveningClicked && !isEveningCompleted;
              return (
                <TouchableOpacity
                  style={{
                    flex: 1,
                    backgroundColor: isEveningCompleted
                      ? '#f0fdf4'
                      : (activeShift === 'Evening' ? '#eff6ff' : (isEveningUnlocked ? '#ffffff' : '#f8fafc')),
                    borderColor: isEveningCompleted
                      ? '#86efac'
                      : (activeShift === 'Evening' ? '#2563eb' : '#e2e8f0'),
                    borderWidth: activeShift === 'Evening' || isEveningCompleted ? 1.5 : 1,
                    borderRadius: 8,
                    padding: 8,
                    alignItems: 'center',
                    flexDirection: 'row',
                    marginLeft: 4,
                    opacity: isEveningUnlocked || isEveningCompleted ? 1 : 0.7,
                    elevation: 1,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: 0.05,
                    shadowRadius: 2,
                  }}
                  disabled={!isEveningUnlocked && !isEveningCompleted}
                  activeOpacity={0.8}
                  onPress={() => handleSelectShift('Evening')}
                >
                  <View style={{
                    width: 26,
                    height: 26,
                    borderRadius: 13,
                    backgroundColor: isEveningCompleted
                      ? '#16a34a'
                      : (activeShift === 'Evening' ? '#2563eb' : '#f1f5f9'),
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: 6
                  }}>
                    <Ionicons 
                      name={
                        isEveningCompleted
                          ? 'checkmark'
                          : (isEveningUnlocked ? 'moon' : 'lock-closed')
                      }
                      size={13} 
                      color={isEveningCompleted || activeShift === 'Evening' ? '#ffffff' : '#475569'} 
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ 
                      fontSize: 11.5, 
                      fontWeight: showEveningRed ? '900' : '800', 
                      color: isEveningCompleted
                        ? '#15803d'
                        : (showEveningRed ? '#ef4444' : (activeShift === 'Evening' ? '#1e3a8a' : '#334155'))
                    }}>
                      Evening Task
                    </Text>
                    <Text style={{
                      fontSize: 8.5,
                      color: isEveningCompleted ? '#16a34a' : '#64748b',
                      fontWeight: '700',
                      marginTop: 0.5
                    }}>
                      {isEveningCompleted
                        ? 'Completed'
                        : (isEveningUnlocked ? 'Evening Slot' : 'Available after 4:00 PM')}
                    </Text>
                  </View>
                  {isEveningCompleted ? (
                    <Ionicons name="checkmark-circle" size={22} color="#16a34a" />
                  ) : null}
                </TouchableOpacity>
              );
            })()}
          </View>
        </View>

        {/* Horizontal scroll metrics ribbon */}
        <View style={styles.metricsContainer}>
          <View style={styles.metricsHeaderRow}>
            <Text style={styles.metricsTitle}>Inspection Status & Tasks</Text>
            <TouchableOpacity onPress={() => handleNavTabChange('Tasks')}>
              <Text style={styles.viewAllText}>View All</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.metricsRow}>
            {/* 0. All Tasks Card — chamber count */}
            <TouchableOpacity 
              style={[
                styles.metricCard, 
                { backgroundColor: '#eff6ff', borderColor: '#dbeafe' },
                activeTab === 'All' && styles.metricCardActive
              ]}
              activeOpacity={0.8}
              onPress={() => setActiveTab('All')}
            >
              <View style={[styles.metricIconCircle, { backgroundColor: '#dbeafe' }]}>
                <Ionicons name="list" size={18} color="#2563eb" />
              </View>
              <Text style={[styles.metricValue, { color: '#2563eb' }]}>
                {chambersList.length}
              </Text>
              <Text style={styles.metricLabel}>All Tasks</Text>
              <Text style={styles.metricSubtitle}>Chambers</Text>
            </TouchableOpacity>

            {/* 2. Pending Tasks Card — pending chambers */}
            <TouchableOpacity 
              style={[
                styles.metricCard, 
                { backgroundColor: '#fffbeb', borderColor: '#fef3c7' },
                activeTab === 'Pending' && styles.metricCardActive
              ]}
              activeOpacity={0.8}
              onPress={() => setActiveTab(activeTab === 'Pending' ? 'All' : 'Pending')}
            >
              <View style={[styles.metricIconCircle, { backgroundColor: '#fef3c7' }]}>
                <Ionicons name="document-text" size={18} color="#d97706" />
              </View>
              <Text style={[styles.metricValue, { color: '#d97706' }]}>
                {Math.max(0, chambersList.length - completedChambersCount)}
              </Text>
              <Text style={styles.metricLabel}>Pending</Text>
              <Text style={styles.metricSubtitle}>Chambers</Text>
            </TouchableOpacity>

            {/* 3. Completed Card — completed chambers */}
            <TouchableOpacity 
              style={[
                styles.metricCard, 
                { backgroundColor: '#f0fdf4', borderColor: '#dcfce7' },
                activeTab === 'Completed' && styles.metricCardActive
              ]}
              activeOpacity={0.8}
              onPress={() => setActiveTab(activeTab === 'Completed' ? 'All' : 'Completed')}
            >
              <View style={[styles.metricIconCircle, { backgroundColor: '#dcfce7' }]}>
                <Ionicons name="checkmark-circle" size={18} color="#16a34a" />
              </View>
              <Text style={[styles.metricValue, { color: '#16a34a' }]}>
                {completedChambersCount}
              </Text>
              <Text style={styles.metricLabel}>Completed</Text>
              <Text style={styles.metricSubtitle}>Chambers</Text>
            </TouchableOpacity>

            {/* 4. Overdue — unique overdue chambers */}
            <TouchableOpacity 
              style={[
                styles.metricCard, 
                { backgroundColor: '#f8fafc', borderColor: '#e2e8f0' },
                activeTab === 'Overdue' && styles.metricCardActive
              ]}
              activeOpacity={0.8}
              onPress={() => setActiveTab(activeTab === 'Overdue' ? 'All' : 'Overdue')}
            >
              <View style={[styles.metricIconCircle, { backgroundColor: '#e2e8f0' }]}>
                <Ionicons name="time" size={18} color="#64748b" />
              </View>
              <Text style={[styles.metricValue, { color: '#64748b' }]}>
                {new Set(overdueTasks.map((t) => Number(t.chamber_id))).size}
              </Text>
              <Text style={styles.metricLabel}>Overdue</Text>
              <Text style={styles.metricSubtitle}>Chambers</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* 2-column chambers grid view */}
        <View style={styles.metricsHeaderRow}>
          <Text style={styles.metricsTitle}>Chamber Overview ({chambersList.length} Chambers)</Text>
          <TouchableOpacity onPress={() => handleNavTabChange('Tasks')}>
            <Text style={styles.viewAllText}>View All</Text>
          </TouchableOpacity>
        </View>

        {(() => {
          const emptyClientChambers = chambersList.filter(
            (c) => getClientsForChamber(c.id).length === 0
          );
          if (chambersList.length === 0 || emptyClientChambers.length === 0) return null;
          const allEmpty = emptyClientChambers.length === chambersList.length;
          return (
            <TouchableOpacity
              style={styles.setupClientsBanner}
              onPress={() => openMasterSetupAddClients(emptyClientChambers[0])}
              activeOpacity={0.88}
            >
              <View style={styles.setupClientsBannerIcon}>
                <Ionicons name="people-outline" size={20} color="#0369a1" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.setupClientsBannerTitle}>
                  {allEmpty ? 'Add clients to start tasks' : 'Some chambers need clients'}
                </Text>
                <Text style={styles.setupClientsBannerSub}>
                  {allEmpty
                    ? 'No clients are configured yet. Open Master Setup → Clients to add them.'
                    : `${emptyClientChambers.length} chamber(s) have no clients — tap to add.`}
                </Text>
              </View>
              <Text style={styles.setupClientsBannerCta}>Add ➔</Text>
            </TouchableOpacity>
          );
        })()}

        <View style={styles.chambersGrid}>
          {getFilteredChambers().length === 0 ? (
            <View style={styles.emptyGridPlaceholder}>
              <Ionicons name="apps-outline" size={32} color="#94a3b8" />
              <Text style={styles.emptyGridText}>No chambers found matching "{activeTab}" filter.</Text>
            </View>
          ) : (
            getFilteredChambers().map((chamber) => {
              const details = getChamberDetails(chamber);
              const todayStr = getLocalDateStr();
              const target = getChamberClientTarget(chamber.id);
              const doneCount = countLoggedClientsForChamber(chamber.id, activeShift, todayStr);
              const isDone = target != null && doneCount >= target;
              const clientCount = getClientsForChamber(chamber.id).length;
              const needsClients = clientCount === 0;

              return (
                <TouchableOpacity
                  key={chamber.id}
                  style={[
                    styles.chamberCard, 
                    details.hasAlert && styles.chamberCardAlertBorder,
                    needsClients && styles.chamberCardNeedsClients
                  ]}
                  onPress={() => {
                    if (needsClients) {
                      openMasterSetupAddClients(chamber);
                      return;
                    }
                    handleOpenChamberLogFormDirect(chamber);
                  }}
                >
                  {/* Left: Chamber details */}
                  <View style={{ flex: 1, alignItems: 'flex-start' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                      <Ionicons name={details.icon} size={14} color={details.pillColor} style={{ marginRight: 6 }} />
                      <Text style={{ fontSize: 13, fontWeight: 'bold', color: '#1e293b' }}>{chamber.name}</Text>
                    </View>
                    <View style={[styles.typePill, { backgroundColor: details.pillBg, marginVertical: 0 }]}>
                      <Text style={[styles.typePillText, { color: details.pillColor }]}>{details.type}</Text>
                    </View>
                    <Text style={{
                      fontSize: 10,
                      fontWeight: '700',
                      color: needsClients ? '#0369a1' : '#64748b',
                      marginTop: 6
                    }}>
                      {needsClients ? 'No clients · Tap to add' : `${clientCount} client${clientCount === 1 ? '' : 's'}`}
                    </Text>
                  </View>

                  {/* Right: Status */}
                  <View style={{ alignItems: 'flex-end', justifyContent: 'center' }}>
                    {needsClients ? (
                      <View style={styles.addClientChip}>
                        <Text style={styles.addClientChipText}>Add</Text>
                      </View>
                    ) : (
                      <View style={[styles.statusIndicatorRow, { marginTop: 0 }]}>
                        <View style={[styles.statusDot, { backgroundColor: isDone ? '#16a34a' : details.statusColor }]} />
                        <Text style={[styles.statusText, { color: isDone ? '#16a34a' : details.statusColor, fontSize: 11 }]}>
                          {isDone ? 'Done' : 'Pending'}
                        </Text>
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </View>

        <View style={{ height: 90 }} />
      </ScrollView>
    );
  };

  // B. TASKS TAB VIEW  (Reports tab reuses this with completedOnly)
  const renderTasksView = (options = {}) => {
    const completedOnly = options.completedOnly === true;
    const listTab = completedOnly ? 'Completed' : activeTab;
    const taskRows = getTasksScreenList(listTab);

    return (
      <View style={styles.tabContainer}>
        {/* Top Filters — Reports tab only lists completed tasks */}
        {!completedOnly ? (
        <View style={styles.filterTabsRow}>
          {['All', 'Pending', 'Completed', 'Overdue'].map((tab) => {
            const count = getTasksScreenList(tab).length;
            const isActive = activeTab === tab;
            return (
              <TouchableOpacity
                key={tab}
                style={[styles.filterTabButton, isActive && styles.filterTabButtonActive]}
                onPress={() => setActiveTab(tab)}
                activeOpacity={0.85}
              >
                <Text
                  style={[styles.filterTabButtonText, isActive && styles.filterTabButtonTextActive]}
                  numberOfLines={1}
                >
                  {tab}
                </Text>
                <Text
                  style={[styles.filterTabButtonCount, isActive && styles.filterTabButtonCountActive]}
                  numberOfLines={1}
                >
                  {count}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        ) : (
        <View style={styles.tasksInfoBanner}>
          <Text style={styles.tasksInfoTitle}>Completed tasks</Text>
          <Text style={styles.tasksInfoText}>
            Submitted Morning / Evening logs appear here as soon as each client task is completed.
          </Text>
        </View>
        )}

        {/* Chamber & Client Filters — bottom sheet (same as DO profile / Daily Reports) */}
        {(() => {
          const chamberFilterOn = taskChamberFilter !== 'All';
          const clientFilterOn = taskClientFilter !== 'All';
          const filtersActive = chamberFilterOn || clientFilterOn;
          const chamberLabel = chamberFilterOn
            ? chambersList.find((c) => Number(c.id) === Number(taskChamberFilter))?.name || 'Chamber'
            : 'All Chambers';
          const clientLabel = clientFilterOn ? taskClientFilter : 'All Clients';
          const pickerQ = String(taskPickerQuery || '').trim().toLowerCase();
          const pickerChamberOptions = (chambersList || []).filter((ch) =>
            pickerQ ? String(ch.name || '').toLowerCase().includes(pickerQ) : true
          );
          const allTaskClients =
            taskChamberFilter === 'All'
              ? Array.from(new Set(assignments.map((a) => a.client_name).filter(Boolean)))
              : Array.from(
                  new Set(
                    assignments
                      .filter((a) => Number(a.chamber_id) === Number(taskChamberFilter))
                      .map((a) => a.client_name)
                      .filter(Boolean)
                  )
                );
          const pickerClientOptions = allTaskClients
            .filter((name) => (pickerQ ? String(name).toLowerCase().includes(pickerQ) : true))
            .sort((a, b) => String(a).localeCompare(String(b)));

          return (
            <>
              <View
                style={[
                  styles.reportListFilterRow,
                  {
                    marginTop: 0,
                    paddingHorizontal: 15,
                    paddingVertical: 10,
                    backgroundColor: '#ffffff',
                    borderBottomWidth: 1,
                    borderBottomColor: '#cbd5e1',
                  },
                ]}
              >
                <TouchableOpacity
                  style={[styles.doFilterChip, chamberFilterOn && styles.doFilterChipActive]}
                  onPress={() => {
                    setTaskPickerQuery('');
                    setTaskOpenFilter(taskOpenFilter === 'chamber' ? null : 'chamber');
                  }}
                  activeOpacity={0.85}
                >
                  <Text style={styles.doFilterChipLabel}>Chamber</Text>
                  <Text style={styles.doFilterChipValue} numberOfLines={1}>
                    {chamberLabel}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.doFilterChip, clientFilterOn && styles.doFilterChipActive]}
                  onPress={() => {
                    setTaskPickerQuery('');
                    setTaskOpenFilter(taskOpenFilter === 'client' ? null : 'client');
                  }}
                  activeOpacity={0.85}
                >
                  <Text style={styles.doFilterChipLabel}>Client</Text>
                  <Text style={styles.doFilterChipValue} numberOfLines={1}>
                    {clientLabel}
                  </Text>
                </TouchableOpacity>
                {filtersActive ? (
                  <TouchableOpacity
                    style={styles.reportListClearBtn}
                    onPress={() => {
                      setTaskChamberFilter('All');
                      setTaskClientFilter('All');
                      setTaskOpenFilter(null);
                      setTaskPickerQuery('');
                    }}
                    activeOpacity={0.85}
                  >
                    <Ionicons name="close" size={14} color="#dc2626" />
                  </TouchableOpacity>
                ) : null}
              </View>

              <Modal
                visible={!!taskOpenFilter}
                transparent
                animationType="slide"
                onRequestClose={() => {
                  setTaskOpenFilter(null);
                  setTaskPickerQuery('');
                }}
              >
                <View style={styles.reportFilterModalOverlay}>
                  <TouchableOpacity
                    style={StyleSheet.absoluteFill}
                    activeOpacity={1}
                    onPress={() => {
                      setTaskOpenFilter(null);
                      setTaskPickerQuery('');
                    }}
                  />
                  <View style={styles.reportFilterModalSheet}>
                    <Text style={styles.reportFilterModalTitle}>
                      {taskOpenFilter === 'client' ? 'Filter client' : 'Filter chamber'}
                    </Text>
                    <View style={styles.reportListSearchWrap}>
                      <Ionicons name="search" size={14} color="#94a3b8" />
                      <TextInput
                        style={styles.reportListSearchInput}
                        value={taskPickerQuery}
                        onChangeText={setTaskPickerQuery}
                        placeholder={
                          taskOpenFilter === 'client' ? 'Search client...' : 'Search chamber...'
                        }
                        placeholderTextColor="#94a3b8"
                        autoCorrect={false}
                        autoCapitalize="none"
                      />
                    </View>
                    <ScrollView
                      style={styles.reportFilterModalScroll}
                      keyboardShouldPersistTaps="handled"
                      nestedScrollEnabled
                      showsVerticalScrollIndicator
                    >
                      {taskOpenFilter === 'chamber' ? (
                        <>
                          <TouchableOpacity
                            style={styles.reportFilterOption}
                            onPress={() => {
                              setTaskChamberFilter('All');
                              setTaskClientFilter('All');
                              setTaskOpenFilter(null);
                              setTaskPickerQuery('');
                            }}
                          >
                            <Text style={styles.reportFilterOptionText}>All Chambers</Text>
                            {!chamberFilterOn ? (
                              <Ionicons name="checkmark" size={16} color="#003580" />
                            ) : null}
                          </TouchableOpacity>
                          {pickerChamberOptions.length === 0 ? (
                            <Text style={styles.reportFilterModalEmpty}>No chambers found.</Text>
                          ) : (
                            pickerChamberOptions.map((ch) => (
                              <TouchableOpacity
                                key={`task-pick-ch-${ch.id}`}
                                style={styles.reportFilterOption}
                                onPress={() => {
                                  setTaskChamberFilter(ch.id);
                                  setTaskClientFilter('All');
                                  setTaskOpenFilter(null);
                                  setTaskPickerQuery('');
                                }}
                              >
                                <Text style={styles.reportFilterOptionText} numberOfLines={1}>
                                  {ch.name}
                                </Text>
                                {String(taskChamberFilter) === String(ch.id) ? (
                                  <Ionicons name="checkmark" size={16} color="#003580" />
                                ) : null}
                              </TouchableOpacity>
                            ))
                          )}
                        </>
                      ) : (
                        <>
                          <TouchableOpacity
                            style={styles.reportFilterOption}
                            onPress={() => {
                              setTaskClientFilter('All');
                              setTaskOpenFilter(null);
                              setTaskPickerQuery('');
                            }}
                          >
                            <Text style={styles.reportFilterOptionText}>All Clients</Text>
                            {!clientFilterOn ? (
                              <Ionicons name="checkmark" size={16} color="#003580" />
                            ) : null}
                          </TouchableOpacity>
                          {pickerClientOptions.length === 0 ? (
                            <Text style={styles.reportFilterModalEmpty}>No clients found.</Text>
                          ) : (
                            pickerClientOptions.map((name) => (
                              <TouchableOpacity
                                key={`task-pick-cl-${name}`}
                                style={styles.reportFilterOption}
                                onPress={() => {
                                  setTaskClientFilter(name);
                                  setTaskOpenFilter(null);
                                  setTaskPickerQuery('');
                                }}
                              >
                                <Text style={styles.reportFilterOptionText} numberOfLines={1}>
                                  {name}
                                </Text>
                                {taskClientFilter === name ? (
                                  <Ionicons name="checkmark" size={16} color="#003580" />
                                ) : null}
                              </TouchableOpacity>
                            ))
                          )}
                        </>
                      )}
                    </ScrollView>
                    <TouchableOpacity
                      style={styles.reportFilterModalClose}
                      onPress={() => {
                        setTaskOpenFilter(null);
                        setTaskPickerQuery('');
                      }}
                      activeOpacity={0.85}
                    >
                      <Text style={styles.reportFilterModalCloseText}>Close</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </Modal>
            </>
          );
        })()}

        {/* Tab Caption Info Box */}
        {!completedOnly ? (
        <View style={styles.tasksInfoBanner}>
          <Text style={styles.tasksInfoTitle}>{activeTab} tasks</Text>
          <Text style={styles.tasksInfoText}>
            {activeTab === 'All' && 'Chamber tasks with total client lots. Stays Pending until every client is logged.'}
            {activeTab === 'Pending' && 'Select each client lot and submit. Chamber stays here until all clients are done.'}
            {activeTab === 'Completed' && 'Client-wise completed logs (only after each client submit).'}
            {activeTab === 'Overdue' && 'Missed chamber audits from the past 2 days.'}
          </Text>
        </View>
        ) : null}

        <ScrollView 
          contentContainerStyle={{ paddingHorizontal: 15, paddingTop: 10, paddingBottom: 100 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={["#003580"]} />
          }
        >
          {taskRows.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="clipboard-outline" size={44} color="#94a3b8" />
              <Text style={styles.emptyText}>
                {completedOnly
                  ? 'No completed tasks yet. Submit a log from Tasks to see it here.'
                  : `No tasks found in "${activeTab}" filter.`}
              </Text>
            </View>
          ) : (
            taskRows.map((item, idx) => {
              const isChamberRow = !!item.is_chamber_task;
              const targetDate = item.due_date || getLocalDateStr();
              const targetShiftName = item.shift_time === '10:00' ? 'Morning' : 'Evening';

              const log = isChamberRow || item.is_overdue
                ? null
                : findShiftLog(
                    item.chamber_id,
                    item.client_name,
                    targetDate,
                    targetShiftName,
                    item.chamber_name
                  ) || (item.box_temp != null ? item : null);

              const isCompleted = listTab === 'Completed'
                ? true
                : (isChamberRow ? !!item.is_completed : !!log);
              const pattern = getChamberTypeAndDefault(item.chamber_id, item.client_name);
              
              let hasWarning = false;
              if (log) {
                const checkType = log.chamber_type || pattern.type;
                if (checkType === 'Frozen' && log.box_temp > -18) hasWarning = true;
                if (checkType === 'Chilled' && (log.box_temp < -5 || log.box_temp > 5)) hasWarning = true;
                if (checkType === 'Dry' && (log.box_temp < 15 || log.box_temp > 25)) hasWarning = true;
              }

              const statusLabel = isCompleted
                ? 'Done'
                : (item.is_overdue ? 'Overdue' : 'Pending');

              const shiftLabel =
                item.shift_label || (item.shift_time === '10:00' ? 'Morning' : 'Evening');
              const isEveningShift =
                item.shift_time === '16:00' || /evening/i.test(String(shiftLabel));
              const shiftColor = isEveningShift ? '#2563eb' : '#ca8a04'; // Evening blue · Morning yellow (dashboard match)

              const titleText = isChamberRow
                ? (item.chamber_name || `Chamber ${item.chamber_id}`)
                : (item.client_name || 'Client');

              const prefixMeta = isChamberRow
                ? (item.is_overdue && item.due_date ? `Due ${item.due_date}` : null)
                : (item.chamber_name || null);

              return (
                <View
                  key={
                    isChamberRow
                      ? `ch_${item.chamber_id}_${item.shift_time || 'na'}_${item.due_date || 'today'}_${idx}`
                      : `${item.chamber_id}_${item.client_name}_${item.shift_time || 'na'}_${idx}`
                  }
                  style={[
                    styles.taskItemCard,
                    isCompleted && styles.taskItemCardCompleted,
                    item.is_overdue && !isCompleted && styles.taskItemCardOverdue
                  ]}
                >
                  <View
                    style={[
                      styles.taskCardAccent,
                      isCompleted
                        ? styles.taskCardAccentDone
                        : item.is_overdue
                          ? styles.taskCardAccentOverdue
                          : styles.taskCardAccentPending
                    ]}
                  />

                  <View style={[styles.taskCardBody, isChamberRow && { alignItems: 'flex-start' }]}>
                    {/* Card body is display-only — All / Pending / Completed: only Record Log or Edit buttons act */}
                    <View style={styles.taskCardMain} pointerEvents="none">
                      <Text style={styles.taskClientName} numberOfLines={1}>
                        {titleText}
                      </Text>

                      <Text style={styles.taskMetaLine} numberOfLines={1}>
                        {prefixMeta ? `${prefixMeta}  ·  ` : ''}
                        <Text style={{ color: shiftColor, fontWeight: '800' }}>{shiftLabel}</Text>
                      </Text>

                      {isChamberRow && item.target_set ? (
                        <Text style={{ fontSize: 11, fontWeight: '600', color: '#64748b', marginTop: 4 }}>
                          Logged {Number(item.clients_done) || 0}/{Number(item.clients_total) || 0} clients
                        </Text>
                      ) : null}

                      {item.is_overdue && !isChamberRow ? (
                        <Text style={styles.taskOverdueDateText}>
                          Due {item.due_date}
                        </Text>
                      ) : null}

                      {isCompleted && log && !isChamberRow ? (
                        <View style={styles.taskReadingRow}>
                          <Text style={[styles.readingLoggedText, hasWarning && { color: '#64748b' }]}>
                            {log.box_temp}°C
                          </Text>
                          <Text style={styles.taskLoggedTime}>
                            {log.inspection_time || item.shift_label || ''}
                          </Text>
                        </View>
                      ) : null}
                    </View>

                    <View style={styles.taskCardActions}>
                      <Text
                        style={[
                          styles.taskStatusLabel,
                          isCompleted
                            ? styles.taskStatusDone
                            : item.is_overdue
                              ? styles.taskStatusOverdue
                              : styles.taskStatusPending
                        ]}
                      >
                        {statusLabel}
                      </Text>
                      {!isCompleted ? (
                        <TouchableOpacity
                          style={styles.logActionBtn}
                          onPress={() => {
                            if (isChamberRow) {
                              const chamber =
                                chambersList.find((c) => Number(c.id) === Number(item.chamber_id)) || {
                                  id: item.chamber_id,
                                  name: item.chamber_name
                                };
                              if (item.shift_time === '16:00') handleSelectShift('Evening');
                              else handleSelectShift('Morning');
                              handleOpenChamberLogFormDirect(chamber);
                            } else {
                              handleOpenTaskLogForm(item);
                            }
                          }}
                          activeOpacity={0.85}
                        >
                          <Ionicons name="thermometer-outline" size={14} color="#ffffff" style={{ marginRight: 4 }} />
                          <Text style={styles.logActionBtnText}>Record Log</Text>
                        </TouchableOpacity>
                      ) : (
                        <TouchableOpacity
                          style={styles.logActionBtn}
                          onPress={() => {
                            if (isChamberRow) {
                              const targetDate = item.due_date || getLocalDateStr();
                              const shiftName = item.shift_time === '16:00' ? 'Evening' : 'Morning';
                              const chamberLog = completedLogs.find(
                                (l) =>
                                  logMatchesChamberRef(l, item.chamber_id, item.chamber_name) &&
                                  logOnDate(l, targetDate) &&
                                  resolveLogShiftName(l) === shiftName
                              );
                              if (!chamberLog) {
                                Alert.alert('Edit', 'No completed client logs were found for this chamber.');
                                return;
                              }
                              if (item.shift_time === '16:00') handleSelectShift('Evening');
                              else handleSelectShift('Morning');
                              handleEditCompletedLog({
                                ...item,
                                chamber_id: chamberLog.chamber_id,
                                chamber_name: chamberLog.chamber_name || item.chamber_name,
                                client_name: chamberLog.client_name,
                                shift_time: item.shift_time || (shiftName === 'Evening' ? '16:00' : '10:00'),
                                shift_label: item.shift_label || `${shiftName} Task`
                              });
                            } else {
                              handleEditCompletedLog(item);
                            }
                          }}
                          activeOpacity={0.85}
                        >
                          <Ionicons name="create-outline" size={14} color="#ffffff" style={{ marginRight: 4 }} />
                          <Text style={styles.logActionBtnText}>Edit</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                </View>
              );
            })
          )}
        </ScrollView>
      </View>
    );
  };

  const logMatchesChamber = (log, chamber) =>
    logMatchesChamberRef(log, chamber?.id, chamber?.name);

  const getTodayReportLogs = () => {
    const dateStr = selectedReportDate || getLocalDateStr();
    return getMergedInspectionLogs().filter((log) => logOnDate(log, dateStr));
  };

  const renderDailyReportsView = () => {
    const todayLogs = getTodayReportLogs();
    const drill = reportDrillChamber;
    const todayStr = getLocalDateStr();
    const dateStr = selectedReportDate || todayStr;
    const dateIsToday = dateStr === todayStr;
    const dateLabel = (() => {
      if (dateIsToday) return 'Today';
      const parts = String(dateStr).split('-').map(Number);
      if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return dateStr;
      const dt = new Date(parts[0], parts[1] - 1, parts[2]);
      return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    })();
    const chamberFilterOn =
      dailyReportChamberFilter !== 'all' && dailyReportChamberFilter !== 'All';
    const clientFilterOn =
      dailyReportClientFilter !== 'All' && dailyReportClientFilter !== 'all';
    const filtersActive = (!drill && chamberFilterOn) || clientFilterOn || !dateIsToday;

    const sortedChambers = [...(chambersList || [])].sort((a, b) => {
      const na = parseInt((String(a.name || '').match(/\d+/) || [a.id])[0], 10);
      const nb = parseInt((String(b.name || '').match(/\d+/) || [b.id])[0], 10);
      return na - nb;
    });

    const clientsForChamber = (chamber) => {
      const fromLogs = todayLogs
        .filter((l) => logMatchesChamber(l, chamber))
        .map((l) => String(l.client_name || '').trim());
      const mapped = dateIsToday
        ? getClientsForChamber(chamber?.id).map((c) => String(c.client_name || '').trim())
        : [];
      return Array.from(new Set([...mapped, ...fromLogs].filter(Boolean)));
    };

    const allClientNames = Array.from(
      new Set(sortedChambers.flatMap((ch) => clientsForChamber(ch)))
    ).sort((a, b) => String(a).localeCompare(String(b)));

    const chamberHasClient = (chamber, clientName) =>
      clientsForChamber(chamber).some((name) => namesMatch(name, clientName));

    const filteredChambers = sortedChambers.filter((chamber) => {
      if (chamberFilterOn && Number(chamber.id) !== Number(dailyReportChamberFilter)) return false;
      if (clientFilterOn && !chamberHasClient(chamber, dailyReportClientFilter)) return false;
      if (!dateIsToday && !todayLogs.some((l) => logMatchesChamber(l, chamber))) return false;
      return true;
    });

    const chamberLabel = chamberFilterOn
      ? chambersList.find((c) => Number(c.id) === Number(dailyReportChamberFilter))?.name ||
        drill?.name ||
        'Chamber'
      : 'All Chambers';
    const clientLabel = clientFilterOn ? dailyReportClientFilter : 'All Clients';

    const clearDailyReportFilters = () => {
      setDailyReportClientFilter('All');
      setDailyReportOpenFilter(null);
      setDailyReportPickerQuery('');
      setSelectedReportDate(todayStr);
      setShowDailyReportCalendar(false);
      if (!drill) {
        setDailyReportChamberFilter('all');
      }
    };

    const openDailyReportCalendar = () => {
      const parts = String(dateStr).split('-').map(Number);
      const monthDate =
        parts.length === 3 && !parts.some((n) => Number.isNaN(n))
          ? new Date(parts[0], parts[1] - 1, parts[2])
          : new Date();
      setDailyReportCalendarMonth(monthDate);
      setDailyReportOpenFilter(null);
      setShowDailyReportCalendar(true);
    };

    const openChamberFromList = (chamber) => {
      setDailyReportChamberFilter(chamber.id);
      setDailyReportOpenFilter(null);
      setDailyReportPickerQuery('');
      setReportDrillChamber({ id: chamber.id, name: chamber.name });
    };

    const goBackToChambers = () => {
      setReportDrillChamber(null);
      setDailyReportChamberFilter('all');
      setDailyReportOpenFilter(null);
      setDailyReportPickerQuery('');
    };

    const pickerQ = String(dailyReportPickerQuery || '').trim().toLowerCase();
    const pickerChamberOptions = sortedChambers.filter((ch) =>
      pickerQ ? String(ch.name || '').toLowerCase().includes(pickerQ) : true
    );
    const pickerClientSource = drill
      ? clientsForChamber(chambersList.find((c) => Number(c.id) === Number(drill.id)) || drill)
      : allClientNames;
    const pickerClientOptions = pickerClientSource.filter((name) =>
      pickerQ ? String(name).toLowerCase().includes(pickerQ) : true
    );

    const renderFilterBar = (subtitle) => (
      <View style={styles.reportListHeader}>
        {drill ? (
          <TouchableOpacity
            onPress={goBackToChambers}
            style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}
            activeOpacity={0.8}
          >
            <Ionicons name="chevron-back" size={16} color="#003580" />
            <Text style={{ fontSize: 11, fontWeight: '800', color: '#003580' }}>All Chambers</Text>
            <Text style={{ fontSize: 11, fontWeight: '700', color: '#64748b' }} numberOfLines={1}>
              {'  ·  '}{subtitle}
            </Text>
          </TouchableOpacity>
        ) : (
          <>
            <Text style={styles.reportListHeaderTitle}>Daily Reports</Text>
            <Text style={styles.reportListHeaderSub}>{subtitle}</Text>
          </>
        )}

        <View style={styles.reportListFilterRow}>
          <TouchableOpacity
            style={[styles.doFilterChip, chamberFilterOn && styles.doFilterChipActive]}
            onPress={() => {
              setShowDailyReportCalendar(false);
              setDailyReportPickerQuery('');
              setDailyReportOpenFilter(dailyReportOpenFilter === 'chamber' ? null : 'chamber');
            }}
            activeOpacity={0.85}
          >
            <Text style={styles.doFilterChipLabel}>Chamber</Text>
            <Text style={styles.doFilterChipValue} numberOfLines={1}>
              {chamberLabel}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.doFilterChip, clientFilterOn && styles.doFilterChipActive]}
            onPress={() => {
              setShowDailyReportCalendar(false);
              setDailyReportPickerQuery('');
              setDailyReportOpenFilter(dailyReportOpenFilter === 'client' ? null : 'client');
            }}
            activeOpacity={0.85}
          >
            <Text style={styles.doFilterChipLabel}>Client</Text>
            <Text style={styles.doFilterChipValue} numberOfLines={1}>
              {clientLabel}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.doFilterChip, !dateIsToday && styles.doFilterChipActive]}
            onPress={openDailyReportCalendar}
            activeOpacity={0.85}
          >
            <Text style={styles.doFilterChipLabel}>Date</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Ionicons name="calendar-outline" size={12} color="#003580" />
              <Text style={styles.doFilterChipValue} numberOfLines={1}>
                {dateLabel}
              </Text>
            </View>
          </TouchableOpacity>
          {filtersActive ? (
            <TouchableOpacity
              style={styles.reportListClearBtn}
              onPress={clearDailyReportFilters}
              activeOpacity={0.85}
            >
              <Ionicons name="close" size={14} color="#dc2626" />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );

    const renderFilterModal = () => (
      <Modal
        visible={!!dailyReportOpenFilter}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setDailyReportOpenFilter(null);
          setDailyReportPickerQuery('');
        }}
      >
        <View style={styles.reportFilterModalOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => {
              setDailyReportOpenFilter(null);
              setDailyReportPickerQuery('');
            }}
          />
          <View style={styles.reportFilterModalSheet}>
            <Text style={styles.reportFilterModalTitle}>
              {dailyReportOpenFilter === 'client' ? 'Filter client' : 'Filter chamber'}
            </Text>
            <View style={styles.reportListSearchWrap}>
              <Ionicons name="search" size={14} color="#94a3b8" />
              <TextInput
                style={styles.reportListSearchInput}
                value={dailyReportPickerQuery}
                onChangeText={setDailyReportPickerQuery}
                placeholder={dailyReportOpenFilter === 'client' ? 'Search client...' : 'Search chamber...'}
                placeholderTextColor="#94a3b8"
                autoCorrect={false}
                autoCapitalize="none"
              />
            </View>
            <ScrollView
              style={styles.reportFilterModalScroll}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              showsVerticalScrollIndicator
            >
              {dailyReportOpenFilter === 'chamber' ? (
                <>
                  <TouchableOpacity
                    style={styles.reportFilterOption}
                    onPress={() => {
                      setDailyReportChamberFilter('all');
                      setReportDrillChamber(null);
                      setDailyReportOpenFilter(null);
                      setDailyReportPickerQuery('');
                    }}
                  >
                    <Text style={styles.reportFilterOptionText}>All Chambers</Text>
                    {!chamberFilterOn ? <Ionicons name="checkmark" size={16} color="#003580" /> : null}
                  </TouchableOpacity>
                  {pickerChamberOptions.length === 0 ? (
                    <Text style={styles.reportFilterModalEmpty}>No chambers found.</Text>
                  ) : (
                    pickerChamberOptions.map((ch) => (
                      <TouchableOpacity
                        key={`pick-ch-${ch.id}`}
                        style={styles.reportFilterOption}
                        onPress={() => openChamberFromList(ch)}
                      >
                        <Text style={styles.reportFilterOptionText} numberOfLines={1}>
                          {ch.name}
                        </Text>
                        {String(dailyReportChamberFilter) === String(ch.id) ? (
                          <Ionicons name="checkmark" size={16} color="#003580" />
                        ) : null}
                      </TouchableOpacity>
                    ))
                  )}
                </>
              ) : (
                <>
                  <TouchableOpacity
                    style={styles.reportFilterOption}
                    onPress={() => {
                      setDailyReportClientFilter('All');
                      setDailyReportOpenFilter(null);
                      setDailyReportPickerQuery('');
                    }}
                  >
                    <Text style={styles.reportFilterOptionText}>All Clients</Text>
                    {!clientFilterOn ? <Ionicons name="checkmark" size={16} color="#003580" /> : null}
                  </TouchableOpacity>
                  {pickerClientOptions.length === 0 ? (
                    <Text style={styles.reportFilterModalEmpty}>No clients found.</Text>
                  ) : (
                    pickerClientOptions.map((name) => (
                      <TouchableOpacity
                        key={`pick-cl-${name}`}
                        style={styles.reportFilterOption}
                        onPress={() => {
                          setDailyReportClientFilter(name);
                          setDailyReportOpenFilter(null);
                          setDailyReportPickerQuery('');
                          if (drill) {
                            const current =
                              chambersList.find((c) => Number(c.id) === Number(drill.id)) || drill;
                            if (!chamberHasClient(current, name)) {
                              setReportDrillChamber(null);
                              setDailyReportChamberFilter('all');
                            }
                          }
                        }}
                      >
                        <Text style={styles.reportFilterOptionText} numberOfLines={1}>
                          {name}
                        </Text>
                        {namesMatch(dailyReportClientFilter, name) ? (
                          <Ionicons name="checkmark" size={16} color="#003580" />
                        ) : null}
                      </TouchableOpacity>
                    ))
                  )}
                </>
              )}
            </ScrollView>
            <TouchableOpacity
              style={styles.reportFilterModalClose}
              onPress={() => {
                setDailyReportOpenFilter(null);
                setDailyReportPickerQuery('');
              }}
            >
              <Text style={styles.reportFilterModalCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );

    const renderDailyDateCalendar = () => {
      const days = getCalendarDays(dailyReportCalendarMonth);
      const monthName = dailyReportCalendarMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
      const weekDays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
      return (
        <Modal
          visible={showDailyReportCalendar}
          transparent
          animationType="slide"
          onRequestClose={() => setShowDailyReportCalendar(false)}
        >
          <View style={styles.reportFilterModalOverlay}>
            <TouchableOpacity
              style={StyleSheet.absoluteFill}
              activeOpacity={1}
              onPress={() => setShowDailyReportCalendar(false)}
            />
            <View style={styles.calendarFilterModalSheet}>
              <View style={styles.calendarSheetHandle} />
              <Text style={styles.reportFilterModalTitle}>Select date</Text>
              <Text style={styles.calendarSheetHint}>
                One day only · {dateLabel}
              </Text>
              <View style={styles.calendarSheetMonthRow}>
                <TouchableOpacity
                  onPress={() => {
                    const prev = new Date(dailyReportCalendarMonth);
                    prev.setMonth(prev.getMonth() - 1);
                    setDailyReportCalendarMonth(prev);
                  }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="chevron-back" size={20} color="#003580" />
                </TouchableOpacity>
                <Text style={styles.calendarSheetMonthText}>{monthName}</Text>
                <TouchableOpacity
                  onPress={() => {
                    const next = new Date(dailyReportCalendarMonth);
                    next.setMonth(next.getMonth() + 1);
                    setDailyReportCalendarMonth(next);
                  }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="chevron-forward" size={20} color="#003580" />
                </TouchableOpacity>
              </View>
              <View style={{ flexDirection: 'row', marginBottom: 4 }}>
                {weekDays.map((d, i) => (
                  <Text key={`wd-${i}`} style={styles.calendarSheetWeekDay}>
                    {d}
                  </Text>
                ))}
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {days.map((d, index) => {
                  if (!d) {
                    return <View key={`empty-${index}`} style={styles.calendarSheetDayCell} />;
                  }
                  const cellDate = getLocalDateStr(d);
                  const isSelected = cellDate === dateStr;
                  const isToday = cellDate === todayStr;
                  const isFuture = cellDate > todayStr;
                  return (
                    <TouchableOpacity
                      key={cellDate}
                      disabled={isFuture}
                      onPress={() => {
                        setSelectedReportDate(cellDate);
                        setShowDailyReportCalendar(false);
                      }}
                      style={[
                        styles.calendarSheetDayCell,
                        {
                          borderRadius: 16,
                          backgroundColor: isSelected ? '#003580' : 'transparent',
                          borderWidth: isToday && !isSelected ? 1 : 0,
                          borderColor: '#93c5fd',
                          opacity: isFuture ? 0.3 : 1,
                        },
                      ]}
                    >
                      <Text
                        style={{
                          fontSize: 12,
                          fontWeight: isSelected || isToday ? '800' : '600',
                          color: isSelected ? '#ffffff' : '#0f172a',
                        }}
                      >
                        {d.getDate()}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <TouchableOpacity
                style={styles.reportFilterModalClose}
                onPress={() => {
                  setSelectedReportDate(todayStr);
                  setShowDailyReportCalendar(false);
                }}
              >
                <Text style={styles.reportFilterModalCloseText}>Today</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      );
    };

    const openClientDetails = (chamber, clientName, log, shiftName) => {
      const found =
        log ||
        todayLogs.find(
          (l) =>
            logMatchesChamber(l, chamber) &&
            namesMatch(l.client_name, clientName) &&
            (!shiftName || resolveLogShiftName(l) === shiftName || !resolveLogShiftName(l))
        ) ||
        todayLogs.find(
          (l) => logMatchesChamber(l, chamber) && namesMatch(l.client_name, clientName)
        );

      if (!found) {
        Alert.alert('Not completed', `"${clientName}" has no submitted log yet.`);
        return;
      }

      setSelectedReportLog({
        ...found,
        chamber_id: found.chamber_id ?? chamber.id,
        chamber_name: found.chamber_name || chamber.name,
        client_name: found.client_name || clientName,
        shift: found.shift || resolveLogShiftName(found) || shiftName || 'Morning',
        chamber_type:
          found.chamber_type || getChamberTypeAndDefault(chamber.id, clientName).type,
        formatted_date: found.formatted_date || logDateKey(found.entry_date),
        entry_date: found.entry_date || found.formatted_date,
        box_temp: found.box_temp ?? found.chamber_temp,
        temp_sensor_image: found.temp_sensor_image || found.photo_url
      });
    };

    const clientNamesForShift = (chamber, shiftName) => {
      const extra = todayLogs
        .filter(
          (l) => logMatchesChamber(l, chamber) && resolveLogShiftName(l) === shiftName
        )
        .map((l) => String(l.client_name || '').trim())
        .filter(Boolean);
      const mapped = dateIsToday
        ? getClientsForChamber(chamber?.id)
            .map((c) => String(c.client_name || '').trim())
            .filter(Boolean)
        : [];
      const names = [];
      const seen = new Set();
      [...mapped, ...extra].forEach((name) => {
        const key = name.toLowerCase();
        if (!name || seen.has(key)) return;
        seen.add(key);
        names.push(name);
      });
      return names;
    };

    const formatBoxQty = (log) => {
      const raw = log?.box_count ?? log?.physical_audit_count ?? log?.count;
      if (raw == null || raw === '') return '—';
      const n = Number(raw);
      return Number.isFinite(n) ? String(n) : '—';
    };

    const formatBoxTemp = (log) => {
      const raw = log?.box_temp ?? log?.chamber_temp ?? log?.temperature;
      if (raw == null || raw === '') return '—';
      const n = Number(raw);
      return Number.isFinite(n) ? `${n}°C` : '—';
    };

    if (drill) {
      const chamber =
        chambersList.find((c) => Number(c.id) === Number(drill.id)) || drill;
      const clients = dateIsToday ? getClientsForChamber(chamber.id) : [];
      const chamberLogs = todayLogs.filter((l) => logMatchesChamber(l, chamber));

      const clientCards = [];
      const seenClients = new Set();
      clients.forEach((client) => {
        const clientName = String(client.client_name || '').trim();
        if (!clientName) return;
        seenClients.add(clientName.toLowerCase());
        const morningLog = chamberLogs.find(
          (l) => namesMatch(l.client_name, clientName) && resolveLogShiftName(l) === 'Morning'
        );
        const eveningLog = chamberLogs.find(
          (l) => namesMatch(l.client_name, clientName) && resolveLogShiftName(l) === 'Evening'
        );
        const anyLog =
          chamberLogs.find((l) => namesMatch(l.client_name, clientName)) ||
          morningLog ||
          eveningLog;
        clientCards.push({
          clientName,
          morningLog,
          eveningLog,
          anyLog,
          isDone: !!(morningLog || eveningLog || anyLog)
        });
      });

      chamberLogs.forEach((log) => {
        const name = String(log.client_name || '').trim();
        if (!name || seenClients.has(name.toLowerCase())) return;
        seenClients.add(name.toLowerCase());
        const shiftName = resolveLogShiftName(log);
        clientCards.push({
          clientName: name,
          morningLog: shiftName === 'Evening' ? null : log,
          eveningLog: shiftName === 'Evening' ? log : null,
          anyLog: log,
          isDone: true
        });
      });

      const visibleClients = clientCards.filter((row) => {
        if (clientFilterOn && !namesMatch(row.clientName, dailyReportClientFilter)) return false;
        return true;
      });

      const renderShiftClientRows = (shiftName) =>
        visibleClients.map((row, idx) => {
          const log = shiftName === 'Evening' ? row.eveningLog : row.morningLog;
          const isDone = !!log;
          return (
            <View
              key={`${shiftName}_${row.clientName}_${idx}`}
              style={[styles.reportListRow, isDone && styles.taskItemCardCompleted]}
            >
              <View
                style={[
                  styles.reportListAccent,
                  isDone ? styles.taskCardAccentDone : styles.taskCardAccentPending
                ]}
              />
              <TouchableOpacity
                style={styles.reportListMain}
                activeOpacity={0.7}
                onPress={() => openClientDetails(chamber, row.clientName, log, shiftName)}
              >
                <Text style={styles.reportListTitle} numberOfLines={1}>
                  {row.clientName}
                </Text>
                <Text style={styles.reportListMeta} numberOfLines={1}>
                  {shiftName}
                  {'  ·  '}
                  {isDone ? 'Done' : 'Pending'}
                  {'  ·  '}Qty {formatBoxQty(log)}
                  {'  ·  '}Temp {formatBoxTemp(log)}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.reportViewBtn, !isDone && { opacity: 0.45 }]}
                onPress={() => openClientDetails(chamber, row.clientName, log, shiftName)}
                activeOpacity={0.85}
              >
                <Text style={styles.reportViewBtnText}>View</Text>
              </TouchableOpacity>
            </View>
          );
        });

      return (
        <View style={styles.tabContainer}>
          {renderFilterBar(
            `${chamber.name || 'Chamber'} · ${visibleClients.length} client${visibleClients.length === 1 ? '' : 's'}`
          )}
          {renderFilterModal()}
          {renderDailyDateCalendar()}

          <ScrollView
            contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 100 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#003580']} />
            }
          >
            {visibleClients.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Ionicons name="people-outline" size={44} color="#94a3b8" />
                <Text style={styles.emptyText}>
                  {clientCards.length === 0
                    ? dateIsToday
                      ? 'No clients mapped to this chamber.'
                      : `No reports for ${dateLabel}.`
                    : 'No clients match the filter.'}
                </Text>
              </View>
            ) : (
              <>
                <Text style={styles.reportShiftSectionTitle}>Morning</Text>
                {renderShiftClientRows('Morning')}
                <Text style={[styles.reportShiftSectionTitle, { marginTop: 10 }]}>Evening</Text>
                {renderShiftClientRows('Evening')}
              </>
            )}
          </ScrollView>
        </View>
      );
    }

    return (
      <View style={styles.tabContainer}>
        {renderFilterBar(dateIsToday ? 'Chambers · tap View for clients' : `Reports · ${dateLabel}`)}
        {renderFilterModal()}
        {renderDailyDateCalendar()}

        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 100 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#003580']} />
          }
        >
          {filteredChambers.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="cube-outline" size={44} color="#94a3b8" />
              <Text style={styles.emptyText}>
                {sortedChambers.length === 0
                  ? 'No chambers found.'
                  : dateIsToday
                    ? 'No chambers match the filter.'
                    : `No reports for ${dateLabel}.`}
              </Text>
            </View>
          ) : (
            filteredChambers.map((chamber) => {
              const morningNames = clientNamesForShift(chamber, 'Morning');
              const eveningNames = clientNamesForShift(chamber, 'Evening');
              const clientNames = [];
              const seenNames = new Set();
              [...morningNames, ...eveningNames].forEach((name) => {
                const key = String(name).toLowerCase();
                if (!name || seenNames.has(key)) return;
                seenNames.add(key);
                clientNames.push(name);
              });
              const pattern = getChamberTypeAndDefault(chamber.id);
              const typeLabel = pattern.type === 'Chilled' ? 'Chiller' : pattern.type;
              const openChamber = () => openChamberFromList(chamber);

              return (
                <View key={`rep-ch-${chamber.id}`} style={styles.reportListRow}>
                  <View style={[styles.reportListAccent, { backgroundColor: pattern.color }]} />
                  <TouchableOpacity style={styles.reportListMain} activeOpacity={0.7} onPress={openChamber}>
                    <Text style={styles.reportListTitle} numberOfLines={1}>
                      {chamber.name}
                      {'  '}
                      <Text style={{ color: pattern.color, fontWeight: '800', fontSize: 12 }}>
                        {typeLabel}
                      </Text>
                    </Text>
                    <Text style={styles.reportListMeta} numberOfLines={1}>
                      {clientNames.length ? clientNames.join(', ') : 'No clients'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.reportViewBtn} onPress={openChamber} activeOpacity={0.85}>
                    <Text style={styles.reportViewBtnText}>View</Text>
                  </TouchableOpacity>
                </View>
              );
            })
          )}
        </ScrollView>
      </View>
    );
  };

  // Same filters as Reports screen (DO scope + chamber + client + slot + search)
  const getFilteredReportLogs = () => {
    const accessAssignments = assignments.filter((a) => a && a.status !== 'inactive');
    const accessChamberIds = new Set(accessAssignments.map((a) => Number(a.chamber_id)));
    const shiftRank = (log) => {
      const s = String(log?.shift || '').trim().toLowerCase();
      if (s === 'evening') return 1;
      if (s === 'morning') return 0;
      const t = String(log?.inspection_time || '');
      if (/^16:00|^18:00/.test(t)) return 1;
      return 0;
    };
    const timeKey = (log) =>
      String(log?.updated_at || log?.created_at || log?.photo_capture_time || log?.inspection_time || '');

    return mergeChamberReportLogs(chamberReportLogs, getAllLocalInspections(displayName, user?.email))
      .filter((log) => {
        if (!log) return false;
        if (accessChamberIds.size > 0 && !accessChamberIds.has(Number(log.chamber_id))) return false;
        if (
          reportChamberFilter !== 'all' &&
          Number(log.chamber_id) !== Number(reportChamberFilter)
        ) {
          return false;
        }
        if (
          reportClientFilter !== 'all' &&
          reportClientFilter !== 'All' &&
          String(log.client_name) !== String(reportClientFilter)
        ) {
          return false;
        }
        if (reportTypeFilter !== 'all' && reportTypeFilter !== 'All') {
          if (resolveReportLotType(log) !== normalizeChamberZone(reportTypeFilter)) return false;
        }
        if (reportShiftFilter !== 'all') {
          const resolved = normalizeShiftLabel(log.shift || log.inspection_time);
          if (resolved !== reportShiftFilter) return false;
        }
        // Calendar date range (From → To)
        const entryDay = logDateKey(log.entry_date || log.formatted_date);
        if (entryDay) {
          const from = reportDateFrom <= reportDateTo ? reportDateFrom : reportDateTo;
          const to = reportDateFrom <= reportDateTo ? reportDateTo : reportDateFrom;
          if (entryDay < from || entryDay > to) return false;
        }
        if (reportSearchQuery.trim()) {
          const q = reportSearchQuery.toLowerCase().trim();
          const hay = `${log.client_name || ''} ${log.chamber_name || ''} ${log.reference_no || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        // Latest on top: date DESC → Evening before Morning → timestamp DESC → id DESC
        const da = String(a.entry_date || '');
        const db = String(b.entry_date || '');
        if (db !== da) return db.localeCompare(da);
        const sr = shiftRank(b) - shiftRank(a);
        if (sr !== 0) return sr;
        const ta = timeKey(a);
        const tb = timeKey(b);
        if (tb !== ta) return tb.localeCompare(ta);
        return (Number(b.id) || 0) - (Number(a.id) || 0);
      });
  };

  /** DO access scope: own warehouse + clients from active assignments only */
  const doAccessScope = useMemo(() => {
    const warehouse = String(user?.warehouse_name || '').trim();
    const active = (assignments || []).filter((a) => a && a.status !== 'inactive');
    const clientNames = Array.from(
      new Set(
        active
          .map((a) => String(a.client_name || '').trim())
          .filter((n) => n && n.toLowerCase() !== 'general')
      )
    ).sort((a, b) => a.localeCompare(b));
    const clientSet = new Set(clientNames.map((c) => c.toLowerCase()));
    const chamberNames = Array.from(
      new Set(active.map((a) => String(a.chamber_name || '').trim()).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));
    const chamberSet = new Set(chamberNames.map((c) => c.toLowerCase()));
    return {
      warehouse,
      warehouseLower: warehouse.toLowerCase(),
      clients: clientNames,
      clientSet,
      chambers: chamberNames,
      chamberSet,
    };
  }, [user?.warehouse_name, assignments]);

  const loadInventoryReports = useCallback(async (mode = 'reset') => {
    if (!apiUrl || !token) return;
    const reset = mode !== 'more';
    if (!reset) {
      if (reportsLoadingMoreRef.current || !reportHasMoreRef.current) return;
      reportsLoadingMoreRef.current = true;
      setReportsLoadingMore(true);
    } else {
      setReportsLoading(true);
      setReportsError('');
      reportOffsetRef.current = 0;
    }
    try {
      const offset = reset ? 0 : reportOffsetRef.current;
      const limit = reset ? INVENTORY_REPORT_FIRST_PAGE : INVENTORY_REPORT_MORE_PAGE;
      const qs = buildInventoryReconciliationQuery({
        offset,
        limit,
        warehouse: user?.warehouse_name || doAccessScope.warehouse,
        client: reportClientFilter
      });
      const res = await fetch(`${apiUrl}/api/dashboard/inventory-reconciliation?${qs.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || `Failed to load inventory (${res.status})`);
      }
      let { rows, total } = parseInventoryReconciliationPayload(data);

      // Soft DO access (same as backend chamber-temp):
      // warehouse match OR blank warehouse; then assigned clients when possible
      const { warehouseLower, clientSet } = doAccessScope;
      if (warehouseLower) {
        rows = rows.filter((r) => {
          const wh = String(r.warehouse_name || '').trim().toLowerCase();
          return !wh || wh === warehouseLower;
        });
      }
      if (clientSet.size > 0) {
        const byClient = rows.filter((r) =>
          clientSet.has(String(r.client_name || '').trim().toLowerCase())
        );
        if (byClient.length > 0) rows = byClient;
      }

      // Client filter options = DO-accessible clients (assignments first)
      if (reset) {
        const clientsFromRows = Array.from(
          new Set(
            rows
              .map((r) => String(r.client_name || '').trim())
              .filter((n) => n && n.toLowerCase() !== 'general')
          )
        ).sort((a, b) => a.localeCompare(b));
        const accessibleClients =
          doAccessScope.clients.length > 0 ? doAccessScope.clients : clientsFromRows;

        setInventoryReportWarehouses(
          doAccessScope.warehouse ? [doAccessScope.warehouse] : []
        );
        setInventoryReportClients(accessibleClients);

        // Drop selected client if no longer in access list
        setReportClientFilter((prev) => {
          if (!prev || prev === 'All' || prev === 'all') return 'All';
          const ok = accessibleClients.some(
            (c) => c.toLowerCase() === String(prev).toLowerCase()
          );
          return ok ? prev : 'All';
        });
      }

      reportOffsetRef.current = offset + rows.length;
      const more = inventoryReportHasMore(offset, rows.length, total) || !!data.has_more;
      reportHasMoreRef.current = more;
      setReportHasMore(more);
      setInventoryReportRows((prev) => (reset ? rows : [...prev, ...rows]));
    } catch (err) {
      if (reset) {
        setInventoryReportRows([]);
        reportHasMoreRef.current = false;
        setReportHasMore(false);
        reportOffsetRef.current = 0;
        setInventoryReportClients(doAccessScope.clients);
        setInventoryReportWarehouses(
          doAccessScope.warehouse ? [doAccessScope.warehouse] : []
        );
      }
      setReportsError(err.message || 'Failed to load inventory reports.');
    } finally {
      setReportsLoading(false);
      setReportsRefreshing(false);
      setReportsLoadingMore(false);
      reportsLoadingMoreRef.current = false;
    }
  }, [apiUrl, token, doAccessScope, user?.warehouse_name, reportClientFilter]);

  const loadChamberReportLogs = useCallback(async () => {
    if (!apiUrl || !token) return;
    setChamberReportsLoading(true);
    setChamberReportsError('');
    try {
      const from = reportDateFrom <= reportDateTo ? reportDateFrom : reportDateTo;
      const to = reportDateFrom <= reportDateTo ? reportDateTo : reportDateFrom;
      const qs = new URLSearchParams({
        page: '1',
        limit: '150',
        fromDate: from,
        toDate: to
      });
      if (user?.warehouse_name) {
        qs.set('warehouse', String(user.warehouse_name).trim());
      }
      const res = await fetch(`${apiUrl}/api/chamber-temp?${qs.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) {
        throw new Error('Session expired. Please log in again.');
      }
      if (!res.ok) {
        throw new Error(data.message || data.error || `Failed to load logs (${res.status})`);
      }
      const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      setChamberReportLogs(items);
    } catch (err) {
      setChamberReportLogs([]);
      setChamberReportsError(err.message || 'Failed to load temperature logs from server.');
    } finally {
      setChamberReportsLoading(false);
    }
  }, [apiUrl, token, reportDateFrom, reportDateTo, user?.warehouse_name]);

  useEffect(() => {
    if (currentNavTab === 'Reports') {
      loadInventoryReports();
    }
  }, [currentNavTab, loadInventoryReports]);

  useEffect(() => {
    if (currentNavTab === 'Reports' && reportsMode === 'temperature') {
      loadChamberReportLogs();
    }
  }, [reportDateFrom, reportDateTo, currentNavTab, reportsMode, loadChamberReportLogs]);

  const resolveReportLotType = (row) => {
    const clientNeedle = String(row?.client_name || '').trim().toLowerCase();
    const nameNeedle = String(row?.chamber_name || '').trim().toLowerCase();
    const cid =
      row?.chamber_id != null && String(row.chamber_id).trim() !== ''
        ? Number(row.chamber_id)
        : null;

    const sameChamber = (id, name) => {
      if (cid != null && Number.isFinite(cid) && Number(id) === cid) return true;
      if (nameNeedle && String(name || '').trim().toLowerCase() === nameNeedle) return true;
      return false;
    };

    const assignExact = (assignments || []).find(
      (a) =>
        sameChamber(a.chamber_id, a.chamber_name) &&
        String(a.client_name || '').trim().toLowerCase() === clientNeedle
    );
    const assignAny = (assignments || []).find((a) => sameChamber(a.chamber_id, a.chamber_name));
    const chamber = (chambersList || []).find((c) => sameChamber(c.id, c.name));

    return (
      pickComplianceZone(
        chamber?.chamber_type,
        assignExact?.chamber_type,
        assignAny?.chamber_type,
        row?.chamber_type
      ) || 'Frozen'
    );
  };

  const filteredInventoryReportRows = useMemo(() => {
    let rows = inventoryReportRows;

    // Soft warehouse access: own WH or blank (DO must not see other warehouses)
    if (doAccessScope.warehouseLower) {
      rows = rows.filter((r) => {
        const wh = String(r.warehouse_name || '').trim().toLowerCase();
        return !wh || wh === doAccessScope.warehouseLower;
      });
    }
    // Assigned clients when filterable without wiping all rows
    if (doAccessScope.clientSet.size > 0) {
      const byClient = rows.filter((r) =>
        doAccessScope.clientSet.has(String(r.client_name || '').trim().toLowerCase())
      );
      if (byClient.length > 0) rows = byClient;
    }

    if (reportChamberFilter && reportChamberFilter !== 'All' && reportChamberFilter !== 'all') {
      rows = rows.filter((r) => {
        const cidMatch = r.chamber_id != null && Number(r.chamber_id) === Number(reportChamberFilter);
        const selectedChamberObj = chambersList.find(c => Number(c.id) === Number(reportChamberFilter));
        const cnameMatch = selectedChamberObj && r.chamber_name && 
          String(r.chamber_name).trim().toLowerCase() === String(selectedChamberObj.name).trim().toLowerCase();
        const assignedMatch = assignments.some(
          a => Number(a.chamber_id) === Number(reportChamberFilter) &&
          a.client_name && r.client_name &&
          String(a.client_name).trim().toLowerCase() === String(r.client_name).trim().toLowerCase()
        );
        return cidMatch || cnameMatch || assignedMatch;
      });
    }

    if (reportClientFilter && reportClientFilter !== 'All' && reportClientFilter !== 'all') {
      const cLower = reportClientFilter.toLowerCase().trim();
      // Only allow selecting DO-accessible clients
      if (doAccessScope.clientSet.size > 0 && !doAccessScope.clientSet.has(cLower)) {
        rows = [];
      } else {
        rows = rows.filter(
          (r) => r.client_name && String(r.client_name).toLowerCase().trim() === cLower
        );
      }
    }

    if (reportTypeFilter && reportTypeFilter !== 'all' && reportTypeFilter !== 'All') {
      const want = normalizeChamberZone(reportTypeFilter);
      rows = rows.filter((r) => resolveReportLotType(r) === want);
    }
    return [...dedupeInventoryLots(rows)].sort((a, b) => {
      // LIFO: newest audit / task first (before opening detail)
      const dateA = String(a.last_audit_date || a.entry_date || '').slice(0, 10);
      const dateB = String(b.last_audit_date || b.entry_date || '').slice(0, 10);
      if (dateB !== dateA) {
        if (!dateA) return 1;
        if (!dateB) return -1;
        return dateB.localeCompare(dateA);
      }
      const timeA = String(a.updated_at || a.created_at || a.last_audit_date || '')
        .replace('T', ' ')
        .slice(0, 19);
      const timeB = String(b.updated_at || b.created_at || b.last_audit_date || '')
        .replace('T', ' ')
        .slice(0, 19);
      if (timeB !== timeA) {
        if (!timeA) return 1;
        if (!timeB) return -1;
        return timeB.localeCompare(timeA);
      }
      return String(a.client_name || '').localeCompare(String(b.client_name || ''));
    });
  }, [inventoryReportRows, reportClientFilter, reportChamberFilter, reportTypeFilter, chambersList, assignments, doAccessScope]);

  const inventoryReportSummary = useMemo(() => {
    let inward = 0;
    let outward = 0;
    let mismatches = 0;
    let totalBoxes = 0;
    const countedInOut = new Set();
    filteredInventoryReportRows.forEach((r) => {
      const ioKey = `${String(r.client_name || '').trim().toLowerCase()}|||${String(r.warehouse_name || '').trim().toLowerCase()}`;
      if (!countedInOut.has(ioKey)) {
        countedInOut.add(ioKey);
        inward += Math.max(0, Number(r.total_inward_boxes) || 0);
        outward += Math.max(0, Number(r.total_outward_boxes) || 0);
      }
      const bal = Math.max(0, Number(r.calculated_balance) || 0);
      const phys = Math.max(0, Number(r.physical_audit_count) || 0);
      totalBoxes += phys;
      if (bal - phys !== 0) mismatches += 1;
    });
    return {
      lots: filteredInventoryReportRows.length,
      inward,
      outward,
      mismatches,
      totalBoxes
    };
  }, [filteredInventoryReportRows]);

  /** Latest total boxes after DO task (physical audit). */
  const getDoLotTotalBoxes = (item) => {
    if (item == null) return 0;
    if (item.physical_audit_count != null && item.physical_audit_count !== '') {
      return Math.max(0, Number(item.physical_audit_count) || 0);
    }
    return Math.max(0, Number(item.calculated_balance) || 0);
  };
  const openInventoryReportDetail = useCallback(
    async (row) => {
      setSelectedInventoryReport(row);
      setInventoryHistory([]);
      setInventoryHistoryError('');
      setInventoryHistoryLoading(true);
      try {
        const qs = new URLSearchParams({
          page: '1',
          limit: '200',
          export: '1'
        });
        if (row.warehouse_name) qs.set('warehouse', String(row.warehouse_name).trim());
        if (row.client_name) qs.set('client', String(row.client_name).trim());
        if (row.chamber_id != null && String(row.chamber_id).trim() !== '') {
          qs.set('chamber_id', String(row.chamber_id));
        } else if (row.chamber_name) {
          qs.set('chamber', String(row.chamber_name).trim());
        }

        const res = await fetch(`${apiUrl}/api/chamber-temp?${qs.toString()}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json'
          }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.message || data.error || `Failed to load history (${res.status})`);
        }
        let items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];

        // One lot = client + chamber (Frozen vs Chilled stay separate)
        const clientNeedle = String(row.client_name || '')
          .trim()
          .toLowerCase();
        const whNeedle = String(row.warehouse_name || '')
          .trim()
          .toLowerCase();
        const chamberId = row.chamber_id != null && String(row.chamber_id).trim() !== ''
          ? Number(row.chamber_id)
          : null;
        const chamberNeedle = String(row.chamber_name || '')
          .trim()
          .toLowerCase();
        items = items.filter((r) => {
          const c = String(r.client_name || '')
            .trim()
            .toLowerCase();
          const w = String(r.warehouse_name || '')
            .trim()
            .toLowerCase();
          const clientMatch = !clientNeedle || c === clientNeedle;
          const whMatch = !whNeedle || w === whNeedle;
          const logCid = r.chamber_id != null && String(r.chamber_id).trim() !== ''
            ? Number(r.chamber_id)
            : null;
          const chamberMatch = chamberId != null && Number.isFinite(chamberId)
            ? logCid === chamberId
            : !chamberNeedle ||
              String(r.chamber_name || '').trim().toLowerCase() === chamberNeedle;
          return clientMatch && whMatch && chamberMatch;
        });

        setInventoryHistory(buildReportReadingRows(items));
      } catch (err) {
        // Offline fallback: local inspections for this client/chamber
        try {
          const local = buildReportReadingRows(
            getAllLocalInspections(displayName, user?.email).filter((log) => {
              if (!log) return false;
              if (
                row.client_name &&
                String(log.client_name || '').trim().toLowerCase() !==
                  String(row.client_name).trim().toLowerCase()
              ) {
                return false;
              }
              if (
                row.warehouse_name &&
                String(log.warehouse_name || '').trim().toLowerCase() &&
                String(log.warehouse_name || '').trim().toLowerCase() !==
                  String(row.warehouse_name).trim().toLowerCase()
              ) {
                return false;
              }
              if (row.chamber_id != null && String(row.chamber_id).trim() !== '') {
                if (Number(log.chamber_id) !== Number(row.chamber_id)) return false;
              } else if (
                row.chamber_name &&
                String(log.chamber_name || '').trim().toLowerCase() !==
                  String(row.chamber_name).trim().toLowerCase()
              ) {
                return false;
              }
              return true;
            })
          );
          setInventoryHistory(local);
          setInventoryHistoryError(local.length ? '' : err.message || 'Failed to load day-wise qty.');
        } catch (_) {
          setInventoryHistory([]);
          setInventoryHistoryError(err.message || 'Failed to load day-wise qty.');
        }
      } finally {
        setInventoryHistoryLoading(false);
      }
    },
    [apiUrl, token, displayName]
  );

  const closeInventoryReportDetail = () => {
    setSelectedInventoryReport(null);
    setInventoryHistory([]);
    setInventoryHistoryError('');
    setInventoryHistoryLoading(false);
    setSelectedReportLog(null);
    setDetailDateFrom('');
    setDetailDateTo('');
  };

  const formatInventoryReportTime = (row) => {
    const to24hTime = (value) => {
      if (value == null || value === '') return null;
      if (typeof value === 'string' && /^\d{1,2}:\d{2}/.test(value.trim())) {
        const m = value.trim().match(/^(\d{1,2}):(\d{2})/);
        if (m) return `${String(parseInt(m[1], 10)).padStart(2, '0')}:${m[2]}`;
      }
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) {
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }
      return null;
    };
    const candidates = [row.created_at, row.submit_time, row.photo_capture_time, row.inspection_time];
    for (const c of candidates) {
      const t = to24hTime(c);
      if (t) return t;
    }
    return '—';
  };

  // Modal to display Client Box Inventory Reports in a dedicated overlay view
  const renderInventoryModal = () => {
    if (!showInventoryModal) return null;

    const allInspections = getAllLocalInspections(displayName, user?.email);
    
    // Group logs
    const clientInventory = {};
    allInspections.forEach(log => {
      if (!log.client_name || !log.chamber_name) return;
      const key = `${log.client_name}_${log.chamber_name}`.toLowerCase();
      if (!clientInventory[key]) {
        clientInventory[key] = {
          clientName: log.client_name,
          chamberName: log.chamber_name,
          chamberType: log.chamber_type || 'Frozen',
          history: []
        };
      }
      clientInventory[key].history.push({
        date: log.entry_date,
        boxCount: log.box_count || 0,
        temp: log.box_temp,
        time: log.inspection_time
      });
    });

    const inventoryList = Object.values(clientInventory).map(item => {
      item.history.sort((a, b) => b.date.localeCompare(a.date));
      item.currentCount = item.history.length > 0 ? item.history[0].boxCount : 0;
      return item;
    });

    const filteredInventoryList = inventoryList.filter(item => {
      if (inventoryClientSearch.trim() !== '') {
        if (!item.clientName.toLowerCase().includes(inventoryClientSearch.toLowerCase())) {
          return false;
        }
      }
      if (inventoryChamberSearch.trim() !== '') {
        if (!item.chamberName.toLowerCase().includes(inventoryChamberSearch.toLowerCase())) {
          return false;
        }
      }
      return true;
    });

    return (
      <Modal visible={showInventoryModal} animationType="slide" transparent={false} onRequestClose={() => setShowInventoryModal(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#f1f5f9' }}>
          {/* Header */}
          <View style={{
            height: 56,
            backgroundColor: '#003580',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            elevation: 4,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.1,
            shadowRadius: 3
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Ionicons name="cube" size={22} color="#ffffff" style={{ marginRight: 8 }} />
              <Text style={{ fontSize: 16, fontWeight: 'bold', color: '#ffffff' }}>Client Box Inventory</Text>
            </View>
            <TouchableOpacity onPress={() => setShowInventoryModal(false)} style={{ padding: 4 }}>
              <Ionicons name="close-circle" size={24} color="#ffffff" />
            </TouchableOpacity>
          </View>

          {/* Search Filters Row */}
          <View style={{ 
            flexDirection: 'row', 
            paddingHorizontal: 16, 
            paddingVertical: 10, 
            backgroundColor: '#ffffff', 
            borderBottomWidth: 1, 
            borderColor: '#e2e8f0',
            zIndex: 10
          }}>
            {/* Client Dropdown */}
            <View style={{ flex: 1, marginRight: 8, position: 'relative' }}>
              <TouchableOpacity 
                style={{
                  height: 38,
                  backgroundColor: '#f8fafc',
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: '#cbd5e1',
                  paddingHorizontal: 10,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between'
                }}
                onPress={() => {
                  setShowInventoryClientDropdown(!showInventoryClientDropdown);
                  setShowInventoryChamberDropdown(false);
                }}
              >
                <Text style={{ fontSize: 11, color: '#1e293b', fontWeight: '600' }} numberOfLines={1}>
                  {inventoryClientSearch || 'All Clients'}
                </Text>
                <Ionicons name={showInventoryClientDropdown ? 'chevron-up' : 'chevron-down'} size={14} color="#64748b" />
              </TouchableOpacity>

              {showInventoryClientDropdown && (
                <View style={{
                  position: 'absolute',
                  top: 42,
                  left: 0,
                  right: 0,
                  backgroundColor: '#ffffff',
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: '#cbd5e1',
                  maxHeight: 150,
                  zIndex: 20,
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.15,
                  shadowRadius: 4,
                  elevation: 5
                }}>
                  <ScrollView nestedScrollEnabled={true} keyboardShouldPersistTaps="handled">
                    <TouchableOpacity 
                      style={{ padding: 10, borderBottomWidth: 0.5, borderColor: '#f1f5f9' }}
                      onPress={() => {
                        setInventoryClientSearch('');
                        setShowInventoryClientDropdown(false);
                      }}
                    >
                      <Text style={{ fontSize: 11, color: '#0f172a', fontWeight: '700' }}>All Clients</Text>
                    </TouchableOpacity>
                    {Array.from(new Set(assignments.map(a => a.client_name).filter(Boolean))).sort().map(clientName => (
                      <TouchableOpacity 
                        key={clientName}
                        style={{ padding: 10, borderBottomWidth: 0.5, borderColor: '#f1f5f9' }}
                        onPress={() => {
                          setInventoryClientSearch(clientName);
                          setShowInventoryClientDropdown(false);
                        }}
                      >
                        <Text style={{ fontSize: 11, color: '#334155' }}>{clientName}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}
            </View>

            {/* Chamber Dropdown */}
            <View style={{ flex: 1, position: 'relative' }}>
              <TouchableOpacity 
                style={{
                  height: 38,
                  backgroundColor: '#f8fafc',
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: '#cbd5e1',
                  paddingHorizontal: 10,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between'
                }}
                onPress={() => {
                  setShowInventoryChamberDropdown(!showInventoryChamberDropdown);
                  setShowInventoryClientDropdown(false);
                }}
              >
                <Text style={{ fontSize: 11, color: '#1e293b', fontWeight: '600' }} numberOfLines={1}>
                  {inventoryChamberSearch || 'All Chambers'}
                </Text>
                <Ionicons name={showInventoryChamberDropdown ? 'chevron-up' : 'chevron-down'} size={14} color="#64748b" />
              </TouchableOpacity>

              {showInventoryChamberDropdown && (
                <View style={{
                  position: 'absolute',
                  top: 42,
                  left: 0,
                  right: 0,
                  backgroundColor: '#ffffff',
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: '#cbd5e1',
                  maxHeight: 150,
                  zIndex: 20,
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.15,
                  shadowRadius: 4,
                  elevation: 5
                }}>
                  <ScrollView nestedScrollEnabled={true} keyboardShouldPersistTaps="handled">
                    <TouchableOpacity 
                      style={{ padding: 10, borderBottomWidth: 0.5, borderColor: '#f1f5f9' }}
                      onPress={() => {
                        setInventoryChamberSearch('');
                        setShowInventoryChamberDropdown(false);
                      }}
                    >
                      <Text style={{ fontSize: 11, color: '#0f172a', fontWeight: '700' }}>All Chambers</Text>
                    </TouchableOpacity>
                    {Array.from(new Set(assignments.map(a => a.chamber_name).filter(Boolean))).sort().map(chamberName => (
                      <TouchableOpacity 
                        key={chamberName}
                        style={{ padding: 10, borderBottomWidth: 0.5, borderColor: '#f1f5f9' }}
                        onPress={() => {
                          setInventoryChamberSearch(chamberName);
                          setShowInventoryChamberDropdown(false);
                        }}
                      >
                        <Text style={{ fontSize: 11, color: '#334155' }}>{chamberName}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}
            </View>
          </View>

          {/* List content */}
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
            {filteredInventoryList.length === 0 ? (
              <View style={[styles.reportsEmptyRow, { backgroundColor: '#ffffff', padding: 24, borderRadius: 12 }]}>
                <Ionicons name="cube-outline" size={32} color="#94a3b8" />
                <Text style={[styles.reportsEmptyText, { marginTop: 10 }]}>No client inventory data matching filter.</Text>
              </View>
            ) : (
              filteredInventoryList.map((item, idx) => {
                const latest = item.history[0];
                const showTrend = item.history.length > 1;
                const diff = showTrend ? (latest.boxCount - item.history[1].boxCount) : 0;

                return (
                  <View key={`${item.clientName}_${item.chamberName}_${idx}`} style={[styles.inventoryItemCard, { backgroundColor: '#ffffff', elevation: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2 }]}>
                    <View style={styles.inventoryItemHeader}>
                      <View style={{ flex: 1, paddingRight: 8 }}>
                        <Text style={styles.inventoryClientName}>{item.clientName}</Text>
                        <Text style={styles.inventoryChamberLabel}>
                          <Text style={{ fontWeight: 'bold', color: '#475569' }}>{item.chamberName}</Text> • {item.chamberType}
                        </Text>
                      </View>
                      <View style={styles.inventoryCountBadge}>
                        <Text style={styles.inventoryCountText}>{item.currentCount} Boxes</Text>
                      </View>
                    </View>

                    {/* Trend Indicator */}
                    {showTrend && (
                      <View style={[styles.inventoryTrendRow, { backgroundColor: '#f8fafc' }]}>
                        <Ionicons 
                          name={diff < 0 ? "trending-down-outline" : "trending-up-outline"} 
                          size={16} 
                          color={diff < 0 ? "#ef4444" : "#16a34a"} 
                        />
                        <Text style={[styles.inventoryTrendText, { color: diff < 0 ? "#ef4444" : "#16a34a", flex: 1, flexWrap: 'wrap' }]}>
                          {diff < 0 ? `Reduced by ${Math.abs(diff)}` : `Increased by ${diff}`} boxes since last reading ({item.history[1].boxCount} ➔ {latest.boxCount})
                        </Text>
                      </View>
                    )}

                    {/* Recent updates list */}
                    <View style={styles.inventoryHistoryList}>
                      <Text style={styles.historyListTitle}>Recent Logs History:</Text>
                      {item.history.slice(0, 3).map((hist, hIdx) => (
                        <View key={hIdx} style={styles.historyRow}>
                          <Text style={styles.historyDate}>{hist.date} ({hist.time})</Text>
                          <Text style={styles.historyBoxes}>{hist.boxCount} Boxes ({hist.temp}°C)</Text>
                        </View>
                      ))}
                      
                      <TouchableOpacity 
                        style={{ 
                          marginTop: 8, 
                          flexDirection: 'row', 
                          alignItems: 'center', 
                          justifyContent: 'center', 
                          backgroundColor: '#eff6ff', 
                          borderColor: '#bfdbfe', 
                          borderWidth: 1, 
                          borderRadius: 8, 
                          paddingVertical: 6,
                          width: '100%'
                        }}
                        onPress={() => {
                          setSelectedInventoryItem(item);
                          setShowHistoryModal(true);
                        }}
                      >
                        <Ionicons name="eye-outline" size={14} color="#1d4ed8" style={{ marginRight: 6 }} />
                        <Text style={{ fontSize: 11, fontWeight: '700', color: "#1d4ed8" }}>View Full History</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    );
  };

  const renderNotificationsModal = () => {
    const { pendingMorning, pendingEvening, isEveningUnlocked } = getActiveTasksDetails();
    const hasMorningPending = pendingMorning.length > 0;
    const hasEveningPending = isEveningUnlocked && pendingEvening.length > 0;
    const permissionAlerts = getActivePermissionAlerts();

    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    const formattedDate = `${dd}/${mm}/${yyyy}`;

    return (
      <Modal
        visible={showNotificationsModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowNotificationsModal(false)}
      >
        <View style={[styles.modalOverlay, { justifyContent: 'flex-start' }]}>
          <View style={[styles.modalContainer, { 
            maxHeight: '85%', 
            width: '100%', 
            padding: 0, 
            borderTopLeftRadius: 0, 
            borderTopRightRadius: 0, 
            borderBottomLeftRadius: 20, 
            borderBottomRightRadius: 20 
          }]}>
            <View style={{ 
              flexDirection: 'row', 
              justifyContent: 'space-between', 
              alignItems: 'center', 
              paddingHorizontal: 20, 
              paddingVertical: 18,
              backgroundColor: '#003580',
              borderBottomWidth: 1, 
              borderColor: 'rgba(255, 255, 255, 0.1)' 
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="notifications" size={20} color="#ffffff" />
                <Text style={{ fontSize: 16, fontWeight: '800', color: '#ffffff' }}>Notification Center</Text>
              </View>
              <TouchableOpacity onPress={() => setShowNotificationsModal(false)}>
                <Ionicons name="close" size={24} color="#ffffff" />
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={{ padding: 12, backgroundColor: '#ffffff', paddingBottom: 20 }}>
              {/* Super Admin edit approval / denial cards */}
              {permissionAlerts.map((notif) => {
                const meta = parsePermissionTaskMeta(notif);
                const isApproved = notif.status === 'Approved';
                const shiftLabel = meta.shift || 'Shift';
                const permText = `${notif.request_description || ''} ${notif.description || ''}`;
                return (
                  <TouchableOpacity
                    key={`perm-${notif.id}`}
                    style={{
                      backgroundColor: '#ffffff',
                      borderRadius: 10,
                      padding: 10,
                      marginBottom: 8,
                      borderLeftWidth: 3,
                      borderColor: isApproved ? '#16a34a' : '#ef4444',
                      elevation: 1,
                      shadowColor: '#000',
                      shadowOffset: { width: 0, height: 1 },
                      shadowOpacity: 0.05,
                      shadowRadius: 2,
                      width: '100%',
                    }}
                    activeOpacity={0.9}
                    onPress={() => openPermissionNotificationTask(notif)}
                  >
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <Text style={{ fontSize: 9.5, fontWeight: '800', color: '#64748b' }}>
                      {notif.record_type === 'MasterSetup'
                        ? 'Master Setup'
                        : notif.record_type === 'ChamberType' || /EDIT chamber type/i.test(permText)
                          ? 'Chamber Type'
                        : notif.record_type === 'ChamberMaster'
                          ? (/ADD chamber/i.test(permText)
                            ? 'Chamber Add'
                            : /EDIT chamber/i.test(permText)
                              ? 'Chamber Edit'
                              : 'Chamber Delete')
                          : notif.record_type === 'ClientMaster'
                            ? (/EDIT client|UPDATE_CLIENT|edited client/i.test(permText)
                              ? 'Client Edit'
                              : /ADD client/i.test(permText)
                                ? 'Client Add'
                                : 'Client Delete')
                            : 'Edit Permission'}{' '}
                      · {formattedDate}
                    </Text>
                      <View style={{
                        backgroundColor:
                          notif.record_type === 'ClientMaster' || notif.record_type === 'MasterSetup'
                            ? '#eff6ff'
                            : (isApproved ? '#f0fdf4' : '#fef2f2'),
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        borderRadius: 4
                      }}>
                        <Text style={{
                          fontSize: 9,
                          fontWeight: '800',
                          color:
                            notif.record_type === 'ClientMaster'
                              ? '#1d4ed8'
                              : notif.record_type === 'MasterSetup'
                                ? '#0369a1'
                                : (isApproved ? '#16a34a' : '#ef4444')
                        }}>
                          {notif.record_type === 'ClientMaster'
                            ? (isApproved ? 'APPROVED' : 'DENIED')
                            : notif.record_type === 'MasterSetup'
                              ? 'OPEN'
                              : (isApproved ? 'APPROVED' : 'DENIED')}
                        </Text>
                      </View>
                    </View>

                    <Text style={{ fontSize: 12, fontWeight: '700', color: '#1e293b', lineHeight: 16, marginBottom: 2 }}>
                      {notif.record_type === 'MasterSetup'
                        ? 'Chambers & Clients management'
                        : notif.record_type === 'ChamberType' || /EDIT chamber type/i.test(permText)
                          ? getPermissionChamberLabel(notif)
                        : notif.record_type === 'ChamberMaster'
                          ? getPermissionChamberLabel(notif)
                          : notif.record_type === 'ClientMaster'
                            ? (
                              String(notif.request_description || notif.description || '').match(/EDIT client "([^"]+)"/i)?.[1] ||
                              String(notif.request_description || notif.description || '').match(/DELETE client "([^"]+)"/i)?.[1] ||
                              'Client master'
                            )
                          : `${meta.chamber_name} · ${meta.client_name}`}
                    </Text>
                    <Text style={{ fontSize: 11, fontWeight: '600', color: '#475569', marginBottom: 6 }}>
                      {notif.record_type === 'MasterSetup'
                        ? 'Master Setup (approval not required)'
                        : notif.record_type === 'ChamberType' || /EDIT chamber type/i.test(permText)
                          ? `Chamber type ${isApproved ? 'approved — updating automatically' : 'denied'}`
                        : notif.record_type === 'ChamberMaster'
                          ? `${/ADD chamber/i.test(permText) ? 'Chamber add' : (/EDIT chamber/i.test(permText) ? 'Chamber edit' : 'Chamber delete')} ${isApproved ? 'approved' : 'denied'}`
                          : notif.record_type === 'ClientMaster'
                            ? `Client change ${isApproved ? 'approved — updating automatically' : 'denied'}`
                          : `${shiftLabel} task · Edit ${isApproved ? 'approved' : 'denied'}${meta.reference_no ? ` · ${meta.reference_no}` : ''}`}
                    </Text>

                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 9.5, color: isApproved ? '#16a34a' : '#ef4444', fontWeight: '800' }}>
                        {notif.record_type === 'ChamberMaster' && isApproved
                          ? (/ADD chamber/i.test(permText)
                            ? 'Tap to assign chamber →'
                            : /EDIT chamber type/i.test(permText)
                              ? 'Type updates automatically ➔'
                            : /EDIT chamber/i.test(permText)
                              ? 'Tap to edit chamber ➔'
                              : 'Tap to delete chamber ➔')
                          : notif.record_type === 'ChamberType'
                            ? (isApproved ? 'Type updates automatically ➔' : 'View & dismiss ➔')
                          : notif.record_type === 'ClientMaster'
                            ? (isApproved ? 'Client updates automatically ➔' : 'View & dismiss ➔')
                          : notif.record_type === 'MasterSetup'
                            ? 'Tap to open Master Setup ➔'
                          : isApproved
                            ? 'Open task to edit ➔'
                            : 'View & dismiss ➔'}
                      </Text>
                      <View style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: isApproved ? '#16a34a' : '#ef4444'
                      }} />
                    </View>
                  </TouchableOpacity>
                );
              })}

              {/* Morning Task Notification Card */}
              <TouchableOpacity 
                style={{
                  backgroundColor: '#ffffff',
                  borderRadius: 10,
                  padding: 10,
                  marginBottom: 8,
                  borderLeftWidth: 3,
                  borderColor: '#eab308',
                  elevation: 1,
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 1 },
                  shadowOpacity: 0.05,
                  shadowRadius: 2,
                  width: '100%',
                }}
                activeOpacity={0.9}
                onPress={() => {
                  handleSelectShift('Morning');
                  setShowNotificationsModal(false);
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <Text style={{ fontSize: 9.5, fontWeight: '800', color: '#64748b' }}>
                    Today's Task - {formattedDate}
                  </Text>
                  <View style={{ backgroundColor: '#fffbeb', padding: 3, borderRadius: 4 }}>
                    <Ionicons name="sunny" size={12} color="#eab308" />
                  </View>
                </View>
                
                <Text style={{ fontSize: 11.5, fontWeight: '700', color: '#1e293b', lineHeight: 15, marginBottom: 4 }}>
                  Morning Task: {pendingMorning.length > 0 
                    ? `${pendingMorning.length} pending assignments.` 
                    : 'All assignments completed.'
                  }
                </Text>

                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 9.5, color: '#ca8a04', fontWeight: '800' }}>
                    {pendingMorning.length > 0 ? 'Review Tasks →' : 'View Details →'}
                  </Text>
                  {pendingMorning.length > 0 && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#eab308' }} />}
                </View>
              </TouchableOpacity>

              {/* Evening Task Notification Card (Only show if Evening is active/unlocked) */}
              {isEveningUnlocked && (
                <TouchableOpacity 
                  style={{
                    backgroundColor: '#ffffff',
                    borderRadius: 10,
                    padding: 10,
                    borderLeftWidth: 3,
                    borderColor: '#3b82f6',
                    elevation: 1,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: 0.05,
                    shadowRadius: 2,
                    width: '100%',
                  }}
                  activeOpacity={0.9}
                  onPress={() => {
                    handleSelectShift('Evening');
                    setShowNotificationsModal(false);
                  }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <Text style={{ fontSize: 9.5, fontWeight: '800', color: '#64748b' }}>
                      Today's Task - {formattedDate}
                    </Text>
                    <View style={{ backgroundColor: '#eff6ff', padding: 3, borderRadius: 4 }}>
                      <Ionicons name="moon" size={12} color="#3b82f6" />
                    </View>
                  </View>
                  
                  <Text style={{ fontSize: 11.5, fontWeight: '700', color: '#1e293b', lineHeight: 15, marginBottom: 4 }}>
                    Evening Task: {pendingEvening.length > 0 
                      ? `${pendingEvening.length} pending assignments.` 
                      : 'All assignments completed.'
                    }
                  </Text>

                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 9.5, color: '#3b82f6', fontWeight: '800' }}>
                      {pendingEvening.length > 0 ? 'Review Tasks →' : 'View Details →'}
                    </Text>
                    {pendingEvening.length > 0 && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#3b82f6' }} />}
                  </View>
                </TouchableOpacity>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    );
  };

  const renderHistoryModal = () => {
    if (!showHistoryModal || !selectedInventoryItem) return null;
    
    return (
      <Modal 
        visible={showHistoryModal} 
        animationType="slide" 
        transparent={false} 
        onRequestClose={() => setShowHistoryModal(false)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: '#f8fafc' }}>
          {/* Header */}
          <View style={{
            height: 56,
            backgroundColor: '#003580',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            elevation: 4,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.1,
            shadowRadius: 3
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 }}>
              <TouchableOpacity onPress={() => setShowHistoryModal(false)} style={{ marginRight: 12 }}>
                <Ionicons name="arrow-back" size={24} color="#ffffff" />
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: 'bold', color: '#ffffff' }} numberOfLines={1}>
                  {selectedInventoryItem.clientName}
                </Text>
                <Text style={{ fontSize: 10, color: '#93c5fd', marginTop: 1 }} numberOfLines={1}>
                  History • <Text style={{ fontWeight: 'bold', color: '#ffffff' }}>{selectedInventoryItem.chamberName}</Text>
                </Text>
              </View>
            </View>
            <TouchableOpacity onPress={() => setShowHistoryModal(false)} style={{ padding: 4 }}>
              <Ionicons name="close-circle" size={24} color="#ffffff" />
            </TouchableOpacity>
          </View>

          {/* Content */}
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
            <View style={{ backgroundColor: '#ffffff', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#e2e8f0', marginBottom: 16 }}>
              <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#64748b', textTransform: 'uppercase', marginBottom: 12 }}>
                Client & Chamber Info
              </Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text style={{ fontSize: 12, color: '#475569' }}>Client Name</Text>
                <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#0f172a' }}>{selectedInventoryItem.clientName}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text style={{ fontSize: 12, color: '#475569' }}>Chamber</Text>
                <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#0f172a' }}>{selectedInventoryItem.chamberName}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text style={{ fontSize: 12, color: '#475569' }}>Chamber Type</Text>
                <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#0f172a' }}>{selectedInventoryItem.chamberType}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 12, color: '#475569' }}>Current Stock</Text>
                <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#16a34a' }}>{selectedInventoryItem.currentCount} Boxes</Text>
              </View>
            </View>

            <View style={{ backgroundColor: '#ffffff', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#e2e8f0' }}>
              <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#64748b', textTransform: 'uppercase', marginBottom: 12 }}>
                Inventory Log History
              </Text>

              {selectedInventoryItem.history.length === 0 ? (
                <Text style={{ fontSize: 12, color: '#64748b', textAlign: 'center', marginVertical: 20 }}>
                  No history records found.
                </Text>
              ) : (
                selectedInventoryItem.history.map((hist, index) => (
                  <View key={index}>
                    <View style={{ paddingVertical: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: '#1e293b' }}>{hist.date}</Text>
                        <Text style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>
                          Slot: {hist.shift === 'Morning' ? 'Morning Task' : hist.shift === 'Evening' ? 'Evening Task' : (hist.time === '10:00' ? 'Morning Task' : hist.time === '16:00' ? 'Evening Task' : hist.time)}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={{ fontSize: 13, fontWeight: '800', color: '#0f172a' }}>{hist.boxCount} Boxes</Text>
                        {hist.temp !== undefined && hist.temp !== null && (
                          <Text style={{ fontSize: 11, color: '#475569', marginTop: 3 }}>Temp: {hist.temp}°C</Text>
                        )}
                      </View>
                    </View>
                    {index < selectedInventoryItem.history.length - 1 && (
                      <View style={{ height: 1, backgroundColor: '#f1f5f9', marginVertical: 2 }} />
                    )}
                  </View>
                ))
              )}
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    );
  };

  // C. REPORTS TAB VIEW — inventory (Client filter only; no WH / chamber)
  const renderReportsView = () => {
    const closeReportFilters = () => {
      setShowReportClientDropdown(false);
      setShowReportWarehouseDropdown(false);
      setShowReportChamberDropdown(false);
      setShowReportTypeDropdown(false);
    };

    const clearReportFilters = () => {
      setReportView('all');
      setReportWarehouseFilter('All');
      setReportClientFilter('All');
      setReportChamberFilter('all');
      setReportTypeFilter('all');
      closeReportFilters();
    };

    const reportDdBtn = {
      height: 36,
      backgroundColor: '#fff',
      borderRadius: 8,
      borderWidth: 1,
      borderColor: '#e2e8f0',
      paddingHorizontal: 8,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between'
    };
    const reportDdMenu = {
      position: 'absolute',
      top: 40,
      left: 0,
      right: 0,
      backgroundColor: '#fff',
      borderRadius: 8,
      borderWidth: 1,
      borderColor: '#e2e8f0',
      maxHeight: 200,
      zIndex: 220,
      elevation: 8,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.12,
      shadowRadius: 4
    };

    const renderDdItem = (key, label, selected, onPress) => (
      <TouchableOpacity
        key={key}
        style={{
          paddingVertical: 10,
          paddingHorizontal: 10,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: '#f1f5f9'
        }}
        onPress={onPress}
      >
        <Text style={{ fontSize: 12, color: '#0f172a', fontWeight: selected ? '800' : '500' }} numberOfLines={1}>
          {label}
        </Text>
        {selected ? <Ionicons name="checkmark" size={14} color="#003580" /> : null}
      </TouchableOpacity>
    );

    const reportClientOptions = (() => {
      let list = [];
      if (reportChamberFilter === 'all' || reportChamberFilter === 'All') {
        list = inventoryReportClients.length
          ? inventoryReportClients
          : Array.from(new Set(assignments.map((a) => a.client_name).filter(Boolean)));
      } else {
        const selectedChamberObj = chambersList.find((c) => Number(c.id) === Number(reportChamberFilter));
        const activeClients = assignments
          .filter((a) => Number(a.chamber_id) === Number(reportChamberFilter))
          .map((a) => a.client_name);
        const rowClients = inventoryReportRows
          .filter((r) => {
            const cidMatch = r.chamber_id != null && Number(r.chamber_id) === Number(reportChamberFilter);
            const cnameMatch =
              selectedChamberObj &&
              r.chamber_name &&
              String(r.chamber_name).trim().toLowerCase() === String(selectedChamberObj.name).trim().toLowerCase();
            return cidMatch || cnameMatch;
          })
          .map((r) => r.client_name);
        list = Array.from(new Set([...activeClients, ...rowClients])).filter(Boolean);
      }
      if (doAccessScope.clients.length > 0) {
        const accessSet = new Set(doAccessScope.clients.map((c) => c.toLowerCase().trim()));
        list = list.filter((c) => accessSet.has(String(c).toLowerCase().trim()));
      }
      return list.sort((a, b) => String(a).localeCompare(String(b)));
    })();

    const chamberLabel =
      reportChamberFilter === 'all' || reportChamberFilter === 'All'
        ? 'All Chambers'
        : chambersList.find((c) => Number(c.id) === Number(reportChamberFilter))?.name || 'All Chambers';
    const clientLabel =
      reportClientFilter === 'All' || reportClientFilter === 'all' ? 'All Clients' : reportClientFilter;
    const typeLabel =
      reportTypeFilter === 'all' || reportTypeFilter === 'All'
        ? 'All Types'
        : chamberZoneStyle(reportTypeFilter).type;

    const renderInventoryItem = ({ item }) => {
      const totalBoxes = getDoLotTotalBoxes(item);
      const outOfStock = totalBoxes === 0;
      const zone = chamberZoneStyle(resolveReportLotType(item));
      return (
        <TouchableOpacity
          style={styles.dailyCard}
          onPress={() => openInventoryReportDetail(item)}
          activeOpacity={0.85}
        >
          <View style={styles.dailyTop}>
            <View style={styles.dailyTextCol}>
              <Text style={styles.dailyChamber} numberOfLines={1}>
                {item.client_name || 'Client'}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 3, gap: 6 }}>
                <Text style={styles.dailyMetaLine} numberOfLines={1}>
                  {item.chamber_name || 'Chamber'}
                </Text>
                <View style={{ backgroundColor: zone.bg, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1 }}>
                  <Text style={{ fontSize: 9, fontWeight: '800', color: zone.color }}>{zone.type}</Text>
                </View>
              </View>
            </View>
            <View style={styles.totalBoxesCol}>
              <Text style={[styles.totalBoxesValue, outOfStock && styles.outOfStockValue]}>
                {outOfStock ? '0' : totalBoxes}
              </Text>
              <Text style={[styles.totalBoxesLabel, outOfStock && styles.outOfStockLabel]}>
                {outOfStock ? 'out of stock' : 'boxes'}
              </Text>
            </View>
          </View>
        </TouchableOpacity>
      );
    };

    return (
      <>
        <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e2e8f0' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: '#0f172a' }}>Reports</Text>
            <TouchableOpacity onPress={clearReportFilters} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: '#64748b' }}>Clear</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.reportsModeRow}>
            <TouchableOpacity
              style={[styles.reportsModeChip, reportsMode === 'inventory' && styles.reportsModeChipActive]}
              onPress={() => { setReportsMode('inventory'); closeReportFilters(); }}
            >
              <Text style={[styles.reportsModeChipText, reportsMode === 'inventory' && styles.reportsModeChipTextActive]}>
                Inventory
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.reportsModeChip, reportsMode === 'temperature' && styles.reportsModeChipActive]}
              onPress={() => { setReportsMode('temperature'); closeReportFilters(); }}
            >
              <Text style={[styles.reportsModeChipText, reportsMode === 'temperature' && styles.reportsModeChipTextActive]}>
                Temperature
              </Text>
            </TouchableOpacity>
          </View>
        </View>
        <View style={[styles.reportsContentArea, { overflow: 'visible' }]}>
          <View style={[styles.doFilterPanel, { zIndex: 100, elevation: 5, overflow: 'visible' }]}>
            <View style={[styles.doFilterRow, { overflow: 'visible', marginBottom: 0 }]}>
              <View style={{ flex: 1, position: 'relative', minWidth: 0 }}>
                <TouchableOpacity
                  style={reportDdBtn}
                  onPress={() => {
                    setShowReportChamberDropdown(!showReportChamberDropdown);
                    setShowReportClientDropdown(false);
                    setShowReportTypeDropdown(false);
                  }}
                >
                  <Text style={{ fontSize: 11, color: '#1e293b', fontWeight: '700', flex: 1, marginRight: 4 }} numberOfLines={1}>
                    {chamberLabel}
                  </Text>
                  <Ionicons name={showReportChamberDropdown ? 'chevron-up' : 'chevron-down'} size={14} color="#64748b" />
                </TouchableOpacity>
                {showReportChamberDropdown && (
                  <View style={reportDdMenu}>
                    <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {renderDdItem('ch-all', 'All Chambers', reportChamberFilter === 'all' || reportChamberFilter === 'All', () => {
                        setReportChamberFilter('all');
                        setReportClientFilter('All');
                        setShowReportChamberDropdown(false);
                      })}
                      {chambersList.map((ch) =>
                        renderDdItem(`ch-${ch.id}`, ch.name, String(reportChamberFilter) === String(ch.id), () => {
                          setReportChamberFilter(ch.id);
                          setReportClientFilter('All');
                          setShowReportChamberDropdown(false);
                        })
                      )}
                    </ScrollView>
                  </View>
                )}
              </View>

              <View style={{ flex: 1, position: 'relative', minWidth: 0 }}>
                <TouchableOpacity
                  style={reportDdBtn}
                  onPress={() => {
                    setShowReportClientDropdown(!showReportClientDropdown);
                    setShowReportChamberDropdown(false);
                    setShowReportTypeDropdown(false);
                  }}
                >
                  <Text style={{ fontSize: 11, color: '#1e293b', fontWeight: '700', flex: 1, marginRight: 4 }} numberOfLines={1}>
                    {clientLabel}
                  </Text>
                  <Ionicons name={showReportClientDropdown ? 'chevron-up' : 'chevron-down'} size={14} color="#64748b" />
                </TouchableOpacity>
                {showReportClientDropdown && (
                  <View style={reportDdMenu}>
                    <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {renderDdItem('cl-all', 'All Clients', reportClientFilter === 'All' || reportClientFilter === 'all', () => {
                        setReportClientFilter('All');
                        setShowReportClientDropdown(false);
                      })}
                      {reportClientOptions.map((name) =>
                        renderDdItem(`cl-${name}`, name, reportClientFilter === name, () => {
                          setReportClientFilter(name);
                          setShowReportClientDropdown(false);
                        })
                      )}
                    </ScrollView>
                  </View>
                )}
              </View>

              <View style={{ flex: 1, position: 'relative', minWidth: 0 }}>
                <TouchableOpacity
                  style={reportDdBtn}
                  onPress={() => {
                    setShowReportTypeDropdown(!showReportTypeDropdown);
                    setShowReportChamberDropdown(false);
                    setShowReportClientDropdown(false);
                  }}
                >
                  <Text style={{ fontSize: 11, color: '#1e293b', fontWeight: '700', flex: 1, marginRight: 4 }} numberOfLines={1}>
                    {typeLabel}
                  </Text>
                  <Ionicons name={showReportTypeDropdown ? 'chevron-up' : 'chevron-down'} size={14} color="#64748b" />
                </TouchableOpacity>
                {showReportTypeDropdown && (
                  <View style={reportDdMenu}>
                    <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {['all', 'Frozen', 'Chilled', 'Dry', 'Other'].map((zone) =>
                        renderDdItem(
                          `ty-${zone}`,
                          zone === 'all' ? 'All Types' : chamberZoneStyle(zone).type,
                          String(reportTypeFilter) === String(zone),
                          () => {
                            setReportTypeFilter(zone);
                            setShowReportTypeDropdown(false);
                          }
                        )
                      )}
                    </ScrollView>
                  </View>
                )}
              </View>
            </View>
          </View>

          {reportsMode === 'inventory' ? (
            <View style={styles.dailyBanner}>
              <Text style={styles.dailyBannerText}>
                {inventoryReportSummary.lots} lot{inventoryReportSummary.lots === 1 ? '' : 's'}
                {` · ${inventoryReportSummary.totalBoxes} boxes`}
              </Text>
            </View>
          ) : null}

          {reportsMode === 'temperature' ? renderDateSlider() : null}

          {reportsMode === 'temperature' ? (
            isBlockingListLoad(
              chamberReportsLoading,
              reportsRefreshing,
              getFilteredReportLogs().length
            ) ? (
              <View style={styles.reportsCenterState}>
                <ActivityIndicator size="large" color="#003580" />
                <Text style={styles.reportsStateText}>Loading temperature logs…</Text>
              </View>
            ) : chamberReportsError && getFilteredReportLogs().length === 0 ? (
              <View style={styles.reportsCenterState}>
                <Ionicons name="cloud-offline-outline" size={28} color="#dc2626" />
                <Text style={styles.reportsStateText}>{chamberReportsError}</Text>
                <Text style={[styles.reportsStateText, { fontSize: 11, marginTop: 4 }]}>
                  Showing local device logs when available.
                </Text>
                <TouchableOpacity style={styles.reportsRetryBtn} onPress={loadChamberReportLogs}>
                  <Text style={styles.reportsRetryText}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={{ flex: 1 }}>
              <FlatList
                data={getFilteredReportLogs()}
                keyExtractor={(item, idx) =>
                  `${item.server_log_id || item.id || 'log'}-${item.entry_date || 'd'}-${idx}`
                }
                renderItem={({ item }) => {
                  const temp =
                    item.box_temp != null
                      ? `${item.box_temp}°C`
                      : item.chamber_temp != null
                        ? `${item.chamber_temp}°C`
                        : '—';
                  return (
                    <TouchableOpacity
                      style={styles.dailyCard}
                      onPress={() => setSelectedReportLog(item)}
                      activeOpacity={0.85}
                    >
                      <View style={styles.dailyTop}>
                        <View style={styles.dailyTextCol}>
                          <Text style={styles.dailyChamber} numberOfLines={1}>
                            {item.client_name || 'Client'}
                          </Text>
                          <Text style={styles.dailyMetaLine} numberOfLines={1}>
                            {item.chamber_name || 'Chamber'}
                            {item.shift ? ` · ${item.shift}` : ''}
                            {` · ${chamberZoneStyle(resolveReportLotType(item)).type}`}
                          </Text>
                        </View>
                        <View style={styles.totalBoxesCol}>
                          <Text style={styles.totalBoxesValue}>{temp}</Text>
                          <Text style={styles.totalBoxesLabel}>
                            {item.formatted_date || item.entry_date || '—'}
                          </Text>
                        </View>
                      </View>
                    </TouchableOpacity>
                  );
                }}
                contentContainerStyle={styles.reportsListBody}
                refreshControl={
                  <RefreshControl
                    refreshing={reportsRefreshing}
                    onRefresh={() => {
                      setReportsRefreshing(true);
                      Promise.all([loadInventoryReports(), loadChamberReportLogs()]).finally(() =>
                        setReportsRefreshing(false)
                      );
                    }}
                  />
                }
                ListEmptyComponent={
                  <View style={styles.reportsCenterState}>
                    <Ionicons name="thermometer-outline" size={28} color="#94a3b8" />
                    <Text style={styles.reportsStateText}>No temperature logs for selected filters.</Text>
                  </View>
                }
                {...FLATLIST_PERF_PROPS}
              />
              <ListLoadingOverlay
                visible={isSoftListLoad(
                  chamberReportsLoading,
                  reportsRefreshing,
                  getFilteredReportLogs().length
                )}
                label="Updating logs…"
              />
              </View>
            )
          ) : isBlockingListLoad(reportsLoading, reportsRefreshing, filteredInventoryReportRows.length) ? (
            <View style={styles.reportsCenterState}>
              <ActivityIndicator size="large" color="#003580" />
              <Text style={styles.reportsStateText}>Loading inventory…</Text>
            </View>
          ) : reportsError && filteredInventoryReportRows.length === 0 ? (
            <View style={styles.reportsCenterState}>
              <Ionicons name="warning-outline" size={28} color="#dc2626" />
              <Text style={styles.reportsStateText}>{reportsError}</Text>
              <TouchableOpacity style={styles.reportsRetryBtn} onPress={loadInventoryReports}>
                <Text style={styles.reportsRetryText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={{ flex: 1 }}>
              <FlatList
                data={filteredInventoryReportRows}
                keyExtractor={(item, idx) =>
                  `${item.client_name || 'c'}-${item.warehouse_name || 'w'}-${item.chamber_name || 'ch'}-${idx}`
                }
                renderItem={renderInventoryItem}
                contentContainerStyle={styles.reportsListBody}
                onEndReachedThreshold={0.35}
                onEndReached={() => {
                  if (reportHasMore && !reportsLoading && !reportsLoadingMore) {
                    loadInventoryReports('more');
                  }
                }}
                ListFooterComponent={
                  reportsLoadingMore ? (
                    <View style={{ paddingVertical: 14, alignItems: 'center' }}>
                      <ActivityIndicator size="small" color="#003580" />
                      <Text style={{ marginTop: 6, fontSize: 11, color: '#64748b', fontWeight: '600' }}>
                        Loading more…
                      </Text>
                    </View>
                  ) : null
                }
                refreshControl={
                  <RefreshControl
                    refreshing={reportsRefreshing}
                    onRefresh={() => {
                      setReportsRefreshing(true);
                      Promise.all([loadInventoryReports('reset'), loadChamberReportLogs()]).finally(() =>
                        setReportsRefreshing(false)
                      );
                    }}
                  />
                }
                ListEmptyComponent={
                  <View style={styles.reportsCenterState}>
                    <Ionicons name="cube-outline" size={28} color="#94a3b8" />
                    <Text style={styles.reportsStateText}>No inventory for selected filters.</Text>
                  </View>
                }
                {...FLATLIST_PERF_PROPS}
              />
              <ListLoadingOverlay
                visible={isSoftListLoad(
                  reportsLoading,
                  reportsRefreshing,
                  filteredInventoryReportRows.length
                )}
                label="Updating inventory…"
              />
            </View>
          )}
        </View>

        <Modal
          visible={!!selectedInventoryReport}
          transparent={false}
          animationType="slide"
          onRequestClose={closeInventoryReportDetail}
        >
          <SafeAreaView style={{ flex: 1, backgroundColor: '#ffffff' }}>
            <View style={{ flex: 1, paddingBottom: 16 }}>
              <View style={styles.invDetailHead}>
                <View style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                  <Text style={styles.invDetailTitle} numberOfLines={1}>
                    {selectedInventoryReport?.client_name || 'Inventory'}
                  </Text>
                  <Text style={styles.invExcelSub} numberOfLines={1}>
                    {selectedInventoryReport?.warehouse_name || user?.warehouse_name || 'Warehouse'}
                    {selectedInventoryReport?.chamber_name
                      ? ` · ${selectedInventoryReport.chamber_name}`
                      : ''}
                    {selectedInventoryReport
                      ? ` · ${chamberZoneStyle(resolveReportLotType(selectedInventoryReport)).type}`
                      : ''}
                  </Text>
                </View>
                <TouchableOpacity onPress={closeInventoryReportDetail}>
                  <Ionicons name="close" size={22} color="#334155" />
                </TouchableOpacity>
              </View>

              {(() => {
                const readingTotal = latestReadingQty(inventoryHistory);
                const totalBoxes =
                  readingTotal != null
                    ? readingTotal
                    : getDoLotTotalBoxes(selectedInventoryReport);
                const outOfStock = totalBoxes === 0;
                return (
                  <View
                    style={[
                      styles.totalBoxesBanner,
                      outOfStock && styles.totalBoxesBannerEmpty
                    ]}
                  >
                    <Ionicons
                      name={outOfStock ? 'alert-circle-outline' : 'cube-outline'}
                      size={16}
                      color={outOfStock ? '#dc2626' : '#003580'}
                    />
                    <Text
                      style={[
                        styles.totalBoxesBannerText,
                        outOfStock && styles.totalBoxesBannerTextEmpty
                      ]}
                    >
                      {outOfStock
                        ? 'Out of stock · Total boxes 0'
                        : `Total boxes · ${totalBoxes}`}
                    </Text>
                  </View>
                );
              })()}

              {/* Date Filter Bar */}
              <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 14,
                paddingVertical: 10,
                backgroundColor: '#f8fafc',
                borderBottomWidth: 1,
                borderBottomColor: '#e2e8f0',
                gap: 8,
                zIndex: 10
              }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#64748b' }}>Date:</Text>
                
                {/* From Date Button */}
                <TouchableOpacity
                  style={{
                    flex: 1,
                    height: 34,
                    backgroundColor: '#ffffff',
                    borderWidth: 1,
                    borderColor: '#cbd5e1',
                    borderRadius: 6,
                    paddingHorizontal: 8,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}
                  onPress={() => {
                    setDetailCalendarPickMode('from');
                    setDetailCalendarMonth(detailDateFrom ? new Date(detailDateFrom) : new Date());
                    setDetailCalendarOpen(true);
                  }}
                >
                  <Text style={{ fontSize: 11, color: detailDateFrom ? '#0f172a' : '#94a3b8', fontWeight: detailDateFrom ? 'bold' : 'normal' }}>
                    {detailDateFrom ? detailDateFrom : 'From Date'}
                  </Text>
                  <Ionicons name="calendar-outline" size={12} color="#64748b" />
                </TouchableOpacity>

                <Text style={{ fontSize: 11, color: '#64748b' }}>to</Text>

                {/* To Date Button */}
                <TouchableOpacity
                  style={{
                    flex: 1,
                    height: 34,
                    backgroundColor: '#ffffff',
                    borderWidth: 1,
                    borderColor: '#cbd5e1',
                    borderRadius: 6,
                    paddingHorizontal: 8,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}
                  onPress={() => {
                    setDetailCalendarPickMode('to');
                    setDetailCalendarMonth(detailDateTo ? new Date(detailDateTo) : new Date());
                    setDetailCalendarOpen(true);
                  }}
                >
                  <Text style={{ fontSize: 11, color: detailDateTo ? '#0f172a' : '#94a3b8', fontWeight: detailDateTo ? 'bold' : 'normal' }}>
                    {detailDateTo ? detailDateTo : 'To Date'}
                  </Text>
                  <Ionicons name="calendar-outline" size={12} color="#64748b" />
                </TouchableOpacity>

                {/* Clear Date Filter Button */}
                {(detailDateFrom || detailDateTo) ? (
                  <TouchableOpacity
                    style={{
                      height: 34,
                      justifyContent: 'center',
                      paddingHorizontal: 10,
                      borderRadius: 6,
                      borderWidth: 1,
                      borderColor: '#cbd5e1',
                      backgroundColor: '#f1f5f9'
                    }}
                    onPress={() => {
                      setDetailDateFrom('');
                      setDetailDateTo('');
                    }}
                  >
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#ef4444' }}>Clear</Text>
                  </TouchableOpacity>
                ) : null}
              </View>

              <View style={styles.invExcelHead}>
                <Text style={[styles.invExcelHeadCell, styles.invExcelColDate]}>Date</Text>
                <Text style={[styles.invExcelHeadCell, styles.invExcelColTime]}>Time</Text>
                <Text style={[styles.invExcelHeadCell, styles.invExcelColTemp]}>Temp</Text>
                <Text style={[styles.invExcelHeadCell, styles.invExcelColIn]}>In</Text>
                <Text style={[styles.invExcelHeadCell, styles.invExcelColOut]}>Out</Text>
                <Text style={[styles.invExcelHeadCell, styles.invExcelColQty]}>Left</Text>
              </View>

              {inventoryHistoryLoading ? (
                <View style={styles.reportsCenterState}>
                  <ActivityIndicator size="large" color="#003580" />
                  <Text style={styles.reportsStateText}>Loading day records…</Text>
                </View>
              ) : inventoryHistoryError ? (
                <View style={styles.reportsCenterState}>
                  <Ionicons name="warning-outline" size={28} color="#dc2626" />
                  <Text style={styles.reportsStateText}>{inventoryHistoryError}</Text>
                  <TouchableOpacity
                    style={styles.reportsRetryBtn}
                    onPress={() =>
                      selectedInventoryReport && openInventoryReportDetail(selectedInventoryReport)
                    }
                  >
                    <Text style={styles.reportsRetryText}>Retry</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                (() => {
                  const filteredHistory = inventoryHistory.filter(row => {
                    const dateLabel = String(row.formatted_date || row.entry_date || '').slice(0, 10);
                    if (detailDateFrom && dateLabel < detailDateFrom) return false;
                    if (detailDateTo && dateLabel > detailDateTo) return false;
                    return true;
                  });

                  return (
                    <ScrollView>
                      {filteredHistory.length === 0 ? (
                        <View style={styles.reportsCenterState}>
                          <Text style={styles.reportsStateText}>No logs found for chosen dates.</Text>
                        </View>
                      ) : (
                        filteredHistory.map((row, idx) => {
                          const dateLabel =
                            String(row.formatted_date || row.entry_date || '').slice(0, 10) || '—';
                          const timeLabel = formatInventoryReportTime(row);
                          const temp =
                            row.box_temp != null
                              ? `${row.box_temp}°C`
                              : row.chamber_temp != null
                                ? `${row.chamber_temp}°C`
                                : '—';
                          const qty = row._qty != null ? row._qty : null;
                          const inQty = row._inQty != null ? row._inQty : '—';
                          const outQty = row._outQty != null ? row._outQty : '—';
                          return (
                            <TouchableOpacity
                              key={String(row.id || `${dateLabel}-${idx}`)}
                              style={[styles.invExcelRow, idx % 2 === 1 && styles.invExcelRowAlt]}
                              onPress={() => setSelectedReportLog(row)}
                              activeOpacity={0.85}
                            >
                              <Text style={[styles.invExcelCell, styles.invExcelColDate]} numberOfLines={1}>
                                {dateLabel}
                              </Text>
                              <Text style={[styles.invExcelCell, styles.invExcelColTime]} numberOfLines={1}>
                                {timeLabel}
                              </Text>
                              <Text style={[styles.invExcelCell, styles.invExcelColTemp]} numberOfLines={1}>
                                {temp}
                              </Text>
                              <Text
                                style={[
                                  styles.invExcelCell,
                                  styles.invExcelColIn,
                                  inQty !== '—' && inQty !== '0' && { color: '#059669', fontWeight: '800' }
                                ]}
                                numberOfLines={1}
                              >
                                {inQty}
                              </Text>
                              <Text
                                style={[
                                  styles.invExcelCell,
                                  styles.invExcelColOut,
                                  outQty !== '—' && outQty !== '0' && { color: '#dc2626', fontWeight: '800' }
                                ]}
                                numberOfLines={1}
                              >
                                {outQty}
                              </Text>
                              <Text
                                style={[styles.invExcelCell, styles.invExcelColQty, { fontWeight: '800' }]}
                                numberOfLines={1}
                              >
                                {qty == null ? '—' : qty}
                              </Text>
                            </TouchableOpacity>
                          );
                        })
                      )}
                    </ScrollView>
                  );
                })()
              )}
            </View>
            {renderDetailCalendarModal()}
          </SafeAreaView>
        </Modal>
      </>
    );
  };

  // Customer-style full log / task details (from inventory day row)
  const renderReportLogDetailModal = () => {
    if (!selectedReportLog) return null;
    const item = selectedReportLog;
    const imagePath = pickDoLogImage(item);
    const detailFields = [
      ['Client', item.client_name],
      ['Warehouse', item.warehouse_name || user?.warehouse_name],
      ['Chamber', item.chamber_name],
      ['Chamber type', item.chamber_type],
      ['Shift', item.shift],
      ['Inspection time', item.inspection_time],
      ['Date', item.formatted_date || item.entry_date],
      [
        'Temperature',
        item.box_temp != null
          ? `${item.box_temp}°C`
          : item.chamber_temp != null
            ? `${item.chamber_temp}°C`
            : null
      ],
      [
        'Box qty',
        item.box_count != null && item.box_count !== '' ? `${item.box_count} boxes` : null
      ],
      ['Supervisor', item.monitor_supervisor_name],
      ['Operator', item.operator_email || user?.email],
      ['Reference', item.reference_no],
      [
        'Time variance',
        item.time_variance_minutes != null ? `${item.time_variance_minutes} min` : null
      ],
      ['Remarks', item.remarks],
      [
        'Updates',
        item.update_count != null && Number(item.update_count) > 0
          ? String(item.update_count)
          : null
      ],
      [
        'Sync',
        item.sync_status
          ? item.sync_status === 'synced'
            ? 'Synced'
            : 'Pending sync'
          : null
      ]
    ];

    const tempText =
      item.box_temp != null
        ? `${item.box_temp}°C`
        : item.chamber_temp != null
          ? `${item.chamber_temp}°C`
          : '—';

    const renderDetailRow = (label, value) => {
      if (value == null || value === '') return null;
      return (
        <View style={styles.doLogDetailRow} key={label}>
          <Text style={styles.doLogDetailLabel}>{label}</Text>
          <Text style={styles.doLogDetailValue}>{String(value)}</Text>
        </View>
      );
    };

    return (
      <Modal
        visible={Boolean(selectedReportLog)}
        animationType="slide"
        onRequestClose={() => setSelectedReportLog(null)}
      >
        <SafeAreaView style={styles.doDetailSafe}>
          <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
          <View style={styles.doDetailHeader}>
            <TouchableOpacity
              style={styles.doDetailBackBtn}
              onPress={() => setSelectedReportLog(null)}
              activeOpacity={0.85}
            >
              <Ionicons name="arrow-back" size={22} color="#0f172a" />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={styles.doDetailTitle} numberOfLines={1}>
                Log details
              </Text>
              <Text style={styles.doDetailSub} numberOfLines={1}>
                {item.client_name || 'Client'}
              </Text>
            </View>
          </View>

          <ScrollView contentContainerStyle={styles.doDetailBody} showsVerticalScrollIndicator={false}>
            <View style={styles.doDetailHeroCard}>
              <Text style={styles.doDetailHeroTemp}>{tempText}</Text>
              <Text style={styles.doDetailHeroMeta}>
                {item.box_count != null && item.box_count !== ''
                  ? `${item.box_count} boxes`
                  : 'Box qty —'}
                {item.shift ? ` · ${item.shift}` : ''}
              </Text>
            </View>

            <View style={styles.doDetailCard}>
              {detailFields.map(([label, value]) => renderDetailRow(label, value))}
            </View>

            <View style={styles.doDetailCard}>
              <Text style={styles.doDetailSectionTitle}>Sensor photo</Text>
              <DoSensorPhotoView rawPath={imagePath} apiUrl={apiUrl} />
              <GpsDetailRow
                label="Photo location (GPS)"
                lat={item.photo_capture_latitude}
                lng={item.photo_capture_longitude}
                accuracy={item.photo_capture_accuracy}
              />
              {item.photo_capture_time
                ? renderDetailRow('Photo capture time', item.photo_capture_time)
                : null}
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    );
  };

  const renderMoreView = () => {
    const profileRows = [
      { label: 'Role', value: 'Data Operator' },
      { label: 'Full Name', value: user?.full_name || displayName || '—' },
      { label: 'Email', value: user?.email || '—' },
      { label: 'Phone', value: user?.phone_no || '—' },
      { label: 'Warehouse', value: user?.warehouse_name || '—' },
      { label: 'Warehouse Code', value: user?.warehouse_code || '—' },
      { label: 'Chamber Limit', value: String(chamberLimit) },
      {
        label: 'Total Clients',
        value: profileClientsLoading
          ? '…'
          : String(
              profileClientsTotal != null ? profileClientsTotal : totalClientsCount
            )
      }
    ];
    const chevronRotate = moreProfileChevron.interpolate({
      inputRange: [0, 1],
      outputRange: ['0deg', '180deg']
    });

    return (
      <ScrollView contentContainerStyle={styles.moreContainer} showsVerticalScrollIndicator={false}>
        <View style={styles.moreSectionCard}>
          <TouchableOpacity
            style={styles.moreProfileHeader}
            onPress={toggleMoreProfile}
            activeOpacity={0.85}
          >
            <View style={styles.profileAvatar}>
              <Ionicons name="person" size={32} color="#003580" />
            </View>
            <View style={[styles.profileMeta, { flex: 1 }]}>
              <Text style={styles.profileName}>{displayName}</Text>
              <Text style={styles.profileRole}>Data Operator</Text>
              <Text style={styles.profileEmail}>{user.email || 'operator@reeferon.com'}</Text>
            </View>
            <Animated.View style={{ transform: [{ rotate: chevronRotate }] }}>
              <Ionicons name="chevron-down" size={22} color="#64748b" />
            </Animated.View>
          </TouchableOpacity>

          {moreProfileOpen ? (
            <Animated.View
              style={[
                styles.moreProfileDropBody,
                { opacity: moreProfileAnim }
              ]}
            >
              {profileRows.map((row, idx) => (
                <View
                  key={row.label}
                  style={[
                    styles.doProfileRow,
                    idx === profileRows.length - 1 && {
                      borderBottomWidth: 0,
                      marginBottom: 0,
                      paddingBottom: 0
                    }
                  ]}
                >
                  <Text style={styles.doProfileLabel}>{row.label}</Text>
                  <Text style={styles.doProfileValue} numberOfLines={2}>
                    {row.value}
                  </Text>
                </View>
              ))}
            </Animated.View>
          ) : null}
        </View>

        <View style={styles.moreSectionCard}>
          <Text style={styles.moreSectionTitle}>Synchronization Engine</Text>
          <View style={styles.syncStatusRow}>
            <Text style={styles.syncStatusLabel}>Sync Queue Status:</Text>
            <View style={[
              styles.syncStatusBadge,
              {
                backgroundColor:
                  syncStatus === 'failed'
                    ? '#fef2f2'
                    : syncStatus === 'partial'
                      ? '#fff7ed'
                      : syncPendingCount > 0
                        ? '#fff7ed'
                        : '#f0fdf4'
              }
            ]}>
              <Text style={[
                styles.syncStatusText,
                {
                  color:
                    syncStatus === 'failed'
                      ? '#dc2626'
                      : syncStatus === 'partial'
                        ? '#c2410c'
                        : syncPendingCount > 0
                          ? '#c2410c'
                          : '#16a34a'
                }
              ]}>
                {syncStatus === 'syncing'
                  ? 'Syncing…'
                  : syncStatus === 'failed'
                    ? `Sync failed · ${syncPendingCount} pending`
                    : syncStatus === 'partial'
                      ? `Partial sync · ${syncPendingCount} left`
                      : syncPendingCount > 0
                        ? `${syncPendingCount} item(s) pending`
                        : 'All Synced'}
              </Text>
            </View>
          </View>

          {syncStatus === 'failed' || syncStatus === 'partial' ? (
            <Text style={{ fontSize: 11, color: '#64748b', marginBottom: 8, marginTop: -4 }}>
              {syncMessage || 'Offline data is still on this phone. Tap Sync Now when network is stable.'}
            </Text>
          ) : syncMessage ? (
            <Text style={{ fontSize: 11, color: '#64748b', marginBottom: 8, marginTop: -4 }}>
              {syncMessage}
            </Text>
          ) : null}

          {syncFailures.length > 0 ? (
            <View style={{ marginBottom: 10 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: '#b45309', marginBottom: 4 }}>
                Upload issues (latest)
              </Text>
              {syncFailures.slice(0, 4).map((f, idx) => (
                <Text key={`${f.type}-${idx}`} style={{ fontSize: 10, color: '#64748b', marginBottom: 2 }} numberOfLines={2}>
                  • {f.label}: {f.message}
                </Text>
              ))}
            </View>
          ) : null}

          <Text style={{ fontSize: 10, color: '#94a3b8', marginBottom: 8 }}>
            Last successful sync: {formatLastSyncLabel(lastSyncAt)}
          </Text>

          {syncStatus === 'syncing' ? (
            <View style={styles.syncSpinnerContainer}>
              <ActivityIndicator size="small" color="#003580" />
              <Text style={styles.syncSpinnerText}>Uploading offline queue to server...</Text>
            </View>
          ) : (
            <TouchableOpacity 
              style={[styles.syncActionBtn, syncPendingCount === 0 && styles.syncActionBtnDisabled]} 
              disabled={syncPendingCount === 0}
              onPress={() => triggerSync(apiUrl, token, handleSyncProgress, user)}
            >
              <Ionicons name="cloud-upload" size={18} color="#ffffff" style={{ marginRight: 6 }} />
              <Text style={styles.syncActionBtnText}>Upload Local Queue Now</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.moreSectionCard}>
          <View style={styles.moreSectionTitleRow}>
            <Text style={[styles.moreSectionTitle, { marginBottom: 0, flex: 1 }]}>Master Setup</Text>
            <TouchableOpacity
              style={styles.moreMasterAddBtn}
              onPress={openMasterManager}
              activeOpacity={0.85}
            >
              <Ionicons name="add" size={22} color="#ffffff" />
            </TouchableOpacity>
          </View>
          <Text style={styles.ipSettingsDesc}>Add chambers and manage client names for each chamber separately.</Text>
          <TouchableOpacity 
            style={[styles.ipUpdateActionBtn, styles.moreMasterOpenBtn]}
            onPress={openMasterManager}
          >
            <Ionicons name="cube-outline" size={16} color="#ffffff" style={{ marginRight: 6 }} />
            <Text style={[styles.ipUpdateActionBtnText, { color: '#ffffff' }]}>Open Master Setup</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.moreSectionCard}>
          <Text style={styles.moreSectionTitle}>Reports</Text>
          <Text style={styles.ipSettingsDesc}>Open any report from here without switching sections first.</Text>

          <TouchableOpacity
            style={styles.moreReportRow}
            onPress={() => handleNavTabChange('Reports', 'daily')}
            activeOpacity={0.85}
          >
            <View style={[styles.moreReportIcon, { backgroundColor: '#eff6ff' }]}>
              <Ionicons name="clipboard-outline" size={18} color="#003580" />
            </View>
            <View style={styles.moreReportMeta}>
              <Text style={styles.moreReportTitle}>Task Reports</Text>
              <Text style={styles.moreReportSub}>Daily chamber temperature reports</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#94a3b8" />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.moreReportRow}
            onPress={() => handleNavTabChange('InwardReports', 'inwards')}
            activeOpacity={0.85}
          >
            <View style={[styles.moreReportIcon, { backgroundColor: '#f0fdfa' }]}>
              <Ionicons name="download-outline" size={18} color="#0D9488" />
            </View>
            <View style={styles.moreReportMeta}>
              <Text style={styles.moreReportTitle}>Inward Reports</Text>
              <Text style={styles.moreReportSub}>Receiving & unloading history</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#94a3b8" />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.moreReportRow, { marginBottom: 0 }]}
            onPress={() => handleNavTabChange('OutwardReports', 'outwards')}
            activeOpacity={0.85}
          >
            <View style={[styles.moreReportIcon, { backgroundColor: '#fff7ed' }]}>
              <View style={{ transform: [{ rotate: '180deg' }] }}>
                <Ionicons name="download-outline" size={18} color="#d97706" />
              </View>
            </View>
            <View style={styles.moreReportMeta}>
              <Text style={styles.moreReportTitle}>Outward Reports</Text>
              <Text style={styles.moreReportSub}>Loading & dispatch history</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#94a3b8" />
          </TouchableOpacity>
        </View>

        <View style={styles.appInfoBox}>
          <Text style={styles.appInfoText}>ReeferON Mobile Client</Text>
          <Text style={styles.appInfoVersion}>Version 1.1.0 (SQLite Active)</Text>
        </View>

        <TouchableOpacity style={styles.moreLogoutBtn} onPress={handleLogout}>
          <Ionicons name="log-out" size={20} color="#ffffff" style={{ marginRight: 8 }} />
          <Text style={styles.moreLogoutBtnText}>Logout</Text>
        </TouchableOpacity>

        <View style={{ height: 100 }} />
      </ScrollView>
    );
  };

  // ==========================================
  // MODALS
  // ==========================================

  // UNIFIED TASK PROFILE & INSPECTION ENTRY FORM MODAL (VERTICAL LAYOUT WITH CHAMBER SELECTOR)
  const renderTaskProfileModal = () => {
    const activePattern = (() => {
      if (selectedChamberType === 'Frozen') {
        return { type: 'Frozen', defaultTemp: -20.0, icon: 'snow', color: '#0284c7', bg: '#e0f2fe' };
      } else if (selectedChamberType === 'Chilled') {
        return { type: 'Chilled', defaultTemp: 2.0, icon: 'thermometer', color: '#0d9488', bg: '#ccfbf1' };
      } else if (selectedChamberType === 'Dry') {
        return { type: 'Dry', defaultTemp: 18.0, icon: 'leaf', color: '#16a34a', bg: '#dcfce7' };
      } else {
        return { type: 'Other', defaultTemp: 25.0, icon: 'options', color: '#64748b', bg: '#f1f5f9' };
      }
    })();

    let hasWarning = false;
    if (tempInput) {
      const tempVal = parseFloat(tempInput);
      if (!isNaN(tempVal)) {
        if (selectedChamberType === 'Frozen' && tempVal > -18) hasWarning = true;
        if (selectedChamberType === 'Chilled' && (tempVal < -5 || tempVal > 5)) hasWarning = true;
        if (selectedChamberType === 'Dry' && (tempVal < 15 || tempVal > 25)) hasWarning = true;
        // 'Other' type has no alert constraints
      }
    }

    return (
      <Modal
        visible={showLogModal}
        animationType="slide"
        transparent={false}
        onRequestClose={handleCloseModal}
      >
        <SafeAreaView style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>
                  {isProfileEditable
                    ? (editingExistingLog ? 'Edit Chamber Inspection' : 'Record Chamber Inspection')
                    : 'Task Profile Details'}
                </Text>
                <Text style={styles.modalSubtitle}>
                  {selectedChamber ? `${selectedChamber.name} Profile` : 'Chamber Entry Form'}
                </Text>
              </View>
              <TouchableOpacity onPress={handleCloseModal}>
                <Ionicons name="close-circle-outline" size={26} color="#64748b" />
              </TouchableOpacity>
            </View>

            <ScrollView
              contentContainerStyle={{ paddingVertical: 10, paddingBottom: 40 }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              
              {/* Dynamic Chamber Classification Header Card */}
              {selectedChamber && (
                <View style={[
                  styles.chamberHeaderCard,
                  { backgroundColor: activePattern.bg, borderColor: activePattern.color }
                ]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={[styles.chamberHeaderIconCircle, { backgroundColor: activePattern.color }]}>
                      <Ionicons name={activePattern.icon === 'snow' ? 'snow' : activePattern.icon} size={18} color="#ffffff" />
                    </View>
                    <View style={{ marginLeft: 10 }}>
                      <Text style={[styles.chamberHeaderTitle, { color: '#0f172a' }]}>
                        Chamber - {getChamberDisplayNo(selectedChamber)}
                      </Text>
                      <Text style={{ fontSize: 11, color: '#64748b', fontWeight: 'bold', marginTop: 2 }}>
                        Compliance: {selectedChamberType} | Target: {selectedChamberType === 'Frozen' ? '≤ -18.0°C' : selectedChamberType === 'Chilled' ? '-5.0°C to 5.0°C' : '> 0.0°C'}
                      </Text>
                    </View>
                  </View>
                </View>
              )}

              {/* Compliance banner for read-only mode */}
              {!isProfileEditable && (
                <View style={[
                  styles.detailStatusBar,
                  { backgroundColor: !hasWarning ? '#dcfce7' : '#fee2e2', marginHorizontal: 0, marginBottom: 15 }
                ]}>
                  <Ionicons 
                    name={!hasWarning ? "checkmark-circle" : "alert-circle"} 
                    size={20} 
                    color={!hasWarning ? "#16a34a" : "#ef4444"} 
                    style={{ marginRight: 8 }}
                  />
                  <Text style={[
                    styles.detailStatusText,
                    { color: !hasWarning ? "#15803d" : "#b91c1c" }
                  ]}>
                    {!hasWarning ? "Temperature Compliance Safe" : "Out-of-Range Temperature warning!"}
                  </Text>
                </View>
              )}

              {/* Main Body - Row Layout: Left side fields, Right side image */}
              {/* Vertical Stack Form Design */}
              <View style={{ paddingHorizontal: 4 }}>
                
                {/* Chamber Dropdown Selector (FAB '+') — inline list (not absolute) so Android does not clip */}
                {openedFromFab && isProfileEditable && (
                  <View style={{ marginBottom: 12, zIndex: 20 }}>
                    <Text style={styles.modalLabel}>Select Chamber</Text>
                    <TouchableOpacity 
                      style={styles.dropdownTrigger} 
                      onPress={() => {
                        setShowClientDropdown(false);
                        setShowChamberDropdown(!showChamberDropdown);
                      }}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.dropdownTriggerText, !selectedChamber && { color: '#94a3b8' }]}>
                        {selectedChamber?.name || 'Select Chamber...'}
                      </Text>
                      <Ionicons name={showChamberDropdown ? 'chevron-up' : 'chevron-down'} size={18} color="#64748b" />
                    </TouchableOpacity>

                    {showChamberDropdown && (
                      <View style={styles.dropdownListInline}>
                        {chambersList.length === 0 ? (
                          <Text style={{ padding: 12, fontSize: 12, color: '#94a3b8' }}>
                            No chambers available (limit: {chamberLimit}). Create chambers / assignments first.
                          </Text>
                        ) : (
                          chambersList.map(ch => (
                            <TouchableOpacity 
                              key={ch.id} 
                              style={[
                                styles.dropdownItem,
                                selectedChamber?.id === ch.id && { backgroundColor: '#eff6ff' }
                              ]} 
                              onPress={() => {
                                setSelectedChamber(ch);
                                setShowChamberDropdown(false);
                                setSelectedClient(null);
                                setSelectedChamberType(getChamberTypeAndDefault(ch.id).type);
                              }}
                            >
                              <Text style={styles.dropdownItemText}>{ch.name}</Text>
                            </TouchableOpacity>
                          ))
                        )}
                      </View>
                    )}
                  </View>
                )}

                {/* Shift Selector (Read Only) */}
                <View style={{ marginBottom: 12 }}>
                  <Text style={styles.modalLabel}>Task Time (Task Slot)</Text>
                  <View style={styles.readOnlyField}>
                    <Text style={[
                      styles.readOnlyText,
                      {
                        fontWeight: '800',
                        color: selectedShift === '10:00' ? '#ca8a04' : '#2563eb'
                      }
                    ]}>
                      {selectedShift === '10:00' ? 'Morning Task' : 'Evening Task'}
                    </Text>
                  </View>
                </View>

                {/* Client Lot Name — locked on edit (cannot change client) */}
                <View style={{ marginBottom: 12, zIndex: 10 }}>
                    <Text style={styles.modalLabel}>Client Lot Name</Text>
                    {editingExistingLog ? (
                      <View style={styles.readOnlyField}>
                        <Text style={styles.readOnlyText} numberOfLines={1}>
                          {selectedClient || editingExistingLog.client_name || '-'}
                        </Text>
                      </View>
                    ) : isProfileEditable ? (
                      <>
                        <TouchableOpacity 
                          style={[styles.dropdownTrigger, !selectedChamber && styles.dropdownDisabled, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10 }]} 
                          disabled={!selectedChamber}
                          onPress={() => {
                            if (!selectedChamber) return;
                            setShowChamberDropdown(false);
                            setShowClientDropdown(!showClientDropdown);
                          }}
                          activeOpacity={0.8}
                        >
                          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                            <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center', marginRight: 8 }}>
                              <Ionicons name="briefcase-outline" size={12} color="#475569" />
                            </View>
                            <Text style={[styles.dropdownTriggerText, !selectedClient && { color: '#94a3b8' }, { fontSize: 13, fontWeight: '700' }]} numberOfLines={1}>
                              {selectedClient || (selectedChamber ? 'Select Client Lot...' : 'Select Chamber first')}
                            </Text>
                            {selectedChamber && selectedClient && isClientCompletedToday(selectedChamber.id, selectedClient, selectedShift) && (
                              <View style={[styles.completedBadgePill, { flexDirection: 'row', alignItems: 'center', marginLeft: 8, paddingVertical: 1, paddingHorizontal: 6, backgroundColor: '#e2f0d9' }]}>
                                <Ionicons name="checkmark-circle" size={10} color="#385723" style={{ marginRight: 2 }} />
                                <Text style={[styles.completedBadgeText, { color: '#385723', fontSize: 8 }]}>Submitted</Text>
                              </View>
                            )}
                          </View>
                          <Ionicons name={showClientDropdown ? 'chevron-up' : 'chevron-down'} size={16} color="#64748b" />
                        </TouchableOpacity>

                        {showClientDropdown && selectedChamber && (
                          <View style={[styles.dropdownListInline, { maxHeight: 220 }]}>
                            <ScrollView
                              nestedScrollEnabled
                              keyboardShouldPersistTaps="handled"
                              showsVerticalScrollIndicator
                              style={{ maxHeight: 220 }}
                            >
                            {(() => {
                              const ordered = getClientsForChamber(selectedChamber.id);

                              if (ordered.length === 0) {
                                return (
                                  <Text style={{ padding: 12, fontSize: 12, color: '#94a3b8' }}>
                      No clients on this chamber yet. Open Master Setup → Clients to add client names for this chamber.
                                  </Text>
                                );
                              }

                              return ordered.map((item) => {
                                const isSelected = selectedClient === item.client_name;
                                const isCompleted = isClientCompletedToday(
                                  selectedChamber.id,
                                  item.client_name,
                                  selectedShift
                                );
                                const isLockedCompleted = isCompleted && !editingExistingLog;
                                return (
                                  <View
                                    key={item.client_name}
                                    style={{
                                      flexDirection: 'row',
                                      alignItems: 'center',
                                      borderBottomWidth: 1,
                                      borderBottomColor: '#f1f5f9',
                                      backgroundColor: isLockedCompleted
                                        ? '#f0fdf4'
                                        : isSelected
                                          ? '#eff6ff'
                                          : '#ffffff',
                                      opacity: isLockedCompleted ? 0.85 : 1
                                    }}
                                  >
                                    <TouchableOpacity
                                      style={{
                                        flex: 1,
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        paddingHorizontal: 10,
                                        paddingVertical: 10
                                      }}
                                      activeOpacity={isLockedCompleted ? 1 : 0.7}
                                      disabled={isLockedCompleted}
                                      onPress={() => {
                                        if (isLockedCompleted) return;
                                        handleSelectClientPill(item.client_name);
                                        setShowClientDropdown(false);
                                      }}
                                    >
                                      <Text
                                        style={[
                                          styles.dropdownItemText,
                                          { flex: 1 },
                                          isLockedCompleted && styles.dropdownItemTextDisabled
                                        ]}
                                        numberOfLines={1}
                                      >
                                        {item.client_name}
                                        {isLockedCompleted ? ' (submitted)' : ''}
                                      </Text>
                                      {isLockedCompleted ? (
                                        <Ionicons
                                          name="checkmark-circle"
                                          size={16}
                                          color="#16a34a"
                                          style={{ marginLeft: 6 }}
                                        />
                                      ) : isSelected ? (
                                        <Ionicons
                                          name="checkmark"
                                          size={16}
                                          color="#003580"
                                          style={{ marginLeft: 6 }}
                                        />
                                      ) : null}
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                      style={{
                                        paddingHorizontal: 12,
                                        paddingVertical: 10,
                                        justifyContent: 'center',
                                        alignItems: 'center'
                                      }}
                                      onPress={() => openDeleteClientFromTaskForm(item.client_name)}
                                      accessibilityLabel={`Delete ${item.client_name}`}
                                    >
                                      <Ionicons name="trash-outline" size={16} color="#dc2626" />
                                    </TouchableOpacity>
                                  </View>
                                );
                              });
                            })()}
                            </ScrollView>
                          </View>
                        )}

                        {selectedChamber && (
                          <TouchableOpacity
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              justifyContent: 'center',
                              paddingVertical: 8,
                              marginTop: 6,
                              backgroundColor: '#f8fafc',
                              borderWidth: 1,
                              borderColor: '#e2e8f0',
                              borderRadius: 8,
                              borderStyle: 'dashed'
                            }}
                            activeOpacity={0.8}
                            onPress={() => {
                              setInlineClientInput('');
                              setInlineRemarkInput('');
                              setShowAddClientModal(true);
                            }}
                          >
                            <Ionicons name="add-circle" size={14} color="#64748b" style={{ marginRight: 4 }} />
                            <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#64748b' }}>
                              Add New Client Lot
                            </Text>
                          </TouchableOpacity>
                        )}
                      </>
                    ) : (
                      <View style={styles.readOnlyField}>
                        <Text style={styles.readOnlyText} numberOfLines={1}>{selectedClient}</Text>
                      </View>
                    )}
                </View>

                {/* Temperature and Box Qty inputs Side-by-Side */}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
                  
                  {/* Left: Box Temp */}
                  <View style={{ flex: 1.1, marginRight: 8 }}>
                    <Text style={styles.modalLabel}>Box Temp Reading (°C)</Text>
                    {isProfileEditable ? (
                      <>
                        <View style={styles.inputWrapper}>
                          <Ionicons name="thermometer-outline" size={16} color="#64748b" style={styles.inputIcon} />
                          <TextInput
                            style={styles.input}
                            placeholder="e.g. -22.5"
                            placeholderTextColor="#94a3b8"
                            keyboardType="numeric"
                            value={tempInput}
                            onChangeText={handleTempInputChange}
                          />
                        </View>
                        {selectedChamber && (
                          <Text style={{ fontSize: 9, color: '#475569', marginTop: 4, marginLeft: 2, fontWeight: '600' }}>
                            Target: {selectedChamberType === 'Frozen' ? '≤ -18.0°C (Frozen)' : selectedChamberType === 'Chilled' ? '-5.0°C to 5.0°C (Chilled)' : selectedChamberType === 'Dry' ? '15.0°C to 25.0°C (Dry)' : 'No compliance limit'}
                          </Text>
                        )}
                      </>
                    ) : (
                      <View style={[styles.readOnlyField, { borderLeftWidth: 4, borderLeftColor: hasWarning ? '#ef4444' : '#16a34a' }]}>
                        <Text style={[styles.readOnlyText, { fontWeight: 'bold', color: hasWarning ? '#ef4444' : '#16a34a' }]}>
                          {tempInput}°C
                        </Text>
                      </View>
                    )}
                  </View>

                  {/* Right: Box Qty */}
                  <View style={{ flex: 0.9, marginLeft: 8 }}>
                    <Text style={styles.modalLabel}>Box Qty (Count)</Text>
                    {isProfileEditable ? (
                      <>
                        <View style={styles.inputWrapper}>
                          <Ionicons name="cube-outline" size={16} color="#64748b" style={styles.inputIcon} />
                          <TextInput
                            style={styles.input}
                            placeholder="e.g. 150"
                            placeholderTextColor="#94a3b8"
                            keyboardType="numeric"
                            value={boxCountInput}
                            onChangeText={(text) => {
                              // Digits only — box qty can never go negative
                              const cleaned = String(text || '').replace(/[^\d]/g, '');
                              setBoxCountInput(cleaned);
                            }}
                          />
                        </View>

                      </>
                    ) : (
                      <View style={styles.readOnlyField}>
                        <Text style={styles.readOnlyText}>{boxCountInput || '0'} boxes</Text>
                      </View>
                    )}
                  </View>

                </View>

                {/* Sensor Photo Capture Section (Stacked below) */}
                <View style={{ marginBottom: 12 }}>
                  <Text style={styles.modalLabel}>Sensor Verification Photo</Text>
                  
                  {isProfileEditable ? (
                    capturedImage ? (
                      <View style={{ width: '100%' }}>
                        <View style={styles.verticalPhotoWrapper}>
                          <TouchableOpacity
                            activeOpacity={0.9}
                            onPress={() =>
                              setImagePreview({ uri: capturedImage, label: 'Sensor Verification Photo' })
                            }
                          >
                            <Image source={{ uri: capturedImage }} style={styles.verticalPhotoPreview} />
                          </TouchableOpacity>
                          <TouchableOpacity 
                            style={styles.verticalRetakeBtn}
                            onPress={handleLaunchCamera}
                          >
                            <Ionicons name="camera-reverse" size={14} color="#ffffff" style={{ marginRight: 4 }} />
                            <Text style={{ color: '#ffffff', fontSize: 12, fontWeight: 'bold' }}>Retake Photo</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ) : (
                      <TouchableOpacity 
                        style={styles.verticalCameraBtn}
                        onPress={handleLaunchCamera}
                      >
                        <Ionicons name="camera" size={32} color="#ffffff" />
                        <Text style={styles.verticalCameraBtnText}>Snap Verification Photo</Text>
                        <Text style={{ fontSize: 9, color: '#bfdbfe', marginTop: 2 }}>Must clearly show the temperature sensor reading</Text>
                      </TouchableOpacity>
                    )
                  ) : (
                    capturedImage ? (
                      <TouchableOpacity
                        style={styles.verticalPhotoWrapper}
                        activeOpacity={0.9}
                        onPress={() =>
                          setImagePreview({ uri: capturedImage, label: 'Sensor Verification Photo' })
                        }
                      >
                        <Image source={{ uri: capturedImage }} style={styles.verticalPhotoPreview} />
                      </TouchableOpacity>
                    ) : (
                      <View style={[styles.verticalCameraBtn, { borderWidth: 1, borderStyle: 'solid' }]}>
                        <Ionicons name="image-outline" size={26} color="#cbd5e1" />
                        <Text style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>No Photo Verification Logged</Text>
                      </View>
                    )
                  )}
                </View>

              </View>

              {/* Read-only Metadata Details */}
              {!isProfileEditable && (
                <View style={styles.metaDataCard}>
                  <View style={styles.metaRow}>
                    <Text style={styles.metaLabel}>Warehouse:</Text>
                    <Text style={styles.metaVal}>{logWarehouseName}</Text>
                  </View>
                  <View style={styles.metaRow}>
                    <Text style={styles.metaLabel}>DO Operator:</Text>
                    <Text style={styles.metaVal}>{logOperatorEmail}</Text>
                  </View>
                  <View style={styles.metaRow}>
                    <Text style={styles.metaLabel}>Supervisor:</Text>
                    <Text style={styles.metaVal}>{logOperatorName}</Text>
                  </View>
                  <View style={styles.metaRow}>
                    <Text style={styles.metaLabel}>Logged Date:</Text>
                    <Text style={styles.metaVal}>{logEntryDate}</Text>
                  </View>
                  <View style={styles.metaRow}>
                    <Text style={styles.metaLabel}>Logged Time:</Text>
                    <Text style={styles.metaVal}>{logEntryTime}</Text>
                  </View>
                  <View style={styles.metaRow}>
                    <Text style={styles.metaLabel}>Sync Engine:</Text>
                    <Text style={[styles.metaVal, { color: logSyncStatus === 'synced' ? '#16a34a' : '#ea580c', fontWeight: 'bold' }]}>
                      {logSyncStatus === 'synced' ? 'Synced to Cloud' : 'Queued on Device (Offline)'}
                    </Text>
                  </View>
                </View>
              )}

              {/* Bottom Actions */}
              {isProfileEditable ? (
                <TouchableOpacity
                  style={[
                    styles.submitBtn,
                    editingExistingLog && { backgroundColor: '#ea580c' }
                  ]}
                  onPress={handleSaveInspection}
                >
                  <Text style={styles.submitBtnText}>
                    {editingExistingLog ? 'Update Reading' : 'Submit Reading'}
                  </Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity 
                  style={[styles.submitBtn, { backgroundColor: '#64748b' }]} 
                  onPress={handleCloseModal}
                >
                  <Text style={styles.submitBtnText}>Close Task Profile</Text>
                </TouchableOpacity>
              )}

            </ScrollView>
          </View>
        </SafeAreaView>
      </Modal>
    );
  };

  const renderClientManagerModal = () => {
    const chamberClients = managerSelectedChamber
      ? getClientsForChamber(managerSelectedChamber.id)
      : [];

    return (
      <Modal
        visible={showClientManagerModal}
        animationType="slide"
        transparent={false}
            onRequestClose={() => {
              requestDiscardChamberEdits(() => {
                closeChamberEditSession();
                setShowClientManagerModal(false);
                setShowManagerChamberDropdown(false);
                setShowClientSuggestions(false);
                setEditingClientName(null);
              });
            }}
      >
        <SafeAreaView style={styles.mmRoot}>
          {/* Header */}
          <View style={styles.mmHeader}>
            <View style={styles.mmHeaderTextWrap}>
              <Text style={styles.mmHeaderTitle}>Master Setup</Text>
            </View>
            <TouchableOpacity
              style={styles.mmCloseBtn}
              onPress={() => {
                requestDiscardChamberEdits(() => {
                  closeChamberEditSession();
                  setShowClientManagerModal(false);
                  setShowManagerChamberDropdown(false);
                  setShowClientSuggestions(false);
                  setEditingClientName(null);
                });
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="close" size={22} color="#475569" />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.mmBody}
            contentContainerStyle={{ paddingBottom: 40 }}
            nestedScrollEnabled={true}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
            onScrollBeginDrag={() => setShowClientSuggestions(false)}
          >
            {/* 1. Header with Add Chamber */}
            <View style={{ marginBottom: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontSize: 13, fontWeight: '800', color: '#1e293b' }}>
                Cold Store Chambers ({chambersList.length})
              </Text>
              <TouchableOpacity
                style={{
                  backgroundColor: '#003580',
                  borderRadius: 6,
                  paddingVertical: 6,
                  paddingHorizontal: 12,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4
                }}
                onPress={openAddChamberPopup}
              >
                <Ionicons name="add-circle-outline" size={14} color="#ffffff" />
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#ffffff' }}>Add Chamber</Text>
              </TouchableOpacity>
            </View>

            {/* 2. Chambers Cards List */}
            {chambersList.length === 0 ? (
              <View style={[styles.mmEmpty, { marginTop: 20 }]}>
                <Ionicons name="cube-outline" size={44} color="#94a3b8" />
                <Text style={styles.mmEmptyTitle}>No chambers added yet</Text>
                <Text style={styles.mmEmptyText}>
                  Tap "Add Chamber" at the top to send a setup request to Super Admin.
                </Text>
              </View>
            ) : (
              chambersList.map((ch) => {
                const chamberClients = getMasterSetupClients(ch.id);
                const canEditChamber =
                  chamberClients.length === 0 || Number(editingChamberId) === Number(ch.id);
                const isExpanded = managerSelectedChamber?.id === ch.id && canEditChamber;

                return (
                  <View
                    key={`ch-card-${ch.id}`}
                    style={{
                      backgroundColor: '#ffffff',
                      borderRadius: 10,
                      borderWidth: 1,
                      borderColor: isExpanded ? '#003580' : '#e2e8f0',
                      marginBottom: 12,
                      padding: 12,
                      shadowColor: '#000',
                      shadowOffset: { width: 0, height: 1 },
                      shadowOpacity: 0.05,
                      shadowRadius: 2,
                      elevation: 2
                    }}
                  >
                    {/* Card Header Row */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 }}>
                        <View style={{
                          width: 32,
                          height: 32,
                          borderRadius: 6,
                          backgroundColor: isExpanded ? '#eff6ff' : '#f1f5f9',
                          alignItems: 'center',
                          justifyContent: 'center',
                          marginRight: 10
                        }}>
                          <Ionicons name="cube" size={18} color={isExpanded ? '#003580' : '#64748b'} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontWeight: '800', color: '#0f172a' }}>
                            {ch.name}
                          </Text>
                          <Text style={{ fontSize: 11, color: '#64748b', fontWeight: '600', marginTop: 1 }}>
                            {chamberClients.length} client{chamberClients.length === 1 ? '' : 's'} assigned
                          </Text>
                        </View>
                      </View>

                      {/* Edit / Collapse — empty chamber edits immediately; clients require SA allow */}
                      <TouchableOpacity
                        style={{
                          backgroundColor: isExpanded ? '#64748b' : '#003580',
                          paddingVertical: 5,
                          paddingHorizontal: 12,
                          borderRadius: 6,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 4
                        }}
                        onPress={() => {
                          if (isExpanded) {
                            requestDiscardChamberEdits(() => {
                              closeChamberEditSession();
                            });
                            return;
                          }
                          if (chamberEditHasChanges()) {
                            requestDiscardChamberEdits(() => handleEditChamberPress(ch));
                            return;
                          }
                          closeChamberEditSession();
                          handleEditChamberPress(ch);
                        }}
                        activeOpacity={0.8}
                      >
                        <Text style={{ fontSize: 10, fontWeight: '700', color: '#ffffff' }}>
                          {isExpanded ? 'Collapse' : 'Edit'}
                        </Text>
                        <Ionicons
                          name={isExpanded ? 'chevron-up' : 'chevron-down'}
                          size={11}
                          color="#ffffff"
                        />
                      </TouchableOpacity>
                    </View>

                    {/* Expanded Content Section */}
                    {isExpanded && (() => {
                      const isEmptyChamber = chamberClients.length === 0;
                      const isEditing =
                        isEmptyChamber || Number(editingChamberId) === Number(ch.id);
                      if (!isEditing) return null;

                      return (
                        <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#e2e8f0' }}>

                          {/* 2.1 Add Client Lot Mapping Form (Only visible in Edit Mode) */}
                          {isEditing && (
                            <View style={{
                              backgroundColor: '#ffffff',
                              borderRadius: 8,
                              borderWidth: 1,
                              borderColor: '#e2e8f0',
                              padding: 10,
                              marginBottom: 10,
                              shadowColor: '#000',
                              shadowOffset: { width: 0, height: 1 },
                              shadowOpacity: 0.01,
                              shadowRadius: 2,
                              elevation: 1
                            }}>
                              <Text style={{ fontSize: 11, fontWeight: '800', color: '#0f172a', marginBottom: 1 }}>
                                Add Client Lot Mapping
                              </Text>
                              <Text style={{ fontSize: 8.5, fontWeight: '600', color: '#64748b', marginBottom: 8 }}>
                                Assign a client lot and choose temperature zone
                              </Text>

                              <Text style={{ fontSize: 9.5, fontWeight: '700', color: '#334155', marginBottom: 4 }}>Chamber Temperature Zone</Text>
                              <View style={{ flexDirection: 'row', gap: 4, marginBottom: 10 }}>
                                {['Frozen', 'Chilled', 'Dry', 'Other'].map(type => {
                                  const active =
                                    (chamberEditDraft && Number(chamberEditDraft.chamberId) === Number(ch.id)
                                      ? chamberEditDraft.type
                                      : newClientType) === type;
                                  
                                  let activeBg = '#ffffff';
                                  let activeBorder = '#e2e8f0';
                                  let activeTextColor = '#64748b';
                                  let iconName = 'ellipse-outline';

                                  if (type === 'Frozen') {
                                    iconName = 'snow-outline';
                                    if (active) {
                                      activeBg = '#eff6ff';
                                      activeBorder = '#bfdbfe';
                                      activeTextColor = '#2563eb';
                                    }
                                  } else if (type === 'Chilled') {
                                    iconName = 'thermometer-outline';
                                    if (active) {
                                      activeBg = '#e6fffa';
                                      activeBorder = '#99f6e4';
                                      activeTextColor = '#0d9488';
                                    }
                                  } else if (type === 'Dry') {
                                    iconName = 'leaf-outline';
                                    if (active) {
                                      activeBg = '#f0fdf4';
                                      activeBorder = '#bbf7d0';
                                      activeTextColor = '#16a34a';
                                    }
                                  } else { // Other
                                    iconName = 'ellipse-outline';
                                    if (active) {
                                      activeBg = '#f1f5f9';
                                      activeBorder = '#cbd5e1';
                                      activeTextColor = '#475569';
                                    }
                                  }

                                  return (
                                    <TouchableOpacity
                                      key={type}
                                      style={{
                                        flex: 1,
                                        paddingVertical: 6,
                                        borderRadius: 6,
                                        backgroundColor: active ? activeBg : '#ffffff',
                                        borderWidth: 1,
                                        borderColor: active ? activeBorder : '#e2e8f0',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        shadowColor: active ? activeBorder : '#000',
                                        shadowOffset: { width: 0, height: 1 },
                                        shadowOpacity: active ? 0.05 : 0,
                                        shadowRadius: 1,
                                        elevation: active ? 1 : 0
                                      }}
                                      onPress={() => handleChangeChamberZone(type)}
                                      activeOpacity={0.8}
                                      hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
                                    >
                                      <Ionicons name={iconName} size={11} color={active ? activeTextColor : '#94a3b8'} style={{ marginBottom: 1 }} />
                                      <Text style={{ fontSize: 8.5, fontWeight: '800', color: active ? activeTextColor : '#475569', textAlign: 'center' }}>
                                        {type}
                                      </Text>
                                      <Text style={{ fontSize: 7, fontWeight: '700', color: active ? activeTextColor : '#94a3b8', marginTop: 0.5, textAlign: 'center' }}>
                                        {type === 'Frozen' ? '< -18°C' :
                                         type === 'Chilled' ? '-5° to 5°C' :
                                         type === 'Dry' ? '15° to 25°C' : 'Ambient'}
                                      </Text>
                                    </TouchableOpacity>
                                  );
                                })}
                              </View>

                              <Text style={{ fontSize: 9.5, fontWeight: '700', color: '#334155', marginBottom: 4 }}>Client Lot Name</Text>
                              <TextInput
                                style={{
                                  width: '100%',
                                  height: 32,
                                  borderWidth: 1,
                                  borderColor: '#e2e8f0',
                                  borderRadius: 6,
                                  paddingHorizontal: 8,
                                  paddingVertical: 0,
                                  textAlignVertical: 'center',
                                  fontSize: 11,
                                  color: '#0f172a',
                                  backgroundColor: '#f8fafc',
                                  marginBottom: 8
                                }}
                                placeholder="e.g. Reliance Fresh / Client Lot A"
                                placeholderTextColor="#94a3b8"
                                value={newClientInput}
                                onChangeText={(txt) => {
                                  setNewClientInput(txt);
                                  if (txt.trim().length > 0) {
                                    setShowClientSuggestions(true);
                                  } else {
                                    setShowClientSuggestions(false);
                                  }
                                }}
                                onFocus={() => {
                                  if (newClientInput.trim().length > 0) {
                                    setShowClientSuggestions(true);
                                  }
                                }}
                                onTouchStart={(e) => e.stopPropagation()}
                                autoCapitalize="words"
                                returnKeyType="done"
                                onSubmitEditing={handleAddNewClient}
                              />

                              {(() => {
                                const matchingSuggestions = (masterClientLots || [])
                                  .filter(c => 
                                    c && 
                                    String(c).toLowerCase().includes(newClientInput.toLowerCase()) &&
                                    String(c).toLowerCase() !== newClientInput.toLowerCase()
                                  )
                                  .slice(0, 5);

                                if (showClientSuggestions && matchingSuggestions.length > 0) {
                                  return (
                                    <View style={{
                                      backgroundColor: '#ffffff',
                                      borderWidth: 1,
                                      borderColor: '#cbd5e1',
                                      borderRadius: 6,
                                      marginTop: -6,
                                      marginBottom: 8,
                                      maxHeight: 120,
                                      shadowColor: '#000',
                                      shadowOffset: { width: 0, height: 2 },
                                      shadowOpacity: 0.05,
                                      shadowRadius: 3,
                                      elevation: 2,
                                      zIndex: 1000
                                    }}>
                                      <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled={true} onTouchStart={(e) => e.stopPropagation()}>
                                        {matchingSuggestions.map((suggestion, idx) => (
                                          <TouchableOpacity
                                            key={`${suggestion}-${idx}`}
                                            style={{
                                              paddingVertical: 6,
                                              paddingHorizontal: 10,
                                              borderBottomWidth: idx === matchingSuggestions.length - 1 ? 0 : 0.5,
                                              borderBottomColor: '#f1f5f9'
                                            }}
                                            onPress={() => {
                                              setNewClientInput(suggestion);
                                              setShowClientSuggestions(false);
                                            }}
                                          >
                                            <Text style={{ fontSize: 10.5, color: '#334155', fontWeight: '600' }}>
                                              {suggestion}
                                            </Text>
                                          </TouchableOpacity>
                                        ))}
                                      </ScrollView>
                                    </View>
                                  );
                                }
                                return null;
                              })()}

                              <TouchableOpacity
                                style={{
                                  backgroundColor: '#003580',
                                  height: 32,
                                  borderRadius: 6,
                                  flexDirection: 'row',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  shadowColor: '#003580',
                                  shadowOffset: { width: 0, height: 2 },
                                  shadowOpacity: 0.1,
                                  shadowRadius: 2,
                                  elevation: 2
                                }}
                                onPress={handleAddNewClient}
                                activeOpacity={0.85}
                              >
                                <Ionicons name="add-circle" size={14} color="#ffffff" style={{ marginRight: 4 }} />
                                <Text style={{ fontSize: 11, fontWeight: '800', color: '#ffffff', letterSpacing: 0.2 }}>
                                  Add Client to Chamber
                                </Text>
                              </TouchableOpacity>

                            </View>
                          )}

                          {/* 2.2 Active Clients List Title & Chamber Delete Button */}
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                            <Text style={{ fontSize: 10.5, fontWeight: '800', color: '#1e293b' }}>
                              Clients mapped to {ch.name} ({chamberClients.length})
                            </Text>
                            {isEditing && (
                              <TouchableOpacity
                                onPress={() => handleDeleteChamberMaster(ch)}
                                style={{
                                  flexDirection: 'row',
                                  alignItems: 'center',
                                  gap: 4,
                                  paddingVertical: 3,
                                  paddingHorizontal: 8,
                                  borderRadius: 6,
                                  borderWidth: 1,
                                  borderColor: '#fecaca',
                                  backgroundColor: '#fef2f2'
                                }}
                              >
                                <Ionicons name="trash" size={10} color="#ef4444" />
                                <Text style={{ fontSize: 8.5, fontWeight: '800', color: '#ef4444' }}>Delete Chamber</Text>
                              </TouchableOpacity>
                            )}
                          </View>

                          {/* Client rows mapping */}
                          {chamberClients.length === 0 ? (
                            <View style={{ backgroundColor: '#f8fafc', borderRadius: 6, padding: 10, borderWidth: 1, borderColor: '#cbd5e1', borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' }}>
                              <Ionicons name="people-outline" size={14} color="#94a3b8" style={{ marginBottom: 2 }} />
                              <Text style={{ fontSize: 10, color: '#64748b', fontWeight: '700' }}>
                                No client lots mapped to this chamber yet.
                              </Text>
                            </View>
                          ) : (
                            <View style={{ gap: 4 }}>
                              {chamberClients.map((item) => {
                                const isCurrentlyRenaming = editingClientName && 
                                  editingClientName.chamberId === ch.id && 
                                  editingClientName.oldName === item.client_name;
                                const clientZone =
                                  (chamberEditDraft && Number(chamberEditDraft.chamberId) === Number(ch.id)
                                    ? chamberEditDraft.type
                                    : ch.chamber_type) || item.chamber_type || 'Frozen';

                                return (
                                  <View key={item.client_name} style={{
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    backgroundColor: '#ffffff',
                                    borderWidth: 1,
                                    borderColor: '#e2e8f0',
                                    paddingVertical: 6,
                                    paddingHorizontal: 8,
                                    borderRadius: 8,
                                    shadowColor: '#000',
                                    shadowOffset: { width: 0, height: 1 },
                                    shadowOpacity: 0.01,
                                    shadowRadius: 1,
                                    elevation: 0.5
                                  }}>
                                    {!isCurrentlyRenaming && (
                                      <View style={{
                                        width: 24,
                                        height: 24,
                                        borderRadius: 12,
                                        backgroundColor:
                                          clientZone === 'Frozen' ? '#eff6ff' :
                                          clientZone === 'Chilled' ? '#f0fdf4' :
                                          clientZone === 'Dry' ? '#f0fdf4' : '#f8fafc',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        marginRight: 8
                                      }}>
                                        <Text style={{
                                          fontSize: 10,
                                          fontWeight: '800',
                                          color:
                                            clientZone === 'Frozen' ? '#2563eb' :
                                            clientZone === 'Chilled' ? '#0d9488' :
                                            clientZone === 'Dry' ? '#16a34a' : '#64748b'
                                        }}>
                                          {String(item.client_name).charAt(0).toUpperCase()}
                                        </Text>
                                      </View>
                                    )}
                                    
                                    {isCurrentlyRenaming ? (
                                      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                        <TextInput
                                          style={{
                                            flex: 1,
                                            height: 28,
                                            borderWidth: 1,
                                            borderColor: '#cbd5e1',
                                            borderRadius: 6,
                                            paddingHorizontal: 6,
                                            paddingVertical: 0,
                                            textAlignVertical: 'center',
                                            fontSize: 11,
                                            color: '#0f172a',
                                            backgroundColor: '#f8fafc'
                                          }}
                                          value={editClientDraft}
                                          onChangeText={setEditClientDraft}
                                          autoFocus={true}
                                          placeholder="Client name"
                                          placeholderTextColor="#94a3b8"
                                          returnKeyType="done"
                                          onSubmitEditing={handleRenameChamberClient}
                                        />
                                        <TouchableOpacity
                                          style={{
                                            width: 28,
                                            height: 28,
                                            borderRadius: 6,
                                            backgroundColor: '#dcfce7',
                                            alignItems: 'center',
                                            justifyContent: 'center'
                                          }}
                                          onPress={handleRenameChamberClient}
                                        >
                                          <Ionicons name="checkmark" size={13} color="#15803d" />
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                          style={{
                                            width: 28,
                                            height: 28,
                                            borderRadius: 6,
                                            backgroundColor: '#f1f5f9',
                                            alignItems: 'center',
                                            justifyContent: 'center'
                                          }}
                                          onPress={() => {
                                            setEditingClientName(null);
                                            setEditClientDraft('');
                                          }}
                                        >
                                          <Ionicons name="close" size={13} color="#64748b" />
                                        </TouchableOpacity>
                                      </View>
                                    ) : (
                                      <View style={{ flex: 1, minWidth: 0, marginRight: 8 }}>
                                        <Text style={{ fontSize: 11.5, fontWeight: '700', color: '#1e293b' }} numberOfLines={1}>
                                          {item.client_name}
                                        </Text>
                                        <View style={{
                                          flexDirection: 'row',
                                          alignItems: 'center',
                                          marginTop: 1
                                        }}>
                                          <View style={{
                                            width: 5,
                                            height: 5,
                                            borderRadius: 2.5,
                                            backgroundColor:
                                              clientZone === 'Frozen' ? '#2563eb' :
                                              clientZone === 'Chilled' ? '#0d9488' :
                                              clientZone === 'Dry' ? '#16a34a' : '#64748b',
                                            marginRight: 3
                                          }} />
                                          <Text style={{
                                            fontSize: 8.5,
                                            fontWeight: '800',
                                            color:
                                              clientZone === 'Frozen' ? '#2563eb' :
                                              clientZone === 'Chilled' ? '#0d9488' :
                                              clientZone === 'Dry' ? '#16a34a' : '#64748b'
                                          }}>
                                            {clientZone} zone
                                          </Text>
                                        </View>
                                      </View>
                                    )}
                                    
                                    {isEditing && !isCurrentlyRenaming && (
                                      <View style={{ flexDirection: 'row', gap: 4 }}>
                                        <TouchableOpacity
                                          style={{
                                            padding: 5,
                                            borderRadius: 6,
                                            backgroundColor: '#fef2f2',
                                            borderWidth: 0.5,
                                            borderColor: '#fee2e2',
                                            alignItems: 'center',
                                            justifyContent: 'center'
                                          }}
                                          onPress={() => handleDeleteClient(item.client_name)}
                                          activeOpacity={0.8}
                                        >
                                          <Ionicons name="trash-outline" size={12} color="#ef4444" />
                                        </TouchableOpacity>
                                      </View>
                                    )}
                                  </View>
                                );
                              })}
                            </View>
                          )}

                          {/* Chamber Save & Sync Button */}
                          <TouchableOpacity
                            style={{
                              backgroundColor: '#003580',
                              height: 32,
                              borderRadius: 6,
                              alignItems: 'center',
                              justifyContent: 'center',
                              marginTop: 10,
                              flexDirection: 'row',
                              gap: 6,
                              shadowColor: '#003580',
                              shadowOffset: { width: 0, height: 1 },
                              shadowOpacity: 0.1,
                              shadowRadius: 2,
                              elevation: 2
                            }}
                            onPress={async () => {
                              const draft =
                                chamberEditDraft && Number(chamberEditDraft.chamberId) === Number(ch.id)
                                  ? chamberEditDraft
                                  : null;
                              if (!draft || !chamberEditHasChanges(draft)) {
                                closeChamberEditSession();
                                Alert.alert('No changes', 'Nothing new to save. No request was sent.');
                                return;
                              }
                              openChamberSetupSavePermission(ch);
                            }}
                            activeOpacity={0.85}
                          >
                            <Ionicons name="checkmark-circle" size={14} color="#ffffff" />
                            <Text style={{ fontSize: 11, fontWeight: '800', color: '#ffffff', letterSpacing: 0.2 }}>
                              Save & Collapse Setup
                            </Text>
                          </TouchableOpacity>
                        </View>
                      );
                    })()}
                  </View>
                );
              })
            )}
          </ScrollView>
          {permissionModal.isOpen &&
            (permissionModal.mode === 'chamber_edit' || permissionModal.mode === 'chamber_type' || permissionModal.mode === 'chamber_setup' || permissionModal.mode === 'client_rename' || permissionModal.mode === 'client_add') && (
            <View
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(15, 23, 42, 0.45)',
                alignItems: 'center',
                justifyContent: 'center',
                paddingHorizontal: 16,
                zIndex: 60
              }}
            >
              {renderPermissionPopupCard()}
            </View>
          )}
          {showDeleteConfirmModal &&
            (clientToDelete?.type === 'chamber_edit_request' ||
              clientToDelete?.type === 'chamber_delete_request' ||
              clientToDelete?.type === 'chamber_type_update') && (
            <View
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(15, 23, 42, 0.45)',
                alignItems: 'center',
                justifyContent: 'center',
                paddingHorizontal: 24,
                zIndex: 50
              }}
            >
              <View style={styles.dialogContent}>
                <Text style={styles.dialogTitle}>
                  {clientToDelete?.type === 'chamber_delete_request'
                    ? 'Request Chamber Delete'
                    : clientToDelete?.type === 'chamber_type_update'
                      ? 'Update Chamber Type'
                      : 'Request Super Admin Permission'}
                </Text>
                <Text style={styles.dialogSubtitle}>
                  {clientToDelete?.type === 'chamber_delete_request'
                    ? `Enter remark/reason to request Super Admin allow for deleting "${clientToDelete?.chamberName}":`
                    : clientToDelete?.type === 'chamber_type_update'
                      ? `Change "${clientToDelete?.chamberName}" from ${clientToDelete?.oldType || 'current'} to ${clientToDelete?.nextType}. Enter remark:`
                      : `"${clientToDelete?.chamberName}" has clients. Enter remark to request Super Admin allow to edit:`}
                </Text>
                <TextInput
                  style={styles.dialogInput}
                  value={deleteRemarkInput}
                  onChangeText={setDeleteRemarkInput}
                  placeholder={
                    clientToDelete?.type === 'chamber_delete_request'
                      ? 'Add remark: why you want to delete this chamber'
                      : clientToDelete?.type === 'chamber_type_update'
                        ? 'Add remark: what type change you want (e.g. Frozen → Chilled)'
                        : 'Add remark: what you want to edit (e.g. add/change client)'
                  }
                  placeholderTextColor="#94a3b8"
                  autoCapitalize="sentences"
                />
                <View style={styles.dialogActionsRow}>
                  <TouchableOpacity
                    style={styles.dialogCancelBtn}
                    onPress={() => {
                      setShowDeleteConfirmModal(false);
                      setClientToDelete(null);
                      setDeleteRemarkInput('');
                    }}
                  >
                    <Text style={styles.dialogCancelBtnText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.dialogSaveBtn, { backgroundColor: '#003580' }]}
                    onPress={async () => {
                      if (!deleteRemarkInput.trim()) {
                        Alert.alert('Validation Error', 'Please enter a remark/reason.');
                        return;
                      }
                      const target = clientToDelete;
                      const remark = deleteRemarkInput.trim();
                      setShowDeleteConfirmModal(false);
                      setDeleteRemarkInput('');
                      setClientToDelete(null);
                      if (!target) return;
                      if (target.type === 'chamber_delete_request') {
                        await requestChamberDeletePermission(
                          { id: target.chamberId, name: target.chamberName },
                          remark
                        );
                        return;
                      }
                      if (target.type === 'chamber_type_update') {
                        await requestChamberTypePermission(
                          { id: target.chamberId, name: target.chamberName },
                          target.nextType,
                          target.oldType,
                          remark
                        );
                        return;
                      }
                      await requestChamberEditPermission(
                        { id: target.chamberId, name: target.chamberName },
                        remark
                      );
                    }}
                  >
                    <Text style={styles.dialogSaveBtnText}>
                      {clientToDelete?.type === 'chamber_type_update' ? 'Save Type' : 'Send Request'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}
        </SafeAreaView>
      </Modal>
    );
  };

  const renderDeleteConfirmModal = () => {
    const isChamberDeleteRequest = clientToDelete?.type === 'chamber_delete_request';
    const isChamberEditRequest = clientToDelete?.type === 'chamber_edit_request';
    const isClientRename = clientToDelete?.type === 'client_rename';
    return (
      <Modal
        visible={
          showDeleteConfirmModal &&
          clientToDelete?.type !== 'chamber_edit_request' &&
          clientToDelete?.type !== 'chamber_delete_request' &&
          clientToDelete?.type !== 'chamber_type_update'
        }
        animationType="fade"
        transparent
        onRequestClose={() => {
          setShowDeleteConfirmModal(false);
          setClientToDelete(null);
          setDeleteRemarkInput('');
        }}
      >
        <View style={styles.dialogOverlay}>
          <View style={styles.dialogContent}>
            <Text style={styles.dialogTitle}>
              {isChamberDeleteRequest ? 'Request Chamber Delete' : (isChamberEditRequest ? 'Request Chamber Edit' : (isClientRename ? 'Rename Client Mapping' : 'Delete Client Master'))}
            </Text>
            <Text style={styles.dialogSubtitle}>
              {isChamberDeleteRequest
                ? `Enter remark/reason to request Super Admin allow for deleting "${clientToDelete?.chamberName}":`
                : (isChamberEditRequest
                  ? `Enter remark/reason to request Super Admin allow for editing "${clientToDelete?.chamberName}":`
                  : (isClientRename
                    ? `Rename client lot "${clientToDelete?.oldName}" to "${clientToDelete?.newName}" on ${clientToDelete?.chamberName}? Enter a remark/reason:`
                    : `Send request to remove "${clientToDelete?.clientName}" from ${clientToDelete?.chamberName || 'Chamber'}. Super Admin must allow first:`
                  ))}
            </Text>
            
            <TextInput
              style={styles.dialogInput}
              value={deleteRemarkInput}
              onChangeText={setDeleteRemarkInput}
              placeholder={
                isChamberDeleteRequest
                  ? 'Add remark: why you want to delete this chamber'
                  : isChamberEditRequest
                    ? 'Add remark: what you want to edit (e.g. add/change client)'
                    : isClientRename
                      ? 'Add remark: why this client name is changing'
                      : 'Add remark: why this client is being removed'
              }
              placeholderTextColor="#94a3b8"
              autoCapitalize="sentences"
            />

            <View style={styles.dialogActionsRow}>
              <TouchableOpacity 
                style={styles.dialogCancelBtn}
                onPress={() => {
                  setShowDeleteConfirmModal(false);
                  setClientToDelete(null);
                  setDeleteRemarkInput('');
                }}
              >
                <Text style={styles.dialogCancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.dialogSaveBtn, { backgroundColor: isChamberEditRequest || isClientRename ? '#003580' : '#ef4444' }]}
                onPress={async () => {
                  if (!deleteRemarkInput.trim()) {
                    Alert.alert('Validation Error', 'Please enter a remark/reason.');
                    return;
                  }
                  const target = clientToDelete;
                  if (!target) return;
                  const remark = deleteRemarkInput.trim();

                  if (target.type === 'chamber_edit_request') {
                    setShowDeleteConfirmModal(false);
                    setDeleteRemarkInput('');
                    setClientToDelete(null);
                    await requestChamberEditPermission(
                      { id: target.chamberId, name: target.chamberName },
                      remark
                    );
                    return;
                  }

                  if (target.type === 'chamber_delete_request') {
                    setShowDeleteConfirmModal(false);
                    setDeleteRemarkInput('');
                    setClientToDelete(null);
                    await requestChamberDeletePermission(
                      { id: target.chamberId, name: target.chamberName },
                      remark
                    );
                    return;
                  }

                  if (target.type === 'client_rename') {
                    setShowDeleteConfirmModal(false);
                    setDeleteRemarkInput('');
                    setEditingClientName(null);
                    setEditClientDraft('');
                    setClientToDelete(null);
                    await requestClientMasterPermission({
                      chamber: { id: target.chamberId, name: target.chamberName },
                      action: 'edit',
                      clientName: target.oldName,
                      newName: target.newName,
                      remark
                    });
                    return;
                  }

                  setShowDeleteConfirmModal(false);
                  setDeleteRemarkInput('');
                  setClientToDelete(null);
                  await requestClientMasterPermission({
                    chamber: { id: target.chamberId, name: target.chamberName },
                    action: 'delete',
                    clientName: target.clientName,
                    remark
                  });
                  if (selectedClient === target.clientName) {
                    setSelectedClient(null);
                    setTempInput('');
                    setBoxCountInput('');
                    setCapturedImage(null);
                    setCapturedImageTimestamp(null);
                  }
                }}
              >
                <Text style={styles.dialogSaveBtnText}>
                  {isChamberDeleteRequest || isChamberEditRequest ? 'Send Request' : (isClientRename ? 'Send Request' : 'Send Request')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  // Super Admin permission popup (completed log edit, chamber master edit, chamber type)
  const renderPermissionPopupCard = () => {
    if (!permissionModal.isOpen) return null;
    const mode = permissionModal.mode || 'log';
    const log = permissionModal.log;
    const chamber = permissionModal.chamber;
    const status = permissionModal.status || 'None';
    const statusColor =
      status === 'Pending' ? '#ca8a04' :
      status === 'Denied' ? '#dc2626' :
      status === 'Used' ? '#64748b' :
      status === 'Approved' ? '#16a34a' : '#64748b';

    const clientCount = chamber ? getClientsForChamber(chamber.id).length : 0;
    const needsRemark = mode === 'chamber_edit' || mode === 'chamber_type' || mode === 'chamber_setup' || mode === 'client_rename' || mode === 'client_add';
    const typeNeedsAllow = mode === 'chamber_type' || (mode === 'chamber_setup' && !!permissionModal.nextType);
    const clientNeedsAllow = mode === 'client_rename' || mode === 'client_add' || mode === 'chamber_setup';
    const primaryLabel =
      typeNeedsAllow || clientNeedsAllow
        ? 'Send Request'
        : mode === 'chamber_setup'
          ? 'Send Request'
          : 'Request Permission';

    const yellowText =
      mode === 'chamber_setup'
        ? 'Client add, delete, rename and chamber type changes need Super Admin approval. They will apply automatically after allow.'
        : mode === 'client_add'
          ? 'Client will be added only after Super Admin allows. It will appear automatically on this app.'
        : mode === 'chamber_type'
          ? 'Chamber type will not change until Super Admin allows. After allow, it updates automatically on this app.'
          : mode === 'chamber_edit'
            ? 'This chamber has clients. First get permission from Super Admin to edit. Each approval allows one edit session.'
            : mode === 'client_rename'
              ? 'Client rename needs Super Admin approval. After allow, the new name appears automatically.'
              : 'To update this completed log, first get permission from Super Admin. Each approval allows one update only.';

    return (
      <View style={[styles.dialogContent, { maxWidth: 360 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
          <Ionicons name="shield-checkmark-outline" size={22} color="#ea580c" style={{ marginRight: 8 }} />
          <Text style={[styles.dialogTitle, { marginBottom: 0, flex: 1 }]}>Permission Required</Text>
          <TouchableOpacity onPress={closePermissionModal}>
            <Ionicons name="close" size={22} color="#64748b" />
          </TouchableOpacity>
        </View>

        <View style={{ backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fef3c7', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <Text style={{ fontSize: 12, color: '#b45309', fontWeight: '700', lineHeight: 18 }}>
            {yellowText}
          </Text>
        </View>

        <View style={{ backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, padding: 12, marginBottom: 12, gap: 6 }}>
          {mode === 'log' ? (
            <>
              <Text style={{ fontSize: 12, color: '#334155' }}>
                <Text style={{ fontWeight: '800' }}>Record:</Text> Chamber DO Log
              </Text>
              <Text style={{ fontSize: 12, color: '#334155' }}>
                <Text style={{ fontWeight: '800' }}>Ref / ID:</Text> {log?.reference_no || `#${getServerLogIdForPermission(log) || '-'}`}
              </Text>
              <Text style={{ fontSize: 12, color: '#334155' }}>
                <Text style={{ fontWeight: '800' }}>Client:</Text> {log?.client_name || '-'}
              </Text>
              <Text style={{ fontSize: 12, color: '#334155' }}>
                <Text style={{ fontWeight: '800' }}>Chamber:</Text> {log?.chamber_name || '-'}
              </Text>
            </>
          ) : (
            <>
              <Text style={{ fontSize: 12, color: '#334155' }}>
                <Text style={{ fontWeight: '800' }}>Record:</Text>{' '}
                {mode === 'chamber_type' ? 'Chamber Type' : mode === 'chamber_setup' ? 'Chamber Setup' : mode === 'client_rename' || mode === 'client_add' ? 'Client Master' : 'Chamber Master'}
              </Text>
              <Text style={{ fontSize: 12, color: '#334155' }}>
                <Text style={{ fontWeight: '800' }}>Chamber:</Text> {chamber?.name || '-'}
              </Text>
              {mode === 'chamber_edit' ? (
                <Text style={{ fontSize: 12, color: '#334155' }}>
                  <Text style={{ fontWeight: '800' }}>Clients:</Text> {clientCount}
                </Text>
              ) : mode === 'client_rename' ? (
                <Text style={{ fontSize: 12, color: '#334155' }}>
                  <Text style={{ fontWeight: '800' }}>Client:</Text> {permissionModal.oldName || '-'} → {permissionModal.newName || '-'}
                </Text>
              ) : mode === 'client_add' ? (
                <Text style={{ fontSize: 12, color: '#334155' }}>
                  <Text style={{ fontWeight: '800' }}>Client:</Text> {permissionModal.pendingClientName || '-'} ({permissionModal.pendingClientType || newClientType})
                </Text>
              ) : permissionModal.nextType ? (
                <Text style={{ fontSize: 12, color: '#334155' }}>
                  <Text style={{ fontWeight: '800' }}>Type:</Text> {permissionModal.oldType || '-'} → {permissionModal.nextType}
                </Text>
              ) : null}
            </>
          )}
          {mode !== 'client_rename' ? (
            <Text style={{ fontSize: 12, color: '#334155' }}>
              <Text style={{ fontWeight: '800' }}>Status:</Text>{' '}
              <Text style={{ fontWeight: '800', color: statusColor }}>
                {status === 'None' ? 'Not Requested' : status === 'Used' ? 'Used (request again)' : status}
              </Text>
            </Text>
          ) : null}
        </View>

        {needsRemark && status !== 'Pending' ? (
          <TextInput
            style={[styles.dialogInput, { marginBottom: 12 }]}
            value={permissionModal.remark || ''}
            onChangeText={(txt) => setPermissionModal((prev) => ({ ...prev, remark: txt }))}
            placeholder={
              mode === 'chamber_setup'
                ? 'Add remark: type change / client add / client delete'
                : mode === 'chamber_type'
                ? 'Add remark: what type change you want (e.g. Frozen → Chilled)'
                : mode === 'client_rename'
                  ? 'Add remark: why this client name is changing'
                  : 'Add remark: what you want to edit (e.g. add/change client)'
            }
            placeholderTextColor="#94a3b8"
            autoCapitalize="sentences"
          />
        ) : null}

        {status === 'Pending' ? (
          <Text style={{ fontSize: 12, color: '#ca8a04', fontWeight: '600', marginBottom: 14, lineHeight: 18 }}>
            {typeNeedsAllow
              ? 'Request is pending Super Admin approval. After allow, chamber type will update automatically.'
              : 'Request is pending Super Admin approval. Open Role & Permission on Super Admin panel to approve, then tap Edit again.'}
          </Text>
        ) : status === 'Used' ? (
          <Text style={{ fontSize: 12, color: '#0f172a', fontWeight: '600', marginBottom: 14, lineHeight: 18 }}>
            Previous approval was already used. Request permission again?
          </Text>
        ) : (
          <Text style={{ fontSize: 12, color: '#0f172a', fontWeight: '600', marginBottom: 14, lineHeight: 18 }}>
            {mode === 'chamber_setup' && typeNeedsAllow
              ? 'Send Super Admin a type-change request? Client add/delete will save now; type updates after allow.'
              : mode === 'chamber_setup'
              ? 'Save these chamber setup changes with your remark?'
              : mode === 'chamber_type'
              ? 'Send this type change to Super Admin? It will update automatically after allow.'
              : mode === 'client_rename'
                ? 'Save this client name change with your remark?'
                : 'Send an edit permission request to Super Admin?'}
          </Text>
        )}

        <View style={styles.dialogActionsRow}>
          <TouchableOpacity style={styles.dialogCancelBtn} onPress={closePermissionModal}>
            <Text style={styles.dialogCancelBtnText}>Back</Text>
          </TouchableOpacity>

          {(status === 'None' || status === 'Denied' || status === 'Used' || ((mode === 'chamber_type' || mode === 'chamber_setup' || mode === 'client_rename' || mode === 'client_add') && status !== 'Pending')) && (
            <TouchableOpacity
              style={[styles.dialogSaveBtn, { backgroundColor: '#ea580c', opacity: permissionRequestBusy ? 0.7 : 1 }]}
              disabled={permissionRequestBusy}
              onPress={handleRequestEditPermission}
            >
              {permissionRequestBusy ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.dialogSaveBtnText}>{primaryLabel}</Text>
              )}
            </TouchableOpacity>
          )}

          {status === 'Pending' && permissionModal.taskItem && (
            <TouchableOpacity
              style={[styles.dialogSaveBtn, { backgroundColor: '#2563eb' }]}
              onPress={() => {
                closePermissionModal();
                handleEditCompletedLog(permissionModal.taskItem);
              }}
            >
              <Text style={styles.dialogSaveBtnText}>Check Again</Text>
            </TouchableOpacity>
          )}

          {status === 'Pending' && mode === 'chamber_edit' && (
            <TouchableOpacity
              style={[styles.dialogSaveBtn, { backgroundColor: '#2563eb' }]}
              onPress={() => {
                const ch = permissionModal.chamber;
                closePermissionModal();
                if (ch) handleEditChamberPress(ch);
              }}
            >
              <Text style={styles.dialogSaveBtnText}>Check Again</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  const renderPermissionModal = () => {
    if (!permissionModal.isOpen) return null;
    // Master Setup already open: overlay is drawn inside that screen
    if (showClientManagerModal && (permissionModal.mode === 'chamber_edit' || permissionModal.mode === 'chamber_type' || permissionModal.mode === 'chamber_setup' || permissionModal.mode === 'client_rename' || permissionModal.mode === 'client_add')) {
      return null;
    }
    return (
      <Modal visible={permissionModal.isOpen} animationType="fade" transparent onRequestClose={closePermissionModal}>
        <View style={styles.dialogOverlay}>
          {renderPermissionPopupCard()}
        </View>
      </Modal>
    );
  };

  // Submission Confirmation Dialog — photo capture time vs submit time (new + edit)
  const renderSubmitConfirmModal = () => {
    if (!showSubmitConfirmModal) return null;

    const submitNowMs = Date.now();
    const diffMins = getImageTimeDifferenceInMinutes(submitNowMs);
    const isVarianceAlert = diffMins == null || diffMins > 5;
    const photoClock = formatClockTime(capturedImageTimestamp);
    const submitClock = formatClockTime(submitNowMs);

    return (
      <Modal
        visible={showSubmitConfirmModal}
        animationType="fade"
        transparent
        onRequestClose={() => setShowSubmitConfirmModal(false)}
      >
        <View style={styles.dialogOverlay}>
          <View style={[styles.dialogContent, { maxWidth: 340 }]}>
            <View style={{ alignItems: 'center', marginBottom: 15 }}>
              <View style={{
                backgroundColor: isVarianceAlert ? '#fee2e2' : '#dcfce7', 
                width: 50, 
                height: 50, 
                borderRadius: 25, 
                alignItems: 'center', 
                justifyContent: 'center',
                marginBottom: 10
              }}>
                <Ionicons 
                  name={isVarianceAlert ? "warning" : "checkmark-circle"} 
                  size={30} 
                  color={isVarianceAlert ? "#ef4444" : "#16a34a"} 
                />
              </View>
              <Text style={[styles.dialogTitle, { textAlign: 'center' }]}>
                {editingExistingLog ? 'Confirm Edit Update' : 'Confirm Submission'}
              </Text>
            </View>

            <View style={{
              backgroundColor: '#f8fafc',
              borderRadius: 10,
              borderWidth: 1,
              borderColor: '#e2e8f0',
              paddingVertical: 10,
              paddingHorizontal: 12,
              marginBottom: 14
            }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6, borderBottomWidth: 0.5, borderBottomColor: '#cbd5e1', paddingBottom: 6 }}>
                <Text style={{ fontSize: 11, color: '#64748b', fontWeight: '600' }}>Task Slot (Time)</Text>
                <Text style={{ fontSize: 12, color: '#0f172a', fontWeight: '800' }}>
                  {selectedShift === '10:00' ? 'Morning (10:00)' : 'Evening (16:00)'}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6, marginTop: 4 }}>
                <Text style={{ fontSize: 11, color: '#64748b', fontWeight: '600' }}>Photo capture</Text>
                <Text style={{ fontSize: 12, color: '#0f172a', fontWeight: '800' }}>{photoClock}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                <Text style={{ fontSize: 11, color: '#64748b', fontWeight: '600' }}>Submit time</Text>
                <Text style={{ fontSize: 12, color: '#0f172a', fontWeight: '800' }}>{submitClock}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 11, color: '#64748b', fontWeight: '600' }}>Difference</Text>
                <Text style={{
                  fontSize: 12,
                  fontWeight: '800',
                  color: isVarianceAlert ? '#dc2626' : '#16a34a'
                }}>
                  {diffMins == null ? 'N/A' : `${diffMins} min`}
                </Text>
              </View>
            </View>

            {/* Temperature Compliance Warning */}
            {(() => {
              const tempVal = parseFloat(tempInput);
              let isTempNonCompliant = false;
              let rangeText = '';
              
              if (!isNaN(tempVal)) {
                if (selectedChamberType === 'Frozen' && tempVal > -18) {
                  isTempNonCompliant = true;
                  rangeText = '<= -18°C';
                } else if (selectedChamberType === 'Chilled' && (tempVal < -5 || tempVal > 5)) {
                  isTempNonCompliant = true;
                  rangeText = '-5°C to 5°C';
                } else if (selectedChamberType === 'Dry' && (tempVal < 15 || tempVal > 25)) {
                  isTempNonCompliant = true;
                  rangeText = '15°C to 25°C';
                }
              }

              if (!isTempNonCompliant) return null;

              return (
                <View style={{
                  backgroundColor: '#fffbeb',
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: '#fef3c7',
                  padding: 12,
                  marginBottom: 14,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8
                }}>
                  <Ionicons name="warning" size={18} color="#d97706" />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, fontWeight: '800', color: '#b45309' }}>
                      Non-Compliant Temperature
                    </Text>
                    <Text style={{ fontSize: 10, fontWeight: '600', color: '#d97706', marginTop: 1 }}>
                      Your temp of {tempVal}°C is not good as a compliance {selectedChamberType} (Range: {rangeText}).
                    </Text>
                  </View>
                </View>
              );
            })()}

            <Text style={[styles.dialogSubtitle, { textAlign: 'center', marginBottom: 20 }]}>
              {diffMins == null ? (
                <Text style={{ color: '#ef4444', fontWeight: 'bold' }}>
                  Photo capture time missing. Retake verification photo, then submit.
                </Text>
              ) : isVarianceAlert ? (
                <Text style={{ color: '#ef4444', fontWeight: 'bold' }}>
                  Warning: Photo was captured {diffMins} minutes before submit (limit 5 minutes).
                </Text>
              ) : (
                <Text style={{ color: '#16a34a', fontWeight: 'bold' }}>
                  Photo time vs submit is compliant ({diffMins} min).
                </Text>
              )}
            </Text>

            <Text style={{ fontSize: 12, color: '#64748b', textAlign: 'center', marginBottom: 20 }}>
              {editingExistingLog
                ? 'Continue to update this inspection record?'
                : 'Do you want to continue and submit this inspection record?'}
            </Text>

            <View style={styles.dialogActionsRow}>
              <TouchableOpacity 
                style={styles.dialogCancelBtn}
                onPress={() => setShowSubmitConfirmModal(false)}
              >
                <Text style={styles.dialogCancelBtnText}>Back</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[
                  styles.dialogSaveBtn, 
                  { backgroundColor: isVarianceAlert ? '#dc2626' : '#003580' }
                ]}
                onPress={handleConfirmSaveInspection}
              >
                <Text style={styles.dialogSaveBtnText}>Continue</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  // Helper to generate calendar grid days for a given month
  const getCalendarDays = (dateObj) => {
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth();
    
    const firstDay = new Date(year, month, 1);
    const totalDays = new Date(year, month + 1, 0).getDate();
    let startDayOfWeek = firstDay.getDay(); 
    
    const days = [];
    for (let i = 0; i < startDayOfWeek; i++) {
      days.push(null);
    }
    for (let day = 1; day <= totalDays; day++) {
      days.push(new Date(year, month, day));
    }
    return days;
  };

  // Custom month calendar modal — pick From then To for report range
  const renderCalendarModal = () => {
    const days = getCalendarDays(calendarMonth);
    const monthName = calendarMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    const rangeStart = reportDateFrom <= reportDateTo ? reportDateFrom : reportDateTo;
    const rangeEnd = reportDateFrom <= reportDateTo ? reportDateTo : reportDateFrom;

    return (
      <Modal visible={showCalendarModal} transparent animationType="slide" onRequestClose={() => setShowCalendarModal(false)}>
        <View style={styles.reportFilterModalOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setShowCalendarModal(false)}
          />
          <View style={styles.calendarFilterModalSheet}>
            <View style={styles.calendarSheetHandle} />
            <Text style={styles.reportFilterModalTitle}>Select date range</Text>
            <Text style={styles.calendarSheetHint}>
              {calendarPickMode === 'from'
                ? 'Tap start date, then end date'
                : 'Tap end date to finish range'}
            </Text>

            <View style={styles.calendarSheetChipRow}>
              <TouchableOpacity
                style={[
                  styles.reportRangePickChip,
                  calendarPickMode === 'from' && styles.reportRangePickChipActive,
                  { flex: 1, marginRight: 8 }
                ]}
                onPress={() => setCalendarPickMode('from')}
              >
                <Text style={[
                  styles.reportRangePickChipText,
                  calendarPickMode === 'from' && styles.reportRangePickChipTextActive
                ]} numberOfLines={1}>
                  From: {reportDateFrom}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.reportRangePickChip,
                  calendarPickMode === 'to' && styles.reportRangePickChipActive,
                  { flex: 1 }
                ]}
                onPress={() => setCalendarPickMode('to')}
              >
                <Text style={[
                  styles.reportRangePickChipText,
                  calendarPickMode === 'to' && styles.reportRangePickChipTextActive
                ]} numberOfLines={1}>
                  To: {reportDateTo}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.calendarSheetMonthRow}>
              <TouchableOpacity onPress={() => {
                const prev = new Date(calendarMonth);
                prev.setMonth(prev.getMonth() - 1);
                setCalendarMonth(prev);
              }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="chevron-back" size={20} color="#003580" />
              </TouchableOpacity>
              
              <Text style={styles.calendarSheetMonthText}>{monthName}</Text>
              
              <TouchableOpacity onPress={() => {
                const next = new Date(calendarMonth);
                next.setMonth(next.getMonth() + 1);
                setCalendarMonth(next);
              }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="chevron-forward" size={20} color="#003580" />
              </TouchableOpacity>
            </View>

            <View style={{ flexDirection: 'row', marginBottom: 4 }}>
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                <Text key={`cal-wd-${i}`} style={styles.calendarSheetWeekDay}>
                  {d}
                </Text>
              ))}
            </View>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {days.map((d, index) => {
                if (d === null) {
                  return <View key={`empty_${index}`} style={styles.calendarSheetDayCell} />;
                }
                const dateStr = getLocalDateStr(d);
                const isStart = dateStr === rangeStart;
                const isEnd = dateStr === rangeEnd;
                const inRange = dateStr >= rangeStart && dateStr <= rangeEnd;
                const isToday = dateStr === getLocalDateStr();

                return (
                  <TouchableOpacity
                    key={dateStr}
                    style={[
                      styles.calendarSheetDayCell,
                      {
                        borderRadius: 16,
                        backgroundColor: isStart || isEnd ? '#003580' : inRange ? '#dbeafe' : 'transparent',
                        borderWidth: isToday && !isStart && !isEnd ? 1 : 0,
                        borderColor: '#93c5fd',
                      },
                    ]}
                    onPress={() => {
                      if (calendarPickMode === 'from') {
                        setReportDateFrom(dateStr);
                        setSelectedReportDate(dateStr);
                        // If new from is after current to, move to as well
                        if (dateStr > reportDateTo) {
                          setReportDateTo(dateStr);
                        }
                        setCalendarPickMode('to');
                      } else {
                        let nextFrom = reportDateFrom;
                        let nextTo = dateStr;
                        if (dateStr < reportDateFrom) {
                          nextFrom = dateStr;
                          nextTo = reportDateFrom;
                        }
                        setReportDateFrom(nextFrom);
                        setReportDateTo(nextTo);
                        setSelectedReportDate(nextTo);
                        setCalendarPickMode('from');
                        setShowCalendarModal(false);
                      }
                    }}
                  >
                    <Text style={{
                      fontSize: 12,
                      fontWeight: isStart || isEnd || isToday ? '800' : '600',
                      color: isStart || isEnd ? '#ffffff' : '#0f172a'
                    }}>
                      {d.getDate()}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity 
              style={styles.reportFilterModalClose}
              onPress={() => setShowCalendarModal(false)}
              activeOpacity={0.85}
            >
              <Text style={styles.reportFilterModalCloseText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  };

  const openDockReportCalendar = (kind, mode = 'from') => {
    const from = kind === 'outward' ? outwardReportDateFrom : inwardReportDateFrom;
    const to = kind === 'outward' ? outwardReportDateTo : inwardReportDateTo;
    const seed =
      mode === 'to' && to
        ? to
        : from || getLocalDateStr();
    const seedDate = new Date(`${seed}T12:00:00`);
    setDockReportCalendarKind(kind);
    setDockReportCalendarPickMode(mode);
    setDockReportCalendarMonth(Number.isNaN(seedDate.getTime()) ? new Date() : seedDate);
    setDockReportCalendarOpen(true);
  };

  const renderDockReportCalendarModal = () => {
    const isOutward = dockReportCalendarKind === 'outward';
    const dateFrom = isOutward ? outwardReportDateFrom : inwardReportDateFrom;
    const dateTo = isOutward ? outwardReportDateTo : inwardReportDateTo;
    const setDateFrom = isOutward ? setOutwardReportDateFrom : setInwardReportDateFrom;
    const setDateTo = isOutward ? setOutwardReportDateTo : setInwardReportDateTo;
    const days = getCalendarDays(dockReportCalendarMonth);
    const monthName = dockReportCalendarMonth.toLocaleString('default', {
      month: 'long',
      year: 'numeric',
    });
    const weekDays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const rangeStart =
      dateFrom && dateTo
        ? dateFrom <= dateTo
          ? dateFrom
          : dateTo
        : dateFrom || dateTo || '';
    const rangeEnd =
      dateFrom && dateTo
        ? dateFrom <= dateTo
          ? dateTo
          : dateFrom
        : dateFrom || dateTo || '';
    const todayStr = getLocalDateStr();

    return (
      <Modal
        visible={dockReportCalendarOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setDockReportCalendarOpen(false)}
      >
        <View style={styles.reportFilterModalOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setDockReportCalendarOpen(false)}
          />
          <View style={styles.calendarFilterModalSheet}>
            <View style={styles.calendarSheetHandle} />
            <Text style={styles.reportFilterModalTitle}>Select date range</Text>
            <Text style={styles.calendarSheetHint}>
              {dockReportCalendarPickMode === 'from'
                ? 'Tap start date, then end date'
                : 'Tap end date to finish range'}
            </Text>

            <View style={styles.calendarSheetChipRow}>
              <TouchableOpacity
                style={[
                  styles.reportRangePickChip,
                  dockReportCalendarPickMode === 'from' && styles.reportRangePickChipActive,
                  { flex: 1, marginRight: 8 },
                ]}
                onPress={() => setDockReportCalendarPickMode('from')}
              >
                <Text
                  style={[
                    styles.reportRangePickChipText,
                    dockReportCalendarPickMode === 'from' && styles.reportRangePickChipTextActive,
                  ]}
                  numberOfLines={1}
                >
                  From: {dateFrom || 'Select'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.reportRangePickChip,
                  dockReportCalendarPickMode === 'to' && styles.reportRangePickChipActive,
                  { flex: 1 },
                ]}
                onPress={() => setDockReportCalendarPickMode('to')}
              >
                <Text
                  style={[
                    styles.reportRangePickChipText,
                    dockReportCalendarPickMode === 'to' && styles.reportRangePickChipTextActive,
                  ]}
                  numberOfLines={1}
                >
                  To: {dateTo || 'Select'}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.calendarSheetMonthRow}>
              <TouchableOpacity
                onPress={() => {
                  const prev = new Date(dockReportCalendarMonth);
                  prev.setMonth(prev.getMonth() - 1);
                  setDockReportCalendarMonth(prev);
                }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="chevron-back" size={20} color="#003580" />
              </TouchableOpacity>
              <Text style={styles.calendarSheetMonthText}>{monthName}</Text>
              <TouchableOpacity
                onPress={() => {
                  const next = new Date(dockReportCalendarMonth);
                  next.setMonth(next.getMonth() + 1);
                  setDockReportCalendarMonth(next);
                }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="chevron-forward" size={20} color="#003580" />
              </TouchableOpacity>
            </View>

            <View style={{ flexDirection: 'row', marginBottom: 4 }}>
              {weekDays.map((d, i) => (
                <Text key={`dock-wd-${i}`} style={styles.calendarSheetWeekDay}>
                  {d}
                </Text>
              ))}
            </View>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {days.map((d, index) => {
                if (d === null) {
                  return <View key={`dock-empty_${index}`} style={styles.calendarSheetDayCell} />;
                }
                const dateStr = getLocalDateStr(d);
                const isStart = dateStr === rangeStart;
                const isEnd = dateStr === rangeEnd;
                const inRange = rangeStart && rangeEnd && dateStr >= rangeStart && dateStr <= rangeEnd;
                const isToday = dateStr === todayStr;
                const isDisabled =
                  dockReportCalendarPickMode === 'to' && dateFrom && dateStr < dateFrom;

                return (
                  <TouchableOpacity
                    key={dateStr}
                    disabled={!!isDisabled}
                    style={[
                      styles.calendarSheetDayCell,
                      {
                        borderRadius: 16,
                        backgroundColor:
                          isStart || isEnd ? '#003580' : inRange ? '#dbeafe' : 'transparent',
                        borderWidth: isToday && !isStart && !isEnd ? 1 : 0,
                        borderColor: '#93c5fd',
                        opacity: isDisabled ? 0.3 : 1,
                      },
                    ]}
                    onPress={() => {
                      if (dockReportCalendarPickMode === 'from') {
                        setDateFrom(dateStr);
                        if (!dateTo || dateStr > dateTo) setDateTo(dateStr);
                        setDockReportCalendarPickMode('to');
                      } else {
                        if (dateFrom && dateStr < dateFrom) {
                          setDateFrom(dateStr);
                          setDateTo(dateFrom);
                        } else {
                          setDateTo(dateStr);
                          if (!dateFrom) setDateFrom(dateStr);
                        }
                        setDockReportCalendarPickMode('from');
                        setDockReportCalendarOpen(false);
                      }
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: isStart || isEnd || isToday ? '800' : '600',
                        color: isStart || isEnd ? '#ffffff' : '#0f172a',
                      }}
                    >
                      {d.getDate()}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.calendarSheetSuggestRow}>
              <TouchableOpacity
                style={styles.doSuggestChip}
                onPress={() => {
                  const t = getLocalDateStr();
                  setDateFrom(t);
                  setDateTo(t);
                  setDockReportCalendarOpen(false);
                }}
              >
                <Text style={styles.doSuggestText}>Today</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.doSuggestChip}
                onPress={() => {
                  const d = new Date();
                  d.setDate(d.getDate() - 1);
                  const y = getLocalDateStr(d);
                  setDateFrom(y);
                  setDateTo(y);
                  setDockReportCalendarOpen(false);
                }}
              >
                <Text style={styles.doSuggestText}>Yesterday</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.doSuggestChip}
                onPress={() => {
                  const end = new Date();
                  const start = new Date();
                  start.setDate(end.getDate() - 6);
                  setDateFrom(getLocalDateStr(start));
                  setDateTo(getLocalDateStr(end));
                  setDockReportCalendarOpen(false);
                }}
              >
                <Text style={styles.doSuggestText}>Last 7 days</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.reportFilterModalClose}
              onPress={() => setDockReportCalendarOpen(false)}
              activeOpacity={0.85}
            >
              <Text style={styles.reportFilterModalCloseText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  };

  // Custom calendar modal for reports detail history screen
  const renderDetailCalendarModal = () => {
    if (!detailCalendarOpen) return null;

    const days = getCalendarDays(detailCalendarMonth);
    const monthName = detailCalendarMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
    const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const rangeStart = detailDateFrom && detailDateTo ? (detailDateFrom <= detailDateTo ? detailDateFrom : detailDateTo) : (detailDateFrom || detailDateTo || '');
    const rangeEnd = detailDateFrom && detailDateTo ? (detailDateFrom <= detailDateTo ? detailDateTo : detailDateFrom) : (detailDateFrom || detailDateTo || '');

    return (
      <Modal visible={detailCalendarOpen} transparent animationType="fade" onRequestClose={() => setDetailCalendarOpen(false)}>
        <View style={styles.dialogOverlay}>
          <View style={[styles.dialogContent, { width: 320, padding: 16 }]}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: '#0f172a', marginBottom: 4 }}>
              Select history range
            </Text>
            <Text style={{ fontSize: 11, color: '#64748b', marginBottom: 12 }}>
              {detailCalendarPickMode === 'from'
                ? 'Tap start date, then end date'
                : 'Tap end date to finish range'}
            </Text>

            <View style={{ flexDirection: 'row', marginBottom: 12 }}>
              <TouchableOpacity
                style={[
                  styles.reportRangePickChip,
                  detailCalendarPickMode === 'from' && styles.reportRangePickChipActive,
                  { marginRight: 8 }
                ]}
                onPress={() => setDetailCalendarPickMode('from')}
              >
                <Text style={[
                  styles.reportRangePickChipText,
                  detailCalendarPickMode === 'from' && styles.reportRangePickChipTextActive
                ]}>
                  From: {detailDateFrom || 'Select'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.reportRangePickChip,
                  detailCalendarPickMode === 'to' && styles.reportRangePickChipActive
                ]}
                onPress={() => setDetailCalendarPickMode('to')}
              >
                <Text style={[
                  styles.reportRangePickChipText,
                  detailCalendarPickMode === 'to' && styles.reportRangePickChipTextActive
                ]}>
                  To: {detailDateTo || 'Select'}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <TouchableOpacity onPress={() => {
                const prev = new Date(detailCalendarMonth);
                prev.setMonth(prev.getMonth() - 1);
                setDetailCalendarMonth(prev);
              }}>
                <Ionicons name="chevron-back" size={20} color="#003580" />
              </TouchableOpacity>
              
              <Text style={{ fontSize: 14, fontWeight: 'bold', color: '#0f172a' }}>{monthName}</Text>
              
              <TouchableOpacity onPress={() => {
                const next = new Date(detailCalendarMonth);
                next.setMonth(next.getMonth() + 1);
                setDetailCalendarMonth(next);
              }}>
                <Ionicons name="chevron-forward" size={20} color="#003580" />
              </TouchableOpacity>
            </View>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 }}>
              {weekDays.map(d => (
                <Text key={d} style={{ width: '14.28%', textAlign: 'center', fontSize: 10, color: '#64748b', fontWeight: 'bold' }}>
                  {d[0]}
                </Text>
              ))}
            </View>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {days.map((d, index) => {
                if (d === null) {
                  return <View key={`empty_detail_${index}`} style={{ width: '14.28%', height: 34 }} />;
                }
                const dateStr = getLocalDateStr(d);
                const isStart = dateStr === rangeStart;
                const isEnd = dateStr === rangeEnd;
                const inRange = rangeStart && rangeEnd && dateStr >= rangeStart && dateStr <= rangeEnd;
                const isToday = dateStr === getLocalDateStr();

                return (
                  <TouchableOpacity
                    key={dateStr}
                    style={{
                      width: '14.28%',
                      height: 34,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 17,
                      backgroundColor: isStart || isEnd ? '#003580' : inRange ? '#dbeafe' : 'transparent',
                      borderWidth: isToday && !isStart && !isEnd ? 1 : 0,
                      borderColor: '#003580',
                    }}
                    onPress={() => {
                      if (detailCalendarPickMode === 'from') {
                        setDetailDateFrom(dateStr);
                        // If new from is after current to, move to as well
                        if (!detailDateTo || dateStr > detailDateTo) {
                          setDetailDateTo(dateStr);
                        }
                        setDetailCalendarPickMode('to');
                      } else {
                        let nextFrom = detailDateFrom;
                        let nextTo = dateStr;
                        if (detailDateFrom && dateStr < detailDateFrom) {
                          nextFrom = dateStr;
                          nextTo = detailDateFrom;
                        }
                        setDetailDateFrom(nextFrom);
                        setDetailDateTo(nextTo);
                        setDetailCalendarPickMode('from');
                        setDetailCalendarOpen(false);
                      }
                    }}
                  >
                    <Text style={{
                      fontSize: 11,
                      fontWeight: isStart || isEnd || isToday ? 'bold' : 'normal',
                      color: isStart || isEnd ? '#ffffff' : '#0f172a'
                    }}>
                      {d.getDate()}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity 
              style={[styles.dialogCancelBtn, { marginTop: 16, alignSelf: 'stretch', alignItems: 'center' }]}
              onPress={() => setDetailCalendarOpen(false)}
            >
              <Text style={styles.dialogCancelBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  };

  // Horizontal Date Slider selector element
  const renderDateSlider = () => {
    const sliderDates = [];
    const weekDayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      sliderDates.push(d);
    }

    return (
      <View style={styles.sliderOuterContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sliderScroll}>
          {sliderDates.map((dateObj, i) => {
            const dateStr = getLocalDateStr(dateObj);
            const isSelected =
              reportDateFrom === reportDateTo && dateStr === reportDateFrom;
            const dayName = i === 0 ? 'Today' : weekDayNames[dateObj.getDay()];
            const dayNum = String(dateObj.getDate()).padStart(2, '0');

            return (
              <TouchableOpacity
                key={dateStr}
                style={[
                  styles.sliderCard,
                  isSelected && styles.sliderCardActive
                ]}
                onPress={() => {
                  setSelectedReportDate(dateStr);
                  setReportDateFrom(dateStr);
                  setReportDateTo(dateStr);
                }}
              >
                <Text style={[styles.sliderDayName, isSelected && styles.sliderTextActive]}>{dayName}</Text>
                <Text style={[styles.sliderDayNum, isSelected && styles.sliderTextActive]}>{dayNum}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        
        <TouchableOpacity 
          style={styles.sliderCalendarBtn}
          onPress={() => {
            setCalendarMonth(new Date(reportDateFrom));
            setCalendarPickMode('from');
            setShowCalendarModal(true);
          }}
        >
          <Ionicons name="calendar-outline" size={18} color="#003580" />
          <Text style={styles.sliderCalendarBtnText}>Range</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const inwardClientSuggestions = useMemo(() => {
    const names = new Set();
    const activeAssignments = (assignments || []).filter((a) => a && a.status !== 'inactive');
    activeAssignments.forEach((a) => {
      const n = String(a.client_name || '').trim();
      if (n && n.toLowerCase() !== 'general') names.add(n);
    });
    if (names.size === 0) {
      (masterClientLots || []).forEach((n) => {
        const trimmed = String(n || '').trim();
        if (trimmed) names.add(trimmed);
      });
    }
    return Array.from(names);
  }, [assignments, masterClientLots]);

  const loadInwardReports = useCallback(
    async (overrides = {}) => {
      if (!apiUrl || !token) {
        setInwardReportsError('Login session or server URL is missing.');
        return;
      }
      const page = overrides.page ?? inwardReportPage;
      const search = overrides.search ?? inwardReportSearch;
      const fromDate =
        Object.prototype.hasOwnProperty.call(overrides, 'fromDate')
          ? overrides.fromDate
          : inwardReportDateFrom;
      const toDate =
        Object.prototype.hasOwnProperty.call(overrides, 'toDate')
          ? overrides.toDate
          : inwardReportDateTo;
      const missingPod =
        Object.prototype.hasOwnProperty.call(overrides, 'missingPod')
          ? Boolean(overrides.missingPod)
          : inwardReportMissingPod;

      setInwardReportsLoading(true);
      setInwardReportsError('');
      try {
        const qs = new URLSearchParams({
          limit: String(DOCK_REPORT_PAGE_SIZE),
          page: String(page),
        });
        const trimmedSearch = String(search || '').trim();
        if (trimmedSearch) qs.set('search', trimmedSearch);
        if (fromDate?.trim()) qs.set('fromDate', fromDate.trim());
        if (toDate?.trim()) qs.set('toDate', toDate.trim());
        if (missingPod) qs.set('missingPod', '1');

        const res = await fetch(`${apiUrl}/api/inward-logs?${qs.toString()}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.message || data.error || `Failed to load (${res.status})`);
        }
        let rows = Array.isArray(data.items)
          ? data.items
          : Array.isArray(data.data)
            ? data.data
            : Array.isArray(data.rows)
              ? data.rows
              : Array.isArray(data)
                ? data
                : [];

        const warehouseLower = doAccessScope.warehouseLower;
        if (warehouseLower) {
          rows = rows.filter((r) => {
            const wh = String(r.warehouse_name || '').trim().toLowerCase();
            return !wh || wh === warehouseLower;
          });
        }

        // Client-side safety net if older API ignores missingPod
        if (missingPod) {
          rows = rows.filter((r) => {
            const pod = String(r.inward_pod_photo || '').trim();
            return !pod || pod === 'null' || pod === 'undefined';
          });
        }

        setInwardReportRows(rows);
        setInwardReportPage(page);
        setInwardReportTotal(Number(data.total) || rows.length);
        setInwardReportHasMore(Boolean(data.hasMore));
      } catch (err) {
        setInwardReportsError(err.message || 'Failed to load inward reports.');
      } finally {
        setInwardReportsLoading(false);
        setInwardReportsRefreshing(false);
      }
    },
    [
      apiUrl,
      token,
      doAccessScope.warehouseLower,
      inwardReportPage,
      inwardReportSearch,
      inwardReportDateFrom,
      inwardReportDateTo,
      inwardReportMissingPod,
    ]
  );

  const applyInwardReportFilters = useCallback(() => {
    loadInwardReports({ page: 1 });
  }, [loadInwardReports]);

  const clearInwardReportFilters = useCallback(() => {
    const today = getLocalDateStr();
    setInwardReportSearch('');
    setInwardReportDateFrom(today);
    setInwardReportDateTo(today);
    setInwardReportMissingPod(false);
    loadInwardReports({
      page: 1,
      search: '',
      fromDate: today,
      toDate: today,
      missingPod: false,
    });
  }, [loadInwardReports]);

  const inwardDatePreset = useMemo(() => {
    const today = getLocalDateStr();
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 6);
    const sevenFrom = getLocalDateStr(start);
    const sevenTo = getLocalDateStr(end);
    const from = inwardReportDateFrom || '';
    const to = inwardReportDateTo || '';
    if (from === today && to === today) return 'today';
    if (from === sevenFrom && to === sevenTo) return '7days';
    return null;
  }, [inwardReportDateFrom, inwardReportDateTo]);

  const applyInwardDatePreset = useCallback(
    (preset) => {
      if (preset === 'today') {
        const t = getLocalDateStr();
        setInwardReportDateFrom(t);
        setInwardReportDateTo(t);
        loadInwardReports({ page: 1, fromDate: t, toDate: t });
        return;
      }
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate() - 6);
      const from = getLocalDateStr(start);
      const to = getLocalDateStr(end);
      setInwardReportDateFrom(from);
      setInwardReportDateTo(to);
      loadInwardReports({ page: 1, fromDate: from, toDate: to });
    },
    [loadInwardReports]
  );

  const toggleInwardMissingPodFilter = useCallback(() => {
    const next = !inwardReportMissingPod;
    setInwardReportMissingPod(next);
    if (next) {
      // Show full missing-POD list (all dates) when filter is turned on
      setInwardReportDateFrom('');
      setInwardReportDateTo('');
      loadInwardReports({
        page: 1,
        missingPod: true,
        fromDate: '',
        toDate: '',
      });
    } else {
      const today = getLocalDateStr();
      setInwardReportDateFrom(today);
      setInwardReportDateTo(today);
      loadInwardReports({
        page: 1,
        missingPod: false,
        fromDate: today,
        toDate: today,
      });
    }
  }, [inwardReportMissingPod, loadInwardReports]);

  const goInwardReportPrevPage = useCallback(() => {
    if (inwardReportPage <= 1) return;
    loadInwardReports({ page: inwardReportPage - 1 });
  }, [inwardReportPage, loadInwardReports]);

  const goInwardReportNextPage = useCallback(() => {
    if (!inwardReportHasMore) return;
    loadInwardReports({ page: inwardReportPage + 1 });
  }, [inwardReportHasMore, inwardReportPage, loadInwardReports]);

  const handleInwardSubmitted = useCallback(
    ({ syncedNow } = {}) => {
      loadInwardReports();
      setSyncPendingCount(
        countPendingSyncItems(user?.warehouse_name, displayName, user?.email)
      );
      if (!syncedNow) {
        triggerSync(apiUrl, token, handleSyncProgress, user);
      }
    },
    [loadInwardReports, apiUrl, token, user, displayName]
  );

  const renderInwardsView = () => (
    <InwardFormView
      apiUrl={apiUrl}
      token={token}
      displayName={displayName}
      user={user}
      clientSuggestions={inwardClientSuggestions}
      onRememberClient={ensureClientInLotMaster}
      onSubmitted={handleInwardSubmitted}
    />
  );

  useEffect(() => {
    if (currentNavTab === 'InwardReports') {
      loadInwardReports();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNavTab]);

  const uploadInwardPodPhoto = useCallback(
    async (inwardId) => {
      if (!apiUrl || !token || !inwardId || podUploadBusy) return;
      try {
        const allowed = await ensureCameraPermission();
        if (!allowed) return;

        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          allowsEditing: false,
          quality: 1,
        });
        if (result.canceled || !result.assets?.length) return;

        setPodUploadBusy(true);
        const compressedUri = await compressImageOnly(result.assets[0].uri, 0.5);
        const formData = new FormData();
        appendLocalFile(formData, 'inward_pod_photo', compressedUri, {
          name: `inward-pod-${inwardId}.jpg`,
          type: 'image/jpeg',
        });

        const res = await multipartRequest(`${apiUrl}/api/inward-logs/${inwardId}/pod-photo`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || data.message || `Upload failed (${res.status})`);
        }

        const newPath = data.inward_pod_photo;
        setSelectedInwardReport((prev) =>
          prev && String(prev.inward_id) === String(inwardId)
            ? { ...prev, inward_pod_photo: newPath }
            : prev
        );
        setInwardReportRows((rows) =>
          rows.map((r) =>
            String(r.inward_id) === String(inwardId) ? { ...r, inward_pod_photo: newPath } : r
          )
        );
        Alert.alert('POD updated', 'POD photo saved successfully.');
      } catch (err) {
        Alert.alert('POD upload failed', err.message || 'Could not update POD photo.');
      } finally {
        setPodUploadBusy(false);
      }
    },
    [apiUrl, token, podUploadBusy]
  );

  const splitInwardPhotoPaths = (value) => {
    if (!value) return [];
    return String(value)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== 'null' && s !== 'undefined');
  };

  const renderInwardDetailModal = () => {
    if (!selectedInwardReport) return null;
    const item = selectedInwardReport;
    const shortQty = parseInt(item.inward_short_received_boxes_qty, 10) || 0;
    const excessQty = parseInt(item.inward_excess_received_boxes_qty, 10) || 0;
    const damageQty = parseInt(item.inward_damage_received_boxes_qty, 10) || 0;
    const recordWarehouse = item.warehouse_name || user?.warehouse_name || '—';
    const recordOperator = item.operator_email || user?.email || '—';
    const operatorLabel = recordOperator.includes('@')
      ? recordOperator.split('@')[0]
      : recordOperator;

    const sections = [
      {
        title: 'Location & Operator',
        rows: [
          ['Warehouse', recordWarehouse],
          ['Operator', recordOperator],
        ],
      },
      {
        title: 'Arrival',
        rows: [
          ['Reference', item.reference_no || `INW-${item.inward_id}`],
          ['Entry date', item.inward_entry_date],
          ['Client', item.inward_client_name],
          ['Dock', item.inward_dock_no],
          ['Material', item.inward_material_type],
          ['Vehicle no.', item.inward_vehicle_no],
          ['Seal no.', item.inward_seal_no],
          ['Transporter', item.inward_transporter_name],
          ['Driver', item.inward_driver_name],
          ['Driver phone', item.inward_driver_no],
        ],
      },
      {
        title: 'Timing',
        rows: [
          ['Reporting time', item.inward_vehicle_reporting_time],
          ['Unload start', item.inward_unloading_start_time],
          ['Unload end', item.inward_unloading_end_time],
          [
            'Duration',
            item.inward_unloading_duration_hours != null || item.inward_unloading_duration_mins != null
              ? `${item.inward_unloading_duration_hours || 0}h ${item.inward_unloading_duration_mins || 0}m`
              : null,
          ],
        ],
      },
      {
        title: 'Temperature & Quantity',
        rows: [
          ['Vehicle temp', item.inward_vehicle_temp != null ? `${item.inward_vehicle_temp}°C` : null],
          ['Material temp', item.inward_material_temp != null ? `${item.inward_material_temp}°C` : null],
          ['Pallets in', item.inward_pallets_in_qty],
          ['Invoice boxes', item.inward_invoice_qty],
          ['Boxes received', item.inward_received_boxes_qty ?? item.inward_received_qty],
          ['Short qty', shortQty > 0 ? String(shortQty) : '0'],
          ['Excess qty', excessQty > 0 ? String(excessQty) : '0'],
          ['Damage qty', damageQty > 0 ? String(damageQty) : '0'],
          ['Supervisor', item.inward_unloading_supervisor_name],
          ['Remarks', item.inward_remarks],
        ],
      },
    ];

    const photoGroups = [
      { label: 'Invoice', fieldKey: 'inward_invoice_photos', paths: splitInwardPhotoPaths(item.inward_invoice_photos) },
      { label: 'Vehicle temp', fieldKey: 'inward_vehicle_temp_photo', paths: splitInwardPhotoPaths(item.inward_vehicle_temp_photo) },
      { label: 'Material temp', fieldKey: 'inward_material_temp_photo', paths: splitInwardPhotoPaths(item.inward_material_temp_photo) },
      { label: 'Vehicle back', fieldKey: 'inward_vehicle_back_side_photo', paths: splitInwardPhotoPaths(item.inward_vehicle_back_side_photo) },
      {
        label: 'Back with material',
        fieldKey: 'inward_vehicle_back_side_photo_with_material',
        paths: splitInwardPhotoPaths(item.inward_vehicle_back_side_photo_with_material),
      },
      { label: 'Count sheet', fieldKey: 'inward_count_sheet_photo', paths: splitInwardPhotoPaths(item.inward_count_sheet_photo) },
      { label: 'Seal', fieldKey: 'inward_vehicle_seal_photo', paths: splitInwardPhotoPaths(item.inward_vehicle_seal_photo) },
      { label: 'Damage boxes', fieldKey: 'inward_damage_boxes_photo', paths: splitInwardPhotoPaths(item.inward_damage_boxes_photo) },
    ].filter((g) => g.paths.length > 0);
    const podPaths = splitInwardPhotoPaths(item.inward_pod_photo);

    const photoItems = photoGroups.flatMap((group) =>
      group.paths.map((path, idx) => ({
        key: `${group.fieldKey}-${idx}`,
        label: group.paths.length > 1 ? `${group.label} ${idx + 1}` : group.label,
        path,
        fieldKey: group.fieldKey,
        photoIndex: idx,
      }))
    );

    const renderDetailRow = (label, value) => {
      if (value == null || value === '') return null;
      return (
        <View style={styles.doLogDetailRow} key={label}>
          <Text style={styles.doLogDetailLabel}>{label}</Text>
          <Text style={styles.doLogDetailValue}>{String(value)}</Text>
        </View>
      );
    };

    return (
      <Modal
        visible={Boolean(selectedInwardReport)}
        animationType="slide"
        onRequestClose={() => setSelectedInwardReport(null)}
      >
        <SafeAreaView style={styles.doDetailSafe}>
          <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
          <View style={styles.doDetailHeader}>
            <TouchableOpacity
              style={styles.doDetailBackBtn}
              onPress={() => setSelectedInwardReport(null)}
              activeOpacity={0.85}
            >
              <Ionicons name="arrow-back" size={22} color="#0f172a" />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={styles.doDetailTitle} numberOfLines={1}>
                Inward details
              </Text>
              <Text style={styles.doDetailSub} numberOfLines={2}>
                {item.reference_no || `INW-${item.inward_id}`} · {item.inward_client_name || 'Client'}
                {'\n'}
                {recordWarehouse} · {operatorLabel}
              </Text>
            </View>
          </View>

          <ScrollView contentContainerStyle={styles.doDetailBody} showsVerticalScrollIndicator={false}>
            <View style={styles.doDetailHeroCard}>
              <Text style={styles.doDetailHeroTemp}>
                {item.inward_material_temp != null ? `${item.inward_material_temp}°C` : '—'}
              </Text>
              <Text style={styles.doDetailHeroMeta}>
                {recordWarehouse}
                {item.inward_entry_date ? ` · ${item.inward_entry_date}` : ''}
                {' · Material temp'}
                {item.inward_vehicle_temp != null ? ` · Veh ${item.inward_vehicle_temp}°C` : ''}
              </Text>
            </View>

            {sections.map((section) => (
              <View style={styles.doDetailCard} key={section.title}>
                <Text style={styles.doDetailSectionTitle}>{section.title}</Text>
                {section.rows.map(([label, value]) => renderDetailRow(label, value))}
              </View>
            ))}

            <View style={styles.doDetailCard}>
              <Text style={styles.doDetailSectionTitle}>POD Photo</Text>
              <Text style={styles.podUpdateHint}>
                Add or replace POD later — no need to re-fill the full inward form.
              </Text>
              {podPaths.length > 0 ? (
                <PhotoGridWithLocation
                  photoItems={podPaths.map((path, idx) => ({
                    key: `inward-pod-${idx}`,
                    label: podPaths.length > 1 ? `POD ${idx + 1}` : 'POD',
                    path,
                    fieldKey: 'inward_pod_photo',
                    photoIndex: idx,
                  }))}
                  folderHint="inward_images"
                  photoMeta={item.photo_capture_metadata}
                  resolveUri={(path, folderHint) =>
                    resolveDoImageUrl(path, apiUrl, folderHint) ||
                    resolveDoImageUrl(path, PRODUCTION_API_URL, folderHint)
                  }
                />
              ) : (
                <Text style={styles.podUpdateEmpty}>No POD photo yet</Text>
              )}
              <TouchableOpacity
                style={[styles.podUpdateBtn, podUploadBusy && styles.podUpdateBtnDisabled]}
                onPress={() => uploadInwardPodPhoto(item.inward_id)}
                disabled={podUploadBusy}
                activeOpacity={0.85}
              >
                {podUploadBusy ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons name="camera-outline" size={18} color="#fff" />
                    <Text style={styles.podUpdateBtnText}>
                      {podPaths.length > 0 ? 'Replace POD Photo' : 'Add POD Photo'}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            {photoItems.length > 0 ? (
              <View style={styles.doDetailCard}>
                <Text style={styles.doDetailSectionTitle}>Photos</Text>
                <PhotoGridWithLocation
                  photoItems={photoItems}
                  folderHint="inward_images"
                  photoMeta={item.photo_capture_metadata}
                  resolveUri={(path, folderHint) =>
                    resolveDoImageUrl(path, apiUrl, folderHint) ||
                    resolveDoImageUrl(path, PRODUCTION_API_URL, folderHint)
                  }
                />
              </View>
            ) : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    );
  };

  const renderInwardReportsView = () => (
    <View style={{ flex: 1, backgroundColor: '#f1f5f9' }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
        <Text style={{ fontSize: 15, fontWeight: '800', color: '#0f172a' }}>Inward Reports</Text>
        <Text style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>
          Saved inward entries · tap a card for full details
        </Text>
      </View>

      <View style={styles.dockReportFilterBar}>
        <View style={styles.dockReportSearchRow}>
          <Ionicons name="search-outline" size={14} color="#64748b" />
          <TextInput
            style={styles.dockReportSearchInput}
            placeholder="Search vehicle, client, ref…"
            placeholderTextColor="#94a3b8"
            value={inwardReportSearch}
            onChangeText={setInwardReportSearch}
            onSubmitEditing={applyInwardReportFilters}
            returnKeyType="search"
          />
        </View>
        <View style={[styles.reportListFilterRow, { marginTop: 0 }]}>
          <TouchableOpacity
            style={[styles.doFilterChip, !!inwardReportDateFrom && styles.doFilterChipActive]}
            onPress={() => openDockReportCalendar('inward', 'from')}
            activeOpacity={0.85}
          >
            <Text style={styles.doFilterChipLabel}>From</Text>
            <Text style={styles.doFilterChipValue} numberOfLines={1}>
              {inwardReportDateFrom
                ? inwardReportDateFrom === getLocalDateStr()
                  ? 'Today'
                  : inwardReportDateFrom
                : 'All'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.doFilterChip, !!inwardReportDateTo && styles.doFilterChipActive]}
            onPress={() => openDockReportCalendar('inward', 'to')}
            activeOpacity={0.85}
          >
            <Text style={styles.doFilterChipLabel}>To</Text>
            <Text style={styles.doFilterChipValue} numberOfLines={1}>
              {inwardReportDateTo
                ? inwardReportDateTo === getLocalDateStr()
                  ? 'Today'
                  : inwardReportDateTo
                : 'All'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.doFilterChip,
              inwardReportMissingPod && styles.doFilterChipActiveWarn,
            ]}
            onPress={toggleInwardMissingPodFilter}
            activeOpacity={0.85}
          >
            <Text style={styles.doFilterChipLabel}>POD</Text>
            <Text
              style={[
                styles.doFilterChipValue,
                inwardReportMissingPod && { color: '#b91c1c' },
              ]}
              numberOfLines={1}
            >
              {inwardReportMissingPod ? 'Missing' : 'All'}
            </Text>
          </TouchableOpacity>
        </View>
        <View style={styles.dockReportFilterActions}>
          <TouchableOpacity
            style={[
              styles.dockLogQuickBtn,
              inwardDatePreset === 'today' && styles.dockLogQuickBtnActive,
            ]}
            onPress={() => applyInwardDatePreset('today')}
            activeOpacity={0.85}
          >
            <Text
              style={[
                styles.dockLogQuickBtnText,
                inwardDatePreset === 'today' && styles.dockLogQuickBtnTextActive,
              ]}
            >
              Today
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.dockLogQuickBtn,
              inwardDatePreset === '7days' && styles.dockLogQuickBtnActive,
            ]}
            onPress={() => applyInwardDatePreset('7days')}
            activeOpacity={0.85}
          >
            <Text
              style={[
                styles.dockLogQuickBtnText,
                inwardDatePreset === '7days' && styles.dockLogQuickBtnTextActive,
              ]}
            >
              7 days
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.dockLogQuickBtn, styles.dockLogQuickBtnClear]}
            onPress={clearInwardReportFilters}
            activeOpacity={0.85}
          >
            <Text style={[styles.dockLogQuickBtnText, styles.dockLogQuickBtnClearText]}>
              Clear
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {isBlockingListLoad(inwardReportsLoading, inwardReportsRefreshing, inwardReportRows.length) ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color="#003580" />
          <Text style={{ marginTop: 8, color: '#64748b', fontSize: 12 }}>Loading reports…</Text>
        </View>
      ) : inwardReportsError && inwardReportRows.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Text style={{ color: '#b91c1c', textAlign: 'center', marginBottom: 12 }}>
            {inwardReportsError}
          </Text>
          <TouchableOpacity
            style={{
              backgroundColor: '#003580',
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 10,
            }}
            onPress={loadInwardReports}
          >
            <Text style={{ color: '#fff', fontWeight: '700' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
        <FlatList
          style={{ flex: 1 }}
          data={inwardReportRows}
          keyExtractor={(item, idx) => String(item.inward_id || item.reference_no || idx)}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 100 }}
          refreshing={inwardReportsRefreshing}
          onRefresh={() => {
            setInwardReportsRefreshing(true);
            loadInwardReports();
          }}
          ListFooterComponent={
            inwardReportTotal > 0 ? (
              <View style={styles.dockReportPagination}>
                <TouchableOpacity
                  style={[
                    styles.dockReportPageBtn,
                    inwardReportPage <= 1 && styles.dockReportPageBtnDisabled,
                  ]}
                  disabled={inwardReportPage <= 1 || inwardReportsLoading}
                  onPress={goInwardReportPrevPage}
                >
                  <Text style={styles.dockReportPageBtnText}>Previous</Text>
                </TouchableOpacity>
                <Text style={styles.dockReportPageMeta}>
                  {(inwardReportPage - 1) * DOCK_REPORT_PAGE_SIZE + 1}–
                  {Math.min(inwardReportPage * DOCK_REPORT_PAGE_SIZE, inwardReportTotal)} of{' '}
                  {inwardReportTotal}
                </Text>
                <TouchableOpacity
                  style={[
                    styles.dockReportPageBtn,
                    !inwardReportHasMore && styles.dockReportPageBtnDisabled,
                  ]}
                  disabled={!inwardReportHasMore || inwardReportsLoading}
                  onPress={goInwardReportNextPage}
                >
                  <Text style={styles.dockReportPageBtnText}>Next</Text>
                </TouchableOpacity>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingTop: 48, paddingHorizontal: 24 }}>
              <Ionicons name="document-text-outline" size={40} color="#94a3b8" />
              <Text style={{ marginTop: 10, color: '#64748b', fontSize: 13, textAlign: 'center' }}>
                {inwardReportMissingPod
                  ? 'No inward records are missing a POD photo.'
                  : inwardReportSearch || inwardReportDateFrom || inwardReportDateTo
                    ? 'No inward records match your filters.'
                    : 'No saved inward records yet. Submit an Inward Task to see it here.'}
              </Text>
            </View>
          }
          {...FLATLIST_PERF_PROPS}
          renderItem={({ item }) => {
            const received = item.inward_received_boxes_qty ?? item.inward_received_qty;
            const rightValue =
              item.inward_material_temp != null
                ? `${item.inward_material_temp}°C`
                : item.inward_vehicle_temp != null
                  ? `${item.inward_vehicle_temp}°C`
                  : received != null
                    ? String(received)
                    : '—';
            const vehicleOrDock = item.inward_vehicle_no
              ? `Vehicle ${item.inward_vehicle_no}`
              : item.inward_dock_no
                ? `Dock ${item.inward_dock_no}`
                : '—';
            const podVal = String(item.inward_pod_photo || '').trim();
            const podMissing = !podVal || podVal === 'null' || podVal === 'undefined';
            return (
              <TouchableOpacity
                style={styles.dockLogCard}
                activeOpacity={0.85}
                onPress={() => setSelectedInwardReport(item)}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={styles.dockLogTitleRow}>
                    <Text style={styles.dockLogTypeTag}>Inward</Text>
                    <Text style={styles.dockLogClient} numberOfLines={1}>
                      {item.inward_client_name || 'Client'}
                    </Text>
                    {podMissing ? (
                      <View style={styles.inwardPodMissingBadge}>
                        <Text style={styles.inwardPodMissingBadgeText}>POD</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.dockLogMeta} numberOfLines={2}>
                    {vehicleOrDock}
                    {item.warehouse_name ? ` · ${item.warehouse_name}` : ''}
                    {' · '}
                    {String(item.inward_entry_date || '').slice(0, 10) || '—'}
                    {item.inward_material_type ? ` · ${item.inward_material_type}` : ''}
                  </Text>
                </View>
                <Text style={styles.dockLogTemp}>{rightValue}</Text>
              </TouchableOpacity>
            );
          }}
        />
        <ListLoadingOverlay
          visible={isSoftListLoad(
            inwardReportsLoading,
            inwardReportsRefreshing,
            inwardReportRows.length
          )}
          label="Loading page…"
        />
        </View>
      )}
    </View>
  );

  const loadOutwardReports = useCallback(
    async (overrides = {}) => {
      if (!apiUrl || !token) {
        setOutwardReportsError('Login session or server URL is missing.');
        return;
      }
      const page = overrides.page ?? outwardReportPage;
      const search = overrides.search ?? outwardReportSearch;
      const fromDate =
        Object.prototype.hasOwnProperty.call(overrides, 'fromDate')
          ? overrides.fromDate
          : outwardReportDateFrom;
      const toDate =
        Object.prototype.hasOwnProperty.call(overrides, 'toDate')
          ? overrides.toDate
          : outwardReportDateTo;
      const missingPod =
        Object.prototype.hasOwnProperty.call(overrides, 'missingPod')
          ? Boolean(overrides.missingPod)
          : outwardReportMissingPod;

      setOutwardReportsLoading(true);
      setOutwardReportsError('');
      try {
        const qs = new URLSearchParams({
          limit: String(DOCK_REPORT_PAGE_SIZE),
          page: String(page),
        });
        const trimmedSearch = String(search || '').trim();
        if (trimmedSearch) qs.set('search', trimmedSearch);
        if (fromDate?.trim()) qs.set('fromDate', fromDate.trim());
        if (toDate?.trim()) qs.set('toDate', toDate.trim());
        if (missingPod) qs.set('missingPod', '1');

        const res = await fetch(`${apiUrl}/api/outward-logs?${qs.toString()}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.message || data.error || `Failed to load (${res.status})`);
        }
        let rows = Array.isArray(data.items)
          ? data.items
          : Array.isArray(data.data)
            ? data.data
            : Array.isArray(data.rows)
              ? data.rows
              : Array.isArray(data)
                ? data
                : [];

        const warehouseLower = doAccessScope.warehouseLower;
        if (warehouseLower) {
          rows = rows.filter((r) => {
            const wh = String(r.warehouse_name || '').trim().toLowerCase();
            return !wh || wh === warehouseLower;
          });
        }

        if (missingPod) {
          rows = rows.filter((r) => {
            const pod = String(r.outward_pod_photo || '').trim();
            return !pod || pod === 'null' || pod === 'undefined';
          });
        }

        setOutwardReportRows(rows);
        setOutwardReportPage(page);
        setOutwardReportTotal(Number(data.total) || rows.length);
        setOutwardReportHasMore(Boolean(data.hasMore));
      } catch (err) {
        setOutwardReportsError(err.message || 'Failed to load outward reports.');
      } finally {
        setOutwardReportsLoading(false);
        setOutwardReportsRefreshing(false);
      }
    },
    [
      apiUrl,
      token,
      doAccessScope.warehouseLower,
      outwardReportPage,
      outwardReportSearch,
      outwardReportDateFrom,
      outwardReportDateTo,
      outwardReportMissingPod,
    ]
  );

  const applyOutwardReportFilters = useCallback(() => {
    loadOutwardReports({ page: 1 });
  }, [loadOutwardReports]);

  const clearOutwardReportFilters = useCallback(() => {
    const today = getLocalDateStr();
    setOutwardReportSearch('');
    setOutwardReportDateFrom(today);
    setOutwardReportDateTo(today);
    setOutwardReportMissingPod(false);
    loadOutwardReports({
      page: 1,
      search: '',
      fromDate: today,
      toDate: today,
      missingPod: false,
    });
  }, [loadOutwardReports]);

  const outwardDatePreset = useMemo(() => {
    const today = getLocalDateStr();
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 6);
    const sevenFrom = getLocalDateStr(start);
    const sevenTo = getLocalDateStr(end);
    const from = outwardReportDateFrom || '';
    const to = outwardReportDateTo || '';
    if (from === today && to === today) return 'today';
    if (from === sevenFrom && to === sevenTo) return '7days';
    return null;
  }, [outwardReportDateFrom, outwardReportDateTo]);

  const applyOutwardDatePreset = useCallback(
    (preset) => {
      if (preset === 'today') {
        const t = getLocalDateStr();
        setOutwardReportDateFrom(t);
        setOutwardReportDateTo(t);
        loadOutwardReports({ page: 1, fromDate: t, toDate: t });
        return;
      }
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate() - 6);
      const from = getLocalDateStr(start);
      const to = getLocalDateStr(end);
      setOutwardReportDateFrom(from);
      setOutwardReportDateTo(to);
      loadOutwardReports({ page: 1, fromDate: from, toDate: to });
    },
    [loadOutwardReports]
  );

  const toggleOutwardMissingPodFilter = useCallback(() => {
    const next = !outwardReportMissingPod;
    setOutwardReportMissingPod(next);
    if (next) {
      setOutwardReportDateFrom('');
      setOutwardReportDateTo('');
      loadOutwardReports({
        page: 1,
        missingPod: true,
        fromDate: '',
        toDate: '',
      });
    } else {
      const today = getLocalDateStr();
      setOutwardReportDateFrom(today);
      setOutwardReportDateTo(today);
      loadOutwardReports({
        page: 1,
        missingPod: false,
        fromDate: today,
        toDate: today,
      });
    }
  }, [outwardReportMissingPod, loadOutwardReports]);

  const goOutwardReportPrevPage = useCallback(() => {
    if (outwardReportPage <= 1) return;
    loadOutwardReports({ page: outwardReportPage - 1 });
  }, [outwardReportPage, loadOutwardReports]);

  const goOutwardReportNextPage = useCallback(() => {
    if (!outwardReportHasMore) return;
    loadOutwardReports({ page: outwardReportPage + 1 });
  }, [outwardReportHasMore, outwardReportPage, loadOutwardReports]);

  const handleOutwardSubmitted = useCallback(
    ({ syncedNow } = {}) => {
      loadOutwardReports();
      setSyncPendingCount(
        countPendingSyncItems(user?.warehouse_name, displayName, user?.email)
      );
      if (!syncedNow) {
        triggerSync(apiUrl, token, handleSyncProgress, user);
      }
    },
    [loadOutwardReports, apiUrl, token, user, displayName]
  );

  const renderOutwardsView = () => (
    <OutwardFormView
      apiUrl={apiUrl}
      token={token}
      displayName={displayName}
      user={user}
      clientSuggestions={inwardClientSuggestions}
      onRememberClient={ensureClientInLotMaster}
      onSubmitted={handleOutwardSubmitted}
    />
  );

  useEffect(() => {
    if (currentNavTab === 'OutwardReports') {
      loadOutwardReports();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNavTab]);

  const uploadOutwardPodPhoto = useCallback(
    async (outwardId) => {
      if (!apiUrl || !token || !outwardId || podUploadBusy) return;
      try {
        const allowed = await ensureCameraPermission();
        if (!allowed) return;

        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          allowsEditing: false,
          quality: 1,
        });
        if (result.canceled || !result.assets?.length) return;

        setPodUploadBusy(true);
        const compressedUri = await compressImageOnly(result.assets[0].uri, 0.5);
        const formData = new FormData();
        appendLocalFile(formData, 'outward_pod_photo', compressedUri, {
          name: `outward-pod-${outwardId}.jpg`,
          type: 'image/jpeg',
        });

        const res = await multipartRequest(`${apiUrl}/api/outward-logs/${outwardId}/pod-photo`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || data.message || `Upload failed (${res.status})`);
        }

        const newPath = data.outward_pod_photo;
        setSelectedOutwardReport((prev) =>
          prev && String(prev.outward_id) === String(outwardId)
            ? { ...prev, outward_pod_photo: newPath }
            : prev
        );
        setOutwardReportRows((rows) =>
          rows.map((r) =>
            String(r.outward_id) === String(outwardId) ? { ...r, outward_pod_photo: newPath } : r
          )
        );
        Alert.alert('POD updated', 'POD photo saved successfully.');
      } catch (err) {
        Alert.alert('POD upload failed', err.message || 'Could not update POD photo.');
      } finally {
        setPodUploadBusy(false);
      }
    },
    [apiUrl, token, podUploadBusy]
  );

  const splitOutwardPhotoPaths = (value) => splitLogPhotoPaths(value);

  const renderOutwardDetailModal = () => {
    if (!selectedOutwardReport) return null;
    const item = selectedOutwardReport;
    const shortQty = parseInt(item.outward_short_received_boxes_qty, 10) || 0;
    const excessQty = parseInt(item.outward_excess_received_boxes_qty, 10) || 0;
    const damageQty = parseInt(item.outward_damage_received_boxes_qty, 10) || 0;
    const recordWarehouse = item.warehouse_name || user?.warehouse_name || '—';
    const recordOperator = item.operator_email || user?.email || '—';
    const operatorLabel = recordOperator.includes('@')
      ? recordOperator.split('@')[0]
      : recordOperator;
    const preVehicleTemp = item.outward_pre_vehicle_temp ?? item.outward_vehicle_temp;

    const sections = [
      {
        title: 'Location & Operator',
        rows: [
          ['Warehouse', recordWarehouse],
          ['Operator', recordOperator],
        ],
      },
      {
        title: 'Arrival',
        rows: [
          ['Reference', item.reference_no || `OUT-${item.outward_id}`],
          ['Entry date', item.outward_entry_date],
          ['Client', item.outward_client_name],
          ['Dock', item.outward_dock_no],
          ['Material', item.outward_material_type],
          ['Vehicle no.', item.outward_vehicle_no],
          ['Seal no.', item.outward_seal_no],
          ['Transporter', item.outward_transporter_name],
          ['Driver', item.outward_driver_name],
          ['Driver phone', item.outward_driver_no],
        ],
      },
      {
        title: 'Timing',
        rows: [
          ['Reporting time', item.outward_vehicle_reporting_time],
          ['Load start', item.outward_loading_start_time],
          ['Load end', item.outward_loading_end_time],
          [
            'Duration',
            item.outward_loading_duration_hours != null || item.outward_loading_duration_mins != null
              ? `${item.outward_loading_duration_hours || 0}h ${item.outward_loading_duration_mins || 0}m`
              : null,
          ],
        ],
      },
      {
        title: 'Temperature & Quantity',
        rows: [
          ['Pre vehicle temp', preVehicleTemp != null ? `${preVehicleTemp}°C` : null],
          ['Material temp', item.outward_material_temp != null ? `${item.outward_material_temp}°C` : null],
          ['Pallets out', item.outward_pallets_in_qty],
          ['Invoice boxes', item.outward_invoice_qty],
          ['Boxes loaded', item.outward_received_boxes_qty ?? item.outward_received_qty],
          ['Short qty', shortQty > 0 ? String(shortQty) : '0'],
          ['Excess qty', excessQty > 0 ? String(excessQty) : '0'],
          ['Damage qty', damageQty > 0 ? String(damageQty) : '0'],
          ['Supervisor', item.outward_loading_supervisor_name],
          ['Remarks', item.outward_remarks],
        ],
      },
    ];

    const photoGroups = [
      { label: 'Invoice', fieldKey: 'outward_invoice_photos', paths: splitOutwardPhotoPaths(item.outward_invoice_photos) },
      {
        label: 'Pre vehicle temp',
        fieldKey: 'outward_pre_vehicle_temp_photo',
        paths: splitOutwardPhotoPaths(
          item.outward_pre_vehicle_temp_photo || item.outward_vehicle_temp_photo
        ),
      },
      { label: 'Material temp', fieldKey: 'outward_material_temp_photo', paths: splitOutwardPhotoPaths(item.outward_material_temp_photo) },
      { label: 'Vehicle back', fieldKey: 'outward_vehicle_back_side_photo', paths: splitOutwardPhotoPaths(item.outward_vehicle_back_side_photo) },
      {
        label: 'Back with material',
        fieldKey: 'outward_vehicle_back_side_photo_with_material',
        paths: splitOutwardPhotoPaths(item.outward_vehicle_back_side_photo_with_material),
      },
      { label: 'Count sheet', fieldKey: 'outward_count_sheet_photo', paths: splitOutwardPhotoPaths(item.outward_count_sheet_photo) },
      { label: 'Seal', fieldKey: 'outward_vehicle_seal_photo', paths: splitOutwardPhotoPaths(item.outward_vehicle_seal_photo) },
      { label: 'Damage boxes', fieldKey: 'outward_damage_boxes_photo', paths: splitOutwardPhotoPaths(item.outward_damage_boxes_photo) },
    ].filter((g) => g.paths.length > 0);
    const podPaths = splitOutwardPhotoPaths(item.outward_pod_photo);

    const photoItems = photoGroups.flatMap((group) =>
      group.paths.map((path, idx) => ({
        key: `${group.fieldKey}-${idx}`,
        label: group.paths.length > 1 ? `${group.label} ${idx + 1}` : group.label,
        path,
        fieldKey: group.fieldKey,
        photoIndex: idx,
      }))
    );

    const renderDetailRow = (label, value) => {
      if (value == null || value === '') return null;
      return (
        <View style={styles.doLogDetailRow} key={label}>
          <Text style={styles.doLogDetailLabel}>{label}</Text>
          <Text style={styles.doLogDetailValue}>{String(value)}</Text>
        </View>
      );
    };

    return (
      <Modal
        visible={Boolean(selectedOutwardReport)}
        animationType="slide"
        onRequestClose={() => setSelectedOutwardReport(null)}
      >
        <SafeAreaView style={styles.doDetailSafe}>
          <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
          <View style={styles.doDetailHeader}>
            <TouchableOpacity
              style={styles.doDetailBackBtn}
              onPress={() => setSelectedOutwardReport(null)}
              activeOpacity={0.85}
            >
              <Ionicons name="arrow-back" size={22} color="#0f172a" />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={styles.doDetailTitle} numberOfLines={1}>
                Outward details
              </Text>
              <Text style={styles.doDetailSub} numberOfLines={2}>
                {item.reference_no || `OUT-${item.outward_id}`} · {item.outward_client_name || 'Client'}
                {'\n'}
                {recordWarehouse} · {operatorLabel}
              </Text>
            </View>
          </View>

          <ScrollView contentContainerStyle={styles.doDetailBody} showsVerticalScrollIndicator={false}>
            <View style={styles.doDetailHeroCard}>
              <Text style={styles.doDetailHeroTemp}>
                {item.outward_material_temp != null ? `${item.outward_material_temp}°C` : '—'}
              </Text>
              <Text style={styles.doDetailHeroMeta}>
                {recordWarehouse}
                {item.outward_entry_date ? ` · ${item.outward_entry_date}` : ''}
                {' · Material temp'}
                {preVehicleTemp != null ? ` · Pre veh ${preVehicleTemp}°C` : ''}
              </Text>
            </View>

            {sections.map((section) => (
              <View style={styles.doDetailCard} key={section.title}>
                <Text style={styles.doDetailSectionTitle}>{section.title}</Text>
                {section.rows.map(([label, value]) => renderDetailRow(label, value))}
              </View>
            ))}

            <View style={styles.doDetailCard}>
              <Text style={styles.doDetailSectionTitle}>POD Photo</Text>
              <Text style={styles.podUpdateHint}>
                Add or replace POD later — no need to re-fill the full outward form.
              </Text>
              {podPaths.length > 0 ? (
                <PhotoGridWithLocation
                  photoItems={podPaths.map((path, idx) => ({
                    key: `outward-pod-${idx}`,
                    label: podPaths.length > 1 ? `POD ${idx + 1}` : 'POD',
                    path,
                    fieldKey: 'outward_pod_photo',
                    photoIndex: idx,
                  }))}
                  folderHint="outward_images"
                  photoMeta={item.photo_capture_metadata}
                  resolveUri={(path, folderHint) =>
                    resolveDoImageUrl(path, apiUrl, folderHint) ||
                    resolveDoImageUrl(path, PRODUCTION_API_URL, folderHint)
                  }
                />
              ) : (
                <Text style={styles.podUpdateEmpty}>No POD photo yet</Text>
              )}
              <TouchableOpacity
                style={[styles.podUpdateBtn, podUploadBusy && styles.podUpdateBtnDisabled]}
                onPress={() => uploadOutwardPodPhoto(item.outward_id)}
                disabled={podUploadBusy}
                activeOpacity={0.85}
              >
                {podUploadBusy ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons name="camera-outline" size={18} color="#fff" />
                    <Text style={styles.podUpdateBtnText}>
                      {podPaths.length > 0 ? 'Replace POD Photo' : 'Add POD Photo'}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            {photoItems.length > 0 ? (
              <View style={styles.doDetailCard}>
                <Text style={styles.doDetailSectionTitle}>Photos</Text>
                <PhotoGridWithLocation
                  photoItems={photoItems}
                  folderHint="outward_images"
                  photoMeta={item.photo_capture_metadata}
                  resolveUri={(path, folderHint) =>
                    resolveDoImageUrl(path, apiUrl, folderHint) ||
                    resolveDoImageUrl(path, PRODUCTION_API_URL, folderHint)
                  }
                />
              </View>
            ) : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    );
  };

  const renderOutwardReportsView = () => (
    <View style={{ flex: 1, backgroundColor: '#f1f5f9' }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
        <Text style={{ fontSize: 15, fontWeight: '800', color: '#0f172a' }}>Outward Reports</Text>
        <Text style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>
          Saved outward entries · tap a card for full details
        </Text>
      </View>

      <View style={styles.dockReportFilterBar}>
        <View style={styles.dockReportSearchRow}>
          <Ionicons name="search-outline" size={14} color="#64748b" />
          <TextInput
            style={styles.dockReportSearchInput}
            placeholder="Search vehicle, client, ref…"
            placeholderTextColor="#94a3b8"
            value={outwardReportSearch}
            onChangeText={setOutwardReportSearch}
            onSubmitEditing={applyOutwardReportFilters}
            returnKeyType="search"
          />
        </View>
        <View style={[styles.reportListFilterRow, { marginTop: 0 }]}>
          <TouchableOpacity
            style={[styles.doFilterChip, !!outwardReportDateFrom && styles.doFilterChipActive]}
            onPress={() => openDockReportCalendar('outward', 'from')}
            activeOpacity={0.85}
          >
            <Text style={styles.doFilterChipLabel}>From</Text>
            <Text style={styles.doFilterChipValue} numberOfLines={1}>
              {outwardReportDateFrom
                ? outwardReportDateFrom === getLocalDateStr()
                  ? 'Today'
                  : outwardReportDateFrom
                : 'All'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.doFilterChip, !!outwardReportDateTo && styles.doFilterChipActive]}
            onPress={() => openDockReportCalendar('outward', 'to')}
            activeOpacity={0.85}
          >
            <Text style={styles.doFilterChipLabel}>To</Text>
            <Text style={styles.doFilterChipValue} numberOfLines={1}>
              {outwardReportDateTo
                ? outwardReportDateTo === getLocalDateStr()
                  ? 'Today'
                  : outwardReportDateTo
                : 'All'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.doFilterChip,
              outwardReportMissingPod && styles.doFilterChipActiveWarn,
            ]}
            onPress={toggleOutwardMissingPodFilter}
            activeOpacity={0.85}
          >
            <Text style={styles.doFilterChipLabel}>POD</Text>
            <Text
              style={[
                styles.doFilterChipValue,
                outwardReportMissingPod && { color: '#b91c1c' },
              ]}
              numberOfLines={1}
            >
              {outwardReportMissingPod ? 'Missing' : 'All'}
            </Text>
          </TouchableOpacity>
        </View>
        <View style={styles.dockReportFilterActions}>
          <TouchableOpacity
            style={[
              styles.dockLogQuickBtn,
              outwardDatePreset === 'today' && styles.dockLogQuickBtnActive,
            ]}
            onPress={() => applyOutwardDatePreset('today')}
            activeOpacity={0.85}
          >
            <Text
              style={[
                styles.dockLogQuickBtnText,
                outwardDatePreset === 'today' && styles.dockLogQuickBtnTextActive,
              ]}
            >
              Today
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.dockLogQuickBtn,
              outwardDatePreset === '7days' && styles.dockLogQuickBtnActive,
            ]}
            onPress={() => applyOutwardDatePreset('7days')}
            activeOpacity={0.85}
          >
            <Text
              style={[
                styles.dockLogQuickBtnText,
                outwardDatePreset === '7days' && styles.dockLogQuickBtnTextActive,
              ]}
            >
              7 days
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.dockLogQuickBtn, styles.dockLogQuickBtnClear]}
            onPress={clearOutwardReportFilters}
            activeOpacity={0.85}
          >
            <Text style={[styles.dockLogQuickBtnText, styles.dockLogQuickBtnClearText]}>
              Clear
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {isBlockingListLoad(outwardReportsLoading, outwardReportsRefreshing, outwardReportRows.length) ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color="#003580" />
          <Text style={{ marginTop: 8, color: '#64748b', fontSize: 12 }}>Loading reports…</Text>
        </View>
      ) : outwardReportsError && outwardReportRows.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Text style={{ color: '#b91c1c', textAlign: 'center', marginBottom: 12 }}>
            {outwardReportsError}
          </Text>
          <TouchableOpacity
            style={{
              backgroundColor: '#003580',
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 10,
            }}
            onPress={loadOutwardReports}
          >
            <Text style={{ color: '#fff', fontWeight: '700' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
        <FlatList
          style={{ flex: 1 }}
          data={outwardReportRows}
          keyExtractor={(item, idx) => String(item.outward_id || item.reference_no || idx)}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 100 }}
          refreshing={outwardReportsRefreshing}
          onRefresh={() => {
            setOutwardReportsRefreshing(true);
            loadOutwardReports();
          }}
          ListFooterComponent={
            outwardReportTotal > 0 ? (
              <View style={styles.dockReportPagination}>
                <TouchableOpacity
                  style={[
                    styles.dockReportPageBtn,
                    outwardReportPage <= 1 && styles.dockReportPageBtnDisabled,
                  ]}
                  disabled={outwardReportPage <= 1 || outwardReportsLoading}
                  onPress={goOutwardReportPrevPage}
                >
                  <Text style={styles.dockReportPageBtnText}>Previous</Text>
                </TouchableOpacity>
                <Text style={styles.dockReportPageMeta}>
                  {(outwardReportPage - 1) * DOCK_REPORT_PAGE_SIZE + 1}–
                  {Math.min(outwardReportPage * DOCK_REPORT_PAGE_SIZE, outwardReportTotal)} of{' '}
                  {outwardReportTotal}
                </Text>
                <TouchableOpacity
                  style={[
                    styles.dockReportPageBtn,
                    !outwardReportHasMore && styles.dockReportPageBtnDisabled,
                  ]}
                  disabled={!outwardReportHasMore || outwardReportsLoading}
                  onPress={goOutwardReportNextPage}
                >
                  <Text style={styles.dockReportPageBtnText}>Next</Text>
                </TouchableOpacity>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingTop: 48, paddingHorizontal: 24 }}>
              <Ionicons name="document-text-outline" size={40} color="#94a3b8" />
              <Text style={{ marginTop: 10, color: '#64748b', fontSize: 13, textAlign: 'center' }}>
                {outwardReportMissingPod
                  ? 'No outward records are missing a POD photo.'
                  : outwardReportSearch || outwardReportDateFrom || outwardReportDateTo
                    ? 'No outward records match your filters.'
                    : 'No saved outward records yet. Submit an Outward Task to see it here.'}
              </Text>
            </View>
          }
          {...FLATLIST_PERF_PROPS}
          renderItem={({ item }) => {
            const loaded = item.outward_received_boxes_qty ?? item.outward_received_qty;
            const preVehicleTemp = item.outward_pre_vehicle_temp ?? item.outward_vehicle_temp;
            const rightValue =
              item.outward_material_temp != null
                ? `${item.outward_material_temp}°C`
                : preVehicleTemp != null
                  ? `${preVehicleTemp}°C`
                  : loaded != null
                    ? String(loaded)
                    : '—';
            const vehicleOrDock = item.outward_vehicle_no
              ? `Vehicle ${item.outward_vehicle_no}`
              : item.outward_dock_no
                ? `Dock ${item.outward_dock_no}`
                : '—';
            const podVal = String(item.outward_pod_photo || '').trim();
            const podMissing = !podVal || podVal === 'null' || podVal === 'undefined';
            return (
              <TouchableOpacity
                style={styles.dockLogCard}
                activeOpacity={0.85}
                onPress={() => setSelectedOutwardReport(item)}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={styles.dockLogTitleRow}>
                    <Text style={[styles.dockLogTypeTag, styles.dockLogTypeTagOut]}>Outward</Text>
                    <Text style={styles.dockLogClient} numberOfLines={1}>
                      {item.outward_client_name || 'Client'}
                    </Text>
                    {podMissing ? (
                      <View style={styles.inwardPodMissingBadge}>
                        <Text style={styles.inwardPodMissingBadgeText}>POD</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.dockLogMeta} numberOfLines={2}>
                    {vehicleOrDock}
                    {item.warehouse_name ? ` · ${item.warehouse_name}` : ''}
                    {' · '}
                    {String(item.outward_entry_date || '').slice(0, 10) || '—'}
                    {item.outward_material_type ? ` · ${item.outward_material_type}` : ''}
                  </Text>
                </View>
                <Text style={styles.dockLogTemp}>{rightValue}</Text>
              </TouchableOpacity>
            );
          }}
        />
        <ListLoadingOverlay
          visible={isSoftListLoad(
            outwardReportsLoading,
            outwardReportsRefreshing,
            outwardReportRows.length
          )}
          label="Loading page…"
        />
        </View>
      )}
    </View>
  );

  const renderProfileView = () => {
    const profileRows = [
      { label: 'Role', value: 'Data Operator' },
      { label: 'Full Name', value: user?.full_name || displayName || '—' },
      { label: 'Email', value: user?.email || '—' },
      { label: 'Phone', value: user?.phone_no || '—' },
      { label: 'Warehouse', value: user?.warehouse_name || '—' },
      { label: 'Warehouse Code', value: user?.warehouse_code || '—' },
      { label: 'Chamber Limit', value: String(chamberLimit) },
      {
        label: 'Total Clients',
        value: String(
          profileClientsTotal != null ? profileClientsTotal : totalClientsCount
        )
      }
    ];

    return (
    <ScrollView
      contentContainerStyle={[styles.moreContainer, { paddingBottom: 100 }]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.profileCard}>
        <View style={styles.profileAvatar}>
          <Ionicons name="person" size={32} color="#003580" />
        </View>
        <View style={styles.profileMeta}>
          <Text style={styles.profileName}>{displayName}</Text>
          <Text style={styles.profileRole}>
            {user?.role === 'do_operator' ? 'Data Operator' : 'Operator'}
          </Text>
          <Text style={styles.profileEmail}>{user?.email || 'operator@reeferon.com'}</Text>
        </View>
      </View>

      <View style={styles.moreSectionCard}>
        <Text style={styles.moreSectionTitle}>Profile</Text>
        {profileRows.map((row, idx) => (
          <View
            key={row.label}
            style={[
              styles.doProfileRow,
              idx === profileRows.length - 1 && { borderBottomWidth: 0, marginBottom: 0, paddingBottom: 0 }
            ]}
          >
            <Text style={styles.doProfileLabel}>{row.label}</Text>
            <Text style={styles.doProfileValue} numberOfLines={2}>
              {row.value}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.moreSectionCard}>
        <Text style={styles.moreSectionTitle}>Master data policy</Text>
        <Text style={{ fontSize: 12, color: '#475569', lineHeight: 18, marginBottom: 8 }}>
          Chambers: Super Admin must approve add, delete, or edit.
        </Text>
        <Text style={{ fontSize: 12, color: '#475569', lineHeight: 18 }}>
          Clients: Changes save immediately and sync; Super Admin is notified only.
        </Text>
      </View>
    </ScrollView>
    );
  };

  // Hamburger Drawer Menu Modal
  const renderDrawerModal = () => {
    if (!showDrawer) return null;

    const isDailyTasksActive =
      navSection === 'daily' &&
      (currentNavTab === 'Tasks' ||
        currentNavTab === 'Reports' ||
        currentNavTab === 'More' ||
        currentNavTab === 'Profile');
    const isInwardsActive =
      navSection === 'inwards' ||
      currentNavTab === 'Inwards' ||
      currentNavTab === 'InwardReports';
    const isOutwardsActive =
      navSection === 'outwards' ||
      currentNavTab === 'Outwards' ||
      currentNavTab === 'OutwardReports';

    return (
      <Modal
        visible={showDrawer}
        animationType="none"
        transparent
        onRequestClose={closeDrawer}
      >
        <View style={styles.drawerOverlay}>
          {/* Drawer Content Panel (rendered first to slide out from Left side) */}
          <Animated.View style={[styles.drawerPanel, { transform: [{ translateX: drawerAnim }] }]}>
            {/* Drawer Header (Contains Operator Profile & Close Button) */}
            <View style={styles.drawerHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                <View style={styles.drawerUserAvatar}>
                  <Ionicons name="person" size={18} color="#003580" />
                </View>
                <View style={{ marginLeft: 10, flex: 1 }}>
                  <Text style={styles.drawerUserName} numberOfLines={1}>
                    {displayName}
                  </Text>
                  <Text style={styles.drawerUserRole}>
                    {user?.role === 'do_operator' ? 'Data Operator' : 'Operator'}
                  </Text>
                </View>
              </View>
              <TouchableOpacity onPress={closeDrawer} style={{ marginLeft: 10 }}>
                <Ionicons name="close-circle-outline" size={26} color="#64748b" />
              </TouchableOpacity>
            </View>

            {/* Menu Options List */}
            <ScrollView style={styles.drawerMenuScroll} showsVerticalScrollIndicator={false}>
              
              {/* Dashboard Menu Item */}
              <TouchableOpacity 
                style={[
                  styles.drawerMenuItem, 
                  currentNavTab === 'Dashboard' && styles.drawerMenuItemActive
                ]}
                onPress={() => {
                  handleNavTabChange('Dashboard');
                  closeDrawer();
                }}
              >
                <Ionicons 
                  name={currentNavTab === 'Dashboard' ? 'home' : 'home-outline'} 
                  size={20} 
                  color={currentNavTab === 'Dashboard' ? '#003580' : '#475569'} 
                  style={{ marginRight: 12 }}
                />
                <Text style={[
                  styles.drawerMenuText,
                  currentNavTab === 'Dashboard' && styles.drawerMenuTextActive
                ]}>
                  Dashboard
                </Text>
              </TouchableOpacity>

              {/* Daily Tasks Menu Item */}
              <TouchableOpacity 
                style={[
                  styles.drawerMenuItem, 
                  isDailyTasksActive && styles.drawerMenuItemActive
                ]}
                onPress={() => {
                  handleNavTabChange('Tasks', 'daily');
                  closeDrawer();
                }}
              >
                <Ionicons 
                  name={isDailyTasksActive ? 'clipboard' : 'clipboard-outline'} 
                  size={20} 
                  color={isDailyTasksActive ? '#003580' : '#475569'} 
                  style={{ marginRight: 12 }}
                />
                <Text style={[
                  styles.drawerMenuText,
                  isDailyTasksActive && styles.drawerMenuTextActive
                ]}>
                  Daily Tasks
                </Text>
              </TouchableOpacity>

              {/* Inwards Menu Item */}
              <TouchableOpacity 
                style={[
                  styles.drawerMenuItem, 
                  isInwardsActive && styles.drawerMenuItemActiveInward
                ]}
                onPress={() => {
                  handleNavTabChange('Inwards', 'inwards');
                  closeDrawer();
                }}
              >
                <Ionicons 
                  name={isInwardsActive ? 'download' : 'download-outline'} 
                  size={20} 
                  color={isInwardsActive ? '#0D9488' : '#475569'} 
                  style={{ marginRight: 12 }}
                />
                <Text style={[
                  styles.drawerMenuText,
                  isInwardsActive && styles.drawerMenuTextActiveInward
                ]}>
                  Inwards
                </Text>
              </TouchableOpacity>

              {/* Outwards Menu Item */}
              <TouchableOpacity 
                style={[
                  styles.drawerMenuItem, 
                  isOutwardsActive && styles.drawerMenuItemActiveOutward
                ]}
                onPress={() => {
                  handleNavTabChange('Outwards', 'outwards');
                  closeDrawer();
                }}
              >
                <View style={{ marginRight: 12, transform: [{ rotate: '180deg' }] }}>
                  <Ionicons 
                    name={isOutwardsActive ? 'download' : 'download-outline'} 
                    size={20} 
                    color={isOutwardsActive ? '#d97706' : '#475569'} 
                  />
                </View>
                <Text style={[
                  styles.drawerMenuText,
                  isOutwardsActive && styles.drawerMenuTextActiveOutward
                ]}>
                  Outwards
                </Text>
              </TouchableOpacity>

            </ScrollView>

            {/* Logout Option at Bottom of Drawer */}
            <View style={styles.drawerFooter}>
              <TouchableOpacity 
                style={styles.drawerLogoutBtn}
                onPress={() => {
                  closeDrawer();
                  handleLogout();
                }}
              >
                <Ionicons name="log-out-outline" size={20} color="#ef4444" style={{ marginRight: 12 }} />
                <Text style={styles.drawerLogoutText}>Logout</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>

          {/* Backdrop Touch Area to close (rendered second to fill right side) */}
          <TouchableOpacity 
            style={styles.drawerBackdrop} 
            activeOpacity={1}
            pressBorder={false} 
            onPress={closeDrawer} 
          />
        </View>
      </Modal>
    );
  };

  // 5. ADD CHAMBER MODAL (name + remark → SA allow)
  const renderAddChamberModal = () => {
    return (
      <Modal
        visible={showAddChamberModal}
        animationType="fade"
        transparent
        onRequestClose={() => {
          setShowAddChamberModal(false);
          setAddChamberNameInput('');
          setAddChamberRemarkInput('');
        }}
      >
        <View style={styles.dialogOverlay}>
          <View style={styles.dialogContent}>
            <Text style={styles.dialogTitle}>Request Add Chamber</Text>
            <Text style={styles.dialogSubtitle}>
              Fill chamber name and remark, then send request. Super Admin will allow it in Role & Permission.
            </Text>

            <Text style={[styles.modalLabel, { fontSize: 11, marginBottom: 4 }]}>Chamber Name *</Text>
            <TextInput
              style={styles.dialogInput}
              placeholder="e.g. Chamber 3 / Cold Store A"
              placeholderTextColor="#94a3b8"
              value={addChamberNameInput}
              onChangeText={setAddChamberNameInput}
              autoCapitalize="words"
            />

            <Text style={[styles.modalLabel, { fontSize: 11, marginBottom: 4 }]}>Remark / Reason *</Text>
            <TextInput
              style={styles.dialogInput}
              placeholder="Add remark: why this chamber is needed"
              placeholderTextColor="#94a3b8"
              value={addChamberRemarkInput}
              onChangeText={setAddChamberRemarkInput}
              autoCapitalize="sentences"
            />

            <View style={styles.dialogActionsRow}>
              <TouchableOpacity
                style={styles.dialogCancelBtn}
                disabled={addChamberBusy}
                onPress={() => {
                  setShowAddChamberModal(false);
                  setAddChamberNameInput('');
                  setAddChamberRemarkInput('');
                }}
              >
                <Text style={styles.dialogCancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.dialogSaveBtn, addChamberBusy && { opacity: 0.7 }]}
                disabled={addChamberBusy}
                onPress={submitAddChamberRequest}
              >
                <Text style={styles.dialogSaveBtnText}>
                  {addChamberBusy ? 'Sending…' : 'Send Request'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  // 5b. ADD CLIENT MODAL DIALOG (CENTERED POPUP)
  const renderAddClientModal = () => {
    return (
      <Modal
        visible={showAddClientModal}
        animationType="fade"
        transparent
        onRequestClose={() => {
          setInlineClientInput('');
          setInlineRemarkInput('');
          setShowAddClientModal(false);
        }}
      >
        <View style={styles.dialogOverlay}>
          <View style={styles.dialogContent}>
            <Text style={styles.dialogTitle}>Request New Client Lot</Text>
            <Text style={styles.dialogSubtitle}>
              Send add request for {selectedChamber?.name}. Super Admin must allow first — client will appear automatically after approval.
            </Text>
            
            <Text style={[styles.modalLabel, { fontSize: 11, marginBottom: 4 }]}>Client Name</Text>
            <TextInput
              style={styles.dialogInput}
              placeholder="e.g. Reliance Fresh"
              placeholderTextColor="#94a3b8"
              value={inlineClientInput}
              onChangeText={setInlineClientInput}
              autoCapitalize="words"
            />

            <Text style={[styles.modalLabel, { fontSize: 11, marginBottom: 4, marginTop: 10 }]}>Remark / Reason</Text>
            <TextInput
              style={styles.dialogInput}
              placeholder="Why this client should be added"
              placeholderTextColor="#94a3b8"
              value={inlineRemarkInput}
              onChangeText={setInlineRemarkInput}
              autoCapitalize="sentences"
            />

            <View style={styles.dialogActionsRow}>
              <TouchableOpacity 
                style={styles.dialogCancelBtn}
                onPress={() => {
                  setInlineClientInput('');
                  setInlineRemarkInput('');
                  setShowAddClientModal(false);
                }}
              >
                <Text style={styles.dialogCancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={styles.dialogSaveBtn}
                onPress={async () => {
                  if (!selectedChamber?.id) {
                    Alert.alert('Validation Error', 'Please select a chamber first.');
                    return;
                  }
                  if (!inlineClientInput.trim()) {
                    Alert.alert('Validation Error', 'Please enter a client name.');
                    return;
                  }
                  if (!inlineRemarkInput.trim()) {
                    Alert.alert('Validation Error', 'Please enter a remark / reason.');
                    return;
                  }
                  if (!apiUrl || !token) {
                    Alert.alert('Offline', 'Connect to server to request client add.');
                    return;
                  }
                  const name = ensureClientInLotMaster(inlineClientInput);
                  const exists = assignments.some(
                    (item) =>
                      Number(item.chamber_id) === Number(selectedChamber.id) &&
                      item.client_name.toLowerCase() === name.toLowerCase()
                  );
                  if (exists) {
                    Alert.alert('Duplicate Client', `"${name}" is already on ${selectedChamber.name}.`);
                    return;
                  }

                  const chamberType =
                    getChamberTypeAndDefault(selectedChamber.id, null).type || 'Frozen';
                  const ok = await requestClientMasterPermission({
                    chamber: selectedChamber,
                    action: 'add',
                    clientName: name,
                    chamberType,
                    remark: inlineRemarkInput.trim()
                  });
                  if (ok) {
                    ensureClientInLotMaster(name);
                    setInlineClientInput('');
                    setInlineRemarkInput('');
                    setShowAddClientModal(false);
                  }
                }}
              >
                <Text style={styles.dialogSaveBtnText}>Send Request</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  // 3. BOTTOM NAVIGATION TAB BAR
  const renderBottomTabBar = () => {
    const inwardTabActive = currentNavTab === 'Inwards';
    const outwardTabActive = currentNavTab === 'Outwards';
    const tasksActive = currentNavTab === 'Tasks';
    const dashboardActive = currentNavTab === 'Dashboard';
    const moreActive = isMoreMenuTab(currentNavTab);
    const activeColor = '#003580';
    const idleColor = '#64748b';

    const onTabBarLayout = (e) => {
      const w = e.nativeEvent.layout.width;
      if (!w || Math.abs(w - tabBarWidthRef.current) < 1) return;
      tabBarWidthRef.current = w;
      const tabW = w / BOTTOM_TAB_COUNT;
      setTabIndicatorWidth(Math.max(28, tabW * 0.5));
      slideTabIndicator(getBottomTabIndex(currentNavTab), w, false);
    };

    return (
      <View style={styles.tabBarContainer} onLayout={onTabBarLayout}>
        {tabIndicatorWidth > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.tabBarActiveLine,
              {
                width: tabIndicatorWidth,
                transform: [{ translateX: tabIndicatorX }],
              },
            ]}
          />
        ) : null}
        <TouchableOpacity
          style={styles.tabBarItem}
          onPress={() => handleNavTabChange('Dashboard')}
        >
          <Ionicons
            name={dashboardActive ? 'home' : 'home-outline'}
            size={20}
            color={dashboardActive ? activeColor : idleColor}
          />
          <Text
            style={[styles.tabBarLabel, dashboardActive && styles.tabBarLabelActive]}
            numberOfLines={1}
          >
            Dashboard
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.tabBarItem}
          onPress={() => handleNavTabChange('Tasks', 'daily')}
        >
          <Ionicons
            name={tasksActive ? 'clipboard' : 'clipboard-outline'}
            size={20}
            color={tasksActive ? activeColor : idleColor}
          />
          <Text
            style={[styles.tabBarLabel, tasksActive && styles.tabBarLabelActive]}
            numberOfLines={1}
          >
            Tasks
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.tabBarItem}
          onPress={() => handleNavTabChange('Inwards', 'inwards')}
        >
          <Ionicons
            name={inwardTabActive ? 'download' : 'download-outline'}
            size={20}
            color={inwardTabActive ? activeColor : idleColor}
          />
          <Text
            style={[styles.tabBarLabel, inwardTabActive && styles.tabBarLabelActive]}
            numberOfLines={1}
          >
            Inward
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.tabBarItem}
          onPress={() => handleNavTabChange('Outwards', 'outwards')}
        >
          <View style={{ transform: [{ rotate: '180deg' }] }}>
            <Ionicons
              name={outwardTabActive ? 'download' : 'download-outline'}
              size={20}
              color={outwardTabActive ? activeColor : idleColor}
            />
          </View>
          <Text
            style={[styles.tabBarLabel, outwardTabActive && styles.tabBarLabelActive]}
            numberOfLines={1}
          >
            Outward
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.tabBarItem}
          onPress={() => handleNavTabChange('More')}
        >
          <Ionicons
            name={moreActive ? 'ellipsis-horizontal' : 'ellipsis-horizontal-outline'}
            size={20}
            color={moreActive ? activeColor : idleColor}
          />
          <Text
            style={[styles.tabBarLabel, moreActive && styles.tabBarLabelActive]}
            numberOfLines={1}
          >
            More
          </Text>
        </TouchableOpacity>
      </View>
    );
  };

  // Main UI Shell
  if (isLoadingData) {
    return <SplashScreen playIntro={false} />;
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#003580" />
      
      {/* Header bar */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity onPress={() => setShowDrawer(true)}>
            <Ionicons name="menu-outline" size={26} color="#ffffff" style={{ marginRight: 10 }} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>
            {currentNavTab === 'Dashboard'
              ? 'Dashboard'
              : currentNavTab === 'Tasks'
              ? 'Daily Tasks'
              : currentNavTab === 'Reports'
              ? 'Reports'
              : currentNavTab === 'Inwards'
                ? 'Inward Task'
                : currentNavTab === 'InwardReports'
                  ? 'Inward Reports'
                  : currentNavTab === 'Outwards'
                    ? 'Outward Task'
                    : currentNavTab === 'OutwardReports'
                      ? 'Outward Reports'
                    : currentNavTab === 'Profile'
                    ? 'Profile'
                    : currentNavTab}
          </Text>
        </View>
        <View style={styles.headerRight}>
          {syncStatus === 'syncing' ? (
            <ActivityIndicator size="small" color="#ffffff" style={{ marginRight: 12 }} />
          ) : (
            <TouchableOpacity onPress={() => triggerSync(apiUrl, token, handleSyncProgress, user)}>
              <Ionicons
                name="sync-outline"
                size={22}
                color={syncStatus === 'failed' ? '#fecaca' : syncStatus === 'partial' ? '#fed7aa' : '#ffffff'}
                style={{ marginRight: 12 }}
              />
            </TouchableOpacity>
          )}
          {(() => {
            const { pendingMorning, pendingEvening, isEveningUnlocked } = getActiveTasksDetails();
            const hasMorningPending = pendingMorning.length > 0;
            const hasEveningPending = isEveningUnlocked && pendingEvening.length > 0;
            const permissionAlertCount = getActivePermissionAlerts().length;
            const totalPendingCount =
              (hasMorningPending ? pendingMorning.length : 0) +
              (hasEveningPending ? pendingEvening.length : 0) +
              permissionAlertCount;

            return (
              <TouchableOpacity onPress={() => setShowNotificationsModal(true)} style={{ position: 'relative' }}>
                <Ionicons name="notifications-outline" size={24} color="#ffffff" />
                 {totalPendingCount > 0 && (
                  <View style={{
                    position: 'absolute',
                    top: 1,
                    right: 2,
                    backgroundColor: '#ef4444',
                    borderRadius: 4,
                    width: 8,
                    height: 8,
                    borderWidth: 1.2,
                    borderColor: '#003580'
                  }} />
                )}
              </TouchableOpacity>
            );
          })()}
        </View>
      </View>

      {/* Conditional View Rendering — switch with menu; lazy-load heavy content/data */}
      <LazyNavTabPanel
        isActive={currentNavTab === 'Dashboard'}
        isMounted={!!mountedNavTabs.Dashboard}
        paintReady={!!tabPaintReady.Dashboard}
        render={renderDashboardView}
      />
      <LazyNavTabPanel
        isActive={currentNavTab === 'Inwards'}
        isMounted={!!mountedNavTabs.Inwards}
        paintReady={!!tabPaintReady.Inwards}
        render={renderInwardsView}
      />
      <LazyNavTabPanel
        isActive={currentNavTab === 'Outwards'}
        isMounted={!!mountedNavTabs.Outwards}
        paintReady={!!tabPaintReady.Outwards}
        render={renderOutwardsView}
      />
      <LazyNavTabPanel
        isActive={currentNavTab === 'InwardReports'}
        isMounted={!!mountedNavTabs.InwardReports}
        paintReady={!!tabPaintReady.InwardReports}
        dataLoading={isBlockingListLoad(inwardReportsLoading, inwardReportsRefreshing, inwardReportRows.length)}
        loadingLabel="Loading reports…"
        render={renderInwardReportsView}
      />
      <LazyNavTabPanel
        isActive={currentNavTab === 'OutwardReports'}
        isMounted={!!mountedNavTabs.OutwardReports}
        paintReady={!!tabPaintReady.OutwardReports}
        dataLoading={isBlockingListLoad(outwardReportsLoading, outwardReportsRefreshing, outwardReportRows.length)}
        loadingLabel="Loading reports…"
        render={renderOutwardReportsView}
      />
      <LazyNavTabPanel
        isActive={currentNavTab === 'Profile'}
        isMounted={!!mountedNavTabs.Profile}
        paintReady={!!tabPaintReady.Profile}
        render={renderProfileView}
      />
      <LazyNavTabPanel
        isActive={currentNavTab === 'Tasks'}
        isMounted={!!mountedNavTabs.Tasks}
        paintReady={!!tabPaintReady.Tasks}
        render={renderTasksView}
      />
      <LazyNavTabPanel
        isActive={currentNavTab === 'Reports'}
        isMounted={!!mountedNavTabs.Reports}
        paintReady={!!tabPaintReady.Reports}
        dataLoading={isBlockingListLoad(reportsLoading, reportsRefreshing, inventoryReportRows.length)}
        loadingLabel="Loading reports…"
        render={renderDailyReportsView}
      />
      <LazyNavTabPanel
        isActive={currentNavTab === 'More'}
        isMounted={!!mountedNavTabs.More}
        paintReady={!!tabPaintReady.More}
        render={renderMoreView}
      />

      {/* Global Modals */}
      {renderTaskProfileModal()}
      {renderClientManagerModal()}
      {renderDeleteConfirmModal()}
      {renderAddChamberModal()}
      {renderAddClientModal()}
      {renderSubmitConfirmModal()}
      {renderPermissionModal()}
      {renderDrawerModal()}
      {renderInventoryModal()}
      {renderHistoryModal()}
      {renderNotificationsModal()}
      {renderCalendarModal()}
      {renderDockReportCalendarModal()}
      {renderReportLogDetailModal()}
      {renderInwardDetailModal()}
      {renderOutwardDetailModal()}
      <ImagePreviewModal
        visible={!!imagePreview}
        uri={imagePreview?.uri}
        label={imagePreview?.label}
        onClose={() => setImagePreview(null)}
      />

      {/* Navigation Tab Bar Overlay */}
      {renderBottomTabBar()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f1f5f9', 
  },
  header: {
    backgroundColor: '#003580', 
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 24) + 4 : 4,
    paddingBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  scrollContainer: {
    paddingHorizontal: 14,
    paddingTop: 14,
  },

  // Welcome Greetings Card
  welcomeCard: {
    backgroundColor: '#0a1128', 
    borderRadius: 12,
    padding: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  welcomeInfo: {
    flex: 1,
    marginRight: 6,
  },
  welcomeText: {
    fontSize: 14.5,
    fontWeight: 'bold',
    color: '#ffffff',
    letterSpacing: 0.2,
  },
  roleText: {
    fontSize: 11,
    color: '#94a3b8', 
    marginTop: 1,
    fontWeight: '500',
  },
  warehouseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  warehouseText: {
    fontSize: 10.5,
    color: '#93c5fd', 
    fontWeight: 'bold',
    marginLeft: 5,
  },
  dateContainer: {
    backgroundColor: '#ffffff', 
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
    width: 105,
    minHeight: 65,
    justifyContent: 'center',
  },
  dateText: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  dateSub: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 2,
  },
  dayText: {
    fontSize: 8.5,
    color: '#64748b',
    fontWeight: '500',
  },
  timeText: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#003580', 
  },

  // Server Connection IP Address Card
  ipConfigCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    marginBottom: 14,
  },
  ipHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  ipLabel: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#003580',
  },
  editIpBtn: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  editIpBtnText: {
    fontSize: 12,
    color: '#003580',
    fontWeight: 'bold',
  },
  ipAddressBox: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 0.5,
    borderColor: '#e2e8f0',
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  ipAddressText: {
    fontSize: 13,
    color: '#475569',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },

  // Offline alert banner
  offlineAlertCard: {
    backgroundColor: '#fff7ed',
    borderWidth: 1,
    borderColor: '#ffedd5',
    borderRadius: 12,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  offlineAlertTextContainer: {
    flex: 1,
    marginLeft: 8,
  },
  offlineAlertTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#ea580c',
  },
  offlineAlertSubtitle: {
    fontSize: 10,
    color: '#c2410c',
  },
  syncBtn: {
    backgroundColor: '#ea580c',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  syncBtnText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: 'bold',
  },

  // Metrics horizontal scrolling container
  metricsContainer: {
    marginBottom: 14,
  },
  metricsHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 6,
    paddingHorizontal: 2,
  },
  metricsTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#003580',
  },
  viewAllText: {
    fontSize: 12,
    color: '#0284c7',
    fontWeight: 'bold',
  },
  metricsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  metricCard: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 2,
    marginHorizontal: 3,
    alignItems: 'center',
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
  },
  metricCardActive: {
    borderColor: '#0284c7',
    borderWidth: 2,
  },
  metricIconCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  metricValue: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 2,
  },
  metricLabel: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#334155',
    textAlign: 'center',
  },
  metricSubtitle: {
    fontSize: 7,
    color: '#64748b',
    textAlign: 'center',
    marginTop: 1,
  },

  // 2-column chambers grid layout
  chambersGrid: {
    flexDirection: 'column',
    paddingVertical: 8,
    width: '100%',
  },
  chamberCard: {
    width: '100%',
    backgroundColor: '#ffffff',
    borderRadius: 14,
    borderWidth: 1.2,
    borderColor: '#e2e8f0', 
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
  },
  chamberCardAlertBorder: {
    borderColor: '#ef4444', 
    borderWidth: 1.5,
  },
  chamberCardNeedsClients: {
    borderColor: '#7dd3fc',
    backgroundColor: '#f0f9ff',
  },
  setupClientsBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#e0f2fe',
    borderWidth: 1,
    borderColor: '#7dd3fc',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  setupClientsBannerIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  setupClientsBannerTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0c4a6e',
  },
  setupClientsBannerSub: {
    fontSize: 11,
    fontWeight: '600',
    color: '#0369a1',
    marginTop: 2,
    lineHeight: 15,
  },
  setupClientsBannerCta: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0284c7',
  },
  addClientChip: {
    backgroundColor: '#0284c7',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  addClientChipText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#ffffff',
  },
  chamberCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
    width: '100%',
  },
  chamberCardName: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#64748b',
  },
  chamberCardClients: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#0f172a',
    marginVertical: 4,
    textAlign: 'center',
    height: 32,
    lineHeight: 16,
    width: '100%',
    paddingHorizontal: 4,
  },
  typePill: {
    paddingHorizontal: 12,
    paddingVertical: 2.5,
    borderRadius: 12,
    marginVertical: 6,
  },
  typePillText: {
    fontSize: 9,
    fontWeight: 'bold',
  },
  statusIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 5,
  },
  statusText: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  emptyGridPlaceholder: {
    width: '100%',
    padding: 24,
    backgroundColor: '#ffffff',
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  emptyGridText: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 6,
    textAlign: 'center',
    fontWeight: '500',
  },

  // Drill down chamber header
  chamberHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#ffffff',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 12,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  backBtnText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#003580',
    marginLeft: 4,
  },
  selectedChamberTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  actionContainer: {
    marginVertical: 10,
  },
  recordLogBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#003580',
    paddingVertical: 12,
    borderRadius: 10
  },
  recordLogBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: 'bold',
  },
  tasksSection: {
    marginTop: 10,
  },
  tasksSectionTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#475569',
    marginBottom: 10,
  },

  reportListHeader: {
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  reportListHeaderTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
  },
  reportListHeaderSub: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b',
    marginTop: 1,
  },
  reportListRow: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 6,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
  },
  reportShiftSectionTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: '#003580',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 6,
    marginTop: 2,
  },
  reportListAccent: {
    width: 3,
    alignSelf: 'stretch',
    backgroundColor: '#003580',
  },
  reportListMain: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 8,
    paddingHorizontal: 10,
    justifyContent: 'center',
  },
  reportListTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
  },
  reportListMeta: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b',
    marginTop: 1,
  },
  reportViewBtn: {
    backgroundColor: '#003580',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    marginRight: 8,
    minWidth: 52,
    alignItems: 'center',
  },
  reportViewBtnText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#ffffff',
  },
  reportListFilterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  reportListClearBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#fee2e2',
    borderWidth: 1,
    borderColor: '#fecaca',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reportListSearchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
    minHeight: 34,
    marginTop: 6,
  },
  reportListSearchInput: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: '#0f172a',
    paddingVertical: 4,
  },

  // Generic Task list items
  taskItemCard: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 10,
    flexDirection: 'row',
    overflow: 'hidden',
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  taskItemCardCompleted: {
    backgroundColor: '#fcfcfd',
  },
  taskItemCardOverdue: {
    backgroundColor: '#fafafa',
  },
  taskCardAccent: {
    width: 3,
  },
  taskCardAccentPending: {
    backgroundColor: '#94a3b8',
  },
  taskCardAccentDone: {
    backgroundColor: '#003580',
  },
  taskCardAccentOverdue: {
    backgroundColor: '#64748b',
  },
  taskCardBody: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  taskCardMain: {
    flex: 1,
    marginRight: 10,
    minWidth: 0,
  },
  taskCardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  taskStatusLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginBottom: 6,
    textAlign: 'center',
  },
  taskStatusPending: {
    color: '#ea580c',
  },
  taskStatusDone: {
    color: '#16a34a',
  },
  taskStatusOverdue: {
    color: '#b91c1c',
  },
  taskMetaLine: {
    fontSize: 11,
    fontWeight: '500',
    color: '#64748b',
    lineHeight: 16,
    marginTop: 4,
  },
  taskReadingRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginTop: 6,
  },
  taskCardActions: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tasksInfoBanner: {
    backgroundColor: '#f8fafc',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginHorizontal: 15,
    marginTop: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  tasksInfoTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#334155',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  tasksInfoText: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 4,
    lineHeight: 15,
  },
  taskItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  statusIndicator: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  taskDetails: {
    flex: 1,
  },
  taskClientName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
  },
  taskClientMeta: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  taskChamberBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#f1f5f9',
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    marginTop: 4,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  taskChamberText: {
    fontSize: 9,
    fontWeight: '600',
    color: '#475569',
  },
  taskMetaChip: {
    backgroundColor: '#f8fafc',
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  taskMetaChipText: {
    fontSize: 9,
    fontWeight: '600',
    color: '#475569',
    letterSpacing: 0.2,
  },
  taskOverdueText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#b91c1c',
    marginTop: 4,
  },
  taskOverdueDateText: {
    fontSize: 10,
    fontWeight: '500',
    color: '#94a3b8',
    marginTop: 4,
  },
  taskItemRight: {
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  readingLoggedWrapper: {
    alignItems: 'flex-end',
  },
  readingLoggedText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    marginRight: 6,
  },
  taskLoggedTime: {
    fontSize: 10,
    color: '#94a3b8',
    fontWeight: '500',
  },
  logActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#003580',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    minWidth: 98,
    minHeight: 30,
  },
  logActionBtnText: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#ffffff',
  },
  pendingActionWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  pendingActionText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#003580',
    marginRight: 2,
  },

  // Global Dialog Modals & Overlays
  dialogOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialogContent: {
    width: '85%',
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    elevation: 10,
  },
  dialogTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#0f172a',
    marginBottom: 4,
  },
  dialogSubtitle: {
    fontSize: 12,
    color: '#64748b',
    marginBottom: 12,
  },
  dialogInput: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#0f172a',
    marginBottom: 16,
    backgroundColor: '#f8fafc',
  },
  dialogActionsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  dialogCancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginRight: 8,
  },
  dialogCancelBtnText: {
    fontSize: 13,
    color: '#64748b',
    fontWeight: 'bold',
  },
  dialogSaveBtn: {
    backgroundColor: '#003580',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  dialogSaveBtnText: {
    fontSize: 13,
    color: '#ffffff',
    fontWeight: 'bold',
  },

  // Master Setup (Manage Chambers / Clients)
  mmRoot: {
    flex: 1,
    backgroundColor: '#f1f5f9',
  },
  mmHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  mmHeaderTextWrap: {
    flex: 1,
    paddingRight: 8,
  },
  mmHeaderTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
  },
  mmHeaderSub: {
    marginTop: 2,
    fontSize: 12,
    color: '#64748b',
    fontWeight: '500',
  },
  mmCloseBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mmTabs: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    padding: 4,
    backgroundColor: '#e2e8f0',
    borderRadius: 12,
  },
  mmTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
  },
  mmTabActive: {
    backgroundColor: '#ffffff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2,
    elevation: 1,
  },
  mmTabText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#64748b',
  },
  mmTabTextActive: {
    color: '#003580',
  },
  mmBody: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  mmCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 12,
  },
  mmCardTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 4,
  },
  mmCardHint: {
    fontSize: 11,
    color: '#64748b',
    marginBottom: 10,
    lineHeight: 15,
  },
  mmAddRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  mmTextInput: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 14,
    color: '#0f172a',
    backgroundColor: '#f8fafc',
  },
  mmPrimaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#003580',
    height: 44,
    paddingHorizontal: 14,
    borderRadius: 10
  },
  mmPrimaryBtnDisabled: {
    backgroundColor: '#94a3b8',
  },
  mmPrimaryBtnText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 13,
  },
  mmSectionLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 8,
    marginTop: 2,
  },
  mmChamberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  mmChamberRowSelected: {
    borderColor: '#93c5fd',
    backgroundColor: '#f8fbff',
  },
  mmChamberIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  mmChamberIconSelected: {
    backgroundColor: '#dbeafe',
  },
  mmChamberName: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0f172a',
  },
  mmChamberMeta: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
    fontWeight: '500',
  },
  mmIconBtnDanger: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  mmIconBtnNeutral: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  mmIconBtnSuccess: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#dcfce7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mmChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 8,
  },
  mmChip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 20,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  mmChipActive: {
    backgroundColor: '#003580',
    borderColor: '#003580',
  },
  mmChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
  },
  mmChipTextActive: {
    color: '#ffffff',
  },
  mmChipGhost: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 20,
    backgroundColor: '#fff7ed',
    borderWidth: 1,
    borderColor: '#fed7aa',
  },
  mmChipGhostText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#c2410c',
  },
  mmClientRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  mmClientAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#e0f2fe',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  mmClientAvatarText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0369a1',
  },
  mmClientName: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    marginRight: 8,
  },
  mmSuggestToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  mmSuggestToggleText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#003580',
  },
  mmSuggestWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  mmSuggestChip: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    maxWidth: '100%',
  },
  mmSuggestChipUsed: {
    backgroundColor: '#f1f5f9',
    borderColor: '#e2e8f0',
  },
  mmSuggestChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#1d4ed8',
  },
  mmSuggestChipTextUsed: {
    color: '#94a3b8',
  },
  mmEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  mmEmptyCompact: {
    paddingVertical: 20,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#cbd5e1',
    backgroundColor: '#ffffff',
  },
  mmEmptyTitle: {
    marginTop: 10,
    fontSize: 15,
    fontWeight: '800',
    color: '#334155',
  },
  mmEmptyText: {
    marginTop: 6,
    fontSize: 12,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 17,
  },

  // Task Log Modal with unified columns
  modalOverlay: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  modalContent: {
    flex: 1,
    backgroundColor: '#ffffff',
    padding: 16,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    paddingBottom: 12,
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  modalSubtitle: {
    fontSize: 12,
    color: '#475569',
    marginTop: 2,
  },
  chamberHeaderCard: {
    borderRadius: 12,
    borderWidth: 1.2,
    padding: 8,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  chamberHeaderIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chamberHeaderTitle: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  modalLabel: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#003580',
    marginBottom: 3,
    marginTop: 4,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 36,
    marginBottom: 6,
    backgroundColor: '#f8fafc',
  },
  inputIcon: {
    marginRight: 8,
  },
  input: {
    flex: 1,
    fontSize: 14,
    color: '#0f172a',
    paddingVertical: 0,
  },
  submitBtn: {
    backgroundColor: '#003580',
    borderRadius: 8,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8
  },
  submitBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: 'bold',
  },

  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 6,
    width: '100%',
    height: 36,
  },
  dropdownDisabled: {
    backgroundColor: '#f1f5f9',
    borderColor: '#e2e8f0',
  },
  dropdownTriggerText: {
    fontSize: 14,
    color: '#0f172a',
    fontWeight: '500',
  },
  dropdownList: {
    position: 'absolute',
    top: 42,
    left: 0,
    right: 0,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    padding: 4,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    width: '100%',
    zIndex: 9999,
  },
  // Inline (non-absolute) — works inside ScrollView on Android
  dropdownListInline: {
    marginTop: 6,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingVertical: 2,
    maxHeight: 200,
    overflow: 'hidden',
  },
  reportFilterDropdownInline: {
    marginTop: 6,
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    maxHeight: 180,
    overflow: 'hidden',
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderColor: '#e2e8f0',
  },
  dropdownItemDisabled: {
    backgroundColor: '#f1f5f9',
    opacity: 0.6,
  },
  dropdownItemText: {
    fontSize: 13,
    color: '#334155',
    fontWeight: '500',
    flex: 1,
  },
  dropdownItemTextDisabled: {
    color: '#94a3b8',
    textDecorationLine: 'line-through',
  },

  // Row columns layout
  formRowContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
  },
  columnLeft: {
    flex: 1.1,
    marginRight: 10,
  },
  columnRight: {
    flex: 0.9,
    marginLeft: 10,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  readOnlyField: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginBottom: 6,
    minHeight: 36,
    justifyContent: 'center',
  },
  readOnlyText: {
    fontSize: 13,
    color: '#334155',
    fontWeight: '600',
  },

  // Image Right Styles
  imageRightContainer: {
    position: 'relative',
    width: '100%',
    aspectRatio: 1,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f1f5f9',
    marginTop: 4,
  },
  imageRightPreview: {
    width: '100%',
    height: '100%',
  },
  imageRightRetakeBtn: {
    position: 'absolute',
    bottom: 8,
    left: '8%',
    right: '8%',
    flexDirection: 'row',
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    paddingVertical: 5,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageRightRetakeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: 'bold',
    marginLeft: 4,
  },
  imageRightCameraBtn: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 10,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#003580',
    backgroundColor: '#f0f7ff',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  imageRightCameraText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#003580',
    marginTop: 6,
  },
  imageRightCameraSubtext: {
    fontSize: 8,
    color: '#64748b',
    marginTop: 2,
  },
  imageRightNoImage: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 10,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  imageRightNoImageText: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 6,
  },

  // Completed Log Meta Card
  metaDataCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    marginTop: 10,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 0.5,
    borderColor: '#cbd5e1',
  },
  metaLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
  },
  metaVal: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
  },

  // Unified status banner inside Modal
  detailStatusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 8,
  },
  detailStatusText: {
    fontSize: 12,
    fontWeight: 'bold',
  },

  // Bottom Navigation Tab Bar Styles
  tabBarContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#ffffff',
    height: 64,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 0,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.08,
    shadowRadius: 5,
  },
  tabBarActiveLine: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: 3,
    backgroundColor: '#003580',
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
    zIndex: 2,
  },
  tabBarItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    minWidth: 0,
  },
  tabBarLabel: {
    fontSize: 10,
    color: '#64748b',
    fontWeight: '600',
    marginTop: 3,
    textAlign: 'center',
  },
  tabBarLabelActive: {
    color: '#003580', 
    fontWeight: 'bold',
  },
  tabBarLabelActiveInward: {
    color: '#0D9488',
    fontWeight: 'bold',
  },
  tabBarLabelActiveOutward: {
    color: '#d97706',
    fontWeight: 'bold',
  },
  tabBarLabelCompact: {
    fontSize: 9,
  },
  dockReportFilterBar: {
    paddingHorizontal: 12,
    paddingBottom: 6,
    gap: 5,
  },
  dockReportSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: Platform.OS === 'ios' ? 5 : 2,
    minHeight: 32,
    gap: 6,
  },
  dockReportSearchInput: {
    flex: 1,
    fontSize: 12,
    color: '#0f172a',
    paddingVertical: 0,
  },
  dockReportDateRow: {
    flexDirection: 'row',
    gap: 8,
  },
  dockReportDateInput: {
    flex: 1,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    fontSize: 13,
    color: '#0f172a',
  },
  dockReportDateBtn: {
    justifyContent: 'center',
    minHeight: 40,
  },
  dockReportDateBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0f172a',
  },
  dockReportDateBtnPlaceholder: {
    color: '#94a3b8',
    fontWeight: '500',
  },
  dockReportCalendarBtn: {
    width: 40,
    minHeight: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#bfdbfe',
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dockReportFilterActions: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: 5,
  },
  dockReportFilterBtnPrimary: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    backgroundColor: '#003580',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dockReportFilterBtnPrimaryText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 11,
  },
  dockReportFilterBtnOutline: {
    flexGrow: 0.55,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#003580',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 6,
    alignItems: 'center',
  },
  dockReportFilterBtnOutlineText: {
    color: '#003580',
    fontWeight: '700',
    fontSize: 11,
  },
  dockLogQuickBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 5,
    borderRadius: 7,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  dockLogQuickBtnActive: {
    backgroundColor: '#003580',
    borderColor: '#003580',
  },
  dockLogQuickBtnText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#475569',
  },
  dockLogQuickBtnTextActive: {
    color: '#fff',
  },
  dockLogQuickBtnClear: {
    backgroundColor: '#fff',
    borderColor: '#cbd5e1',
  },
  dockLogQuickBtnClearText: {
    color: '#475569',
  },
  dockLogCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 8,
    marginBottom: 5,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 8,
  },
  dockLogTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 1,
  },
  dockLogTypeTag: {
    fontSize: 8,
    fontWeight: '800',
    color: '#0284c7',
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    overflow: 'hidden',
  },
  dockLogTypeTagOut: {
    color: '#b45309',
    backgroundColor: '#ffedd5',
  },
  dockLogClient: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0f172a',
    flex: 1,
  },
  dockLogMeta: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 1,
  },
  dockLogTemp: {
    fontSize: 13,
    fontWeight: '800',
    color: '#003580',
  },
  dockReportPagination: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 4,
    marginTop: 4,
  },
  dockReportPageBtn: {
    backgroundColor: '#003580',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  dockReportPageBtnDisabled: {
    backgroundColor: '#94a3b8',
  },
  dockReportPageBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 12,
  },
  dockReportPageMeta: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: '600',
  },
  podUpdateHint: {
    fontSize: 12,
    color: '#64748b',
    marginBottom: 10,
    lineHeight: 18,
  },
  podUpdateEmpty: {
    fontSize: 12,
    color: '#94a3b8',
    marginBottom: 10,
  },
  podUpdateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#003580',
    borderRadius: 10,
    paddingVertical: 12,
    marginTop: 4,
  },
  podUpdateBtnDisabled: {
    opacity: 0.7,
  },
  podUpdateBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  inwardReportCard: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  inwardReportCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  inwardReportRef: {
    fontSize: 12,
    fontWeight: '800',
    color: '#003580',
    flexShrink: 1,
  },
  inwardPodMissingBadge: {
    marginLeft: 8,
    marginTop: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  inwardPodMissingBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#b91c1c',
    letterSpacing: 0.2,
  },
  inwardReportDateInline: {
    fontSize: 11,
    fontWeight: '600',
    color: '#94a3b8',
  },
  inwardReportClient: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    marginTop: 2,
  },
  inwardReportScopeText: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 4,
    fontWeight: '600',
  },
  inwardReportDateWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  inwardReportDate: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b',
  },
  inwardReportMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  inwardReportMetaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 4,
    maxWidth: '48%',
  },
  inwardReportMetaText: {
    fontSize: 11,
    color: '#475569',
    fontWeight: '600',
    flexShrink: 1,
  },
  inwardReportStatsRow: {
    flexDirection: 'row',
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  inwardReportStat: {
    flex: 1,
    alignItems: 'center',
  },
  inwardReportStatLabel: {
    fontSize: 9,
    color: '#94a3b8',
    fontWeight: '600',
    marginBottom: 1,
  },
  inwardReportStatValue: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
  },
  inwardReportTapHint: {
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: '600',
    textAlign: 'right',
  },
  inwardDetailPhotoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  inwardDetailPhotoCell: {
    width: '48%',
    marginBottom: 14,
  },
  inwardDetailPhotoLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
    marginBottom: 6,
    minHeight: 28,
  },
  inwardDetailPhotoFrame: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#e2e8f0',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  inwardDetailPhotoImage: {
    width: '100%',
    height: '100%',
  },
  inwardDetailPhotoPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // View Containers
  tabContainer: {
    flex: 1,
    backgroundColor: '#f1f5f9',
  },
  emptyContainer: {
    padding: 30,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 40,
  },
  emptyText: {
    fontSize: 14,
    color: '#64748b',
    fontWeight: 'bold',
    marginTop: 10,
    textAlign: 'center',
  },

  // Tasks sub-filter buttons
  filterTabsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    gap: 6,
  },
  filterTabButton: {
    flex: 1,
    minHeight: 32,
    paddingVertical: 5,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterTabButtonActive: {
    backgroundColor: '#003580',
    borderColor: '#003580',
  },
  filterTabButtonText: {
    fontSize: 10,
    color: '#475569',
    fontWeight: '700',
    textAlign: 'center',
  },
  filterTabButtonTextActive: {
    color: '#ffffff',
  },
  filterTabButtonCount: {
    fontSize: 9,
    color: '#64748b',
    fontWeight: '600',
    marginTop: 0,
    textAlign: 'center',
  },
  filterTabButtonCountActive: {
    color: '#dbeafe',
  },

  // Reports View Styles — match Sub-Admin layout
  reportsContainer: {
    padding: 14,
    flexGrow: 1,
  },
  reportsContentArea: {
    flex: 1,
    paddingBottom: 64,
    backgroundColor: '#f8fafc'
  },
  reportsListBody: {
    padding: 8,
    paddingBottom: 88
  },
  reportsCenterState: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    gap: 8
  },
  reportsStateText: {
    color: '#64748b',
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 19
  },
  reportsRetryBtn: {
    marginTop: 8,
    backgroundColor: '#003580',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10
  },
  reportsRetryText: { color: '#fff', fontWeight: '700', fontSize: 13, textAlign: 'center' },
  invDetailOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'flex-end'
  },
  invDetailSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '88%',
    paddingBottom: 16
  },
  invDetailHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0'
  },
  invDetailTitle: { fontSize: 15, fontWeight: '800', color: '#0f172a' },
  invExcelSub: { fontSize: 11, color: '#64748b', fontWeight: '600', marginTop: 2 },
  invExcelHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#f1f5f9',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0'
  },
  invExcelHeadCell: { fontSize: 9, fontWeight: '800', color: '#64748b' },
  invExcelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9'
  },
  invExcelRowAlt: { backgroundColor: '#f8fafc' },
  invExcelCell: { fontSize: 10, color: '#334155', fontWeight: '600' },
  invExcelColDate: { flex: 1.2 },
  invExcelColTime: { flex: 0.85 },
  invExcelColTemp: { flex: 0.75 },
  invExcelColIn: { flex: 0.55, textAlign: 'right' },
  invExcelColOut: { flex: 0.55, textAlign: 'right' },
  invExcelColQty: { flex: 0.65, textAlign: 'right' },
  doLogDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9'
  },
  doLogDetailLabel: {
    width: 110,
    fontSize: 11,
    fontWeight: '700',
    color: '#94a3b8',
    textTransform: 'uppercase'
  },
  doLogDetailValue: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    textAlign: 'right'
  },
  doDetailSafe: { flex: 1, backgroundColor: '#f8fafc' },
  doDetailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0'
  },
  doDetailBackBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f1f5f9'
  },
  doDetailTitle: { fontSize: 16, fontWeight: '800', color: '#0f172a' },
  doDetailSub: { fontSize: 12, color: '#64748b', fontWeight: '600', marginTop: 1 },
  doDetailBody: { padding: 16, paddingBottom: 40 },
  doDetailHeroCard: {
    backgroundColor: '#003580',
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 16,
    marginBottom: 12
  },
  doDetailHeroTemp: { fontSize: 28, fontWeight: '900', color: '#ffffff' },
  doDetailHeroMeta: { fontSize: 13, fontWeight: '700', color: '#bfdbfe', marginTop: 6 },
  doDetailCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 12
  },
  doDetailSectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#003580',
    marginBottom: 10,
    textTransform: 'uppercase'
  },
  doDetailImage: {
    width: '100%',
    height: 260,
    borderRadius: 10,
    backgroundColor: '#f1f5f9'
  },
  doDetailImageViewHint: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(15,23,42,0.62)',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
  },
  doDetailImageViewHintText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  doDetailImageEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 28,
    gap: 8
  },
  doDetailImageLoading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1
  },
  dailyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#eff6ff',
    borderBottomWidth: 1,
    borderBottomColor: '#dbeafe'
  },
  dailyBannerText: {
    fontSize: 10,
    color: '#003580',
    fontWeight: '700',
    flex: 1
  },
  reportsModeRow: {
    flexDirection: 'row',
    marginTop: 8,
    gap: 8
  },
  reportsModeChip: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    alignItems: 'center'
  },
  reportsModeChipActive: {
    backgroundColor: '#003580'
  },
  reportsModeChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569'
  },
  reportsModeChipTextActive: {
    color: '#ffffff'
  },
  masterPolicyCard: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe'
  },
  masterPolicyTitle: {
    marginLeft: 6,
    fontSize: 13,
    fontWeight: '800',
    color: '#003580'
  },
  masterPolicyRow: {
    fontSize: 11,
    color: '#334155',
    lineHeight: 17,
    marginTop: 4
  },
  dailyCard: {
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginBottom: 5,
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  dailyTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dailyTextCol: { flex: 1, minWidth: 0 },
  dailyChamber: { fontSize: 12, fontWeight: '800', color: '#0f172a' },
  dailyTemp: { fontSize: 13, fontWeight: '800', color: '#003580' },
  dailyMetaLine: { fontSize: 10, color: '#64748b', fontWeight: '600', marginTop: 1 },
  totalBoxesCol: { alignItems: 'flex-end', minWidth: 64 },
  totalBoxesValue: { fontSize: 15, fontWeight: '900', color: '#003580' },
  totalBoxesLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: '#64748b',
    marginTop: 1,
    textTransform: 'uppercase'
  },
  outOfStockValue: { fontSize: 15, fontWeight: '900', color: '#dc2626' },
  outOfStockLabel: { color: '#dc2626' },
  outOfStockTag: {
    marginTop: 3,
    alignSelf: 'flex-start',
    fontSize: 10,
    fontWeight: '800',
    color: '#dc2626',
    backgroundColor: '#fee2e2',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden'
  },
  totalBoxesBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#eff6ff',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
    marginHorizontal: 10,
    borderWidth: 1,
    borderColor: '#dbeafe'
  },
  totalBoxesBannerEmpty: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca'
  },
  totalBoxesBannerText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '800',
    color: '#003580'
  },
  totalBoxesBannerTextEmpty: { color: '#dc2626' },
  reportScopeCard: {
    backgroundColor: '#003580',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 14,
  },
  reportScopeTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#ffffff',
    marginBottom: 4,
  },
  reportScopeSub: {
    fontSize: 12,
    color: '#bfdbfe',
    lineHeight: 17,
  },
  reportSectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
    marginBottom: 8,
    marginLeft: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  reportRangeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#eff6ff',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  reportRangeBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#003580',
  },
  reportRangePickChip: {
    flex: 1,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  reportRangePickChipActive: {
    backgroundColor: '#eff6ff',
    borderColor: '#003580',
  },
  reportRangePickChipText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b',
    textAlign: 'center',
  },
  reportRangePickChipTextActive: {
    color: '#003580',
  },
  reportDateRangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8
  },
  reportDateRangeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 48
  },
  reportDateRangeBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
    marginTop: 1
  },
  reportDateTodayBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    minHeight: 48,
    justifyContent: 'center'
  },
  reportDateTodayBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#003580'
  },
  reportFiltersRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 8,
    zIndex: 20
  },
  reportClearRow: {
    flexDirection: 'row',
    marginBottom: 8
  },
  reportClearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#fee2e2',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#fecaca'
  },
  reportClearBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#dc2626'
  },
  reportFilterTextWrap: {
    flex: 1,
    minWidth: 0
  },
  reportFilterLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.3
  },
  reportFilterTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 48
  },
  reportFilterTriggerActive: {
    backgroundColor: '#eff6ff',
    borderColor: '#93c5fd'
  },
  reportFilterTriggerText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
    marginTop: 1
  },
  reportFilterTriggerTextActive: {
    color: '#003580'
  },
  reportSlotChip: {
    flex: 1,
    paddingVertical: 8,
    minHeight: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center'
  },
  reportSlotChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b'
  },
  reportFilterDropdown: {
    position: 'absolute',
    top: 52,
    left: 0,
    right: 0,
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#0f172a',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
    overflow: 'hidden'
  },
  reportFilterOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f1f5f9'
  },
  reportFilterOptionText: {
    flex: 1,
    fontSize: 12,
    color: '#334155',
    fontWeight: '500'
  },
  reportFilterModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'flex-end'
  },
  reportFilterModalSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 20,
    maxHeight: BOTTOM_SHEET_MAX_H,
  },
  calendarFilterModalSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 14,
  },
  reportFilterModalScroll: {
    maxHeight: BOTTOM_SHEET_SCROLL_H,
  },
  reportFilterModalTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 10
  },
  reportFilterModalEmpty: {
    paddingVertical: 20,
    textAlign: 'center',
    fontSize: 12,
    color: '#94a3b8'
  },
  reportFilterModalClose: {
    marginTop: 12,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#f1f5f9'
  },
  reportFilterModalCloseText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155'
  },
  calendarSheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 999,
    backgroundColor: '#cbd5e1',
    marginBottom: 8,
  },
  calendarSheetHint: {
    fontSize: 10,
    color: '#64748b',
    marginBottom: 8,
    fontWeight: '600',
  },
  calendarSheetChipRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  calendarSheetMonthRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  calendarSheetMonthText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
  },
  calendarSheetWeekDay: {
    width: '14.28%',
    textAlign: 'center',
    fontSize: 9,
    fontWeight: '800',
    color: '#94a3b8',
  },
  calendarSheetDayCell: {
    width: '14.28%',
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calendarSheetSuggestRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  /* DO Reports filters — same as Sub-Admin filterPanel */
  doFilterPanel: {
    backgroundColor: '#fff',
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0'
  },
  doLogTypeRow: { flexDirection: 'row', gap: 6, marginBottom: 6 },
  doLogTypeChip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  doLogTypeChipActive: { backgroundColor: '#003580', borderColor: '#003580' },
  doLogTypeChipText: { fontSize: 11, fontWeight: '700', color: '#64748b' },
  doLogTypeChipTextActive: { color: '#fff' },
  doFilterRow: { flexDirection: 'row', gap: 6, marginBottom: 6 },
  doFilterChip: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 7,
    paddingHorizontal: 5,
    paddingVertical: 3
  },
  doFilterChipActive: { borderColor: '#93c5fd', backgroundColor: '#eff6ff' },
  doFilterChipActiveWarn: { borderColor: '#fca5a5', backgroundColor: '#fef2f2' },
  doFilterChipLabel: {
    fontSize: 7,
    color: '#94a3b8',
    fontWeight: '700',
    letterSpacing: 0.2,
    lineHeight: 9
  },
  doFilterChipValue: {
    fontSize: 10,
    color: '#0f172a',
    fontWeight: '700',
    marginTop: 0,
    lineHeight: 13
  },
  doSuggestRow: { gap: 6, paddingBottom: 2 },
  doSuggestChip: {
    backgroundColor: '#f1f5f9',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4
  },
  doSuggestClear: { backgroundColor: '#fee2e2' },
  doSuggestText: { fontSize: 11, fontWeight: '700', color: '#334155' },
  reportSearchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 12,
  },
  reportExportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#003580',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  reportExportBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#ffffff',
  },
  reportSummaryCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 14,
  },
  reportHeader: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#003580',
    marginBottom: 12,
  },
  statsMetricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statsBox: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    paddingVertical: 12,
    marginHorizontal: 4,
  },
  statsVal: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0f172a',
  },
  statsLbl: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b',
    marginTop: 4,
    textTransform: 'uppercase',
  },
  chartCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 14,
  },
  chartTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#1e293b',
    marginBottom: 12,
  },
  barGraphContainer: {
    flexDirection: 'row',
    height: 140,
    alignItems: 'flex-end',
    justifyContent: 'space-around',
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    marginBottom: 8,
  },
  graphBarColumn: {
    alignItems: 'center',
    width: 32,
    height: '100%',
    justifyContent: 'flex-end',
  },
  graphBarValue: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#64748b',
    marginBottom: 4,
  },
  graphBar: {
    width: 14,
    borderRadius: 4,
    minHeight: 10,
  },
  graphBarLabel: {
    fontSize: 9,
    color: '#64748b',
    marginTop: 6,
    fontWeight: '600',
  },
  chartSubtext: {
    fontSize: 9,
    color: '#94a3b8',
    textAlign: 'center',
    marginTop: 4,
  },
  alertLogsCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  alertLogsCardTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#003580',
    marginBottom: 12,
  },
  reportsEmptyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  reportsEmptyText: {
    fontSize: 12,
    color: '#16a34a',
    fontWeight: '600',
    marginLeft: 8,
  },
  alertLogItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: '#f1f5f9',
  },
  alertLogClient: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#1e293b',
  },
  alertLogMeta: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 2,
  },
  alertLogTemp: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#ef4444',
  },

  // More View Styles
  moreContainer: {
    padding: 14,
  },
  profileCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  profileAvatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  profileMeta: {
    flex: 1,
  },
  profileName: {
    fontSize: 17,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  profileRole: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: 'bold',
    marginTop: 1,
  },
  profileEmail: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
  },
  moreSectionCard: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 14,
  },
  moreSectionTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#003580',
    marginBottom: 10,
  },
  moreSectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  moreProfileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 0,
    paddingBottom: 0,
    borderBottomWidth: 0
  },
  moreProfileDropBody: {
    marginTop: 12,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e2e8f0'
  },
  moreMasterAddBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#003580',
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreMasterOpenBtn: {
    backgroundColor: '#003580',
    borderColor: '#003580',
  },
  moreReportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    marginBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  moreReportIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  moreReportMeta: {
    flex: 1,
    minWidth: 0,
  },
  moreReportTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
  },
  moreReportSub: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 1,
    fontWeight: '600',
  },
  doProfileRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
    marginBottom: 2
  },
  doProfileLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    minWidth: 110
  },
  doProfileValue: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    textAlign: 'right'
  },
  syncStatusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  syncStatusLabel: {
    fontSize: 13,
    color: '#475569',
    fontWeight: '500',
  },
  syncSpinnerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    justifyContent: 'center',
  },
  syncSpinnerText: {
    fontSize: 12,
    color: '#475569',
    marginLeft: 8,
  },
  syncActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ea580c',
    paddingVertical: 10,
    borderRadius: 8
  },
  syncActionBtnDisabled: {
    backgroundColor: '#fdba74',
    opacity: 0.6,
  },
  syncActionBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  ipSettingsDesc: {
    fontSize: 12,
    color: '#64748b',
    marginBottom: 8,
    lineHeight: 18,
  },
  ipAddressContainer: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  ipAddressValue: {
    fontSize: 13,
    color: '#475569',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  ipUpdateActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    paddingVertical: 10,
    borderRadius: 8,
  },
  ipUpdateActionBtnText: {
    color: '#003580',
    fontSize: 12,
    fontWeight: 'bold',
  },
  appInfoBox: {
    alignItems: 'center',
    marginVertical: 14,
  },
  appInfoText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#94a3b8',
  },
  appInfoVersion: {
    fontSize: 9,
    color: '#cbd5e1',
    marginTop: 2,
  },
  moreLogoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ef4444',
    paddingVertical: 12,
    borderRadius: 10,
    elevation: 2
  },
  moreLogoutBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: 'bold',
  },
  
  // Dynamic Segmented Type Selector Styles
  typeSelectorRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 4,
    width: '100%',
  },
  typeTabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingVertical: 6,
    marginHorizontal: 3,
    backgroundColor: '#ffffff',
  },
  typeTabText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#475569',
  },

  // Vertical Photo Verification Styles
  verticalCameraBtn: {
    width: '100%',
    height: 120,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#cbd5e1',
    borderStyle: 'solid',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#003580',
    marginVertical: 8,
  },
  verticalCameraBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#ffffff',
    marginTop: 6
  },
  verticalPhotoWrapper: {
    width: '100%',
    height: 220,
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
    marginVertical: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1.2,
    borderColor: '#e2e8f0',
  },
  verticalPhotoPreview: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  verticalRetakeBtn: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },

  // Card-based Dropdown Row Master Styles
  dropdownCardItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    backgroundColor: '#ffffff',
    marginVertical: 3,
    marginHorizontal: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  statusIndicatorCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  dropdownCardItemText: {
    fontSize: 13,
    color: '#0f172a',
    fontWeight: '600',
    flex: 1,
  },
  completedBadgePill: {
    backgroundColor: '#dcfce7',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    marginLeft: 8,
  },
  completedBadgeText: {
    fontSize: 9,
    color: '#16a34a',
    fontWeight: 'bold',
  },
  dropdownDeleteBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#fee2e2',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 10,
  },
  dropdownAddActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#003580',
    borderRadius: 8,
    paddingVertical: 10,
    marginTop: 8,
    marginHorizontal: 4,
    marginBottom: 4,
  },
  dropdownAddActionBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  
  // Drawer Menu Styles
  drawerOverlay: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: 'rgba(15, 23, 42, 0.4)',
  },
  drawerBackdrop: {
    flex: 1,
    height: '100%',
  },
  drawerPanel: {
    width: 280,
    height: '100%',
    backgroundColor: '#ffffff',
    paddingTop: Platform.OS === 'ios' ? 50 : 20,
    shadowColor: '#0f172a',
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 16,
  },
  drawerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderColor: '#f1f5f9',
  },
  drawerBrandContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  drawerBrandText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#003580',
    marginLeft: 8,
  },
  drawerUserCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    margin: 16,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  drawerUserAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#e0e7ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  drawerUserName: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  drawerUserRole: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 1,
    fontWeight: '600',
  },
  drawerMenuScroll: {
    flex: 1,
    paddingHorizontal: 16,
  },
  drawerMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginBottom: 6,
  },
  drawerMenuItemActive: {
    backgroundColor: '#eff6ff',
  },
  drawerMenuItemActiveInward: {
    backgroundColor: '#f0fdfa',
  },
  drawerMenuItemActiveOutward: {
    backgroundColor: '#fff7ed',
  },
  drawerMenuText: {
    fontSize: 13,
    color: '#475569',
    fontWeight: '600',
  },
  drawerMenuTextActive: {
    color: '#003580',
    fontWeight: 'bold',
  },
  drawerMenuTextActiveInward: {
    color: '#0D9488',
    fontWeight: 'bold',
  },
  drawerMenuTextActiveOutward: {
    color: '#d97706',
    fontWeight: 'bold',
  },
  drawerFooter: {
    paddingHorizontal: 16,
    paddingVertical: 15,
    borderTopWidth: 1,
    borderColor: '#f1f5f9',
    marginBottom: Platform.OS === 'ios' ? 25 : 10,
  },
  drawerLogoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  drawerLogoutText: {
    fontSize: 13,
    color: '#ef4444',
    fontWeight: 'bold',
  },

  // Date Slider & Custom Calendar Styles
  sliderOuterContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    marginHorizontal: 16,
    marginBottom: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 8,
  },
  sliderScroll: {
    paddingRight: 10,
  },
  sliderCard: {
    width: 50,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  sliderCardActive: {
    backgroundColor: '#003580',
    borderColor: '#003580',
  },
  sliderDayName: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#64748b',
    textTransform: 'uppercase',
  },
  sliderDayNum: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#0f172a',
    marginTop: 2,
  },
  sliderTextActive: {
    color: '#ffffff',
  },
  sliderCalendarBtn: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 12,
    borderLeftWidth: 1,
    borderLeftColor: '#e2e8f0',
    width: 55,
  },
  sliderCalendarBtnText: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#003580',
    marginTop: 2,
  },

  // Client Box Inventory Styles
  inventoryItemCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    marginBottom: 12,
  },
  inventoryItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  inventoryClientName: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  inventoryChamberLabel: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  inventoryCountBadge: {
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  inventoryCountText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#0369a1',
  },
  inventoryTrendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    padding: 8,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: '#cbd5e1',
    marginBottom: 10,
  },
  inventoryTrendText: {
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 6,
  },
  inventoryHistoryList: {
    borderTopWidth: 0.5,
    borderColor: '#cbd5e1',
    paddingTop: 8,
  },
  historyListTitle: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#64748b',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 3,
  },
  historyDate: {
    fontSize: 11,
    color: '#475569',
  },
  historyBoxes: {
    fontSize: 11,
    fontWeight: '600',
    color: '#0f172a',
  },
  inventoryLauncherCard: {
    backgroundColor: '#ffffff',
    marginHorizontal: 16,
    marginBottom: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
  },
  inventoryLauncherIconBg: {
    width: 38,
    height: 38,
    borderRadius: 8,
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  inventoryLauncherTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#0f172a',
  },
  inventoryLauncherSub: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
});
