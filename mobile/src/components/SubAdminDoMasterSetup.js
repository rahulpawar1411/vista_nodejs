import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Alert,
  Platform,
  KeyboardAvoidingView
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import FastTouchable from './FastTouchable';
import { generateClientCode } from '../utils/generateClientCode';

const TouchableOpacity = FastTouchable;
const CHAMBER_TYPES = ['Frozen', 'Chilled', 'Dry'];

const isTempChamberId = (id) => String(id).startsWith('tmp-');

const cloneSnapshot = (assignmentRows, chamberRows) => ({
  assignments: JSON.parse(JSON.stringify(assignmentRows || [])),
  chambers: JSON.parse(JSON.stringify(chamberRows || []))
});

const sameClient = (a, b) =>
  a.client_code && b.client_code
    ? String(a.client_code) === String(b.client_code)
    : String(a.client_name || '').toLowerCase() === String(b.client_name || '').toLowerCase();

/**
 * WHAT: Modal editor for one DO’s chambers and client assignments (operational graph).
 * WHY: Assignments differ from catalog master — they drive daily temperature tasks.
 * HOW: Loads/saves via API; chamber limit and client codes; Sub-Admin saves without DO permission flow.
 */
export default function SubAdminDoMasterSetup({
  visible,
  onClose,
  apiUrl,
  token,
  authHeaders,
  warehouseName,
  warehouseCode,
  operatorEmail,
  operatorName,
  operatorId,
  operatorPhone,
  chamberLimit,
  onChamberLimitChange
}) {
  const [loading, setLoading] = useState(false);
  const [assignments, setAssignments] = useState([]);
  const [chambers, setChambers] = useState([]);
  const [clients, setClients] = useState([]);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState(null);
  const [expandedChamberId, setExpandedChamberId] = useState(null);
  const [addForChamberId, setAddForChamberId] = useState(null);
  const [clientQuery, setClientQuery] = useState('');
  const [customClient, setCustomClient] = useState('');
  const [localLimit, setLocalLimit] = useState(
    Number(chamberLimit) > 0 ? Number(chamberLimit) : 4
  );
  const [showAddChamber, setShowAddChamber] = useState(false);
  const [newChamberType, setNewChamberType] = useState('Frozen');
  const [newChamberName, setNewChamberName] = useState('');
  const [renameChamberId, setRenameChamberId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const baselineRef = useRef({ assignments: [], chambers: [] });
  const dirtyRef = useRef(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setHasUnsavedChanges(true);
  }, []);

  const resetDraftFromBaseline = useCallback(() => {
    const base = baselineRef.current;
    setAssignments(JSON.parse(JSON.stringify(base.assignments)));
    setChambers(JSON.parse(JSON.stringify(base.chambers)));
    dirtyRef.current = false;
    setHasUnsavedChanges(false);
  }, []);

  const applyBaseline = useCallback((assignmentRows, chamberRows) => {
    baselineRef.current = cloneSnapshot(assignmentRows, chamberRows);
    dirtyRef.current = false;
    setHasUnsavedChanges(false);
  }, []);

  const headers = useMemo(
    () => ({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(authHeaders || {}),
      Authorization: authHeaders?.Authorization || (token ? `Bearer ${token}` : undefined)
    }),
    [authHeaders, token]
  );

  const syncDoChamberLimit = useCallback(
    async (newLimit) => {
      if (!operatorId || !apiUrl || !token) return false;
      let phone = String(operatorPhone || '').replace(/^\+91/, '').trim();
      if (!phone) {
        try {
          const opsRes = await fetch(`${apiUrl}/api/do-operators`, { headers });
          const opsData = await opsRes.json().catch(() => ([]));
          const ops = Array.isArray(opsData)
            ? opsData
            : Array.isArray(opsData?.data)
              ? opsData.data
              : [];
          const found = ops.find((o) => Number(o.id) === Number(operatorId));
          phone = String(found?.phone_no || '').replace(/^\+91/, '').trim();
        } catch (_) {}
      }
      if (!phone) return false;
      const putRes = await fetch(`${apiUrl}/api/do-operators/${operatorId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          email: operatorEmail,
          full_name: operatorName || operatorEmail,
          phone_no: phone,
          warehouse_name: warehouseName,
          warehouse_code: warehouseCode || undefined,
          chamber_limit: newLimit
        })
      });
      if (!putRes.ok) return false;
      setLocalLimit(newLimit);
      onChamberLimitChange?.(newLimit);
      return true;
    },
    [
      operatorId,
      apiUrl,
      token,
      headers,
      operatorPhone,
      operatorEmail,
      operatorName,
      warehouseName,
      warehouseCode,
      onChamberLimitChange
    ]
  );

  const load = useCallback(async (opts = {}) => {
    const silent = !!opts.silent;
    const refreshBaseline = !!opts.refreshBaseline;
    if (!apiUrl || !token || !warehouseName) return;
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const qs = encodeURIComponent(warehouseName);
      const [aRes, cRes, clRes] = await Promise.all([
        fetch(`${apiUrl}/api/chambers/assignments?warehouse_name=${qs}`, { headers }),
        fetch(`${apiUrl}/api/chambers`, { headers }),
        fetch(`${apiUrl}/api/masters/clients?active_only=1`, { headers })
      ]);
      const aData = await aRes.json().catch(() => ({}));
      const cData = await cRes.json().catch(() => ({}));
      const clData = await clRes.json().catch(() => ({}));
      if (!aRes.ok) throw new Error(aData.message || aData.error || 'Assignments failed');
      const assigns = Array.isArray(aData.data) ? aData.data : Array.isArray(aData) ? aData : [];

      const allChamberRows = Array.isArray(cData.data) ? cData.data : [];
      const chamberById = new Map();
      allChamberRows.forEach((c) => chamberById.set(String(c.id), c));

      const idsWithClients = new Set();
      assigns.forEach((a) => {
        if (a.chamber_id != null) idsWithClients.add(String(a.chamber_id));
      });

      const chamberRows = [];
      idsWithClients.forEach((id) => {
        const fromMaster = chamberById.get(id);
        if (fromMaster) {
          chamberRows.push(fromMaster);
          return;
        }
        const sample = assigns.find((a) => String(a.chamber_id) === id);
        if (sample) {
          chamberRows.push({
            id: sample.chamber_id,
            name: sample.chamber_name || `Chamber #${sample.chamber_id}`,
            chamber_type: sample.chamber_type || 'Frozen'
          });
        }
      });
      chamberRows.sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true })
      );

      const allClients = Array.isArray(clData.data) ? clData.data : [];
      const whClients = allClients.filter(
        (c) =>
          !c.warehouse_name ||
          String(c.warehouse_name).toLowerCase() === String(warehouseName).toLowerCase()
      );
      setClients(whClients.length ? whClients : allClients);

      const mayOverwriteDraft = refreshBaseline || !dirtyRef.current;
      if (mayOverwriteDraft) {
        setAssignments(assigns);
        setChambers(chamberRows);
        applyBaseline(assigns, chamberRows);

        let maxNum = 0;
        chamberRows.forEach((c) => {
          const n = parseInt(String(c.name || '').replace(/\D/g, ''), 10);
          if (!Number.isNaN(n) && n > maxNum) maxNum = n;
        });
        const syncedLimit = Math.max(maxNum, chamberRows.length, 1);
        setLocalLimit(syncedLimit);
      }

      if (!silent) setError('');
    } catch (err) {
      if (!silent) {
        setError(err.message || 'Failed to load Master Setup.');
        if (!dirtyRef.current) setAssignments([]);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [
    apiUrl,
    token,
    warehouseName,
    headers,
    chamberLimit,
    operatorId,
    syncDoChamberLimit,
    applyBaseline
  ]);

  useEffect(() => {
    if (!visible) return;
    setExpandedChamberId(null);
    setAddForChamberId(null);
    setClientQuery('');
    setCustomClient('');
    setShowAddChamber(false);
    setNewChamberType('Frozen');
    setNewChamberName('');
    setRenameChamberId(null);
    setRenameValue('');
    setHasUnsavedChanges(false);
    dirtyRef.current = false;
    setLocalLimit(Number(chamberLimit) > 0 ? Number(chamberLimit) : 4);
    load({ silent: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, warehouseName]);

  const isInactive = (row) => {
    const s = String(row?.status || 'active').trim().toLowerCase();
    return (
      s === 'inactive' ||
      s === 'deactive' ||
      s === 'deactivated' ||
      s === 'disabled' ||
      s === '0' ||
      s === 'false'
    );
  };

  const chambersWithClients = useMemo(() => {
    const byId = new Map();
    chambers.forEach((c) => {
      byId.set(String(c.id), {
        id: c.id,
        name: c.name,
        chamber_type: String(c.chamber_type || 'Frozen').trim() || 'Frozen',
        activeClients: [],
        deactiveClients: []
      });
    });
    assignments.forEach((a) => {
      const key = String(a.chamber_id);
      if (!byId.has(key)) {
        byId.set(key, {
          id: a.chamber_id,
          name: a.chamber_name || `Chamber #${a.chamber_id}`,
          chamber_type: String(a.chamber_type || 'Frozen').trim() || 'Frozen',
          activeClients: [],
          deactiveClients: []
        });
      }
      const row = byId.get(key);
      if (a.chamber_type) row.chamber_type = String(a.chamber_type).trim() || row.chamber_type;
      if (isInactive(a)) row.deactiveClients.push(a);
      else row.activeClients.push(a);
    });
    return Array.from(byId.values()).sort((a, b) =>
      String(a.name).localeCompare(String(b.name), undefined, { numeric: true })
    );
  }, [chambers, assignments]);

  const totalActive = useMemo(
    () => assignments.filter((a) => !isInactive(a)).length,
    [assignments]
  );
  const totalDeactive = useMemo(
    () => assignments.filter((a) => isInactive(a)).length,
    [assignments]
  );

  const filteredClients = useMemo(() => {
    const q = clientQuery.trim().toLowerCase();
    if (!q) return clients.slice(0, 40);
    return clients
      .filter(
        (c) =>
          String(c.client_name || '').toLowerCase().includes(q) ||
          String(c.client_code || '').toLowerCase().includes(q)
      )
      .slice(0, 40);
  }, [clients, clientQuery]);

  const updateChamberType = (chamber, nextType) => {
    if (!chamber?.id || !nextType || chamber.chamber_type === nextType) return;
    setChambers((list) =>
      list.map((c) =>
        String(c.id) === String(chamber.id) ? { ...c, chamber_type: nextType } : c
      )
    );
    setAssignments((list) =>
      list.map((a) =>
        String(a.chamber_id) === String(chamber.id) ? { ...a, chamber_type: nextType } : a
      )
    );
    markDirty();
  };

  const removeAssignment = (row) => {
    Alert.alert(
      'Remove client',
      `Remove ${row.client_name || row.client_code} from ${row.chamber_name || 'chamber'}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            setAssignments((list) =>
              list.map((a) => {
                const sameChamber = String(a.chamber_id) === String(row.chamber_id);
                if (!sameChamber) return a;
                if (!sameClient(a, row)) return a;
                return { ...a, status: 'inactive' };
              })
            );
            markDirty();
          }
        }
      ]
    );
  };

  const assignClient = (chamberId, client) => {
    const client_name = client?.client_name || customClient.trim();
    const client_code =
      client?.client_code ||
      generateClientCode(client_name, warehouseName, warehouseCode) ||
      undefined;
    if (!chamberId || !client_name) {
      Alert.alert('Missing', 'Select or type a client name.');
      return;
    }
    const chamber = chambersWithClients.find((c) => String(c.id) === String(chamberId));
    const existingActive = assignments.find(
      (a) =>
        String(a.chamber_id) === String(chamberId) &&
        !isInactive(a) &&
        sameClient(a, { client_name, client_code })
    );
    if (existingActive) {
      setAddForChamberId(null);
      setClientQuery('');
      setCustomClient('');
      return;
    }

    const optimistic = {
      chamber_id: chamberId,
      chamber_name: chamber?.name,
      client_name,
      client_code: client_code || null,
      chamber_type: chamber?.chamber_type || 'Frozen',
      warehouse_name: warehouseName,
      status: 'active'
    };

    setAssignments((list) => {
      const idx = list.findIndex(
        (a) =>
          String(a.chamber_id) === String(chamberId) && sameClient(a, { client_name, client_code })
      );
      if (idx >= 0) {
        const next = [...list];
        next[idx] = {
          ...next[idx],
          status: 'active',
          client_code: client_code || next[idx].client_code
        };
        return next;
      }
      return [...list, optimistic];
    });
    setAddForChamberId(null);
    setClientQuery('');
    setCustomClient('');
    markDirty();
  };

  const renameChamber = (chamber) => {
    if (!chamber?.id) return;
    const nextName = String(renameValue || '').trim();
    if (!nextName) {
      Alert.alert('Missing', 'Chamber name is required.');
      return;
    }
    if (nextName === chamber.name) {
      setRenameChamberId(null);
      setRenameValue('');
      return;
    }
    setChambers((list) =>
      list.map((c) => (String(c.id) === String(chamber.id) ? { ...c, name: nextName } : c))
    );
    setAssignments((list) =>
      list.map((a) =>
        String(a.chamber_id) === String(chamber.id) ? { ...a, chamber_name: nextName } : a
      )
    );
    markDirty();
    setRenameChamberId(null);
    setRenameValue('');
  };

  const reactivateClient = (row) => {
    assignClient(row.chamber_id, {
      client_name: row.client_name,
      client_code: row.client_code
    });
  };

  const nextChamberNumber = useMemo(() => {
    let maxNum = 0;
    chambers.forEach((c) => {
      const n = parseInt(String(c.name || '').replace(/\D/g, ''), 10);
      if (!Number.isNaN(n) && n > maxNum) maxNum = n;
    });
    return maxNum + 1;
  }, [chambers]);

  const addChamber = () => {
    const nextNum = nextChamberNumber;
    const name = String(newChamberName || '').trim() || `Chamber ${nextNum}`;
    const tempId = `tmp-${Date.now()}`;
    setChambers((list) =>
      [
        ...list,
        {
          id: tempId,
          name,
          chamber_type: newChamberType || 'Frozen',
          _isNew: true
        }
      ].sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true })
      )
    );
    setExpandedChamberId(tempId);
    markDirty();
    setShowAddChamber(false);
    setNewChamberType('Frozen');
    setNewChamberName('');
  };

  const persistAllChanges = useCallback(async () => {
    if (!dirtyRef.current) return true;
    if (!apiUrl || !token) return false;

    setBusyKey('save-all');
    setError('');
    try {
      const baseline = baselineRef.current;
      const idMap = new Map();

      const newChambers = chambers.filter((c) => isTempChamberId(c.id));
      for (const ch of newChambers) {
        const name = String(ch.name || '').trim();
        const createRes = await fetch(`${apiUrl}/api/chambers`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name,
            chamber_type: ch.chamber_type || 'Frozen'
          })
        });
        const createData = await createRes.json().catch(() => ({}));
        if (!createRes.ok && createRes.status !== 400) {
          throw new Error(createData.message || createData.error || 'Could not create chamber.');
        }
        let chamberRow = createData?.data || null;
        if (!chamberRow?.id) {
          const cRes = await fetch(`${apiUrl}/api/chambers`, { headers });
          const cData = await cRes.json().catch(() => ({}));
          const rows = Array.isArray(cData.data) ? cData.data : [];
          chamberRow = rows.find(
            (c) => String(c.name || '').toLowerCase() === name.toLowerCase()
          );
        }
        if (!chamberRow?.id) {
          throw new Error(`Could not resolve new chamber "${name}".`);
        }
        idMap.set(String(ch.id), chamberRow.id);
      }

      const resolveChamberId = (id) => {
        const key = String(id);
        return idMap.has(key) ? idMap.get(key) : id;
      };

      for (const ch of chambers) {
        if (isTempChamberId(ch.id)) continue;
        const base = baseline.chambers.find((c) => String(c.id) === String(ch.id));
        if (!base) continue;
        const payload = {};
        if (String(base.name || '') !== String(ch.name || '')) payload.name = ch.name;
        if (
          String(base.chamber_type || 'Frozen') !== String(ch.chamber_type || 'Frozen')
        ) {
          payload.chamber_type = ch.chamber_type || 'Frozen';
        }
        if (!Object.keys(payload).length) continue;
        const res = await fetch(`${apiUrl}/api/chambers/${ch.id}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            ...payload,
            warehouse_name: warehouseName,
            operator_email: operatorEmail || undefined
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || data.error || 'Chamber update failed');
      }

      for (const a of baseline.assignments) {
        if (isInactive(a)) continue;
        const stillActive = assignments.some(
          (c) =>
            !isInactive(c) &&
            String(resolveChamberId(c.chamber_id)) === String(a.chamber_id) &&
            sameClient(c, a)
        );
        if (stillActive) continue;
        const res = await fetch(`${apiUrl}/api/chambers/assignments`, {
          method: 'DELETE',
          headers,
          body: JSON.stringify({
            chamber_id: a.chamber_id,
            client_name: a.client_name,
            client_code: a.client_code,
            warehouse_name: warehouseName,
            warehouse_code: warehouseCode || undefined,
            operator_email: operatorEmail || undefined
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || data.error || 'Remove client failed');
      }

      for (const a of assignments) {
        if (isInactive(a)) continue;
        const chamber_id = resolveChamberId(a.chamber_id);
        const chamber = chambers.find(
          (c) => String(c.id) === String(a.chamber_id) || String(resolveChamberId(c.id)) === String(chamber_id)
        );
        const wasActive = baseline.assignments.some(
          (b) =>
            !isInactive(b) && String(b.chamber_id) === String(chamber_id) && sameClient(b, a)
        );
        if (wasActive) continue;
        const res = await fetch(`${apiUrl}/api/chambers/assignments`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            chamber_id: Number(chamber_id),
            client_name: a.client_name,
            client_code: a.client_code,
            chamber_type: chamber?.chamber_type || a.chamber_type || 'Frozen',
            warehouse_name: warehouseName,
            warehouse_code: warehouseCode || undefined,
            operator_email: operatorEmail || undefined
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || data.error || 'Assign client failed');
      }

      if (newChambers.length > 0 && operatorId) {
        let maxNum = 0;
        chambers.forEach((c) => {
          const n = parseInt(String(c.name || '').replace(/\D/g, ''), 10);
          if (!Number.isNaN(n) && n > maxNum) maxNum = n;
        });
        const newLimit = Math.max(
          maxNum,
          chambers.length,
          Number(localLimit) || 0,
          nextChamberNumber - 1
        );
        const ok = await syncDoChamberLimit(newLimit);
        if (!ok) {
          throw new Error('Chamber limit update failed. Check DO phone in Admin → DOs.');
        }
      }

      await load({ silent: true, refreshBaseline: true });
      return true;
    } catch (err) {
      Alert.alert('Save failed', err.message || 'Could not save changes.');
      return false;
    } finally {
      setBusyKey(null);
    }
  }, [
    apiUrl,
    token,
    headers,
    chambers,
    assignments,
    warehouseName,
    warehouseCode,
    operatorEmail,
    operatorId,
    localLimit,
    nextChamberNumber,
    syncDoChamberLimit,
    load
  ]);

  const requestClose = useCallback(() => {
    if (busyKey === 'save-all') return;
    if (!dirtyRef.current) {
      onClose?.({ hadChanges: false });
      return;
    }
    Alert.alert(
      'Unsaved changes',
      'Nothing is saved until you tap Save & Done. Discard changes and go back?',
      [
        { text: 'Stay', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            resetDraftFromBaseline();
            onClose?.({ hadChanges: false });
          }
        }
      ]
    );
  }, [busyKey, onClose, resetDraftFromBaseline]);

  const handleDone = useCallback(async () => {
    if (busyKey === 'save-all') return;
    if (!dirtyRef.current) {
      onClose?.({ hadChanges: false });
      return;
    }
    const ok = await persistAllChanges();
    if (ok) onClose?.({ hadChanges: true });
  }, [busyKey, onClose, persistAllChanges]);

  const renderClientRow = (row, idx, mode) => {
    const deactive = mode === 'deactive' || isInactive(row);
    const saving = busyKey === 'save-all';
    return (
      <View
        key={`${mode}-${row.client_code || row.client_name}-${row.id || idx}`}
        style={[styles.clientRow, deactive && styles.clientRowDeactive]}
      >
        <View style={[styles.clientDot, deactive && styles.clientDotDeactive]} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.clientName, deactive && styles.clientNameDeactive]}>
            {row.client_name || row.client_code}
          </Text>
          <View style={styles.clientMetaRow}>
            {row.client_code ? (
              <Text style={styles.clientCode}>{row.client_code}</Text>
            ) : null}
            <View style={[styles.statusPill, deactive ? styles.statusDeactive : styles.statusActive]}>
              <Text
                style={[
                  styles.statusPillText,
                  deactive ? styles.statusDeactiveText : styles.statusActiveText
                ]}
              >
                {deactive ? 'Deactive' : 'Active'}
              </Text>
            </View>
          </View>
        </View>
        {deactive ? (
          <TouchableOpacity
            style={styles.reactivateBtn}
            onPress={() => reactivateClient(row)}
            disabled={saving}
          >
            <Text style={styles.reactivateText}>Activate</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.trashBtn}
            onPress={() => removeAssignment(row)}
            disabled={saving}
          >
            <Ionicons name="trash-outline" size={16} color="#dc2626" />
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={requestClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerIcon}>
              <Ionicons name="git-network-outline" size={18} color="#003580" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Chambers & Clients</Text>
              <Text style={styles.sub} numberOfLines={1}>
                {operatorName || operatorEmail || 'DO'} · {warehouseName || '—'}
                {hasUnsavedChanges ? ' · Unsaved' : ''}
              </Text>
            </View>
            <TouchableOpacity onPress={requestClose} style={styles.closeBtn} hitSlop={10}>
              <Ionicons name="close" size={20} color="#64748b" />
            </TouchableOpacity>
          </View>

          <View style={styles.summaryRow}>
            <View style={styles.summaryPill}>
              <Text style={styles.summaryNum}>{chambersWithClients.length}</Text>
              <Text style={styles.summaryLbl}>Chambers</Text>
            </View>
            <View style={[styles.summaryPill, { backgroundColor: '#ecfdf5' }]}>
              <Text style={[styles.summaryNum, { color: '#059669' }]}>{totalActive}</Text>
              <Text style={[styles.summaryLbl, { color: '#059669' }]}>Active</Text>
            </View>
            <View style={[styles.summaryPill, { backgroundColor: '#fef2f2' }]}>
              <Text style={[styles.summaryNum, { color: '#dc2626' }]}>{totalDeactive}</Text>
              <Text style={[styles.summaryLbl, { color: '#dc2626' }]}>Deactive</Text>
            </View>
          </View>

          <View style={styles.addChamberBar}>
            <TouchableOpacity
              style={styles.addChamberBtn}
              onPress={() => {
                setShowAddChamber((v) => {
                  const next = !v;
                  if (next) {
                    setNewChamberName(`Chamber ${nextChamberNumber}`);
                    setNewChamberType('Frozen');
                  }
                  return next;
                });
              }}
              activeOpacity={0.85}
            >
              <Ionicons
                name={showAddChamber ? 'chevron-up' : 'add-circle-outline'}
                size={18}
                color="#fff"
              />
              <Text style={styles.addChamberBtnText}>
                {showAddChamber ? 'Hide' : 'Add chamber'}
              </Text>
            </TouchableOpacity>
          </View>

          {showAddChamber ? (
            <View style={styles.addChamberBox}>
              <Text style={styles.fieldLabel}>Chamber name</Text>
              <TextInput
                style={styles.input}
                value={newChamberName}
                onChangeText={setNewChamberName}
                placeholder={`Chamber ${nextChamberNumber}`}
                placeholderTextColor="#94a3b8"
                autoFocus
              />
              <Text style={styles.fieldLabel}>Type</Text>
              <View style={styles.typeRow}>
                {CHAMBER_TYPES.map((t) => {
                  const active = newChamberType === t;
                  return (
                    <TouchableOpacity
                      key={t}
                      style={[styles.typeChip, active && styles.typeChipActive]}
                      onPress={() => setNewChamberType(t)}
                    >
                      <Text style={[styles.typeChipText, active && styles.typeChipTextActive]}>
                        {t}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <TouchableOpacity
                style={styles.saveBtn}
                onPress={addChamber}
                disabled={busyKey === 'save-all'}
              >
                <Text style={styles.saveBtnText}>Add to list</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {loading && chambersWithClients.length === 0 ? (
            <ActivityIndicator color="#003580" style={{ marginTop: 36 }} />
          ) : error && chambersWithClients.length === 0 ? (
            <View style={styles.errorBox}>
              <Text style={styles.error}>{error}</Text>
              <TouchableOpacity style={styles.retryBtn} onPress={() => load({ silent: false })}>
                <Text style={styles.retryText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={styles.list}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {chambersWithClients.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Ionicons name="cube-outline" size={28} color="#94a3b8" />
                  <Text style={styles.empty}>No chambers for this DO yet.</Text>
                </View>
              ) : (
                chambersWithClients.map((ch) => {
                  const expanded = String(expandedChamberId) === String(ch.id);
                  const adding = String(addForChamberId) === String(ch.id);
                  const typeBusy = busyKey === 'save-all';
                  return (
                    <View key={String(ch.id)} style={styles.chamberCard}>
                      <TouchableOpacity
                        style={styles.chamberHead}
                        onPress={() =>
                          setExpandedChamberId(expanded ? null : ch.id)
                        }
                        activeOpacity={0.85}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={styles.chamberName}>{ch.name}</Text>
                          <Text style={styles.chamberMeta}>
                            {ch.activeClients.length} active · {ch.deactiveClients.length}{' '}
                            deactive · {ch.chamber_type}
                          </Text>
                        </View>
                        <Ionicons
                          name={expanded ? 'chevron-up' : 'chevron-down'}
                          size={18}
                          color="#94a3b8"
                        />
                      </TouchableOpacity>

                      {expanded ? (
                        <View style={styles.chamberBody}>
                          <Text style={styles.fieldLabel}>Chamber name</Text>
                          {String(renameChamberId) === String(ch.id) ? (
                            <View style={styles.renameRow}>
                              <TextInput
                                style={[styles.input, { flex: 1, marginBottom: 0 }]}
                                value={renameValue}
                                onChangeText={setRenameValue}
                                placeholder="Chamber name"
                                placeholderTextColor="#94a3b8"
                                autoFocus
                              />
                              <TouchableOpacity
                                style={styles.renameSaveBtn}
                                onPress={() => renameChamber(ch)}
                                disabled={busyKey === 'save-all'}
                              >
                                <Text style={styles.renameSaveText}>Apply</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={styles.renameCancelBtn}
                                onPress={() => {
                                  setRenameChamberId(null);
                                  setRenameValue('');
                                }}
                              >
                                <Text style={styles.renameCancelText}>Cancel</Text>
                              </TouchableOpacity>
                            </View>
                          ) : (
                            <TouchableOpacity
                              style={styles.renameTrigger}
                              onPress={() => {
                                setRenameChamberId(ch.id);
                                setRenameValue(ch.name || '');
                              }}
                            >
                              <Text style={styles.renameTriggerName}>{ch.name}</Text>
                              <Ionicons name="create-outline" size={16} color="#003580" />
                              <Text style={styles.renameTriggerHint}>Rename</Text>
                            </TouchableOpacity>
                          )}

                          <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Chamber type</Text>
                          <View style={styles.typeRow}>
                            {CHAMBER_TYPES.map((t) => {
                              const active = ch.chamber_type === t;
                              return (
                                <TouchableOpacity
                                  key={t}
                                  style={[
                                    styles.typeChip,
                                    active && styles.typeChipActive,
                                    typeBusy && { opacity: 0.7 }
                                  ]}
                                  onPress={() => updateChamberType(ch, t)}
                                  disabled={typeBusy}
                                >
                                  <Text
                                    style={[
                                      styles.typeChipText,
                                      active && styles.typeChipTextActive
                                    ]}
                                  >
                                    {t}
                                  </Text>
                                </TouchableOpacity>
                              );
                            })}
                          </View>

                          <View style={styles.clientsHead}>
                            <Text style={styles.fieldLabel}>
                              Active clients ({ch.activeClients.length})
                            </Text>
                            <TouchableOpacity
                              style={styles.miniAdd}
                              onPress={() => {
                                setAddForChamberId(adding ? null : ch.id);
                                setClientQuery('');
                                setCustomClient('');
                              }}
                            >
                              <Ionicons
                                name={adding ? 'close' : 'add'}
                                size={14}
                                color="#003580"
                              />
                              <Text style={styles.miniAddText}>{adding ? 'Close' : 'Add'}</Text>
                            </TouchableOpacity>
                          </View>

                          {adding ? (
                            <View style={styles.addBox}>
                              <TextInput
                                style={styles.input}
                                value={clientQuery}
                                onChangeText={setClientQuery}
                                placeholder="Search master clients…"
                                placeholderTextColor="#94a3b8"
                              />
                              <ScrollView
                                horizontal
                                showsHorizontalScrollIndicator={false}
                                style={{ marginBottom: 8 }}
                              >
                                {filteredClients.map((c) => (
                                  <TouchableOpacity
                                    key={String(c.id || c.client_code)}
                                    style={styles.pickChip}
                                    onPress={() => assignClient(ch.id, c)}
                                    disabled={typeBusy}
                                  >
                                    <Text style={styles.pickChipText} numberOfLines={1}>
                                      {c.client_name}
                                    </Text>
                                  </TouchableOpacity>
                                ))}
                              </ScrollView>
                              <Text style={styles.fieldLabel}>Or type new client name</Text>
                              <TextInput
                                style={styles.input}
                                value={customClient}
                                onChangeText={setCustomClient}
                                placeholder="Client name"
                                placeholderTextColor="#94a3b8"
                              />
                              {customClient.trim() ? (
                                <Text style={styles.codePreview}>
                                  Code:{' '}
                                  {generateClientCode(
                                    customClient.trim(),
                                    warehouseName,
                                    warehouseCode
                                  ) || '—'}
                                </Text>
                              ) : null}
                              <TouchableOpacity
                                style={styles.saveBtn}
                                onPress={() => assignClient(ch.id, null)}
                                disabled={typeBusy}
                              >
                                <Text style={styles.saveBtnText}>Assign to {ch.name}</Text>
                              </TouchableOpacity>
                            </View>
                          ) : null}

                          {ch.activeClients.length === 0 ? (
                            <Text style={styles.noClients}>No active clients on this chamber.</Text>
                          ) : (
                            ch.activeClients.map((row, idx) => renderClientRow(row, idx, 'active'))
                          )}

                          <View style={[styles.clientsHead, { marginTop: 12 }]}>
                            <Text style={styles.fieldLabel}>
                              Deactive clients ({ch.deactiveClients.length})
                            </Text>
                          </View>
                          {ch.deactiveClients.length === 0 ? (
                            <Text style={styles.noClients}>No deactive clients.</Text>
                          ) : (
                            ch.deactiveClients.map((row, idx) =>
                              renderClientRow(row, idx, 'deactive')
                            )
                          )}
                        </View>
                      ) : null}
                    </View>
                  );
                })
              )}
            </ScrollView>
          )}

          <View style={styles.footer}>
            {hasUnsavedChanges ? (
              <Text style={styles.footerHint}>Tap Save & Done to save — back will not save.</Text>
            ) : null}
            <TouchableOpacity
              style={[styles.doneFooterBtn, busyKey === 'save-all' && { opacity: 0.7 }]}
              onPress={handleDone}
              disabled={busyKey === 'save-all'}
              activeOpacity={0.85}
            >
              {busyKey === 'save-all' ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.doneFooterText}>
                  {hasUnsavedChanges ? 'Save & Done' : 'Done'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: '#f8fafc'
  },
  sheet: {
    flex: 1,
    backgroundColor: '#f8fafc',
    paddingTop: Platform.OS === 'ios' ? 48 : 12,
    paddingBottom: Platform.OS === 'ios' ? 28 : 14
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#cbd5e1',
    marginTop: 8,
    marginBottom: 6
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 10,
    gap: 10
  },
  headerIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#dbeafe',
    alignItems: 'center',
    justifyContent: 'center'
  },
  title: { fontSize: 16, fontWeight: '800', color: '#0f172a' },
  sub: { fontSize: 12, color: '#64748b', fontWeight: '600', marginTop: 2 },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center'
  },
  summaryRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    marginBottom: 10
  },
  summaryPill: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  summaryNum: { fontSize: 16, fontWeight: '800', color: '#0f172a' },
  summaryLbl: { fontSize: 10, fontWeight: '700', color: '#64748b', marginTop: 2 },
  addChamberBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    marginBottom: 8,
    gap: 10
  },
  addChamberBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#003580',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10
  },
  addChamberBtnText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  addChamberBox: {
    marginHorizontal: 14,
    marginBottom: 10,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#bfdbfe',
    padding: 12
  },
  addChamberName: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 4
  },
  list: { paddingHorizontal: 14, paddingBottom: 24 },
  chamberCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 10,
    overflow: 'hidden'
  },
  chamberHead: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 10
  },
  chamberName: { fontSize: 14, fontWeight: '800', color: '#0f172a' },
  chamberMeta: { fontSize: 11, color: '#64748b', fontWeight: '600', marginTop: 2 },
  chamberBody: {
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    padding: 12,
    paddingTop: 10
  },
  renameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  renameSaveBtn: {
    backgroundColor: '#059669',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  renameSaveText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  renameCancelBtn: {
    backgroundColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10
  },
  renameCancelText: { color: '#475569', fontWeight: '700', fontSize: 12 },
  renameTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginBottom: 4
  },
  renameTriggerName: { flex: 1, fontSize: 13, fontWeight: '700', color: '#0f172a' },
  renameTriggerHint: { fontSize: 11, fontWeight: '800', color: '#003580' },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748b',
    textTransform: 'uppercase',
    marginBottom: 6
  },
  codePreview: {
    fontSize: 10,
    color: '#0369a1',
    fontWeight: '700',
    marginBottom: 8,
    marginTop: -2
  },
  typeRow: { flexDirection: 'row', gap: 6, marginBottom: 12 },
  typeChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  typeChipActive: { backgroundColor: '#003580', borderColor: '#003580' },
  typeChipText: { fontSize: 11, fontWeight: '700', color: '#64748b' },
  typeChipTextActive: { color: '#fff' },
  clientsHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6
  },
  miniAdd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#eff6ff',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8
  },
  miniAddText: { fontSize: 11, fontWeight: '800', color: '#003580' },
  noClients: { fontSize: 12, color: '#94a3b8', fontWeight: '600', marginBottom: 8 },
  clientRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9'
  },
  clientRowDeactive: { opacity: 0.92, backgroundColor: '#fffafa' },
  clientDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#22c55e'
  },
  clientDotDeactive: { backgroundColor: '#f87171' },
  clientName: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  clientNameDeactive: { color: '#64748b', textDecorationLine: 'line-through' },
  clientMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 2
  },
  clientCode: { fontSize: 11, color: '#94a3b8', fontWeight: '600' },
  statusPill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6
  },
  statusActive: { backgroundColor: '#ecfdf5' },
  statusDeactive: { backgroundColor: '#fef2f2' },
  statusPillText: { fontSize: 9, fontWeight: '800' },
  statusActiveText: { color: '#059669' },
  statusDeactiveText: { color: '#dc2626' },
  trashBtn: { padding: 6 },
  reactivateBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#ecfdf5',
    borderWidth: 1,
    borderColor: '#a7f3d0'
  },
  reactivateText: { fontSize: 11, fontWeight: '800', color: '#059669' },
  addBox: {
    marginTop: 4,
    marginBottom: 10,
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 10
  },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#0f172a',
    backgroundColor: '#fff',
    marginBottom: 8
  },
  pickChip: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginRight: 6,
    maxWidth: 160
  },
  pickChipText: { fontSize: 11, fontWeight: '700', color: '#003580' },
  saveBtn: {
    backgroundColor: '#059669',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center'
  },
  saveBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  footer: {
    paddingHorizontal: 14,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#fff'
  },
  footerHint: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b',
    textAlign: 'center',
    marginBottom: 8
  },
  doneFooterBtn: {
    backgroundColor: '#003580',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center'
  },
  doneFooterText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  emptyBox: { alignItems: 'center', paddingTop: 40, gap: 8 },
  empty: { color: '#94a3b8', fontWeight: '600' },
  errorBox: { alignItems: 'center', paddingTop: 28, paddingHorizontal: 20 },
  error: { color: '#dc2626', fontWeight: '700', textAlign: 'center' },
  retryBtn: {
    marginTop: 12,
    backgroundColor: '#003580',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8
  },
  retryText: { color: '#fff', fontWeight: '700' }
});
