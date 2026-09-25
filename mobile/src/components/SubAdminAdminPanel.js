import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Modal,
  ActivityIndicator,
  Alert,
  RefreshControl,
  Platform,
  KeyboardAvoidingView
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import FastTouchable from './FastTouchable';
import SavedChangesPopup from './SavedChangesPopup';
import { generateClientCode } from '../utils/generateClientCode';
import { generateWarehouseCode } from '../utils/generateWarehouseCode';

const TouchableOpacity = FastTouchable;

function StatusBadge({ status }) {
  const s = String(status || 'Pending');
  const tone =
    s === 'Approved'
      ? { bg: '#ecfdf5', fg: '#059669' }
      : s === 'Denied'
        ? { bg: '#fef2f2', fg: '#dc2626' }
        : { bg: '#fffbeb', fg: '#d97706' };
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg }]}>
      <Text style={[styles.badgeText, { color: tone.fg }]}>{s}</Text>
    </View>
  );
}

/**
 * Sub-Admin Admin panel — three sections:
 *   1) Permissions — approve/deny DO requests
 *   2) DOs — create/edit operators (warehouse + chamber_limit)
 *   3) Master — catalog warehouse_master / client_master CRUD
 * Chamber↔client assignments for a DO are edited in SubAdminDoMasterSetup, not here.
 */
