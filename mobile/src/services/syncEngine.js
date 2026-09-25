import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  cacheAssignments,
  getPendingInspections,
  markInspectionAsSynced,
  getPendingAssignments,
  markAssignmentSynced,
  markAssignmentAwaitingApproval,
  getPendingInwardLogs,
  getPendingOutwardLogs,
  markInwardAsSynced,
  markOutwardAsSynced,
  markInwardSyncError,
  markOutwardSyncError,
  markInwardSyncing,
  markOutwardSyncing,
  countPendingSyncItems,
  upsertSyncedInspectionFromServer,
  reconcileSyncedInspectionsFromServer,
  getPendingActivities,
  markActivitySynced,
} from '../database/db';
import {
  buildInwardFormData,
  buildOutwardFormData,
  describeInwardQueueItem,
  describeOutwardQueueItem,
  assertQueuePhotosExist,
} from '../utils/offlineLogFormData';
import {
  appendLocalFile,
  localFileExists,
  multipartRequest,
} from '../utils/formDataAppendFile';

function toLocalYmd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const LAST_SYNC_KEY = 'reeferon_last_sync_at';

/** Prevent overlapping sync runs. */
let isSyncing = false;

export async function getLastSyncAt() {
  try {
    return (await AsyncStorage.getItem(LAST_SYNC_KEY)) || null;
  } catch (_) {
    return null;
  }
}

async function persistLastSync(iso) {
  if (!iso) return;
  try {
    await AsyncStorage.setItem(LAST_SYNC_KEY, iso);
  } catch (_) {}
}

function emitProgress(onSyncProgress, payload) {
  if (typeof onSyncProgress === 'function') onSyncProgress(payload);
}

function countPending(warehouseName, operatorName, operatorEmail) {
  return countPendingSyncItems(warehouseName, operatorName, operatorEmail);
}

/**
 * Upload pending assignments + inspections + inward/outward queues.
 * Continues after individual failures (no break).
 */
