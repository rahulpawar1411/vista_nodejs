// ====================================================================
// Sub Admin — mobile/src/screens/SubAdminScreen.js
// --------------------------------------------------------------------
// Role `sub_admin`: mobile mini-admin (same data scope as Super Admin).
// Tabs: Dashboard | Logs | Reports | Admin | More
// Admin → Master = catalog (warehouse_master / client_master).
// DO profile → Edit chambers & clients = assignments (operational).
// Permissions: approve free; deny requires remark. Push on new request
// even if this app is closed. No overdue push — overdue is dashboard only.
// Errors: formatUserError + InlineErrorState; reports keep last cache offline.
// ====================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  ScrollView,
  StatusBar,
  SafeAreaView,
  ActivityIndicator,
  RefreshControl,
  FlatList,
  Modal,
  Linking,
  Alert,
  Share,
  Platform,
  BackHandler,
  Animated,
  TextInput,
  KeyboardAvoidingView,
  Pressable
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import FastTouchable from '../components/FastTouchable';
import { dedupeInventoryLots } from '../utils/dedupeInventoryLots';
import { buildReportReadingRows, latestReadingQty } from '../utils/buildReportReadingRows';
import { PhotoGridWithLocation } from '../components/LogDetailPhotoLocation';
import {
  resolveLogImageUrl,
  DOCK_REPORT_PAGE_SIZE,
  buildInwardOutwardPhotoItems,
  formatPhotoGps,
  openLocationInMaps
} from '../utils/customerLogReportHelpers';
import { formatUserError } from '../utils/userFacingError';
import ListLoadingOverlay from '../components/ListLoadingOverlay';
import InlineErrorState from '../components/InlineErrorState';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import {
  initSubAdminPushAlerts,
  notifySubAdminIfNeeded,
  clearSubAdminPushToken,
  resetSubAdminPushAlerts,
  subscribePermissionNotificationOpen,
  subscribeSubAdminPushTokenRefresh
} from '../services/subAdminPushAlerts';
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
import SubAdminAdminPanel from '../components/SubAdminAdminPanel';
import SubAdminDoMasterSetup from '../components/SubAdminDoMasterSetup';
import SavedChangesPopup from '../components/SavedChangesPopup';
import { generateClientCode } from '../utils/generateClientCode';
import { generateWarehouseCode } from '../utils/generateWarehouseCode';

function suggestWarehouseCode(name, city, existingCodes = []) {
  return generateWarehouseCode(name, city, existingCodes);
}

function parseMasterList(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function isCatalogActive(row) {
  const v = row?.is_active;
  if (v === false || v === 0 || v === '0') return false;
  return Number(v) !== 0;
}

const TouchableOpacity = FastTouchable;

const PRODUCTION_API_URL = 'https://reeferon-crm-backend.onrender.com';

function resolveImageUrl(raw, baseUrl, folderHint = 'daily_temp_monitor_images') {
  return resolveLogImageUrl(raw, baseUrl, folderHint);
}

function pickLogImage(log) {
  if (!log) return null;
  if (log._logType === 'inward') {
    return (
      log.inward_material_temp_photo ||
      log.inward_vehicle_temp_photo ||
      log.inward_pod_photo ||
      log.inward_vehicle_back_side_photo ||
      null
    );
  }
  if (log._logType === 'outward') {
    return (
      log.outward_material_temp_photo ||
      log.outward_vehicle_temp_photo ||
      log.outward_pod_photo ||
      log.outward_vehicle_back_side_photo ||
      null
    );
  }
  return log.temp_sensor_image || null;
}

async function downloadImageToDevice(uri) {
  if (!uri) throw new Error('No image URL');

  const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!baseDir) throw new Error('Storage not available on this device');

  const fileName = `reeferon_${Date.now()}.jpg`;
  const dest = `${baseDir}${fileName}`;

  let localUri = dest;
  if (uri.startsWith('data:')) {
    const base64 = uri.replace(/^data:image\/\w+;base64,/, '');
    await FileSystem.writeAsStringAsync(dest, base64, {
      encoding: FileSystem.EncodingType.Base64
    });
  } else {
    const result = await FileSystem.downloadAsync(uri, dest);
    localUri = result.uri;
  }

  // Open system share sheet so user can Save / Download / Share
  if (Platform.OS === 'android') {
    try {
      const contentUri = await FileSystem.getContentUriAsync(localUri);
      await Share.share({ url: contentUri, message: 'ReeferON log image', title: 'Download image' });
      return localUri;
    } catch (_) {
      /* fall through */
    }
  }

  await Share.share({
    url: localUri,
    message: Platform.OS === 'ios' ? undefined : 'ReeferON log image',
    title: 'Download image'
  });
  return localUri;
}