export default function SubAdminAdminPanel({
  apiUrl,
  token,
  authHeaders,
  permissionItems = [],
  permissionLoading = false,
  onRefreshPermissions,
  onApprovePermission,
  onDenyPermission,
  permissionBusyId = null,
  onOpenDoProfile,
  initialSection = 'permissions',
  permissionsUpdatedAt = null,
  initialPermFilter = 'pending'
}) {
  const [section, setSection] = useState(initialSection);
  useEffect(() => {
    if (initialSection) setSection(initialSection);
  }, [initialSection]);
  const [permFilter, setPermFilter] = useState(initialPermFilter); // pending | decided | all
  useEffect(() => {
    if (initialPermFilter) setPermFilter(initialPermFilter);
  }, [initialPermFilter]);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');

  const [operators, setOperators] = useState([]);
  const [opsLoading, setOpsLoading] = useState(false);
  const [opsError, setOpsError] = useState('');
  const [doFormOpen, setDoFormOpen] = useState(false);
  const [editingDo, setEditingDo] = useState(null);
  const [doBusy, setDoBusy] = useState(false);
  const [doForm, setDoForm] = useState({
    full_name: '',
    email: '',
    phone_no: '',
    password: '',
    warehouse_name: '',
    chamber_limit: '4'
  });

  const [masterTab, setMasterTab] = useState('warehouses');
  const [warehouses, setWarehouses] = useState([]);
  const [clients, setClients] = useState([]);
  const [clientAssignments, setClientAssignments] = useState([]);
  const [mastersLoading, setMastersLoading] = useState(false);
  const [mastersError, setMastersError] = useState('');
  const [masterFormOpen, setMasterFormOpen] = useState(false);
  const [masterBusy, setMasterBusy] = useState(false);
  const [whForm, setWhForm] = useState({ warehouse_code: '', warehouse_name: '', city: '' });
  const [clForm, setClForm] = useState({
    client_code: '',
    client_name: '',
    warehouse_name: '',
    warehouse_code: ''
  });
  const [editingMasterId, setEditingMasterId] = useState(null);
  const clientCodeManualRef = useRef(false);
  const whCodeManualRef = useRef(false);
  const [savedPopup, setSavedPopup] = useState({
    visible: false,
    title: 'Changes saved',
    message: 'Your updates were saved successfully.'
  });

  const showSaved = (title, message) => {
    setSavedPopup({
      visible: true,
      title: title || 'Changes saved',
      message: message || 'Your updates were saved successfully.'
    });
  };

  const headers = useMemo(
    () => ({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(authHeaders || {}),
      Authorization: authHeaders?.Authorization || (token ? `Bearer ${token}` : undefined)
    }),
    [authHeaders, token]
  );

  const loadOperators = useCallback(async () => {
    if (!apiUrl || !token) return;
    setOpsLoading(true);
    setOpsError('');
    try {
      const res = await fetch(`${apiUrl}/api/do-operators`, { headers });
      const data = await res.json().catch(() => ([]));
      if (!res.ok) throw new Error(data.error || data.message || `Failed (${res.status})`);
      setOperators(Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : []);
    } catch (err) {
      setOpsError(err.message || 'Failed to load DOs.');
      setOperators([]);
    } finally {
      setOpsLoading(false);
    }
  }, [apiUrl, token, headers]);

  const loadMasters = useCallback(async () => {
    if (!apiUrl || !token) return;
    setMastersLoading(true);
    setMastersError('');
    try {
      const [whRes, clRes, asgRes] = await Promise.all([
        fetch(`${apiUrl}/api/masters/warehouses?active_only=0`, { headers }),
        fetch(`${apiUrl}/api/masters/clients?active_only=0`, { headers }),
        // Include inactive chamber-client rows (soft-deactivated clients)
        fetch(`${apiUrl}/api/chambers/assignments`, { headers })
      ]);
      const whData = await whRes.json().catch(() => ({}));
      const clData = await clRes.json().catch(() => ({}));
      const asgData = await asgRes.json().catch(() => ({}));
      if (!whRes.ok) throw new Error(whData.message || `Warehouses failed (${whRes.status})`);
      if (!clRes.ok) throw new Error(clData.message || `Clients failed (${clRes.status})`);
      setWarehouses(Array.isArray(whData.data) ? whData.data : []);
      setClients(Array.isArray(clData.data) ? clData.data : []);
      const assigns = Array.isArray(asgData.data)
        ? asgData.data
        : Array.isArray(asgData)
          ? asgData
          : [];
      setClientAssignments(assigns);
    } catch (err) {
      setMastersError(err.message || 'Failed to load master data.');
      setWarehouses([]);
      setClients([]);
      setClientAssignments([]);
    } finally {
      setMastersLoading(false);
    }
  }, [apiUrl, token, headers]);

  /** Catalog + chamber assignments — so soft-deactivated clients also appear. */
  const displayClients = useMemo(() => {
    const isAssignInactive = (row) => {
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

    const keyOf = (name, warehouse, code) =>
      `${String(name || '').trim().toLowerCase()}|${String(warehouse || '')
        .trim()
        .toLowerCase()}`;

    const map = new Map();

    (clients || []).forEach((c) => {
      const name = String(c.client_name || '').trim();
      if (!name) return;
      const key = keyOf(name, c.warehouse_name);
      map.set(key, {
        id: c.id,
        client_code: c.client_code || null,
        client_name: name,
        warehouse_name: c.warehouse_name || null,
        warehouse_code: c.warehouse_code || null,
        is_active: Number(c.is_active) === 0 ? 0 : 1,
        _fromCatalog: true,
        _hasActiveAssign: false,
        _hasDeactiveAssign: false
      });
    });

    (clientAssignments || []).forEach((a) => {
      const name = String(a.client_name || '').trim();
      if (!name) return;
      const inactive = isAssignInactive(a);
      const key = keyOf(name, a.warehouse_name);
      const prev = map.get(key);
      if (!prev) {
        map.set(key, {
          id: `asg-${a.chamber_id}-${name}`,
          client_code: a.client_code || null,
          client_name: name,
          warehouse_name: a.warehouse_name || null,
          warehouse_code: a.warehouse_code || null,
          is_active: inactive ? 0 : 1,
          _fromCatalog: false,
          _hasActiveAssign: !inactive,
          _hasDeactiveAssign: inactive,
          chamber_name: a.chamber_name || null
        });
        return;
      }
      if (inactive) prev._hasDeactiveAssign = true;
      else prev._hasActiveAssign = true;
      if (a.client_code && !prev.client_code) prev.client_code = a.client_code;
      if (a.chamber_name) prev.chamber_name = a.chamber_name;
    });

    return Array.from(map.values()).map((row) => {
      // Prefer operational assignment status: deactive assignment → show Deactive
      // even if catalog is_active is still 1
      let is_active = row.is_active;
      if (row._hasDeactiveAssign && !row._hasActiveAssign) is_active = 0;
      else if (row._hasActiveAssign) is_active = 1;
      else if (!row._fromCatalog && row._hasDeactiveAssign) is_active = 0;
      return { ...row, is_active };
    });
  }, [clients, clientAssignments]);

  useEffect(() => {
    if (section === 'dos') {
      loadOperators();
      loadMasters();
    }
    if (section === 'masters') loadMasters();
  }, [section, loadOperators, loadMasters]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      if (section === 'permissions') await onRefreshPermissions?.();
      if (section === 'dos') {
        await loadOperators();
        await loadMasters();
      }
      if (section === 'masters') await loadMasters();
    } finally {
      setRefreshing(false);
    }
  };

  const filteredPerms = useMemo(() => {
    let list = [...permissionItems];
    if (permFilter === 'pending') list = list.filter((n) => n.status === 'Pending');
    if (permFilter === 'decided') {
      list = list.filter((n) => n.status === 'Approved' || n.status === 'Denied');
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((n) =>
        `${n._title || ''} ${n._subtitle || ''} ${n.operator_email || ''} ${n.chamber_name || ''}`
          .toLowerCase()
          .includes(q)
      );
    }
    return list;
  }, [permissionItems, permFilter, search]);

  const filteredOps = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return operators;
    const tokens = q.split(/\s+/).filter(Boolean);
    return operators.filter((op) => {
      const hay = [
        op.full_name,
        op.name,
        op.email,
        op.phone_no,
        op.warehouse_name,
        op.warehouse_code,
        op.chamber_limit != null ? `chambers ${op.chamber_limit}` : ''
      ]
        .map((v) => String(v || '').toLowerCase().trim())
        .filter(Boolean)
        .join(' · ');
      return tokens.every((t) => hay.includes(t));
    });
  }, [operators, search]);

  const isMasterActive = (row) => {
    const v = row?.is_active;
    if (v === false || v === 0 || v === '0') return false;
    return Number(v) !== 0;
  };

  const filteredMasters = useMemo(() => {
    const q = search.trim().toLowerCase();
    const src = masterTab === 'warehouses' ? warehouses : displayClients;
    const list = !q
      ? [...src]
      : src.filter((row) => JSON.stringify(row).toLowerCase().includes(q));
    // Active first, then Deactive — both always visible
    return list.sort((a, b) => {
      const aActive = isMasterActive(a) ? 0 : 1;
      const bActive = isMasterActive(b) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      const an =
        masterTab === 'warehouses'
          ? String(a.warehouse_name || '')
          : String(a.client_name || '');
      const bn =
        masterTab === 'warehouses'
          ? String(b.warehouse_name || '')
          : String(b.client_name || '');
      return an.localeCompare(bn, undefined, { numeric: true });
    });
  }, [masterTab, warehouses, displayClients, search]);

  const activeMasterRows = useMemo(
    () => filteredMasters.filter((r) => isMasterActive(r)),
    [filteredMasters]
  );
  const deactiveMasterRows = useMemo(
    () => filteredMasters.filter((r) => !isMasterActive(r)),
    [filteredMasters]
  );

  const pendingCount = permissionItems.filter((n) => n.status === 'Pending').length;

  const openCreateDo = () => {
    setEditingDo(null);
    setDoForm({
      full_name: '',
      email: '',
      phone_no: '',
      password: '',
      warehouse_name: '',
      chamber_limit: '4'
    });
    loadMasters();
    setDoFormOpen(true);
  };

  const openEditDo = (op) => {
    setEditingDo(op);
    setDoForm({
      full_name: op.full_name || '',
      email: op.email || '',
      phone_no: String(op.phone_no || '').replace(/^\+91/, ''),
      password: '',
      warehouse_name: op.warehouse_name || '',
      chamber_limit: String(op.chamber_limit != null ? op.chamber_limit : 4)
    });
    loadMasters();
    setDoFormOpen(true);
  };

  const saveDo = async () => {
    if (!apiUrl || !token) return;
    const payload = {
      full_name: doForm.full_name.trim(),
      email: doForm.email.trim().toLowerCase(),
      phone_no: doForm.phone_no.trim(),
      warehouse_name: doForm.warehouse_name.trim(),
      chamber_limit: editingDo
        ? parseInt(editingDo.chamber_limit, 10) || 4
        : 4
    };
    if (!payload.full_name || !payload.email || !payload.phone_no || !payload.warehouse_name) {
      Alert.alert('Missing fields', 'Name, email, phone and warehouse are required.');
      return;
    }
    const whOk = activeWarehouses.some(
      (w) =>
        String(w.warehouse_name || '').trim().toLowerCase() ===
        payload.warehouse_name.toLowerCase()
    );
    if (!whOk) {
      Alert.alert(
        'Select warehouse',
        'Choose a warehouse from the Master list (tap a suggestion). Add new places under Master → Warehouses first.'
      );
      return;
    }
    if (!editingDo && !doForm.password.trim()) {
      Alert.alert('Missing password', 'Password is required for new DO.');
      return;
    }
    if (!editingDo || doForm.password.trim()) payload.password = doForm.password.trim();
    setDoBusy(true);
    try {
      const url = editingDo
        ? `${apiUrl}/api/do-operators/${editingDo.id}`
        : `${apiUrl}/api/do-operators`;
      const res = await fetch(url, {
        method: editingDo ? 'PUT' : 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || `Save failed (${res.status})`);
      setDoFormOpen(false);
      await loadOperators();
      showSaved(
        editingDo ? 'DO updated' : 'DO created',
        data.message || 'Data operator changes were saved successfully.'
      );
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not save DO.');
    } finally {
      setDoBusy(false);
    }
  };

  const deleteDo = (op) => {
    Alert.alert('Revoke DO access', `Delete operator ${op.full_name || op.email}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            const res = await fetch(`${apiUrl}/api/do-operators/${op.id}`, {
              method: 'DELETE',
              headers
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || data.message || 'Delete failed');
            await loadOperators();
            showSaved('DO revoked', 'Operator access was removed successfully.');
          } catch (err) {
            Alert.alert('Error', err.message || 'Could not delete DO.');
          }
        }
      }
    ]);
  };

  const catalogIdOf = (row) => {
    const id = Number(row?.id);
    if (!Number.isFinite(id) || id <= 0) return null;
    if (String(row?.id).startsWith('asg-')) return null;
    return id;
  };

  const saveWarehouse = async () => {
    const warehouse_name = whForm.warehouse_name.trim();
    const city = whForm.city.trim() || null;
    const existingCodes = warehouses.map((w) => w.warehouse_code);
    let warehouse_code = whForm.warehouse_code.trim().toUpperCase();
    if (!editingMasterId) {
      warehouse_code =
        warehouse_code || generateWarehouseCode(warehouse_name, '', existingCodes);
    }
    if (!warehouse_name) {
      Alert.alert('Missing fields', 'Warehouse name is required.');
      return;
    }
    if (!editingMasterId && !warehouse_code) {
      Alert.alert('Missing fields', 'Warehouse code could not be generated. Enter a name.');
      return;
    }
    setMasterBusy(true);
    try {
      const isEdit = !!editingMasterId;
      const url = isEdit
        ? `${apiUrl}/api/masters/warehouses/${editingMasterId}`
        : `${apiUrl}/api/masters/warehouses`;
      const body = isEdit
        ? { warehouse_name, city }
        : {
            warehouse_code,
            warehouse_name,
            city
          };
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers,
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'Save failed');
      setMasterFormOpen(false);
      setEditingMasterId(null);
      whCodeManualRef.current = false;
      setWhForm({ warehouse_code: '', warehouse_name: '', city: '' });
      await loadMasters();
      showSaved(
        isEdit ? 'Warehouse updated' : 'Warehouse saved',
        data.message ||
          (isEdit
            ? 'Warehouse was saved successfully.'
            : `Warehouse saved as ${data?.data?.warehouse_code || warehouse_code}.`)
      );
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not save warehouse.');
    } finally {
      setMasterBusy(false);
    }
  };

  const saveClient = async () => {
    const client_name = clForm.client_name.trim();
    const warehouse_name = clForm.warehouse_name.trim();
    let client_code = clForm.client_code.trim().toUpperCase();
    if (!client_code && client_name) {
      client_code = generateClientCode(client_name, warehouse_name, clForm.warehouse_code);
    }
    if (!client_name) {
      Alert.alert('Missing fields', 'Client name is required.');
      return;
    }
    setMasterBusy(true);
    try {
      const isEdit = !!editingMasterId;
      const url = isEdit
        ? `${apiUrl}/api/masters/clients/${editingMasterId}`
        : `${apiUrl}/api/masters/clients`;
      const body = isEdit
        ? { client_name, warehouse_name: warehouse_name || null }
        : {
            client_code: client_code || undefined,
            client_name,
            warehouse_name: warehouse_name || null,
            warehouse_code: clForm.warehouse_code || undefined
          };
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers,
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'Save failed');
      setMasterFormOpen(false);
      setEditingMasterId(null);
      clientCodeManualRef.current = false;
      setClForm({ client_code: '', client_name: '', warehouse_name: '', warehouse_code: '' });
      await loadMasters();
      showSaved(
        isEdit ? 'Client updated' : 'Client saved',
        data.message || 'Client was saved successfully.'
      );
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not save client.');
    } finally {
      setMasterBusy(false);
    }
  };

  const activeWarehouses = warehouses.filter((w) => Number(w.is_active) !== 0);

  useEffect(() => {
    if (masterTab !== 'clients' || clientCodeManualRef.current || editingMasterId) return;
    const code = generateClientCode(
      clForm.client_name,
      clForm.warehouse_name,
      clForm.warehouse_code
    );
    if (code !== clForm.client_code) {
      setClForm((p) => ({ ...p, client_code: code }));
    }
  }, [clForm.client_name, clForm.warehouse_name, clForm.warehouse_code, masterTab, editingMasterId]);

  useEffect(() => {
    if (masterTab !== 'warehouses' || whCodeManualRef.current || editingMasterId || !masterFormOpen) {
      return;
    }
    const existingCodes = warehouses.map((w) => w.warehouse_code);
    const code = generateWarehouseCode(whForm.warehouse_name, '', existingCodes);
    if (code !== whForm.warehouse_code) {
      setWhForm((p) => ({ ...p, warehouse_code: code }));
    }
  }, [
    whForm.warehouse_name,
    whForm.warehouse_code,
    masterTab,
    editingMasterId,
    masterFormOpen,
    warehouses
  ]);

  const openMasterAddForm = () => {
    clientCodeManualRef.current = false;
    whCodeManualRef.current = false;
    setEditingMasterId(null);
    if (masterTab === 'clients') {
      setClForm({ client_code: '', client_name: '', warehouse_name: '', warehouse_code: '' });
    } else {
      setWhForm({ warehouse_code: '', warehouse_name: '', city: '' });
    }
    setMasterFormOpen(true);
  };

  const openMasterEdit = (row) => {
    const id = catalogIdOf(row);
    if (!id) {
      Alert.alert('Not in catalog', 'This row is assignment-only. Add it to the catalog first.');
      return;
    }
    setEditingMasterId(id);
    if (masterTab === 'warehouses') {
      whCodeManualRef.current = true;
      setWhForm({
        warehouse_code: row.warehouse_code || '',
        warehouse_name: row.warehouse_name || '',
        city: row.city || ''
      });
    } else {
      clientCodeManualRef.current = true;
      setClForm({
        client_code: row.client_code || '',
        client_name: row.client_name || '',
        warehouse_name: row.warehouse_name || '',
        warehouse_code: row.warehouse_code || ''
      });
    }
    setMasterFormOpen(true);
  };

  const setMasterActive = (row, nextActive) => {
    const id = catalogIdOf(row);
    if (!id) {
      Alert.alert('Not in catalog', 'This row cannot be updated from Master.');
      return;
    }
    const isWh = masterTab === 'warehouses';
    const label = isWh ? row.warehouse_name : row.client_name;
    Alert.alert(
      nextActive ? 'Activate' : 'Delete',
      nextActive
        ? `Activate ${label || 'this record'}?`
        : `Deactivate ${label || 'this record'}? Existing logs stay.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: nextActive ? 'Activate' : 'Delete',
          style: nextActive ? 'default' : 'destructive',
          onPress: async () => {
            try {
              const path = isWh ? 'warehouses' : 'clients';
              const res = await fetch(`${apiUrl}/api/masters/${path}/${id}`, {
                method: nextActive ? 'PUT' : 'DELETE',
                headers,
                body: nextActive ? JSON.stringify({ is_active: 1 }) : undefined
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(data.message || data.error || 'Update failed');
              await loadMasters();
              showSaved(
                nextActive ? 'Activated' : 'Deactivated',
                data.message || (nextActive ? 'Record is active again.' : 'Record deactivated.')
              );
            } catch (err) {
              Alert.alert('Error', err.message || 'Could not update record.');
            }
          }
        }
      ]
    );
  };

  const renderMasterActions = (row, active) => {
    const id = catalogIdOf(row);
    if (!id) return null;
    return (
      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[styles.actionBtn, styles.editBtn]}
          onPress={() => openMasterEdit(row)}
        >
          <Ionicons name="create-outline" size={13} color="#fff" />
          <Text style={styles.actionBtnText}>Edit</Text>
        </TouchableOpacity>
        {active ? (
          <TouchableOpacity
            style={[styles.actionBtn, styles.denyBtn]}
            onPress={() => setMasterActive(row, false)}
          >
            <Ionicons name="trash-outline" size={13} color="#fff" />
            <Text style={styles.actionBtnText}>Delete</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.actionBtn, styles.approveBtn]}
            onPress={() => setMasterActive(row, true)}
          >
            <Ionicons name="refresh-outline" size={13} color="#fff" />
            <Text style={styles.actionBtnText}>Activate</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>Admin Control</Text>
        <Text style={styles.heroSub}>Permissions · Data Operators · Master data</Text>
      </View>

      <View style={styles.sectionRow}>
        {[
          { id: 'permissions', label: 'Permission', icon: 'shield-checkmark', count: pendingCount },
          { id: 'dos', label: 'DOs', icon: 'people' },
          { id: 'masters', label: 'Master', icon: 'business' }
        ].map((s) => {
          const active = section === s.id;
          return (
            <TouchableOpacity
              key={s.id}
              style={[styles.sectionChip, active && styles.sectionChipActive]}
              onPress={() => {
                setSection(s.id);
                setSearch('');
              }}
              activeOpacity={0.85}
            >
              <Ionicons name={s.icon} size={13} color={active ? '#fff' : '#003580'} />
              <Text style={[styles.sectionChipText, active && styles.sectionChipTextActive]}>
                {s.label}
              </Text>
              {s.count > 0 ? (
                <View style={[styles.countDot, active && styles.countDotActive]}>
                  <Text style={[styles.countDotText, active && styles.countDotTextActive]}>
                    {s.count}
                  </Text>
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.searchWrap}>
        <Ionicons name="search" size={14} color="#94a3b8" />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder={
            section === 'permissions'
              ? 'Search permission requests…'
              : section === 'dos'
                ? 'Search DOs by name, email, warehouse, phone…'
                : 'Search master…'
          }
          placeholderTextColor="#94a3b8"
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={14} color="#94a3b8" />
          </TouchableOpacity>
        ) : null}
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {section === 'permissions' ? (
          <>
            <View style={styles.filterRow}>
              {[
                { id: 'pending', label: 'Pending' },
                { id: 'decided', label: 'Decided' },
                { id: 'all', label: 'All' }
              ].map((f) => {
                const active = permFilter === f.id;
                return (
                  <TouchableOpacity
                    key={f.id}
                    style={[styles.filterChip, active && styles.filterChipActive]}
                    onPress={() => setPermFilter(f.id)}
                  >
                    <Text style={[styles.filterText, active && styles.filterTextActive]}>
                      {f.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {permissionsUpdatedAt ? (
              <Text style={styles.updatedAt}>Updated · {permissionsUpdatedAt}</Text>
            ) : null}

            {permissionLoading && !refreshing ? (
              <ActivityIndicator color="#003580" style={{ marginTop: 24 }} />
            ) : filteredPerms.length === 0 ? (
              <View style={styles.emptyBox}>
                <Ionicons name="shield-checkmark-outline" size={22} color="#94a3b8" />
                <Text style={styles.empty}>No permission requests here.</Text>
              </View>
            ) : (
              filteredPerms.map((n) => {
                const pending = n.status === 'Pending';
                const approving = permissionBusyId === `${n.id}-Approved`;
                const denying = permissionBusyId === `${n.id}-Denied`;
                return (
                  <View key={String(n.id)} style={styles.card}>
                    <View style={styles.cardTop}>
                      <View style={styles.cardIcon}>
                        <Ionicons name="key-outline" size={14} color="#003580" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.cardTitle} numberOfLines={2}>
                          {n._title || n.action_type || 'Request'}
                        </Text>
                        <Text style={styles.cardMeta} numberOfLines={2}>
                          {n.operator_email || n.requested_by || 'DO'}
                          {n.chamber_name ? ` · ${n.chamber_name}` : ''}
                        </Text>
                      </View>
                      <StatusBadge status={n.status} />
                    </View>
                    <Text style={styles.cardBody} numberOfLines={3}>
                      {n._subtitle || n.details || n.message || '—'}
                    </Text>
                    {pending ? (
                      <View style={styles.actionRow}>
                        <TouchableOpacity
                          style={[styles.actionBtn, styles.approveBtn]}
                          onPress={() => onApprovePermission?.(n.id)}
                          disabled={!!permissionBusyId}
                        >
                          {approving ? (
                            <ActivityIndicator size="small" color="#fff" />
                          ) : (
                            <>
                              <Ionicons name="checkmark" size={14} color="#fff" />
                              <Text style={styles.actionBtnText}>Approve</Text>
                            </>
                          )}
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.actionBtn, styles.denyBtn]}
                          onPress={() => onDenyPermission?.(n.id)}
                          disabled={!!permissionBusyId}
                        >
                          {denying ? (
                            <ActivityIndicator size="small" color="#fff" />
                          ) : (
                            <>
                              <Ionicons name="close" size={14} color="#fff" />
                              <Text style={styles.actionBtnText}>Deny</Text>
                            </>
                          )}
                        </TouchableOpacity>
                      </View>
                    ) : null}
                  </View>
                );
              })
            )}
          </>
        ) : null}

        {section === 'dos' ? (
          <>
            <View style={styles.toolbar}>
              <Text style={styles.hint}>
                {search.trim()
                  ? `${filteredOps.length} of ${operators.length} DO(s)`
                  : `${filteredOps.length} operator(s)`}
              </Text>
              <TouchableOpacity style={styles.addBtn} onPress={openCreateDo}>
                <Ionicons name="person-add" size={13} color="#fff" />
                <Text style={styles.addBtnText}>Add DO</Text>
              </TouchableOpacity>
            </View>
            {opsLoading && !refreshing ? (
              <ActivityIndicator color="#003580" style={{ marginTop: 24 }} />
            ) : opsError ? (
              <Text style={styles.error}>{opsError}</Text>
            ) : filteredOps.length === 0 ? (
              <View style={styles.emptyBox}>
                <Ionicons
                  name={search.trim() ? 'search-outline' : 'people-outline'}
                  size={22}
                  color="#94a3b8"
                />
                <Text style={styles.empty}>
                  {search.trim()
                    ? `No DOs match “${search.trim()}”. Try name, email, warehouse or phone.`
                    : 'No data operators yet.'}
                </Text>
                {search.trim() ? (
                  <TouchableOpacity style={styles.clearSearchBtn} onPress={() => setSearch('')}>
                    <Text style={styles.clearSearchText}>Clear search</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : (
              filteredOps.map((op) => (
                <TouchableOpacity
                  key={String(op.id)}
                  style={styles.card}
                  activeOpacity={0.9}
                  onPress={() => onOpenDoProfile?.(op)}
                >
                  <View style={styles.cardTop}>
                    <View style={[styles.cardIcon, { backgroundColor: '#dbeafe' }]}>
                      <Ionicons name="person" size={14} color="#003580" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardTitle}>{op.full_name || op.email}</Text>
                      <Text style={styles.cardMeta} numberOfLines={1}>
                        {op.email}
                        {op.phone_no ? ` · ${op.phone_no}` : ''}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color="#94a3b8" />
                  </View>
                  <View style={styles.metaChips}>
                    <View style={styles.metaChip}>
                      <Ionicons name="business-outline" size={11} color="#0369a1" />
                      <Text style={styles.metaChipText} numberOfLines={1}>
                        {op.warehouse_name || 'No warehouse'}
                        {op.warehouse_code ? ` (${op.warehouse_code})` : ''}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.actionRow}>
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.editBtn]}
                      onPress={() => openEditDo(op)}
                    >
                      <Ionicons name="create-outline" size={13} color="#fff" />
                      <Text style={styles.actionBtnText}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.denyBtn]}
                      onPress={() => deleteDo(op)}
                    >
                      <Text style={styles.actionBtnText}>Revoke</Text>
                    </TouchableOpacity>
                  </View>
                </TouchableOpacity>
              ))
            )}
          </>
        ) : null}

        {section === 'masters' ? (
          <>
            <View style={styles.masterTabs}>
              <TouchableOpacity
                style={[styles.masterTab, masterTab === 'warehouses' && styles.masterTabActive]}
                onPress={() => setMasterTab('warehouses')}
              >
                <Text
                  style={[
                    styles.masterTabText,
                    masterTab === 'warehouses' && styles.masterTabTextActive
                  ]}
                >
                  Warehouses
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.masterTab, masterTab === 'clients' && styles.masterTabActive]}
                onPress={() => setMasterTab('clients')}
              >
                <Text
                  style={[
                    styles.masterTabText,
                    masterTab === 'clients' && styles.masterTabTextActive
                  ]}
                >
                  Clients
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.addBtn} onPress={openMasterAddForm}>
                <Ionicons name="add" size={14} color="#fff" />
                <Text style={styles.addBtnText}>Add</Text>
              </TouchableOpacity>
            </View>
            {mastersLoading && !refreshing ? (
              <ActivityIndicator color="#003580" style={{ marginTop: 24 }} />
            ) : mastersError ? (
              <Text style={styles.error}>{mastersError}</Text>
            ) : filteredMasters.length === 0 ? (
              <View style={styles.emptyBox}>
                <Ionicons name="business-outline" size={22} color="#94a3b8" />
                <Text style={styles.empty}>No master records.</Text>
              </View>
            ) : (
              <>
                <Text style={styles.masterGroupTitle}>
                  Active ({activeMasterRows.length})
                </Text>
                {activeMasterRows.length === 0 ? (
                  <Text style={styles.masterGroupEmpty}>No active records.</Text>
                ) : (
                  activeMasterRows.map((row) => (
                    <View key={`a-${String(row.id)}`} style={styles.card}>
                      <Text style={styles.cardTitle}>
                        {masterTab === 'warehouses' ? row.warehouse_name : row.client_name}
                      </Text>
                      <Text style={styles.cardMeta}>
                        {masterTab === 'warehouses'
                          ? `${row.warehouse_code || '—'}${row.city ? ` · ${row.city}` : ''}`
                          : `${row.client_code || '—'}${
                              row.warehouse_name ? ` · ${row.warehouse_name}` : ''
                            }${row.chamber_name ? ` · ${row.chamber_name}` : ''}`}
                      </Text>
                      <View style={[styles.statusPill, styles.statusActive]}>
                        <Text style={[styles.statusPillText, styles.statusActiveText]}>Active</Text>
                      </View>
                      {renderMasterActions(row, true)}
                    </View>
                  ))
                )}

                <Text style={[styles.masterGroupTitle, styles.masterGroupTitleDeactive]}>
                  Deactive ({deactiveMasterRows.length})
                </Text>
                {deactiveMasterRows.length === 0 ? (
                  <Text style={styles.masterGroupEmpty}>No deactive records.</Text>
                ) : (
                  deactiveMasterRows.map((row) => (
                    <View
                      key={`d-${String(row.id)}`}
                      style={[styles.card, styles.cardDeactive]}
                    >
                      <Text style={[styles.cardTitle, styles.cardTitleDeactive]}>
                        {masterTab === 'warehouses' ? row.warehouse_name : row.client_name}
                      </Text>
                      <Text style={styles.cardMeta}>
                        {masterTab === 'warehouses'
                          ? `${row.warehouse_code || '—'}${row.city ? ` · ${row.city}` : ''}`
                          : `${row.client_code || '—'}${
                              row.warehouse_name ? ` · ${row.warehouse_name}` : ''
                            }${row.chamber_name ? ` · ${row.chamber_name}` : ''}`}
                      </Text>
                      <View style={[styles.statusPill, styles.statusDeactive]}>
                        <Text style={[styles.statusPillText, styles.statusDeactiveText]}>
                          Deactive
                        </Text>
                      </View>
                      {renderMasterActions(row, false)}
                    </View>
                  ))
                )}
              </>
            )}
          </>
        ) : null}
      </ScrollView>

      <Modal visible={doFormOpen} transparent animationType="slide" onRequestClose={() => setDoFormOpen(false)}>
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>{editingDo ? 'Edit DO profile' : 'Add Data Operator'}</Text>
            {[
              ['full_name', 'Full name'],
              ['email', 'Email'],
              ['phone_no', 'Phone (10 digit)'],
              ['password', editingDo ? 'New password (optional)' : 'Password']
            ].map(([key, label]) => (
              <View key={key} style={styles.field}>
                <Text style={styles.fieldLabel}>{label}</Text>
                <TextInput
                  style={styles.input}
                  value={String(doForm[key] || '')}
                  onChangeText={(t) => setDoForm((p) => ({ ...p, [key]: t }))}
                  autoCapitalize={key === 'email' ? 'none' : 'sentences'}
                  keyboardType={key === 'phone_no' ? 'number-pad' : 'default'}
                  secureTextEntry={key === 'password'}
                  placeholder={label}
                  placeholderTextColor="#94a3b8"
                />
              </View>
            ))}
            <Text style={styles.fieldLabel}>Warehouse</Text>
            {activeWarehouses.length === 0 ? (
              <Text style={styles.helpText}>
                No warehouses in Master yet. Add one under Admin → Master → Warehouses first.
              </Text>
            ) : (
              <View style={styles.whSuggestBox}>
                <TextInput
                  style={styles.input}
                  value={doForm.warehouse_name}
                  onChangeText={(t) => setDoForm((p) => ({ ...p, warehouse_name: t }))}
                  placeholder="Type warehouse name to see suggestions"
                  placeholderTextColor="#94a3b8"
                  autoCapitalize="words"
                />
                {String(doForm.warehouse_name || '').trim().length > 0 ? (
                  <ScrollView
                    style={styles.whSuggestList}
                    nestedScrollEnabled
                    keyboardShouldPersistTaps="handled"
                  >
                    {activeWarehouses
                      .filter((w) => {
                        const q = String(doForm.warehouse_name || '').trim().toLowerCase();
                        const name = String(w.warehouse_name || '').toLowerCase();
                        const code = String(w.warehouse_code || '').toLowerCase();
                        const exact =
                          name === q ||
                          String(doForm.warehouse_name || '').trim().toLowerCase() === name;
                        // Still show match when already exact so user sees selection
                        return name.includes(q) || code.includes(q) || exact;
                      })
                      .map((w) => {
                        const active =
                          String(doForm.warehouse_name || '').trim().toLowerCase() ===
                          String(w.warehouse_name || '').trim().toLowerCase();
                        return (
                          <TouchableOpacity
                            key={String(w.id)}
                            style={[styles.whSuggestRow, active && styles.whSuggestRowActive]}
                            onPress={() =>
                              setDoForm((p) => ({ ...p, warehouse_name: w.warehouse_name }))
                            }
                          >
                            <Text
                              style={[styles.whSuggestName, active && styles.whSuggestNameActive]}
                              numberOfLines={1}
                            >
                              {w.warehouse_name}
                            </Text>
                            {w.warehouse_code ? (
                              <Text style={styles.whSuggestCode}>{w.warehouse_code}</Text>
                            ) : null}
                          </TouchableOpacity>
                        );
                      })}
                  </ScrollView>
                ) : (
                  <Text style={styles.whSuggestHint}>Start typing — matching warehouses appear here</Text>
                )}
              </View>
            )}
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.actionBtn, styles.editBtn, { flex: 1 }]}
                onPress={() => setDoFormOpen(false)}
              >
                <Text style={styles.actionBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, styles.approveBtn, { flex: 1 }]}
                onPress={saveDo}
                disabled={doBusy}
              >
                {doBusy ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.actionBtnText}>Save</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={masterFormOpen}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setMasterFormOpen(false);
          setEditingMasterId(null);
        }}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>
              {masterTab === 'warehouses'
                ? editingMasterId
                  ? 'Edit warehouse'
                  : 'Add warehouse'
                : editingMasterId
                  ? 'Edit client'
                  : 'Add client'}
            </Text>
            {masterTab === 'warehouses' ? (
              <>
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Name</Text>
                  <TextInput
                    style={styles.input}
                    value={whForm.warehouse_name}
                    onChangeText={(t) => {
                      whCodeManualRef.current = false;
                      setWhForm((p) => ({ ...p, warehouse_name: t }));
                    }}
                    placeholder="e.g. Pune"
                    placeholderTextColor="#94a3b8"
                  />
                </View>
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>City</Text>
                  <TextInput
                    style={styles.input}
                    value={whForm.city}
                    onChangeText={(t) => {
                      setWhForm((p) => ({ ...p, city: t }));
                    }}
                    placeholder="City (optional)"
                    placeholderTextColor="#94a3b8"
                  />
                </View>
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Code (auto)</Text>
                  <TextInput
                    style={[styles.input, { backgroundColor: '#f1f5f9', color: '#64748b' }]}
                    value={whForm.warehouse_code}
                    placeholder="WH-PUNE-01"
                    placeholderTextColor="#94a3b8"
                    editable={false}
                  />
                  <Text style={styles.fieldHint}>
                    Auto from name only (WH-PUNE-01…). Typing locked.
                  </Text>
                </View>
              </>
            ) : (
              <>
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Name</Text>
                  <TextInput
                    style={styles.input}
                    value={clForm.client_name}
                    onChangeText={(t) => setClForm((p) => ({ ...p, client_name: t }))}
                    placeholder="Client name"
                    placeholderTextColor="#94a3b8"
                  />
                </View>
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Warehouse</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <TouchableOpacity
                      style={[
                        styles.pickChip,
                        !clForm.warehouse_name && styles.pickChipActive
                      ]}
                      onPress={() =>
                        setClForm((p) => ({
                          ...p,
                          warehouse_name: '',
                          warehouse_code: ''
                        }))
                      }
                    >
                      <Text
                        style={[
                          styles.pickChipText,
                          !clForm.warehouse_name && styles.pickChipTextActive
                        ]}
                      >
                        None
                      </Text>
                    </TouchableOpacity>
                    {activeWarehouses.map((w) => {
                      const active = clForm.warehouse_name === w.warehouse_name;
                      return (
                        <TouchableOpacity
                          key={String(w.id)}
                          style={[styles.pickChip, active && styles.pickChipActive]}
                          onPress={() =>
                            setClForm((p) => ({
                              ...p,
                              warehouse_name: w.warehouse_name,
                              warehouse_code: w.warehouse_code || ''
                            }))
                          }
                        >
                          <Text
                            style={[styles.pickChipText, active && styles.pickChipTextActive]}
                            numberOfLines={1}
                          >
                            {w.warehouse_name}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Code (auto)</Text>
                  <TextInput
                    style={[styles.input, { backgroundColor: '#f1f5f9' }]}
                    value={clForm.client_code}
                    onChangeText={(t) => {
                      clientCodeManualRef.current = true;
                      setClForm((p) => ({ ...p, client_code: t.toUpperCase() }));
                    }}
                    autoCapitalize="characters"
                    placeholder="CL-WH-CLIENT"
                    placeholderTextColor="#94a3b8"
                    editable={!editingMasterId}
                  />
                  <Text style={styles.fieldHint}>
                    Auto from client + warehouse name. Edit only if you need a custom code.
                  </Text>
                </View>
              </>
            )}
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.actionBtn, styles.editBtn, { flex: 1 }]}
                onPress={() => {
                  setMasterFormOpen(false);
                  setEditingMasterId(null);
                }}
              >
                <Text style={styles.actionBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, styles.approveBtn, { flex: 1 }]}
                onPress={masterTab === 'warehouses' ? saveWarehouse : saveClient}
                disabled={masterBusy}
              >
                {masterBusy ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.actionBtnText}>Save</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <SavedChangesPopup
        visible={savedPopup.visible}
        title={savedPopup.title}
        message={savedPopup.message}
        onDone={() => setSavedPopup((p) => ({ ...p, visible: false }))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#f8fafc' },
  hero: { paddingHorizontal: 12, paddingTop: 2, paddingBottom: 4 },
  heroTitle: { fontSize: 15, fontWeight: '800', color: '#0f172a' },
  heroSub: { fontSize: 10, color: '#64748b', fontWeight: '600', marginTop: 1 },
  sectionRow: { flexDirection: 'row', gap: 5, paddingHorizontal: 10, paddingBottom: 6 },
  sectionChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 7,
    borderRadius: 9,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  sectionChipActive: { backgroundColor: '#003580', borderColor: '#003580' },
  sectionChipText: { fontSize: 10, fontWeight: '800', color: '#003580' },
  sectionChipTextActive: { color: '#fff' },
  countDot: {
    minWidth: 15,
    height: 15,
    borderRadius: 8,
    backgroundColor: '#fee2e2',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3
  },
  countDotActive: { backgroundColor: 'rgba(255,255,255,0.25)' },
  countDotText: { fontSize: 9, fontWeight: '800', color: '#dc2626' },
  countDotTextActive: { color: '#fff' },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 10,
    marginBottom: 6,
    backgroundColor: '#fff',
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'ios' ? 7 : 2
  },
  searchInput: { flex: 1, fontSize: 12, color: '#0f172a', paddingVertical: 4 },
  body: { paddingHorizontal: 10, paddingBottom: 24 },
  filterRow: { flexDirection: 'row', gap: 5, marginBottom: 8 },
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 16,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  filterChipActive: { backgroundColor: '#003580', borderColor: '#003580' },
  filterText: { fontSize: 10, fontWeight: '700', color: '#64748b' },
  filterTextActive: { color: '#fff' },
  updatedAt: {
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: '600',
    marginBottom: 8,
    marginTop: -2
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8
  },
  hint: { fontSize: 11, color: '#64748b', fontWeight: '700' },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#003580',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8
  },
  addBtnText: { color: '#fff', fontWeight: '800', fontSize: 11 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 9,
    marginBottom: 7
  },
  cardDeactive: {
    backgroundColor: '#fffafa',
    borderColor: '#fecaca'
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  cardIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center'
  },
  cardTitle: { fontSize: 12, fontWeight: '800', color: '#0f172a' },
  cardTitleDeactive: { color: '#64748b', textDecorationLine: 'line-through' },
  cardMeta: { fontSize: 10, color: '#64748b', fontWeight: '600', marginTop: 1 },
  masterGroupTitle: {
    marginTop: 4,
    marginBottom: 6,
    fontSize: 11,
    fontWeight: '800',
    color: '#059669',
    textTransform: 'uppercase',
    letterSpacing: 0.3
  },
  masterGroupTitleDeactive: {
    marginTop: 14,
    color: '#dc2626'
  },
  masterGroupEmpty: {
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: '600',
    marginBottom: 8
  },
  statusPill: {
    alignSelf: 'flex-start',
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999
  },
  statusActive: { backgroundColor: '#ecfdf5' },
  statusDeactive: { backgroundColor: '#fef2f2' },
  statusPillText: { fontSize: 9, fontWeight: '800' },
  statusActiveText: { color: '#059669' },
  statusDeactiveText: { color: '#dc2626' },
  cardBody: { fontSize: 11, color: '#475569', fontWeight: '600', marginTop: 5, lineHeight: 15 },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  badgeText: { fontSize: 9, fontWeight: '800' },
  metaChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 6 },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#f0f9ff',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    maxWidth: '100%'
  },
  metaChipText: { fontSize: 10, fontWeight: '700', color: '#0369a1', maxWidth: 160 },
  emptyBox: { alignItems: 'center', paddingTop: 28, gap: 6 },
  empty: { textAlign: 'center', color: '#94a3b8', fontWeight: '600', fontSize: 12 },
  clearSearchBtn: {
    marginTop: 8,
    backgroundColor: '#003580',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  clearSearchText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  error: { color: '#dc2626', fontWeight: '700', marginTop: 10, fontSize: 12 },
  actionRow: { flexDirection: 'row', gap: 6, marginTop: 8 },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 7,
    borderRadius: 8
  },
  approveBtn: { backgroundColor: '#059669' },
  denyBtn: { backgroundColor: '#dc2626' },
  editBtn: { backgroundColor: '#0369a1' },
  actionBtnText: { color: '#fff', fontWeight: '800', fontSize: 11 },
  masterTabs: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 8 },
  masterTab: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  masterTabActive: { backgroundColor: '#003580', borderColor: '#003580' },
  masterTabText: { fontSize: 11, fontWeight: '700', color: '#64748b' },
  masterTabTextActive: { color: '#fff' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'flex-end'
  },
  modalSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    padding: 12,
    paddingBottom: Platform.OS === 'ios' ? 22 : 12
  },
  modalHandle: {
    alignSelf: 'center',
    width: 32,
    height: 3,
    borderRadius: 2,
    backgroundColor: '#cbd5e1',
    marginBottom: 8
  },
  modalTitle: { fontSize: 14, fontWeight: '800', color: '#0f172a', marginBottom: 8 },
  field: { marginBottom: 7 },
  fieldLabel: { fontSize: 10, fontWeight: '800', color: '#64748b', marginBottom: 3 },
  fieldHint: { fontSize: 9, color: '#94a3b8', fontWeight: '600', marginTop: 2 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 12,
    color: '#0f172a',
    backgroundColor: '#f8fafc',
    marginBottom: 6
  },
  pickChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginRight: 5
  },
  pickChipActive: { backgroundColor: '#003580', borderColor: '#003580' },
  pickChipText: { fontSize: 11, fontWeight: '700', color: '#475569' },
  pickChipTextActive: { color: '#fff' },
  helpText: { fontSize: 11, color: '#b45309', fontWeight: '600', marginBottom: 8, lineHeight: 16 },
  whSuggestBox: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#fff',
    marginBottom: 10,
    overflow: 'hidden'
  },
  whSuggestList: { maxHeight: 160 },
  whSuggestHint: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '600',
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  whSuggestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e2e8f0'
  },
  whSuggestRowActive: { backgroundColor: '#eff6ff' },
  whSuggestName: { flex: 1, fontSize: 13, fontWeight: '700', color: '#0f172a', marginRight: 8 },
  whSuggestNameActive: { color: '#003580' },
  whSuggestCode: { fontSize: 10, fontWeight: '600', color: '#64748b' }
});