export const triggerSync = async (apiBaseUrl, token, onSyncProgress = () => {}, userProfile = {}) => {
  const warehouseName = userProfile?.warehouse_name || null;
  const operatorName = userProfile?.full_name || userProfile?.email || null;
  const operatorEmail = userProfile?.email || null;

  if (isSyncing) return;
  if (!apiBaseUrl || !token) {
    emitProgress(onSyncProgress, {
      status: 'failed',
      pendingCount: countPending(warehouseName, operatorName, operatorEmail),
      message: 'Missing API URL or login token.',
      failures: [],
    });
    return;
  }

  isSyncing = true;
  emitProgress(onSyncProgress, {
    status: 'syncing',
    pendingCount: countPending(warehouseName, operatorName, operatorEmail),
    message: 'Uploading offline queue…',
    failures: [],
  });

  let syncedCount = 0;
  let failedCount = 0;
  let assignmentsUpdated = false;
  const failures = [];

  const recordFailure = (type, label, message) => {
    failedCount += 1;
    failures.push({
      type,
      label,
      message: message || 'Upload failed',
    });
  };

  try {
    const pendingActivities = getPendingActivities();
    for (const item of pendingActivities) {
      try {
        const response = await fetch(`${apiBaseUrl}/api/operator-activities`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            action: item.action,
            logType: item.log_type || 'DO_CHANGE',
            description: item.description,
            remark: item.remark || null,
            record_id: item.permission_req || undefined,
          }),
        });
        if (response.status === 200 || response.status === 201) {
          markActivitySynced(item.id);
          syncedCount += 1;
        } else {
          const resData = await response.json().catch(() => ({}));
          throw new Error(resData.message || resData.error || `Activity sync failed (${response.status})`);
        }
      } catch (actErr) {
        recordFailure(
          'activity',
          `Activity · ${item.action}`,
          actErr.message || String(actErr)
        );
        console.error('❌ Sync failed for operator activity:', actErr.message || actErr);
      }
    }

    const pendingAssignments = getPendingAssignments(warehouseName);
    for (const item of pendingAssignments) {
      try {
        const isDelete = item.action === 'delete' || item.action === 'rename_delete';
        const isRename = item.action === 'rename_add' || item.action === 'rename_delete';
        const response = await fetch(`${apiBaseUrl}/api/chambers/assignments`, {
          method: isDelete ? 'DELETE' : 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            chamber_id: item.chamber_id,
            client_name: item.client_name,
            client_code: item.client_code || null,
            warehouse_code: item.warehouse_code || userProfile?.warehouse_code || null,
            remark: item.remark,
            chamber_type: item.chamber_type,
            skip_activity: isRename,
          }),
        });

        if (response.status === 200 || response.status === 201) {
          markAssignmentSynced(item.chamber_id, item.client_name, item.action);
          syncedCount += 1;
        } else {
          const resData = await response.json().catch(() => ({}));
          const msg = String(resData.message || resData.error || `Sync failed (${response.status})`);
          // Client master needs SA approval — keep local row so today's temp
          // tasks still show the new client; stop retry spam.
          if (
            response.status === 403 &&
            /super admin approval|approval is required/i.test(msg)
          ) {
            if (isDelete) {
              // Keep local inactive row; SA must approve delete first.
              markAssignmentSynced(item.chamber_id, item.client_name, 'add');
            } else {
              markAssignmentAwaitingApproval(item.chamber_id, item.client_name);
            }
            console.warn(
              `⚠️ Client awaiting SA approval (kept for today's tasks): ${item.client_name}`
            );
            continue;
          }
          throw new Error(msg);
        }
      } catch (assignErr) {
        recordFailure(
          'assignment',
          `Client · ${item.client_name}`,
          assignErr.message || String(assignErr)
        );
        console.error(`❌ Sync failed for assignment ${item.client_name}:`, assignErr.message || assignErr);
      }
    }

    try {
      const assignRes = await fetch(`${apiBaseUrl}/api/chambers/assignments`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (assignRes.status === 200) {
        const assignData = await assignRes.json().catch(() => ({}));
        const rows = Array.isArray(assignData?.data) ? assignData.data : [];
        cacheAssignments(rows, warehouseName, userProfile?.warehouse_code);
        assignmentsUpdated = true;
        console.log(`⬇️ Sync Engine: cached ${rows.length} chamber assignment(s) from server`);
      }
    } catch (pullAssignErr) {
      console.warn(
        '⚠️ Sync Engine: Failed to pull chamber assignments:',
        pullAssignErr.message || pullAssignErr
      );
    }

    const pendingInspections = getPendingInspections(operatorName);
    for (const log of pendingInspections) {
      try {
        const formData = new FormData();
        formData.append('operator_name', log.monitor_supervisor_name);
        formData.append('chamber_id', log.chamber_id.toString());
        formData.append('client_name', log.client_name);
        if (log.client_code) formData.append('client_code', String(log.client_code).trim());
        formData.append('entry_date', log.entry_date);
        formData.append('entry_time', log.inspection_time);
        formData.append('box_temp', String(log.box_temp));
        if (log.box_count != null) formData.append('box_count', log.box_count.toString());
        if (log.chamber_type) formData.append('chamber_type', log.chamber_type);
        if (log.overdue_time) formData.append('overdue_time', log.overdue_time);
        if (log.photo_capture_time) formData.append('photo_capture_time', log.photo_capture_time);
        if (log.photo_capture_latitude != null) {
          formData.append('photo_capture_latitude', String(log.photo_capture_latitude));
        }
        if (log.photo_capture_longitude != null) {
          formData.append('photo_capture_longitude', String(log.photo_capture_longitude));
        }
        if (log.photo_capture_accuracy != null) {
          formData.append('photo_capture_accuracy', String(log.photo_capture_accuracy));
        }
        if (log.created_at) formData.append('created_at', log.created_at);
        formData.append(
          'shift',
          log.shift || (log.inspection_time === '10:00' ? 'Morning' : 'Evening')
        );
        const wh = log.warehouse_name || warehouseName;
        const opEmail = log.operator_email || operatorEmail;
        if (wh) formData.append('warehouse_name', String(wh).trim());
        const whCode = log.warehouse_code || userProfile?.warehouse_code;
        if (whCode) formData.append('warehouse_code', String(whCode).trim());
        if (opEmail) formData.append('operator_email', String(opEmail).trim());

        if (log.temp_sensor_image) {
          const photoOk = await localFileExists(log.temp_sensor_image);
          if (!photoOk) {
            throw new Error(
              'Sensor photo file missing on device. Open the task, capture photo again, then sync.'
            );
          }
          const filename = log.temp_sensor_image.split('/').pop() || `inspection-${log.id}.jpg`;
          appendLocalFile(formData, 'sensor_photo', log.temp_sensor_image, {
            name: filename,
            type: 'image/jpeg',
          });
        }

        const response = await multipartRequest(`${apiBaseUrl}/api/chambers/inspections`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          body: formData,
        });

        const resData = await response.json();

        if (response.status === 200 || response.status === 201) {
          markInspectionAsSynced(log.id, resData.reference_no, resData.logId);
          syncedCount += 1;
        } else if (response.status === 409) {
          markInspectionAsSynced(log.id, resData.reference_no, resData.logId);
          syncedCount += 1;
        } else {
          throw new Error(resData.message || resData.error || `Sync failed (${response.status})`);
        }
      } catch (err) {
        recordFailure(
          'inspection',
          `Task · ${log.chamber_name || log.chamber_id} · ${log.client_name}`,
          err.message || String(err)
        );
        console.error(`❌ Sync failed for log ${log.id}:`, err.message || err);
      }
    }

    const pendingInwards = getPendingInwardLogs(operatorEmail);
    for (const record of pendingInwards) {
      try {
        markInwardSyncing(record.id);
        await assertQueuePhotosExist(record);
        const formData = buildInwardFormData(record);
        const response = await multipartRequest(`${apiBaseUrl}/api/inward-logs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          body: formData,
        });
        const resData = await response.json().catch(() => ({}));
        if (response.status === 200 || response.status === 201) {
          markInwardAsSynced(record.id, resData.reference_no, resData.id);
          syncedCount += 1;
        } else {
          const msg = resData.message || resData.error || `Inward upload failed (${response.status})`;
          markInwardSyncError(record.id, msg);
          throw new Error(msg);
        }
      } catch (err) {
        markInwardSyncError(record.id, err.message || String(err));
        recordFailure('inward', describeInwardQueueItem(record), err.message || String(err));
        console.error(`❌ Sync failed for inward ${record.id}:`, err.message || err);
      }
    }

    const pendingOutwards = getPendingOutwardLogs(operatorEmail);
    for (const record of pendingOutwards) {
      try {
        markOutwardSyncing(record.id);
        await assertQueuePhotosExist(record);
        const formData = buildOutwardFormData(record);
        const response = await multipartRequest(`${apiBaseUrl}/api/outward-logs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          body: formData,
        });
        const resData = await response.json().catch(() => ({}));
        if (response.status === 200 || response.status === 201) {
          markOutwardAsSynced(record.id, resData.reference_no, resData.id);
          syncedCount += 1;
        } else {
          const msg = resData.message || resData.error || `Outward upload failed (${response.status})`;
          markOutwardSyncError(record.id, msg);
          throw new Error(msg);
        }
      } catch (err) {
        markOutwardSyncError(record.id, err.message || String(err));
        recordFailure('outward', describeOutwardQueueItem(record), err.message || String(err));
        console.error(`❌ Sync failed for outward ${record.id}:`, err.message || err);
      }
    }

    try {
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 2);
      const toStr = toLocalYmd(toDate);
      const fromStr = toLocalYmd(fromDate);
      const qs = new URLSearchParams({
        page: '1',
        limit: '500',
        fromDate: fromStr,
        toDate: toStr,
      });
      if (warehouseName) qs.set('warehouse', String(warehouseName).trim());

      const pullResponse = await fetch(`${apiBaseUrl}/api/chamber-temp?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (pullResponse.status === 200) {
        const pullData = await pullResponse.json().catch(() => ({}));
        const items = Array.isArray(pullData?.items)
          ? pullData.items
          : Array.isArray(pullData)
            ? pullData
            : [];
        let pulled = 0;
        for (const item of items) {
          if (
            upsertSyncedInspectionFromServer(item, {
              displayName: operatorName,
              operatorEmail,
              warehouseName,
            })
          ) {
            pulled += 1;
          }
        }
        reconcileSyncedInspectionsFromServer(items, {
          fromDate: fromStr,
          toDate: toStr,
          operatorEmail,
        });
        if (pulled > 0) {
          console.log(`⬇️ Sync Engine: mirrored ${pulled} server inspection(s) to SQLite (${fromStr}→${toStr})`);
        }
      }
    } catch (pullHistoryErr) {
      console.warn(
        '⚠️ Sync Engine: Failed to pull chamber history:',
        pullHistoryErr.message || pullHistoryErr
      );
    }
  } catch (error) {
    failedCount += 1;
    recordFailure('sync', 'Sync engine', error.message || String(error));
    console.error('❌ Sync Engine encountered an error:', error);
  } finally {
    isSyncing = false;
    const stillPending = countPending(warehouseName, operatorName, operatorEmail);
    let status = 'idle';
    let message = null;
    let lastSyncAt;

    if (failedCount > 0 && syncedCount > 0) {
      status = 'partial';
      message = `${syncedCount} uploaded · ${stillPending} still on phone`;
    } else if (failedCount > 0 || stillPending > 0) {
      status = stillPending > 0 ? 'failed' : 'idle';
      message =
        stillPending > 0
          ? `${stillPending} item(s) waiting — tap Sync when online`
          : 'Sync failed — data safe on device';
    } else if (syncedCount > 0) {
      message = `${syncedCount} item(s) synced to server`;
    } else {
      message = 'All data synced';
    }

    if (syncedCount > 0) {
      lastSyncAt = new Date().toISOString();
      await persistLastSync(lastSyncAt);
    } else {
      lastSyncAt = (await getLastSyncAt()) || undefined;
    }

    emitProgress(onSyncProgress, {
      status,
      lastSyncAt,
      pendingCount: stillPending,
      message,
      failures: failures.slice(0, 8),
      assignmentsUpdated,
    });
  }
};

export const subscribeToSync = (apiBaseUrl, token, onSyncProgress = () => {}, userProfile = {}) => {
  let retryTimer = null;

  const runSyncIfOnline = (state) => {
    const isOnline = state.isConnected && state.isInternetReachable !== false;
    if (isOnline) triggerSync(apiBaseUrl, token, onSyncProgress, userProfile);
  };

  const unsubscribeNetInfo = NetInfo.addEventListener(runSyncIfOnline);

  retryTimer = setInterval(() => {
    NetInfo.fetch()
      .then((state) => {
        const isOnline = state.isConnected && state.isInternetReachable !== false;
        if (isOnline) triggerSync(apiBaseUrl, token, onSyncProgress, userProfile);
      })
      .catch(() => {});
  }, 30000);

  return () => {
    unsubscribeNetInfo();
    if (retryTimer) clearInterval(retryTimer);
  };
};

/** Format ISO timestamp for DO sync UI. */
export function formatLastSyncLabel(iso) {
  if (!iso) return 'Never synced';
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();
    const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return `Today ${time}`;
    return `${d.toLocaleDateString('en-IN')} ${time}`;
  } catch (_) {
    return iso;
  }
}