function SmallLogImage({ rawPath, apiUrl, folderHint, latitude, longitude, accuracy }) {
  const uri = useMemo(() => {
    const primary = resolveImageUrl(rawPath, apiUrl, folderHint);
    if (primary) return primary;
    return resolveImageUrl(rawPath, PRODUCTION_API_URL, folderHint);
  }, [rawPath, apiUrl, folderHint]);
  const [failed, setFailed] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const locationText = useMemo(
    () => formatPhotoGps(latitude, longitude, accuracy),
    [latitude, longitude, accuracy]
  );
  const hasGps =
    latitude != null &&
    longitude != null &&
    Number.isFinite(parseFloat(latitude)) &&
    Number.isFinite(parseFloat(longitude));

  useEffect(() => {
    setFailed(false);
  }, [uri]);

  const handleDownload = async () => {
    if (!uri || downloading) return;
    setDownloading(true);
    try {
      await downloadImageToDevice(uri);
      Alert.alert('Saved', 'Use Save Image / Downloads from the share sheet to keep the photo.');
    } catch (err) {
      Alert.alert('Download failed', err?.message || 'Could not download image.');
    } finally {
      setDownloading(false);
    }
  };

  if (!uri || failed) {
    return (
      <View style={styles.smallImgEmpty}>
        <Ionicons name="image-outline" size={18} color="#94a3b8" />
        <Text style={styles.smallImgEmptyText}>No image</Text>
        {locationText ? (
          <TouchableOpacity
            onPress={() => openLocationInMaps(latitude, longitude)}
            disabled={!hasGps}
            activeOpacity={hasGps ? 0.75 : 1}
          >
            <Text style={[styles.smallImgLocation, hasGps && styles.smallImgLocationLink]}>
              Location: {locationText}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  return (
    <>
      <TouchableOpacity activeOpacity={0.85} onPress={() => setViewerOpen(true)}>
        <Image
          source={{ uri }}
          style={styles.smallImg}
          resizeMode="cover"
          onError={() => setFailed(true)}
        />
        <Text style={styles.smallImgHint}>Tap to view</Text>
      </TouchableOpacity>
      {locationText ? (
        <TouchableOpacity
          onPress={() => openLocationInMaps(latitude, longitude)}
          disabled={!hasGps}
          activeOpacity={hasGps ? 0.75 : 1}
          style={styles.smallImgLocationWrap}
        >
          <Ionicons name="location-outline" size={12} color={hasGps ? '#0369a1' : '#64748b'} />
          <Text style={[styles.smallImgLocation, hasGps && styles.smallImgLocationLink]}>
            Location: {locationText}
          </Text>
        </TouchableOpacity>
      ) : (
        <Text style={styles.smallImgLocationMuted}>Location: not recorded</Text>
      )}

      <Modal
        visible={viewerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setViewerOpen(false)}
      >
        <View style={styles.imgViewerOverlay}>
          <View style={styles.imgViewerTop}>
            <TouchableOpacity
              style={styles.imgViewerBtn}
              onPress={() => setViewerOpen(false)}
              activeOpacity={0.85}
            >
              <Ionicons name="close" size={20} color="#fff" />
              <Text style={styles.imgViewerBtnText}>Close</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.imgViewerBtn, styles.imgViewerDownload]}
              onPress={handleDownload}
              disabled={downloading}
              activeOpacity={0.85}
            >
              {downloading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="download-outline" size={18} color="#fff" />
                  <Text style={styles.imgViewerBtnText}>Download</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
          <ScrollView
            maximumZoomScale={3}
            minimumZoomScale={1}
            contentContainerStyle={styles.imgViewerBody}
            centerContent
          >
            <Image source={{ uri }} style={styles.imgViewerImage} resizeMode="contain" />
          </ScrollView>
          {locationText ? (
            <TouchableOpacity
              style={styles.imgViewerLocationBar}
              onPress={() => openLocationInMaps(latitude, longitude)}
              disabled={!hasGps}
              activeOpacity={hasGps ? 0.75 : 1}
            >
              <Ionicons name="location-outline" size={14} color="#fff" />
              <Text style={styles.imgViewerLocationText}>Location: {locationText}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </Modal>
    </>
  );
}

/**
 * Mobile Sub-Admin — overview, permission approve/deny, catalog Master,
 * and per-DO chamber/client assignments (not mixed with catalog CRUD).
 */
const SUBADMIN_BOTTOM_TAB_COUNT = 5;
const SUBADMIN_BOTTOM_TABS = [
  { id: 'Dashboard', label: 'Dashboard', icon: 'home', iconOutline: 'home-outline' },
  { id: 'Logs', label: 'Logs', icon: 'list', iconOutline: 'list-outline' },
  { id: 'Reports', label: 'Reports', icon: 'stats-chart', iconOutline: 'stats-chart-outline' },
  { id: 'Admin', label: 'Admin', icon: 'construct', iconOutline: 'construct-outline' },
  { id: 'More', label: 'More', icon: 'person', iconOutline: 'person-outline' }
];

function getSubAdminBottomTabIndex(tab) {
  if (tab === 'Dashboard' || tab === 'Home') return 0;
  if (tab === 'Logs') return 1;
  if (tab === 'Reports') return 2;
  if (tab === 'Admin') return 3;
  return 4;
}

export default function SubAdminScreen({ user, token, apiUrl, onLogout }) {
  const [activeTab, setActiveTab] = useState('Dashboard');
  const tabIndicatorX = useRef(new Animated.Value(0)).current;
  const tabBarWidthRef = useRef(0);
  const [tabIndicatorWidth, setTabIndicatorWidth] = useState(0);
  const [adminInitialSection, setAdminInitialSection] = useState('permissions');
  const [adminPermFilter, setAdminPermFilter] = useState('pending');
  const [showDrawer, setShowDrawer] = useState(false);
  const drawerAnim = useRef(new Animated.Value(-280)).current;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (showDrawer) {
      drawerAnim.setValue(-280);
      Animated.timing(drawerAnim, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true
      }).start();
    }
  }, [showDrawer, drawerAnim]);

  const openDrawer = () => setShowDrawer(true);

  const closeDrawer = useCallback(() => {
    Animated.timing(drawerAnim, {
      toValue: -280,
      duration: 200,
      useNativeDriver: true
    }).start(() => {
      setShowDrawer(false);
    });
  }, [drawerAnim]);

  const slideTabIndicator = useCallback(
    (index, barWidth, animated) => {
      if (!barWidth) return;
      const tabW = barWidth / SUBADMIN_BOTTOM_TAB_COUNT;
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
        tension: 90
      }).start();
    },
    [tabIndicatorX]
  );

  useEffect(() => {
    slideTabIndicator(getSubAdminBottomTabIndex(activeTab), tabBarWidthRef.current, true);
  }, [activeTab, slideTabIndicator]);

  const [stats, setStats] = useState(null);
  const [todayLogs, setTodayLogs] = useState([]);
  const [warehouseTasks, setWarehouseTasks] = useState([]);
  const [homeOperators, setHomeOperators] = useState([]);
  const [homeCustomers, setHomeCustomers] = useState([]);
  const [homeCatalogWarehouses, setHomeCatalogWarehouses] = useState([]);
  const [homeCatalogClients, setHomeCatalogClients] = useState([]);
  const [customerModal, setCustomerModal] = useState({
    visible: false,
    mode: 'create',
    busy: false,
    id: null
  });
  const [customerForm, setCustomerForm] = useState({
    full_name: '',
    email: '',
    phone_no: '',
    password: '',
    allowed_warehouses: '',
    allowed_clients: ''
  });
  const [catalogModal, setCatalogModal] = useState({
    visible: false,
    kind: 'warehouse',
    mode: 'create',
    busy: false,
    id: null
  });
  const [warehouseForm, setWarehouseForm] = useState({
    warehouse_code: '',
    warehouse_name: '',
    city: ''
  });
  const [clientForm, setClientForm] = useState({
    client_code: '',
    client_name: '',
    warehouse_name: '',
    warehouse_code: ''
  });
  const warehouseCodeManualRef = useRef(false);
  const clientCodeManualRef = useRef(false);
  const [taskSummary, setTaskSummary] = useState(null);
  const [homeListFocus, setHomeListFocus] = useState('ops'); // warehouses | customers | ops
  const [selectedDoProfile, setSelectedDoProfile] = useState(null);
  const [showDoMasterSetup, setShowDoMasterSetup] = useState(false);
  const [doProfileEditing, setDoProfileEditing] = useState(false);
  const [doProfileBusy, setDoProfileBusy] = useState(false);
  const [doProfileForm, setDoProfileForm] = useState({
    full_name: '',
    phone_no: '',
    warehouse_name: '',
    chamber_limit: ''
  });
  const [doProfileAssignments, setDoProfileAssignments] = useState([]);
  const [doProfileAssignLoading, setDoProfileAssignLoading] = useState(false);
  const [savedPopup, setSavedPopup] = useState({
    visible: false,
    title: 'Changes saved',
    message: 'Your updates were saved successfully.'
  });

  const showSavedChanges = useCallback((title, message) => {
    setSavedPopup({
      visible: true,
      title: title || 'Changes saved',
      message: message || 'Your updates were saved successfully.'
    });
  }, []);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeRefreshing, setHomeRefreshing] = useState(false);
  const [homeError, setHomeError] = useState('');
  const [homeLastUpdated, setHomeLastUpdated] = useState(null);
  const homeOverviewRequestIdRef = useRef(0);

  const [warehouseFilter, setWarehouseFilter] = useState('All');
  const [chamberFilter, setChamberFilter] = useState('All');
  const [clientFilter, setClientFilter] = useState('All');
  const [logType, setLogType] = useState('chambers'); // chambers | inward | outward
  const [logFilterScope, setLogFilterScope] = useState({
    warehouses: [],
    warehouseClients: {}, // wh -> [clients]
    warehouseChambers: {}, // wh -> [{ name, clients: [] }]
  });
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  });
  const [dateTo, setDateTo] = useState(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  });
  const [openFilter, setOpenFilter] = useState(null);
  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const [calendarPickMode, setCalendarPickMode] = useState('from');
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [warehouses, setWarehouses] = useState([]);
  const [clients, setClients] = useState([]);
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState('');
  const [logsRefreshing, setLogsRefreshing] = useState(false);
  const [logTaskSummary, setLogTaskSummary] = useState(null);
  const [logTaskSummaryLoading, setLogTaskSummaryLoading] = useState(false);
  const [logPage, setLogPage] = useState(1);
  const [logTotal, setLogTotal] = useState(0);
  const [logHasMore, setLogHasMore] = useState(false);
  const [selectedLog, setSelectedLog] = useState(null);

  const [reportRows, setReportRows] = useState([]);
  const [reportWarehouses, setReportWarehouses] = useState([]);
  const [reportClients, setReportClients] = useState([]);
  // For Reports filter: selected warehouse ke hisaab se hi clients dropdown me dikhane ke liye
  const [reportWarehouseClientsMap, setReportWarehouseClientsMap] = useState({});
  const [reportWarehouseFilter, setReportWarehouseFilter] = useState('All');
  const [reportClientFilter, setReportClientFilter] = useState('All');
  const [reportView, setReportView] = useState('all'); // all | mismatch
  const [selectedReport, setSelectedReport] = useState(null);
  const [reportHistory, setReportHistory] = useState([]);
  const [reportHistoryLoading, setReportHistoryLoading] = useState(false);
  const [reportHistoryError, setReportHistoryError] = useState('');
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportsError, setReportsError] = useState('');
  const [reportsRefreshing, setReportsRefreshing] = useState(false);
  const [reportsLoadingMore, setReportsLoadingMore] = useState(false);
  const [reportHasMore, setReportHasMore] = useState(false);
  const [reportsFromCache, setReportsFromCache] = useState(false);
  const [reportsLastUpdated, setReportsLastUpdated] = useState(null);
  const [isOnline, setIsOnline] = useState(true);
  const reportOffsetRef = useRef(0);
  const reportsLoadingMoreRef = useRef(false);
  const reportHasMoreRef = useRef(false);
  const reportRowsRef = useRef([]);

  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifFilter, setNotifFilter] = useState('all'); // all | pending | decided
  const [seenNotifIds, setSeenNotifIds] = useState([]);
  const [notifActionBusy, setNotifActionBusy] = useState(null);
  const [permissionsUpdatedAt, setPermissionsUpdatedAt] = useState(null);
  const [denyModal, setDenyModal] = useState({
    visible: false,
    id: null,
    remark: ''
  });

  const REPORTS_CACHE_KEY = 'subadmin_inventory_reports_cache_v1';

  const displayName = user?.full_name || user?.email?.split('@')[0] || 'Sub-Admin';

  const formatClockTime = useCallback((d = new Date()) => {
    try {
      return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
  }, []);
  const toLocalYmd = (d = new Date()) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const authHeaders = useMemo(
    () => ({
      Accept: 'application/json',
      Authorization: `Bearer ${token}`
    }),
    [token]
  );

  const formatDateLabel = (value) => {
    if (!value || value === 'All') return 'All';
    const today = toLocalYmd();
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const yesterday = toLocalYmd(y);
    if (value === today) return 'Today';
    if (value === yesterday) return 'Yesterday';
    return value;
  };

  const applyDateRange = (from, to) => {
    if (from === 'All' && to === 'All') {
      setDateFrom('All');
      setDateTo('All');
      return;
    }
    let nextFrom = from === 'All' ? to : from;
    let nextTo = to === 'All' ? from : to;
    if (nextFrom !== 'All' && nextTo !== 'All' && nextTo < nextFrom) nextTo = nextFrom;
    setDateFrom(nextFrom || 'All');
    setDateTo(nextTo || 'All');
  };

  const clearAllFilters = () => {
    setWarehouseFilter('All');
    setClientFilter('All');
    setOpenFilter(null);
    // Chambers = daily view → reset to today; other types clear dates
    if (logType === 'chambers') {
      const t = toLocalYmd();
      applyDateRange(t, t);
    } else {
      applyDateRange('All', 'All');
    }
  };

  const normalizeLogRow = (row, type) => {
    if (type === 'inward') {
      return {
        ...row,
        _logType: 'inward',
        client_name: row.inward_client_name || row.client_name || null,
        warehouse_name: row.warehouse_name || null,
        chamber_name: row.inward_vehicle_no ? `Vehicle ${row.inward_vehicle_no}` : row.inward_dock_no || 'Inward',
        entry_date: row.inward_entry_date || row.entry_date || null,
        formatted_date: row.inward_entry_date || row.formatted_date || null,
        box_temp: row.inward_material_temp ?? row.inward_vehicle_temp ?? null,
        chamber_temp: row.inward_vehicle_temp ?? null,
        shift: row.inward_material_type || null,
        box_count: row.inward_received_boxes_qty ?? row.inward_received_qty ?? null
      };
    }
    if (type === 'outward') {
      return {
        ...row,
        _logType: 'outward',
        client_name: row.outward_client_name || row.client_name || null,
        warehouse_name: row.warehouse_name || null,
        chamber_name: row.outward_vehicle_no
          ? `Vehicle ${row.outward_vehicle_no}`
          : row.outward_dock_no || 'Outward',
        entry_date: row.outward_entry_date || row.entry_date || null,
        formatted_date: row.outward_entry_date || row.formatted_date || null,
        box_temp: row.outward_material_temp ?? row.outward_vehicle_temp ?? null,
        chamber_temp: row.outward_vehicle_temp ?? null,
        shift: row.outward_material_type || null,
        box_count: row.outward_loaded_boxes_qty ?? row.outward_invoice_qty ?? null
      };
    }
    return { ...row, _logType: 'chambers' };
  };

  const openCalendar = (mode = 'from') => {
    setOpenFilter(null);
    const seed =
      mode === 'to' && dateTo !== 'All'
        ? dateTo
        : dateFrom !== 'All'
          ? dateFrom
          : toLocalYmd();
    setCalendarMonth(new Date(`${seed}T12:00:00`));
    setCalendarPickMode(mode);
    setShowCalendarModal(true);
  };

  const getCalendarDays = (dateObj) => {
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth();
    const firstDay = new Date(year, month, 1);
    const totalDays = new Date(year, month + 1, 0).getDate();
    const startDayOfWeek = firstDay.getDay();
    const days = [];
    for (let i = 0; i < startDayOfWeek; i += 1) days.push(null);
    for (let day = 1; day <= totalDays; day += 1) days.push(new Date(year, month, day));
    return days;
  };

  const applyDoTaskOverviewPayload = useCallback((tasksData) => {
    const warehouses = Array.isArray(tasksData?.warehouses) ? tasksData.warehouses : [];
    setWarehouseTasks(warehouses);
    setTaskSummary(tasksData?.summary || null);

    let doList = [];
    if (Array.isArray(tasksData?.operators) && tasksData.operators.length) {
      doList = tasksData.operators.map((op) => ({
        ...op,
        morning_completed: Number(op.morning_completed) || 0,
        morning_expected: Number(op.morning_expected) || 0,
        morning_pending: Number(op.morning_pending) || 0,
        evening_completed: Number(op.evening_completed) || 0,
        evening_expected: Number(op.evening_expected) || 0,
        evening_pending: Number(op.evening_pending) || 0
      }));
    } else {
      warehouses.forEach((w) => {
        (w.operators || []).forEach((op) => {
          doList.push({
            ...op,
            warehouse_name: w.warehouse_name,
            completed: w.completed,
            pending: w.pending,
            overdue: w.overdue,
            morning_completed: w.morning_completed,
            morning_expected: w.morning_expected,
            morning_pending: w.morning_pending,
            evening_completed: w.evening_completed,
            evening_expected: w.evening_expected,
            evening_pending: w.evening_pending
          });
        });
      });
    }
    setHomeOperators(doList);
  }, []);

  const loadHomeOverview = useCallback(async () => {
    if (!apiUrl || !token) return;
    const requestId = ++homeOverviewRequestIdRef.current;
    setHomeLoading(true);
    setHomeError('');
    try {
      const today = toLocalYmd();
      const taskQs = new URLSearchParams({ date: today });
      const [statsRes, logsRes, tasksRes, customersRes, filterRes, operatorsRes, whMasterRes, clMasterRes] =
        await Promise.all([
        fetch(`${apiUrl}/api/dashboard`, { headers: authHeaders }),
        fetch(
          `${apiUrl}/api/chamber-temp?${new URLSearchParams({
            page: '1',
            limit: '80',
            fromDate: today,
            toDate: today
          }).toString()}`,
          { headers: authHeaders }
        ),
        fetch(`${apiUrl}/api/dashboard/do-task-overview?${taskQs.toString()}`, {
          headers: authHeaders
        }),
        fetch(`${apiUrl}/api/dashboard/customers`, { headers: authHeaders }),
        fetch(`${apiUrl}/api/dashboard/inventory-filter-options`, { headers: authHeaders }),
        fetch(`${apiUrl}/api/dashboard/do-operators`, { headers: authHeaders }),
        fetch(`${apiUrl}/api/masters/warehouses?active_only=0`, { headers: authHeaders }),
        fetch(`${apiUrl}/api/masters/clients?active_only=0`, { headers: authHeaders })
      ]);

      if (requestId !== homeOverviewRequestIdRef.current) return;

      const statsData = await statsRes.json().catch(() => ({}));
      if (!statsRes.ok) {
        throw new Error(statsData.message || statsData.error || `Stats failed (${statsRes.status})`);
      }
      setStats(statsData.stats || statsData || {});

      const logsData = await logsRes.json().catch(() => ({}));
      if (logsRes.ok) {
        const items = Array.isArray(logsData?.items)
          ? logsData.items
          : Array.isArray(logsData)
            ? logsData
            : [];
        const scoped = items.filter((row) => {
          const d = String(row.formatted_date || row.entry_date || '').slice(0, 10);
          return d === today;
        });
        setTodayLogs(scoped);
      } else {
        console.warn('Today logs failed:', logsData.message || logsRes.status);
        setTodayLogs([]);
      }

      const tasksData = await tasksRes.json().catch(() => ({}));
      const filterData = await filterRes.json().catch(() => ({}));
      const operatorsData = await operatorsRes.json().catch(() => ({}));

      if (requestId !== homeOverviewRequestIdRef.current) return;

      if (!tasksRes.ok) {
        console.warn('DO task overview failed:', tasksData.message || tasksRes.status);
        setWarehouseTasks([]);
        setTaskSummary(null);
        setHomeOperators([]);
      } else {
        applyDoTaskOverviewPayload(tasksData);
      }

      if (
        (!tasksRes.ok || !(Array.isArray(tasksData.operators) && tasksData.operators.length)) &&
        !(Array.isArray(tasksData.warehouses) && tasksData.warehouses.some((w) => (w.operators || []).length)) &&
        operatorsRes.ok &&
        Array.isArray(operatorsData.operators) &&
        operatorsData.operators.length
      ) {
        setHomeOperators(
          operatorsData.operators.map((op) => ({
            id: op.id,
            name: op.name || op.full_name || (op.email ? String(op.email).split('@')[0] : 'DO'),
            email: op.email || null,
            phone_no: op.phone_no || null,
            warehouse_name: op.warehouse_name || 'Unassigned',
            chamber_limit: op.chamber_limit,
            completed: 0,
            pending: 0,
            overdue: 0,
            morning_completed: 0,
            morning_expected: 0,
            evening_completed: 0,
            evening_expected: 0
          }))
        );
      }

      if (
        (!tasksRes.ok || !(Array.isArray(tasksData.warehouses) && tasksData.warehouses.length)) &&
        filterRes.ok
      ) {
        const filterWarehouses = Array.isArray(filterData?.warehouses) ? filterData.warehouses : [];
        if (filterWarehouses.length) {
          setWarehouseTasks(
            filterWarehouses.map((wh) => {
              const whName = wh.name || wh.warehouse_name || 'Unassigned';
              return {
                warehouse_name: whName,
                do_names: 'No DO',
                operators: [],
                assignment_count:
                  Number(wh.client_count) || (Array.isArray(wh.clients) ? wh.clients.length : 0),
                completed: 0,
                pending: 0,
                overdue: 0,
                expected_today: 0,
                morning_completed: 0,
                morning_expected: 0,
                evening_completed: 0,
                evening_expected: 0
              };
            })
          );
        }
      }

      if (requestId !== homeOverviewRequestIdRef.current) return;

      const customersData = await customersRes.json().catch(() => ({}));
      if (!customersRes.ok) {
        console.warn('Customers fetch failed:', customersData.message || customersRes.status);
        setHomeCustomers([]);
      } else {
        const list = Array.isArray(customersData.customers)
          ? customersData.customers
          : Array.isArray(customersData)
            ? customersData
            : [];
        setHomeCustomers(
          list.map((row) => ({
            id: row.id,
            full_name: row.full_name || null,
            email: row.email || null,
            phone_no: row.phone_no || null,
            allowed_clients: row.allowed_clients || null,
            allowed_warehouses: row.allowed_warehouses || null
          }))
        );
      }

      const whMasterData = await whMasterRes.json().catch(() => ({}));
      if (!whMasterRes.ok) {
        console.warn('Warehouse catalog failed:', whMasterData.message || whMasterRes.status);
        setHomeCatalogWarehouses([]);
      } else {
        setHomeCatalogWarehouses(parseMasterList(whMasterData));
      }

      const clMasterData = await clMasterRes.json().catch(() => ({}));
      if (!clMasterRes.ok) {
        console.warn('Client catalog failed:', clMasterData.message || clMasterRes.status);
        setHomeCatalogClients([]);
      } else {
        setHomeCatalogClients(parseMasterList(clMasterData));
      }
      setHomeLastUpdated(formatClockTime(new Date()));
    } catch (err) {
      if (requestId !== homeOverviewRequestIdRef.current) return;
      setHomeError(formatUserError(err, { apiUrl, context: 'Failed to load overview' }));
      setTodayLogs([]);
      setStats(null);
      setWarehouseTasks([]);
      setHomeOperators([]);
      setHomeCustomers([]);
      setHomeCatalogWarehouses([]);
      setHomeCatalogClients([]);
      setTaskSummary(null);
    } finally {
      setHomeLoading(false);
      setHomeRefreshing(false);
    }
  }, [apiUrl, token, authHeaders, formatClockTime, applyDoTaskOverviewPayload]);


  const loadHomeOverviewRef = useRef(loadHomeOverview);
  loadHomeOverviewRef.current = loadHomeOverview;
  // Handle Android system back button presses
  useEffect(() => {
    const backAction = () => {
      if (showDrawer) {
        closeDrawer();
        return true;
      }
      if (denyModal.visible) {
        setDenyModal({ visible: false, id: null, remark: '' });
        return true;
      }
      if (showNotifications) {
        setShowNotifications(false);
        return true;
      }
      if (selectedDoProfile) {
        setSelectedDoProfile(null);
        return true;
      }
      if (selectedLog) {
        setSelectedLog(null);
        return true;
      }
      if (selectedReport) {
        setSelectedReport(null);
        return true;
      }
      if (customerModal.visible) {
        if (customerModal.busy) return true;
        setCustomerModal({ visible: false, mode: 'create', busy: false, id: null });
        return true;
      }
      if (catalogModal.visible) {
        if (catalogModal.busy) return true;
        setCatalogModal({ visible: false, kind: 'warehouse', mode: 'create', busy: false, id: null });
        return true;
      }
      if (showCalendarModal) {
        setShowCalendarModal(false);
        return true;
      }
      if (activeTab !== 'Dashboard') {
        setActiveTab('Dashboard');
        return true;
      }
      return false;
    };

    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => backHandler.remove();
  }, [showDrawer, closeDrawer, showNotifications, selectedDoProfile, selectedLog, selectedReport, showCalendarModal, activeTab, denyModal.visible, customerModal.visible, customerModal.busy, catalogModal.visible, catalogModal.busy]);

  const loadLogFilterScope = useCallback(async () => {
    if (!apiUrl || !token) return;
    try {
      const [filterRes, assignRes, chamberRes] = await Promise.all([
        fetch(`${apiUrl}/api/dashboard/inventory-filter-options`, { headers: authHeaders }),
        fetch(`${apiUrl}/api/chambers/assignments`, { headers: authHeaders }),
        fetch(`${apiUrl}/api/chambers`, { headers: authHeaders })
      ]);
      const filterData = await filterRes.json().catch(() => ({}));
      const assignData = await assignRes.json().catch(() => ({}));
      const chamberData = await chamberRes.json().catch(() => ({}));
      const chamberRows = Array.isArray(chamberData?.data) ? chamberData.data : [];
      const chamberWarehouseById = new Map();
      chamberRows.forEach((c) => {
        if (c?.id == null) return;
        const wh = String(c.warehouse_name || '').trim();
        if (wh) chamberWarehouseById.set(String(c.id), wh);
      });

      // Case-insensitive maps: key = lower(wh), value holds display name + data
      const whMeta = {}; // lower -> { name, clients:Set, chambers: { chamberName: Set } }

      const ensureWh = (rawName) => {
        const name = String(rawName || '').trim();
        if (!name) return null;
        const key = name.toLowerCase();
        if (!whMeta[key]) {
          whMeta[key] = { name, clients: new Set(), chambers: {} };
        }
        return whMeta[key];
      };

      const filterWh = Array.isArray(filterData?.warehouses) ? filterData.warehouses : [];
      filterWh.forEach((w) => {
        const bucket = ensureWh(w.name || w.warehouse_name);
        if (!bucket) return;
        (Array.isArray(w.clients) ? w.clients : []).forEach((c) => {
          const cl = String(c || '').trim();
          if (cl) bucket.clients.add(cl);
        });
      });

      const assigns = Array.isArray(assignData?.data)
        ? assignData.data
        : Array.isArray(assignData)
          ? assignData
          : [];
      assigns.forEach((a) => {
        const whRaw =
          String(a.warehouse_name || '').trim() ||
          chamberWarehouseById.get(String(a.chamber_id)) ||
          '';
        const bucket = ensureWh(whRaw);
        if (!bucket) return;
        const chamber = String(a.chamber_name || '').trim();
        const client = String(a.client_name || '').trim();
        const status = String(a.status || 'active').toLowerCase();
        // Include inactive for filter lists too (still useful), but prefer active in UI chips
        if (chamber) {
          if (!bucket.chambers[chamber]) bucket.chambers[chamber] = new Set();
          if (client && status !== 'inactive') bucket.chambers[chamber].add(client);
          if (client && status === 'inactive' && bucket.chambers[chamber].size === 0) {
            // keep chamber visible even if only inactive clients
            bucket.chambers[chamber].add(client);
          }
        }
        if (client) bucket.clients.add(client);
      });

      const warehouses = Object.values(whMeta)
        .map((b) => b.name)
        .sort((a, b) => a.localeCompare(b));

      const warehouseClients = {};
      const warehouseChambersList = {};
      Object.values(whMeta).forEach((b) => {
        warehouseClients[b.name] = Array.from(b.clients).sort((a, c) => a.localeCompare(c));
        warehouseChambersList[b.name] = Object.keys(b.chambers)
          .sort((a, c) => a.localeCompare(c, undefined, { numeric: true }))
          .map((chamberName) => ({
            name: chamberName,
            clients: Array.from(b.chambers[chamberName]).sort((a, c) => a.localeCompare(c))
          }));
      });

      setLogFilterScope({
        warehouses,
        warehouseClients,
        warehouseChambers: warehouseChambersList,
        _byLower: whMeta
      });
      setWarehouses(warehouses);
    } catch (_) {
      // keep existing scope
    }
  }, [apiUrl, token, authHeaders]);

  const resolveScopeWarehouseKey = useCallback(
    (whName) => {
      const raw = String(whName || '').trim();
      if (!raw || raw === 'All') return null;
      if (logFilterScope.warehouseClients?.[raw]) return raw;
      if (logFilterScope.warehouseChambers?.[raw]) return raw;
      const lower = raw.toLowerCase();
      const hit = (logFilterScope.warehouses || []).find((w) => w.toLowerCase() === lower);
      if (hit) return hit;
      const fromMeta = logFilterScope._byLower?.[lower]?.name;
      return fromMeta || raw;
    },
    [logFilterScope]
  );

  const logsWarehouseSelected = warehouseFilter !== 'All';

  const loadLogTaskSummary = useCallback(async () => {
    if (!apiUrl || !token || logType !== 'chambers') {
      setLogTaskSummary(null);
      return;
    }
    let from = dateFrom;
    let to = dateTo;
    if (from === 'All' || to === 'All') {
      const t = toLocalYmd();
      from = from === 'All' ? t : from;
      to = to === 'All' ? t : to;
    }
    setLogTaskSummaryLoading(true);
    try {
      const qs = new URLSearchParams({
        fromDate: String(from).slice(0, 10),
        toDate: String(to).slice(0, 10)
      });
      const res = await fetch(`${apiUrl}/api/dashboard/do-task-overview?${qs.toString()}`, {
        headers: authHeaders
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || `Task summary failed (${res.status})`);
      }

      let morningDone = Number(data?.summary?.morning_completed) || 0;
      let morningExp = Number(data?.summary?.morning_expected) || 0;
      let eveningDone = Number(data?.summary?.evening_completed) || 0;
      let eveningExp = Number(data?.summary?.evening_expected) || 0;
      let completed = Number(data?.summary?.completed) || 0;
      let expected =
        Number(data?.summary?.expected_today) || morningExp + eveningExp;
      let pending = Number(data?.summary?.pending) || 0;

      if (warehouseFilter && warehouseFilter !== 'All' && Array.isArray(data?.warehouses)) {
        const needle = String(warehouseFilter).trim().toLowerCase();
        const matched = data.warehouses.filter(
          (w) => String(w.warehouse_name || '').trim().toLowerCase() === needle
        );
        morningDone = matched.reduce((s, w) => s + (Number(w.morning_completed) || 0), 0);
        morningExp = matched.reduce((s, w) => s + (Number(w.morning_expected) || 0), 0);
        eveningDone = matched.reduce((s, w) => s + (Number(w.evening_completed) || 0), 0);
        eveningExp = matched.reduce((s, w) => s + (Number(w.evening_expected) || 0), 0);
        completed = matched.reduce((s, w) => s + (Number(w.completed) || 0), 0);
        expected = matched.reduce(
          (s, w) => s + (Number(w.expected_today) || 0),
          0
        );
        pending = matched.reduce((s, w) => s + (Number(w.pending) || 0), 0);
      }

      setLogTaskSummary({
        from,
        to,
        morningDone,
        morningExp,
        eveningDone,
        eveningExp,
        completed,
        expected: expected || morningExp + eveningExp,
        pending
      });
    } catch (err) {
      console.warn('Log task summary failed:', err?.message || err);
      setLogTaskSummary(null);
    } finally {
      setLogTaskSummaryLoading(false);
    }
  }, [apiUrl, token, authHeaders, logType, dateFrom, dateTo, warehouseFilter]);

  const loadLogs = useCallback(async () => {
    if (!apiUrl || !token) return;
    setLogsLoading(true);
    setLogsError('');
    try {
      // Chambers always load as daily chamber-temp data (default today if no range)
      let from = dateFrom;
      let to = dateTo;
      if (logType === 'chambers' && (from === 'All' || to === 'All')) {
        const t = toLocalYmd();
        from = from === 'All' ? t : from;
        to = to === 'All' ? t : to;
      }

      // Local chamber/client filters need a wider page so filters stay accurate
      const hasLocalFilter =
        (chamberFilter && chamberFilter !== 'All') ||
        (clientFilter && clientFilter !== 'All');
      const pageSize = hasLocalFilter ? 100 : DOCK_REPORT_PAGE_SIZE;
      const page = hasLocalFilter ? 1 : logPage;

      const qs = new URLSearchParams({
        page: String(page),
        limit: String(pageSize)
      });
      if (warehouseFilter && warehouseFilter !== 'All') qs.set('warehouse', warehouseFilter);
      if (from && from !== 'All') qs.set('fromDate', from);
      if (to && to !== 'All') qs.set('toDate', to);

      const endpoint =
        logType === 'inward'
          ? '/api/inward-logs'
          : logType === 'outward'
            ? '/api/outward-logs'
            : '/api/chamber-temp';

      const res = await fetch(`${apiUrl}${endpoint}?${qs.toString()}`, {
        headers: authHeaders
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || `Failed to load logs (${res.status})`);
      }
      let items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      items = items.map((row) => normalizeLogRow(row, logType));

      if (chamberFilter && chamberFilter !== 'All') {
        const needle = chamberFilter.trim().toLowerCase();
        items = items.filter(
          (r) => String(r.chamber_name || '').trim().toLowerCase() === needle
        );
      }

      if (clientFilter && clientFilter !== 'All') {
        const needle = clientFilter.trim().toLowerCase();
        items = items.filter((r) => String(r.client_name || '').trim().toLowerCase() === needle);
      }

      // Sort chambers daily data: date desc, then chamber, then shift
      if (logType === 'chambers') {
        items.sort((a, b) => {
          const da = String(a.formatted_date || a.entry_date || '').slice(0, 10);
          const db = String(b.formatted_date || b.entry_date || '').slice(0, 10);
          if (da !== db) return db.localeCompare(da);
          const ca = String(a.chamber_name || '').localeCompare(String(b.chamber_name || ''), undefined, {
            numeric: true
          });
          if (ca !== 0) return ca;
          const sa = String(a.shift || '');
          const sb = String(b.shift || '');
          if (sa === sb) return String(a.client_name || '').localeCompare(String(b.client_name || ''));
          if (sa === 'Morning') return -1;
          if (sb === 'Morning') return 1;
          return sa.localeCompare(sb);
        });
      }

      if (!logFilterScope.warehouses.length) {
      const whSet = new Set();
      const clSet = new Set();
      items.forEach((r) => {
        if (r.warehouse_name) whSet.add(String(r.warehouse_name).trim());
        if (r.client_name) clSet.add(String(r.client_name).trim());
      });
      setWarehouses(Array.from(whSet).sort((a, b) => a.localeCompare(b)));
      setClients(Array.from(clSet).sort((a, b) => a.localeCompare(b)));
      } else if (warehouseFilter && warehouseFilter !== 'All') {
        // Merge clients seen in current logs into scope (fallback if assignments sparse)
        const clFromLogs = new Set();
        items.forEach((r) => {
          const wh = String(r.warehouse_name || '').trim().toLowerCase();
          if (wh === warehouseFilter.trim().toLowerCase() && r.client_name) {
            clFromLogs.add(String(r.client_name).trim());
          }
        });
        if (clFromLogs.size) {
          setLogFilterScope((prev) => {
            const whKey =
              (prev.warehouses || []).find(
                (w) => w.toLowerCase() === warehouseFilter.trim().toLowerCase()
              ) || warehouseFilter;
            const existing = prev.warehouseClients?.[whKey] || [];
            const merged = Array.from(new Set([...existing, ...clFromLogs])).sort((a, b) =>
              a.localeCompare(b)
            );
            if (merged.length === existing.length) return prev;
            return {
              ...prev,
              warehouseClients: { ...prev.warehouseClients, [whKey]: merged }
            };
          });
        }
      }
      const total = Number(data?.total ?? data?.pagination?.total ?? items.length) || items.length;
      setLogs(items);
      setLogTotal(hasLocalFilter ? items.length : total);
      setLogHasMore(hasLocalFilter ? false : page * pageSize < total);
    } catch (err) {
      setLogs([]);
      setLogTotal(0);
      setLogHasMore(false);
      setLogsError(formatUserError(err, { apiUrl, context: 'Failed to load logs' }));
    } finally {
      setLogsLoading(false);
      setLogsRefreshing(false);
    }
  }, [
    apiUrl,
    token,
    authHeaders,
    warehouseFilter,
    chamberFilter,
    clientFilter,
    dateFrom,
    dateTo,
    logType,
    logPage,
    logFilterScope.warehouses.length
  ]);

  const goLogPrevPage = useCallback(() => {
    setLogPage((p) => Math.max(1, p - 1));
  }, []);

  const goLogNextPage = useCallback(() => {
    if (logHasMore) setLogPage((p) => p + 1);
  }, [logHasMore]);

  const loadReports = useCallback(async (mode = 'reset') => {
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
        warehouse: reportWarehouseFilter,
        client: reportClientFilter,
        view: reportView
      });

      const fetches = [
        fetch(`${apiUrl}/api/dashboard/inventory-reconciliation?${qs.toString()}`, {
          headers: authHeaders
        })
      ];
      if (reset) {
        fetches.push(
          fetch(`${apiUrl}/api/dashboard/inventory-filter-options`, { headers: authHeaders })
        );
      }

      const [reconRes, filterRes] = await Promise.all(fetches);
      const data = await reconRes.json().catch(() => ({}));
      if (!reconRes.ok) {
        throw new Error(data.message || data.error || `Failed to load inventory (${reconRes.status})`);
      }

      const { rows, total } = parseInventoryReconciliationPayload(data);

      if (reset && filterRes) {
        const filterData = await filterRes.json().catch(() => ({}));
      const whSet = new Set();
      const clientSet = new Set();
        const warehouseClientsMap = {};
        const addToMap = (whName, clientName) => {
          const wh = String(whName || '').trim();
          const cl = String(clientName || '').trim();
          if (!wh || !cl) return;
          if (!warehouseClientsMap[wh]) warehouseClientsMap[wh] = new Set();
          warehouseClientsMap[wh].add(cl);
        };
      rows.forEach((r) => {
        if (r.warehouse_name) whSet.add(String(r.warehouse_name).trim());
        if (r.client_name) clientSet.add(String(r.client_name).trim());
          addToMap(r.warehouse_name, r.client_name);
        });
        const filterWarehouses = Array.isArray(filterData?.warehouses) ? filterData.warehouses : [];
        filterWarehouses.forEach((w) => {
          const whName = w?.name || w?.warehouse_name;
          if (whName) whSet.add(String(whName).trim());
          if (Array.isArray(w?.clients)) {
            w.clients.forEach((c) => {
              const cl = String(c || '').trim();
              if (cl) clientSet.add(cl);
              addToMap(whName, cl);
            });
          }
      });
      setReportWarehouses(Array.from(whSet).sort((a, b) => a.localeCompare(b)));
      setReportClients(Array.from(clientSet).sort((a, b) => a.localeCompare(b)));
        const normalizedMap = {};
        Object.keys(warehouseClientsMap).forEach((wh) => {
          normalizedMap[wh] = Array.from(warehouseClientsMap[wh] || [])
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b));
        });
        setReportWarehouseClientsMap(normalizedMap);
      }

      reportOffsetRef.current = offset + rows.length;
      const more = inventoryReportHasMore(offset, rows.length, total) || !!data.has_more;
      reportHasMoreRef.current = more;
      setReportHasMore(more);
      setReportRows((prev) => {
        const next = reset ? rows : [...prev, ...rows];
        reportRowsRef.current = next;
        return next;
      });
      if (reset) {
        setReportsFromCache(false);
        setReportsError('');
        const stamp = formatClockTime(new Date());
        setReportsLastUpdated(stamp);
        AsyncStorage.setItem(
          REPORTS_CACHE_KEY,
          JSON.stringify({
            at: Date.now(),
            stamp,
            rows,
            warehouses: null,
            clients: null
          })
        ).catch(() => {});
      }
    } catch (err) {
      const msg = err.message || 'Failed to load inventory reports.';
      setReportsError(msg);
      if (reset) {
        const keepLive = reportRowsRef.current.length > 0;
        if (keepLive) {
          setReportsFromCache(true);
        } else {
          try {
            const raw = await AsyncStorage.getItem(REPORTS_CACHE_KEY);
            const cached = raw ? JSON.parse(raw) : null;
            if (Array.isArray(cached?.rows) && cached.rows.length) {
              setReportRows(cached.rows);
              reportRowsRef.current = cached.rows;
              setReportsFromCache(true);
              setReportsLastUpdated(cached.stamp || formatClockTime(new Date(cached.at || Date.now())));
              reportHasMoreRef.current = false;
              setReportHasMore(false);
            } else {
      setReportRows([]);
              reportRowsRef.current = [];
              reportHasMoreRef.current = false;
              setReportHasMore(false);
              reportOffsetRef.current = 0;
            }
          } catch (_) {
            setReportRows([]);
            reportRowsRef.current = [];
            reportHasMoreRef.current = false;
            setReportHasMore(false);
            reportOffsetRef.current = 0;
          }
        }
      }
    } finally {
      setReportsLoading(false);
      setReportsRefreshing(false);
      setReportsLoadingMore(false);
      reportsLoadingMoreRef.current = false;
    }
  }, [
    apiUrl,
    token,
    authHeaders,
    reportWarehouseFilter,
    reportClientFilter,
    reportView,
    formatClockTime
  ]);

  const filteredReportRows = useMemo(() => {
    let rows = reportRows;
    rows = dedupeInventoryLots(rows);
    return [...rows].sort((a, b) => {
      // LIFO: newest audit first on Reports list (before click)
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
  }, [reportRows]);

  useEffect(() => {
    if (activeTab === 'Dashboard' || activeTab === 'Home') {
      loadHomeOverviewRef.current();
    }
  }, [activeTab]);

  useEffect(() => {
    setLogPage(1);
  }, [warehouseFilter, chamberFilter, clientFilter, dateFrom, dateTo, logType]);

  useEffect(() => {
    if (activeTab === 'Logs') {
      loadLogFilterScope();
      loadLogs();
      loadLogTaskSummary();
    }
  }, [activeTab, loadLogFilterScope, loadLogs, loadLogTaskSummary]);

  useEffect(() => {
    if (activeTab === 'Reports') loadReports();
  }, [activeTab, loadReports]);

  const loadNotifications = useCallback(async () => {
    if (!apiUrl || !token) return;
    try {
      const res = await fetch(`${apiUrl}/api/permission-requests?_=${Date.now()}`, {
        headers: authHeaders
      });
      if (!res.ok) return;
      const data = await res.json().catch(() => []);
      if (Array.isArray(data)) {
        setNotifications(data);
        setPermissionsUpdatedAt(formatClockTime(new Date()));
      }
    } catch (_) {
      // keep last list if offline
    }
  }, [apiUrl, token, authHeaders, formatClockTime]);

  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      const online =
        !!state.isConnected && state.isInternetReachable !== false;
      setIsOnline(online);
    });
    return () => {
      try {
        unsub();
      } catch (_) {
        /* ignore */
      }
    };
  }, []);

  useEffect(() => {
    if (!apiUrl || !token) return undefined;
    loadNotifications();
    const timer = setInterval(loadNotifications, 15000);
    return () => clearInterval(timer);
  }, [apiUrl, token, loadNotifications]);

  useEffect(() => {
    if (dateFrom === 'All' || dateTo === 'All') return;
    if (dateTo < dateFrom) setDateTo(dateFrom);
  }, [dateFrom, dateTo]);

  const formatNotifTime = (value) => {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      return String(value).replace('T', ' ').slice(0, 16);
    }
    const ymd = toLocalYmd(d);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${ymd} ${hm}`;
  };

  const isRolePermissionNotif = (n) => {
    const type = String(n.record_type || '');
    // Same Scope as Super Admin Role & Permission (skip notify-only noise)
    if (type === 'MasterSetup' || type === 'DO_CHANGE' || type === 'activity') {
      return false;
    }
    return ['Chamber', 'Inward', 'Outward', 'ChamberMaster', 'ChamberType', 'ClientMaster'].includes(type);
  };

  const rolePermissionNotifications = useMemo(
    () => notifications.filter(isRolePermissionNotif),
    [notifications]
  );

  const getNotifMessage = (n) => {
    const msg =
      n.request_description ||
      n.description ||
      n.request_remark ||
      n.remark ||
      '';
    return String(msg)
      .replace(/\s*\(id:\s*\d+\)/gi, '')
      .replace(/Chamber\s*#\s*\d+/gi, (n.chamber_name || 'Chamber').trim())
      .trim() || 'Role & Permission request';
  };

  const getNotifTitle = (n) => {
    const status = String(n.status || 'Pending');
    const type = String(n.record_type || 'Record');
    const action = /DELETE|delete/i.test(String(n.raw_action || n.description || ''))
      ? 'Delete'
      : 'Edit';
    const chamberLabel = String(n.chamber_name || '').trim();
    const typeLabel =
      (type === 'ChamberMaster' || type === 'Chamber') && chamberLabel
        ? chamberLabel
        : type;
    if (status === 'Pending') return `Role & Permission · ${action} · ${typeLabel}`;
    if (status === 'Approved') return `${action} approved · ${typeLabel}`;
    if (status === 'Denied') return `${action} denied · ${typeLabel}`;
    return `${status} · ${typeLabel}`;
  };

  const filteredNotifications = useMemo(() => {
    let list = [...rolePermissionNotifications];
    if (notifFilter === 'pending') {
      list = list.filter((n) => n.status === 'Pending');
    } else if (notifFilter === 'decided') {
      list = list.filter((n) => n.status === 'Approved' || n.status === 'Denied');
    }
    // Pending first, then newest
    list.sort((a, b) => {
      const ap = a.status === 'Pending' ? 0 : 1;
      const bp = b.status === 'Pending' ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return (Number(b.id) || 0) - (Number(a.id) || 0);
    });
    return list.slice(0, 80);
  }, [rolePermissionNotifications, notifFilter]);

  const pendingNotifCount = useMemo(
    () => rolePermissionNotifications.filter((n) => n.status === 'Pending').length,
    [rolePermissionNotifications]
  );

  // Bell badge = only actionable pending items (matches default "pending" tab).
  // Empty pending list → no number on the bell.
  const unreadNotifCount = useMemo(() => {
    const count = Number(pendingNotifCount) || 0;
    return count > 0 ? count : 0;
  }, [pendingNotifCount]);

  const respondToPermissionRequest = async (notifId, status, remark = '') => {
    if (!notifId || !apiUrl || !token || notifActionBusy) return;
    const note = String(remark || '').trim();
    if (status === 'Denied' && !note) {
      Alert.alert('Remark required', 'Please enter a reason for denying this request.');
      return;
    }
    setNotifActionBusy(`${notifId}-${status}`);
    try {
      const res = await fetch(`${apiUrl}/api/permission-requests/${notifId}`, {
        method: 'PUT',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          status,
          ...(note ? { remark: note } : {})
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || `Failed to ${status.toLowerCase()}`);
      }
      await loadNotifications();
      showSavedChanges(
        status === 'Approved' ? 'Permission approved' : 'Permission denied',
        status === 'Approved'
          ? 'Request approved. Changes are saved.'
          : 'Request denied. Your remark was sent to the DO.'
      );
    } catch (err) {
      Alert.alert('Request update failed', err.message || 'Please try again.');
    } finally {
      setNotifActionBusy(null);
    }
  };

  const openDenyPermission = (notifId) => {
    if (!notifId || notifActionBusy) return;
    setDenyModal({ visible: true, id: notifId, remark: '' });
  };

  const confirmDenyPermission = async () => {
    const id = denyModal.id;
    const remark = String(denyModal.remark || '').trim();
    if (!remark) {
      Alert.alert('Remark required', 'Please enter a reason for denying this request.');
      return;
    }
    setDenyModal({ visible: false, id: null, remark: '' });
    await respondToPermissionRequest(id, 'Denied', remark);
  };

  const openNotifications = () => {
    setShowNotifications(true);
    setNotifFilter('pending');
    loadNotifications();
    const decidedIds = rolePermissionNotifications
      .filter((n) => n.status === 'Approved' || n.status === 'Denied')
      .map((n) => Number(n.id))
      .filter((id) => Number.isFinite(id));
    if (decidedIds.length) {
      setSeenNotifIds((prev) => Array.from(new Set([...prev, ...decidedIds])));
    }
  };

  const handleLogoutPress = () => {
    if (busy) return;
    Alert.alert('Logout', 'Do you want to end this session and go to login?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            // Session first — don't block on push cleanup
            const done = onLogout?.();
            clearSubAdminPushToken({ apiUrl, token }).catch(() => {});
            resetSubAdminPushAlerts();
            await done;
          } finally {
            setBusy(false);
          }
        }
      }
    ]);
  };

  const overviewCards = useMemo(() => {
    const t = taskSummary || {};
    const customerTotal = homeCustomers.length || Number(t.customers) || 0;
    const warehouseTotal =
      homeCatalogWarehouses.filter(isCatalogActive).length ||
      Number(t.warehouses) ||
      warehouseTasks.length ||
      0;
    return [
      {
        key: 'warehouses',
        label: 'Warehouses',
        value: warehouseTotal,
        icon: 'business-outline',
        color: '#0284c7'
      },
      {
        key: 'customers',
        label: 'Customers',
        value: customerTotal,
        icon: 'briefcase-outline',
        color: '#059669'
      },
      {
        key: 'ops',
        label: 'DOs',
        value: homeOperators.length || Number(t.operators) || 0,
        icon: 'people-outline',
        color: '#003580'
      }
    ];
  }, [taskSummary, warehouseTasks, homeCustomers, homeOperators, homeCatalogWarehouses]);

  const homeListTitle = useMemo(() => {
    if (homeListFocus === 'warehouses') return 'Warehouses';
    if (homeListFocus === 'customers') return 'Customers';
    return 'Data Operators';
  }, [homeListFocus]);

  const homeListSubtitle = useMemo(() => {
    if (homeListFocus === 'warehouses') {
      return 'Tap a row to edit · add / delete';
    }
    if (homeListFocus === 'customers') {
      return 'Portal logins · tap to edit · add / delete';
    }
    return "Today's tasks · Morning & Evening";
  }, [homeListFocus]);

  const activeCatalogWarehouses = useMemo(
    () => (homeCatalogWarehouses || []).filter(isCatalogActive),
    [homeCatalogWarehouses]
  );

  const dashboardWarehouseRows = useMemo(() => {
    const keyOf = (n) => String(n || '').trim().toLowerCase();
    const taskMap = new Map();
    (warehouseTasks || []).forEach((wh) => {
      const k = keyOf(wh.warehouse_name);
      if (k) taskMap.set(k, wh);
    });
    const seen = new Set();
    const rows = [];
    (homeCatalogWarehouses || []).forEach((cat) => {
      if (!isCatalogActive(cat)) return;
      const k = keyOf(cat.warehouse_name);
      if (k) seen.add(k);
      const task = (k && taskMap.get(k)) || {};
      rows.push({
        warehouse_name: cat.warehouse_name,
        catalog_id: cat.id,
        warehouse_code: cat.warehouse_code || null,
        city: cat.city || null,
        operators: task.operators || [],
        assignment_count: task.assignment_count || 0,
        morning_completed: Number(task.morning_completed) || 0,
        morning_expected: Number(task.morning_expected) || 0,
        evening_completed: Number(task.evening_completed) || 0,
        evening_expected: Number(task.evening_expected) || 0,
        overdue: Number(task.overdue) || 0,
        pending: Number(task.pending) || 0
      });
    });
    (warehouseTasks || []).forEach((wh) => {
      const k = keyOf(wh.warehouse_name);
      if (!k || seen.has(k)) return;
      rows.push({
        ...wh,
        catalog_id: null,
        warehouse_code: wh.warehouse_code || null,
        city: null
      });
    });
    return rows;
  }, [homeCatalogWarehouses, warehouseTasks]);

  const todayOps = useMemo(() => {
    const t = taskSummary || {};
    return {
      completed: Number(t.completed) || 0,
      pending: Number(t.pending) || 0,
      overdue: Number(t.overdue) || 0,
      morningDone: Number(t.morning_completed) || 0,
      morningExpected: Number(t.morning_expected) || 0,
      eveningDone: Number(t.evening_completed) || 0,
      eveningExpected: Number(t.evening_expected) || 0,
      totalInward: Number(t.total_inward) || 0,
      totalOutward: Number(t.total_outward) || 0,
      todayInward: Number(t.today_inward) || 0,
      todayOutward: Number(t.today_outward) || 0
    };
  }, [taskSummary]);

  const todayLabel = useMemo(() => {
    try {
      return new Date().toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      });
    } catch (_) {
      return toLocalYmd();
    }
  }, []);

  const logDatePreset = useMemo(() => {
    const today = toLocalYmd();
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 6);
    const sevenFrom = toLocalYmd(start);
    const sevenTo = toLocalYmd(end);
    const from = dateFrom === 'All' ? today : dateFrom;
    const to = dateTo === 'All' ? today : dateTo;
    if (from === today && to === today) return 'today';
    if (from === sevenFrom && to === sevenTo) return '7days';
    return null;
  }, [dateFrom, dateTo]);

  const openAdminSection = useCallback((section, permFilter = 'pending') => {
    setAdminInitialSection(section);
    if (section === 'permissions') setAdminPermFilter(permFilter);
    setActiveTab('Admin');
    setShowNotifications(false);
  }, []);

  useEffect(() => {
    initSubAdminPushAlerts();
  }, []);

  useEffect(() => {
    const unsub = subscribeSubAdminPushTokenRefresh({ apiUrl, token });
    return () => {
      try {
        unsub?.();
      } catch (_) {
        /* ignore */
      }
    };
  }, [apiUrl, token]);

  useEffect(() => {
    const unsub = subscribePermissionNotificationOpen(() => {
      openAdminSection('permissions', 'pending');
      loadNotifications();
    });
    return () => {
      try {
        unsub?.();
      } catch (_) {
        /* ignore */
      }
    };
  }, [openAdminSection, loadNotifications]);

  useEffect(() => {
    notifySubAdminIfNeeded({
      pendingPermissions: pendingNotifCount
    });
  }, [pendingNotifCount]);

  const openLogsToday = useCallback(() => {
    const today = toLocalYmd();
    setLogPage(1);
    setLogType('chambers');
    applyDateRange(today, today);
    setWarehouseFilter('All');
    setChamberFilter('All');
    setClientFilter('All');
    setActiveTab('Logs');
  }, []);

  const derivedHomeOperators = useMemo(() => {
    if (homeOperators.length) return homeOperators;
    const flat = [];
    warehouseTasks.forEach((w) => {
      (w.operators || []).forEach((op) => {
        flat.push({
          ...op,
          warehouse_name: w.warehouse_name,
          completed: w.completed,
          pending: w.pending,
          overdue: w.overdue,
          morning_completed: w.morning_completed,
          morning_expected: w.morning_expected,
          morning_pending: w.morning_pending,
          evening_completed: w.evening_completed,
          evening_expected: w.evening_expected,
          evening_pending: w.evening_pending
        });
      });
    });
    return flat;
  }, [homeOperators, warehouseTasks]);

  const formatScopeList = (value) => {
    if (value == null || String(value).trim() === '') return 'All';
    const parts = String(value)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return 'All';
    if (parts.length <= 2) return parts.join(', ');
    return `${parts.slice(0, 2).join(', ')} +${parts.length - 2}`;
  };

  const splitCsv = (value) =>
    String(value || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const csvHas = (csv, name) => {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return false;
    return splitCsv(csv).some((s) => s.toLowerCase() === n);
  };

  const toggleCsvValue = (current, name) => {
    const label = String(name || '').trim();
    if (!label) return String(current || '');
    const parts = splitCsv(current);
    const key = label.toLowerCase();
    const exists = parts.some((s) => s.toLowerCase() === key);
    if (exists) return parts.filter((s) => s.toLowerCase() !== key).join(',');
    return [...parts, label].join(',');
  };

  const customerScopeWarehouses = useMemo(() => {
    const names = new Set();
    (homeCatalogWarehouses || []).forEach((w) => {
      if (!isCatalogActive(w)) return;
      const name = String(w.warehouse_name || '').trim();
      if (name) names.add(name);
    });
    (logFilterScope.warehouses || []).forEach((name) => {
      const trimmed = String(name || '').trim();
      if (trimmed && trimmed !== 'All') names.add(trimmed);
    });
    (warehouses || []).forEach((name) => {
      const trimmed = String(name || '').trim();
      if (trimmed && trimmed !== 'All') names.add(trimmed);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [homeCatalogWarehouses, logFilterScope.warehouses, warehouses]);

  const customerClientsByWarehouse = useMemo(() => {
    const map = {};
    const unscoped = new Set();
    const add = (whRaw, clientRaw) => {
      const cl = String(clientRaw || '').trim();
      if (!cl) return;
      const wh = String(whRaw || '').trim();
      if (!wh) {
        unscoped.add(cl);
        return;
      }
      const key = wh.toLowerCase();
      if (!map[key]) map[key] = { name: wh, clients: new Set() };
      map[key].clients.add(cl);
    };
    (homeCatalogClients || []).forEach((c) => {
      if (!isCatalogActive(c)) return;
      add(c.warehouse_name, c.client_name);
    });
    Object.entries(logFilterScope.warehouseClients || {}).forEach(([wh, list]) => {
      (list || []).forEach((cl) => add(wh, cl));
    });
    return { map, unscoped };
  }, [homeCatalogClients, logFilterScope.warehouseClients]);

  const clientsForWarehouseName = useCallback(
    (whName) => {
      const key = String(whName || '').trim().toLowerCase();
      const found = new Set(customerClientsByWarehouse.unscoped || []);
      if (!key) return found;
      Object.entries(customerClientsByWarehouse.map || {}).forEach(([k, bucket]) => {
        if (k === key || k.includes(key) || key.includes(k)) {
          (bucket?.clients || []).forEach((cl) => found.add(cl));
        }
      });
      return found;
    },
    [customerClientsByWarehouse]
  );

  const customerScopeClientGroups = useMemo(() => {
    const selected = splitCsv(customerForm.allowed_warehouses);
    const warehouseNames = selected.length ? selected : customerScopeWarehouses;
    return warehouseNames.map((wh) => ({
      warehouse: wh,
      clients: Array.from(clientsForWarehouseName(wh)).sort((a, b) => a.localeCompare(b))
    }));
  }, [customerForm.allowed_warehouses, customerScopeWarehouses, clientsForWarehouseName]);

  const pruneClientsForWarehouses = useCallback(
    (warehouseCsv, clientCsv) => {
      const selectedClients = splitCsv(clientCsv);
      if (!selectedClients.length) return '';
      const selectedWh = splitCsv(warehouseCsv);
      if (!selectedWh.length) return selectedClients.join(',');
      const allowed = new Set();
      selectedWh.forEach((wh) => {
        clientsForWarehouseName(wh).forEach((cl) => allowed.add(String(cl).toLowerCase()));
      });
      const kept = selectedClients.filter((cl) => allowed.has(cl.toLowerCase()));
      if (!kept.length) return selectedClients.join(',');
      return kept.join(',');
    },
    [clientsForWarehouseName]
  );

  const closeCustomerModal = useCallback(() => {
    setCustomerModal({ visible: false, mode: 'create', busy: false, id: null });
  }, []);

  const openCreateCustomer = useCallback(() => {
    setCustomerForm({
      full_name: '',
      email: '',
      phone_no: '',
      password: '',
      allowed_warehouses: '',
      allowed_clients: ''
    });
    setCustomerModal({ visible: true, mode: 'create', busy: false, id: null });
  }, []);

  const openEditCustomer = useCallback((row) => {
    if (!row?.id) return;
    setCustomerForm({
      full_name: row.full_name || '',
      email: row.email || '',
      phone_no: row.phone_no || '',
      password: '',
      allowed_warehouses: row.allowed_warehouses || '',
      allowed_clients: row.allowed_clients || ''
    });
    setCustomerModal({ visible: true, mode: 'edit', busy: false, id: row.id });
  }, []);

  const saveCustomer = useCallback(async () => {
    const full_name = String(customerForm.full_name || '').trim();
    const email = String(customerForm.email || '').trim().toLowerCase();
    const phone_no = String(customerForm.phone_no || '').trim();
    const password = String(customerForm.password || '').trim();
    const allowed_warehouses = String(customerForm.allowed_warehouses || '').trim() || null;
    const prunedClients = pruneClientsForWarehouses(
      customerForm.allowed_warehouses,
      customerForm.allowed_clients
    );
    const allowed_clients = String(prunedClients || customerForm.allowed_clients || '').trim() || null;

    if (!full_name || !email || !phone_no) {
      Alert.alert('Missing fields', 'Name, email and phone are required.');
      return;
    }
    if (customerModal.mode === 'create' && !password) {
      Alert.alert('Password required', 'Set a login password for this customer.');
      return;
    }
    if (!apiUrl || !token) return;

    setCustomerModal((prev) => ({ ...prev, busy: true }));
    try {
      const body = {
        full_name,
        email,
        phone_no,
        allowed_warehouses,
        allowed_clients
      };
      if (password) body.password = password;

      const url =
        customerModal.mode === 'edit' && customerModal.id
          ? `${apiUrl}/api/customers/${customerModal.id}`
          : `${apiUrl}/api/customers`;
      const method = customerModal.mode === 'edit' ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || `Save failed (${res.status})`);
      }
      closeCustomerModal();
      showSavedChanges(
        customerModal.mode === 'edit' ? 'Customer updated' : 'Customer created',
        data.message || 'Customer account saved.'
      );
      loadHomeOverview();
    } catch (err) {
      Alert.alert('Could not save', formatUserError(err, { apiUrl, context: 'Customer save failed' }));
      setCustomerModal((prev) => ({ ...prev, busy: false }));
    }
  }, [
    apiUrl,
    token,
    authHeaders,
    customerForm,
    customerModal.mode,
    customerModal.id,
    closeCustomerModal,
    showSavedChanges,
    loadHomeOverview,
    pruneClientsForWarehouses
  ]);

  const deleteCustomer = useCallback(
    (row) => {
      if (!row?.id) return;
      Alert.alert(
        'Delete customer',
        `Remove portal login for ${row.full_name || row.email || 'this customer'}? This cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              try {
                const res = await fetch(`${apiUrl}/api/customers/${row.id}`, {
                  method: 'DELETE',
                  headers: authHeaders
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                  throw new Error(data.error || data.message || `Delete failed (${res.status})`);
                }
                if (customerModal.id === row.id) closeCustomerModal();
                showSavedChanges('Customer deleted', data.message || 'Portal account removed.');
                loadHomeOverview();
              } catch (err) {
                Alert.alert(
                  'Could not delete',
                  formatUserError(err, { apiUrl, context: 'Customer delete failed' })
                );
              }
            }
          }
        ]
      );
    },
    [apiUrl, authHeaders, customerModal.id, closeCustomerModal, showSavedChanges, loadHomeOverview]
  );

  const closeCatalogModal = useCallback(() => {
    setCatalogModal({ visible: false, kind: 'warehouse', mode: 'create', busy: false, id: null });
  }, []);

  const openCreateWarehouse = useCallback(() => {
    setSelectedDoProfile(null);
    warehouseCodeManualRef.current = false;
    setWarehouseForm({ warehouse_code: '', warehouse_name: '', city: '' });
    setCatalogModal({ visible: true, kind: 'warehouse', mode: 'create', busy: false, id: null });
  }, []);

  const openEditWarehouse = useCallback((row) => {
    setSelectedDoProfile(null);
    warehouseCodeManualRef.current = true;
    setWarehouseForm({
      warehouse_code:
        row?.warehouse_code ||
        suggestWarehouseCode(row?.warehouse_name, row?.city, []),
      warehouse_name: row?.warehouse_name || '',
      city: row?.city || ''
    });
    setCatalogModal({
      visible: true,
      kind: 'warehouse',
      mode: row?.catalog_id ? 'edit' : 'create',
      busy: false,
      id: row?.catalog_id || null
    });
  }, []);

  const openCreateClient = useCallback(() => {
    setSelectedDoProfile(null);
    clientCodeManualRef.current = false;
    setClientForm({
      client_code: '',
      client_name: '',
      warehouse_name: '',
      warehouse_code: ''
    });
    setCatalogModal({ visible: true, kind: 'client', mode: 'create', busy: false, id: null });
  }, []);

  const openEditClient = useCallback((row) => {
    if (!row?.id) return;
    setSelectedDoProfile(null);
    clientCodeManualRef.current = true;
    setClientForm({
      client_code: row.client_code || '',
      client_name: row.client_name || '',
      warehouse_name: row.warehouse_name || '',
      warehouse_code: row.warehouse_code || ''
    });
    setCatalogModal({ visible: true, kind: 'client', mode: 'edit', busy: false, id: row.id });
  }, []);

  const saveWarehouseCatalog = useCallback(async () => {
    const warehouse_name = String(warehouseForm.warehouse_name || '').trim();
    const city = String(warehouseForm.city || '').trim();
    const existingCodes = (homeCatalogWarehouses || []).map((w) => w.warehouse_code);
    let warehouse_code = String(warehouseForm.warehouse_code || '').trim().toUpperCase();
    if (warehouse_code && !warehouse_code.startsWith('WH-')) {
      warehouse_code = `WH-${warehouse_code}`;
    }
    if (!warehouse_code) {
      warehouse_code = suggestWarehouseCode(warehouse_name, '', existingCodes);
    }
    if (!warehouse_name) {
      Alert.alert('Missing fields', 'Warehouse name is required.');
      return;
    }
    if (catalogModal.mode === 'create' && !warehouse_code) {
      Alert.alert('Missing fields', 'Warehouse code is required (WH-…).');
      return;
    }
    if (!apiUrl || !token) return;

    setCatalogModal((prev) => ({ ...prev, busy: true }));
    try {
      const isEdit = catalogModal.mode === 'edit' && catalogModal.id;
      const url = isEdit
        ? `${apiUrl}/api/masters/warehouses/${catalogModal.id}`
        : `${apiUrl}/api/masters/warehouses`;
      const body = isEdit
        ? { warehouse_name, city: city || null }
        : { warehouse_code, warehouse_name, city: city || null };
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || `Save failed (${res.status})`);
      }
      const saved = data.data || {};
      const nextId = saved.id || catalogModal.id;
      setHomeCatalogWarehouses((prev) => {
        if (isEdit && catalogModal.id) {
          return prev.map((row) =>
            Number(row.id) === Number(catalogModal.id)
              ? { ...row, warehouse_name, city: city || null, is_active: 1 }
              : row
          );
        }
        const row = {
          id: nextId || Date.now(),
          warehouse_code: saved.warehouse_code || warehouse_code,
          warehouse_name,
          city: city || null,
          is_active: 1
        };
        const exists = prev.some((r) => Number(r.id) === Number(row.id));
        return exists ? prev.map((r) => (Number(r.id) === Number(row.id) ? { ...r, ...row } : r)) : [row, ...prev];
      });
      closeCatalogModal();
      showSavedChanges(
        isEdit ? 'Warehouse updated' : 'Warehouse created',
        data.message || 'Warehouse saved.'
      );
      loadHomeOverview();
      loadLogFilterScope();
    } catch (err) {
      Alert.alert('Could not save', formatUserError(err, { apiUrl, context: 'Warehouse save failed' }));
      setCatalogModal((prev) => ({ ...prev, busy: false }));
    }
  }, [
    apiUrl,
    token,
    authHeaders,
    warehouseForm,
    catalogModal.mode,
    catalogModal.id,
    homeCatalogWarehouses,
    closeCatalogModal,
    showSavedChanges,
    loadHomeOverview,
    loadLogFilterScope
  ]);

  const saveClientCatalog = useCallback(async () => {
    const client_name = String(clientForm.client_name || '').trim();
    const warehouse_name = String(clientForm.warehouse_name || '').trim();
    const warehouse_code = String(clientForm.warehouse_code || '').trim();
    let client_code = String(clientForm.client_code || '').trim().toUpperCase();
    if (!client_code && client_name) {
      client_code = generateClientCode(client_name, warehouse_name, warehouse_code);
    }
    if (!client_name) {
      Alert.alert('Missing fields', 'Client name is required.');
      return;
    }
    if (!apiUrl || !token) return;

    setCatalogModal((prev) => ({ ...prev, busy: true }));
    try {
      const isEdit = catalogModal.mode === 'edit' && catalogModal.id;
      const url = isEdit
        ? `${apiUrl}/api/masters/clients/${catalogModal.id}`
        : `${apiUrl}/api/masters/clients`;
      const body = isEdit
        ? { client_name, warehouse_name: warehouse_name || null }
        : {
            client_code: client_code || undefined,
            client_name,
            warehouse_name: warehouse_name || null,
            warehouse_code: warehouse_code || undefined
          };
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || `Save failed (${res.status})`);
      }
      const saved = data.data || {};
      const nextId = saved.id || catalogModal.id;
      setHomeCatalogClients((prev) => {
        if (isEdit && catalogModal.id) {
          return prev.map((row) =>
            Number(row.id) === Number(catalogModal.id)
              ? {
                  ...row,
                  client_name,
                  warehouse_name: warehouse_name || null,
                  warehouse_code: warehouse_code || row.warehouse_code || null,
                  is_active: 1
                }
              : row
          );
        }
        const row = {
          id: nextId || Date.now(),
          client_code: saved.client_code || data.client_code || client_code,
          client_name,
          warehouse_name: warehouse_name || null,
          warehouse_code: warehouse_code || null,
          is_active: 1
        };
        const exists = prev.some((r) => Number(r.id) === Number(row.id));
        return exists ? prev.map((r) => (Number(r.id) === Number(row.id) ? { ...r, ...row } : r)) : [row, ...prev];
      });
      closeCatalogModal();
      showSavedChanges(isEdit ? 'Client updated' : 'Client created', data.message || 'Client saved.');
      loadHomeOverview();
      loadLogFilterScope();
    } catch (err) {
      Alert.alert('Could not save', formatUserError(err, { apiUrl, context: 'Client save failed' }));
      setCatalogModal((prev) => ({ ...prev, busy: false }));
    }
  }, [
    apiUrl,
    token,
    authHeaders,
    clientForm,
    catalogModal.mode,
    catalogModal.id,
    closeCatalogModal,
    showSavedChanges,
    loadHomeOverview,
    loadLogFilterScope
  ]);

  const saveCatalogRecord = useCallback(() => {
    if (catalogModal.kind === 'client') return saveClientCatalog();
    return saveWarehouseCatalog();
  }, [catalogModal.kind, saveClientCatalog, saveWarehouseCatalog]);

  const deleteWarehouseCatalog = useCallback(
    (row) => {
      if (!row?.catalog_id) {
        Alert.alert('Not in catalog', 'Add this warehouse to the catalog before deleting it.');
        return;
      }
      Alert.alert(
        'Delete warehouse',
        `Deactivate ${row.warehouse_name || 'this warehouse'}? Existing logs stay; it is hidden from new work.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              try {
                const res = await fetch(`${apiUrl}/api/masters/warehouses/${row.catalog_id}`, {
                  method: 'DELETE',
                  headers: authHeaders
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                  throw new Error(data.error || data.message || `Delete failed (${res.status})`);
                }
                if (catalogModal.id === row.catalog_id) closeCatalogModal();
                setHomeCatalogWarehouses((prev) =>
                  prev.map((item) =>
                    Number(item.id) === Number(row.catalog_id) ? { ...item, is_active: 0 } : item
                  )
                );
                showSavedChanges('Warehouse deleted', data.message || 'Warehouse deactivated.');
                loadHomeOverview();
                loadLogFilterScope();
              } catch (err) {
                Alert.alert(
                  'Could not delete',
                  formatUserError(err, { apiUrl, context: 'Warehouse delete failed' })
                );
              }
            }
          }
        ]
      );
    },
    [apiUrl, authHeaders, catalogModal.id, closeCatalogModal, showSavedChanges, loadHomeOverview, loadLogFilterScope]
  );

  const deleteClientCatalog = useCallback(
    (row) => {
      if (!row?.id) return;
      Alert.alert(
        'Delete client',
        `Deactivate ${row.client_name || 'this client'}? Existing logs stay; it is hidden from new work.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              try {
                const res = await fetch(`${apiUrl}/api/masters/clients/${row.id}`, {
                  method: 'DELETE',
                  headers: authHeaders
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                  throw new Error(data.error || data.message || `Delete failed (${res.status})`);
                }
                if (catalogModal.id === row.id) closeCatalogModal();
                setHomeCatalogClients((prev) =>
                  prev.map((item) =>
                    Number(item.id) === Number(row.id) ? { ...item, is_active: 0 } : item
                  )
                );
                showSavedChanges('Client deleted', data.message || 'Client deactivated.');
                loadHomeOverview();
                loadLogFilterScope();
              } catch (err) {
                Alert.alert(
                  'Could not delete',
                  formatUserError(err, { apiUrl, context: 'Client delete failed' })
                );
              }
            }
          }
        ]
      );
    },
    [apiUrl, authHeaders, catalogModal.id, closeCatalogModal, showSavedChanges, loadHomeOverview, loadLogFilterScope]
  );

  useEffect(() => {
    if (!catalogModal.visible || catalogModal.kind !== 'warehouse' || catalogModal.mode !== 'create') {
      return;
    }
    if (warehouseCodeManualRef.current) return;
    const existingCodes = (homeCatalogWarehouses || []).map((w) => w.warehouse_code);
    const next = suggestWarehouseCode(
      warehouseForm.warehouse_name,
      '',
      existingCodes
    );
    if (next !== warehouseForm.warehouse_code) {
      setWarehouseForm((p) => ({ ...p, warehouse_code: next }));
    }
  }, [
    catalogModal.visible,
    catalogModal.kind,
    catalogModal.mode,
    warehouseForm.warehouse_name,
    warehouseForm.warehouse_code,
    homeCatalogWarehouses
  ]);

  useEffect(() => {
    if (!catalogModal.visible || catalogModal.kind !== 'client' || catalogModal.mode !== 'create') {
      return;
    }
    if (clientCodeManualRef.current) return;
    const next = generateClientCode(
      clientForm.client_name,
      clientForm.warehouse_name,
      clientForm.warehouse_code
    );
    if (next !== clientForm.client_code) {
      setClientForm((p) => ({ ...p, client_code: next }));
    }
  }, [
    catalogModal.visible,
    catalogModal.kind,
    catalogModal.mode,
    clientForm.client_name,
    clientForm.warehouse_name,
    clientForm.warehouse_code,
    clientForm.client_code
  ]);

  const resolveDoProfile = useCallback(
    (op, warehouseHint) => {
      if (!op) return null;
      const email = String(op.email || '').trim().toLowerCase();
      const id = op.id != null ? Number(op.id) : null;
      const fromList =
        homeOperators.find((o) => {
          if (id != null && Number.isFinite(id) && Number(o.id) === id) return true;
          if (email && String(o.email || '').trim().toLowerCase() === email) return true;
          return false;
        }) || null;
      const merged = { ...(fromList || {}), ...op };
      return {
        id: merged.id ?? null,
        name:
          merged.name ||
          merged.full_name ||
          (merged.email ? String(merged.email).split('@')[0] : 'DO'),
        full_name: merged.full_name || merged.name || null,
        email: merged.email || null,
        phone_no: merged.phone_no || null,
        warehouse_name: merged.warehouse_name || warehouseHint || 'Unassigned',
        warehouse_code: merged.warehouse_code || null,
        chamber_limit: merged.chamber_limit != null ? Number(merged.chamber_limit) : null,
        completed: Number(merged.completed) || 0,
        pending: Number(merged.pending) || 0,
        overdue: Number(merged.overdue) || 0,
        morning_completed: Number(merged.morning_completed) || 0,
        morning_expected: Number(merged.morning_expected) || 0,
        morning_pending: Number(merged.morning_pending) || 0,
        evening_completed: Number(merged.evening_completed) || 0,
        evening_expected: Number(merged.evening_expected) || 0,
        evening_pending: Number(merged.evening_pending) || 0,
        total_inward: Number(merged.total_inward) || 0,
        total_outward: Number(merged.total_outward) || 0,
        today_inward: Number(merged.today_inward) || 0,
        today_outward: Number(merged.today_outward) || 0,
        task_date: toLocalYmd()
      };
    },
    [homeOperators]
  );

  const openDoProfile = useCallback(
    (op, warehouseHint) => {
      if (homeListFocus === 'warehouses' || homeListFocus === 'customers') {
        return;
      }
      const profile = resolveDoProfile(op, warehouseHint);
      if (!profile) return;
      setSelectedDoProfile(profile);
      setDoProfileEditing(false);
      setDoProfileForm({
        full_name: profile.full_name || profile.name || '',
        phone_no: String(profile.phone_no || '').replace(/^\+91/, ''),
        warehouse_name: profile.warehouse_name || '',
        chamber_limit: profile.chamber_limit != null ? String(profile.chamber_limit) : '4'
      });
      setDoProfileAssignments([]);

      const email = String(profile.email || '').trim();
      if (apiUrl && token && email) {
        const qs = new URLSearchParams({ email });
        fetch(`${apiUrl}/api/dashboard/do-operator-io-counts?${qs.toString()}`, {
          headers: authHeaders
        })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok) return;
            setSelectedDoProfile((prev) => {
              if (!prev || String(prev.email || '').trim().toLowerCase() !== email.toLowerCase()) {
                return prev;
              }
              return {
                ...prev,
                total_inward: Number(data.total_inward) || 0,
                total_outward: Number(data.total_outward) || 0,
                today_inward: Number(data.today_inward) || 0,
                today_outward: Number(data.today_outward) || 0
              };
            });
          })
          .catch(() => {});
      }
    },
    [resolveDoProfile, homeListFocus, apiUrl, token, authHeaders]
  );

  const loadDoProfileAssignments = useCallback(async () => {
    const wh = selectedDoProfile?.warehouse_name;
    if (!apiUrl || !token || !wh) {
      setDoProfileAssignments([]);
      return;
    }
    setDoProfileAssignLoading(true);
    try {
      const res = await fetch(
        `${apiUrl}/api/chambers/assignments?warehouse_name=${encodeURIComponent(wh)}`,
        { headers: authHeaders }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'Failed');
      setDoProfileAssignments(
        Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : []
      );
    } catch (_) {
      setDoProfileAssignments([]);
    } finally {
      setDoProfileAssignLoading(false);
    }
  }, [apiUrl, token, authHeaders, selectedDoProfile?.warehouse_name]);

  useEffect(() => {
    if (selectedDoProfile?.warehouse_name) loadDoProfileAssignments();
  }, [selectedDoProfile?.warehouse_name, loadDoProfileAssignments]);

  useEffect(() => {
    setSelectedDoProfile((prev) => {
      if (!prev) return prev;
      const refreshed = resolveDoProfile(prev, prev.warehouse_name);
      if (!refreshed) return prev;
      return {
        ...prev,
        completed: refreshed.completed,
        pending: refreshed.pending,
        overdue: refreshed.overdue,
        morning_completed: refreshed.morning_completed,
        morning_expected: refreshed.morning_expected,
        morning_pending: refreshed.morning_pending,
        evening_completed: refreshed.evening_completed,
        evening_expected: refreshed.evening_expected,
        evening_pending: refreshed.evening_pending,
        total_inward: refreshed.total_inward,
        total_outward: refreshed.total_outward,
        today_inward: refreshed.today_inward,
        today_outward: refreshed.today_outward,
        task_date: refreshed.task_date
      };
    });
  }, [homeOperators, resolveDoProfile]);

  const saveDoProfileEdits = useCallback(async () => {
    if (!selectedDoProfile?.id || !apiUrl || !token) {
      Alert.alert(
        'Cannot edit',
        'Open this DO from Admin → DOs to edit full profile (needs operator id).'
      );
      return;
    }
    const payload = {
      full_name: doProfileForm.full_name.trim(),
      email: selectedDoProfile.email,
      phone_no: doProfileForm.phone_no.trim(),
      warehouse_name: doProfileForm.warehouse_name.trim(),
      chamber_limit:
        selectedDoProfile.chamber_limit != null
          ? Number(selectedDoProfile.chamber_limit)
          : 4
    };
    if (!payload.full_name || !payload.phone_no || !payload.warehouse_name) {
      Alert.alert('Missing fields', 'Name, phone and warehouse are required.');
      return;
    }
    setDoProfileBusy(true);
    try {
      const res = await fetch(`${apiUrl}/api/do-operators/${selectedDoProfile.id}`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || 'Save failed');
      setSelectedDoProfile((prev) =>
        prev
          ? {
              ...prev,
              name: payload.full_name,
              full_name: payload.full_name,
              phone_no: payload.phone_no,
              warehouse_name: payload.warehouse_name,
              chamber_limit: payload.chamber_limit
            }
          : prev
      );
      setDoProfileEditing(false);
      loadHomeOverview();
      showSavedChanges('Changes saved', 'DO profile was updated successfully.');
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not save profile.');
    } finally {
      setDoProfileBusy(false);
    }
  }, [
    selectedDoProfile,
    apiUrl,
    token,
    authHeaders,
    doProfileForm,
    loadHomeOverview,
    showSavedChanges
  ]);

  const doProfileChamberGroups = useMemo(() => {
    const map = new Map();
    doProfileAssignments.forEach((a) => {
      const key = String(a.chamber_id);
      if (!map.has(key)) {
        map.set(key, {
          id: a.chamber_id,
          name: a.chamber_name || `Chamber #${a.chamber_id}`,
          type: a.chamber_type || 'Frozen',
          active: [],
          deactive: []
        });
      }
      const inactive = (() => {
        const s = String(a.status || 'active').trim().toLowerCase();
        return (
          s === 'inactive' ||
          s === 'deactive' ||
          s === 'deactivated' ||
          s === 'disabled' ||
          s === '0' ||
          s === 'false'
        );
      })();
      const label = a.client_name || a.client_code || 'Client';
      if (inactive) map.get(key).deactive.push(label);
      else map.get(key).active.push(label);
    });
    return Array.from(map.values()).sort((a, b) =>
      String(a.name).localeCompare(String(b.name), undefined, { numeric: true })
    );
  }, [doProfileAssignments]);

  const dosForWarehouse = useCallback(
    (wh) => {
      const nested = Array.isArray(wh?.operators) ? wh.operators : [];
      if (nested.length) return nested;
      const whKey = String(wh?.warehouse_name || '')
        .trim()
        .toLowerCase();
      if (!whKey) return [];
      return homeOperators.filter(
        (op) => String(op.warehouse_name || '').trim().toLowerCase() === whKey
      );
    },
    [homeOperators]
  );

  const reportSummary = useMemo(() => {
    let inward = 0;
    let outward = 0;
    let balance = 0;
    let mismatches = 0;
    filteredReportRows.forEach((r) => {
      inward += Math.max(0, Number(r.total_inward_boxes) || 0);
      outward += Math.max(0, Number(r.total_outward_boxes) || 0);
      balance += Math.max(0, Number(r.calculated_balance) || 0);
      const bal = Math.max(0, Number(r.calculated_balance) || 0);
      const phys = Math.max(0, Number(r.physical_audit_count) || 0);
      if (bal - phys !== 0) mismatches += 1;
    });
    return {
      lots: filteredReportRows.length,
      inward,
      outward,
      balance,
      mismatches
    };
  }, [filteredReportRows]);

  const reportWarehouseOptions = useMemo(
    () => ['All', ...reportWarehouses],
    [reportWarehouses]
  );
  const reportClientOptions = useMemo(() => {
    if (reportWarehouseFilter && reportWarehouseFilter !== 'All') {
      const whNeed = String(reportWarehouseFilter).toLowerCase().trim();
      const map = reportWarehouseClientsMap || {};

      // Case-insensitive key match
      const foundKey = Object.keys(map).find((k) => String(k).toLowerCase().trim() === whNeed);
      const fromMap = foundKey ? map[foundKey] || [] : [];
      if (fromMap.length) return ['All', ...fromMap];

      // Fallback: reportRows se derive
      const set = new Set();
      reportRows.forEach((r) => {
        if (!r?.warehouse_name || !r?.client_name) return;
        if (String(r.warehouse_name).toLowerCase().trim() !== whNeed) return;
        const cl = String(r.client_name).trim();
        if (cl) set.add(cl);
      });
      const derived = Array.from(set).sort((a, b) => a.localeCompare(b));
      return ['All', ...(derived.length ? derived : reportClients)];
    }
    return ['All', ...reportClients];
  }, [reportWarehouseFilter, reportWarehouseClientsMap, reportRows, reportClients]);

  const to24hTime = (value) => {
    if (value == null || String(value).trim() === '') return null;
    const s = String(value).trim();

    // ISO / datetime: 2026-08-10T14:35:22 or 2026-08-10 14:35:22
    const iso = s.match(/(?:T|\s)(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (iso && !/[APMapm]{2}/.test(s)) {
      const hh = String(Math.min(23, parseInt(iso[1], 10))).padStart(2, '0');
      const mm = iso[2];
      return `${hh}:${mm}`;
    }

    // 12h clock: 4:05 PM / 10:00 am
    const ampm = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])/);
    if (ampm) {
      let h = parseInt(ampm[1], 10);
      const m = ampm[2];
      const ap = ampm[3].toUpperCase();
      if (ap === 'PM' && h < 12) h += 12;
      if (ap === 'AM' && h === 12) h = 0;
      return `${String(h).padStart(2, '0')}:${m}`;
    }

    // Already 24h clock fragment
    const h24 = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (h24) {
      return `${String(Math.min(23, parseInt(h24[1], 10))).padStart(2, '0')}:${h24[2]}`;
    }

    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return null;
  };

  const formatReportTime = (row) => {
    // Prefer actual submit time (created_at), then capture/submit fields — always 24h
    const candidates = [row.created_at, row.submit_time, row.photo_capture_time, row.inspection_time];
    for (const c of candidates) {
      const t = to24hTime(c);
      if (t) return t;
    }
    return '—';
  };

  const openReportDetail = useCallback(
    async (row) => {
      setSelectedReport(row);
      setReportHistory([]);
      setReportHistoryError('');
      setReportHistoryLoading(true);
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
          headers: authHeaders
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.message || data.error || `Failed to load history (${res.status})`);
        }
        let items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];

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

        setReportHistory(buildReportReadingRows(items));
      } catch (err) {
        setReportHistory([]);
        setReportHistoryError(err.message || 'Failed to load day-wise qty.');
      } finally {
        setReportHistoryLoading(false);
      }
    },
    [apiUrl, authHeaders]
  );

  const closeReportDetail = () => {
    setSelectedReport(null);
    setReportHistory([]);
    setReportHistoryError('');
    setReportHistoryLoading(false);
  };

  const renderReportItem = ({ item }) => {
    const inward = Math.max(0, Number(item.total_inward_boxes) || 0);
    const outward = Math.max(0, Number(item.total_outward_boxes) || 0);
    const balance = Math.max(0, Number(item.calculated_balance) || 0);
    const physical = Math.max(0, Number(item.physical_audit_count) || 0);
    // Diff = system balance vs physical (never show a minus sign — show gap size)
    const rawDiff = balance - physical;
    const mismatch = rawDiff !== 0;
    const gap = Math.abs(rawDiff);
    return (
      <TouchableOpacity
        style={styles.dailyCard}
        onPress={() => openReportDetail(item)}
        activeOpacity={0.85}
      >
        <View style={styles.dailyTop}>
          <View style={styles.dailyTextCol}>
            <Text style={styles.dailyChamber} numberOfLines={1}>
              {item.client_name || 'Client'}
            </Text>
            <Text style={styles.dailyMetaLine} numberOfLines={1}>
              {item.chamber_name || 'Chamber'}
              {item.warehouse_name ? ` · ${item.warehouse_name}` : ''}
              {` · In ${inward} · Out ${outward} · Bal ${balance} · Phys ${physical}`}
            </Text>
          </View>
          <Text style={[styles.dailyTemp, { color: mismatch ? '#dc2626' : '#059669' }]}>
            {mismatch ? gap : 0}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderLogItem = ({ item }) => {
    if (item._logType === 'chambers' || (!item._logType && logType === 'chambers')) {
      const dateLabel = formatDateLabel(
        String(item.formatted_date || item.entry_date || '').slice(0, 10) || 'All'
      );
      const temp =
        item.box_temp != null
          ? `${item.box_temp}°C`
          : item.chamber_temp != null
            ? `${item.chamber_temp}°C`
            : '—';
      return (
        <TouchableOpacity
          style={styles.dailyCard}
          onPress={() => setSelectedLog(item)}
          activeOpacity={0.85}
        >
          <View style={styles.dailyTop}>
            <View style={styles.dailyTextCol}>
              <Text style={styles.dailyChamber} numberOfLines={1}>
                {item.chamber_name || 'Chamber'}
                {item.client_name ? ` · ${item.client_name}` : ''}
              </Text>
              <Text style={styles.dailyMetaLine} numberOfLines={1}>
                {dateLabel}
                {item.shift ? ` · ${item.shift}` : ''}
                {item.box_count != null ? ` · ${item.box_count} boxes` : ''}
                {item.warehouse_name ? ` · ${item.warehouse_name}` : ''}
              </Text>
            </View>
            <Text style={styles.dailyTemp}>{temp}</Text>
          </View>
        </TouchableOpacity>
      );
    }

    const typeLabel =
      item._logType === 'inward' ? 'Inward' : item._logType === 'outward' ? 'Outward' : 'Chamber';
    const rightValue =
      item.box_temp != null
        ? `${item.box_temp}°C`
        : item.chamber_temp != null
          ? `${item.chamber_temp}°C`
          : item.box_count != null
            ? `${item.box_count}`
            : '—';
    return (
      <TouchableOpacity
        style={styles.logCard}
        onPress={() => setSelectedLog(item)}
        activeOpacity={0.85}
      >
        <View style={{ flex: 1 }}>
          <View style={styles.logTitleRow}>
            <Text style={styles.logTypeTag}>{typeLabel}</Text>
            <Text style={styles.logClient} numberOfLines={1}>
              {item.client_name || 'Client'}
            </Text>
          </View>
          <Text style={styles.logMeta} numberOfLines={2}>
            {item.chamber_name || '—'}
            {item.warehouse_name ? ` · ${item.warehouse_name}` : ''}
            {' · '}
            {String(item.formatted_date || item.entry_date || '').slice(0, 10) || '—'}
            {item.shift ? ` · ${item.shift}` : ''}
          </Text>
        </View>
        <Text style={styles.logTemp}>{rightValue}</Text>
      </TouchableOpacity>
    );
  };

  const warehouseOptions = useMemo(() => {
    const fromScope = logFilterScope.warehouses || [];
    const merged = fromScope.length ? fromScope : warehouses;
    return ['All', ...merged];
  }, [logFilterScope.warehouses, warehouses]);

  const chamberOptions = useMemo(() => {
    const whKey = resolveScopeWarehouseKey(warehouseFilter);
    if (!whKey) {
      const set = new Set();
      Object.values(logFilterScope.warehouseChambers || {}).forEach((list) => {
        (list || []).forEach((c) => {
          if (c?.name) set.add(c.name);
        });
      });
      return ['All', ...Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))];
    }
    const list = logFilterScope.warehouseChambers?.[whKey] || [];
    return ['All', ...list.map((c) => c.name)];
  }, [warehouseFilter, logFilterScope.warehouseChambers, resolveScopeWarehouseKey]);

  const clientOptions = useMemo(() => {
    const whKey = resolveScopeWarehouseKey(warehouseFilter);
    if (whKey) {
      if (chamberFilter && chamberFilter !== 'All') {
        const chambers = logFilterScope.warehouseChambers?.[whKey] || [];
        const hit = chambers.find(
          (c) => String(c.name).toLowerCase() === String(chamberFilter).toLowerCase()
        );
        if (hit?.clients?.length) return ['All', ...hit.clients];
      }
      const fromWh = logFilterScope.warehouseClients?.[whKey];
      if (fromWh?.length) return ['All', ...fromWh];
      // Fallback: union clients from chambers under this warehouse
      const fromChambers = new Set();
      (logFilterScope.warehouseChambers?.[whKey] || []).forEach((c) => {
        (c.clients || []).forEach((cl) => fromChambers.add(cl));
      });
      if (fromChambers.size) {
        return ['All', ...Array.from(fromChambers).sort((a, b) => a.localeCompare(b))];
      }
    }
    const set = new Set();
    Object.values(logFilterScope.warehouseClients || {}).forEach((list) => {
      (list || []).forEach((c) => set.add(c));
    });
    if (set.size) return ['All', ...Array.from(set).sort((a, b) => a.localeCompare(b))];
    return ['All', ...clients];
  }, [
    warehouseFilter,
    chamberFilter,
    logFilterScope.warehouseClients,
    logFilterScope.warehouseChambers,
    clients,
    resolveScopeWarehouseKey
  ]);

  const selectWarehouseFilter = (opt) => {
    setWarehouseFilter(opt);
    setChamberFilter('All');
    setClientFilter('All');
  };

  const selectChamberFilter = (opt) => {
    setChamberFilter(opt);
    setClientFilter('All');
  };

  const pickFilterOption = (opt) => {
    if (openFilter === 'warehouse') {
      selectWarehouseFilter(opt);
      if (opt === 'All') {
        setOpenFilter(null);
        return;
      }
      const whKey = resolveScopeWarehouseKey(opt);
      const chamberList = whKey ? logFilterScope.warehouseChambers?.[whKey] || [] : [];
      setOpenFilter(chamberList.length ? 'chamber' : null);
      return;
    }
    if (openFilter === 'chamber') {
      selectChamberFilter(opt);
      if (opt === 'All') {
        setOpenFilter(null);
        return;
      }
      const whKey = resolveScopeWarehouseKey(warehouseFilter);
      const hit = (logFilterScope.warehouseChambers?.[whKey] || []).find(
        (c) => String(c.name).toLowerCase() === String(opt).toLowerCase()
      );
      const clientList = hit?.clients?.length
        ? hit.clients
        : (logFilterScope.warehouseClients?.[whKey] || []).filter(Boolean);
      setOpenFilter(clientList.length ? 'client' : null);
      return;
    }
    if (openFilter === 'client') {
      setClientFilter(opt);
      setOpenFilter(null);
      return;
    }
    if (openFilter === 'reportWarehouse') {
      setReportWarehouseFilter(opt);
      setOpenFilter(null);
      return;
    }
    if (openFilter === 'reportClient') {
      setReportClientFilter(opt);
      setOpenFilter(null);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />

      <View style={styles.header}>
        <View style={styles.headerSide}>
          <TouchableOpacity
            onPress={openDrawer}
            activeOpacity={0.85}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{ padding: 2 }}
          >
            <Ionicons name="menu-outline" size={26} color="#003580" />
          </TouchableOpacity>
        </View>
        <View style={styles.headerCenter}>
          <Image
            source={require('../../assets/logo-transparent.png')}
            style={styles.headerLogo}
            resizeMode="contain"
          />
          <View style={styles.headerTitleWrap}>
            <Text style={styles.headerTitle}>Sub Admin</Text>
            <Text style={styles.headerMobileSub}>mobile</Text>
          </View>
        </View>
        <View style={[styles.headerSide, styles.headerSideRight]}>
          <TouchableOpacity
            style={styles.bellBtn}
            onPress={openNotifications}
            activeOpacity={0.85}
          >
            <Ionicons
              name={unreadNotifCount > 0 ? 'notifications' : 'notifications-outline'}
              size={22}
              color="#003580"
            />
            {Number(unreadNotifCount) > 0 ? (
              <View style={styles.bellBadge}>
                <Text style={styles.bellBadgeText}>
                  {unreadNotifCount > 99 ? '99+' : String(unreadNotifCount)}
                </Text>
              </View>
            ) : null}
          </TouchableOpacity>
        </View>
      </View>

      {activeTab === 'Logs' ? (
        <View style={styles.contentArea}>
          <View style={styles.filterPanel}>
            <View style={styles.logTypeRow}>
              {[
                { id: 'chambers', label: 'Chambers' },
                { id: 'inward', label: 'Inward' },
                { id: 'outward', label: 'Outward' }
              ].map((t) => {
                const active = logType === t.id;
                return (
                  <TouchableOpacity
                    key={t.id}
                    style={[styles.logTypeChip, active && styles.logTypeChipActive]}
                    onPress={() => {
                      setLogPage(1);
                      setLogType(t.id);
                      setWarehouseFilter('All');
                      setChamberFilter('All');
                      setClientFilter('All');
                      setOpenFilter(null);
                      if (t.id === 'chambers') {
                        const today = toLocalYmd();
                        applyDateRange(today, today);
                      }
                    }}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.logTypeChipText, active && styles.logTypeChipTextActive]}>
                      {t.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.filterRow}>
              <TouchableOpacity
                style={[styles.filterChip, warehouseFilter !== 'All' && styles.filterChipActive]}
                onPress={() => setOpenFilter(openFilter === 'warehouse' ? null : 'warehouse')}
              >
                <Text style={styles.filterChipLabel}>WH</Text>
                <Text style={styles.filterChipValue} numberOfLines={1}>
                  {warehouseFilter}
                </Text>
              </TouchableOpacity>
              {logsWarehouseSelected ? (
                <TouchableOpacity
                  style={[styles.filterChip, chamberFilter !== 'All' && styles.filterChipActive]}
                  onPress={() => setOpenFilter(openFilter === 'chamber' ? null : 'chamber')}
                >
                  <Text style={styles.filterChipLabel}>Chamber</Text>
                  <Text style={styles.filterChipValue} numberOfLines={1}>
                    {chamberFilter}
                  </Text>
                </TouchableOpacity>
              ) : null}
              {logsWarehouseSelected ? (
              <TouchableOpacity
                style={[styles.filterChip, clientFilter !== 'All' && styles.filterChipActive]}
                onPress={() => setOpenFilter(openFilter === 'client' ? null : 'client')}
              >
                <Text style={styles.filterChipLabel}>Client</Text>
                <Text style={styles.filterChipValue} numberOfLines={1}>
                  {clientFilter}
                </Text>
              </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={[styles.filterChip, dateFrom !== 'All' && styles.filterChipActive]}
                onPress={() => openCalendar('from')}
              >
                <Text style={styles.filterChipLabel}>From</Text>
                <Text style={styles.filterChipValue} numberOfLines={1}>
                  {formatDateLabel(dateFrom)}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.filterChip, dateTo !== 'All' && styles.filterChipActive]}
                onPress={() => openCalendar('to')}
              >
                <Text style={styles.filterChipLabel}>To</Text>
                <Text style={styles.filterChipValue} numberOfLines={1}>
                  {formatDateLabel(dateTo)}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.logQuickBtnRow}>
              <TouchableOpacity
                style={[
                  styles.logQuickBtn,
                  logDatePreset === 'today' && styles.logQuickBtnActive
                ]}
                onPress={() => {
                  const t = toLocalYmd();
                  applyDateRange(t, t);
                }}
                activeOpacity={0.85}
              >
                <Text
                  style={[
                    styles.logQuickBtnText,
                    logDatePreset === 'today' && styles.logQuickBtnTextActive
                  ]}
                >
                  Today
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.logQuickBtn,
                  logDatePreset === '7days' && styles.logQuickBtnActive
                ]}
                onPress={() => {
                  const end = new Date();
                  const start = new Date();
                  start.setDate(end.getDate() - 6);
                  applyDateRange(toLocalYmd(start), toLocalYmd(end));
                }}
                activeOpacity={0.85}
              >
                <Text
                  style={[
                    styles.logQuickBtnText,
                    logDatePreset === '7days' && styles.logQuickBtnTextActive
                  ]}
                >
                  7 days
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.logQuickBtn, styles.logQuickBtnClear]}
                onPress={clearAllFilters}
                activeOpacity={0.85}
              >
                <Text style={[styles.logQuickBtnText, styles.logQuickBtnClearText]}>Clear</Text>
              </TouchableOpacity>
            </View>
          </View>

            {logType === 'chambers' ? (
              <>
                <View style={[styles.todayOpsCard, styles.logOpsCard]}>
                  <View style={[styles.todayOpsCell, styles.logOpsCell]}>
                    <Text style={[styles.todayOpsNum, styles.logOpsNum, { color: '#059669' }]}>
                      {logTaskSummaryLoading ? '—' : logTaskSummary?.completed ?? 0}
                      <Text style={[styles.todayOpsDen, styles.logOpsDen]}>
                        /{logTaskSummaryLoading ? '—' : logTaskSummary?.expected ?? 0}
                      </Text>
                    </Text>
                    <Text style={[styles.todayOpsLbl, styles.logOpsLbl]}>Completed</Text>
                  </View>
                  <View style={styles.todayOpsDivider} />
                  <View style={[styles.todayOpsCell, styles.logOpsCell]}>
                    <Text style={[styles.todayOpsNum, styles.logOpsNum, { color: '#059669' }]}>
                      {logTaskSummaryLoading ? '—' : logTaskSummary?.morningDone ?? 0}
                      <Text style={[styles.todayOpsDen, styles.logOpsDen]}>
                        /{logTaskSummaryLoading ? '—' : logTaskSummary?.morningExp ?? 0}
                      </Text>
                    </Text>
                    <Text style={[styles.todayOpsLbl, styles.logOpsLbl]}>Morning</Text>
                  </View>
                  <View style={styles.todayOpsDivider} />
                  <View style={[styles.todayOpsCell, styles.logOpsCell]}>
                    <Text style={[styles.todayOpsNum, styles.logOpsNum, { color: '#003580' }]}>
                      {logTaskSummaryLoading ? '—' : logTaskSummary?.eveningDone ?? 0}
                      <Text style={[styles.todayOpsDen, styles.logOpsDen]}>
                        /{logTaskSummaryLoading ? '—' : logTaskSummary?.eveningExp ?? 0}
                      </Text>
                    </Text>
                    <Text style={[styles.todayOpsLbl, styles.logOpsLbl]}>Evening</Text>
                  </View>
                </View>
                <View style={[styles.dailyBanner, styles.logDailyBanner]}>
                  <Ionicons name="thermometer-outline" size={11} color="#003580" />
                  <Text style={[styles.dailyBannerText, styles.logDailyBannerText]}>
                    Tasks for filter dates
                    {dateFrom !== 'All' && dateTo !== 'All'
                      ? dateFrom === dateTo
                        ? ` · ${formatDateLabel(dateFrom)}`
                        : ` · ${formatDateLabel(dateFrom)} → ${formatDateLabel(dateTo)}`
                      : ''}
                    {warehouseFilter !== 'All' ? ` · ${warehouseFilter}` : ''}
                    {logTaskSummaryLoading ? ' · …' : ''}
                  </Text>
                </View>
              </>
            ) : null}

          {isBlockingListLoad(logsLoading, logsRefreshing, logs.length) ? (
            <View style={styles.centerState}>
              <ActivityIndicator size="large" color="#003580" />
              <Text style={styles.stateText}>
                Loading {logType === 'inward' ? 'inward' : logType === 'outward' ? 'outward' : 'chamber'}{' '}
                logs…
              </Text>
            </View>
          ) : logsError && logs.length === 0 ? (
            <InlineErrorState message={logsError} onRetry={loadLogs} icon="warning-outline" />
          ) : (
            <View style={{ flex: 1 }}>
            <FlatList
              data={logs}
              keyExtractor={(item, idx) =>
                String(item.id || item.inward_id || item.outward_id || item.reference_no || idx)
              }
              renderItem={renderLogItem}
              contentContainerStyle={styles.listBody}
              refreshControl={
                <RefreshControl
                  refreshing={logsRefreshing}
                  onRefresh={() => {
                    setLogsRefreshing(true);
                    loadLogs();
                    loadLogTaskSummary();
                  }}
                />
              }
                ListFooterComponent={
                  logTotal > DOCK_REPORT_PAGE_SIZE || logPage > 1 ? (
                    <View style={styles.dockReportPagination}>
                      <TouchableOpacity
                        style={[
                          styles.dockReportPageBtn,
                          logPage <= 1 && styles.dockReportPageBtnDisabled
                        ]}
                        disabled={logPage <= 1 || logsLoading}
                        onPress={goLogPrevPage}
                      >
                        <Text style={styles.dockReportPageBtnText}>Previous</Text>
                      </TouchableOpacity>
                      <Text style={styles.dockReportPageMeta}>
                        Page {logPage}
                        {logTotal ? ` · ${logTotal} total` : ''}
                      </Text>
                      <TouchableOpacity
                        style={[
                          styles.dockReportPageBtn,
                          !logHasMore && styles.dockReportPageBtnDisabled
                        ]}
                        disabled={!logHasMore || logsLoading}
                        onPress={goLogNextPage}
                      >
                        <Text style={styles.dockReportPageBtnText}>Next</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null
              }
              ListEmptyComponent={
                <View style={styles.centerState}>
                  <Ionicons name="document-text-outline" size={28} color="#94a3b8" />
                  <Text style={styles.stateText}>No logs for selected filters.</Text>
                </View>
              }
                {...FLATLIST_PERF_PROPS}
            />
              <ListLoadingOverlay
                visible={isSoftListLoad(logsLoading, logsRefreshing, logs.length)}
                label="Loading logs…"
              />
            </View>
          )}
        </View>
      ) : activeTab === 'Reports' ? (
        <View style={styles.contentArea}>
          <View style={styles.filterPanel}>
            <View style={styles.logTypeRow}>
              {[
                { id: 'all', label: 'All lots' },
                { id: 'mismatch', label: 'Mismatch' }
              ].map((t) => {
                const active = reportView === t.id;
                return (
                  <TouchableOpacity
                    key={t.id}
                    style={[styles.logTypeChip, active && styles.logTypeChipActive]}
                    onPress={() => setReportView(t.id)}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.logTypeChipText, active && styles.logTypeChipTextActive]}>
                      {t.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.filterRow}>
              <TouchableOpacity
                style={[
                  styles.filterChip,
                  reportWarehouseFilter !== 'All' && styles.filterChipActive
                ]}
                onPress={() =>
                  setOpenFilter(openFilter === 'reportWarehouse' ? null : 'reportWarehouse')
                }
              >
                <Text style={styles.filterChipLabel}>WH</Text>
                <Text style={styles.filterChipValue} numberOfLines={1}>
                  {reportWarehouseFilter}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.filterChip,
                  reportClientFilter !== 'All' && styles.filterChipActive
                ]}
                onPress={() =>
                  setOpenFilter(openFilter === 'reportClient' ? null : 'reportClient')
                }
              >
                <Text style={styles.filterChipLabel}>Client</Text>
                <Text style={styles.filterChipValue} numberOfLines={1}>
                  {reportClientFilter}
                </Text>
              </TouchableOpacity>
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.suggestRow}
            >
              <TouchableOpacity
                style={styles.suggestChip}
                onPress={() => setReportView('all')}
              >
                <Text style={styles.suggestText}>All</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.suggestChip}
                onPress={() => setReportView('mismatch')}
              >
                <Text style={styles.suggestText}>Mismatch only</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.suggestChip}
                onPress={() => {
                  setReportView('all');
                  setReportWarehouseFilter('All');
                  setReportClientFilter('All');
                }}
              >
                <Text style={styles.suggestText}>Clear</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>

          <View style={styles.dailyBanner}>
            <Ionicons name="cube-outline" size={14} color="#003580" />
            <Text style={styles.dailyBannerText}>
              Inventory · {reportSummary.lots} lot{reportSummary.lots === 1 ? '' : 's'}
              {` · In ${reportSummary.inward} · Out ${reportSummary.outward}`}
              {reportSummary.mismatches ? ` · ${reportSummary.mismatches} mismatch` : ''}
            </Text>
          </View>

          {!isOnline || reportsFromCache || (reportsError && filteredReportRows.length > 0) ? (
            <View
              style={[
                styles.netBanner,
                !isOnline ? styles.netBannerOffline : styles.netBannerWarn
              ]}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.netBannerTitle}>
                  {!isOnline
                    ? 'You are offline'
                    : reportsFromCache
                      ? 'Showing saved reports'
                      : 'Network issue'}
                </Text>
                <Text style={styles.netBannerSub} numberOfLines={2}>
                  {!isOnline
                    ? 'Using last saved inventory data. Retry when you are back online.'
                    : reportsError ||
                      (reportsLastUpdated
                        ? `Last good load · ${reportsLastUpdated}`
                        : 'Pull to refresh or tap Retry.')}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.netBannerBtn}
                onPress={() => {
                  setReportsRefreshing(true);
                  loadReports('reset');
                }}
                activeOpacity={0.85}
              >
                <Text style={styles.netBannerBtnText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : reportsLastUpdated ? (
            <Text style={styles.reportsUpdatedAt}>Updated · {reportsLastUpdated}</Text>
          ) : null}

          {isBlockingListLoad(reportsLoading, reportsRefreshing, filteredReportRows.length) ? (
            <View style={styles.centerState}>
              <ActivityIndicator size="large" color="#003580" />
              <Text style={styles.stateText}>Loading inventory…</Text>
            </View>
          ) : reportsError && filteredReportRows.length === 0 ? (
            <InlineErrorState
              message={reportsError}
              onRetry={() => loadReports('reset')}
              icon={!isOnline ? 'cloud-offline-outline' : 'warning-outline'}
            />
          ) : (
            <View style={{ flex: 1 }}>
            <FlatList
              data={filteredReportRows}
              keyExtractor={(item, idx) =>
                `${item.client_name || 'c'}-${item.warehouse_name || 'w'}-${idx}`
              }
              renderItem={renderReportItem}
              contentContainerStyle={styles.listBody}
                onEndReachedThreshold={0.35}
                onEndReached={() => {
                  if (reportHasMore && !reportsLoading && !reportsLoadingMore) {
                    loadReports('more');
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
                      loadReports('reset');
                  }}
                />
              }
              ListEmptyComponent={
                <View style={styles.centerState}>
                  <Ionicons name="cube-outline" size={28} color="#94a3b8" />
                  <Text style={styles.stateText}>No inventory for selected filters.</Text>
                </View>
              }
                {...FLATLIST_PERF_PROPS}
              />
              <ListLoadingOverlay
                visible={isSoftListLoad(
                  reportsLoading,
                  reportsRefreshing,
                  filteredReportRows.length
                )}
                label="Updating inventory…"
              />
            </View>
          )}
        </View>
      ) : activeTab === 'Admin' ? (
        <View style={styles.contentArea}>
          <SubAdminAdminPanel
            apiUrl={apiUrl}
            token={token}
            authHeaders={authHeaders}
            initialSection={adminInitialSection}
            permissionItems={[...rolePermissionNotifications]
              .sort((a, b) => {
                const ap = a.status === 'Pending' ? 0 : 1;
                const bp = b.status === 'Pending' ? 0 : 1;
                if (ap !== bp) return ap - bp;
                return (Number(b.id) || 0) - (Number(a.id) || 0);
              })
              .slice(0, 100)
              .map((n) => ({
                ...n,
                _title: getNotifTitle(n),
                _subtitle: getNotifMessage(n)
              }))}
            permissionLoading={false}
            onRefreshPermissions={loadNotifications}
            onApprovePermission={(id) => respondToPermissionRequest(id, 'Approved')}
            onDenyPermission={openDenyPermission}
            permissionBusyId={notifActionBusy}
            permissionsUpdatedAt={permissionsUpdatedAt}
            initialPermFilter={adminPermFilter}
            onOpenDoProfile={(op) =>
              openDoProfile(
                {
                  id: op.id,
                  name: op.full_name || op.email,
                  full_name: op.full_name,
                  email: op.email,
                  phone_no: op.phone_no,
                  warehouse_name: op.warehouse_name,
                  warehouse_code: op.warehouse_code,
                  chamber_limit: op.chamber_limit
                },
                op.warehouse_name
              )
            }
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.body, activeTab === 'More' && styles.moreBody]}
          showsVerticalScrollIndicator={false}
          refreshControl={
            activeTab === 'Dashboard' || activeTab === 'Home' ? (
              <RefreshControl
                refreshing={homeRefreshing}
                onRefresh={() => {
                  setHomeRefreshing(true);
                  loadHomeOverview();
                }}
              />
            ) : undefined
          }
        >
          {(activeTab === 'Dashboard' || activeTab === 'Home') && (
            <>
              {homeLoading && !homeRefreshing ? (
                <View style={styles.centerState}>
                  <ActivityIndicator size="large" color="#003580" />
                  <Text style={styles.stateText}>Loading overview…</Text>
                </View>
              ) : homeError ? (
                <InlineErrorState message={homeError} onRetry={loadHomeOverview} />
              ) : (
                <>
                  <View style={styles.dashHero}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.dashHeroEyebrow}>DO monitor · daily tasks</Text>
                      <Text style={styles.dashHeroTitle}>Today's status</Text>
                      <Text style={styles.dashHeroDate}>
                        {todayLabel}
                        {homeLastUpdated ? ` · Updated ${homeLastUpdated}` : ''}
                      </Text>
                    </View>
                    <View style={styles.dashHeroIcon}>
                      <Ionicons name="pulse-outline" size={18} color="#003580" />
                    </View>
                  </View>

                  <View style={styles.todayOpsCard}>
                    <View style={styles.todayOpsCell}>
                      <Text style={[styles.todayOpsNum, { color: '#059669' }]}>
                        {todayOps.morningDone}
                        <Text style={styles.todayOpsDen}>/{todayOps.morningExpected}</Text>
                      </Text>
                      <Text style={styles.todayOpsLbl}>Morning</Text>
                    </View>
                    <View style={styles.todayOpsDivider} />
                    <View style={styles.todayOpsCell}>
                      <Text style={[styles.todayOpsNum, { color: '#003580' }]}>
                        {todayOps.eveningDone}
                        <Text style={styles.todayOpsDen}>/{todayOps.eveningExpected}</Text>
                      </Text>
                      <Text style={styles.todayOpsLbl}>Evening</Text>
                    </View>
                    <View style={styles.todayOpsDivider} />
                    <View style={styles.todayOpsCell}>
                      <Text style={[styles.todayOpsNum, { color: '#dc2626' }]}>
                        {todayOps.overdue}
                      </Text>
                      <Text style={styles.todayOpsLbl}>Overdue</Text>
                    </View>
                  </View>

                  <View style={styles.todayOpsCard}>
                    <View style={styles.todayOpsCell}>
                      <Text style={[styles.todayOpsNum, { color: '#1967d2' }]}>
                        {todayOps.totalInward}
                      </Text>
                      <Text style={styles.todayOpsLbl}>Total In</Text>
                    </View>
                    <View style={styles.todayOpsDivider} />
                    <View style={styles.todayOpsCell}>
                      <Text style={[styles.todayOpsNum, { color: '#e37400' }]}>
                        {todayOps.totalOutward}
                      </Text>
                      <Text style={styles.todayOpsLbl}>Total Out</Text>
                    </View>
                    <View style={styles.todayOpsDivider} />
                    <View style={styles.todayOpsCell}>
                      <Text style={[styles.todayOpsNum, { color: '#137333' }]}>
                        {todayOps.todayInward}
                      </Text>
                      <Text style={styles.todayOpsLbl}>Today In</Text>
                    </View>
                    <View style={styles.todayOpsDivider} />
                    <View style={styles.todayOpsCell}>
                      <Text style={[styles.todayOpsNum, { color: '#7627bb' }]}>
                        {todayOps.todayOutward}
                      </Text>
                      <Text style={styles.todayOpsLbl}>Today Out</Text>
                    </View>
                  </View>

                  {pendingNotifCount > 0 ? (
                    <TouchableOpacity
                      style={styles.permAlertBanner}
                      onPress={() => openAdminSection('permissions')}
                      activeOpacity={0.88}
                    >
                      <View style={styles.permAlertIcon}>
                        <Ionicons name="shield-outline" size={18} color="#b45309" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.permAlertTitle}>
                          {pendingNotifCount} permission request
                          {pendingNotifCount === 1 ? '' : 's'} pending
                        </Text>
                        <Text style={styles.permAlertSub}>Review in Admin → Permission</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={18} color="#b45309" />
                    </TouchableOpacity>
                  ) : null}

                  <Text style={styles.dashSectionLbl}>Browse by category</Text>
                  <View style={styles.statsGrid}>
                    {overviewCards.map((card) => {
                      const active = homeListFocus === card.key;
                      return (
                        <Pressable
                          key={card.key}
                          style={[styles.statCard, active && styles.statCardActive]}
                          onPress={() => {
                            setSelectedDoProfile(null);
                            setHomeListFocus(card.key);
                          }}
                          hitSlop={0}
                        >
                        <View style={[styles.statIcon, { backgroundColor: `${card.color}18` }]}>
                          <Ionicons name={card.icon} size={12} color={card.color} />
                        </View>
                        <Text style={[styles.statValue, { color: card.color }]}>{card.value}</Text>
                        <Text style={styles.statLabel} numberOfLines={1}>
                          {card.label}
                        </Text>
                    </Pressable>
                      );
                    })}
                  </View>

                  <View style={styles.doSection}>
                    <View style={styles.doOverviewCard}>
                      <View style={styles.doOverviewHead}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.doOverviewTitle}>{homeListTitle}</Text>
                          <Text style={styles.doOverviewSub}>{homeListSubtitle}</Text>
                        </View>
                        {homeListFocus === 'customers' || homeListFocus === 'warehouses' ? (
                          <TouchableOpacity
                            style={styles.customerAddBtn}
                            onPress={
                              homeListFocus === 'warehouses'
                                ? openCreateWarehouse
                                : openCreateCustomer
                            }
                            activeOpacity={0.85}
                          >
                            <Ionicons name="add" size={16} color="#fff" />
                            <Text style={styles.customerAddBtnText}>Add</Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>

                      {homeListFocus === 'warehouses' ? (
                        dashboardWarehouseRows.length === 0 ? (
                          <Text style={styles.cardHintSm}>No warehouses yet.</Text>
                        ) : (
                        dashboardWarehouseRows.map((wh, idx) => {
                          const mornDone = Number(wh.morning_completed) || 0;
                          const mornExp = Number(wh.morning_expected) || 0;
                          const eveDone = Number(wh.evening_completed) || 0;
                          const eveExp = Number(wh.evening_expected) || 0;
                          const overdue = Number(wh.overdue) || 0;
                          const pending = Number(wh.pending) || 0;
                          const color =
                            overdue > 0 ? '#dc2626' : pending > 0 ? '#d97706' : '#059669';
                          return (
                            <View
                              key={`${wh.catalog_id || 'task'}-${wh.warehouse_name}-${idx}`}
                              style={[styles.doOverviewRow, idx > 0 && styles.doOverviewRowBorder]}
                            >
                              <View
                                style={[styles.doOverviewDotSm, { backgroundColor: color }]}
                              />
                              <Pressable
                                style={{ flex: 1, minWidth: 0 }}
                                onPress={() => openEditWarehouse(wh)}
                                hitSlop={0}
                              >
                                <Text style={styles.doOverviewWh} numberOfLines={1}>
                                  {wh.warehouse_name}
                                </Text>
                                <Text style={styles.doOverviewMeta} numberOfLines={2}>
                                  {wh.warehouse_code || 'No code'}
                                  {wh.city ? ` · ${wh.city}` : ''}
                                  {` · Mor ${mornDone}/${mornExp}`}
                                  {` · Evn ${eveDone}/${eveExp}`}
                                  {overdue ? ` · Over ${overdue}` : ''}
                                </Text>
                              </Pressable>
                              <Pressable
                                style={styles.customerIconBtn}
                                onPress={() => openEditWarehouse(wh)}
                                hitSlop={0}
                              >
                                <Ionicons name="create-outline" size={16} color="#003580" />
                              </Pressable>
                              {wh.catalog_id ? (
                                <Pressable
                                  style={styles.customerIconBtnDanger}
                                  onPress={() => deleteWarehouseCatalog(wh)}
                                  hitSlop={0}
                                >
                                  <Ionicons name="trash-outline" size={16} color="#dc2626" />
                                </Pressable>
                              ) : null}
                            </View>
                          );
                        })
                        )
                      ) : homeListFocus === 'customers' ? (
                        homeCustomers.length === 0 ? (
                          <Text style={styles.cardHintSm}>No customer accounts yet.</Text>
                        ) : (
                          homeCustomers.map((c, idx) => (
                            <View
                              key={String(c.id || c.email || idx)}
                              style={[styles.doOverviewRow, idx > 0 && styles.doOverviewRowBorder]}
                            >
                              <View
                                style={[styles.doOverviewDotSm, { backgroundColor: '#059669' }]}
                              />
                              <TouchableOpacity
                                style={{ flex: 1, minWidth: 0 }}
                                activeOpacity={0.85}
                                onPress={() => openEditCustomer(c)}
                              >
                                <Text style={styles.doOverviewWh} numberOfLines={1}>
                                  {c.full_name || c.email || 'Customer'}
                                </Text>
                                <Text style={styles.doOverviewMeta} numberOfLines={2}>
                                  {c.email || '—'}
                                  {c.phone_no ? ` · ${c.phone_no}` : ''}
                                  {` · WH: ${formatScopeList(c.allowed_warehouses)}`}
                                  {` · Clients: ${formatScopeList(c.allowed_clients)}`}
                                </Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={styles.customerIconBtn}
                                onPress={() => openEditCustomer(c)}
                                activeOpacity={0.85}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                              >
                                <Ionicons name="create-outline" size={16} color="#003580" />
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={styles.customerIconBtnDanger}
                                onPress={() => deleteCustomer(c)}
                                activeOpacity={0.85}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                              >
                                <Ionicons name="trash-outline" size={16} color="#dc2626" />
                              </TouchableOpacity>
                            </View>
                          ))
                        )
                      ) : derivedHomeOperators.length === 0 ? (
                        <Text style={styles.cardHintSm}>No DO operators yet.</Text>
                      ) : (
                        derivedHomeOperators.map((op, idx) => {
                          const overdue = Number(op.overdue) || 0;
                          const pending = Number(op.pending) || 0;
                          const mornDone = Number(op.morning_completed) || 0;
                          const mornExp = Number(op.morning_expected) || 0;
                          const eveDone = Number(op.evening_completed) || 0;
                          const eveExp = Number(op.evening_expected) || 0;
                          const todayIn = Number(op.today_inward) || 0;
                          const todayOut = Number(op.today_outward) || 0;
                          const color =
                            overdue > 0 ? '#dc2626' : pending > 0 ? '#d97706' : '#059669';
                          return (
                            <TouchableOpacity
                              key={`${op.id || op.email || op.name}-${idx}`}
                              style={[styles.doOverviewDoRow, idx > 0 && styles.doOverviewRowBorder]}
                              activeOpacity={0.85}
                              onPress={() => openDoProfile(op, op.warehouse_name)}
                            >
                              <View style={styles.doOverviewRowTop}>
                                <View style={[styles.doOverviewDotSm, { backgroundColor: color }]} />
                                <View style={{ flex: 1, minWidth: 0 }}>
                                  <Text style={styles.doOverviewWh} numberOfLines={1}>
                                    {op.name || 'DO'}
                                  </Text>
                                  <Text style={styles.doOverviewMeta} numberOfLines={1}>
                                    {op.warehouse_name || 'Unassigned'}
                                    {op.email ? ` · ${op.email}` : ''}
                                  </Text>
                                </View>
                                <Ionicons name="chevron-forward" size={16} color="#94a3b8" />
                              </View>
                              <View style={styles.doCountPillsWrap}>
                                <View style={[styles.doCountPill, styles.doCountPillDone]}>
                                  <Text style={[styles.doCountPillNum, { color: '#059669' }]}>
                                    {mornDone}/{mornExp}
                                  </Text>
                                  <Text style={[styles.doCountPillLbl, { color: '#059669' }]}>Mor</Text>
                                </View>
                                <View style={[styles.doCountPill, { backgroundColor: '#eff6ff' }]}>
                                  <Text style={[styles.doCountPillNum, { color: '#003580' }]}>
                                    {eveDone}/{eveExp}
                                  </Text>
                                  <Text style={[styles.doCountPillLbl, { color: '#003580' }]}>Evn</Text>
                                </View>
                                <View style={[styles.doCountPill, styles.doCountPillOver]}>
                                  <Text style={[styles.doCountPillNum, { color: '#dc2626' }]}>
                                    {overdue}
                                  </Text>
                                  <Text style={[styles.doCountPillLbl, { color: '#dc2626' }]}>Over</Text>
                                </View>
                                <View style={[styles.doCountPill, { backgroundColor: '#e6f4ea' }]}>
                                  <Text style={[styles.doCountPillNum, { color: '#137333' }]}>
                                    {todayIn}
                                  </Text>
                                  <Text style={[styles.doCountPillLbl, { color: '#137333' }]}>
                                    Today In
                                  </Text>
                                </View>
                                <View style={[styles.doCountPill, { backgroundColor: '#f3e8fd' }]}>
                                  <Text style={[styles.doCountPillNum, { color: '#7627bb' }]}>
                                    {todayOut}
                                  </Text>
                                  <Text style={[styles.doCountPillLbl, { color: '#7627bb' }]}>
                                    Today Out
                                  </Text>
                                </View>
                              </View>
                            </TouchableOpacity>
                          );
                        })
                    )}
                    </View>
                  </View>
                </>
              )}
            </>
          )}

          {activeTab === 'More' && (
            <>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Profile</Text>
                <Text style={styles.profileRow}>
                  <Text style={styles.profileKey}>Role: </Text>
                  <Text style={styles.profileVal}>Sub-Admin (full mobile access)</Text>
                </Text>
                <Text style={styles.profileRow}>
                  <Text style={styles.profileKey}>Name: </Text>
                  <Text style={styles.profileVal}>{displayName}</Text>
                </Text>
                <Text style={styles.profileRow}>
                  <Text style={styles.profileKey}>Email: </Text>
                  <Text style={styles.profileVal}>{user?.email || '—'}</Text>
                </Text>
                <Text style={styles.profileRow}>
                  <Text style={styles.profileKey}>Phone: </Text>
                  <Text style={styles.profileVal}>{user?.phone_no || '—'}</Text>
                </Text>
              </View>

              <TouchableOpacity
                style={styles.logoutBtn}
                onPress={handleLogoutPress}
                disabled={busy}
                activeOpacity={0.85}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons name="log-out-outline" size={16} color="#fff" />
                    <Text style={styles.logoutText}>Logout</Text>
                  </>
                )}
              </TouchableOpacity>

              <View style={styles.aboutFooter}>
                <Image
                  source={require('../../assets/logo-transparent.png')}
                  style={styles.aboutLogo}
                  resizeMode="contain"
                />
                <Text style={styles.aboutTitle}>About ReeferON</Text>
                <Text style={styles.aboutBody}>
                  Sub-Admin can monitor all cold-chain logs and inventory reports across the
                  operation — separate from scoped Customer accounts.
                </Text>
                <TouchableOpacity onPress={() => Linking.openURL('tel:+917678047222')}>
                  <Text style={styles.aboutContact}>+91 76780 47222</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </ScrollView>
      )}

      {/* Filter pickers */}
      <Modal visible={openFilter != null} transparent animationType="fade" onRequestClose={() => setOpenFilter(null)}>
        <TouchableOpacity style={styles.sheetOverlay} activeOpacity={1} pressBorder={false} onPress={() => setOpenFilter(null)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>
              {openFilter === 'warehouse' || openFilter === 'reportWarehouse'
                ? 'Select warehouse'
                : openFilter === 'chamber'
                  ? 'Select chamber'
                : 'Select client'}
            </Text>
            <ScrollView style={{ maxHeight: 320 }}>
              {(openFilter === 'warehouse'
                ? warehouseOptions
                : openFilter === 'chamber'
                  ? chamberOptions
                : openFilter === 'reportWarehouse'
                  ? reportWarehouseOptions
                  : openFilter === 'reportClient'
                    ? reportClientOptions
                    : clientOptions
              ).map((opt) => (
                <TouchableOpacity
                  key={opt}
                  style={styles.sheetItem}
                  onPress={() => pickFilterOption(opt)}
                >
                  <Text style={styles.sheetItemText}>{opt}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Calendar */}
      <Modal visible={showCalendarModal} transparent animationType="fade" onRequestClose={() => setShowCalendarModal(false)}>
        <View style={styles.sheetOverlay}>
          <View style={styles.calendarSheet}>
            <View style={styles.calendarHead}>
              <TouchableOpacity
                onPress={() =>
                  setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))
                }
              >
                <Ionicons name="chevron-back" size={22} color="#003580" />
              </TouchableOpacity>
              <Text style={styles.calendarTitle}>
                {calendarMonth.toLocaleString('en-IN', { month: 'long', year: 'numeric' })}
              </Text>
              <TouchableOpacity
                onPress={() =>
                  setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))
                }
              >
                <Ionicons name="chevron-forward" size={22} color="#003580" />
              </TouchableOpacity>
            </View>
            <View style={styles.calendarGrid}>
              {getCalendarDays(calendarMonth).map((day, idx) => {
                if (!day) return <View key={`e-${idx}`} style={styles.calCell} />;
                const ymd = toLocalYmd(day);
                const selected =
                  (calendarPickMode === 'from' && dateFrom === ymd) ||
                  (calendarPickMode === 'to' && dateTo === ymd);
                return (
                  <TouchableOpacity
                    key={ymd}
                    style={[styles.calCell, selected && styles.calCellActive]}
                    onPress={() => {
                      if (calendarPickMode === 'from') applyDateRange(ymd, dateTo === 'All' ? ymd : dateTo);
                      else applyDateRange(dateFrom === 'All' ? ymd : dateFrom, ymd);
                      setShowCalendarModal(false);
                    }}
                  >
                    <Text style={[styles.calCellText, selected && styles.calCellTextActive]}>
                      {day.getDate()}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity style={styles.retryBtn} onPress={() => setShowCalendarModal(false)}>
              <Text style={styles.retryText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Log detail */}
      <Modal visible={!!selectedLog} transparent animationType="slide" onRequestClose={() => setSelectedLog(null)}>
        <View style={styles.detailOverlay}>
          <View style={styles.detailSheet}>
            <View style={styles.detailHead}>
              <Text style={styles.detailTitle}>
                {selectedLog?._logType === 'inward'
                  ? 'Inward details'
                  : selectedLog?._logType === 'outward'
                    ? 'Outward details'
                    : 'Log detail'}
              </Text>
              <TouchableOpacity onPress={() => setSelectedLog(null)}>
                <Ionicons name="close" size={22} color="#334155" />
              </TouchableOpacity>
            </View>
            {selectedLog && (
              <ScrollView contentContainerStyle={{ paddingBottom: 20 }}>
                {selectedLog._logType === 'inward' || selectedLog._logType === 'outward' ? (
                  <>
                    {(() => {
                      const item = selectedLog;
                      const isInward = item._logType === 'inward';
                      const shortQty =
                        parseInt(
                          isInward
                            ? item.inward_short_received_boxes_qty
                            : item.outward_short_received_boxes_qty,
                          10
                        ) || 0;
                      const excessQty =
                        parseInt(
                          isInward
                            ? item.inward_excess_received_boxes_qty
                            : item.outward_excess_received_boxes_qty,
                          10
                        ) || 0;
                      const damageQty =
                        parseInt(
                          isInward
                            ? item.inward_damage_received_boxes_qty
                            : item.outward_damage_received_boxes_qty,
                          10
                        ) || 0;
                      const preVehicleTemp =
                        item.outward_pre_vehicle_temp ?? item.outward_vehicle_temp;
                      const sections = isInward
                        ? [
                            {
                              title: 'Location & Operator',
                              rows: [
                                ['Warehouse', item.warehouse_name],
                                ['Warehouse code', item.warehouse_code],
                                ['Operator', item.operator_email],
                                ['Client code', item.inward_client_code]
                              ]
                            },
                            {
                              title: 'Arrival',
                              rows: [
                                [
                                  'Reference',
                                  item.reference_no ||
                                    (item.inward_id != null ? `INW-${item.inward_id}` : null)
                                ],
                                [
                                  'Entry date',
                                  item.inward_entry_date ||
                                    String(item.formatted_date || item.entry_date || '').slice(0, 10)
                                ],
                                ['Client', item.inward_client_name || item.client_name],
                                ['Dock', item.inward_dock_no],
                                ['Material', item.inward_material_type],
                                ['Vehicle no.', item.inward_vehicle_no],
                                ['Seal no.', item.inward_seal_no],
                                ['Transporter', item.inward_transporter_name],
                                ['Driver', item.inward_driver_name],
                                ['Driver phone', item.inward_driver_no]
                              ]
                            },
                            {
                              title: 'Timing',
                              rows: [
                                ['Reporting time', item.inward_vehicle_reporting_time],
                                ['Unload start', item.inward_unloading_start_time],
                                ['Unload end', item.inward_unloading_end_time],
                                [
                                  'Duration',
                                  item.inward_unloading_duration_hours != null ||
                                  item.inward_unloading_duration_mins != null
                                    ? `${item.inward_unloading_duration_hours || 0}h ${item.inward_unloading_duration_mins || 0}m`
                                    : null
                                ],
                                [
                                  'Created',
                                  item.inward_created_at
                                    ? String(item.inward_created_at).replace('T', ' ').slice(0, 19)
                                    : item.created_at
                                      ? String(item.created_at).replace('T', ' ').slice(0, 19)
                                      : null
                                ]
                              ]
                            },
                            {
                              title: 'Temperature & Quantity',
                              rows: [
                                [
                                  'Vehicle temp',
                                  item.inward_vehicle_temp != null
                                    ? `${item.inward_vehicle_temp}°C`
                                    : null
                                ],
                                [
                                  'Material temp',
                                  item.inward_material_temp != null
                                    ? `${item.inward_material_temp}°C`
                                    : null
                                ],
                                ['Pallets in', item.inward_pallets_in_qty],
                                ['Invoice boxes', item.inward_invoice_qty],
                                [
                                  'Boxes received',
                                  item.inward_received_boxes_qty ?? item.inward_received_qty
                                ],
                                ['Short qty', String(shortQty)],
                                ['Excess qty', String(excessQty)],
                                ['Damage qty', String(damageQty)],
                                ['Supervisor', item.inward_unloading_supervisor_name],
                                ['Remarks', item.inward_remarks]
                              ]
                            }
                          ]
                        : [
                            {
                              title: 'Location & Operator',
                              rows: [
                                ['Warehouse', item.warehouse_name],
                                ['Warehouse code', item.warehouse_code],
                                ['Operator', item.operator_email],
                                ['Client code', item.outward_client_code]
                              ]
                            },
                            {
                              title: 'Dispatch',
                              rows: [
                                [
                                  'Reference',
                                  item.reference_no ||
                                    (item.outward_id != null ? `OUT-${item.outward_id}` : null)
                                ],
                                [
                                  'Entry date',
                                  item.outward_entry_date ||
                                    String(item.formatted_date || item.entry_date || '').slice(0, 10)
                                ],
                                ['Client', item.outward_client_name || item.client_name],
                                ['Dock', item.outward_dock_no],
                                ['Material', item.outward_material_type],
                                ['Vehicle no.', item.outward_vehicle_no],
                                ['Seal no.', item.outward_seal_no],
                                ['Transporter', item.outward_transporter_name],
                                ['Driver', item.outward_driver_name],
                                ['Driver phone', item.outward_driver_no]
                              ]
                            },
                            {
                              title: 'Timing',
                              rows: [
                                ['Reporting time', item.outward_vehicle_reporting_time],
                                ['Load start', item.outward_loading_start_time],
                                ['Load end', item.outward_loading_end_time],
                                [
                                  'Duration',
                                  item.outward_loading_duration_hours != null ||
                                  item.outward_loading_duration_mins != null
                                    ? `${item.outward_loading_duration_hours || 0}h ${item.outward_loading_duration_mins || 0}m`
                                    : null
                                ],
                                [
                                  'Created',
                                  item.outward_created_at
                                    ? String(item.outward_created_at).replace('T', ' ').slice(0, 19)
                                    : item.created_at
                                      ? String(item.created_at).replace('T', ' ').slice(0, 19)
                                      : null
                                ]
                              ]
                            },
                            {
                              title: 'Temperature & Quantity',
                              rows: [
                                [
                                  'Pre vehicle temp',
                                  preVehicleTemp != null ? `${preVehicleTemp}°C` : null
                                ],
                                [
                                  'Material temp',
                                  item.outward_material_temp != null
                                    ? `${item.outward_material_temp}°C`
                                    : null
                                ],
                                ['Pallets out', item.outward_pallets_in_qty],
                                ['Invoice boxes', item.outward_invoice_qty],
                                [
                                  'Boxes loaded',
                                  item.outward_received_boxes_qty ??
                                    item.outward_loaded_boxes_qty ??
                                    item.outward_received_qty ??
                                    item.box_count
                                ],
                                ['Short qty', String(shortQty)],
                                ['Excess qty', String(excessQty)],
                                ['Damage qty', String(damageQty)],
                                ['Supervisor', item.outward_loading_supervisor_name],
                                ['Remarks', item.outward_remarks]
                              ]
                            }
                          ];

                      return sections.map((section) => {
                        const visibleRows = section.rows.filter(
                          ([, value]) => value != null && String(value).trim() !== ''
                        );
                        if (!visibleRows.length) return null;
                        return (
                          <View key={section.title} style={styles.logDetailSection}>
                            <Text style={styles.logDetailSectionTitle}>{section.title}</Text>
                            {visibleRows.map(([label, value]) => (
                              <View key={label} style={styles.detailRow}>
                                <Text style={styles.detailLabel}>{label}</Text>
                                <Text style={styles.detailValue}>{String(value)}</Text>
                              </View>
                            ))}
                          </View>
                        );
                      });
                    })()}

                    <View style={styles.smallImgWrap}>
                      <Text style={styles.logDetailSectionTitle}>Photos</Text>
                      {(() => {
                        const photoItems = buildInwardOutwardPhotoItems(selectedLog);
                        const folderHint =
                          selectedLog._logType === 'inward' ? 'inward_images' : 'outward_images';
                        if (!photoItems.length) {
                          return (
                            <View style={styles.smallImgEmpty}>
                              <Ionicons name="image-outline" size={18} color="#94a3b8" />
                              <Text style={styles.smallImgEmptyText}>No photos attached</Text>
                            </View>
                          );
                        }
                        return (
                          <PhotoGridWithLocation
                            photoItems={photoItems}
                            folderHint={folderHint}
                            photoMeta={selectedLog.photo_capture_metadata}
                              resolveUri={(path, hint) => {
                                const local =
                                  resolveImageUrl(path, apiUrl, hint) ||
                                  resolveImageUrl(path, PRODUCTION_API_URL, hint);
                                // Prefer local uploads; keep original Cloudinary as secondary
                                if (
                                  local &&
                                  /^https?:\/\/res\.cloudinary\.com\//i.test(String(path || ''))
                                ) {
                                  return [local, String(path).trim()];
                                }
                                return local;
                              }}
                          />
                        );
                      })()}
                    </View>
                  </>
                ) : (
                  <>
                    <View style={styles.smallImgWrap}>
                      <Text style={styles.detailLabel}>Image</Text>
                      <SmallLogImage
                        rawPath={pickLogImage(selectedLog)}
                        apiUrl={apiUrl}
                        folderHint="daily_temp_monitor_images"
                        latitude={selectedLog.photo_capture_latitude}
                        longitude={selectedLog.photo_capture_longitude}
                        accuracy={selectedLog.photo_capture_accuracy}
                      />
                    </View>
                    {[
                        ['Client', selectedLog.client_name],
                        ['Chamber', selectedLog.chamber_name],
                        ['Warehouse', selectedLog.warehouse_name],
                      [
                        'Date',
                        String(selectedLog.formatted_date || selectedLog.entry_date || '').slice(
                          0,
                          10
                        )
                      ],
                        ['Shift', selectedLog.shift || selectedLog.inspection_time],
                      [
                        'Box temp',
                        selectedLog.box_temp != null ? `${selectedLog.box_temp}°C` : null
                      ],
                        ['Boxes', selectedLog.box_count],
                        ['Reference', selectedLog.reference_no],
                        [
                          'DO name',
                          selectedLog.monitor_supervisor_name ||
                            selectedLog.do_name ||
                            (selectedLog.operator_email
                              ? String(selectedLog.operator_email).split('@')[0]
                              : null) ||
                            selectedLog.created_by
                        ],
                        [
                          'Time',
                          selectedLog.photo_capture_time ||
                            selectedLog.submit_time ||
                            (selectedLog.created_at
                              ? String(selectedLog.created_at).replace('T', ' ').slice(0, 19)
                              : null)
                        ]
                    ].map(([label, value]) =>
                  value != null && String(value).trim() !== '' ? (
                    <View key={label} style={styles.detailRow}>
                      <Text style={styles.detailLabel}>{label}</Text>
                      <Text style={styles.detailValue}>{String(value)}</Text>
                    </View>
                  ) : null
                )}
                  </>
                )}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* Inventory report detail — Excel-style day history */}
      <Modal
        visible={!!selectedReport}
        transparent
        animationType="slide"
        onRequestClose={closeReportDetail}
      >
        <View style={styles.detailOverlay}>
          <View style={styles.detailSheet}>
            <View style={styles.detailHead}>
              <View style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                <Text style={styles.detailTitle} numberOfLines={1}>
                  {selectedReport?.client_name || 'Inventory'}
                </Text>
                <Text style={styles.excelSub} numberOfLines={1}>
                  {selectedReport?.warehouse_name || 'Warehouse'}
                  {selectedReport?.chamber_name ? ` · ${selectedReport.chamber_name}` : ''}
                </Text>
              </View>
              <TouchableOpacity onPress={closeReportDetail}>
                <Ionicons name="close" size={22} color="#334155" />
              </TouchableOpacity>
            </View>

            <View style={styles.excelHead}>
              <Text style={[styles.excelHeadCell, styles.excelColDate]}>Date</Text>
              <Text style={[styles.excelHeadCell, styles.excelColTime]}>Time</Text>
              <Text style={[styles.excelHeadCell, styles.excelColTemp]}>Temp</Text>
              <Text style={[styles.excelHeadCell, styles.excelColIn]}>In</Text>
              <Text style={[styles.excelHeadCell, styles.excelColOut]}>Out</Text>
              <Text style={[styles.excelHeadCell, styles.excelColQty]}>Left</Text>
            </View>

            {reportHistoryLoading ? (
              <View style={styles.centerState}>
                <ActivityIndicator size="large" color="#003580" />
                <Text style={styles.stateText}>Loading day records…</Text>
              </View>
            ) : reportHistoryError ? (
              <View style={styles.centerState}>
                <Ionicons name="warning-outline" size={28} color="#dc2626" />
                <Text style={styles.stateText}>{reportHistoryError}</Text>
                <TouchableOpacity
                  style={styles.retryBtn}
                  onPress={() => selectedReport && openReportDetail(selectedReport)}
                >
                  <Text style={styles.retryText}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <ScrollView>
                {reportHistory.length === 0 ? (
                  <View style={styles.centerState}>
                    <Text style={styles.stateText}>No day-wise qty found for this lot.</Text>
                  </View>
                ) : (
                  reportHistory.map((row, idx) => {
                    const dateLabel = String(row.formatted_date || row.entry_date || '').slice(0, 10) || '—';
                    const timeLabel = formatReportTime(row);
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
                      <View
                        key={String(row.id || `${dateLabel}-${idx}`)}
                        style={[styles.excelRow, idx % 2 === 1 && styles.excelRowAlt]}
                      >
                        <Text style={[styles.excelCell, styles.excelColDate]} numberOfLines={1}>
                          {dateLabel}
                        </Text>
                        <Text style={[styles.excelCell, styles.excelColTime]} numberOfLines={1}>
                          {timeLabel}
                        </Text>
                        <Text style={[styles.excelCell, styles.excelColTemp]} numberOfLines={1}>
                          {temp}
                        </Text>
                        <Text
                          style={[
                            styles.excelCell,
                            styles.excelColIn,
                            inQty !== '—' && inQty !== '0' && styles.excelIn
                          ]}
                          numberOfLines={1}
                        >
                          {inQty}
                        </Text>
                        <Text
                          style={[
                            styles.excelCell,
                            styles.excelColOut,
                            outQty !== '—' && outQty !== '0' && styles.excelOut
                          ]}
                          numberOfLines={1}
                        >
                          {outQty}
                        </Text>
                        <Text style={[styles.excelCell, styles.excelColQty, styles.excelQty]} numberOfLines={1}>
                          {qty == null ? '—' : qty}
                        </Text>
                      </View>
                    );
                  })
                )}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* Notifications / incoming requests */}
      <Modal
        visible={showNotifications}
        transparent
        animationType="slide"
        onRequestClose={() => setShowNotifications(false)}
      >
        <View style={styles.notifOverlay}>
          <View style={styles.notifSheet}>
            <View style={styles.notifHead}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.notifTitle}>Role & Permission</Text>
                <Text style={styles.notifSub}>
                  {pendingNotifCount} pending request{pendingNotifCount === 1 ? '' : 's'}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setShowNotifications(false)}>
                <Ionicons name="close" size={22} color="#334155" />
              </TouchableOpacity>
            </View>

            <View style={styles.notifFilterRow}>
              {[
                { id: 'pending', label: 'Pending' },
                { id: 'all', label: 'All' },
                { id: 'decided', label: 'Approved/Denied' }
              ].map((f) => {
                const active = notifFilter === f.id;
                return (
                  <TouchableOpacity
                    key={f.id}
                    style={[styles.notifFilterChip, active && styles.notifFilterChipActive]}
                    onPress={() => setNotifFilter(f.id)}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.notifFilterText, active && styles.notifFilterTextActive]}>
                      {f.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <ScrollView contentContainerStyle={styles.notifList}>
              {filteredNotifications.length === 0 ? (
                <View style={styles.centerState}>
                  <Ionicons name="notifications-off-outline" size={28} color="#94a3b8" />
                  <Text style={styles.stateText}>No Role & Permission requests here.</Text>
                </View>
              ) : (
                filteredNotifications.map((n) => {
                  const status = String(n.status || 'Pending');
                  const statusStyle =
                    status === 'Pending'
                      ? styles.notifStatusPending
                      : status === 'Approved'
                        ? styles.notifStatusApproved
                        : status === 'Denied'
                          ? styles.notifStatusDenied
                          : styles.notifStatusOther;
                  const approving = notifActionBusy === `${n.id}-Approved`;
                  const denying = notifActionBusy === `${n.id}-Denied`;
                  return (
                    <View
                      key={String(n.id)}
                      style={[styles.notifCard, status === 'Pending' && styles.notifCardPending]}
                    >
                      <View style={styles.notifCardTop}>
                        <Text style={styles.notifCardTitle} numberOfLines={2}>
                          {getNotifTitle(n)}
                        </Text>
                        <Text style={[styles.notifStatus, statusStyle]}>{status}</Text>
                      </View>
                      <Text style={styles.notifMsg}>{getNotifMessage(n)}</Text>
                      <Text style={styles.notifMeta} numberOfLines={2}>
                        {n.operator_email || 'DO'}
                        {n.client_name ? ` · ${n.client_name}` : ''}
                        {n.chamber_name ? ` · ${n.chamber_name}` : ''}
                        {` · ${formatNotifTime(n.created_at)}`}
                      </Text>
                      {status === 'Pending' ? (
                        <View style={styles.notifActions}>
                          <TouchableOpacity
                            style={[styles.notifActionBtn, styles.notifApproveBtn]}
                            disabled={!!notifActionBusy}
                            onPress={() => respondToPermissionRequest(n.id, 'Approved')}
                            activeOpacity={0.85}
                          >
                            {approving ? (
                              <ActivityIndicator size="small" color="#fff" />
                            ) : (
                              <Text style={styles.notifActionText}>Approve</Text>
                            )}
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.notifActionBtn, styles.notifDenyBtn]}
                            disabled={!!notifActionBusy}
                            onPress={() => openDenyPermission(n.id)}
                            activeOpacity={0.85}
                          >
                            {denying ? (
                              <ActivityIndicator size="small" color="#fff" />
                            ) : (
                              <Text style={styles.notifActionText}>Deny</Text>
                            )}
                          </TouchableOpacity>
                        </View>
                      ) : null}
                    </View>
                  );
                })
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={denyModal.visible}
        transparent
        animationType="fade"
        onRequestClose={() => setDenyModal({ visible: false, id: null, remark: '' })}
      >
        <KeyboardAvoidingView
          style={styles.denyOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.denyCard}>
            <Text style={styles.denyTitle}>Deny permission</Text>
            <Text style={styles.denySub}>
              Add a remark so the DO knows why this request was denied.
            </Text>
            <TextInput
              style={styles.denyInput}
              value={denyModal.remark}
              onChangeText={(txt) => setDenyModal((prev) => ({ ...prev, remark: txt }))}
              placeholder="Reason for deny (required)"
              placeholderTextColor="#94a3b8"
              multiline
              autoFocus
            />
            <View style={styles.denyActions}>
              <TouchableOpacity
                style={styles.denyCancelBtn}
                onPress={() => setDenyModal({ visible: false, id: null, remark: '' })}
                activeOpacity={0.85}
              >
                <Text style={styles.denyCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.denyConfirmBtn}
                onPress={confirmDenyPermission}
                activeOpacity={0.85}
              >
                <Text style={styles.denyConfirmText}>Deny request</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={customerModal.visible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!customerModal.busy) closeCustomerModal();
        }}
      >
        <KeyboardAvoidingView
          style={styles.denyOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.customerModalCard}>
            <Text style={styles.denyTitle}>
              {customerModal.mode === 'edit' ? 'Edit customer' : 'Add customer'}
            </Text>
            <Text style={styles.denySub}>
              Portal login. Empty warehouse/client buttons mean All access.
            </Text>
            <ScrollView
              style={styles.customerModalScroll}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <TextInput
                style={styles.customerInput}
                value={customerForm.full_name}
                onChangeText={(txt) => setCustomerForm((p) => ({ ...p, full_name: txt }))}
                placeholder="Full name"
                placeholderTextColor="#94a3b8"
              />
              <TextInput
                style={styles.customerInput}
                value={customerForm.email}
                onChangeText={(txt) => setCustomerForm((p) => ({ ...p, email: txt }))}
                placeholder="Email"
                placeholderTextColor="#94a3b8"
                autoCapitalize="none"
                keyboardType="email-address"
              />
              <TextInput
                style={styles.customerInput}
                value={customerForm.phone_no}
                onChangeText={(txt) => setCustomerForm((p) => ({ ...p, phone_no: txt }))}
                placeholder="Phone"
                placeholderTextColor="#94a3b8"
                keyboardType="phone-pad"
              />
              <TextInput
                style={styles.customerInput}
                value={customerForm.password}
                onChangeText={(txt) => setCustomerForm((p) => ({ ...p, password: txt }))}
                placeholder={
                  customerModal.mode === 'edit' ? 'New password (optional)' : 'Password'
                }
                placeholderTextColor="#94a3b8"
                secureTextEntry
              />
              <Text style={styles.customerChipLabel}>Warehouses</Text>
              <Text style={styles.cardHintSm}>
                {splitCsv(customerForm.allowed_warehouses).length
                  ? 'Clients below are only for the selected warehouse(s).'
                  : 'No warehouse selected = all sites. Clients are grouped by warehouse.'}
              </Text>
              <View style={styles.customerChipWrap}>
                {customerScopeWarehouses.length === 0 ? (
                  <Text style={styles.cardHintSm}>No warehouses in scope yet.</Text>
                ) : (
                  customerScopeWarehouses.map((name) => {
                    const on = csvHas(customerForm.allowed_warehouses, name);
                    return (
                      <TouchableOpacity
                        key={name}
                        style={[styles.customerChip, on && styles.customerChipOn]}
                        onPress={() =>
                          setCustomerForm((p) => {
                            const allowed_warehouses = toggleCsvValue(
                              p.allowed_warehouses,
                              name
                            );
                            return {
                              ...p,
                              allowed_warehouses,
                              allowed_clients: pruneClientsForWarehouses(
                                allowed_warehouses,
                                p.allowed_clients
                              )
                            };
                          })
                        }
                        activeOpacity={0.85}
                      >
                        <Text style={[styles.customerChipText, on && styles.customerChipTextOn]}>
                          {name}
                        </Text>
                      </TouchableOpacity>
                    );
                  })
                )}
              </View>
              <Text style={styles.customerChipLabel}>Clients</Text>
              {customerScopeClientGroups.length === 0 ? (
                <Text style={styles.cardHintSm}>No warehouses to load clients from.</Text>
              ) : (
                customerScopeClientGroups.map((group) => (
                  <View key={group.warehouse} style={{ marginBottom: 8 }}>
                    <Text style={styles.customerChipGroupLbl}>{group.warehouse}</Text>
                    <View style={styles.customerChipWrap}>
                      {group.clients.length === 0 ? (
                        <Text style={styles.cardHintSm}>No clients in this warehouse.</Text>
                      ) : (
                        group.clients.map((name) => {
                          const on = csvHas(customerForm.allowed_clients, name);
                          return (
                            <TouchableOpacity
                              key={`${group.warehouse}-${name}`}
                              style={[styles.customerChip, on && styles.customerChipOn]}
                              onPress={() =>
                                setCustomerForm((p) => ({
                                  ...p,
                                  allowed_clients: toggleCsvValue(p.allowed_clients, name)
                                }))
                              }
                              activeOpacity={0.85}
                            >
                              <Text
                                style={[styles.customerChipText, on && styles.customerChipTextOn]}
                              >
                                {name}
                              </Text>
                            </TouchableOpacity>
                          );
                        })
                      )}
                    </View>
                  </View>
                ))
              )}
            </ScrollView>
            <View style={styles.denyActions}>
              <TouchableOpacity
                style={styles.denyCancelBtn}
                disabled={customerModal.busy}
                onPress={closeCustomerModal}
                activeOpacity={0.85}
              >
                <Text style={styles.denyCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.customerSaveBtn}
                disabled={customerModal.busy}
                onPress={saveCustomer}
                activeOpacity={0.85}
              >
                {customerModal.busy ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.customerSaveText}>
                    {customerModal.mode === 'edit' ? 'Update' : 'Create'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={catalogModal.visible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!catalogModal.busy) closeCatalogModal();
        }}
      >
        <KeyboardAvoidingView
          style={styles.denyOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.customerModalCard}>
            <Text style={styles.denyTitle}>
              {catalogModal.kind === 'client'
                ? catalogModal.mode === 'edit'
                  ? 'Edit client'
                  : 'Add client'
                : catalogModal.mode === 'edit'
                  ? 'Edit warehouse'
                  : 'Add warehouse'}
            </Text>
            <Text style={styles.denySub}>
              {catalogModal.kind === 'client'
                ? 'Company in the catalog. Optional warehouse ties it to a site.'
                : 'Name auto-makes WH-PUNE-01, WH-PUNE-02… City is optional only.'}
            </Text>
            <ScrollView
              style={styles.customerModalScroll}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {catalogModal.kind === 'client' ? (
                <>
                  <TextInput
                    style={styles.customerInput}
                    value={clientForm.client_name}
                    onChangeText={(txt) => {
                      clientCodeManualRef.current = false;
                      setClientForm((p) => ({ ...p, client_name: txt }));
                    }}
                    placeholder="Client name"
                    placeholderTextColor="#94a3b8"
                  />
                  <TextInput
                    style={[
                      styles.customerInput,
                      catalogModal.mode === 'edit' && styles.customerInputLocked
                    ]}
                    value={clientForm.client_code}
                    onChangeText={(txt) => {
                      clientCodeManualRef.current = true;
                      setClientForm((p) => ({ ...p, client_code: txt.toUpperCase() }));
                    }}
                    placeholder="Code (CL-… auto)"
                    placeholderTextColor="#94a3b8"
                    autoCapitalize="characters"
                    editable={catalogModal.mode !== 'edit'}
                  />
                  <Text style={styles.customerChipLabel}>Warehouse</Text>
                  <View style={styles.customerChipWrap}>
                    <TouchableOpacity
                      style={[
                        styles.customerChip,
                        !clientForm.warehouse_name && styles.customerChipOn
                      ]}
                      onPress={() =>
                        setClientForm((p) => ({
                          ...p,
                          warehouse_name: '',
                          warehouse_code: ''
                        }))
                      }
                      activeOpacity={0.85}
                    >
                      <Text
                        style={[
                          styles.customerChipText,
                          !clientForm.warehouse_name && styles.customerChipTextOn
                        ]}
                      >
                        All
                      </Text>
                    </TouchableOpacity>
                    {activeCatalogWarehouses.map((w) => {
                      const on = clientForm.warehouse_name === w.warehouse_name;
                      return (
                        <TouchableOpacity
                          key={String(w.id)}
                          style={[styles.customerChip, on && styles.customerChipOn]}
                          onPress={() =>
                            setClientForm((p) => ({
                              ...p,
                              warehouse_name: w.warehouse_name,
                              warehouse_code: w.warehouse_code || ''
                            }))
                          }
                          activeOpacity={0.85}
                        >
                          <Text style={[styles.customerChipText, on && styles.customerChipTextOn]}>
                            {w.warehouse_name}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </>
              ) : (
                <>
                  <TextInput
                    style={styles.customerInput}
                    value={warehouseForm.warehouse_name}
                    onChangeText={(txt) => {
                      warehouseCodeManualRef.current = false;
                      setWarehouseForm((p) => ({ ...p, warehouse_name: txt }));
                    }}
                    placeholder="Warehouse name (e.g. Pune)"
                    placeholderTextColor="#94a3b8"
                  />
                  <TextInput
                    style={styles.customerInput}
                    value={warehouseForm.city}
                    onChangeText={(txt) => {
                      setWarehouseForm((p) => ({ ...p, city: txt }));
                    }}
                    placeholder="City (optional)"
                    placeholderTextColor="#94a3b8"
                  />
                  <TextInput
                    style={[
                      styles.customerInput,
                      styles.customerInputLocked
                    ]}
                    value={warehouseForm.warehouse_code}
                    placeholder="Code auto WH-PUNE-01"
                    placeholderTextColor="#94a3b8"
                    autoCapitalize="characters"
                    editable={false}
                  />
                </>
              )}
            </ScrollView>
            <View style={styles.denyActions}>
              <TouchableOpacity
                style={styles.denyCancelBtn}
                disabled={catalogModal.busy}
                onPress={closeCatalogModal}
                activeOpacity={0.85}
              >
                <Text style={styles.denyCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.customerSaveBtn}
                disabled={catalogModal.busy}
                onPress={saveCatalogRecord}
                activeOpacity={0.85}
              >
                {catalogModal.busy ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.customerSaveText}>
                    {catalogModal.mode === 'edit' ? 'Update' : 'Create'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={!!selectedDoProfile && !catalogModal.visible}
        animationType="slide"
        onRequestClose={() => {
          setDoProfileEditing(false);
          setSelectedDoProfile(null);
        }}
      >
        <View style={styles.doProfileOverlay}>
          <View style={styles.doProfileSheet}>
            <View style={styles.doProfileHandle} />
            <View style={styles.detailHead}>
              <View style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                <Text style={styles.detailTitle} numberOfLines={1}>
                  DO profile
                </Text>
                <Text style={styles.excelSub} numberOfLines={1}>
                  {selectedDoProfile?.name || 'Data Operator'}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => {
                  setDoProfileEditing(false);
                  setSelectedDoProfile(null);
                }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>

            {selectedDoProfile ? (
              <ScrollView
                style={{ flex: 1 }}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingBottom: 28 }}
                keyboardShouldPersistTaps="handled"
              >
                <View style={styles.doProfileHero}>
                  <View style={styles.doProfileHeroAvatar}>
                    <Ionicons name="person" size={28} color="#003580" />
                  </View>
                  <Text style={styles.doProfileHeroName} numberOfLines={2}>
                    {selectedDoProfile.name}
                  </Text>
                  <Text style={styles.doProfileHeroRole}>Data Operator</Text>
                </View>

                <View style={styles.doProfileCard}>
                  <View style={styles.doProfileCardHead}>
                    <Text style={styles.doProfileSectionTitle}>Profile</Text>
                    <TouchableOpacity
                      onPress={() => {
                        if (doProfileEditing) {
                          setDoProfileEditing(false);
                          setDoProfileForm({
                            full_name:
                              selectedDoProfile.full_name || selectedDoProfile.name || '',
                            phone_no: String(selectedDoProfile.phone_no || '').replace(
                              /^\+91/,
                              ''
                            ),
                            warehouse_name: selectedDoProfile.warehouse_name || '',
                            chamber_limit:
                              selectedDoProfile.chamber_limit != null
                                ? String(selectedDoProfile.chamber_limit)
                                : '4'
                          });
                        } else {
                          setDoProfileEditing(true);
                        }
                      }}
                    >
                      <Text style={styles.doProfileEditLink}>
                        {doProfileEditing ? 'Cancel' : 'Edit'}
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {doProfileEditing ? (
                    <>
                      {[
                        ['full_name', 'Full name'],
                        ['phone_no', 'Phone'],
                        ['warehouse_name', 'Warehouse']
                      ].map(([key, label]) => (
                        <View key={key} style={styles.doProfileField}>
                          <Text style={styles.doProfileLabel}>{label}</Text>
                          <TextInput
                            style={styles.doProfileInput}
                            value={String(doProfileForm[key] || '')}
                            onChangeText={(t) =>
                              setDoProfileForm((p) => ({ ...p, [key]: t }))
                            }
                            keyboardType={key === 'phone_no' ? 'number-pad' : 'default'}
                            placeholder={label}
                            placeholderTextColor="#94a3b8"
                          />
                        </View>
                      ))}
                      <View style={styles.doProfileRow}>
                        <Text style={styles.doProfileLabel}>Email</Text>
                        <Text style={styles.doProfileValue}>
                          {selectedDoProfile.email || '—'}
                        </Text>
                      </View>
                      <TouchableOpacity
                        style={[styles.doMasterSetupBtn, { marginTop: 12, marginBottom: 0 }]}
                        onPress={saveDoProfileEdits}
                        disabled={doProfileBusy}
                      >
                        {doProfileBusy ? (
                          <ActivityIndicator size="small" color="#fff" />
                        ) : (
                          <>
                            <Ionicons name="save-outline" size={16} color="#fff" />
                            <Text style={styles.doMasterSetupBtnText}>Save profile</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    </>
                  ) : (
                    [
                      ['Full name', selectedDoProfile.full_name || selectedDoProfile.name],
                      ['Email', selectedDoProfile.email],
                      ['Phone', selectedDoProfile.phone_no],
                      ['Warehouse', selectedDoProfile.warehouse_name],
                      ['Warehouse code', selectedDoProfile.warehouse_code]
                    ]
                      .filter(([, v]) => v != null && String(v).trim() !== '')
                      .map(([label, value]) => (
                        <View key={label} style={styles.doProfileRow}>
                          <Text style={styles.doProfileLabel}>{label}</Text>
                          <Text style={styles.doProfileValue}>{String(value)}</Text>
                        </View>
                      ))
                  )}
                </View>

                <View style={styles.doProfileCard}>
                  <Text style={[styles.doProfileSectionTitle, { marginBottom: 4 }]}>
                    Today's tasks · Mor / Evn
                  </Text>
                  <Text style={[styles.doProfileHeroRole, { marginBottom: 10, textAlign: 'left' }]}>
                    {toLocalYmd()} · Today
                  </Text>
                  <View style={styles.doProfileStatRow}>
                    <View style={[styles.doProfileStatPill, { backgroundColor: '#ecfdf5' }]}>
                      <Text style={[styles.doProfileStatNum, { color: '#059669' }]}>
                        {Number(selectedDoProfile.morning_completed) || 0}
                        <Text style={{ fontSize: 12, fontWeight: '700' }}>
                          /{Number(selectedDoProfile.morning_expected) || 0}
                        </Text>
                      </Text>
                      <Text style={[styles.doProfileStatLbl, { color: '#059669' }]}>Morning</Text>
                    </View>
                    <View style={[styles.doProfileStatPill, { backgroundColor: '#eff6ff' }]}>
                      <Text style={[styles.doProfileStatNum, { color: '#003580' }]}>
                        {Number(selectedDoProfile.evening_completed) || 0}
                        <Text style={{ fontSize: 12, fontWeight: '700' }}>
                          /{Number(selectedDoProfile.evening_expected) || 0}
                        </Text>
                      </Text>
                      <Text style={[styles.doProfileStatLbl, { color: '#003580' }]}>Evening</Text>
                    </View>
                    <View style={[styles.doProfileStatPill, { backgroundColor: '#fef2f2' }]}>
                      <Text style={[styles.doProfileStatNum, { color: '#dc2626' }]}>
                        {selectedDoProfile.overdue}
                      </Text>
                      <Text style={[styles.doProfileStatLbl, { color: '#dc2626' }]}>Overdue</Text>
                    </View>
                  </View>
                </View>

                <View style={styles.doProfileCard}>
                  <Text style={[styles.doProfileSectionTitle, { marginBottom: 10 }]}>
                    Inward / Outward
                  </Text>
                  <View style={[styles.doProfileStatRow, { marginBottom: 8 }]}>
                    <View style={[styles.doProfileStatPill, { backgroundColor: '#e8f0fe', flex: 1 }]}>
                      <Text style={[styles.doProfileStatNum, { color: '#1967d2' }]}>
                        {Number(selectedDoProfile.total_inward) || 0}
                      </Text>
                      <Text style={[styles.doProfileStatLbl, { color: '#1967d2' }]}>Total In</Text>
                    </View>
                    <View style={[styles.doProfileStatPill, { backgroundColor: '#fef7e0', flex: 1 }]}>
                      <Text style={[styles.doProfileStatNum, { color: '#e37400' }]}>
                        {Number(selectedDoProfile.total_outward) || 0}
                      </Text>
                      <Text style={[styles.doProfileStatLbl, { color: '#e37400' }]}>Total Out</Text>
                    </View>
                  </View>
                  <View style={styles.doProfileStatRow}>
                    <View style={[styles.doProfileStatPill, { backgroundColor: '#e6f4ea', flex: 1 }]}>
                      <Text style={[styles.doProfileStatNum, { color: '#137333' }]}>
                        {Number(selectedDoProfile.today_inward) || 0}
                      </Text>
                      <Text style={[styles.doProfileStatLbl, { color: '#137333' }]}>Today In</Text>
                    </View>
                    <View style={[styles.doProfileStatPill, { backgroundColor: '#f3e8fd', flex: 1 }]}>
                      <Text style={[styles.doProfileStatNum, { color: '#7627bb' }]}>
                        {Number(selectedDoProfile.today_outward) || 0}
                      </Text>
                      <Text style={[styles.doProfileStatLbl, { color: '#7627bb' }]}>Today Out</Text>
                    </View>
                  </View>
                </View>

                {selectedDoProfile.warehouse_name ? (
                  <View style={styles.doProfileCard}>
                    <View style={styles.doProfileCardHead}>
                      <Text style={styles.doProfileSectionTitle}>Chambers & clients</Text>
                      <TouchableOpacity onPress={loadDoProfileAssignments}>
                        <Ionicons name="refresh" size={16} color="#003580" />
                      </TouchableOpacity>
                    </View>
                    {doProfileAssignLoading ? (
                      <ActivityIndicator color="#003580" style={{ marginVertical: 12 }} />
                    ) : doProfileChamberGroups.length === 0 ? (
                      <Text style={styles.doProfileEmptyAssign}>
                        No chamber–client assignments yet.
                      </Text>
                    ) : (
                      doProfileChamberGroups.map((ch) => (
                        <View key={String(ch.id)} style={styles.doProfileChamberBlock}>
                          <View style={styles.doProfileChamberHead}>
                            <Text style={styles.doProfileChamberName}>{ch.name}</Text>
                            <View style={styles.doProfileTypePill}>
                              <Text style={styles.doProfileTypeText}>{ch.type}</Text>
                            </View>
                          </View>
                          <Text style={styles.doProfileClientsLine}>
                            Active ({ch.active.length}):{' '}
                            {ch.active.length ? ch.active.join(' · ') : '—'}
                          </Text>
                          <Text
                            style={[styles.doProfileClientsLine, { color: '#94a3b8' }]}
                          >
                            Deactive ({ch.deactive.length}):{' '}
                            {ch.deactive.length ? ch.deactive.join(' · ') : '—'}
                          </Text>
                        </View>
                      ))
                    )}
                    <TouchableOpacity
                      style={styles.doMasterSetupBtn}
                      onPress={() => setShowDoMasterSetup(true)}
                      activeOpacity={0.85}
                    >
                      <Ionicons name="create-outline" size={18} color="#fff" />
                      <Text style={styles.doMasterSetupBtnText}>Edit chambers & clients</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}

                <TouchableOpacity
                  style={styles.doProfileDoneBtn}
                  onPress={() => {
                    setDoProfileEditing(false);
                    setSelectedDoProfile(null);
                  }}
                  activeOpacity={0.85}
                >
                  <Text style={styles.doProfileDoneBtnText}>Done</Text>
                </TouchableOpacity>
              </ScrollView>
            ) : null}
          </View>
        </View>
      </Modal>

      <SubAdminDoMasterSetup
        visible={showDoMasterSetup && !!selectedDoProfile?.warehouse_name}
        onClose={({ hadChanges } = {}) => {
          setShowDoMasterSetup(false);
          loadDoProfileAssignments();
          if (hadChanges) {
            showSavedChanges(
              'Changes saved',
              'Chamber and client updates were saved successfully.'
            );
          }
        }}
        apiUrl={apiUrl}
        token={token}
        authHeaders={authHeaders}
        warehouseName={selectedDoProfile?.warehouse_name}
        warehouseCode={selectedDoProfile?.warehouse_code}
        operatorEmail={selectedDoProfile?.email}
        operatorName={selectedDoProfile?.name || selectedDoProfile?.full_name}
        operatorId={selectedDoProfile?.id}
        operatorPhone={selectedDoProfile?.phone_no}
        chamberLimit={selectedDoProfile?.chamber_limit}
        onChamberLimitChange={(next) => {
          setSelectedDoProfile((prev) =>
            prev ? { ...prev, chamber_limit: next } : prev
          );
        }}
      />

      <SavedChangesPopup
        visible={savedPopup.visible}
        title={savedPopup.title}
        message={savedPopup.message}
        onDone={() => setSavedPopup((p) => ({ ...p, visible: false }))}
      />

      <Modal
        visible={showDrawer}
        transparent
        animationType="none"
        onRequestClose={closeDrawer}
      >
        <View style={styles.drawerOverlay}>
          <Animated.View
            style={[styles.drawerPanel, { transform: [{ translateX: drawerAnim }] }]}
          >
            <View style={styles.drawerHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                <View style={styles.drawerUserAvatar}>
                  <Ionicons name="person" size={18} color="#003580" />
                </View>
                <View style={{ marginLeft: 10, flex: 1 }}>
                  <Text style={styles.drawerUserName} numberOfLines={1}>
                    {displayName}
                  </Text>
                  <Text style={styles.drawerUserRole}>Sub-Admin</Text>
                </View>
              </View>
              <TouchableOpacity onPress={closeDrawer} style={{ marginLeft: 10 }}>
                <Ionicons name="close-circle-outline" size={26} color="#64748b" />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.drawerMenuScroll} showsVerticalScrollIndicator={false}>
              <TouchableOpacity
                style={[
                  styles.drawerMenuItem,
                  activeTab === 'Dashboard' && styles.drawerMenuItemActive
                ]}
                onPress={() => {
                  setActiveTab('Dashboard');
                  closeDrawer();
                }}
              >
                <Ionicons
                  name={activeTab === 'Dashboard' ? 'home' : 'home-outline'}
                  size={20}
                  color={activeTab === 'Dashboard' ? '#003580' : '#475569'}
                  style={{ marginRight: 12 }}
                />
                <Text
                  style={[
                    styles.drawerMenuText,
                    activeTab === 'Dashboard' && styles.drawerMenuTextActive
                  ]}
                >
                  Dashboard
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.drawerMenuItem, activeTab === 'Logs' && styles.drawerMenuItemActive]}
                onPress={() => {
                  setActiveTab('Logs');
                  closeDrawer();
                }}
              >
                <Ionicons
                  name={activeTab === 'Logs' ? 'list' : 'list-outline'}
                  size={20}
                  color={activeTab === 'Logs' ? '#003580' : '#475569'}
                  style={{ marginRight: 12 }}
                />
                <Text
                  style={[
                    styles.drawerMenuText,
                    activeTab === 'Logs' && styles.drawerMenuTextActive
                  ]}
                >
                  Logs
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.drawerMenuItem,
                  activeTab === 'Reports' && styles.drawerMenuItemActive
                ]}
                onPress={() => {
                  setActiveTab('Reports');
                  closeDrawer();
                }}
              >
                <Ionicons
                  name={activeTab === 'Reports' ? 'stats-chart' : 'stats-chart-outline'}
                  size={20}
                  color={activeTab === 'Reports' ? '#003580' : '#475569'}
                  style={{ marginRight: 12 }}
                />
                <Text
                  style={[
                    styles.drawerMenuText,
                    activeTab === 'Reports' && styles.drawerMenuTextActive
                  ]}
                >
                  Reports
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.drawerMenuItem,
                  activeTab === 'Admin' && styles.drawerMenuItemActive
                ]}
                onPress={() => {
                  setAdminInitialSection('permissions');
                  setActiveTab('Admin');
                  closeDrawer();
                }}
              >
                <Ionicons
                  name={activeTab === 'Admin' ? 'construct' : 'construct-outline'}
                  size={20}
                  color={activeTab === 'Admin' ? '#003580' : '#475569'}
                  style={{ marginRight: 12 }}
                />
                <Text
                  style={[
                    styles.drawerMenuText,
                    activeTab === 'Admin' && styles.drawerMenuTextActive
                  ]}
                >
                  Admin
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.drawerMenuItem, activeTab === 'More' && styles.drawerMenuItemActive]}
                onPress={() => {
                  setActiveTab('More');
                  closeDrawer();
                }}
              >
                <Ionicons
                  name={activeTab === 'More' ? 'person' : 'person-outline'}
                  size={20}
                  color={activeTab === 'More' ? '#003580' : '#475569'}
                  style={{ marginRight: 12 }}
                />
                <Text
                  style={[
                    styles.drawerMenuText,
                    activeTab === 'More' && styles.drawerMenuTextActive
                  ]}
                >
                  More
                </Text>
              </TouchableOpacity>
            </ScrollView>

            <View style={styles.drawerFooter}>
              <TouchableOpacity
                style={styles.drawerLogoutBtn}
                onPress={() => {
                  closeDrawer();
                  handleLogoutPress();
                }}
              >
                <Ionicons
                  name="log-out-outline"
                  size={20}
                  color="#ef4444"
                  style={{ marginRight: 12 }}
                />
                <Text style={styles.drawerLogoutText}>Logout</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>

          <TouchableOpacity
            style={styles.drawerBackdrop}
            activeOpacity={1}
            onPress={closeDrawer}
          />
        </View>
      </Modal>

      <View
        style={styles.tabBar}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          if (!w || Math.abs(w - tabBarWidthRef.current) < 1) return;
          tabBarWidthRef.current = w;
          const tabW = w / SUBADMIN_BOTTOM_TAB_COUNT;
          setTabIndicatorWidth(Math.max(28, tabW * 0.5));
          slideTabIndicator(getSubAdminBottomTabIndex(activeTab), w, false);
        }}
      >
        {tabIndicatorWidth > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.tabBarActiveLine,
              {
                width: tabIndicatorWidth,
                transform: [{ translateX: tabIndicatorX }]
              }
            ]}
          />
        ) : null}
        {SUBADMIN_BOTTOM_TABS.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <TouchableOpacity
              key={tab.id}
              style={styles.tabItem}
              onPress={() => {
                if (tab.id === 'Admin') setAdminInitialSection('permissions');
                setActiveTab(tab.id);
              }}
              activeOpacity={0.85}
            >
              <Ionicons
                name={active ? tab.icon : tab.iconOutline}
                size={22}
                color={active ? '#003580' : '#64748b'}
              />
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f8fafc' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 24) + 4 : 4,
    paddingBottom: 14,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0'
  },
  headerSide: {
    width: 48,
    alignItems: 'flex-start',
    justifyContent: 'center'
  },
  headerSideRight: {
    alignItems: 'flex-end'
  },
  headerCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8
  },
  menuBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#eff6ff'
  },
  headerLogo: { width: 44, height: 44 },
  headerTitleWrap: {
    alignItems: 'flex-start'
  },
  headerTitle: { fontSize: 16, fontWeight: '800', color: '#0f172a', lineHeight: 18 },
  headerMobileSub: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b',
    marginTop: 1,
    letterSpacing: 0.4,
    textTransform: 'lowercase'
  },
  headerSub: { fontSize: 12, color: '#64748b', maxWidth: 140 },
  drawerOverlay: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: 'rgba(15, 23, 42, 0.4)'
  },
  drawerBackdrop: {
    flex: 1,
    height: '100%'
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
    elevation: 16
  },
  drawerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderColor: '#f1f5f9'
  },
  drawerUserAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#e0e7ff',
    alignItems: 'center',
    justifyContent: 'center'
  },
  drawerUserName: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#0f172a'
  },
  drawerUserRole: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 1,
    fontWeight: '600'
  },
  drawerMenuScroll: {
    flex: 1,
    paddingHorizontal: 16
  },
  drawerMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginBottom: 6
  },
  drawerMenuItemActive: {
    backgroundColor: '#eff6ff'
  },
  drawerMenuText: {
    fontSize: 13,
    color: '#475569',
    fontWeight: '600'
  },
  drawerMenuTextActive: {
    color: '#003580',
    fontWeight: 'bold'
  },
  drawerFooter: {
    paddingHorizontal: 16,
    paddingVertical: 15,
    borderTopWidth: 1,
    borderColor: '#f1f5f9',
    marginBottom: Platform.OS === 'ios' ? 25 : 10
  },
  drawerLogoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8
  },
  drawerLogoutText: {
    fontSize: 13,
    color: '#ef4444',
    fontWeight: 'bold'
  },
  bellBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#dbeafe'
  },
  bellBadge: {
    position: 'absolute',
    top: -2,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#dc2626',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
    borderWidth: 1.5,
    borderColor: '#fff'
  },
  bellBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999
  },
  badgeText: { fontSize: 11, fontWeight: '700', color: '#003580' },
  notifOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'flex-end'
  },
  notifSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    maxHeight: '82%',
    paddingBottom: 12
  },
  notifHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0'
  },
  notifTitle: { fontSize: 16, fontWeight: '800', color: '#0f172a' },
  notifSub: { fontSize: 11, color: '#64748b', fontWeight: '600', marginTop: 2 },
  notifFilterRow: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  notifFilterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  notifFilterChipActive: { backgroundColor: '#003580', borderColor: '#003580' },
  notifFilterText: { fontSize: 11, fontWeight: '700', color: '#64748b' },
  notifFilterTextActive: { color: '#fff' },
  notifList: { paddingHorizontal: 12, paddingBottom: 20 },
  notifCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  notifCardPending: { borderColor: '#fde68a', backgroundColor: '#fffbeb' },
  notifCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 6
  },
  notifCardTitle: { fontSize: 13, fontWeight: '800', color: '#0f172a', flex: 1 },
  notifStatus: {
    fontSize: 10,
    fontWeight: '800',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: 'hidden'
  },
  notifStatusPending: { color: '#d97706', backgroundColor: '#fef3c7' },
  notifStatusApproved: { color: '#059669', backgroundColor: '#d1fae5' },
  notifStatusDenied: { color: '#dc2626', backgroundColor: '#fee2e2' },
  notifStatusOther: { color: '#64748b', backgroundColor: '#f1f5f9' },
  notifMsg: { fontSize: 12, color: '#334155', lineHeight: 18, fontWeight: '600' },
  notifMeta: { fontSize: 10, color: '#94a3b8', fontWeight: '600', marginTop: 8 },
  notifActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  notifActionBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: 8,
    minHeight: 36
  },
  notifApproveBtn: { backgroundColor: '#059669' },
  notifDenyBtn: { backgroundColor: '#dc2626' },
  notifActionText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  denyOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    padding: 20
  },
  denyCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  denyTitle: { fontSize: 16, fontWeight: '800', color: '#0f172a' },
  denySub: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: '600',
    marginTop: 6,
    marginBottom: 12,
    lineHeight: 17
  },
  denyInput: {
    minHeight: 88,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    color: '#0f172a',
    textAlignVertical: 'top',
    backgroundColor: '#f8fafc'
  },
  denyActions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  denyCancelBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: '#f1f5f9'
  },
  denyCancelText: { color: '#334155', fontWeight: '800', fontSize: 13 },
  denyConfirmBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: '#dc2626'
  },
  denyConfirmText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  contentArea: { flex: 1, paddingBottom: 64 },
  body: { padding: 16, paddingBottom: 88 },
  moreBody: { paddingBottom: 120 },
  dashHero: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderLeftWidth: 3,
    borderLeftColor: '#003580'
  },
  dashHeroEyebrow: {
    fontSize: 9,
    fontWeight: '800',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 1
  },
  dashHeroTitle: { fontSize: 15, fontWeight: '800', color: '#0f172a', lineHeight: 18 },
  dashHeroDate: { fontSize: 11, color: '#64748b', fontWeight: '600', marginTop: 1 },
  dashHeroHint: {
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: '600',
    marginTop: 6,
    lineHeight: 15
  },
  dashHeroDateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    flexWrap: 'wrap'
  },
  dashDateChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  dashDateChipText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#003580',
    maxWidth: 140
  },
  dashTodayBtn: {
    backgroundColor: '#003580',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7
  },
  dashTodayBtnText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#fff'
  },
  dashUpdatedAt: {
    fontSize: 10,
    color: '#64748b',
    fontWeight: '700',
    marginTop: 6
  },
  dashHeroIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8
  },
  todayOpsCard: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 8,
    overflow: 'hidden'
  },
  todayOpsCell: { flex: 1, alignItems: 'center', paddingVertical: 8 },
  todayOpsDivider: { width: 1, backgroundColor: '#e2e8f0' },
  todayOpsNum: { fontSize: 16, fontWeight: '800', lineHeight: 20 },
  todayOpsDen: { fontSize: 11, fontWeight: '700', color: '#94a3b8' },
  todayOpsLbl: {
    fontSize: 9,
    fontWeight: '700',
    color: '#64748b',
    marginTop: 1,
    textTransform: 'uppercase',
    letterSpacing: 0.3
  },
  permAlertBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#fffbeb',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#fde68a',
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginBottom: 10
  },
  permAlertIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: '#fef3c7',
    alignItems: 'center',
    justifyContent: 'center'
  },
  permAlertTitle: { fontSize: 13, fontWeight: '800', color: '#92400e' },
  permAlertSub: { fontSize: 11, fontWeight: '600', color: '#b45309', marginTop: 1 },
  attentionCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#fecaca',
    marginBottom: 10,
    overflow: 'hidden'
  },
  attentionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: '#eff6ff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#dbeafe'
  },
  attentionTitle: { fontSize: 12, fontWeight: '800', color: '#0f172a', flex: 1 },
  doListCount: {
    minWidth: 22,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#dbeafe',
    color: '#003580',
    fontSize: 11,
    fontWeight: '800',
    textAlign: 'center'
  },
  attentionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8
  },
  attentionRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#f1f5f9'
  },
  attentionName: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  attentionMeta: { fontSize: 11, color: '#64748b', fontWeight: '600', marginTop: 1 },
  attentionBadge: {
    fontSize: 10,
    fontWeight: '800',
    color: '#dc2626',
    backgroundColor: '#fef2f2',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    overflow: 'hidden'
  },
  dashSectionLbl: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 6,
    marginTop: 2
  },
  hero: {
    backgroundColor: '#003580',
    borderRadius: 16,
    padding: 18,
    marginBottom: 14
  },
  heroEyebrow: { color: '#7dd3fc', fontSize: 11, fontWeight: '700', letterSpacing: 0.4, marginBottom: 4 },
  heroTitle: { color: '#fff', fontSize: 22, fontWeight: '800', marginBottom: 6 },
  heroSub: { color: '#dbeafe', fontSize: 13, lineHeight: 19 },
  statsGrid: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  statCard: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center'
  },
  statCardActive: {
    borderColor: '#003580',
    backgroundColor: '#eff6ff',
    borderWidth: 1.5
  },
  statIcon: {
    width: 22,
    height: 22,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4
  },
  statValue: { fontSize: 15, fontWeight: '800', color: '#0f172a' },
  statLabel: { fontSize: 10, color: '#64748b', marginTop: 1, fontWeight: '700', textAlign: 'center' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 12
  },
  cardTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  cardTitle: { fontSize: 15, fontWeight: '800', color: '#0f172a', marginBottom: 4 },
  cardHint: { fontSize: 13, color: '#64748b', lineHeight: 19 },
  cardCompact: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 12
  },
  cardTitleSm: { fontSize: 13, fontWeight: '800', color: '#0f172a', marginBottom: 4 },
  cardHintSm: { fontSize: 11, color: '#94a3b8', marginTop: 4 },
  doSection: { marginBottom: 12 },
  doOverviewCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  doOverviewHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 2
  },
  doOverviewTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 2
  },
  doOverviewSub: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '600',
    marginBottom: 8,
    lineHeight: 15
  },
  doMonitorFilterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9'
  },
  doMonitorFilterHint: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94a3b8',
    marginLeft: 'auto'
  },
  doOverviewStats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
    marginBottom: 10,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0'
  },
  doOverviewStat: { fontSize: 12, color: '#64748b', fontWeight: '600' },
  doOverviewDot: { fontSize: 12, color: '#cbd5e1', fontWeight: '700' },
  doOverviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8
  },
  doOverviewDoRow: {
    gap: 8,
    paddingVertical: 10
  },
  doOverviewRowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  doOverviewRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e2e8f0'
  },
  doOverviewDotSm: { width: 7, height: 7, borderRadius: 4 },
  doOverviewWh: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  doOverviewMeta: { fontSize: 11, color: '#64748b', fontWeight: '600', marginTop: 1 },
  customerAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#059669',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8
  },
  customerAddBtnText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  customerIconBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#eff6ff'
  },
  customerIconBtnDanger: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fef2f2'
  },
  customerModalCard: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '88%',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16
  },
  customerModalScroll: { maxHeight: 420, marginTop: 8 },
  customerInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#0f172a',
    marginBottom: 8,
    backgroundColor: '#f8fafc'
  },
  customerChipLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: '#334155',
    marginTop: 6,
    marginBottom: 6
  },
  customerChipGroupLbl: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748b',
    marginBottom: 6
  },
  customerChipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  customerChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center'
  },
  customerChipOn: { backgroundColor: '#059669', borderColor: '#059669' },
  customerChipText: { fontSize: 11, fontWeight: '800', color: '#475569' },
  customerChipTextOn: { color: '#fff' },
  customerSaveBtn: {
    flex: 1,
    backgroundColor: '#003580',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center'
  },
  customerSaveText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  customerInputLocked: { backgroundColor: '#e2e8f0', color: '#64748b' },
  catalogRowActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 8
  },
  doCountPills: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  doCountPillsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 15
  },
  doCountPill: {
    minWidth: 52,
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 5,
    borderRadius: 8
  },
  doCountPillDone: { backgroundColor: '#ecfdf5' },
  doCountPillPend: { backgroundColor: '#fffbeb' },
  doCountPillOver: { backgroundColor: '#fef2f2' },
  doCountPillNum: { fontSize: 12, fontWeight: '800' },
  doCountPillLbl: { fontSize: 8, fontWeight: '700', marginTop: 1 },
  whRow: { paddingVertical: 7 },
  whRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#e2e8f0' },
  whRowMain: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  whDot: { width: 6, height: 6, borderRadius: 3 },
  whRowText: { flex: 1, minWidth: 0 },
  whNameSm: { fontSize: 12, fontWeight: '800', color: '#0f172a' },
  whDoSm: { fontSize: 10, color: '#64748b', marginTop: 1, fontWeight: '600' },
  whPills: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  whPill: {
    minWidth: 22,
    textAlign: 'center',
    fontSize: 10,
    fontWeight: '800',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 5,
    overflow: 'hidden'
  },
  whPillDone: { color: '#059669', backgroundColor: '#ecfdf5' },
  whPillPend: { color: '#d97706', backgroundColor: '#fffbeb' },
  whPillOver: { color: '#dc2626', backgroundColor: '#fef2f2' },
  whDetailLineSm: { fontSize: 10, color: '#64748b', lineHeight: 14, marginTop: 3, paddingLeft: 12 },
  whLegendBar: {
    marginBottom: 2,
    fontSize: 9,
    color: '#94a3b8',
    fontWeight: '600'
  },
  linkText: { color: '#0284c7', fontWeight: '700', fontSize: 12 },
  recentRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 10 },
  recentBorder: { borderTopWidth: 1, borderTopColor: '#f1f5f9' },
  recentClient: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  recentMeta: { fontSize: 12, color: '#64748b', marginTop: 2 },
  recentTemp: { fontSize: 15, fontWeight: '800', color: '#003580' },
  filterPanel: {
    backgroundColor: '#fff',
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0'
  },
  logTypeRow: { flexDirection: 'row', gap: 6, marginBottom: 6 },
  logTypeChip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  logTypeChipActive: { backgroundColor: '#003580', borderColor: '#003580' },
  logTypeChipText: { fontSize: 11, fontWeight: '700', color: '#64748b' },
  logTypeChipTextActive: { color: '#fff' },
  filterRow: { flexDirection: 'row', gap: 6, marginBottom: 6 },
  filterChip: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 5
  },
  filterChipActive: { borderColor: '#93c5fd', backgroundColor: '#eff6ff' },
  filterChipLabel: { fontSize: 8, color: '#94a3b8', fontWeight: '700', letterSpacing: 0.2 },
  filterChipValue: { fontSize: 11, color: '#0f172a', fontWeight: '700', marginTop: 1 },
  logQuickBtnRow: {
    flexDirection: 'row',
    gap: 5,
    marginBottom: 2
  },
  logQuickBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 5,
    borderRadius: 7,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  logQuickBtnActive: {
    backgroundColor: '#003580',
    borderColor: '#003580'
  },
  logQuickBtnText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#475569'
  },
  logQuickBtnTextActive: {
    color: '#fff'
  },
  logQuickBtnClear: {
    backgroundColor: '#fff',
    borderColor: '#cbd5e1'
  },
  logQuickBtnClearText: {
    color: '#475569'
  },
  logOpsCard: {
    marginHorizontal: 10,
    marginTop: 4,
    marginBottom: 2,
    borderRadius: 8
  },
  logOpsCell: { paddingVertical: 4 },
  logOpsNum: { fontSize: 12 },
  logOpsDen: { fontSize: 9 },
  logOpsLbl: { fontSize: 7, marginTop: 0 },
  logDailyBanner: {
    marginHorizontal: 10,
    marginBottom: 2,
    paddingVertical: 3,
    paddingHorizontal: 7
  },
  logDailyBannerText: { fontSize: 8 },
  suggestRow: { gap: 6, paddingBottom: 2 },
  suggestChip: {
    backgroundColor: '#f1f5f9',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4
  },
  suggestClear: { backgroundColor: '#fee2e2' },
  suggestText: { fontSize: 11, fontWeight: '700', color: '#334155' },
  listBody: { padding: 8, paddingBottom: 88 },
  dockReportPagination: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 4,
    marginTop: 4
  },
  dockReportPageBtn: {
    backgroundColor: '#003580',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8
  },
  dockReportPageBtnDisabled: {
    backgroundColor: '#94a3b8'
  },
  dockReportPageBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 12
  },
  dockReportPageMeta: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: '600'
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
  dailyBannerText: { fontSize: 10, color: '#003580', fontWeight: '700', flex: 1 },
  reportsUpdatedAt: {
    fontSize: 10,
    color: '#64748b',
    fontWeight: '700',
    paddingHorizontal: 12,
    paddingVertical: 6
  },
  netBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 10,
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1
  },
  netBannerOffline: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca'
  },
  netBannerWarn: {
    backgroundColor: '#fffbeb',
    borderColor: '#fde68a'
  },
  netBannerTitle: { fontSize: 12, fontWeight: '800', color: '#0f172a' },
  netBannerSub: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '600',
    marginTop: 2,
    lineHeight: 15
  },
  netBannerBtn: {
    backgroundColor: '#003580',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  netBannerBtnText: { color: '#fff', fontWeight: '800', fontSize: 12 },
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
  logCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 8,
    marginBottom: 5,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 8
  },
  logTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 1 },
  logTypeTag: {
    fontSize: 8,
    fontWeight: '800',
    color: '#0284c7',
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    overflow: 'hidden'
  },
  logClient: { fontSize: 12, fontWeight: '700', color: '#0f172a', flex: 1 },
  logMeta: { fontSize: 10, color: '#64748b', marginTop: 1 },
  logTemp: { fontSize: 13, fontWeight: '800', color: '#003580' },
  reportWhRow: { gap: 6, paddingVertical: 8 },
  reportWhChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  reportWhChipActive: { backgroundColor: '#003580', borderColor: '#003580' },
  reportWhChipText: { fontSize: 11, fontWeight: '700', color: '#64748b', maxWidth: 120 },
  reportWhChipTextActive: { color: '#fff' },
  invSummaryGrid: { flexDirection: 'row', gap: 6, marginTop: 2 },
  invSummaryCell: {
    flex: 1,
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    paddingVertical: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  invSummaryValue: { fontSize: 13, fontWeight: '800', color: '#0f172a' },
  invSummaryLabel: { fontSize: 9, color: '#94a3b8', fontWeight: '700', marginTop: 1 },
  invCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  invCardWarn: { borderColor: '#fecaca', backgroundColor: '#fffafa' },
  invCardTop: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  invClient: { fontSize: 13, fontWeight: '800', color: '#0f172a' },
  invMeta: { fontSize: 10, color: '#64748b', fontWeight: '600', marginTop: 1 },
  invDisc: { fontSize: 14, fontWeight: '800' },
  invMetrics: { flexDirection: 'row', gap: 5 },
  invMetric: {
    flex: 1,
    backgroundColor: '#f8fafc',
    borderRadius: 7,
    paddingVertical: 5,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  invMetricValue: { fontSize: 12, fontWeight: '800', color: '#0f172a' },
  invMetricLabel: { fontSize: 9, color: '#94a3b8', fontWeight: '700', marginTop: 1 },
  invAudit: { marginTop: 6, fontSize: 10, color: '#94a3b8', fontWeight: '600' },
  reportSummaryRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  reportPill: {
    flex: 1,
    backgroundColor: '#eff6ff',
    borderRadius: 12,
    padding: 12
  },
  reportPillAlt: { backgroundColor: '#ecfdf5' },
  reportPillValue: { fontSize: 20, fontWeight: '800', color: '#0f172a' },
  reportPillLabel: { fontSize: 11, color: '#64748b', fontWeight: '600', marginTop: 2 },
  reportCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 10
  },
  deltaText: { fontSize: 16, fontWeight: '800', color: '#64748b' },
  profileRow: { marginTop: 8, fontSize: 13, lineHeight: 20 },
  profileKey: { color: '#64748b', fontWeight: '600' },
  profileVal: { color: '#0f172a', fontWeight: '700' },
  logoutBtn: {
    marginTop: 8,
    backgroundColor: '#dc2626',
    borderRadius: 12,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8
  },
  logoutText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  aboutFooter: { marginTop: 28, alignItems: 'center', paddingHorizontal: 8 },
  aboutLogo: { width: 72, height: 40, marginBottom: 8, opacity: 0.7 },
  aboutTitle: { fontSize: 14, fontWeight: '800', color: '#64748b', marginBottom: 6 },
  aboutBody: { fontSize: 12, color: '#94a3b8', textAlign: 'center', lineHeight: 18 },
  aboutContact: { marginTop: 10, color: '#0284c7', fontWeight: '700', fontSize: 13 },
  centerState: { alignItems: 'center', justifyContent: 'center', padding: 28, gap: 8 },
  stateText: { color: '#64748b', textAlign: 'center', fontSize: 13, lineHeight: 19 },
  retryBtn: {
    marginTop: 8,
    backgroundColor: '#003580',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10
  },
  retryText: { color: '#fff', fontWeight: '700', fontSize: 13, textAlign: 'center' },
  tabBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.08,
    shadowRadius: 5
  },
  tabBarActiveLine: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: 3,
    backgroundColor: '#003580',
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
    zIndex: 2
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    minWidth: 0,
    gap: 2
  },
  tabLabel: { fontSize: 10, color: '#64748b', fontWeight: '600' },
  tabLabelActive: { color: '#003580', fontWeight: '800' },
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'flex-end'
  },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 16,
    maxHeight: '60%'
  },
  sheetTitle: { fontSize: 15, fontWeight: '800', color: '#0f172a', marginBottom: 10 },
  sheetItem: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  sheetItemText: { fontSize: 14, color: '#0f172a', fontWeight: '600' },
  calendarSheet: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 40,
    borderRadius: 16,
    padding: 16
  },
  calendarHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12
  },
  calendarTitle: { fontSize: 15, fontWeight: '800', color: '#0f172a' },
  calendarSubTitle: {
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    marginBottom: 8
  },
  calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calCell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  calCellActive: { backgroundColor: '#003580', borderRadius: 999 },
  calCellDisabled: { opacity: 0.35 },
  calCellText: { fontSize: 13, color: '#334155', fontWeight: '600' },
  calCellTextActive: { color: '#fff' },
  calCellTextDisabled: { color: '#94a3b8' },
  detailOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'flex-end'
  },
  detailSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 16,
    maxHeight: '88%'
  },
  doProfileOverlay: {
    flex: 1,
    backgroundColor: '#fff'
  },
  doProfileSheet: {
    flex: 1,
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 48 : 12,
    paddingBottom: Platform.OS === 'ios' ? 28 : 16
  },
  doProfileHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#cbd5e1',
    marginBottom: 10
  },
  doProfileHero: {
    alignItems: 'center',
    paddingVertical: 12,
    marginBottom: 10
  },
  doProfileHeroAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#e0efff',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10
  },
  doProfileHeroName: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
    textAlign: 'center'
  },
  doProfileHeroRole: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    marginTop: 4
  },
  doProfileCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    marginBottom: 10
  },
  doProfileSectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#003580',
    marginBottom: 0,
    textTransform: 'uppercase'
  },
  doProfileCardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10
  },
  doProfileEditLink: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0369a1'
  },
  doProfileField: { marginBottom: 8 },
  doProfileInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#0f172a',
    backgroundColor: '#f8fafc',
    marginTop: 4
  },
  doProfileEmptyAssign: {
    fontSize: 12,
    color: '#94a3b8',
    fontWeight: '600',
    marginBottom: 10
  },
  doProfileChamberBlock: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9'
  },
  doProfileChamberHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8
  },
  doProfileChamberName: { fontSize: 13, fontWeight: '800', color: '#0f172a', flex: 1 },
  doProfileTypePill: {
    backgroundColor: '#eff6ff',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6
  },
  doProfileTypeText: { fontSize: 10, fontWeight: '800', color: '#003580' },
  doProfileClientsLine: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '600',
    marginTop: 4,
    lineHeight: 16
  },
  doMasterSetupBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#003580',
    borderRadius: 12,
    paddingVertical: 12,
    marginTop: 12,
    marginBottom: 4
  },
  doMasterSetupBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  doProfileDoneBtn: {
    marginTop: 4,
    marginBottom: 8,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    backgroundColor: '#e2e8f0'
  },
  doProfileDoneBtnText: { color: '#0f172a', fontWeight: '800', fontSize: 14 },
  doProfileRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0'
  },
  doProfileLabel: { fontSize: 12, color: '#64748b', fontWeight: '600', flex: 1 },
  doProfileValue: {
    fontSize: 12,
    color: '#0f172a',
    fontWeight: '700',
    flex: 1.4,
    textAlign: 'right'
  },
  doProfileStatRow: { flexDirection: 'row', gap: 8 },
  doProfileStatPill: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center'
  },
  doProfileStatNum: { fontSize: 16, fontWeight: '800' },
  doProfileStatLbl: { fontSize: 10, fontWeight: '700', marginTop: 2 },
  warehouseDoList: { marginTop: 10, gap: 6 },
  warehouseDoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingVertical: 8,
    paddingHorizontal: 10
  },
  warehouseDoAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#e0efff',
    alignItems: 'center',
    justifyContent: 'center'
  },
  warehouseDoName: { fontSize: 13, fontWeight: '800', color: '#0f172a' },
  warehouseDoMeta: { fontSize: 11, fontWeight: '600', color: '#64748b', marginTop: 1 },
  detailHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12
  },
  detailTitle: { fontSize: 16, fontWeight: '800', color: '#0f172a' },
  excelSub: { fontSize: 11, color: '#64748b', fontWeight: '600', marginTop: 2 },
  excelHead: {
    flexDirection: 'row',
    backgroundColor: '#003580',
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 6,
    marginBottom: 2
  },
  excelHeadCell: {
    fontSize: 10,
    fontWeight: '800',
    color: '#fff',
    textTransform: 'uppercase',
    letterSpacing: 0.3
  },
  excelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0'
  },
  excelRowAlt: { backgroundColor: '#f8fafc' },
  excelCell: { fontSize: 10, color: '#0f172a', fontWeight: '600' },
  excelColDate: { flex: 1.2 },
  excelColTime: { flex: 0.85 },
  excelColTemp: { flex: 0.75 },
  excelColIn: { flex: 0.55, textAlign: 'right' },
  excelColOut: { flex: 0.55, textAlign: 'right' },
  excelColQty: { flex: 0.65, textAlign: 'right' },
  excelIn: { color: '#059669', fontWeight: '800' },
  excelOut: { color: '#d97706', fontWeight: '800' },
  excelQty: { fontWeight: '800', color: '#003580' },
  smallImgWrap: { marginBottom: 12 },
  smallImg: {
    width: 96,
    height: 96,
    borderRadius: 10,
    marginTop: 6,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  smallImgEmpty: {
    width: 96,
    height: 96,
    borderRadius: 10,
    marginTop: 6,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4
  },
  smallImgEmptyText: { fontSize: 10, color: '#94a3b8', fontWeight: '600' },
  smallImgHint: { marginTop: 4, fontSize: 10, color: '#0284c7', fontWeight: '700' },
  smallImgLocationWrap: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4
  },
  smallImgLocation: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '700',
    flexShrink: 1
  },
  smallImgLocationLink: {
    color: '#0369a1',
    textDecorationLine: 'underline'
  },
  smallImgLocationMuted: {
    marginTop: 6,
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: '600'
  },
  imgViewerLocationBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: 'rgba(15,23,42,0.92)'
  },
  imgViewerLocationText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700'
  },
  imgViewerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight || 12 : 48
  },
  imgViewerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 10
  },
  imgViewerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10
  },
  imgViewerDownload: { backgroundColor: '#003580' },
  imgViewerBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  imgViewerBody: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12
  },
  imgViewerImage: {
    width: '100%',
    height: 480,
    maxWidth: 520
  },
  detailRow: { marginBottom: 10 },
  detailLabel: { fontSize: 11, color: '#94a3b8', fontWeight: '700' },
  detailValue: { fontSize: 14, color: '#0f172a', fontWeight: '600', marginTop: 2 },
  logDetailSection: {
    marginBottom: 14,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0'
  },
  logDetailSectionTitle: {
    fontSize: 13,
    color: '#003580',
    fontWeight: '800',
    marginBottom: 10,
    letterSpacing: 0.2
  }
});
