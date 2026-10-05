/**
 * Shared log list UI (src/components/LogListCards.js).
 * WHAT: Pagination helpers and card rows for chamber temp and dock logs.
 * WHY: Customer, DO, and Sub-Admin screens share the same list look and behavior.
 * HOW: paginateList + ChamberTempLogCard + DockMovementLogCard + ListPageFooter.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import FastTouchable from './FastTouchable';
import {
  chamberZoneStyle,
  normalizeChamberZone,
  pickComplianceZone,
  getChamberTempDeviation,
} from '../utils/dedupeInventoryLots';
import { LIST_PAGE_SIZE } from '../utils/customerLogReportHelpers';

const TouchableOpacity = FastTouchable;
const ALERT_RED = '#dc2626';

export { LIST_PAGE_SIZE };

/**
 * WHAT: Previous/Next footer with “1–15 of N” text.
 * WHY: Long log histories need paging without loading everything at once.
 * HOW: Hides when total <= pageSize; disables buttons at first/last page.
 */
export function ListPageFooter({
  page = 1,
  pageSize = LIST_PAGE_SIZE,
  total = 0,
  onPrev,
  onNext,
  style
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  if (total <= pageSize) return null;
  const start = (safePage - 1) * pageSize + 1;
  const end = Math.min(safePage * pageSize, total);
  return (
    <View style={[styles.pageRow, style]}>
      <TouchableOpacity
        style={[styles.pageBtn, safePage <= 1 && styles.pageBtnDisabled]}
        disabled={safePage <= 1}
        onPress={onPrev}
        activeOpacity={0.85}
      >
        <Text style={styles.pageBtnText}>Previous</Text>
      </TouchableOpacity>
      <Text style={styles.pageMeta}>
        {start}–{end} of {total}
      </Text>
      <TouchableOpacity
        style={[styles.pageBtn, safePage >= totalPages && styles.pageBtnDisabled]}
        disabled={safePage >= totalPages}
        onPress={onNext}
        activeOpacity={0.85}
      >
        <Text style={styles.pageBtnText}>Next</Text>
      </TouchableOpacity>
    </View>
  );
}

/** WHAT: Slices an array for one page. WHY: Shared math for footers and charts. HOW: Returns { items, page, totalPages, total }. */
export function paginateList(list, page = 1, pageSize = LIST_PAGE_SIZE) {
  const arr = Array.isArray(list) ? list : [];
  const totalPages = Math.max(1, Math.ceil(arr.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    page: safePage,
    totalPages,
    total: arr.length,
    pageSize,
    items: arr.slice(start, start + pageSize)
  };
}

function formatTemp(tempNum) {
  if (tempNum == null || !Number.isFinite(tempNum)) return '—';
  return `${tempNum % 1 === 0 ? tempNum : tempNum.toFixed(1)}°C`;
}

function resolveTempNum(item) {
  if (item?.box_temp != null && item.box_temp !== '') {
    const n = Number(item.box_temp);
    if (Number.isFinite(n)) return n;
  }
  if (item?.chamber_temp != null && item.chamber_temp !== '') {
    const n = Number(item.chamber_temp);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function resolveChamberType(item) {
  return (
    pickComplianceZone(item?.chamber_type, item?.inward_material_type, item?.outward_material_type) ||
    normalizeChamberZone(item?.chamber_type) ||
    (item?.chamber_type ? chamberZoneStyle(item.chamber_type).type : null) ||
    null
  );
}

function resolveBoxCount(item) {
  const raw =
    item?.box_count ??
    item?.physical_audit_count ??
    item?.inward_received_boxes_qty ??
    item?.inward_received_qty ??
    item?.outward_loaded_boxes_qty ??
    item?.outward_received_boxes_qty ??
    item?.outward_received_qty ??
    null;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function TypeHint({ chamberType, deviation, outOfRange }) {
  if (!chamberType) return null;
  return (
    <View style={styles.typeRow}>
      {deviation === 'low' ? (
        <Text style={[styles.typeArrow, { color: ALERT_RED }]}>{'<'}</Text>
      ) : null}
      {deviation === 'high' ? (
        <Text style={[styles.typeArrow, { color: ALERT_RED }]}>{'>'}</Text>
      ) : null}
      <Text
        style={[styles.typeHint, outOfRange && styles.typeHintAlert]}
        numberOfLines={1}
      >
        {chamberType}
      </Text>
    </View>
  );
}

/**
 * Shared chamber / daily-temp log row — same theme for Customer, DO, Admin.
 * Shows: client, chamber · shift · boxes, °C (OOR red), type arrows, date.
 */
export function ChamberTempLogCard({ item, onPress, style }) {
  const tempNum = resolveTempNum(item);
  const temp = formatTemp(tempNum);
  const chamberType = resolveChamberType(item);
  const deviation =
    tempNum != null ? getChamberTempDeviation(tempNum, chamberType) : null;
  const outOfRange = deviation != null;
  const boxCount = resolveBoxCount(item);
  const dateLabel =
    String(item?.formatted_date || item?.entry_date || '').slice(0, 10) || '—';
  return (
    <TouchableOpacity
      style={[styles.card, style]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <View style={styles.row}>
        <View style={styles.left}>
          <Text style={styles.title} numberOfLines={1}>
            {item?.client_name || 'Client'}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {item?.chamber_name || 'Chamber'}
            {item?.shift ? ` · ${item.shift}` : ''}
            {boxCount != null ? ` · ${boxCount} boxes` : ''}
            {item?.warehouse_name ? ` · ${item.warehouse_name}` : ''}
          </Text>
        </View>
        <View style={styles.right}>
          <Text style={[styles.temp, outOfRange && styles.tempAlert]}>{temp}</Text>
          <TypeHint
            chamberType={chamberType}
            deviation={deviation}
            outOfRange={outOfRange}
          />
          <Text style={styles.date}>{dateLabel}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

/**
 * Shared inward/outward dock log row — OOR red °C + box count always visible.
 */
export function DockMovementLogCard({ item, mode = 'inward', onPress, style }) {
  const isIn = mode === 'inward' || item?._logType === 'inward';
  const typeLabel = isIn ? 'Inward' : 'Outward';
  const client =
    (isIn
      ? item?.inward_client_name || item?.client_name
      : item?.outward_client_name || item?.client_name) || 'Client';

  const tempRaw = isIn
    ? item?.inward_material_temp ?? item?.inward_vehicle_temp ?? item?.box_temp
    : item?.outward_material_temp ??
      item?.outward_pre_vehicle_temp ??
      item?.outward_vehicle_temp ??
      item?.box_temp;
  const tempNum =
    tempRaw == null || tempRaw === '' ? null : Number(tempRaw);
  const hasTemp = tempNum != null && Number.isFinite(tempNum);

  const materialType = isIn
    ? item?.inward_material_type || item?.chamber_type
    : item?.outward_material_type || item?.chamber_type;
  const chamberType =
    pickComplianceZone(materialType) || normalizeChamberZone(materialType) || null;
  const deviation =
    hasTemp && chamberType ? getChamberTempDeviation(tempNum, chamberType) : null;
  const outOfRange = deviation != null;

  const boxCount = resolveBoxCount(item);
  const vehicleOrDock = isIn
    ? item?.inward_vehicle_no
      ? `Vehicle ${item.inward_vehicle_no}`
      : item?.inward_dock_no
        ? `Dock ${item.inward_dock_no}`
        : null
    : item?.outward_vehicle_no
      ? `Vehicle ${item.outward_vehicle_no}`
      : item?.outward_dock_no
        ? `Dock ${item.outward_dock_no}`
        : item?.chamber_name || null;

  const dateLabel = String(
    (isIn ? item?.inward_entry_date : item?.outward_entry_date) ||
      item?.entry_date ||
      item?.formatted_date ||
      ''
  ).slice(0, 10) || '—';

  const podVal = String(
    isIn ? item?.inward_pod_photo : item?.outward_pod_photo || ''
  ).trim();
  const podMissing =
    isIn && (!podVal || podVal === 'null' || podVal === 'undefined');

  return (
    <TouchableOpacity
      style={[styles.dockCard, style]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <View style={styles.left}>
        <View style={styles.titleRow}>
          <Text style={[styles.typeTag, !isIn && styles.typeTagOut]}>{typeLabel}</Text>
          <Text style={styles.dockClient} numberOfLines={1}>
            {client}
          </Text>
          {podMissing ? (
            <View style={styles.podBadge}>
              <Text style={styles.podBadgeText}>POD</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.meta} numberOfLines={2}>
          {vehicleOrDock || '—'}
          {item?.warehouse_name ? ` · ${item.warehouse_name}` : ''}
          {` · ${dateLabel}`}
          {boxCount != null ? ` · ${boxCount} boxes` : ''}
        </Text>
      </View>
      <View style={styles.right}>
        <Text style={[styles.temp, hasTemp && outOfRange && styles.tempAlert]}>
          {hasTemp ? formatTemp(tempNum) : '—'}
        </Text>
        <TypeHint
          chamberType={chamberType}
          deviation={deviation}
          outOfRange={outOfRange}
        />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
  },
  dockCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  left: {
    flex: 1,
    minWidth: 0,
  },
  right: {
    alignItems: 'flex-end',
    flexShrink: 0,
  },
  title: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0f172a',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  typeTag: {
    fontSize: 9,
    fontWeight: '800',
    color: '#1d4ed8',
    backgroundColor: '#dbeafe',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  typeTagOut: {
    color: '#c2410c',
    backgroundColor: '#ffedd5',
  },
  dockClient: {
    flex: 1,
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
  },
  meta: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b',
    marginTop: 2,
  },
  temp: {
    fontSize: 16,
    fontWeight: '900',
    color: '#0f172a',
  },
  tempAlert: {
    color: ALERT_RED,
  },
  date: {
    marginTop: 2,
    fontSize: 10,
    fontWeight: '600',
    color: '#94a3b8',
  },
  typeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginTop: 2,
    maxWidth: 110,
  },
  typeArrow: {
    fontSize: 11,
    fontWeight: '900',
  },
  typeHint: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b',
  },
  typeHintAlert: {
    color: ALERT_RED,
    fontWeight: '800',
  },
  podBadge: {
    backgroundColor: '#fee2e2',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  podBadgeText: {
    fontSize: 8,
    fontWeight: '900',
    color: '#dc2626',
  },
  pageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  pageBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bfdbfe',
    backgroundColor: '#eff6ff',
  },
  pageBtnDisabled: {
    opacity: 0.4,
  },
  pageBtnText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#003580',
  },
  pageMeta: {
    flex: 1,
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
  },
});
