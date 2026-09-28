// ====================================================================
// Customer — mobile/src/screens/CustomerScreen.js
// --------------------------------------------------------------------
// Role `customer`: read-only scoped portal.
// Super Admin sets allowed_warehouses + allowed_clients — this screen
// never edits catalog masters or DO assignments.
// Lists: chamber / inward / outward / inventory (first 50, then +20).
// Errors: formatUserError + InlineErrorState + Retry.
// ====================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  ImageBackground,
  StyleSheet,
  ScrollView,
  StatusBar,
  SafeAreaView,
  ActivityIndicator,
  RefreshControl,
  FlatList,
  Modal,
  Linking,
  TextInput,
  Alert,
  Platform,
  BackHandler,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import FastTouchable from '../components/FastTouchable';
import {
  dedupeInventoryLots,
  chamberZoneStyle,
  normalizeChamberZone,
  pickComplianceZone,
  getChamberTempRange,
  getChamberTempDeviation,
  isChamberTempOutOfRange,
} from '../utils/dedupeInventoryLots';
import { buildReportReadingRows, latestReadingQty } from '../utils/buildReportReadingRows';
import {
  DOCK_REPORT_PAGE_SIZE,
  resolveLogImageUrl,
  buildInwardOutwardPhotoItems,
} from '../utils/customerLogReportHelpers';
import { formatUserError } from '../utils/userFacingError';
import { ImagePreviewModal, GpsDetailRow, PhotoGridWithLocation } from '../components/LogDetailPhotoLocation';
import ListLoadingOverlay from '../components/ListLoadingOverlay';
import { ChamberTempLogCard, DockMovementLogCard, ListPageFooter, paginateList, LIST_PAGE_SIZE } from '../components/LogListCards';
import InlineErrorState from '../components/InlineErrorState';
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

const TouchableOpacity = FastTouchable;

const PRODUCTION_API_URL = 'https://reeferon-crm-backend.onrender.com';
const BOTTOM_SHEET_MAX_H = Math.round(Dimensions.get('window').height * 0.5);
const BOTTOM_SHEET_SCROLL_H = Math.max(180, BOTTOM_SHEET_MAX_H - 130);
const INOUT_DONUT_IN = '#5B9AF5';
const INOUT_DONUT_OUT = '#F4A261';
const INOUT_ACCENT_IN = '#1A73E8';
const INOUT_ACCENT_OUT = '#EA580C';
const TEMP_TASK_COMPLETED = '#0D9488';
const TEMP_TASK_BAD = '#EA580C';
const TEMP_TASK_PENDING = '#EAB308';
const SCREEN_W = Dimensions.get('window').width;

/** Resolve Frozen / Chilled / Dry / Other for an inward or outward row. */
function resolveInOutItemZone(item, mode = 'inward') {
  const rawType =
    mode === 'inward'
      ? item?.inward_material_type || item?.chamber_type || item?.material_type
      : item?.outward_material_type || item?.chamber_type || item?.material_type;
  const zone =
    pickComplianceZone(rawType) || normalizeChamberZone(rawType) || 'Other';
  return ['Frozen', 'Chilled', 'Dry', 'Other'].includes(zone) ? zone : 'Other';
}

/** Client/product boxes within one zone (Amul, Hyfun, …) — no temp. */
function buildInOutClientBoxSeries(inwardRows, outwardRows, zone = 'Frozen') {
  const want = zone || 'Frozen';
  const map = new Map();

  const addRows = (rows, mode) => {
    (Array.isArray(rows) ? rows : []).forEach((item) => {
      if (resolveInOutItemZone(item, mode) !== want) return;
      const client =
        String(
          mode === 'inward'
            ? item.inward_client_name || item.client_name || ''
            : item.outward_client_name || item.client_name || ''
        ).trim() || 'Unknown';
      const boxes = Number(
        mode === 'inward'
          ? item.inward_received_boxes_qty ?? item.inward_received_qty ?? 0
          : item.outward_loaded_boxes_qty ??
              item.outward_received_boxes_qty ??
              item.outward_received_qty ??
              0
      );
      if (!map.has(client)) {
        map.set(client, { key: client, client, inwardBoxes: 0, outwardBoxes: 0 });
      }
      const row = map.get(client);
      const n = Number.isFinite(boxes) ? boxes : 0;
      if (mode === 'inward') row.inwardBoxes += n;
      else row.outwardBoxes += n;
    });
  };

  addRows(inwardRows, 'inward');
  addRows(outwardRows, 'outward');
  return Array.from(map.values()).sort(
    (a, b) =>
      b.inwardBoxes + b.outwardBoxes - (a.inwardBoxes + a.outwardBoxes) ||
      a.client.localeCompare(b.client)
  );
}

/** Type chips → product/client names + boxes (Inward top, Outward bottom). */
function InOutZoneBoxChart({ inwardRows, outwardRows }) {
  const zones = ['Frozen', 'Chilled', 'Dry', 'Other'];
  const [selectedZone, setSelectedZone] = useState('Frozen');
  const [inPage, setInPage] = useState(1);
  const [outPage, setOutPage] = useState(1);
  const [netPage, setNetPage] = useState(1);
  const zoneStyle = chamberZoneStyle(selectedZone);
  const series = buildInOutClientBoxSeries(inwardRows, outwardRows, selectedZone);
  const maxBoxes = Math.max(
    1,
    ...series.flatMap((r) => [Number(r.inwardBoxes) || 0, Number(r.outwardBoxes) || 0])
  );

  const renderClientBars = (mode) => {
    const isIn = mode === 'inward';
    const title = isIn ? 'Inward' : 'Outward';
    const modeRows = series.filter(
      (r) => (Number(isIn ? r.inwardBoxes : r.outwardBoxes) || 0) > 0
    );
    const page = isIn ? inPage : outPage;
    const setPage = isIn ? setInPage : setOutPage;
    const paged = paginateList(modeRows, page, LIST_PAGE_SIZE);
    return (
      <View style={{ marginBottom: isIn ? 14 : 0 }}>
        <Text
          style={{
            fontSize: 13,
            fontWeight: '800',
            color: '#0f172a',
            marginBottom: 8
          }}
        >
          {title}
        </Text>
        {!modeRows.length ? (
          <Text style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>
            No {title.toLowerCase()} products in {selectedZone}.
          </Text>
        ) : (
          <>
          {paged.items.map((row) => {
            const boxes = Number(isIn ? row.inwardBoxes : row.outwardBoxes) || 0;
            const pct = Math.max(4, Math.round((boxes / maxBoxes) * 100));
            return (
              <View key={`${mode}-${row.key}`} style={{ marginBottom: 10 }}>
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 4,
                    gap: 8
                  }}
                >
                  <Text
                    style={{ flex: 1, fontSize: 12, fontWeight: '800', color: '#0f172a' }}
                    numberOfLines={1}
                  >
                    {row.client}
                  </Text>
                  <Text style={{ fontSize: 11, fontWeight: '800', color: '#334155' }}>
                    {boxes} boxes
                  </Text>
                </View>
                <View
                  style={{
                    height: 3,
                    borderRadius: 999,
                    backgroundColor: zoneStyle.bg,
                    overflow: 'hidden'
                  }}
                >
                  <View
                    style={{
                      width: `${pct}%`,
                      height: '100%',
                      borderRadius: 999,
                      backgroundColor: zoneStyle.color
                    }}
                  />
                </View>
              </View>
            );
          })}
          <ListPageFooter
            page={paged.page}
            pageSize={LIST_PAGE_SIZE}
            total={paged.total}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(paged.totalPages, p + 1))}
          />
          </>
        )}
      </View>
    );
  };

  return (
    <View style={{ marginTop: 4 }}>
      <Text style={{ fontSize: 11, fontWeight: '600', color: '#64748b', marginBottom: 10 }}>
        Select type · product name · boxes
      </Text>
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 14 }}>
        {zones.map((z) => {
          const active = selectedZone === z;
          const zs = chamberZoneStyle(z);
          return (
            <TouchableOpacity
              key={z}
              onPress={() => {
                setSelectedZone(z);
                setInPage(1);
                setOutPage(1);
                setNetPage(1);
              }}
              activeOpacity={0.85}
              style={{
                flex: 1,
                paddingVertical: 8,
                paddingHorizontal: 2,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: active ? zs.color : '#e2e8f0',
                backgroundColor: active ? zs.bg : '#ffffff',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <Text
                style={{
                  fontSize: 10,
                  fontWeight: '800',
                  color: active ? zs.color : '#64748b',
                  textAlign: 'center'
                }}
                numberOfLines={1}
              >
                {z}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {renderClientBars('inward')}
      {renderClientBars('outward')}

      <View
        style={{
          marginTop: 14,
          paddingTop: 12,
          borderTopWidth: 1,
          borderTopColor: '#e2e8f0'
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: '900', color: '#000000', marginBottom: 4 }}>
          Total (Inward − Outward)
        </Text>
        <Text style={{ fontSize: 10, fontWeight: '600', color: '#64748b', marginBottom: 10 }}>
          Same client name matched · {selectedZone}
        </Text>
        {!series.length ? (
          <Text style={{ fontSize: 11, color: '#94a3b8' }}>No clients to match.</Text>
        ) : (
          <>
            {(() => {
              const pagedNet = paginateList(series, netPage, LIST_PAGE_SIZE);
              const netMax = Math.max(
                1,
                ...series.map((r) =>
                  Math.abs((Number(r.inwardBoxes) || 0) - (Number(r.outwardBoxes) || 0))
                )
              );
              return (
                <>
            {pagedNet.items.map((row) => {
              const inB = Number(row.inwardBoxes) || 0;
              const outB = Number(row.outwardBoxes) || 0;
              const net = inB - outB;
              const absNet = Math.abs(net);
              const pct = Math.max(absNet > 0 ? 4 : 0, Math.round((absNet / netMax) * 100));
              const netColor = net > 0 ? '#16a34a' : net < 0 ? '#dc2626' : '#64748b';
              return (
                <View key={`net-${row.key}`} style={{ marginBottom: 10 }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 2,
                      gap: 6
                    }}
                  >
                    <Text
                      style={{ flex: 1, fontSize: 12, fontWeight: '800', color: '#0f172a' }}
                      numberOfLines={1}
                    >
                      {row.client}
                    </Text>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#64748b' }}>
                      {inB} − {outB}
                    </Text>
                    <Text style={{ fontSize: 11, fontWeight: '900', color: netColor, minWidth: 52, textAlign: 'right' }}>
                      {net > 0 ? `+${net}` : String(net)}
                    </Text>
                  </View>
                  <View
                    style={{
                      height: 3,
                      borderRadius: 999,
                      backgroundColor: '#e2e8f0',
                      overflow: 'hidden'
                    }}
                  >
                    <View
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        borderRadius: 999,
                        backgroundColor: netColor
                      }}
                    />
                  </View>
                </View>
              );
            })}
            <ListPageFooter
              page={pagedNet.page}
              pageSize={LIST_PAGE_SIZE}
              total={pagedNet.total}
              onPrev={() => setNetPage((p) => Math.max(1, p - 1))}
              onNext={() => setNetPage((p) => Math.min(pagedNet.totalPages, p + 1))}
            />
                </>
              );
            })()}
            {(() => {
              const totalIn = series.reduce((s, r) => s + (Number(r.inwardBoxes) || 0), 0);
              const totalOut = series.reduce((s, r) => s + (Number(r.outwardBoxes) || 0), 0);
              const totalNet = totalIn - totalOut;
              return (
                <View
                  style={{
                    marginTop: 6,
                    paddingTop: 10,
                    borderTopWidth: 1,
                    borderTopColor: '#e2e8f0',
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: '900', color: '#000000' }}>
                    All clients
                  </Text>
                  <Text style={{ fontSize: 11, fontWeight: '900', color: '#000000' }}>
                    {totalIn} − {totalOut}
                  </Text>
                  <Text style={{ fontSize: 13, fontWeight: '900', color: '#000000' }}>
                    {totalNet > 0 ? `+${totalNet}` : String(totalNet)} boxes
                  </Text>
                </View>
              );
            })()}
          </>
        )}
      </View>
    </View>
  );
}

/** Inward / Outward donut — left circle + right legend (Views only, no SVG). */
function InOutDonutChart({ series }) {
  const size = 118;
  const ring = 22;
  const segments = 72;
  const radius = (size - ring) / 2;

  const totals = (series || []).reduce(
    (acc, s) => {
      acc.inward += Number(s.inward) || 0;
      acc.outward += Number(s.outward) || 0;
      return acc;
    },
    { inward: 0, outward: 0 }
  );
  const inward = totals.inward;
  const outward = totals.outward;
  const total = inward + outward;
  const inSegs = total > 0 ? Math.round((inward / total) * segments) : 0;

  if (!series?.length && total === 0) {
    return (
      <Text style={{ fontSize: 12, color: '#94a3b8' }}>No In / Out activity in this range.</Text>
    );
  }

  const legend = [
    { key: 'in', label: 'Inward', color: INOUT_DONUT_IN, accent: INOUT_ACCENT_IN, count: inward },
    { key: 'out', label: 'Outward', color: INOUT_DONUT_OUT, accent: INOUT_ACCENT_OUT, count: outward }
  ];

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 6,
        paddingBottom: 4,
        gap: 14
      }}
    >
      <View style={{ width: size, height: size, flexShrink: 0 }}>
        {total > 0 &&
          Array.from({ length: segments }).map((_, i) => {
            const angle = (i / segments) * 360 - 90;
            const rad = (angle * Math.PI) / 180;
            const cx = size / 2 + Math.cos(rad) * radius;
            const cy = size / 2 + Math.sin(rad) * radius;
            const color = i < inSegs ? INOUT_DONUT_IN : INOUT_DONUT_OUT;
            return (
              <View
                key={`seg-${i}`}
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: cx - 3,
                  top: cy - ring / 2,
                  width: 6.5,
                  height: ring,
                  backgroundColor: color,
                  transform: [{ rotate: `${angle + 90}deg` }]
                }}
              />
            );
          })}
        {total === 0 && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: ring / 2,
              top: ring / 2,
              width: size - ring,
              height: size - ring,
              borderRadius: (size - ring) / 2,
              borderWidth: ring,
              borderColor: '#e2e8f0'
            }}
          />
        )}
        {/* Hollow center */}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: ring + 2,
            top: ring + 2,
            right: ring + 2,
            bottom: ring + 2,
            borderRadius: 999,
            backgroundColor: '#ffffff'
          }}
        />
      </View>

      <View style={{ flex: 1, justifyContent: 'center', gap: 14, minWidth: 0 }}>
        {legend.map((row) => (
          <View
            key={row.key}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
              <View
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  backgroundColor: row.color,
                  borderWidth: 1.5,
                  borderColor: row.accent,
                  flexShrink: 0
                }}
              />
              <Text
                style={{ fontSize: 13, fontWeight: '600', color: '#334155' }}
                numberOfLines={1}
              >
                {row.label}
              </Text>
            </View>
            <Text
              style={{
                fontSize: 13,
                fontWeight: '700',
                color: row.accent,
                flexShrink: 0
              }}
            >
              {row.count}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Resolve Morning | Evening from log.shift or inspection_time. */
function resolveTempTaskShift(log) {
  if (!log) return 'Morning';
  const s = String(log.shift || '').trim().toLowerCase();
  if (s === 'evening' || s.startsWith('evening')) return 'Evening';
  if (s === 'morning' || s.startsWith('morning')) return 'Morning';
  const tu = String(log.inspection_time || log.time || '').trim().toUpperCase();
  if (tu.startsWith('10:00') || tu === '10:00 AM') return 'Morning';
  if (tu.includes('PM') || tu.startsWith('18:') || tu.startsWith('6:')) return 'Evening';
  try {
    const raw = log.created_at || log.entry_date || '';
    const dt = new Date(raw);
    if (!Number.isNaN(dt.getTime())) {
      return dt.getHours() < 14 ? 'Morning' : 'Evening';
    }
  } catch (_) {
    /* ignore */
  }
  return 'Morning';
}

/** Build daily temp task rows: completed / bad / pending (client × day × shift). */
function buildDailyTempTaskRows({ logs, clientNames, rangeStart, rangeEnd, normName }) {
  const toYmd = (dt) => {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };
  const days = [];
  try {
    const cursor = new Date(`${rangeStart}T12:00:00`);
    const end = new Date(`${rangeEnd}T12:00:00`);
    if (!Number.isNaN(cursor.getTime()) && !Number.isNaN(end.getTime())) {
      while (cursor <= end) {
        days.push(toYmd(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
    }
  } catch (_) {
    /* ignore */
  }
  if (!days.length && rangeStart) days.push(rangeStart);

  const parseTemp = (log) => {
    const raw = log?.chamber_temp ?? log?.box_temp ?? log?.temperature ?? null;
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const dayKeyOf = (log) => {
    const raw =
      log?.entry_date ||
      log?.formatted_date ||
      log?.log_date ||
      log?.created_at ||
      '';
    const s = String(raw).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  };

  const readingByKey = new Map();
  const clientTypeMap = new Map();
  (Array.isArray(logs) ? logs : []).forEach((log) => {
    const day = dayKeyOf(log);
    const client = String(log?.client_name || '').trim();
    if (!day || !client) return;
    if (day < rangeStart || day > rangeEnd) return;
    const t = parseTemp(log);
    if (t == null) return;
    const shift = resolveTempTaskShift(log);
    const key = `${normName(client)}::${day}::${shift}`;
    const prev = readingByKey.get(key);
    const prevTs = prev ? String(prev.created_at || prev.entry_date || '') : '';
    const nextTs = String(log.created_at || log.entry_date || '');
    if (!prev || nextTs >= prevTs) readingByKey.set(key, log);
    const ctype = log.chamber_type || log.material_type || null;
    if (ctype) clientTypeMap.set(normName(client), ctype);
  });

  const clients =
    Array.isArray(clientNames) && clientNames.length
      ? clientNames.map((c) => String(c).trim()).filter(Boolean)
      : Array.from(
          new Set(
            (Array.isArray(logs) ? logs : [])
              .map((l) => String(l?.client_name || '').trim())
              .filter(Boolean)
          )
        );

  const shifts = ['Morning', 'Evening'];
  const rows = [];
  clients.forEach((client) => {
    days.forEach((day) => {
      shifts.forEach((shift) => {
        const key = `${normName(client)}::${day}::${shift}`;
        const log = readingByKey.get(key);
        if (!log) {
          rows.push({
            key,
            client,
            dayKey: day,
            status: 'pending',
            temp: null,
            chamberType: clientTypeMap.get(normName(client)) || null,
            deviation: null,
            shift,
            warehouse: null,
            boxCount: null
          });
          return;
        }
        const temp = parseTemp(log);
        const chamberType = log.chamber_type || log.material_type || null;
        const deviation =
          temp != null ? getChamberTempDeviation(temp, chamberType) : null;
        const boxRaw =
          log.box_count ?? log.physical_audit_count ?? log.count ?? null;
        const boxNum =
          boxRaw == null || boxRaw === '' ? null : Number(boxRaw);
        rows.push({
          key,
          client,
          dayKey: day,
          status: deviation ? 'bad' : 'completed',
          temp,
          chamberType,
          deviation: deviation || null,
          shift,
          warehouse: log.warehouse_name || null,
          boxCount: boxNum != null && Number.isFinite(boxNum) ? boxNum : null
        });
      });
    });
  });
  return rows;
}

/** 3-segment donut: Completed / Bad reading / Pending. */
function TempTaskStatusDonut({ completed = 0, bad = 0, pending = 0 }) {
  const size = 118;
  const ring = 22;
  const segments = 72;
  const radius = (size - ring) / 2;
  const c = Number(completed) || 0;
  const b = Number(bad) || 0;
  const p = Number(pending) || 0;
  const total = c + b + p;
  const cSegs = total > 0 ? Math.round((c / total) * segments) : 0;
  const bSegs = total > 0 ? Math.round((b / total) * segments) : 0;

  const legend = [
    { key: 'completed', label: 'Completed', color: TEMP_TASK_COMPLETED, count: c },
    { key: 'bad', label: 'Bad reading', color: TEMP_TASK_BAD, count: b },
    { key: 'pending', label: 'Pending', color: TEMP_TASK_PENDING, count: p }
  ];

  if (total === 0) {
    return (
      <Text style={{ fontSize: 12, color: '#94a3b8' }}>
        No daily temp tasks in this date range.
      </Text>
    );
  }

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 6,
        paddingBottom: 4,
        gap: 14
      }}
    >
      <View style={{ width: size, height: size, flexShrink: 0 }}>
        {Array.from({ length: segments }).map((_, i) => {
          const angle = (i / segments) * 360 - 90;
          const rad = (angle * Math.PI) / 180;
          const cx = size / 2 + Math.cos(rad) * radius;
          const cy = size / 2 + Math.sin(rad) * radius;
          let color = TEMP_TASK_PENDING;
          if (i < cSegs) color = TEMP_TASK_COMPLETED;
          else if (i < cSegs + bSegs) color = TEMP_TASK_BAD;
          return (
            <View
              key={`tseg-${i}`}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: cx - 3,
                top: cy - ring / 2,
                width: 6.5,
                height: ring,
                backgroundColor: color,
                transform: [{ rotate: `${angle + 90}deg` }]
              }}
            />
          );
        })}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: ring + 2,
            top: ring + 2,
            right: ring + 2,
            bottom: ring + 2,
            borderRadius: 999,
            backgroundColor: '#ffffff',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <Text style={{ fontSize: 20, fontWeight: '900', color: '#0f172a' }}>{total}</Text>
          <Text style={{ fontSize: 10, fontWeight: '700', color: '#64748b' }}>Tasks</Text>
        </View>
      </View>
      <View style={{ flex: 1, justifyContent: 'center', gap: 12, minWidth: 0 }}>
        {legend.map((row) => (
          <View
            key={row.key}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
              <View
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  backgroundColor: row.color,
                  flexShrink: 0
                }}
              />
              <Text
                style={{ fontSize: 12, fontWeight: '600', color: '#334155' }}
                numberOfLines={1}
              >
                {row.label}
              </Text>
            </View>
            <Text style={{ fontSize: 13, fontWeight: '800', color: row.color }}>{row.count}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** OOR delta for detail hero: type + how much below/above band. */
function getTempComplianceHeroMeta(temp, chamberType) {
  const type =
    pickComplianceZone(chamberType) ||
    normalizeChamberZone(chamberType) ||
    String(chamberType || '').trim() ||
    null;
  const t = temp == null || temp === '' ? null : Number(temp);
  const hasTemp = t != null && Number.isFinite(t);
  const tempText = hasTemp ? `${t % 1 === 0 ? t : t.toFixed(1)}°C` : '—';
  if (!hasTemp || !type) {
    return {
      tempText,
      type,
      outOfRange: false,
      deviation: null,
      typeLine: type || null,
      deltaLine: null,
      statusLine: null
    };
  }
  const deviation = getChamberTempDeviation(t, type);
  const range = getChamberTempRange(type);
  if (!deviation || !range) {
    return {
      tempText,
      type,
      outOfRange: false,
      deviation: null,
      typeLine: type,
      deltaLine: null,
      statusLine: null
    };
  }
  let delta = 0;
  if (deviation === 'high' && range.max != null) delta = t - range.max;
  else if (deviation === 'low' && range.min != null) delta = range.min - t;
  const deltaAbs = Math.round(Math.abs(delta) * 10) / 10;
  const deltaStr = deltaAbs % 1 === 0 ? String(deltaAbs) : deltaAbs.toFixed(1);
  return {
    tempText,
    type,
    outOfRange: true,
    deviation,
    typeLine: deviation === 'low' ? `< ${type}` : `> ${type}`,
    deltaLine:
      deviation === 'low'
        ? `${deltaStr}°C below allowed (${range.label})`
        : `${deltaStr}°C above allowed (${range.label})`,
    /** Single red line: "> Frozen, 3°C above allowed (≤ -18°C)" */
    statusLine:
      deviation === 'low'
        ? `< ${type}, ${deltaStr}°C below allowed (${range.label})`
        : `> ${type}, ${deltaStr}°C above allowed (${range.label})`,
    range
  };
}

/**
 * Build absolute / data URI for chamber sensor photos.
 */
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

function resolveImageUrl(raw, baseUrl, folderHint = 'daily_temp_monitor_images') {
  return resolveLogImageUrl(raw, baseUrl, folderHint);
}

function buildImageCandidates(raw, apiUrl, folderHint = 'daily_temp_monitor_images') {
  const urls = [];
  const push = (u) => {
    if (u && !urls.includes(u)) urls.push(u);
  };

  push(resolveImageUrl(raw, apiUrl, folderHint));

  // If logged into local server but photo lives on Render (or vice versa)
  const prod = String(PRODUCTION_API_URL || '').replace(/\/$/, '');
  const current = String(apiUrl || '').replace(/\/$/, '');
  if (prod && prod !== current) {
    push(resolveImageUrl(raw, prod, folderHint));
  }

  return urls;
}

function SensorPhotoView({ rawPath, apiUrl, folderHint = 'daily_temp_monitor_images' }) {
  const candidates = useMemo(
    () => buildImageCandidates(rawPath, apiUrl, folderHint),
    [rawPath, apiUrl, folderHint]
  );
  const [idx, setIdx] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    setIdx(0);
    setFailed(false);
    setLoading(true);
    setPreviewOpen(false);
  }, [rawPath, apiUrl]);

  if (!candidates.length) {
    return (
      <View style={styles.detailImageEmpty}>
        <Ionicons name="image-outline" size={28} color="#94a3b8" />
        <Text style={styles.stateText}>No photo attached to this log.</Text>
      </View>
    );
  }

  if (failed) {
    return (
      <View style={styles.detailImageEmpty}>
        <Ionicons name="alert-circle-outline" size={28} color="#dc2626" />
        <Text style={styles.stateText}>Could not load sensor photo.</Text>
        <Text style={styles.detailImageHint} numberOfLines={2}>
          {candidates[0]}
        </Text>
      </View>
    );
  }

  const uri = candidates[Math.min(idx, candidates.length - 1)];

  return (
    <>
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={() => setPreviewOpen(true)}
        disabled={loading}
        style={{ position: 'relative' }}
      >
        {loading ? (
          <View style={styles.detailImageLoading}>
            <ActivityIndicator color="#003580" />
          </View>
        ) : null}
        <Image
          source={{ uri }}
          style={[styles.detailImage, loading && { opacity: 0.2 }]}
          resizeMode="contain"
          onLoadStart={() => setLoading(true)}
          onLoad={() => setLoading(false)}
          onError={() => {
            if (idx + 1 < candidates.length) {
              setIdx((v) => v + 1);
              setLoading(true);
            } else {
              setLoading(false);
              setFailed(true);
            }
          }}
        />
        {!loading ? (
          <View style={styles.detailImageViewHint}>
            <Ionicons name="expand-outline" size={14} color="#fff" />
            <Text style={styles.detailImageViewHintText}>Tap to view</Text>
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

/**
 * Customer portal — scoped read-only logs/inventory (allowed WH + clients only).
 * Does not edit masters or DO assignments.
 */
export default function CustomerScreen({ user, token, apiUrl, onLogout, onUserUpdate }) {
  const [activeTab, setActiveTab] = useState('Dashboard'); // Dashboard | Logs | Reports | More
  const [busy, setBusy] = useState(false);

  const [warehouseFilter, setWarehouseFilter] = useState('All');
  const [clientFilter, setClientFilter] = useState('All');
  const [logsReportsMode, setLogsReportsMode] = useState('temperature'); // temperature | inward | outward
  const [logsChamberFilter, setLogsChamberFilter] = useState('all');
  const [logsClientFilter, setLogsClientFilter] = useState('All');
  const [logsTypeFilter, setLogsTypeFilter] = useState('all');
  const [logsReportDateFrom, setLogsReportDateFrom] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [logsReportDateTo, setLogsReportDateTo] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [chamberReportLogs, setChamberReportLogs] = useState([]);
  const [chamberReportsLoading, setChamberReportsLoading] = useState(false);
  const [chamberReportsError, setChamberReportsError] = useState('');
  const [showLogsChamberDropdown, setShowLogsChamberDropdown] = useState(false);
  const [showLogsClientDropdown, setShowLogsClientDropdown] = useState(false);
  const [showLogsTypeDropdown, setShowLogsTypeDropdown] = useState(false);
  const [calendarContext, setCalendarContext] = useState('dock'); // dock | logsTemp | overview | overviewInOut | overviewTask
  const [logSearch, setLogSearch] = useState('');
  const [logPage, setLogPage] = useState(1);
  const [logTotal, setLogTotal] = useState(0);
  const [logHasMore, setLogHasMore] = useState(false);
  const [dateFrom, setDateFrom] = useState('All');
  const [dateTo, setDateTo] = useState('All');
  const [openFilter, setOpenFilter] = useState(null); // 'warehouse' | 'client' | null
  const [selectedLog, setSelectedLog] = useState(null);
  const [imagePreview, setImagePreview] = useState(null); // { uri, label } | null
  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const [calendarPickMode, setCalendarPickMode] = useState('from'); // 'from' | 'to'
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [dynamicWarehouses, setDynamicWarehouses] = useState([]);
  const [dynamicClients, setDynamicClients] = useState([]);
  const [warehouseClientsMap, setWarehouseClientsMap] = useState({});
  const [todayLogItems, setTodayLogItems] = useState([]);
  const [homeUpdates, setHomeUpdates] = useState([]);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeRefreshing, setHomeRefreshing] = useState(false);
  const [homeError, setHomeError] = useState('');
  const [overviewDate, setOverviewDate] = useState(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  });
  const [overviewWarehouse, setOverviewWarehouse] = useState('All');
  const [overviewClient, setOverviewClient] = useState('All');
  const [overviewHomeSection, setOverviewHomeSection] = useState('temperature'); // temperature | inout
  const [overviewTempDateFrom, setOverviewTempDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  });
  const [overviewTempDateTo, setOverviewTempDateTo] = useState(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  });
  const [overviewTempTasks, setOverviewTempTasks] = useState([]);
  const [overviewTempListFilter, setOverviewTempListFilter] = useState('completed'); // completed | bad | pending
  const [overviewTempShift, setOverviewTempShift] = useState(
    () => (new Date().getHours() >= 16 ? 'Evening' : 'Morning')
  );
  const [overviewTempListPage, setOverviewTempListPage] = useState(1);
  const [logsTempListPage, setLogsTempListPage] = useState(1);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState('');
  const [overviewTotals, setOverviewTotals] = useState({
    tasks: 0,
    inward: 0,
    outward: 0,
    todayCompleted: 0,
    todayTotal: 0
  });
  const [overviewSeries, setOverviewSeries] = useState([]);
  const [overviewInwardList, setOverviewInwardList] = useState([]);
  const [overviewOutwardList, setOverviewOutwardList] = useState([]);
  const [overviewInOutDateFrom, setOverviewInOutDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  });
  const [overviewInOutDateTo, setOverviewInOutDateTo] = useState(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  });
  const [showOverviewClientDropdown, setShowOverviewClientDropdown] = useState(false);

  const [inventoryRows, setInventoryRows] = useState([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState('');
  const [inventoryLoadingMore, setInventoryLoadingMore] = useState(false);
  const [inventoryHasMore, setInventoryHasMore] = useState(false);
  const inventoryOffsetRef = useRef(0);
  const inventoryLoadingMoreRef = useRef(false);
  const inventoryHasMoreRef = useRef(false);

  const [reportRows, setReportRows] = useState([]);
  const [reportWarehouses, setReportWarehouses] = useState([]);
  const [reportClients, setReportClients] = useState([]);
  const [reportWarehouseFilter, setReportWarehouseFilter] = useState('All');
  const [reportClientFilter, setReportClientFilter] = useState('All');
  const [reportView, setReportView] = useState('all'); // all | mismatch
  const [selectedReport, setSelectedReport] = useState(null);
  const [reportHistory, setReportHistory] = useState([]);
  const [reportHistoryPage, setReportHistoryPage] = useState(1);
  const [reportHistoryLoading, setReportHistoryLoading] = useState(false);
  const [reportHistoryError, setReportHistoryError] = useState('');
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportsError, setReportsError] = useState('');
  const [reportsRefreshing, setReportsRefreshing] = useState(false);
  const [reportsLoadingMore, setReportsLoadingMore] = useState(false);
  const [reportHasMore, setReportHasMore] = useState(false);
  const reportOffsetRef = useRef(0);
  const reportsLoadingMoreRef = useRef(false);
  const reportHasMoreRef = useRef(false);
  const [adminNotes, setAdminNotes] = useState([]);
  const [adminNotesLoading, setAdminNotesLoading] = useState(false);
  const [adminNotesError, setAdminNotesError] = useState('');
  const [queryMessage, setQueryMessage] = useState('');
  const [querySending, setQuerySending] = useState(false);
  const [queryError, setQueryError] = useState('');
  const [querySuccess, setQuerySuccess] = useState('');

  const displayName = user?.full_name || user?.email?.split('@')[0] || 'Customer';
  const userRef = useRef(user);
  userRef.current = user;

  const authHeaders = useMemo(
    () => ({
      Accept: 'application/json',
      Authorization: `Bearer ${token}`
    }),
    [token]
  );

  const allowedClients = useMemo(() => {
    if (!user?.allowed_clients) return [];
    return String(user.allowed_clients)
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
  }, [user?.allowed_clients]);

  const allowedWarehouses = useMemo(() => {
    if (!user?.allowed_warehouses) return [];
    return String(user.allowed_warehouses)
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean);
  }, [user?.allowed_warehouses]);

  const normName = (v) => String(v || '').trim().toLowerCase();

  const warehouseOptions = useMemo(() => {
    // Customer must only see assigned warehouses when scope is set
    if (allowedWarehouses.length) return ['All', ...allowedWarehouses];
    return ['All', ...dynamicWarehouses];
  }, [allowedWarehouses, dynamicWarehouses]);

  const clientOptions = useMemo(() => {
    const base = allowedClients.length ? allowedClients : dynamicClients;
    if (warehouseFilter === 'All') {
      return ['All', ...base];
    }
    const whKey = Object.keys(warehouseClientsMap).find(
      (k) => normName(k) === normName(warehouseFilter)
    );
    let scoped = whKey ? warehouseClientsMap[whKey] || [] : [];
    if (allowedClients.length) {
      scoped = scoped.filter((c) => allowedClients.some((a) => normName(a) === normName(c)));
    }
    const list = scoped.length ? scoped : base;
    return ['All', ...list];
  }, [allowedClients, dynamicClients, warehouseFilter, warehouseClientsMap]);

  const warehouseFilterSelected = warehouseFilter !== 'All';

  const reportClientOptions = useMemo(() => {
    const base = allowedClients.length ? allowedClients : reportClients;
    if (reportWarehouseFilter === 'All') {
      return ['All', ...base];
    }
    const whKey = Object.keys(warehouseClientsMap).find(
      (k) => normName(k) === normName(reportWarehouseFilter)
    );
    let scoped = whKey ? warehouseClientsMap[whKey] || [] : [];
    if (allowedClients.length) {
      scoped = scoped.filter((c) => allowedClients.some((a) => normName(a) === normName(c)));
    }
    const list = scoped.length ? scoped : base;
    return ['All', ...list];
  }, [allowedClients, reportClients, reportWarehouseFilter, warehouseClientsMap]);

  const toLocalYmd = (d = new Date()) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

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
    if (nextFrom !== 'All' && nextTo !== 'All' && nextTo < nextFrom) {
      nextTo = nextFrom;
    }
    setDateFrom(nextFrom || 'All');
    setDateTo(nextTo || 'All');
  };

  const suggestToday = () => {
    const t = toLocalYmd();
    applyDateRange(t, t);
  };

  const suggestYesterday = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const y = toLocalYmd(d);
    applyDateRange(y, y);
  };

  const suggestLast7 = () => {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 6);
    applyDateRange(toLocalYmd(start), toLocalYmd(end));
  };

  const clearDateRange = () => applyDateRange('All', 'All');

  const clearAllFilters = () => {
    setWarehouseFilter('All');
    setClientFilter('All');
    setOpenFilter(null);
    setLogSearch('');
    setLogPage(1);
    if (logsReportsMode === 'inward' || logsReportsMode === 'outward') {
      const today = toLocalYmd();
      applyDateRange(today, today);
    } else {
      clearLogsReportFilters();
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

  // Keep To >= From whenever either side changes
  useEffect(() => {
    if (dateFrom === 'All' || dateTo === 'All') return;
    if (dateTo < dateFrom) setDateTo(dateFrom);
  }, [dateFrom, dateTo]);

  const openCalendar = (mode = 'from') => {
    setOpenFilter(null);
    setCalendarContext('dock');
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
    for (let day = 1; day <= totalDays; day += 1) {
      days.push(new Date(year, month, day));
    }
    return days;
  };

  const applyScope = useCallback(
    (items, whFilter = 'All', clFilter = 'All') => {
      return (items || []).filter((row) => {
        const rowClient = normName(row.client_name);
        const rowClientCode = normName(
          row.client_code || row.inward_client_code || row.outward_client_code
        );
        const rowWh = normName(row.warehouse_name);
        const rowWhCode = normName(row.warehouse_code);

        // Strict: if customer has assigned clients, row must match name OR code
        const clientOk =
          allowedClients.length === 0
            ? true
            : allowedClients.some((c) => {
                const token = normName(c);
                return token && (token === rowClient || token === rowClientCode);
              });

        const whOk =
          allowedWarehouses.length === 0
            ? true
            : allowedWarehouses.some((w) => {
                const token = normName(w);
                return token && (token === rowWh || token === rowWhCode);
              });

        // UI filter chips (must also stay inside assigned scope)
        const whFilterOk =
          whFilter === 'All' ||
          normName(whFilter) === rowWh ||
          normName(whFilter) === rowWhCode;
        const clientFilterOk =
          clFilter === 'All' ||
          normName(clFilter) === rowClient ||
          normName(clFilter) === rowClientCode;

        return clientOk && whOk && whFilterOk && clientFilterOk;
      });
    },
    [allowedClients, allowedWarehouses]
  );

  const overviewClientOptions = useMemo(() => {
    const base = allowedClients.length ? allowedClients : dynamicClients;
    return ['All', ...base];
  }, [allowedClients, dynamicClients]);

  const overviewWarehouseOptions = useMemo(() => {
    if (allowedWarehouses.length) return ['All', ...allowedWarehouses];
    return ['All', ...dynamicWarehouses];
  }, [allowedWarehouses, dynamicWarehouses]);

  const applyOverviewDate = useCallback((ymd) => {
    const next = String(ymd || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return;
    setOverviewDate(next);
  }, []);

  const applyOverviewInOutRange = useCallback((from, to) => {
    let nextFrom = String(from || '').trim();
    let nextTo = String(to || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextFrom)) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextTo)) nextTo = nextFrom;
    if (nextTo < nextFrom) {
      const tmp = nextFrom;
      nextFrom = nextTo;
      nextTo = tmp;
    }
    setOverviewInOutDateFrom(nextFrom);
    setOverviewInOutDateTo(nextTo);
  }, []);

  const openOverviewInOutCalendar = (mode = 'from') => {
    setOpenFilter(null);
    setCalendarContext('overviewInOut');
    const seed =
      mode === 'to' ? overviewInOutDateTo : overviewInOutDateFrom;
    try {
      const [y, m] = String(seed).split('-').map(Number);
      if (y && m) setCalendarMonth(new Date(y, m - 1, 1));
      else setCalendarMonth(new Date(`${seed}T12:00:00`));
    } catch (_) {
      setCalendarMonth(new Date());
    }
    setCalendarPickMode(mode);
    setShowCalendarModal(true);
  };

  const applyOverviewTempRange = useCallback((from, to) => {
    let nextFrom = String(from || '').trim();
    let nextTo = String(to || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextFrom)) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextTo)) nextTo = nextFrom;
    if (nextTo < nextFrom) {
      const tmp = nextFrom;
      nextFrom = nextTo;
      nextTo = tmp;
    }
    setOverviewTempDateFrom(nextFrom);
    setOverviewTempDateTo(nextTo);
    setOverviewTempListPage(1);
  }, []);

  const openOverviewTempCalendar = (mode = 'from') => {
    setOpenFilter(null);
    setCalendarContext('overviewTask');
    const seed = mode === 'to' ? overviewTempDateTo : overviewTempDateFrom;
    try {
      const [y, m] = String(seed).split('-').map(Number);
      if (y && m) setCalendarMonth(new Date(y, m - 1, 1));
      else setCalendarMonth(new Date(`${seed}T12:00:00`));
    } catch (_) {
      setCalendarMonth(new Date());
    }
    setCalendarPickMode(mode);
    setShowCalendarModal(true);
  };

  const loadOverview = useCallback(async () => {
    if (!apiUrl || !token) return;
    setOverviewLoading(true);
    setOverviewError('');
    try {
      // Refresh customer scope so graph uses live Super Admin access list
      let liveAllowedClients = allowedClients;
      let liveAllowedWarehouses = allowedWarehouses;
      try {
        const meRes = await fetch(`${apiUrl}/api/auth/me`, { headers: authHeaders });
        const meData = await meRes.json().catch(() => ({}));
        if (meRes.ok && meData?.user) {
          const prev = userRef.current || {};
          const nextClients = String(meData.user.allowed_clients || '')
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean);
          const nextWarehouses = String(meData.user.allowed_warehouses || '')
            .split(',')
            .map((w) => w.trim())
            .filter(Boolean);
          if (nextClients.length) liveAllowedClients = nextClients;
          if (nextWarehouses.length) liveAllowedWarehouses = nextWarehouses;
          const sameClients =
            String(prev.allowed_clients || '') === String(meData.user.allowed_clients || '');
          const sameWh =
            String(prev.allowed_warehouses || '') === String(meData.user.allowed_warehouses || '');
          if (!sameClients || !sameWh) {
            onUserUpdate?.({
              ...prev,
              ...meData.user,
              role: meData.user.role || prev.role
            });
          }
        }
      } catch (_) {
        /* keep cached profile */
      }

      const day = overviewDate;
      const warehouseQs =
        overviewWarehouse && overviewWarehouse !== 'All'
          ? `&warehouse=${encodeURIComponent(overviewWarehouse)}`
          : '';
      const clientQs =
        overviewClient && overviewClient !== 'All'
          ? `&client=${encodeURIComponent(overviewClient)}`
          : '';
      const needTemp = overviewHomeSection === 'temperature';

      const parseItemsEarly = (payload) => {
        if (Array.isArray(payload?.items)) return payload.items;
        if (Array.isArray(payload?.data)) return payload.data;
        if (Array.isArray(payload?.rows)) return payload.rows;
        if (Array.isArray(payload)) return payload;
        return [];
      };
      const tokenMatchEarly = (token, name, code) => {
        const t = normName(token);
        if (!t) return false;
        return t === normName(name) || t === normName(code);
      };
      const rowInAccessEarly = (row) => {
        const name = row.client_name;
        const code = row.client_code || row.inward_client_code || row.outward_client_code;
        const wh = row.warehouse_name;
        const whCode = row.warehouse_code;
        const clientOk =
          liveAllowedClients.length === 0
            ? true
            : liveAllowedClients.some((c) => tokenMatchEarly(c, name, code));
        const whOk =
          liveAllowedWarehouses.length === 0
            ? true
            : liveAllowedWarehouses.some((w) => tokenMatchEarly(w, wh, whCode));
        const clientFilterOk =
          !overviewClient ||
          overviewClient === 'All' ||
          tokenMatchEarly(overviewClient, name, code);
        const warehouseFilterOk =
          !overviewWarehouse ||
          overviewWarehouse === 'All' ||
          tokenMatchEarly(overviewWarehouse, wh, whCode);
        return clientOk && whOk && clientFilterOk && warehouseFilterOk;
      };

      if (needTemp) {
        let taskFrom = overviewTempDateFrom;
        let taskTo = overviewTempDateTo;
        if (taskTo < taskFrom) {
          const tmp = taskFrom;
          taskFrom = taskTo;
          taskTo = tmp;
        }
        const tempCommon =
          'fromDate=' +
          encodeURIComponent(taskFrom) +
          '&toDate=' +
          encodeURIComponent(taskTo) +
          '&page=1&limit=5000&export=1';
        const tRes = await fetch(
          `${apiUrl}/api/chamber-temp?${tempCommon}${warehouseQs}${clientQs}`,
          { headers: authHeaders }
        );
        const tData = await tRes.json().catch(() => ({}));
        if (!tRes.ok) {
          throw new Error(tData.message || tData.error || 'Failed to load temperature tasks');
        }
        const tempLogs = parseItemsEarly(tData).filter(rowInAccessEarly);
        let clientNames = liveAllowedClients.slice();
        if (overviewClient && overviewClient !== 'All') clientNames = [overviewClient];
        setOverviewTempTasks(
          buildDailyTempTaskRows({
            logs: tempLogs,
            clientNames,
            rangeStart: taskFrom,
            rangeEnd: taskTo,
            normName
          })
        );
        return;
      }

      // In/Out donut: From → To
      let rangeStart = overviewInOutDateFrom;
      let rangeEnd = overviewInOutDateTo;
      if (rangeEnd < rangeStart) {
        const tmp = rangeStart;
        rangeStart = rangeEnd;
        rangeEnd = tmp;
      }
      let bucketMode = 'day'; // day | week | month
      try {
        const startDt = new Date(`${rangeStart}T12:00:00`);
        const endDt = new Date(`${rangeEnd}T12:00:00`);
        const spanDays = Math.max(
          0,
          Math.round((endDt.getTime() - startDt.getTime()) / 86400000)
        );
        if (spanDays > 90) bucketMode = 'month';
        else if (spanDays > 21) bucketMode = 'week';
      } catch (_) {
        bucketMode = 'day';
      }
      const rangeLimit = bucketMode === 'month' ? 10000 : bucketMode === 'week' ? 5000 : 2000;
      const rangeCommon = `fromDate=${encodeURIComponent(rangeStart)}&toDate=${encodeURIComponent(rangeEnd)}&page=1&limit=${rangeLimit}&export=1`;

      const fetchJobs = [
        fetch(`${apiUrl}/api/inward-logs?${rangeCommon}${warehouseQs}${clientQs}`, {
          headers: authHeaders
        }).then(async (r) => ({ kind: 'i', res: r, data: await r.json().catch(() => ({})) })),
        fetch(`${apiUrl}/api/outward-logs?${rangeCommon}${warehouseQs}${clientQs}`, {
          headers: authHeaders
        }).then(async (r) => ({ kind: 'o', res: r, data: await r.json().catch(() => ({})) }))
      ];
      const results = await Promise.all(fetchJobs);
      const byKind = Object.fromEntries(results.map((x) => [x.kind, x]));
      const iRes = byKind.i?.res || { ok: true };
      const oRes = byKind.o?.res || { ok: true };
      const iData = byKind.i?.data || {};
      const oData = byKind.o?.data || {};

      if (!iRes.ok && !oRes.ok) {
        throw new Error(iData.message || oData.message || 'Failed to load In & Out');
      }

      const parseItems = (payload) => {
        if (Array.isArray(payload?.items)) return payload.items;
        if (Array.isArray(payload?.data)) return payload.data;
        if (Array.isArray(payload?.rows)) return payload.rows;
        if (Array.isArray(payload)) return payload;
        return [];
      };

      const tokenMatch = (token, name, code) => {
        const t = normName(token);
        if (!t) return false;
        return t === normName(name) || t === normName(code);
      };

      // Strict access gate using LIVE assigned clients/warehouses (name OR code)
      const rowInAccess = (row) => {
        const name = row.client_name;
        const code = row.client_code || row.inward_client_code || row.outward_client_code;
        const wh = row.warehouse_name;
        const whCode = row.warehouse_code;

        const clientOk =
          liveAllowedClients.length === 0
            ? true
            : liveAllowedClients.some((c) => tokenMatch(c, name, code));

        const whOk =
          liveAllowedWarehouses.length === 0
            ? true
            : liveAllowedWarehouses.some((w) => tokenMatch(w, wh, whCode));

        const clientFilterOk =
          !overviewClient ||
          overviewClient === 'All' ||
          tokenMatch(overviewClient, name, code);

        const warehouseFilterOk =
          !overviewWarehouse ||
          overviewWarehouse === 'All' ||
          tokenMatch(overviewWarehouse, wh, whCode);

        return clientOk && whOk && clientFilterOk && warehouseFilterOk;
      };

      const inward = parseItems(iData)
        .map((r) => normalizeLogRow(r, 'inward'))
        .filter(rowInAccess);
      const outward = parseItems(oData)
        .map((r) => normalizeLogRow(r, 'outward'))
        .filter(rowInAccess);

      const logDayKey = (log) => {
        const raw = String(log?.entry_date || log?.formatted_date || '').trim();
        const m = raw.match(/(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : null;
      };

      const MONTH_SHORT = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec'
      ];
      const WEEK_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

      const toYmdParts = (dt) => {
        const y = dt.getFullYear();
        const m = String(dt.getMonth() + 1).padStart(2, '0');
        const d = String(dt.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      };

      // Monday-start week key (ISO-style)
      const weekStartKey = (ymdOrDate) => {
        const dt =
          ymdOrDate instanceof Date
            ? new Date(ymdOrDate.getTime())
            : new Date(`${String(ymdOrDate).slice(0, 10)}T12:00:00`);
        if (Number.isNaN(dt.getTime())) return null;
        const dow = dt.getDay(); // 0=Sun
        const delta = dow === 0 ? -6 : 1 - dow;
        dt.setDate(dt.getDate() + delta);
        return toYmdParts(dt);
      };

      const dayBuckets = [];
      try {
        const cursor = new Date(`${rangeStart}T12:00:00`);
        const endCursor = new Date(`${rangeEnd}T12:00:00`);
        if (bucketMode === 'month') {
          const seen = new Set();
          const c = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 12);
          const endM = new Date(endCursor.getFullYear(), endCursor.getMonth(), 1, 12);
          while (c <= endM) {
            const y = c.getFullYear();
            const mi = c.getMonth();
            const key = `${y}-${String(mi + 1).padStart(2, '0')}`;
            if (!seen.has(key)) {
              seen.add(key);
              dayBuckets.push({
                date: key,
                label: MONTH_SHORT[mi],
                weekday: null,
                inward: 0,
                outward: 0
              });
            }
            c.setMonth(c.getMonth() + 1);
          }
        } else if (bucketMode === 'week') {
          const seen = new Set();
          let weekIdx = 1;
          // Align cursor to Monday of first week containing rangeStart
          const firstMon = weekStartKey(cursor);
          const c = firstMon ? new Date(`${firstMon}T12:00:00`) : new Date(cursor);
          while (c <= endCursor) {
            const key = toYmdParts(c);
            if (!seen.has(key)) {
              seen.add(key);
              const weekEnd = new Date(c);
              weekEnd.setDate(weekEnd.getDate() + 6);
              const endLabel = weekEnd > endCursor ? endCursor : weekEnd;
              dayBuckets.push({
                date: key,
                label: `W${weekIdx}`,
                weekday: `W${weekIdx}`,
                dayNum: null,
                subLabel: `${c.getDate()}–${endLabel.getDate()} ${MONTH_SHORT[endLabel.getMonth()]}`,
                inward: 0,
                outward: 0
              });
              weekIdx += 1;
            }
            c.setDate(c.getDate() + 7);
          }
        } else {
          while (cursor <= endCursor) {
            const y = cursor.getFullYear();
            const m = String(cursor.getMonth() + 1).padStart(2, '0');
            const d = String(cursor.getDate()).padStart(2, '0');
            const dateStr = `${y}-${m}-${d}`;
            const weekday = WEEK_SHORT[cursor.getDay()];
            dayBuckets.push({
              date: dateStr,
              label: weekday,
              weekday,
              dayNum: Number(d),
              inward: 0,
              outward: 0
            });
            cursor.setDate(cursor.getDate() + 1);
          }
        }
      } catch (_) {
        dayBuckets.push({ date: day, label: day.slice(5), weekday: null, inward: 0, outward: 0 });
      }
      const bucketIndex = new Map(dayBuckets.map((b, i) => [b.date, i]));

      const resolveBucketKey = (dayStr) => {
        if (!dayStr) return null;
        if (bucketMode === 'month') return dayStr.slice(0, 7);
        if (bucketMode === 'week') return weekStartKey(dayStr);
        return dayStr;
      };

      inward.forEach((log) => {
        const k = resolveBucketKey(logDayKey(log));
        if (k != null && bucketIndex.has(k)) dayBuckets[bucketIndex.get(k)].inward += 1;
      });
      outward.forEach((log) => {
        const k = resolveBucketKey(logDayKey(log));
        if (k != null && bucketIndex.has(k)) dayBuckets[bucketIndex.get(k)].outward += 1;
      });

      const inwardInRange = inward
        .filter((log) => {
          const k = logDayKey(log);
          return k && k >= rangeStart && k <= rangeEnd;
        })
        .sort((a, b) => {
          const da = String(a.entry_date || a.formatted_date || '');
          const db = String(b.entry_date || b.formatted_date || '');
          return db.localeCompare(da);
        });
      const outwardInRange = outward
        .filter((log) => {
          const k = logDayKey(log);
          return k && k >= rangeStart && k <= rangeEnd;
        })
        .sort((a, b) => {
          const da = String(a.entry_date || a.formatted_date || '');
          const db = String(b.entry_date || b.formatted_date || '');
          return db.localeCompare(da);
        });
      setOverviewTotals((prev) => ({
        ...prev,
        inward: inwardInRange.length,
        outward: outwardInRange.length
      }));
      setOverviewSeries(dayBuckets);
      setOverviewInwardList(inwardInRange);
      setOverviewOutwardList(outwardInRange);
    } catch (err) {
      setOverviewError(
        formatUserError(err, { apiUrl, context: 'Failed to load dashboard overview' })
      );
    } finally {
      setOverviewLoading(false);
      setHomeRefreshing(false);
    }
  }, [
    apiUrl,
    token,
    authHeaders,
    overviewDate,
    overviewWarehouse,
    overviewClient,
    overviewInOutDateFrom,
    overviewInOutDateTo,
    overviewHomeSection,
    overviewTempDateFrom,
    overviewTempDateTo,
    allowedClients,
    allowedWarehouses,
    onUserUpdate
  ]);

  // Handle Android system back button presses
  useEffect(() => {
    const backAction = () => {
      if (selectedLog) {
        setSelectedLog(null);
        return true;
      }
      if (selectedReport) {
        setSelectedReport(null);
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
  }, [selectedLog, selectedReport, showCalendarModal, activeTab]);

  // Keep selected filters inside assigned scope
  useEffect(() => {
    if (
      warehouseFilter !== 'All' &&
      allowedWarehouses.length > 0 &&
      !allowedWarehouses.some((w) => normName(w) === normName(warehouseFilter))
    ) {
      setWarehouseFilter('All');
    }
    if (
      overviewWarehouse !== 'All' &&
      allowedWarehouses.length > 0 &&
      !allowedWarehouses.some((w) => normName(w) === normName(overviewWarehouse))
    ) {
      setOverviewWarehouse('All');
    }
    if (
      clientFilter !== 'All' &&
      allowedClients.length > 0 &&
      !allowedClients.some((c) => normName(c) === normName(clientFilter))
    ) {
      setClientFilter('All');
    }
  }, [allowedWarehouses, allowedClients, warehouseFilter, overviewWarehouse, clientFilter]);

  const loadFilterScope = useCallback(async () => {
    if (!apiUrl || !token) return;
    try {
      const res = await fetch(`${apiUrl}/api/dashboard/inventory-filter-options`, {
        headers: authHeaders
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const map = {};
      const whNames = [];
      (Array.isArray(data?.warehouses) ? data.warehouses : []).forEach((w) => {
        const name = String(w.name || w.warehouse_name || '').trim();
        if (!name) return;
        whNames.push(name);
        const clients = (Array.isArray(w.clients) ? w.clients : [])
          .map((c) => String(c || '').trim())
          .filter(Boolean);
        map[name] = [...new Set(clients)].sort((a, b) => a.localeCompare(b));
      });
      setWarehouseClientsMap(map);
      if (allowedWarehouses.length === 0 && whNames.length) {
        setDynamicWarehouses((prev) => {
          const merged = [...new Set([...prev, ...whNames])].sort((a, b) => a.localeCompare(b));
          return merged;
        });
      }
    } catch (_) {
      // keep last map if offline
    }
  }, [apiUrl, token, authHeaders, allowedWarehouses.length]);

  useEffect(() => {
    loadFilterScope();
  }, [loadFilterScope]);

  useEffect(() => {
    if (warehouseFilter === 'All') {
      if (clientFilter !== 'All') setClientFilter('All');
      return;
    }
    if (clientFilter === 'All') return;
    const opts = clientOptions.filter((o) => o !== 'All');
    if (opts.length && !opts.some((o) => normName(o) === normName(clientFilter))) {
      setClientFilter('All');
    }
  }, [warehouseFilter, clientOptions, clientFilter]);

  useEffect(() => {
    if (reportWarehouseFilter === 'All') {
      if (reportClientFilter !== 'All') setReportClientFilter('All');
      return;
    }
    if (reportClientFilter === 'All') return;
    const opts = reportClientOptions.filter((o) => o !== 'All');
    if (opts.length && !opts.some((o) => normName(o) === normName(reportClientFilter))) {
      setReportClientFilter('All');
    }
  }, [reportWarehouseFilter, reportClientOptions, reportClientFilter]);

  useEffect(() => {
    if (
      reportWarehouseFilter !== 'All' &&
      allowedWarehouses.length > 0 &&
      !allowedWarehouses.some((w) => normName(w) === normName(reportWarehouseFilter))
    ) {
      setReportWarehouseFilter('All');
    }
    if (
      reportClientFilter !== 'All' &&
      allowedClients.length > 0 &&
      !allowedClients.some((c) => normName(c) === normName(reportClientFilter))
    ) {
      setReportClientFilter('All');
    }
  }, [allowedWarehouses, allowedClients, reportWarehouseFilter, reportClientFilter]);

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
            await onLogout?.();
          } finally {
            setBusy(false);
          }
        }
      }
    ]);
  };

  const loadHomeOverview = useCallback(async () => {
    if (!apiUrl || !token) return;
    setHomeLoading(true);
    setHomeError('');
    try {
      try {
        const meRes = await fetch(`${apiUrl}/api/auth/me`, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`
          }
        });
        const meData = await meRes.json().catch(() => ({}));
        if (meRes.ok && meData?.user) {
          const prev = userRef.current || {};
          const sameClients =
            String(prev.allowed_clients || '') === String(meData.user.allowed_clients || '');
          const sameWh =
            String(prev.allowed_warehouses || '') === String(meData.user.allowed_warehouses || '');
          if (!sameClients || !sameWh) {
            onUserUpdate?.({
              ...prev,
              ...meData.user,
              role: meData.user.role || prev.role
            });
          }
        }
      } catch (_) {
        /* keep cached profile */
      }
      const today = toLocalYmd();
      const fromUpdates = (() => {
        const d = new Date();
        d.setDate(d.getDate() - 14);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      })();

      const [todayRes, updatesRes] = await Promise.all([
        fetch(
          `${apiUrl}/api/chamber-temp?${new URLSearchParams({
            page: '1',
            limit: '100',
            fromDate: today,
            toDate: today
          }).toString()}`,
          {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`
            }
          }
        ),
        fetch(
          `${apiUrl}/api/chamber-temp?${new URLSearchParams({
            page: '1',
            limit: '100',
            fromDate: fromUpdates,
            toDate: today,
            export: '1'
          }).toString()}`,
          {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`
            }
          }
        )
      ]);

      const todayData = await todayRes.json().catch(() => ({}));
      if (!todayRes.ok) {
        if (todayRes.status === 401) {
          throw new Error('Session expired or account not found on this server. Logout and login again.');
        }
        throw new Error(
          todayData.message || todayData.error || `Failed to load overview (${todayRes.status})`
        );
      }

      const todayItems = Array.isArray(todayData?.items)
        ? todayData.items
        : Array.isArray(todayData)
          ? todayData
          : [];
      const scopedToday = applyScope(todayItems).filter((row) => {
        const d = String(row.formatted_date || row.entry_date || '').slice(0, 10);
        return d === today;
      });
      setTodayLogItems(scopedToday);

      const updatesData = await updatesRes.json().catch(() => ({}));
      const updateItems = Array.isArray(updatesData?.items)
        ? updatesData.items
        : Array.isArray(updatesData)
          ? updatesData
          : [];
      const scopedUpdates = applyScope(updateItems)
        .filter((row) => Number(row.update_count) > 0 || String(row.update_details || '').trim())
        .sort((a, b) => {
          const ta = String(a.updated_at || a.created_at || '')
            .replace('T', ' ')
            .slice(0, 19);
          const tb = String(b.updated_at || b.created_at || '')
            .replace('T', ' ')
            .slice(0, 19);
          if (tb !== ta) return tb.localeCompare(ta);
          return (Number(b.id) || 0) - (Number(a.id) || 0);
        })
        .slice(0, 12);
      setHomeUpdates(scopedUpdates);
    } catch (err) {
      setTodayLogItems([]);
      setHomeUpdates([]);
      setHomeError(formatUserError(err, { apiUrl, context: 'Failed to load overview' }));
    } finally {
      setHomeLoading(false);
      setHomeRefreshing(false);
    }
  }, [apiUrl, token, applyScope, onUserUpdate]);

  const formatUpdatePreview = (row) => {
    const raw = String(row?.update_details || '').trim();
    if (!raw) {
      const n = Number(row?.update_count) || 0;
      return n > 0 ? `Updated ${n} time${n === 1 ? '' : 's'}` : 'Updated';
    }
    const parts = raw.split('|').map((p) => p.trim()).filter(Boolean);
    const last = parts[parts.length - 1] || raw;
    return last.length > 90 ? `${last.slice(0, 90)}…` : last;
  };
  const loadLogs = useCallback(async (overrides = {}) => {
    if (!apiUrl || !token) return;
    setLogsLoading(true);
    setLogsError('');
    try {
      const isDock = logsReportsMode === 'inward' || logsReportsMode === 'outward';
      if (!isDock) return;
      let from = overrides.fromDate ?? (dateFrom === 'All' ? '' : dateFrom);
      let to = overrides.toDate ?? (dateTo === 'All' ? '' : dateTo);
      const page = overrides.page ?? logPage;
      const search = overrides.search ?? logSearch;

      const qs = new URLSearchParams();
      qs.set('page', String(page));
      qs.set('limit', String(DOCK_REPORT_PAGE_SIZE));
      const trimmedSearch = String(search || '').trim();
      if (trimmedSearch) qs.set('search', trimmedSearch);

      if (warehouseFilter && warehouseFilter !== 'All') {
        qs.set('warehouse', warehouseFilter);
      }
      if (clientFilter && clientFilter !== 'All') {
        qs.set('client', clientFilter);
      }
      if (from) qs.set('fromDate', from);
      if (to) qs.set('toDate', to);

      const endpoint =
        logsReportsMode === 'inward' ? '/api/inward-logs' : '/api/outward-logs';

      const res = await fetch(`${apiUrl}${endpoint}?${qs.toString()}`, {
        method: 'GET',
        headers: authHeaders
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Session expired or account not found on this server. Logout and login again.');
        }
        throw new Error(data.message || data.error || `Failed to load logs (${res.status})`);
      }

      let items = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data)
          ? data
          : [];
      items = items.map((row) => normalizeLogRow(row, logsReportsMode));
      items = applyScope(items, warehouseFilter, clientFilter);

      setLogPage(page);
      setLogTotal(Number(data.total) || items.length);
      setLogHasMore(Boolean(data.hasMore));

      setLogs(items);

      if (allowedWarehouses.length === 0) {
        const wh = [
          ...new Set(
            items
              .map((r) => r.warehouse_name)
              .filter(Boolean)
              .map((n) => String(n).trim())
          )
        ].sort((a, b) => a.localeCompare(b));
        setDynamicWarehouses(wh);
      }
      if (allowedClients.length === 0) {
        const cl = [
          ...new Set(
            items
              .map((r) => r.client_name)
              .filter(Boolean)
              .map((n) => String(n).trim())
          )
        ].sort((a, b) => a.localeCompare(b));
        setDynamicClients(cl);
      }
    } catch (err) {
      const msg = formatUserError(err, { apiUrl, context: 'Failed to load logs' });
      console.warn('Customer logs load failed:', msg);
      setLogs([]);
      setLogsError(msg);
    } finally {
      setLogsLoading(false);
      setRefreshing(false);
    }
  }, [
    apiUrl,
    token,
    authHeaders,
    warehouseFilter,
    clientFilter,
    dateFrom,
    dateTo,
    logsReportsMode,
    logPage,
    logSearch,
    applyScope,
    allowedClients.length,
    allowedWarehouses.length
  ]);

  const applyDockLogFilters = useCallback(() => {
    setLogPage(1);
    loadLogs({ page: 1 });
  }, [loadLogs]);

  const clearDockLogFilters = useCallback(() => {
    const today = toLocalYmd();
    setLogSearch('');
    setLogPage(1);
    applyDateRange(today, today);
    loadLogs({ page: 1, search: '', fromDate: today, toDate: today });
  }, [loadLogs]);

  const goLogPrevPage = useCallback(() => {
    if (logPage <= 1) return;
    loadLogs({ page: logPage - 1 });
  }, [logPage, loadLogs]);

  const goLogNextPage = useCallback(() => {
    if (!logHasMore) return;
    loadLogs({ page: logPage + 1 });
  }, [logHasMore, logPage, loadLogs]);

  const loadInventory = useCallback(async (mode = 'reset') => {
    if (!apiUrl || !token) return;
    const reset = mode !== 'more';
    if (!reset) {
      if (inventoryLoadingMoreRef.current || !inventoryHasMoreRef.current) return;
      inventoryLoadingMoreRef.current = true;
      setInventoryLoadingMore(true);
    } else {
      setInventoryLoading(true);
      setInventoryError('');
      inventoryOffsetRef.current = 0;
    }
    try {
      const offset = reset ? 0 : inventoryOffsetRef.current;
      const limit = reset ? INVENTORY_REPORT_FIRST_PAGE : INVENTORY_REPORT_MORE_PAGE;
      const qs = buildInventoryReconciliationQuery({
        offset,
        limit,
        warehouse: warehouseFilter,
        client: clientFilter
      });
      const res = await fetch(
        `${apiUrl}/api/dashboard/inventory-reconciliation?${qs.toString()}`,
        { headers: authHeaders }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Session expired or account not found on this server. Logout and login again.');
        }
        throw new Error(data.message || data.error || `Failed to load inventory (${res.status})`);
      }
      const { rows, total } = parseInventoryReconciliationPayload(data);
      // Double-scope on client (backend also scopes for customer role)
      const scoped = applyScope(rows, warehouseFilter, clientFilter);
      inventoryOffsetRef.current = offset + scoped.length;
      const more = inventoryReportHasMore(offset, scoped.length, total) || !!data.has_more;
      inventoryHasMoreRef.current = more;
      setInventoryHasMore(more);
      setInventoryRows((prev) => (reset ? scoped : [...prev, ...scoped]));
    } catch (err) {
      const msg = formatUserError(err, { apiUrl, context: 'Failed to load inventory' });
      console.warn('Customer inventory load failed:', msg);
      if (reset) {
        setInventoryRows([]);
        inventoryHasMoreRef.current = false;
        setInventoryHasMore(false);
        inventoryOffsetRef.current = 0;
      }
      setInventoryError(msg);
    } finally {
      setInventoryLoading(false);
      setRefreshing(false);
      setInventoryLoadingMore(false);
      inventoryLoadingMoreRef.current = false;
    }
  }, [
    apiUrl,
    token,
    authHeaders,
    warehouseFilter,
    clientFilter,
    applyScope
  ]);

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
      const res = await fetch(
        `${apiUrl}/api/dashboard/inventory-reconciliation?${qs.toString()}`,
        { headers: authHeaders }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Session expired or account not found on this server. Logout and login again.');
        }
        throw new Error(data.message || data.error || `Failed to load inventory (${res.status})`);
      }
      const { rows, total } = parseInventoryReconciliationPayload(data);
      const scoped = applyScope(rows);

      if (reset) {
        const whSet = new Set(allowedWarehouses.map((w) => String(w).trim()).filter(Boolean));
        const clientSet = new Set(allowedClients.map((c) => String(c).trim()).filter(Boolean));
        scoped.forEach((r) => {
          if (r.warehouse_name) whSet.add(String(r.warehouse_name).trim());
          if (r.client_name) clientSet.add(String(r.client_name).trim());
        });
        setReportWarehouses(Array.from(whSet).sort((a, b) => a.localeCompare(b)));
        setReportClients(Array.from(clientSet).sort((a, b) => a.localeCompare(b)));
      }

      reportOffsetRef.current = offset + scoped.length;
      const more = inventoryReportHasMore(offset, scoped.length, total) || !!data.has_more;
      reportHasMoreRef.current = more;
      setReportHasMore(more);
      setReportRows((prev) => (reset ? scoped : [...prev, ...scoped]));
    } catch (err) {
      setReportsError(formatUserError(err, { apiUrl, context: 'Failed to load inventory reports' }));
      if (reset) {
        setReportRows([]);
        reportHasMoreRef.current = false;
        setReportHasMore(false);
        reportOffsetRef.current = 0;
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
    applyScope,
    reportWarehouseFilter,
    reportClientFilter,
    reportView,
    allowedWarehouses,
    allowedClients
  ]);

  /** LIFO: last-in (newest DO audit / update) first on outer Reports list */
  const sortLotsLifo = (rows) =>
    [...(rows || [])].sort((a, b) => {
      const dateA = String(a.last_audit_date || a.formatted_date || a.entry_date || '')
        .slice(0, 10);
      const dateB = String(b.last_audit_date || b.formatted_date || b.entry_date || '')
        .slice(0, 10);
      if (dateB !== dateA) {
        if (!dateA) return 1;
        if (!dateB) return -1;
        return dateB.localeCompare(dateA);
      }
      const timeA = String(
        a.updated_at || a.created_at || a.last_audit_date || ''
      ).replace('T', ' ').slice(0, 19);
      const timeB = String(
        b.updated_at || b.created_at || b.last_audit_date || ''
      ).replace('T', ' ').slice(0, 19);
      if (timeB !== timeA) {
        if (!timeA) return 1;
        if (!timeB) return -1;
        return timeB.localeCompare(timeA);
      }
      const idDiff = (Number(b.id) || 0) - (Number(a.id) || 0);
      if (idDiff !== 0) return idDiff;
      return String(a.client_name || '').localeCompare(String(b.client_name || ''));
    });

  const filteredInventoryRows = useMemo(() => {
    return sortLotsLifo(dedupeInventoryLots(inventoryRows));
  }, [inventoryRows]);

  const filteredReportRows = useMemo(() => {
    // Server already applies warehouse/client/view filters for page payload
    return sortLotsLifo(dedupeInventoryLots(reportRows));
  }, [reportRows]);

  const reportSummary = useMemo(() => {
    let inward = 0;
    let outward = 0;
    let mismatches = 0;
    let totalBoxes = 0;
    filteredReportRows.forEach((r) => {
      inward += Math.max(0, Number(r.total_inward_boxes) || 0);
      outward += Math.max(0, Number(r.total_outward_boxes) || 0);
      const bal = Math.max(0, Number(r.calculated_balance) || 0);
      const phys = Math.max(0, Number(r.physical_audit_count) || 0);
      // Total after DO task = physical audit count (latest logged boxes)
      totalBoxes += phys;
      if (bal - phys !== 0) mismatches += 1;
    });
    return {
      lots: filteredReportRows.length,
      inward,
      outward,
      mismatches,
      totalBoxes
    };
  }, [filteredReportRows]);

  const closeLogsReportDropdowns = () => {
    setShowLogsChamberDropdown(false);
    setShowLogsClientDropdown(false);
    setShowLogsTypeDropdown(false);
  };

  const clearLogsReportFilters = () => {
    setLogsChamberFilter('all');
    setLogsClientFilter('All');
    setLogsTypeFilter('all');
    closeLogsReportDropdowns();
    const t = toLocalYmd();
    setLogsReportDateFrom(t);
    setLogsReportDateTo(t);
  };

  const logDateKey = (value) => String(value || '').slice(0, 10);

  const resolveReportLotType = useCallback((row) => {
    return pickComplianceZone(row?.chamber_type) || 'Frozen';
  }, []);

  const chambersList = useMemo(() => {
    const map = new Map();
    [...reportRows, ...chamberReportLogs].forEach((row) => {
      const id = row?.chamber_id;
      const name = row?.chamber_name;
      if (id != null && name) {
        map.set(Number(id), {
          id: Number(id),
          name: String(name).trim(),
          chamber_type: row.chamber_type,
        });
      }
    });
    return Array.from(map.values()).sort((a, b) => {
      const na = parseInt((String(a.name || '').match(/\d+/) || [a.id])[0], 10);
      const nb = parseInt((String(b.name || '').match(/\d+/) || [b.id])[0], 10);
      return na - nb;
    });
  }, [reportRows, chamberReportLogs]);

  const logsReportClientOptions = useMemo(() => {
    let list = [];
    if (logsChamberFilter === 'all' || logsChamberFilter === 'All') {
      list = allowedClients.length ? [...allowedClients] : [...reportClients];
    } else {
      list = Array.from(
        new Set(
          [...reportRows, ...chamberReportLogs]
            .filter((r) => Number(r.chamber_id) === Number(logsChamberFilter))
            .map((r) => String(r.client_name || '').trim())
            .filter(Boolean)
        )
      );
    }
    if (allowedClients.length) {
      const accessSet = new Set(allowedClients.map((c) => normName(c)));
      list = list.filter((c) => accessSet.has(normName(c)));
    }
    return list.sort((a, b) => String(a).localeCompare(String(b)));
  }, [
    logsChamberFilter,
    allowedClients,
    reportClients,
    reportRows,
    chamberReportLogs,
  ]);

  const filteredLogsInventoryRows = useMemo(() => {
    let rows = reportRows;
    if (logsChamberFilter && logsChamberFilter !== 'All' && logsChamberFilter !== 'all') {
      rows = rows.filter((r) => {
        const cidMatch = r.chamber_id != null && Number(r.chamber_id) === Number(logsChamberFilter);
        const selectedCh = chambersList.find((c) => Number(c.id) === Number(logsChamberFilter));
        const cnameMatch =
          selectedCh &&
          r.chamber_name &&
          normName(r.chamber_name) === normName(selectedCh.name);
        return cidMatch || cnameMatch;
      });
    }
    if (logsClientFilter && logsClientFilter !== 'All' && logsClientFilter !== 'all') {
      rows = rows.filter(
        (r) => r.client_name && normName(r.client_name) === normName(logsClientFilter)
      );
    }
    if (logsTypeFilter && logsTypeFilter !== 'all' && logsTypeFilter !== 'All') {
      const want = normalizeChamberZone(logsTypeFilter);
      rows = rows.filter((r) => resolveReportLotType(r) === want);
    }
    return sortLotsLifo(dedupeInventoryLots(rows));
  }, [
    reportRows,
    logsChamberFilter,
    logsClientFilter,
    logsTypeFilter,
    chambersList,
    resolveReportLotType,
  ]);

  const logsInventorySummary = useMemo(() => {
    let totalBoxes = 0;
    filteredLogsInventoryRows.forEach((r) => {
      totalBoxes += Math.max(0, Number(r.physical_audit_count) || 0);
    });
    return {
      lots: filteredLogsInventoryRows.length,
      totalBoxes,
    };
  }, [filteredLogsInventoryRows]);

  const getFilteredLogsTemperature = useCallback(() => {
    const from =
      logsReportDateFrom <= logsReportDateTo ? logsReportDateFrom : logsReportDateTo;
    const to =
      logsReportDateFrom <= logsReportDateTo ? logsReportDateTo : logsReportDateFrom;
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

    return chamberReportLogs
      .filter((log) => {
        if (!log) return false;
        if (
          logsChamberFilter !== 'all' &&
          logsChamberFilter !== 'All' &&
          Number(log.chamber_id) !== Number(logsChamberFilter)
        ) {
          return false;
        }
        if (
          logsClientFilter !== 'all' &&
          logsClientFilter !== 'All' &&
          String(log.client_name) !== String(logsClientFilter)
        ) {
          return false;
        }
        if (logsTypeFilter !== 'all' && logsTypeFilter !== 'All') {
          if (resolveReportLotType(log) !== normalizeChamberZone(logsTypeFilter)) return false;
        }
        const entryDay = logDateKey(log.entry_date || log.formatted_date);
        if (entryDay && (entryDay < from || entryDay > to)) return false;
        return true;
      })
      .sort((a, b) => {
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
  }, [
    chamberReportLogs,
    logsChamberFilter,
    logsClientFilter,
    logsTypeFilter,
    logsReportDateFrom,
    logsReportDateTo,
    resolveReportLotType,
  ]);

  const loadChamberReportLogs = useCallback(async () => {
    if (!apiUrl || !token) return;
    setChamberReportsLoading(true);
    setChamberReportsError('');
    try {
      const from =
        logsReportDateFrom <= logsReportDateTo ? logsReportDateFrom : logsReportDateTo;
      const to =
        logsReportDateFrom <= logsReportDateTo ? logsReportDateTo : logsReportDateFrom;
      const qs = new URLSearchParams({
        page: '1',
        limit: '150',
        fromDate: from,
        toDate: to,
      });
      const res = await fetch(`${apiUrl}/api/chamber-temp?${qs.toString()}`, {
        headers: authHeaders,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Session expired or account not found on this server. Logout and login again.');
        }
        throw new Error(data.message || data.error || `Failed to load logs (${res.status})`);
      }
      const items = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data)
          ? data
          : [];
      setChamberReportLogs(applyScope(items.map((row) => normalizeLogRow(row, 'chambers'))));
    } catch (err) {
      const msg =
        err?.message === 'Network request failed'
          ? `Cannot reach server: ${apiUrl}. Open Login settings → Local server, or use Production.`
          : err.message || 'Failed to load temperature logs.';
      setChamberReportLogs([]);
      setChamberReportsError(msg);
    } finally {
      setChamberReportsLoading(false);
      setRefreshing(false);
    }
  }, [
    apiUrl,
    token,
    authHeaders,
    logsReportDateFrom,
    logsReportDateTo,
    applyScope,
  ]);

  const inventorySummary = useMemo(() => {
    let totalBoxes = 0;
    filteredInventoryRows.forEach((r) => {
      totalBoxes += Math.max(0, Number(r.physical_audit_count) || 0);
    });
    return {
      lots: filteredInventoryRows.length,
      totalBoxes
    };
  }, [filteredInventoryRows]);

  /** Latest total boxes after DO task (physical audit). */
  const getLotTotalBoxes = (item) => {
    if (item == null) return 0;
    if (item.physical_audit_count != null && item.physical_audit_count !== '') {
      return Math.max(0, Number(item.physical_audit_count) || 0);
    }
    return Math.max(0, Number(item.calculated_balance) || 0);
  };
  const reportWarehouseOptions = useMemo(
    () => ['All', ...(allowedWarehouses.length ? allowedWarehouses : reportWarehouses)],
    [allowedWarehouses, reportWarehouses]
  );

  const to24hTime = (value) => {
    if (value == null || String(value).trim() === '') return null;
    const s = String(value).trim();

    const iso = s.match(/(?:T|\s)(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (iso && !/[APMapm]{2}/.test(s)) {
      const hh = String(Math.min(23, parseInt(iso[1], 10))).padStart(2, '0');
      const mm = iso[2];
      return `${hh}:${mm}`;
    }

    const ampm = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])/);
    if (ampm) {
      let h = parseInt(ampm[1], 10);
      const m = ampm[2];
      const ap = ampm[3].toUpperCase();
      if (ap === 'PM' && h < 12) h += 12;
      if (ap === 'AM' && h === 12) h = 0;
      return `${String(h).padStart(2, '0')}:${m}`;
    }

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
    const candidates = [row.created_at, row.submit_time, row.photo_capture_time, row.inspection_time];
    for (const c of candidates) {
      const t = to24hTime(c);
      if (t) return t;
    }
    return '—';
  };

  const openReportDetail = useCallback(
    async (row) => {
      // Block opening inventory for out-of-scope client/warehouse
      if (applyScope([row]).length === 0) {
        setSelectedReport(row);
        setReportHistory([]);
        setReportHistoryError('This lot is outside your assigned warehouse / client access.');
        setReportHistoryLoading(false);
        return;
      }
      setSelectedReport(row);
      setReportHistory([]);
      setReportHistoryPage(1);
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
        items = applyScope(items);

        const clientNeedle = normName(row.client_name);
        const whNeedle = normName(row.warehouse_name);
        const chamberId = row.chamber_id != null && String(row.chamber_id).trim() !== ''
          ? Number(row.chamber_id)
          : null;
        const chamberNeedle = normName(row.chamber_name);
        items = items.filter((r) => {
          const clientMatch = !clientNeedle || normName(r.client_name) === clientNeedle;
          const whMatch = !whNeedle || normName(r.warehouse_name) === whNeedle;
          const logCid = r.chamber_id != null && String(r.chamber_id).trim() !== ''
            ? Number(r.chamber_id)
            : null;
          const chamberMatch = chamberId != null && Number.isFinite(chamberId)
            ? logCid === chamberId
            : !chamberNeedle || normName(r.chamber_name) === chamberNeedle;
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
    [apiUrl, authHeaders, applyScope]
  );

  const closeReportDetail = () => {
    setSelectedReport(null);
    setReportHistory([]);
    setReportHistoryError('');
    setReportHistoryLoading(false);
  };

  const loadAdminNotes = useCallback(async () => {
    if (!apiUrl || !token) return;
    setAdminNotesLoading(true);
    setAdminNotesError('');
    try {
      const res = await fetch(`${apiUrl}/api/customer-notes`, {
        method: 'GET',
        headers: authHeaders
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || `Failed to load notes (${res.status})`);
      }
      const items = Array.isArray(data?.items) ? data.items : [];
      // Read-only: only Super Admin updates (customers cannot send)
      setAdminNotes(items.filter((m) => m?.author_role === 'super_admin'));
    } catch (err) {
      setAdminNotes([]);
      setAdminNotesError(err.message || 'Failed to load notes.');
    } finally {
      setAdminNotesLoading(false);
    }
  }, [apiUrl, token, authHeaders]);

  useEffect(() => {
    setLogsTempListPage(1);
  }, [logsChamberFilter, logsClientFilter, logsTypeFilter, logsReportDateFrom, logsReportDateTo]);

  useEffect(() => {
    if (activeTab !== 'Dashboard') return;
    loadOverview();
  }, [activeTab, loadOverview]);

  useEffect(() => {
    if (activeTab !== 'Logs') return;
    if (logsReportsMode === 'temperature') {
      loadChamberReportLogs();
    } else {
      loadLogs();
    }
  }, [
    activeTab,
    logsReportsMode,
    loadChamberReportLogs,
    loadLogs,
    logsReportDateFrom,
    logsReportDateTo,
  ]);

  useEffect(() => {
    if (activeTab === 'Reports') {
      loadReports();
    }
  }, [activeTab, loadReports]);

  const onRefresh = () => {
    if (activeTab === 'Reports') {
      setReportsRefreshing(true);
      loadReports();
    } else if (logsReportsMode === 'temperature') {
      setRefreshing(true);
      loadChamberReportLogs();
    } else {
      setRefreshing(true);
      loadLogs();
    }
  };

  const onHomeRefresh = () => {
    setHomeRefreshing(true);
    loadOverview();
  };

  const submitCustomerQuery = useCallback(async () => {
    const msg = String(queryMessage || '').trim();
    if (!msg) {
      setQueryError('Please type your query message.');
      setQuerySuccess('');
      return;
    }
    if (!apiUrl || !token) {
      setQueryError('Not connected. Check server and login again.');
      return;
    }
    setQuerySending(true);
    setQueryError('');
    setQuerySuccess('');
    try {
      const res = await fetch(`${apiUrl}/api/customer-reports`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          reference_no: 'Query',
          message: msg
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || 'Failed to submit query.');
      }
      setQueryMessage('');
      setQuerySuccess(data.message || 'Query submitted.');
      Alert.alert('Submitted', data.message || 'Your query was submitted.');
    } catch (err) {
      setQueryError(err.message || 'Failed to submit query.');
    } finally {
      setQuerySending(false);
    }
  }, [queryMessage, apiUrl, token, authHeaders]);

  const selectWarehouseFilter = (opt) => {
    setWarehouseFilter(opt);
    setClientFilter('All');
  };

  const pickFilterOption = (opt) => {
    if (openFilter === 'warehouse') {
      selectWarehouseFilter(opt);
      if (opt === 'All') {
        setOpenFilter(null);
        return;
      }
      const whKey = Object.keys(warehouseClientsMap).find(
        (k) => normName(k) === normName(opt)
      );
      const clientList = whKey ? warehouseClientsMap[whKey] || [] : [];
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
      setReportClientFilter('All');
      if (opt === 'All') {
        setOpenFilter(null);
        return;
      }
      const whKey = Object.keys(warehouseClientsMap).find(
        (k) => normName(k) === normName(opt)
      );
      const clientList = whKey ? warehouseClientsMap[whKey] || [] : [];
      setOpenFilter(clientList.length ? 'reportClient' : null);
      return;
    }
    if (openFilter === 'reportClient') {
      setReportClientFilter(opt);
      setOpenFilter(null);
      return;
    }
    if (openFilter === 'overviewWarehouse') {
      setOverviewWarehouse(opt);
      setOpenFilter(null);
    }
  };

  const resolveDockPhotoUri = useCallback((path, hint) => {
    const local =
      resolveImageUrl(path, apiUrl, hint) ||
      resolveImageUrl(path, PRODUCTION_API_URL, hint);
    if (local && /^https?:\/\/res\.cloudinary\.com\//i.test(String(path || ''))) {
      return [local, String(path).trim()];
    }
    return local;
  }, [apiUrl]);

  const renderFilterDropdown = (key, label, options, selected, onSelect, formatOption) => {
    const open = openFilter === key;
    const selectedLabel = formatOption ? formatOption(selected) : selected;
    const isActive = selected && selected !== 'All';
    return (
      <TouchableOpacity
        style={[styles.filterChip, isActive && styles.filterChipActive]}
        onPress={() => setOpenFilter(open ? null : key)}
        activeOpacity={0.85}
      >
        <Ionicons
          name={key === 'warehouse' ? 'business-outline' : 'people-outline'}
          size={12}
          color={isActive ? '#003580' : '#64748b'}
        />
        <View style={styles.filterChipTextWrap}>
          <Text style={styles.filterChipLabel}>{label}</Text>
          <Text style={[styles.filterChipValue, isActive && styles.filterChipValueActive]} numberOfLines={1}>
            {selectedLabel || 'All'}
          </Text>
        </View>
        <Ionicons name="chevron-down" size={12} color={isActive ? '#003580' : '#94a3b8'} />
      </TouchableOpacity>
    );
  };

  const renderFilterPickerModal = () => {
    const isWarehouse = openFilter === 'warehouse';
    const isClient = openFilter === 'client';
    const isReportWarehouse = openFilter === 'reportWarehouse';
    const isReportClient = openFilter === 'reportClient';
    const isOverviewWarehouse = openFilter === 'overviewWarehouse';
    if (
      !isWarehouse &&
      !isClient &&
      !isReportWarehouse &&
      !isReportClient &&
      !isOverviewWarehouse
    ) {
      return null;
    }

    const title =
      isWarehouse || isReportWarehouse || isOverviewWarehouse
        ? 'Select warehouse'
        : 'Select client';
    const options = isWarehouse
      ? warehouseOptions
      : isClient
        ? clientOptions
        : isReportWarehouse
          ? reportWarehouseOptions
          : isOverviewWarehouse
            ? overviewWarehouseOptions
            : reportClientOptions;
    const selected = isWarehouse
      ? warehouseFilter
      : isClient
        ? clientFilter
        : isReportWarehouse
          ? reportWarehouseFilter
          : isOverviewWarehouse
            ? overviewWarehouse
            : reportClientFilter;
    const onSelect = (v) => {
      pickFilterOption(v);
    };

    return (
      <Modal
        visible
        transparent
        animationType="slide"
        onRequestClose={() => setOpenFilter(null)}
      >
        <View style={styles.filterModalBackdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            pressBorder={false}
            onPress={() => setOpenFilter(null)}
          />
          <View style={styles.filterModalSheet}>
            <View style={styles.filterModalHandle} />
            <Text style={styles.filterModalTitle}>{title}</Text>
            <ScrollView
              style={styles.filterModalList}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {options.map((opt) => {
                const active = selected === opt;
                return (
                  <TouchableOpacity
                    key={`picker-${opt}`}
                    style={[styles.filterModalItem, active && styles.filterModalItemActive]}
                    onPress={() => onSelect(opt)}
                    activeOpacity={0.85}
                  >
                    <Text
                      style={[styles.filterModalItemText, active && styles.filterModalItemTextActive]}
                      numberOfLines={2}
                    >
                      {opt}
                    </Text>
                    {active ? <Ionicons name="checkmark-circle" size={18} color="#003580" /> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity
              style={styles.filterModalClose}
              onPress={() => setOpenFilter(null)}
              activeOpacity={0.85}
            >
              <Text style={styles.filterModalCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  };

  const renderDetailRow = (label, value) => {
    if (value == null || value === '') return null;
    return (
      <View style={styles.logDetailRow}>
        <Text style={styles.logDetailLabel}>{label}</Text>
        <Text style={styles.logDetailValue}>{String(value)}</Text>
      </View>
    );
  };

  const renderReportItem = ({ item }) => {
    const inward = Math.max(0, Number(item.total_inward_boxes) || 0);
    const outward = Math.max(0, Number(item.total_outward_boxes) || 0);
    const balance = Math.max(0, Number(item.calculated_balance) || 0);
    const totalBoxes = getLotTotalBoxes(item);
    const outOfStock = totalBoxes === 0;
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
              {` · In ${inward} · Out ${outward} · Bal ${balance}`}
              {` · Total ${totalBoxes}`}
            </Text>
            {outOfStock ? (
              <Text style={styles.outOfStockTag} numberOfLines={1}>
                Out of stock
              </Text>
            ) : null}
          </View>
          <View style={styles.totalBoxesCol}>
            {outOfStock ? (
              <Text style={styles.outOfStockValue}>0</Text>
            ) : (
              <Text style={styles.totalBoxesValue}>{totalBoxes}</Text>
            )}
            <Text style={[styles.totalBoxesLabel, outOfStock && styles.outOfStockLabel]}>
              {outOfStock ? 'Out of stock' : 'boxes'}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderLogsInventoryItem = ({ item }) => {
    const totalBoxes = getLotTotalBoxes(item);
    const outOfStock = totalBoxes === 0;
    const zone = chamberZoneStyle(resolveReportLotType(item));
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

  const openLogsTempCalendar = (mode = 'from') => {
    setOpenFilter(null);
    setCalendarContext('logsTemp');
    const seed = mode === 'to' ? logsReportDateTo : logsReportDateFrom;
    try {
      const [y, m] = String(seed).split('-').map(Number);
      if (y && m) setCalendarMonth(new Date(y, m - 1, 1));
      else setCalendarMonth(new Date(`${seed}T12:00:00`));
    } catch (_) {
      setCalendarMonth(new Date());
    }
    setCalendarPickMode(mode);
    setShowCalendarModal(true);
  };

  const renderLogsTempDateRange = () => (
    <View style={[styles.inoutDateRow, styles.logsTempDateRow]}>
      <TouchableOpacity
        style={[styles.filterChip, styles.inoutDateChip]}
        onPress={() => openLogsTempCalendar('from')}
        activeOpacity={0.85}
      >
        <View style={styles.filterChipTextWrap}>
          <Text style={styles.filterChipLabel}>Start date</Text>
          <Text style={[styles.filterChipValue, styles.filterChipValueActive]} numberOfLines={1}>
            {formatDateLabel(logsReportDateFrom)}
          </Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.filterChip, styles.inoutDateChip]}
        onPress={() => openLogsTempCalendar('to')}
        activeOpacity={0.85}
      >
        <View style={styles.filterChipTextWrap}>
          <Text style={styles.filterChipLabel}>End date</Text>
          <Text style={[styles.filterChipValue, styles.filterChipValueActive]} numberOfLines={1}>
            {formatDateLabel(logsReportDateTo)}
          </Text>
        </View>
      </TouchableOpacity>
    </View>
  );

  const renderLogsDateSlider = () => {
    const sliderDates = [];
    const weekDayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = 0; i < 7; i += 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      sliderDates.push(d);
    }

    return (
      <View style={[styles.sliderOuterContainer, styles.logsSliderOuter]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sliderScroll}>
          {sliderDates.map((dateObj, i) => {
            const dateStr = toLocalYmd(dateObj);
            const isSelected =
              logsReportDateFrom === logsReportDateTo && dateStr === logsReportDateFrom;
            const dayName = i === 0 ? 'Today' : weekDayNames[dateObj.getDay()];
            const dayNum = String(dateObj.getDate()).padStart(2, '0');

            return (
              <TouchableOpacity
                key={dateStr}
                style={[
                  styles.sliderCard,
                  styles.logsSliderCard,
                  isSelected && styles.sliderCardActive
                ]}
                onPress={() => {
                  setLogsReportDateFrom(dateStr);
                  setLogsReportDateTo(dateStr);
                }}
              >
                <Text
                  style={[
                    styles.sliderDayName,
                    styles.logsSliderDayName,
                    isSelected && styles.sliderTextActive
                  ]}
                >
                  {dayName}
                </Text>
                <Text
                  style={[
                    styles.sliderDayNum,
                    styles.logsSliderDayNum,
                    isSelected && styles.sliderTextActive
                  ]}
                >
                  {dayNum}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        <TouchableOpacity
          style={[styles.sliderCalendarBtn, styles.logsSliderCalendarBtn]}
          onPress={() => {
            setCalendarContext('logsTemp');
            setCalendarMonth(new Date(`${logsReportDateFrom}T12:00:00`));
            setCalendarPickMode('from');
            setShowCalendarModal(true);
          }}
        >
          <Ionicons name="calendar-outline" size={12} color="#003580" />
          <Text style={[styles.sliderCalendarBtnText, styles.logsSliderCalendarBtnText]}>Range</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderOverviewDateSlider = () => {
    const sliderDates = [];
    const weekDayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = 0; i < 7; i += 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      sliderDates.push(d);
    }

    return (
      <View style={[styles.sliderOuterContainer, styles.overviewSliderWrap, styles.logsSliderOuter]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.sliderScroll}
        >
          {sliderDates.map((dateObj, i) => {
            const dateStr = toLocalYmd(dateObj);
            const isSelected = dateStr === overviewDate;
            const dayName = i === 0 ? 'Today' : weekDayNames[dateObj.getDay()];
            const dayNum = String(dateObj.getDate()).padStart(2, '0');

            return (
              <TouchableOpacity
                key={`ov-${dateStr}`}
                style={[
                  styles.sliderCard,
                  styles.logsSliderCard,
                  isSelected && styles.sliderCardActive
                ]}
                onPress={() => applyOverviewDate(dateStr)}
                activeOpacity={0.85}
              >
                <Text
                  style={[
                    styles.sliderDayName,
                    styles.logsSliderDayName,
                    isSelected && styles.sliderTextActive
                  ]}
                >
                  {dayName}
                </Text>
                <Text
                  style={[
                    styles.sliderDayNum,
                    styles.logsSliderDayNum,
                    isSelected && styles.sliderTextActive
                  ]}
                >
                  {dayNum}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        <TouchableOpacity
          style={[styles.sliderCalendarBtn, styles.logsSliderCalendarBtn]}
          onPress={() => {
            setCalendarContext('overview');
            setCalendarPickMode('from');
            try {
              const [y, m] = String(overviewDate).split('-').map(Number);
              if (y && m) setCalendarMonth(new Date(y, m - 1, 1));
              else setCalendarMonth(new Date(`${overviewDate}T12:00:00`));
            } catch (_) {
              setCalendarMonth(new Date());
            }
            setShowCalendarModal(true);
          }}
          activeOpacity={0.85}
        >
          <Ionicons name="calendar-outline" size={12} color="#003580" />
          <Text style={[styles.sliderCalendarBtnText, styles.logsSliderCalendarBtnText]}>Range</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderLogsReportsView = () => {
    const reportDdBtn = {
      height: 28,
      backgroundColor: '#fff',
      borderRadius: 6,
      borderWidth: 1,
      borderColor: '#e2e8f0',
      paddingHorizontal: 6,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    };
    const reportDdMenu = {
      position: 'absolute',
      top: 30,
      left: 0,
      right: 0,
      backgroundColor: '#fff',
      borderRadius: 6,
      borderWidth: 1,
      borderColor: '#e2e8f0',
      maxHeight: 180,
      zIndex: 220,
      elevation: 8,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.12,
      shadowRadius: 4,
    };

    const renderDdItem = (key, label, selected, onPress) => (
      <TouchableOpacity
        key={key}
        style={{
          paddingVertical: 7,
          paddingHorizontal: 8,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: '#f1f5f9',
        }}
        onPress={onPress}
      >
        <Text style={{ fontSize: 11, color: '#0f172a', fontWeight: selected ? '800' : '500' }} numberOfLines={1}>
          {label}
        </Text>
        {selected ? <Ionicons name="checkmark" size={12} color="#003580" /> : null}
      </TouchableOpacity>
    );

    const chamberLabel =
      logsChamberFilter === 'all' || logsChamberFilter === 'All'
        ? 'All Chambers'
        : chambersList.find((c) => Number(c.id) === Number(logsChamberFilter))?.name || 'All Chambers';
    const clientLabel =
      logsClientFilter === 'All' || logsClientFilter === 'all' ? 'All Clients' : logsClientFilter;
    const typeLabel =
      logsTypeFilter === 'all' || logsTypeFilter === 'All'
        ? 'All Types'
        : chamberZoneStyle(logsTypeFilter).type;

    const isDockMode = logsReportsMode === 'inward' || logsReportsMode === 'outward';

    return (
      <View style={styles.logsWrap}>
        <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 6, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e2e8f0' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 14, fontWeight: '800', color: '#0f172a' }}>Logs</Text>
            <TouchableOpacity onPress={isDockMode ? clearAllFilters : clearLogsReportFilters} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: '#64748b' }}>Clear</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.reportsModeRow}>
            {[
              { id: 'temperature', label: 'Temperature' },
              { id: 'inward', label: 'Inward' },
              { id: 'outward', label: 'Outward' },
            ].map((mode) => (
              <TouchableOpacity
                key={mode.id}
                style={[styles.reportsModeChip, logsReportsMode === mode.id && styles.reportsModeChipActive]}
                onPress={() => {
                  setLogsReportsMode(mode.id);
                  closeLogsReportDropdowns();
                  if (mode.id === 'inward' || mode.id === 'outward') {
                    setWarehouseFilter('All');
                    setClientFilter('All');
                    setLogSearch('');
                    setLogPage(1);
                    const today = toLocalYmd();
                    applyDateRange(today, today);
                  }
                }}
              >
                <Text style={[styles.reportsModeChipText, logsReportsMode === mode.id && styles.reportsModeChipTextActive]}>
                  {mode.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {!isDockMode ? (
          <View style={[styles.reportsContentArea, { overflow: 'visible' }]}>
            <View style={[styles.doFilterPanel, { zIndex: 100, elevation: 5, overflow: 'visible' }]}>
              <View style={[styles.doFilterRow, { overflow: 'visible', marginBottom: 0 }]}>
                <View style={{ flex: 1, position: 'relative', minWidth: 0 }}>
                  <TouchableOpacity
                    style={reportDdBtn}
                    onPress={() => {
                      setShowLogsChamberDropdown(!showLogsChamberDropdown);
                      setShowLogsClientDropdown(false);
                      setShowLogsTypeDropdown(false);
                    }}
                  >
                    <Text style={{ fontSize: 10, color: '#1e293b', fontWeight: '700', flex: 1, marginRight: 4 }} numberOfLines={1}>
                      {chamberLabel}
                    </Text>
                    <Ionicons name={showLogsChamberDropdown ? 'chevron-up' : 'chevron-down'} size={12} color="#64748b" />
                  </TouchableOpacity>
                  {showLogsChamberDropdown ? (
                    <View style={reportDdMenu}>
                      <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
                        {renderDdItem('ch-all', 'All Chambers', logsChamberFilter === 'all' || logsChamberFilter === 'All', () => {
                          setLogsChamberFilter('all');
                          setLogsClientFilter('All');
                          setShowLogsChamberDropdown(false);
                        })}
                        {chambersList.map((ch) =>
                          renderDdItem(`ch-${ch.id}`, ch.name, String(logsChamberFilter) === String(ch.id), () => {
                            setLogsChamberFilter(ch.id);
                            setLogsClientFilter('All');
                            setShowLogsChamberDropdown(false);
                          })
                        )}
                      </ScrollView>
                    </View>
                  ) : null}
                </View>

                <View style={{ flex: 1, position: 'relative', minWidth: 0 }}>
                  <TouchableOpacity
                    style={reportDdBtn}
                    onPress={() => {
                      setShowLogsClientDropdown(!showLogsClientDropdown);
                      setShowLogsChamberDropdown(false);
                      setShowLogsTypeDropdown(false);
                    }}
                  >
                    <Text style={{ fontSize: 10, color: '#1e293b', fontWeight: '700', flex: 1, marginRight: 4 }} numberOfLines={1}>
                      {clientLabel}
                    </Text>
                    <Ionicons name={showLogsClientDropdown ? 'chevron-up' : 'chevron-down'} size={12} color="#64748b" />
                  </TouchableOpacity>
                  {showLogsClientDropdown ? (
                    <View style={reportDdMenu}>
                      <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
                        {renderDdItem('cl-all', 'All Clients', logsClientFilter === 'All' || logsClientFilter === 'all', () => {
                          setLogsClientFilter('All');
                          setShowLogsClientDropdown(false);
                        })}
                        {logsReportClientOptions.map((name) =>
                          renderDdItem(`cl-${name}`, name, logsClientFilter === name, () => {
                            setLogsClientFilter(name);
                            setShowLogsClientDropdown(false);
                          })
                        )}
                      </ScrollView>
                    </View>
                  ) : null}
                </View>

                <View style={{ flex: 1, position: 'relative', minWidth: 0 }}>
                  <TouchableOpacity
                    style={reportDdBtn}
                    onPress={() => {
                      setShowLogsTypeDropdown(!showLogsTypeDropdown);
                      setShowLogsChamberDropdown(false);
                      setShowLogsClientDropdown(false);
                    }}
                  >
                    <Text style={{ fontSize: 10, color: '#1e293b', fontWeight: '700', flex: 1, marginRight: 4 }} numberOfLines={1}>
                      {typeLabel}
                    </Text>
                    <Ionicons name={showLogsTypeDropdown ? 'chevron-up' : 'chevron-down'} size={12} color="#64748b" />
                  </TouchableOpacity>
                  {showLogsTypeDropdown ? (
                    <View style={reportDdMenu}>
                      <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
                        {['all', 'Frozen', 'Chilled', 'Dry', 'Other'].map((zone) =>
                          renderDdItem(
                            `ty-${zone}`,
                            zone === 'all' ? 'All Types' : chamberZoneStyle(zone).type,
                            String(logsTypeFilter) === String(zone),
                            () => {
                              setLogsTypeFilter(zone);
                              setShowLogsTypeDropdown(false);
                            }
                          )
                        )}
                      </ScrollView>
                    </View>
                  ) : null}
                </View>
              </View>
            </View>

            {logsReportsMode === 'temperature' ? renderLogsTempDateRange() : null}

            {logsReportsMode === 'temperature' ? (
              isBlockingListLoad(
                chamberReportsLoading,
                refreshing,
                getFilteredLogsTemperature().length
              ) ? (
                <View style={styles.reportsCenterState}>
                  <ActivityIndicator size="large" color="#003580" />
                  <Text style={styles.reportsStateText}>Loading temperature logs…</Text>
                </View>
              ) : chamberReportsError && getFilteredLogsTemperature().length === 0 ? (
                <View style={styles.reportsCenterState}>
                  <Ionicons name="cloud-offline-outline" size={28} color="#dc2626" />
                  <Text style={styles.reportsStateText}>{chamberReportsError}</Text>
                  <TouchableOpacity style={styles.reportsRetryBtn} onPress={loadChamberReportLogs}>
                    <Text style={styles.reportsRetryText}>Retry</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={{ flex: 1 }}>
                  {(() => {
                    const allTempLogs = getFilteredLogsTemperature();
                    const paged = paginateList(allTempLogs, logsTempListPage, LIST_PAGE_SIZE);
                    return (
                  <FlatList
                    data={paged.items}
                    keyExtractor={(item, idx) =>
                      `${item.server_log_id || item.id || 'log'}-${item.entry_date || 'd'}-${idx}`
                    }
                    renderItem={({ item }) => (
                      <ChamberTempLogCard
                        item={item}
                        onPress={() => setSelectedLog({ ...item, _logType: 'chambers' })}
                      />
                    )}
                    contentContainerStyle={styles.reportsListBody}
                    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
                    ListFooterComponent={
                      <ListPageFooter
                        page={paged.page}
                        pageSize={LIST_PAGE_SIZE}
                        total={paged.total}
                        onPrev={() => setLogsTempListPage((p) => Math.max(1, p - 1))}
                        onNext={() =>
                          setLogsTempListPage((p) => Math.min(paged.totalPages, p + 1))
                        }
                      />
                    }
                    ListEmptyComponent={
                      <View style={styles.reportsCenterState}>
                        <Ionicons name="thermometer-outline" size={28} color="#94a3b8" />
                        <Text style={styles.reportsStateText}>
                          No temperature logs for selected filters.
                        </Text>
                      </View>
                    }
                    {...FLATLIST_PERF_PROPS}
                  />
                    );
                  })()}
                  <ListLoadingOverlay
                    visible={isSoftListLoad(
                      chamberReportsLoading,
                      refreshing,
                      getFilteredLogsTemperature().length
                    )}
                    label="Updating logs…"
                  />
                </View>
              )
            ) : null}
          </View>
        ) : (
          <>
            <View style={styles.filtersCard}>
              <View style={styles.filterChipRow}>
                {renderFilterDropdown('warehouse', 'Warehouse', warehouseOptions, warehouseFilter)}
                {warehouseFilterSelected
                  ? renderFilterDropdown('client', 'Client', clientOptions, clientFilter)
                  : null}
              </View>
              <View style={styles.dockReportFilterBar}>
                <View style={styles.dockReportSearchRow}>
                  <Ionicons name="search-outline" size={14} color="#64748b" />
                  <TextInput
                    style={styles.dockReportSearchInput}
                    placeholder="Search vehicle, client, ref…"
                    placeholderTextColor="#94a3b8"
                    value={logSearch}
                    onChangeText={setLogSearch}
                    onSubmitEditing={applyDockLogFilters}
                    returnKeyType="search"
                  />
                </View>
                <View style={styles.dockReportDateRow}>
                  <TouchableOpacity
                    style={[
                      styles.filterChip,
                      dateFrom !== 'All' && styles.filterChipActive,
                      { flex: 1 },
                    ]}
                    onPress={() => openCalendar('from')}
                    activeOpacity={0.85}
                  >
                    <View style={styles.filterChipTextWrap}>
                      <Text style={styles.filterChipLabel}>From</Text>
                      <Text
                        style={[
                          styles.filterChipValue,
                          dateFrom !== 'All' && styles.filterChipValueActive,
                        ]}
                        numberOfLines={1}
                      >
                        {dateFrom === 'All' ? 'All' : formatDateLabel(dateFrom)}
                      </Text>
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.filterChip,
                      dateTo !== 'All' && styles.filterChipActive,
                      { flex: 1 },
                    ]}
                    onPress={() => openCalendar('to')}
                    activeOpacity={0.85}
                  >
                    <View style={styles.filterChipTextWrap}>
                      <Text style={styles.filterChipLabel}>To</Text>
                      <Text
                        style={[
                          styles.filterChipValue,
                          dateTo !== 'All' && styles.filterChipValueActive,
                        ]}
                        numberOfLines={1}
                      >
                        {dateTo === 'All' ? 'All' : formatDateLabel(dateTo)}
                      </Text>
                    </View>
                  </TouchableOpacity>
                </View>
                <View style={styles.dockReportFilterActions}>
                  <TouchableOpacity style={styles.dockReportFilterBtnPrimary} onPress={applyDockLogFilters}>
                    <Text style={styles.dockReportFilterBtnPrimaryText}>Apply</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.dockReportFilterBtnOutline} onPress={clearDockLogFilters}>
                    <Text style={styles.dockReportFilterBtnOutlineText}>Clear</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            <View style={styles.dailyBanner}>
              <Ionicons name="document-text-outline" size={14} color="#003580" />
              <Text style={styles.dailyBannerText}>
                {logsReportsMode === 'inward' ? 'Inward' : 'Outward'} reports · {logTotal} record
                {logTotal === 1 ? '' : 's'} · Your data only
              </Text>
            </View>

            {isBlockingListLoad(logsLoading, refreshing, logs.length) ? (
              <View style={styles.centerState}>
                <ActivityIndicator size="large" color="#003580" />
                <Text style={styles.stateText}>
                  Loading {logsReportsMode === 'inward' ? 'inward' : 'outward'} logs…
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
                  contentContainerStyle={styles.listBodyCompact}
                  refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
                  ListFooterComponent={
                    logTotal > 0 ? (
                      <View style={styles.dockReportPagination}>
                        <TouchableOpacity
                          style={[styles.dockReportPageBtn, logPage <= 1 && styles.dockReportPageBtnDisabled]}
                          disabled={logPage <= 1 || logsLoading}
                          onPress={goLogPrevPage}
                        >
                          <Text style={styles.dockReportPageBtnText}>Previous</Text>
                        </TouchableOpacity>
                        <Text style={styles.dockReportPageMeta}>
                          {(logPage - 1) * DOCK_REPORT_PAGE_SIZE + 1}–
                          {Math.min(logPage * DOCK_REPORT_PAGE_SIZE, logTotal)} of {logTotal}
                        </Text>
                        <TouchableOpacity
                          style={[styles.dockReportPageBtn, !logHasMore && styles.dockReportPageBtnDisabled]}
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
                      <Text style={styles.stateText}>
                        {logSearch || dateFrom !== 'All' || dateTo !== 'All'
                          ? 'No records match your filters.'
                          : 'No records for your assigned clients yet.'}
                      </Text>
                    </View>
                  }
                  {...FLATLIST_PERF_PROPS}
                />
                <ListLoadingOverlay
                  visible={isSoftListLoad(logsLoading, refreshing, logs.length)}
                  label="Loading page…"
                />
              </View>
            )}
          </>
        )}
      </View>
    );
  };

  const renderReportsInventoryView = () => {
    const reportDdBtn = {
      height: 36,
      backgroundColor: '#fff',
      borderRadius: 8,
      borderWidth: 1,
      borderColor: '#e2e8f0',
      paddingHorizontal: 8,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
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
      shadowRadius: 4,
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
          borderBottomColor: '#f1f5f9',
        }}
        onPress={onPress}
      >
        <Text style={{ fontSize: 12, color: '#0f172a', fontWeight: selected ? '800' : '500' }} numberOfLines={1}>
          {label}
        </Text>
        {selected ? <Ionicons name="checkmark" size={14} color="#003580" /> : null}
      </TouchableOpacity>
    );

    const chamberLabel =
      logsChamberFilter === 'all' || logsChamberFilter === 'All'
        ? 'All Chambers'
        : chambersList.find((c) => Number(c.id) === Number(logsChamberFilter))?.name || 'All Chambers';
    const clientLabel =
      logsClientFilter === 'All' || logsClientFilter === 'all' ? 'All Clients' : logsClientFilter;
    const typeLabel =
      logsTypeFilter === 'all' || logsTypeFilter === 'All'
        ? 'All Types'
        : chamberZoneStyle(logsTypeFilter).type;

    return (
      <View style={styles.logsWrap}>
        <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e2e8f0' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: '#0f172a' }}>Reports</Text>
            <TouchableOpacity onPress={clearLogsReportFilters} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: '#64748b' }}>Clear</Text>
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
                    setShowLogsChamberDropdown(!showLogsChamberDropdown);
                    setShowLogsClientDropdown(false);
                    setShowLogsTypeDropdown(false);
                  }}
                >
                  <Text style={{ fontSize: 11, color: '#1e293b', fontWeight: '700', flex: 1, marginRight: 4 }} numberOfLines={1}>
                    {chamberLabel}
                  </Text>
                  <Ionicons name={showLogsChamberDropdown ? 'chevron-up' : 'chevron-down'} size={14} color="#64748b" />
                </TouchableOpacity>
                {showLogsChamberDropdown ? (
                  <View style={reportDdMenu}>
                    <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {renderDdItem('ch-all', 'All Chambers', logsChamberFilter === 'all' || logsChamberFilter === 'All', () => {
                        setLogsChamberFilter('all');
                        setLogsClientFilter('All');
                        setShowLogsChamberDropdown(false);
                      })}
                      {chambersList.map((ch) =>
                        renderDdItem(`ch-${ch.id}`, ch.name, String(logsChamberFilter) === String(ch.id), () => {
                          setLogsChamberFilter(ch.id);
                          setLogsClientFilter('All');
                          setShowLogsChamberDropdown(false);
                        })
                      )}
                    </ScrollView>
                  </View>
                ) : null}
              </View>

              <View style={{ flex: 1, position: 'relative', minWidth: 0 }}>
                <TouchableOpacity
                  style={reportDdBtn}
                  onPress={() => {
                    setShowLogsClientDropdown(!showLogsClientDropdown);
                    setShowLogsChamberDropdown(false);
                    setShowLogsTypeDropdown(false);
                  }}
                >
                  <Text style={{ fontSize: 11, color: '#1e293b', fontWeight: '700', flex: 1, marginRight: 4 }} numberOfLines={1}>
                    {clientLabel}
                  </Text>
                  <Ionicons name={showLogsClientDropdown ? 'chevron-up' : 'chevron-down'} size={14} color="#64748b" />
                </TouchableOpacity>
                {showLogsClientDropdown ? (
                  <View style={reportDdMenu}>
                    <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {renderDdItem('cl-all', 'All Clients', logsClientFilter === 'All' || logsClientFilter === 'all', () => {
                        setLogsClientFilter('All');
                        setShowLogsClientDropdown(false);
                      })}
                      {logsReportClientOptions.map((name) =>
                        renderDdItem(`cl-${name}`, name, logsClientFilter === name, () => {
                          setLogsClientFilter(name);
                          setShowLogsClientDropdown(false);
                        })
                      )}
                    </ScrollView>
                  </View>
                ) : null}
              </View>

              <View style={{ flex: 1, position: 'relative', minWidth: 0 }}>
                <TouchableOpacity
                  style={reportDdBtn}
                  onPress={() => {
                    setShowLogsTypeDropdown(!showLogsTypeDropdown);
                    setShowLogsChamberDropdown(false);
                    setShowLogsClientDropdown(false);
                  }}
                >
                  <Text style={{ fontSize: 11, color: '#1e293b', fontWeight: '700', flex: 1, marginRight: 4 }} numberOfLines={1}>
                    {typeLabel}
                  </Text>
                  <Ionicons name={showLogsTypeDropdown ? 'chevron-up' : 'chevron-down'} size={14} color="#64748b" />
                </TouchableOpacity>
                {showLogsTypeDropdown ? (
                  <View style={reportDdMenu}>
                    <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {['all', 'Frozen', 'Chilled', 'Dry', 'Other'].map((zone) =>
                        renderDdItem(
                          `ty-${zone}`,
                          zone === 'all' ? 'All Types' : chamberZoneStyle(zone).type,
                          String(logsTypeFilter) === String(zone),
                          () => {
                            setLogsTypeFilter(zone);
                            setShowLogsTypeDropdown(false);
                          }
                        )
                      )}
                    </ScrollView>
                  </View>
                ) : null}
              </View>
            </View>
          </View>

          <View style={styles.dailyBanner}>
            <Ionicons name="cube-outline" size={14} color="#003580" />
            <Text style={styles.dailyBannerText}>
              Inventory · {logsInventorySummary.lots} lot{logsInventorySummary.lots === 1 ? '' : 's'}
              {` · ${logsInventorySummary.totalBoxes} boxes`}
            </Text>
          </View>

          {isBlockingListLoad(reportsLoading, reportsRefreshing, filteredLogsInventoryRows.length) ? (
            <View style={styles.reportsCenterState}>
              <ActivityIndicator size="large" color="#003580" />
              <Text style={styles.reportsStateText}>Loading inventory…</Text>
            </View>
          ) : reportsError && filteredLogsInventoryRows.length === 0 ? (
            <InlineErrorState message={reportsError} onRetry={loadReports} icon="warning-outline" />
          ) : (
            <View style={{ flex: 1 }}>
              <FlatList
                data={filteredLogsInventoryRows}
                keyExtractor={(item, idx) =>
                  `${item.client_name || 'c'}-${item.warehouse_name || 'w'}-${item.chamber_name || 'ch'}-${idx}`
                }
                renderItem={renderLogsInventoryItem}
                contentContainerStyle={styles.reportsListBody}
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
                refreshControl={<RefreshControl refreshing={reportsRefreshing} onRefresh={onRefresh} />}
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
                  filteredLogsInventoryRows.length
                )}
                label="Updating inventory…"
              />
            </View>
          )}
        </View>
      </View>
    );
  };

  const renderLogItem = ({ item }) => {
    if (item._logType === 'inward' || item._logType === 'outward') {
      return (
        <DockMovementLogCard
          item={item}
          mode={item._logType}
          onPress={() => setSelectedLog(item)}
        />
      );
    }

    return (
      <ChamberTempLogCard
        item={item}
        onPress={() => setSelectedLog(item)}
      />
    );
  };

  const renderDoDetailRow = (label, value) => {
    if (value == null || value === '') return null;
    return (
      <View style={styles.doLogDetailRow} key={label}>
        <Text style={styles.doLogDetailLabel}>{label}</Text>
        <Text style={styles.doLogDetailValue}>{String(value)}</Text>
      </View>
    );
  };

  const renderLogDetailScreen = () => {
    if (!selectedLog) return null;
    const item = selectedLog;
    const logTypeKey = item._logType || 'chambers';

    if (logTypeKey === 'inward') {
      const shortQty = parseInt(item.inward_short_received_boxes_qty, 10) || 0;
      const excessQty = parseInt(item.inward_excess_received_boxes_qty, 10) || 0;
      const damageQty = parseInt(item.inward_damage_received_boxes_qty, 10) || 0;
      const recordWarehouse = item.warehouse_name || '—';
      const recordOperator = item.operator_email || '—';
      const operatorLabel = recordOperator.includes('@') ? recordOperator.split('@')[0] : recordOperator;
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
            ['Client', item.inward_client_name || item.client_name],
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
      const photoItems = buildInwardOutwardPhotoItems({ ...item, _logType: 'inward' });
      const heroTempRaw =
        item.inward_material_temp != null
          ? item.inward_material_temp
          : item.inward_vehicle_temp;
      const heroCompliance = getTempComplianceHeroMeta(
        heroTempRaw,
        item.inward_material_type || item.chamber_type || item.inward_chamber_type
      );
      const heroAlert = '#EF4444';

      return (
        <Modal visible animationType="slide" onRequestClose={() => setSelectedLog(null)}>
          <SafeAreaView style={styles.doDetailSafe}>
            <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
            <View style={styles.doDetailHeader}>
              <TouchableOpacity style={styles.doDetailBackBtn} onPress={() => setSelectedLog(null)} activeOpacity={0.85}>
                <Ionicons name="arrow-back" size={22} color="#0f172a" />
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={styles.doDetailTitle} numberOfLines={1}>Inward details</Text>
                <Text style={styles.doDetailSub} numberOfLines={2}>
                  {item.reference_no || `INW-${item.inward_id}`} · {item.inward_client_name || item.client_name || 'Client'}
                  {'\n'}
                  {recordWarehouse} · {operatorLabel}
                </Text>
              </View>
            </View>
            <ScrollView contentContainerStyle={styles.doDetailBody} showsVerticalScrollIndicator={false}>
              <View style={styles.doDetailHeroCard}>
                <Text
                  style={[
                    styles.doDetailHeroTemp,
                    heroCompliance.outOfRange && { color: heroAlert }
                  ]}
                >
                  {heroCompliance.tempText}
                </Text>
                {heroCompliance.statusLine ? (
                  <Text style={[styles.doDetailHeroDelta, { color: heroAlert }]}>
                    {heroCompliance.statusLine}
                  </Text>
                ) : heroCompliance.typeLine ? (
                  <Text style={styles.doDetailHeroMeta}>{heroCompliance.typeLine}</Text>
                ) : null}
                <Text style={styles.doDetailHeroMeta}>
                  {recordWarehouse}
                  {item.inward_entry_date ? ` · ${item.inward_entry_date}` : ''}
                  {' · Material temp'}
                </Text>
              </View>
              {sections.map((section) => (
                <View style={styles.doDetailCard} key={section.title}>
                  <Text style={styles.doDetailSectionTitle}>{section.title}</Text>
                  {section.rows.map(([label, value]) => renderDoDetailRow(label, value))}
                </View>
              ))}
              {photoItems.length > 0 ? (
                <View style={styles.doDetailCard}>
                  <Text style={styles.doDetailSectionTitle}>Photos</Text>
                  <PhotoGridWithLocation
                    photoItems={photoItems}
                    folderHint="inward_images"
                    photoMeta={item.photo_capture_metadata}
                    resolveUri={resolveDockPhotoUri}
                  />
                </View>
              ) : null}
            </ScrollView>
          </SafeAreaView>
        </Modal>
      );
    }

    if (logTypeKey === 'outward') {
      const shortQty = parseInt(item.outward_short_received_boxes_qty, 10) || 0;
      const excessQty = parseInt(item.outward_excess_received_boxes_qty, 10) || 0;
      const damageQty = parseInt(item.outward_damage_received_boxes_qty, 10) || 0;
      const preVehicleTemp = item.outward_pre_vehicle_temp ?? item.outward_vehicle_temp;
      const recordWarehouse = item.warehouse_name || '—';
      const recordOperator = item.operator_email || '—';
      const operatorLabel = recordOperator.includes('@') ? recordOperator.split('@')[0] : recordOperator;
      const sections = [
        {
          title: 'Location & Operator',
          rows: [
            ['Warehouse', recordWarehouse],
            ['Operator', recordOperator],
          ],
        },
        {
          title: 'Dispatch',
          rows: [
            ['Reference', item.reference_no || `OUT-${item.outward_id}`],
            ['Entry date', item.outward_entry_date],
            ['Client', item.outward_client_name || item.client_name],
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
      const photoItems = buildInwardOutwardPhotoItems({ ...item, _logType: 'outward' });
      const heroTempRaw =
        item.outward_material_temp != null
          ? item.outward_material_temp
          : preVehicleTemp;
      const heroCompliance = getTempComplianceHeroMeta(
        heroTempRaw,
        item.outward_material_type || item.chamber_type || item.outward_chamber_type
      );
      const heroAlert = '#EF4444';

      return (
        <Modal visible animationType="slide" onRequestClose={() => setSelectedLog(null)}>
          <SafeAreaView style={styles.doDetailSafe}>
            <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
            <View style={styles.doDetailHeader}>
              <TouchableOpacity style={styles.doDetailBackBtn} onPress={() => setSelectedLog(null)} activeOpacity={0.85}>
                <Ionicons name="arrow-back" size={22} color="#0f172a" />
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={styles.doDetailTitle} numberOfLines={1}>Outward details</Text>
                <Text style={styles.doDetailSub} numberOfLines={2}>
                  {item.reference_no || `OUT-${item.outward_id}`} · {item.outward_client_name || item.client_name || 'Client'}
                  {'\n'}
                  {recordWarehouse} · {operatorLabel}
                </Text>
              </View>
            </View>
            <ScrollView contentContainerStyle={styles.doDetailBody} showsVerticalScrollIndicator={false}>
              <View style={styles.doDetailHeroCard}>
                <Text
                  style={[
                    styles.doDetailHeroTemp,
                    heroCompliance.outOfRange && { color: heroAlert }
                  ]}
                >
                  {heroCompliance.tempText}
                </Text>
                {heroCompliance.statusLine ? (
                  <Text style={[styles.doDetailHeroDelta, { color: heroAlert }]}>
                    {heroCompliance.statusLine}
                  </Text>
                ) : heroCompliance.typeLine ? (
                  <Text style={styles.doDetailHeroMeta}>{heroCompliance.typeLine}</Text>
                ) : null}
                <Text style={styles.doDetailHeroMeta}>
                  {recordWarehouse}
                  {item.outward_entry_date ? ` · ${item.outward_entry_date}` : ''}
                  {' · Material temp'}
                </Text>
              </View>
              {sections.map((section) => (
                <View style={styles.doDetailCard} key={section.title}>
                  <Text style={styles.doDetailSectionTitle}>{section.title}</Text>
                  {section.rows.map(([label, value]) => renderDoDetailRow(label, value))}
                </View>
              ))}
              {photoItems.length > 0 ? (
                <View style={styles.doDetailCard}>
                  <Text style={styles.doDetailSectionTitle}>Photos</Text>
                  <PhotoGridWithLocation
                    photoItems={photoItems}
                    folderHint="outward_images"
                    photoMeta={item.photo_capture_metadata}
                    resolveUri={resolveDockPhotoUri}
                  />
                </View>
              ) : null}
            </ScrollView>
          </SafeAreaView>
        </Modal>
      );
    }

    const imagePath = pickLogImage(item);
    const tempNum =
      item.box_temp != null
        ? Number(item.box_temp)
        : item.chamber_temp != null
          ? Number(item.chamber_temp)
          : null;
    const heroCompliance = getTempComplianceHeroMeta(tempNum, item.chamber_type);
    const heroAlert = '#EF4444';
    const typeLabel = heroCompliance.typeLine || heroCompliance.type;
    const range = heroCompliance.range || getChamberTempRange(heroCompliance.type);
    const outOfRange = heroCompliance.outOfRange;
    const alertColor = '#dc2626';

    return (
      <Modal visible animationType="slide" onRequestClose={() => setSelectedLog(null)}>
        <SafeAreaView style={styles.doDetailSafe}>
          <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
          <View style={styles.doDetailHeader}>
            <TouchableOpacity style={styles.doDetailBackBtn} onPress={() => setSelectedLog(null)} activeOpacity={0.85}>
              <Ionicons name="arrow-back" size={22} color="#0f172a" />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={styles.doDetailTitle} numberOfLines={1}>Chamber log</Text>
              <Text style={styles.doDetailSub} numberOfLines={1}>
                {item.chamber_name || 'Chamber'} · {item.client_name || 'Client'}
              </Text>
            </View>
          </View>
          <ScrollView contentContainerStyle={styles.doDetailBody} showsVerticalScrollIndicator={false}>
            <View style={styles.doDetailHeroCard}>
              <Text
                style={[
                  styles.doDetailHeroTemp,
                  outOfRange && { color: heroAlert }
                ]}
              >
                {heroCompliance.tempText}
              </Text>
              {heroCompliance.statusLine ? (
                <Text style={[styles.doDetailHeroDelta, { color: heroAlert }]}>
                  {heroCompliance.statusLine}
                </Text>
              ) : typeLabel ? (
                <Text style={styles.doDetailHeroMeta}>{typeLabel}</Text>
              ) : (
                <Text style={styles.doDetailHeroMeta}>Chamber type —</Text>
              )}
              <Text style={styles.doDetailHeroMeta}>
                {item.box_count != null && item.box_count !== ''
                  ? `${item.box_count} boxes`
                  : 'Box qty —'}
                {item.shift ? ` · ${item.shift}` : ''}
              </Text>
            </View>
            <View style={styles.doDetailCard}>
              {renderDoDetailRow('Warehouse', item.warehouse_name)}
              {renderDoDetailRow('Chamber type', typeLabel || item.chamber_type)}
              {renderDoDetailRow('Shift', item.shift)}
              {renderDoDetailRow('Inspection time', item.inspection_time)}
              {renderDoDetailRow('Date', item.formatted_date || item.entry_date)}
              {renderDoDetailRow('Supervisor', item.monitor_supervisor_name)}
              {renderDoDetailRow('Operator', item.operator_email)}
              {renderDoDetailRow('Reference', item.reference_no)}
              {renderDoDetailRow(
                'Time variance',
                item.time_variance_minutes != null ? `${item.time_variance_minutes} min` : null
              )}
              {renderDoDetailRow('Remarks', item.remarks)}
              {renderDoDetailRow(
                'Updates',
                item.update_count != null && Number(item.update_count) > 0 ? String(item.update_count) : null
              )}
              {renderDoDetailRow('Update details', item.update_details)}
            </View>
            <View style={styles.doDetailCard}>
              <Text style={styles.doDetailSectionTitle}>Sensor photo</Text>
              <SensorPhotoView rawPath={imagePath} apiUrl={apiUrl} folderHint="daily_temp_monitor_images" />
              <GpsDetailRow
                label="Photo location (GPS)"
                lat={item.photo_capture_latitude}
                lng={item.photo_capture_longitude}
                accuracy={item.photo_capture_accuracy}
              />
              {item.photo_capture_time
                ? renderDoDetailRow('Photo capture time', item.photo_capture_time)
                : null}
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    );
  };

  const renderInventoryDetailModal = () => {
    const readingTotal = latestReadingQty(reportHistory);
    const totalBoxes =
      readingTotal != null ? readingTotal : getLotTotalBoxes(selectedReport);
    const outOfStock = !!selectedReport && totalBoxes === 0;
    return (
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

          <View style={[styles.totalBoxesBanner, outOfStock && styles.totalBoxesBannerEmpty]}>
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
                (() => {
                  const pagedHist = paginateList(reportHistory, reportHistoryPage, LIST_PAGE_SIZE);
                  return (
                <>
                {pagedHist.items.map((row, idx) => {
                  const dateLabel =
                    String(row.formatted_date || row.entry_date || '').slice(0, 10) || '—';
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
                      <Text
                        style={[styles.excelCell, styles.excelColQty, styles.excelQty]}
                        numberOfLines={1}
                      >
                        {qty == null ? '—' : qty}
                      </Text>
                    </View>
                  );
                })}
                <ListPageFooter
                  page={pagedHist.page}
                  pageSize={LIST_PAGE_SIZE}
                  total={pagedHist.total}
                  onPrev={() => setReportHistoryPage((p) => Math.max(1, p - 1))}
                  onNext={() => setReportHistoryPage((p) => Math.min(pagedHist.totalPages, p + 1))}
                />
                </>
                  );
                })()
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
  };

  const applyCalendarRange = (from, to) => {
    if (calendarContext === 'logsTemp') {
      setLogsReportDateFrom(from);
      setLogsReportDateTo(to);
      setLogsTempListPage(1);
    } else if (calendarContext === 'overviewInOut') {
      applyOverviewInOutRange(from, to);
    } else if (calendarContext === 'overviewTask') {
      applyOverviewTempRange(from, to);
    } else if (calendarContext === 'overview') {
      applyOverviewDate(from || to);
    } else {
      applyDateRange(from, to);
    }
  };

  const isOverviewCalendar = calendarContext === 'overview';
  const isOverviewInOutCalendar = calendarContext === 'overviewInOut';
  const isOverviewTaskCalendar = calendarContext === 'overviewTask';
  const isRangeCalendar = !isOverviewCalendar;

  const calendarRangeFrom =
    calendarContext === 'logsTemp'
      ? logsReportDateFrom
      : isOverviewInOutCalendar
        ? overviewInOutDateFrom
        : isOverviewTaskCalendar
          ? overviewTempDateFrom
          : isOverviewCalendar
            ? overviewDate
            : dateFrom === 'All'
              ? null
              : dateFrom;
  const calendarRangeTo =
    calendarContext === 'logsTemp'
      ? logsReportDateTo
      : isOverviewInOutCalendar
        ? overviewInOutDateTo
        : isOverviewTaskCalendar
          ? overviewTempDateTo
          : isOverviewCalendar
            ? overviewDate
            : dateTo === 'All'
              ? null
              : dateTo;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <View style={styles.header}>
        <View style={styles.welcomeBlock}>
          <Text style={styles.welcomeLine}>Welcome</Text>
          <Text style={styles.welcomeName} numberOfLines={1}>
            {displayName}
          </Text>
        </View>
        <Image
          source={require('../../assets/logo-transparent.png')}
          style={styles.headerLogo}
          resizeMode="contain"
        />
      </View>

      <View style={styles.contentArea}>
        {activeTab === 'Logs' ? renderLogsReportsView() : activeTab === 'Reports' ? renderReportsInventoryView() : (
          <ScrollView
            contentContainerStyle={[
              styles.body,
              activeTab === 'More' && styles.moreBody
            ]}
            showsVerticalScrollIndicator={false}
            refreshControl={
              activeTab === 'Dashboard' ? (
                <RefreshControl refreshing={homeRefreshing} onRefresh={onHomeRefresh} />
              ) : undefined
            }
          >
            {activeTab === 'Dashboard' && (
              <>
                <ImageBackground
                  source={require('../../assets/warehouse_bg.jpg')}
                  style={styles.homeHero}
                  resizeMode="cover"
                >
                  <View style={styles.homeHeroOverlay}>
                    <Text style={styles.homeHeroTitle}>Stay informed. Stay in control.</Text>
                    <Text style={styles.homeHeroSubtitle}>
                      Fast overview of temperature, inward and outward activity.
                    </Text>
                  </View>
                </ImageBackground>

                {overviewError && !overviewLoading ? (
                  <InlineErrorState message={overviewError} onRetry={() => loadOverview()} />
                ) : null}

                <>
                    <View style={styles.overviewSectionTabs}>
                      {[
                        { id: 'temperature', label: 'Temperature' },
                        { id: 'inout', label: 'In & Out' }
                      ].map((tab) => {
                        const active = overviewHomeSection === tab.id;
                        return (
                          <TouchableOpacity
                            key={tab.id}
                            style={[
                              styles.overviewSectionTab,
                              active && styles.overviewSectionTabActive
                            ]}
                            onPress={() => setOverviewHomeSection(tab.id)}
                            activeOpacity={0.85}
                          >
                            <Text
                              style={[
                                styles.overviewSectionTabText,
                                active && styles.overviewSectionTabTextActive
                              ]}
                            >
                              {tab.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    <View style={styles.overviewDateRow}>
                      <TouchableOpacity
                        style={[
                          styles.filterChip,
                          styles.overviewWarehouseChip,
                          overviewWarehouse !== 'All' && styles.filterChipActive
                        ]}
                        onPress={() =>
                          setOpenFilter((prev) =>
                            prev === 'overviewWarehouse' ? null : 'overviewWarehouse'
                          )
                        }
                        activeOpacity={0.85}
                      >
                        <Ionicons
                          name="business-outline"
                          size={12}
                          color={overviewWarehouse !== 'All' ? '#003580' : '#64748b'}
                        />
                        <View style={styles.filterChipTextWrap}>
                          <Text style={styles.filterChipLabel}>Warehouse</Text>
                          <Text
                            style={[
                              styles.filterChipValue,
                              overviewWarehouse !== 'All' && styles.filterChipValueActive
                            ]}
                            numberOfLines={1}
                          >
                            {overviewWarehouse === 'All' ? 'All' : overviewWarehouse}
                          </Text>
                        </View>
                        <Ionicons
                          name="chevron-down"
                          size={12}
                          color={overviewWarehouse !== 'All' ? '#003580' : '#94a3b8'}
                        />
                      </TouchableOpacity>
                    </View>

                    {overviewHomeSection === 'temperature' ? (
                    overviewLoading && !homeRefreshing ? (
                      <View style={styles.centerState}>
                        <ActivityIndicator size="large" color="#003580" />
                        <Text style={styles.stateText}>Loading Daily Temp Task…</Text>
                      </View>
                    ) : (
                    <View style={styles.card}>
                      <Text style={styles.cardTitle}>Daily Temp Task</Text>
                      <Text style={styles.cardHint}>
                        Filter by dates · status donut · task lists
                      </Text>

                      <View style={[styles.inoutDateRow, { marginTop: 10 }]}>
                        <TouchableOpacity
                          style={[styles.filterChip, styles.inoutDateChip]}
                          onPress={() => openOverviewTempCalendar('from')}
                          activeOpacity={0.85}
                        >
                          <View style={styles.filterChipTextWrap}>
                            <Text style={styles.filterChipLabel}>Start date</Text>
                            <Text style={[styles.filterChipValue, styles.filterChipValueActive]} numberOfLines={1}>
                              {formatDateLabel(overviewTempDateFrom)}
                            </Text>
                          </View>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.filterChip, styles.inoutDateChip]}
                          onPress={() => openOverviewTempCalendar('to')}
                          activeOpacity={0.85}
                        >
                          <View style={styles.filterChipTextWrap}>
                            <Text style={styles.filterChipLabel}>End date</Text>
                            <Text style={[styles.filterChipValue, styles.filterChipValueActive]} numberOfLines={1}>
                              {formatDateLabel(overviewTempDateTo)}
                            </Text>
                          </View>
                        </TouchableOpacity>
                      </View>

                      <View style={{ flexDirection: 'row', gap: 6, marginTop: 10 }}>
                        {['Morning', 'Evening'].map((shift) => {
                          const active = overviewTempShift === shift;
                          return (
                            <TouchableOpacity
                              key={shift}
                              onPress={() => {
                                setOverviewTempShift(shift);
                                setOverviewTempListPage(1);
                              }}
                              activeOpacity={0.85}
                              style={[
                                styles.overviewShiftChip,
                                { flex: 1, justifyContent: 'center' },
                                active && styles.overviewShiftChipActive
                              ]}
                            >
                              <Ionicons
                                name={shift === 'Morning' ? 'sunny-outline' : 'moon-outline'}
                                size={12}
                                color={active ? '#ffffff' : '#003580'}
                              />
                              <Text
                                style={[
                                  styles.overviewShiftChipText,
                                  active && styles.overviewShiftChipTextActive
                                ]}
                                numberOfLines={1}
                              >
                                {shift}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>

                      {(() => {
                        const shiftTasks = overviewTempTasks.filter(
                          (t) => t.shift === overviewTempShift
                        );
                        const completed = shiftTasks.filter((t) => t.status === 'completed').length;
                        const bad = shiftTasks.filter((t) => t.status === 'bad').length;
                        const pending = shiftTasks.filter((t) => t.status === 'pending').length;
                        const list = shiftTasks.filter((t) => t.status === overviewTempListFilter);
                        const paged = paginateList(list, overviewTempListPage, LIST_PAGE_SIZE);
                        const page = paged.page;
                        const totalPages = paged.totalPages;
                        const pageStart = (page - 1) * LIST_PAGE_SIZE;
                        const pageList = paged.items;
                        const filterMeta = {
                          completed: { label: 'Completed', color: TEMP_TASK_COMPLETED, bg: '#ccfbf1' },
                          bad: { label: 'Bad reading', color: TEMP_TASK_BAD, bg: '#ffedd5' },
                          pending: { label: 'Pending', color: TEMP_TASK_PENDING, bg: '#fef9c3' }
                        };
                        const activeMeta = filterMeta[overviewTempListFilter] || filterMeta.completed;
                        return (
                          <>
                            <Text style={{ fontSize: 13, fontWeight: '800', color: '#0f172a', marginTop: 12, marginBottom: 6 }}>
                              Task status
                            </Text>
                            <TempTaskStatusDonut completed={completed} bad={bad} pending={pending} />

                            <View style={{ flexDirection: 'row', gap: 6, marginTop: 14, marginBottom: 12 }}>
                              {[
                                { id: 'completed', label: 'Completed', count: completed },
                                { id: 'bad', label: 'Bad reading', count: bad },
                                { id: 'pending', label: 'Pending', count: pending }
                              ].map((btn) => {
                                const active = overviewTempListFilter === btn.id;
                                const meta = filterMeta[btn.id];
                                return (
                                  <TouchableOpacity
                                    key={btn.id}
                                    onPress={() => {
                                      setOverviewTempListFilter(btn.id);
                                      setOverviewTempListPage(1);
                                    }}
                                    activeOpacity={0.85}
                                    style={{
                                      flex: 1,
                                      paddingVertical: 8,
                                      paddingHorizontal: 4,
                                      borderRadius: 8,
                                      borderWidth: 1,
                                      borderColor: active ? meta.color : '#e2e8f0',
                                      backgroundColor: active ? meta.bg : '#ffffff',
                                      alignItems: 'center'
                                    }}
                                  >
                                    <Text
                                      style={{
                                        fontSize: 10,
                                        fontWeight: '800',
                                        color: active ? meta.color : '#64748b',
                                        textAlign: 'center'
                                      }}
                                      numberOfLines={1}
                                    >
                                      {btn.label}
                                    </Text>
                                    <Text
                                      style={{
                                        fontSize: 11,
                                        fontWeight: '900',
                                        color: active ? meta.color : '#94a3b8',
                                        marginTop: 2
                                      }}
                                    >
                                      {btn.count}
                                    </Text>
                                  </TouchableOpacity>
                                );
                              })}
                            </View>

                            <Text style={{ fontSize: 13, fontWeight: '800', color: '#0f172a', marginBottom: 8 }}>
                              {activeMeta.label} · {overviewTempShift}
                            </Text>
                            {!list.length ? (
                              <Text style={{ fontSize: 12, color: '#94a3b8' }}>
                                No {activeMeta.label.toLowerCase()} tasks in this range.
                              </Text>
                            ) : (
                              <>
                              {pageList.map((row) => {
                                const zone =
                                  pickComplianceZone(row.chamberType) ||
                                  normalizeChamberZone(row.chamberType) ||
                                  null;
                                const zs = zone ? chamberZoneStyle(zone) : null;
                                const tempNum =
                                  row.temp != null && Number.isFinite(Number(row.temp))
                                    ? Number(row.temp)
                                    : null;
                                const tempStr =
                                  tempNum != null
                                    ? `${tempNum % 1 === 0 ? tempNum : tempNum.toFixed(1)}°C`
                                    : '—';
                                const deviation =
                                  row.deviation ||
                                  (tempNum != null && zone
                                    ? getChamberTempDeviation(tempNum, zone)
                                    : null);
                                const outOfRange = deviation != null;
                                const alertColor = '#dc2626';
                                const tempColor = outOfRange
                                  ? alertColor
                                  : row.status === 'completed'
                                    ? TEMP_TASK_COMPLETED
                                    : row.status === 'pending'
                                      ? TEMP_TASK_PENDING
                                      : '#64748b';
                                const typeColor = outOfRange
                                  ? alertColor
                                  : zs?.color || '#64748b';
                                return (
                                  <View
                                    key={row.key}
                                    style={{
                                      paddingVertical: 10,
                                      borderBottomWidth: 1,
                                      borderBottomColor: '#f1f5f9'
                                    }}
                                  >
                                    <View
                                      style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        gap: 8
                                      }}
                                    >
                                      <Text
                                        style={{ flex: 1, fontSize: 13, fontWeight: '800', color: '#0f172a' }}
                                        numberOfLines={1}
                                      >
                                        {row.client}
                                      </Text>
                                      <View style={{ alignItems: 'flex-end' }}>
                                        <Text
                                          style={{
                                            fontSize: 12,
                                            fontWeight: '900',
                                            color: tempColor
                                          }}
                                        >
                                          {tempStr}
                                        </Text>
                                        {zone ? (
                                          <View
                                            style={{
                                              flexDirection: 'row',
                                              alignItems: 'center',
                                              gap: 2,
                                              marginTop: 2
                                            }}
                                          >
                                            {deviation === 'low' ? (
                                              <Text
                                                style={{
                                                  fontSize: 11,
                                                  fontWeight: '900',
                                                  color: alertColor
                                                }}
                                              >
                                                {'<'}
                                              </Text>
                                            ) : null}
                                            {deviation === 'high' ? (
                                              <Text
                                                style={{
                                                  fontSize: 11,
                                                  fontWeight: '900',
                                                  color: alertColor
                                                }}
                                              >
                                                {'>'}
                                              </Text>
                                            ) : null}
                                            <Text
                                              style={{
                                                fontSize: 10,
                                                fontWeight: outOfRange ? '800' : '700',
                                                color: typeColor
                                              }}
                                              numberOfLines={1}
                                            >
                                              {zone}
                                            </Text>
                                          </View>
                                        ) : null}
                                      </View>
                                    </View>
                                    <View
                                      style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: 6,
                                        marginTop: 4,
                                        flexWrap: 'wrap'
                                      }}
                                    >
                                      <Text style={{ fontSize: 10, fontWeight: '600', color: '#94a3b8' }}>
                                        {formatDateLabel(row.dayKey)}
                                        {row.shift ? ` · ${row.shift}` : ''}
                                        {row.boxCount != null
                                          ? ` · ${row.boxCount} boxes`
                                          : ''}
                                      </Text>
                                    </View>
                                  </View>
                                );
                              })}
                              {list.length > LIST_PAGE_SIZE ? (
                                <ListPageFooter
                                  page={page}
                                  pageSize={LIST_PAGE_SIZE}
                                  total={list.length}
                                  onPrev={() => setOverviewTempListPage((p) => Math.max(1, p - 1))}
                                  onNext={() =>
                                    setOverviewTempListPage((p) => Math.min(totalPages, p + 1))
                                  }
                                  style={{ marginTop: 10 }}
                                />
                              ) : null}
                              </>
                            )}
                          </>
                        );
                      })()}
                    </View>
                    )
                    ) : overviewLoading && !homeRefreshing ? (
                      <View style={styles.centerState}>
                        <ActivityIndicator size="large" color="#003580" />
                        <Text style={styles.stateText}>Loading In & Out…</Text>
                      </View>
                    ) : (
                    <View style={styles.card}>
                      <View style={styles.tempGraphHeader}>
                        <View style={styles.tempGraphHeaderText}>
                          <Text style={styles.cardTitle}>In & Out</Text>
                          <Text style={styles.cardHint}>
                            How many inward vs outward moves in your date range
                          </Text>
                        </View>
                      </View>

                      <View style={styles.inoutDateRow}>
                        <TouchableOpacity
                          style={[styles.filterChip, styles.inoutDateChip]}
                          onPress={() => openOverviewInOutCalendar('from')}
                          activeOpacity={0.85}
                        >
                          <View style={styles.filterChipTextWrap}>
                            <Text style={styles.filterChipLabel}>Start date</Text>
                            <Text style={[styles.filterChipValue, styles.filterChipValueActive]} numberOfLines={1}>
                              {formatDateLabel(overviewInOutDateFrom)}
                            </Text>
                          </View>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.filterChip, styles.inoutDateChip]}
                          onPress={() => openOverviewInOutCalendar('to')}
                          activeOpacity={0.85}
                        >
                          <View style={styles.filterChipTextWrap}>
                            <Text style={styles.filterChipLabel}>End date</Text>
                            <Text style={[styles.filterChipValue, styles.filterChipValueActive]} numberOfLines={1}>
                              {formatDateLabel(overviewInOutDateTo)}
                            </Text>
                          </View>
                        </TouchableOpacity>
                      </View>
                      <InOutDonutChart series={overviewSeries} />

                      <View style={styles.inoutProductGraphBox}>
                        <InOutZoneBoxChart
                          inwardRows={overviewInwardList}
                          outwardRows={overviewOutwardList}
                        />
                      </View>
                    </View>
                    )}
                  </>
              </>
            )}

            {activeTab === 'More' && (
              <>
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Profile</Text>
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
                  <Text style={styles.profileRow}>
                    <Text style={styles.profileKey}>Clients: </Text>
                    <Text style={styles.profileVal}>
                      {allowedClients.length === 0 ? 'Full access' : allowedClients.join(', ')}
                    </Text>
                  </Text>
                  <Text style={styles.profileRow}>
                    <Text style={styles.profileKey}>Warehouses: </Text>
                    <Text style={styles.profileVal}>
                      {allowedWarehouses.length === 0
                        ? 'Full access'
                        : allowedWarehouses.join(', ')}
                    </Text>
                  </Text>
                </View>

                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Send query</Text>
                  <Text style={styles.queryLabel}>Message</Text>
                  <TextInput
                    style={[styles.queryInput, styles.queryMessageInput]}
                    value={queryMessage}
                    onChangeText={setQueryMessage}
                    placeholder="Type your query…"
                    placeholderTextColor="#94a3b8"
                    multiline
                    textAlignVertical="top"
                  />
                  {queryError ? (
                    <Text style={[styles.cardHint, { color: '#dc2626' }]}>{queryError}</Text>
                  ) : null}
                  {querySuccess ? (
                    <Text style={[styles.cardHint, { color: '#16a34a' }]}>{querySuccess}</Text>
                  ) : null}
                  <TouchableOpacity
                    style={[
                      styles.querySendBtn,
                      (!String(queryMessage || '').trim() || querySending) && { opacity: 0.55 }
                    ]}
                    onPress={submitCustomerQuery}
                    disabled={!String(queryMessage || '').trim() || querySending}
                    activeOpacity={0.85}
                  >
                    {querySending ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <Ionicons name="send-outline" size={16} color="#fff" />
                        <Text style={styles.querySendText}>Submit query</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>

                <TouchableOpacity
                  style={[styles.logoutBtn, { alignSelf: 'stretch', justifyContent: 'center' }]}
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

                <View style={styles.moreSpacer} />

                <View style={styles.aboutFooter}>
                  <View style={styles.aboutLogoWrap}>
                    <Image
                      source={require('../../assets/logo-transparent.png')}
                      style={styles.aboutLogo}
                      resizeMode="contain"
                    />
                  </View>
                  <Text style={styles.aboutFooterTitle}>About ReeferON</Text>
                  <Text style={styles.aboutBody}>
                    ReeferON is an integrated cold-chain solutions company delivering end-to-end
                    services across cold warehousing, transportation, logistics, storage and
                    supply-chain consulting. With strong industry expertise, ReeferON focuses on
                    efficiency, compliance, innovation and reliable cold-chain operations.
                  </Text>

                  <Text style={styles.aboutSectionTitle}>Our Services</Text>
                  {[
                    'Cold Warehousing',
                    'Transportation',
                    'Logistics',
                    'Supply Chain Consulting',
                    'Flexible Storage',
                    'Reefer Containers',
                    'Packaging Solutions'
                  ].map((item) => (
                    <Text key={item} style={styles.aboutBullet}>
                      • {item}
                    </Text>
                  ))}

                  <Text style={styles.aboutSectionTitle}>Our Values</Text>
                  {[
                    'Customer Excellence',
                    'Compliance',
                    'Cost Optimization',
                    'Collaboration'
                  ].map((item) => (
                    <Text key={item} style={styles.aboutBullet}>
                      • {item}
                    </Text>
                  ))}

                  <Text style={styles.aboutSectionTitle}>Contact Us</Text>
                  <TouchableOpacity
                    onPress={() => Linking.openURL('tel:+917678047222')}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.aboutContactLink}>+91 7678047222</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => Linking.openURL('tel:+917678047222')}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.aboutContactLink}>+91 7678047222</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => Linking.openURL('mailto:smile@reeferon.com')}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.aboutContactLink}>smile@reeferon.com</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </ScrollView>
        )}
      </View>

      {/* Bottom navigation — same pattern as DO */}
      <View style={styles.tabBarContainer}>
        {[
          { id: 'Dashboard', label: 'Dashboard', icon: 'home', iconOutline: 'home-outline' },
          { id: 'Logs', label: 'Logs', icon: 'thermometer', iconOutline: 'thermometer-outline' },
          { id: 'Reports', label: 'Reports', icon: 'stats-chart', iconOutline: 'stats-chart-outline' },
          { id: 'More', label: 'More', icon: 'ellipsis-horizontal', iconOutline: 'ellipsis-horizontal-outline' }
        ].map((tab) => {
          const active = activeTab === tab.id;
          return (
            <TouchableOpacity
              key={tab.id}
              style={styles.tabBarItem}
              onPress={() => setActiveTab(tab.id)}
              activeOpacity={0.85}
            >
              <Ionicons
                name={active ? tab.icon : tab.iconOutline}
                size={22}
                color={active ? '#003580' : '#64748b'}
              />
              <Text style={[styles.tabBarLabel, active && styles.tabBarLabelActive]}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Modal
        visible={showCalendarModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowCalendarModal(false)}
      >
        <View style={styles.calendarOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setShowCalendarModal(false)}
          />
          <View style={styles.calendarCard}>
            <View style={styles.calendarSheetHandle} />
            <Text style={styles.calendarTitle}>
              {isOverviewCalendar
                ? 'Select date'
                : isOverviewInOutCalendar
                  ? 'In & Out date range'
                  : isOverviewTaskCalendar
                    ? 'Temperature date range'
                    : calendarContext === 'logsTemp'
                      ? 'Logs temperature date range'
                      : 'Select date range'}
            </Text>
            <Text style={styles.calendarHint}>
              {isOverviewCalendar
                ? 'Tap one date to filter dashboard'
                : calendarPickMode === 'from'
                  ? 'Tap start date, then end date'
                  : 'Tap end date to finish'}
            </Text>

            {isRangeCalendar ? (
            <View style={styles.calendarChipRow}>
              <TouchableOpacity
                style={[styles.calendarModeChip, calendarPickMode === 'from' && styles.calendarModeChipActive]}
                onPress={() => setCalendarPickMode('from')}
              >
                <Text
                  style={[
                    styles.calendarModeChipText,
                    calendarPickMode === 'from' && styles.calendarModeChipTextActive
                  ]}
                >
                  From:{' '}
                  {calendarContext === 'logsTemp'
                    ? logsReportDateFrom
                    : isOverviewInOutCalendar
                      ? overviewInOutDateFrom
                      : isOverviewTaskCalendar
                        ? overviewTempDateFrom
                        : formatDateLabel(dateFrom)}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.calendarModeChip, calendarPickMode === 'to' && styles.calendarModeChipActive]}
                onPress={() => setCalendarPickMode('to')}
              >
                <Text
                  style={[
                    styles.calendarModeChipText,
                    calendarPickMode === 'to' && styles.calendarModeChipTextActive
                  ]}
                >
                  To:{' '}
                  {calendarContext === 'logsTemp'
                    ? logsReportDateTo
                    : isOverviewInOutCalendar
                      ? overviewInOutDateTo
                      : isOverviewTaskCalendar
                        ? overviewTempDateTo
                        : formatDateLabel(dateTo)}
                </Text>
              </TouchableOpacity>
            </View>
            ) : (
              <View style={styles.calendarChipRow}>
                <View style={[styles.calendarModeChip, styles.calendarModeChipActive]}>
                  <Text style={[styles.calendarModeChipText, styles.calendarModeChipTextActive]}>
                    Date: {formatDateLabel(overviewDate)}
                  </Text>
                </View>
              </View>
            )}

            <View style={styles.calendarMonthRow}>
              <TouchableOpacity
                onPress={() => {
                  const prev = new Date(calendarMonth);
                  prev.setMonth(prev.getMonth() - 1);
                  setCalendarMonth(prev);
                }}
              >
                <Ionicons name="chevron-back" size={22} color="#003580" />
              </TouchableOpacity>
              <Text style={styles.calendarMonthText}>
                {calendarMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  const next = new Date(calendarMonth);
                  next.setMonth(next.getMonth() + 1);
                  setCalendarMonth(next);
                }}
              >
                <Ionicons name="chevron-forward" size={22} color="#003580" />
              </TouchableOpacity>
            </View>

            <View style={styles.calendarWeekRow}>
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                <Text key={`${d}-${i}`} style={styles.calendarWeekDay}>
                  {d}
                </Text>
              ))}
            </View>

            <View style={styles.calendarDaysWrap}>
              {getCalendarDays(calendarMonth).map((d, index) => {
                if (!d) {
                  return <View key={`empty-${index}`} style={styles.calendarDayCell} />;
                }
                const dateStr = toLocalYmd(d);
                const effectiveFrom = calendarRangeFrom;
                const effectiveTo =
                  calendarRangeTo && calendarRangeFrom
                    ? calendarRangeTo < calendarRangeFrom
                      ? calendarRangeFrom
                      : calendarRangeTo
                    : calendarRangeTo;
                const rangeStart = effectiveFrom;
                const rangeEnd = isOverviewCalendar ? effectiveFrom : effectiveTo;
                const isStart = rangeStart && dateStr === rangeStart;
                const isEnd = !isOverviewCalendar && rangeEnd && dateStr === rangeEnd;
                const inRange =
                  !isOverviewCalendar &&
                  rangeStart &&
                  rangeEnd &&
                  dateStr >= rangeStart &&
                  dateStr <= rangeEnd;
                const isToday = dateStr === toLocalYmd();
                // In To mode: dates before From are not selectable
                const isDisabled =
                  !isOverviewCalendar &&
                  calendarPickMode === 'to' &&
                  effectiveFrom != null &&
                  dateStr < effectiveFrom;

                return (
                  <TouchableOpacity
                    key={dateStr}
                    disabled={isDisabled}
                    style={[
                      styles.calendarDayCell,
                      (isStart || isEnd) && styles.calendarDaySelected,
                      inRange && !isStart && !isEnd && styles.calendarDayInRange,
                      isToday && !isStart && !isEnd && !isDisabled && styles.calendarDayToday,
                      isDisabled && styles.calendarDayDisabled
                    ]}
                    onPress={() => {
                      if (isOverviewCalendar) {
                        applyOverviewDate(dateStr);
                        setShowCalendarModal(false);
                        return;
                      }
                      if (calendarPickMode === 'from') {
                        const currentTo =
                          calendarContext === 'logsTemp'
                            ? logsReportDateTo
                            : isOverviewInOutCalendar
                              ? overviewInOutDateTo
                              : isOverviewTaskCalendar
                                ? overviewTempDateTo
                              : dateTo === 'All'
                                ? dateStr
                                : dateTo;
                        const nextTo = dateStr > currentTo ? dateStr : currentTo;
                        applyCalendarRange(dateStr, nextTo);
                        setCalendarPickMode('to');
                      } else {
                        if (effectiveFrom && dateStr < effectiveFrom) return;
                        applyCalendarRange(effectiveFrom || dateStr, dateStr);
                        setCalendarPickMode('from');
                        setShowCalendarModal(false);
                      }
                    }}
                  >
                    <Text
                      style={[
                        styles.calendarDayText,
                        (isStart || isEnd) && styles.calendarDayTextSelected,
                        isDisabled && styles.calendarDayTextDisabled
                      ]}
                    >
                      {d.getDate()}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.calendarActionRow}>
              <TouchableOpacity
                style={styles.calendarClearBtn}
                onPress={() => {
                  const t = toLocalYmd();
                  if (calendarContext === 'logsTemp') {
                    setLogsReportDateFrom(t);
                    setLogsReportDateTo(t);
                  } else if (isOverviewInOutCalendar) {
                    const start = new Date();
                    start.setDate(start.getDate() - 6);
                    applyOverviewInOutRange(toLocalYmd(start), t);
                  } else if (isOverviewTaskCalendar) {
                    const start = new Date();
                    start.setDate(start.getDate() - 6);
                    applyOverviewTempRange(toLocalYmd(start), t);
                  } else if (isOverviewCalendar) {
                    applyOverviewDate(t);
                  } else {
                    clearDateRange();
                  }
                  setCalendarPickMode('from');
                  setShowCalendarModal(false);
                }}
                activeOpacity={0.85}
              >
                <Text style={styles.calendarClearText}>Clear</Text>
              </TouchableOpacity>
              {isRangeCalendar ? (
                <TouchableOpacity
                  style={styles.calendarClearBtn}
                  onPress={() => {
                    const end = new Date();
                    const start = new Date();
                    start.setDate(end.getDate() - 6);
                    const from = toLocalYmd(start);
                    const to = toLocalYmd(end);
                    if (calendarContext === 'logsTemp') {
                      setLogsReportDateFrom(from);
                      setLogsReportDateTo(to);
                    } else if (isOverviewInOutCalendar) {
                      applyOverviewInOutRange(from, to);
                    } else if (isOverviewTaskCalendar) {
                      applyOverviewTempRange(from, to);
                    } else {
                      suggestLast7();
                    }
                    setCalendarPickMode('from');
                    setShowCalendarModal(false);
                  }}
                  activeOpacity={0.85}
                >
                  <Text style={styles.calendarClearText}>Last 7 days</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={styles.calendarDoneBtn}
                onPress={() => setShowCalendarModal(false)}
                activeOpacity={0.85}
              >
                <Text style={styles.calendarDoneText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {renderLogDetailScreen()}
      {renderInventoryDetailModal()}
      {renderFilterPickerModal()}
      <ImagePreviewModal
        visible={!!imagePreview}
        uri={imagePreview?.uri}
        label={imagePreview?.label}
        onClose={() => setImagePreview(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f8fafc' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 10,
    paddingRight: 14,
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 24) + 4 : 6,
    paddingBottom: 14,
    minHeight: Platform.OS === 'android' ? 64 : 58,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0'
  },
  headerLogo: {
    width: 120,
    height: 44,
    marginRight: -28,
    marginTop: 6,
    alignSelf: 'flex-end',
  },
  aboutLogoWrap: {
    alignSelf: 'center',
    marginBottom: 12
  },
  aboutLogo: {
    width: 110,
    height: 48
  },
  welcomeBlock: {
    flex: 1,
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingRight: 8,
    marginLeft: 14,
    marginTop: 6,
  },
  welcomeLine: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 2,
    textAlign: 'left',
  },
  welcomeName: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0f172a',
    textAlign: 'left',
  },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#dc2626',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8
  },
  logoutText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  contentArea: { flex: 1, paddingBottom: 64 },
  body: { padding: 12, paddingBottom: 36 },
  homeHero: {
    height: 110,
    marginHorizontal: -12,
    marginTop: -12,
    marginBottom: 12,
    justifyContent: 'flex-end'
  },
  homeHeroOverlay: {
    backgroundColor: 'rgba(0, 30, 80, 0.55)',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10
  },
  homeHeroTitle: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '800',
    lineHeight: 22
  },
  homeHeroSubtitle: {
    color: '#e2e8f0',
    fontSize: 11,
    marginTop: 4,
    lineHeight: 15,
    fontWeight: '500'
  },
  dashboardHint: {
    marginTop: 8,
    fontSize: 12,
    color: '#64748b',
    fontWeight: '600',
    textAlign: 'center'
  },
  overviewPresetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8
  },
  overviewPresetChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  overviewPresetChipActive: {
    backgroundColor: '#eff6ff',
    borderColor: '#93c5fd'
  },
  overviewPresetText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b'
  },
  overviewPresetTextActive: {
    color: '#003580'
  },
  overviewSectionTabs: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  overviewTotalsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  overviewTotalCard: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    minWidth: 0,
  },
  overviewTotalIn: {
    borderColor: '#99f6e4',
    backgroundColor: '#f0fdfa',
  },
  overviewTotalOut: {
    borderColor: '#fed7aa',
    backgroundColor: '#fff7ed',
  },
  overviewTotalTask: {
    borderColor: '#bfdbfe',
    backgroundColor: '#eff6ff',
  },
  overviewTotalLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b',
    marginBottom: 4,
  },
  overviewTotalValue: {
    fontSize: 20,
    fontWeight: '900',
    color: '#0f172a',
  },
  overviewTotalValueIn: {
    color: '#0f766e',
  },
  overviewTotalValueOut: {
    color: '#c2410c',
  },
  overviewTotalValueTask: {
    color: '#003580',
  },
  overviewTotalSub: {
    marginTop: 2,
    fontSize: 9,
    fontWeight: '600',
    color: '#94a3b8',
  },
  overviewSectionTab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  overviewSectionTabActive: {
    backgroundColor: '#003580',
    borderColor: '#003580',
  },
  overviewSectionTabText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#475569',
  },
  overviewSectionTabTextActive: {
    color: '#ffffff',
  },
  overviewDateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'nowrap',
    gap: 6,
    marginTop: 2,
    marginBottom: 10
  },
  overviewDateChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d2e3fc'
  },
  overviewDateChipText: {
    flex: 1,
    fontSize: 11,
    fontWeight: '700',
    color: '#0f172a',
    minWidth: 0
  },
  overviewWarehouseChip: {
    flex: 1,
    minHeight: 34,
  },
  overviewWarehouseChipActive: {
    borderColor: '#93c5fd',
    backgroundColor: '#eff6ff'
  },
  overviewWarehouseChipTextActive: {
    color: '#003580'
  },
  overviewDateTodayBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#e8f0fe'
  },
  overviewDateTodayText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#003580'
  },
  overviewShiftRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: 4
  },
  overviewShiftChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#d2e3fc'
  },
  overviewShiftChipActive: {
    backgroundColor: '#003580',
    borderColor: '#003580'
  },
  overviewShiftChipText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#003580'
  },
  overviewShiftChipTextActive: {
    color: '#ffffff'
  },
  inoutDateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10
  },
  logsTempDateRow: {
    marginHorizontal: 12,
    marginTop: 4,
    marginBottom: 8
  },
  inoutListSection: {
    marginTop: 8,
    borderTopWidth: 0,
    paddingTop: 4,
  },
  inoutListTabRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
    marginBottom: 4,
  },
  inoutListTabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  inoutListTabBtnText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#64748b',
  },
  inoutListTabBtnCount: {
    fontSize: 12,
    fontWeight: '900',
    color: '#94a3b8',
  },
  inoutPagerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 8,
    marginBottom: 2,
  },
  inoutPagerBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#E8F0FE',
    borderWidth: 1,
    borderColor: '#A8C7FA',
  },
  inoutPagerBtnDisabled: {
    opacity: 0.4,
  },
  inoutPagerBtnText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#1A73E8',
  },
  inoutPagerMeta: {
    flex: 1,
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
  },
  inoutListHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  inoutListHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  inoutListDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  inoutListTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0f172a',
  },
  inoutListCount: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748b',
  },
  inoutListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
    marginBottom: 6,
  },
  inoutListClient: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
  },
  inoutListMeta: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b',
  },
  inoutListValue: {
    fontSize: 14,
    fontWeight: '900',
    flexShrink: 0,
  },
  inoutListBoxesHint: {
    marginTop: 2,
    fontSize: 10,
    fontWeight: '800',
    color: '#475569',
  },
  inoutProductGraphBox: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  inoutDateChip: {
    flex: 1
  },
  inoutClearBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    minHeight: 34,
    justifyContent: 'center',
  },
  inoutClearText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748b',
  },
  inoutRangeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 10
  },
  inoutCalendarBlock: {
    marginBottom: 8,
    marginHorizontal: -4,
  },
  inoutRangeChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  inoutRangeChipActive: {
    backgroundColor: '#0F766E',
    borderColor: '#0F766E'
  },
  inoutRangeChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569'
  },
  inoutRangeChipTextActive: {
    color: '#ffffff',
    fontWeight: '800'
  },
  tempGraphHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4
  },
  tempGraphHeaderText: {
    flex: 1,
    minWidth: 0,
    paddingRight: 4
  },
  taskHelpBox: {
    backgroundColor: '#f0f7ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
    marginTop: 4,
  },
  taskHelpTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#003580',
    marginBottom: 4,
  },
  taskHelpText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#334155',
    lineHeight: 16,
  },
  taskHelpRange: {
    marginTop: 6,
    fontSize: 11,
    fontWeight: '700',
    color: '#003580',
  },
  taskInstrHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f0f7ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginTop: 6,
    marginBottom: 8,
  },
  taskInstrHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    minWidth: 0,
  },
  taskInstrHeaderTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#003580',
  },
  taskInstrBody: {
    backgroundColor: '#f8fbff',
    borderWidth: 1,
    borderColor: '#dbeafe',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: -4,
    marginBottom: 10,
  },
  taskInstrSectionTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: '#0f172a',
    marginTop: 8,
    marginBottom: 4,
  },
  taskInstrText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#475569',
    lineHeight: 16,
  },
  taskInstrRange: {
    marginTop: 10,
    fontSize: 11,
    fontWeight: '700',
    color: '#003580',
  },
  taskRangeSummaryBox: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 12,
  },
  taskRangeSummaryTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 12,
  },
  taskRangeSummaryTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0f172a',
  },
  taskRangeSummarySub: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b',
  },
  taskRangeDaysPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#E8F0FE',
    borderWidth: 1,
    borderColor: '#A8C7FA',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  taskRangeDaysPillText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#1A73E8',
  },
  taskRangeProgressBlock: {
    marginBottom: 12,
  },
  taskRangeProgressMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  taskRangeProgressLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
  },
  taskRangeProgressPct: {
    fontSize: 11,
    fontWeight: '800',
    color: '#1A73E8',
  },
  taskRangeProgressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: '#e2e8f0',
    overflow: 'hidden',
  },
  taskRangeProgressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#0D9488',
  },
  taskRangeMetricRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  taskRangeMetricCard: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  taskRangeMetricTotal: {
    borderColor: '#A8C7FA',
    backgroundColor: '#E8F0FE',
  },
  taskRangeMetricDone: {
    borderColor: '#99F6E4',
    backgroundColor: '#F0FDFA',
  },
  taskRangeMetricPending: {
    borderColor: '#A8C7FA',
    backgroundColor: '#E8F0FE',
  },
  taskRangeMetricValue: {
    fontSize: 20,
    fontWeight: '900',
    color: '#1A73E8',
  },
  taskRangeMetricLabel: {
    marginTop: 2,
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b',
  },
  taskRangeTempHeading: {
    fontSize: 11,
    fontWeight: '800',
    color: '#475569',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  taskRangeTempRow: {
    flexDirection: 'row',
    gap: 8,
  },
  taskRangeTempCard: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  taskRangeTempGood: {
    borderColor: '#99F6E4',
    backgroundColor: '#F0FDFA',
  },
  taskRangeTempBad: {
    borderColor: '#FED7AA',
    backgroundColor: '#FFF7ED',
  },
  taskRangeTempHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  taskRangeTempDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  taskRangeTempLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
  },
  taskRangeTempValue: {
    fontSize: 22,
    fontWeight: '900',
  },
  taskRangeTempHint: {
    marginTop: 2,
    fontSize: 10,
    fontWeight: '600',
    color: '#94a3b8',
  },
  taskDailyChartBox: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 6,
    marginBottom: 12,
  },
  taskBucketRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 10,
  },
  taskBucketChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  taskBucketChipActive: {
    backgroundColor: '#E8F0FE',
    borderColor: '#1A73E8',
  },
  taskBucketChipText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748b',
  },
  taskBucketChipTextActive: {
    color: '#1A73E8',
  },
  taskLegendRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  taskLegendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  taskLegendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  taskLegendText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b',
  },
  taskLegendGood: {
    color: '#16a34a',
  },
  taskLegendRisk: {
    color: '#ea580c',
  },
  taskLegendPending: {
    color: '#64748b',
  },
  taskRangeRules: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  taskRangeRulesTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: '#475569',
    marginBottom: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  taskRangeRulesText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b',
    lineHeight: 15,
  },
  taskCompHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 4,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
    marginTop: 6,
  },
  taskCompColHead: {
    fontSize: 10,
    fontWeight: '700',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  taskCompColTask: {
    flex: 1,
    minWidth: 0,
    paddingRight: 8,
    flexShrink: 1,
  },
  taskCompColPct: {
    width: 56,
    textAlign: 'center',
    flexShrink: 0,
  },
  taskCompColTrend: {
    width: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskCompColStatus: {
    width: 52,
    textAlign: 'center',
    flexShrink: 0,
  },
  taskCompRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 4,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f1f5f9',
  },
  taskCompTaskName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    lineHeight: 18,
  },
  taskCompTaskSub: {
    fontSize: 10,
    fontWeight: '600',
    color: '#94a3b8',
    marginTop: 4,
    lineHeight: 14,
  },
  taskCompPct: {
    width: 56,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '800',
    color: '#64748b',
    paddingTop: 2,
    flexShrink: 0,
  },
  taskCompPctGood: {
    color: '#16a34a',
  },
  taskCompPctRisk: {
    color: '#ea580c',
  },
  taskCompStatusPill: {
    width: 52,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 0,
    flexShrink: 0,
    backgroundColor: 'transparent',
  },
  taskStatusBullet: {
    width: 12,
    height: 12,
    borderRadius: 6,
    flexShrink: 0,
  },
  taskCompStatusGood: {},
  taskCompStatusRisk: {},
  taskCompStatusPending: {},
  taskCompStatusText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748b',
  },
  taskCompStatusTextGood: {
    color: '#15803d',
  },
  taskCompStatusTextRisk: {
    color: '#c2410c',
  },
  overviewClientBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  overviewClientBtnText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: '#0f172a'
  },
  overviewClientMenu: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '100%',
    marginTop: 4,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    overflow: 'hidden',
    elevation: 4,
    shadowColor: '#0f172a',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 }
  },
  overviewClientItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0'
  },
  overviewClientItemActive: {
    backgroundColor: '#eff6ff'
  },
  overviewClientItemText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155'
  },
  overviewClientItemTextActive: {
    color: '#003580',
    fontWeight: '800'
  },
  overviewKpiRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12
  },
  overviewKpiCard: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  overviewKpiValue: {
    fontSize: 20,
    fontWeight: '900',
    marginTop: 4
  },
  overviewKpiLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b',
    marginTop: 2
  },
  overviewActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12
  },
  overviewFilterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  overviewFilterChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#334155'
  },
  dailyTempScreenHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12
  },
  dailyTempBackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 4,
    paddingRight: 6
  },
  dailyTempBackText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#003580'
  },
  dailyTempScreenTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
    color: '#0f172a'
  },
  overviewFilterBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center'
  },
  overviewFilterBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#ffffff'
  },
  taskGraphHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 6,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0'
  },
  taskGraphHeadCell: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748b',
    textTransform: 'uppercase'
  },
  taskGraphClientCol: {
    width: '28%',
    paddingRight: 6
  },
  taskGraphBarCol: {
    width: '36%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingRight: 4
  },
  taskGraphRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8
  },
  taskGraphClient: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0f172a'
  },
  taskGraphBarTrack: {
    flex: 1,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#f1f5f9',
    overflow: 'hidden'
  },
  taskGraphBarFill: {
    height: '100%',
    borderRadius: 5,
    minWidth: 0
  },
  taskGraphBarMorning: {
    backgroundColor: '#003580'
  },
  taskGraphBarEvening: {
    backgroundColor: '#0d9488'
  },
  taskGraphCount: {
    width: 18,
    fontSize: 10,
    fontWeight: '800',
    color: '#475569',
    textAlign: 'right'
  },
  tempGraphRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 8
  },
  tempGraphClientCol: {
    width: 104,
    paddingRight: 2
  },
  tempGraphClient: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0f172a'
  },
  tempGraphType: {
    marginTop: 1,
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b'
  },
  tempGraphTypeAlert: {
    color: '#dc2626'
  },
  tempGraphBarTrack: {
    flex: 1,
    height: 14,
    borderRadius: 4,
    backgroundColor: '#e8eef6',
    overflow: 'hidden'
  },
  tempGraphBarFill: {
    height: '100%',
    borderRadius: 4,
    backgroundColor: '#003580'
  },
  tempGraphBarFillAlert: {
    backgroundColor: '#dc2626'
  },
  tempGraphValue: {
    width: 48,
    fontSize: 12,
    fontWeight: '800',
    color: '#0f172a',
    textAlign: 'right'
  },
  tempGraphValueAlert: {
    color: '#dc2626'
  },
  overviewActionsWrap: {
    backgroundColor: '#ffffff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    marginBottom: 12
  },
  overviewActionsTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#003580',
    marginBottom: 10
  },
  overviewActionBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 12,
    paddingBottom: 10,
    paddingHorizontal: 6,
    borderRadius: 14,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    minHeight: 132
  },
  overviewActionIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8
  },
  overviewActionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
    marginTop: 2
  },
  overviewActionCount: {
    fontSize: 22,
    fontWeight: '900',
    color: '#0f172a',
    lineHeight: 26
  },
  overviewActionPill: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999
  },
  overviewActionPillText: {
    fontSize: 10,
    fontWeight: '800'
  },
  overviewBarRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-end',
    marginTop: 8,
    height: 140,
    paddingBottom: 4
  },
  overviewBarCol: {
    alignItems: 'center',
    width: 64,
    height: '100%',
    justifyContent: 'flex-end'
  },
  overviewBarValue: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 4
  },
  overviewBarTrack: {
    width: 22,
    height: 100,
    borderRadius: 6,
    backgroundColor: '#f1f5f9',
    justifyContent: 'flex-end',
    overflow: 'hidden'
  },
  overviewBarFill: {
    width: '100%',
    borderRadius: 6,
    minHeight: 8
  },
  overviewBarLabel: {
    marginTop: 6,
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b'
  },
  overviewDailyRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingTop: 8,
    paddingBottom: 4,
    minHeight: 120
  },
  overviewDailyCol: {
    width: 42,
    alignItems: 'center'
  },
  overviewDailyBars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    height: 76
  },
  overviewDailyBar: {
    width: 8,
    borderRadius: 3,
    minHeight: 4
  },
  overviewDailyLabel: {
    marginTop: 6,
    fontSize: 9,
    fontWeight: '700',
    color: '#64748b'
  },
  overviewDailySum: {
    fontSize: 9,
    fontWeight: '800',
    color: '#0f172a'
  },
  overviewLegendRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 14,
    marginTop: 12
  },
  overviewLegendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5
  },
  overviewLegendDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  overviewLegendText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b'
  },
  moreBody: {
    flexGrow: 1,
    paddingBottom: 24
  },
  moreSpacer: {
    flexGrow: 1,
    minHeight: 24
  },
  aboutFooter: {
    marginTop: 8,
    paddingTop: 18,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0'
  },
  aboutFooterTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#64748b',
    textAlign: 'center'
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    marginBottom: 10
  },
  cardTitle: { fontSize: 15, fontWeight: '800', color: '#0f172a' },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4
  },
  cardHint: { fontSize: 12, color: '#64748b', marginTop: 6, lineHeight: 18 },
  aboutBrand: {
    fontSize: 16,
    fontWeight: '900',
    color: '#003580',
    marginTop: 4
  },
  aboutBody: {
    fontSize: 13,
    color: '#94a3b8',
    lineHeight: 20,
    marginTop: 8,
    fontWeight: '500'
  },
  aboutSectionTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#64748b',
    marginTop: 16,
    marginBottom: 6
  },
  aboutBullet: {
    fontSize: 13,
    color: '#94a3b8',
    lineHeight: 22,
    fontWeight: '600',
    paddingLeft: 2
  },
  aboutContactLink: {
    fontSize: 13,
    color: '#64748b',
    lineHeight: 24,
    fontWeight: '700',
    paddingLeft: 2
  },
  linkText: { fontSize: 12, fontWeight: '800', color: '#0369a1' },
  scopeBlock: { marginTop: 14 },
  scopeLabel: { fontSize: 11, fontWeight: '800', color: '#0369a1', textTransform: 'uppercase' },
  scopeValue: { fontSize: 13, color: '#334155', marginTop: 4, lineHeight: 18, fontWeight: '600' },
  profileRow: {
    marginTop: 10,
    fontSize: 13,
    lineHeight: 20,
    color: '#334155'
  },
  profileKey: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a'
  },
  profileVal: {
    fontSize: 13,
    fontWeight: '600',
    color: '#334155'
  },
  queryLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    marginTop: 10,
    marginBottom: 6
  },
  queryInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#0f172a',
    backgroundColor: '#f8fafc'
  },
  queryMessageInput: {
    minHeight: 110,
    maxHeight: 180
  },
  querySendBtn: {
    marginTop: 12,
    backgroundColor: '#003580',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8
  },
  querySendText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14
  },
  mono: { fontSize: 12, color: '#0f172a', marginTop: 8, fontWeight: '600' },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 12
  },
  statCard: {
    width: '48%',
    flexGrow: 1,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14
  },
  statPrimary: { borderColor: '#bfdbfe', backgroundColor: '#eff6ff' },
  statWide: { width: '100%' },
  statAlert: { borderColor: '#fecaca', backgroundColor: '#fef2f2' },
  statLabel: { fontSize: 11, fontWeight: '800', color: '#64748b', textTransform: 'uppercase' },
  statValue: { fontSize: 22, fontWeight: '900', color: '#0f172a', marginTop: 6 },
  shortcutRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12
  },
  shortcutBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  shortcutText: { fontSize: 12, fontWeight: '800', color: '#0f172a' },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  barName: { width: 88, fontSize: 12, fontWeight: '700', color: '#334155' },
  barTrack: {
    flex: 1,
    height: 8,
    borderRadius: 999,
    backgroundColor: '#f1f5f9',
    overflow: 'hidden'
  },
  barFill: { height: '100%', backgroundColor: '#003580', borderRadius: 999 },
  barFillAlt: { height: '100%', backgroundColor: '#0284c7', borderRadius: 999 },
  barCount: { width: 28, textAlign: 'right', fontSize: 12, fontWeight: '800', color: '#0f172a' },
  recentRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  recentRowBorder: { borderTopWidth: 1, borderTopColor: '#f1f5f9' },
  recentClient: { fontSize: 13, fontWeight: '800', color: '#0f172a' },
  recentMeta: { fontSize: 11, color: '#64748b', marginTop: 2, fontWeight: '600' },
  updateIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center'
  },
  updateMetaLine: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 3,
    fontWeight: '600'
  },
  recentTemp: { fontSize: 14, fontWeight: '800', color: '#0369a1' },
  logsWrap: { flex: 1 },
  filtersCard: {
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 6
  },
  adminNotesCard: {
    backgroundColor: '#fff',
    marginHorizontal: 10,
    marginTop: 10,
    marginBottom: 8,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  adminNotesHomeCard: {
    paddingBottom: 10
  },
  adminNotesScroll: {
    maxHeight: 280,
    marginTop: 8
  },
  adminNoteBubble: {
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    maxWidth: '92%'
  },
  adminNoteBubbleAdmin: {
    alignSelf: 'flex-start',
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe'
  },
  adminNoteBubbleMine: {
    alignSelf: 'flex-end',
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  adminNoteAuthor: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b',
    marginBottom: 4
  },
  adminNoteAuthorAdmin: { color: '#003580' },
  adminNoteBody: {
    fontSize: 13,
    color: '#0f172a',
    fontWeight: '600',
    lineHeight: 18
  },
  adminNoteBodyAdmin: { color: '#0f172a' },
  adminNoteCompose: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginTop: 8
  },
  adminNoteInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 90,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#0f172a',
    backgroundColor: '#f8fafc'
  },
  adminNoteSend: {
    backgroundColor: '#003580',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minWidth: 64,
    alignItems: 'center',
    justifyContent: 'center'
  },
  adminNoteSendText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  filterChipRow: {
    flexDirection: 'row',
    gap: 6
  },
  filterChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 5,
    minHeight: 34
  },
  filterChipActive: {
    backgroundColor: '#eff6ff',
    borderColor: '#93c5fd'
  },
  dateChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 5,
    minHeight: 34
  },
  filterChipTextWrap: {
    flex: 1,
    minWidth: 0
  },
  filterChipLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.3
  },
  filterChipValue: {
    fontSize: 11,
    fontWeight: '700',
    color: '#334155',
    marginTop: 0
  },
  filterChipValueActive: {
    color: '#003580'
  },
  filterModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'flex-end'
  },
  filterModalSheet: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 20,
    maxHeight: BOTTOM_SHEET_MAX_H,
  },
  filterModalHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 999,
    backgroundColor: '#cbd5e1',
    marginBottom: 12
  },
  filterModalTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 10
  },
  filterModalList: {
    maxHeight: BOTTOM_SHEET_SCROLL_H,
  },
  filterModalItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginBottom: 4,
    backgroundColor: '#f8fafc'
  },
  filterModalItemActive: {
    backgroundColor: '#eff6ff'
  },
  filterModalItemText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#334155',
    marginRight: 8
  },
  filterModalItemTextActive: {
    color: '#003580',
    fontWeight: '800'
  },
  filterModalClose: {
    marginTop: 10,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#f1f5f9'
  },
  filterModalCloseText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#334155'
  },
  scopeNote: { fontSize: 11, color: '#64748b', fontWeight: '600', marginTop: 2 },
  dateFilterBlock: { gap: 8 },
  dateSuggestRow: {
    gap: 6,
    paddingTop: 6,
    paddingRight: 4
  },
  dateSuggestChip: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe'
  },
  dateSuggestText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#003580'
  },
  calendarOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'flex-end',
  },
  calendarCard: {
    width: '100%',
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
  },
  calendarSheetHandle: {
    alignSelf: 'center',
    width: 32,
    height: 3,
    borderRadius: 999,
    backgroundColor: '#cbd5e1',
    marginBottom: 6,
  },
  calendarTitle: { fontSize: 13, fontWeight: '800', color: '#0f172a', marginBottom: 1 },
  calendarHint: { fontSize: 9, color: '#64748b', marginBottom: 6, fontWeight: '600' },
  calendarChipRow: { flexDirection: 'row', gap: 6, marginBottom: 6 },
  calendarModeChip: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    paddingHorizontal: 6,
    paddingVertical: 5
  },
  calendarModeChipActive: {
    borderColor: '#93c5fd',
    backgroundColor: '#eff6ff'
  },
  calendarModeChipText: { fontSize: 10, fontWeight: '700', color: '#64748b', textAlign: 'center' },
  calendarModeChipTextActive: { color: '#003580' },
  calendarMonthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4
  },
  calendarMonthText: { fontSize: 12, fontWeight: '800', color: '#0f172a' },
  calendarWeekRow: { flexDirection: 'row', marginBottom: 2 },
  calendarWeekDay: {
    width: '14.28%',
    textAlign: 'center',
    fontSize: 8,
    fontWeight: '800',
    color: '#94a3b8'
  },
  calendarDaysWrap: { flexDirection: 'row', flexWrap: 'wrap' },
  calendarDayCell: {
    width: '14.28%',
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14
  },
  calendarDaySelected: { backgroundColor: '#003580' },
  calendarDayInRange: { backgroundColor: '#dbeafe' },
  calendarDayToday: { borderWidth: 1, borderColor: '#93c5fd' },
  calendarDayDisabled: { opacity: 0.35 },
  calendarDayText: { fontSize: 11, fontWeight: '600', color: '#0f172a' },
  calendarDayTextSelected: { color: '#ffffff', fontWeight: '800' },
  calendarDayTextDisabled: { color: '#94a3b8' },
  calendarSuggestRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    marginTop: 8
  },
  calendarDoneBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#003580',
  },
  calendarDoneText: { color: '#ffffff', fontWeight: '800', fontSize: 13 },
  calendarActionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
    width: '100%',
  },
  calendarClearBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  calendarClearText: {
    color: '#64748b',
    fontWeight: '800',
    fontSize: 13,
  },
  calendarDoneChip: {
    backgroundColor: '#003580',
    borderColor: '#003580',
  },
  calendarDoneChipText: {
    color: '#ffffff',
  },
  listBody: { padding: 16, paddingBottom: 40, flexGrow: 1 },
  listBodyCompact: { padding: 8, paddingBottom: 88, flexGrow: 1 },
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
  logChamberTypeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
    marginTop: 2
  },
  logChamberTypeArrow: {
    fontSize: 11,
    fontWeight: '900',
    lineHeight: 12
  },
  logChamberTypeHint: {
    fontSize: 9,
    fontWeight: '700',
    color: '#64748b'
  },
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
  compactLogCard: {
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
    gap: 8
  },
  dockLogTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 1
  },
  dockLogTypeTag: {
    fontSize: 8,
    fontWeight: '800',
    color: '#0284c7',
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    overflow: 'hidden'
  },
  dockLogTypeTagOut: {
    color: '#b45309',
    backgroundColor: '#ffedd5'
  },
  dockLogClient: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0f172a',
    flex: 1
  },
  dockLogMeta: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 1
  },
  dockLogTemp: {
    fontSize: 13,
    fontWeight: '800',
    color: '#003580'
  },
  inwardPodMissingBadge: {
    marginLeft: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca'
  },
  inwardPodMissingBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#b91c1c',
    letterSpacing: 0.2
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
  logMeta: { fontSize: 10, color: '#64748b', marginTop: 1 },
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
  detailHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12
  },
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
  logCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 10
  },
  logCheckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  logCheckCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#bfdbfe',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#eff6ff'
  },
  logCheckBody: { flex: 1, minWidth: 0 },
  logClient: { fontSize: 14, fontWeight: '800', color: '#0f172a' },
  logCheckMeta: { fontSize: 11, color: '#64748b', marginTop: 2, fontWeight: '600' },
  logRightStats: { alignItems: 'flex-end', gap: 2 },
  logTemp: { fontSize: 14, fontWeight: '800', color: '#0369a1' },
  logBoxes: { fontSize: 11, fontWeight: '700', color: '#475569' },
  logPhotoBadge: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8
  },
  logPhotoBadgeText: { fontSize: 9, fontWeight: '800', color: '#0369a1' },
  logDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9'
  },
  logDetailLabel: {
    width: 110,
    fontSize: 11,
    fontWeight: '700',
    color: '#94a3b8',
    textTransform: 'uppercase'
  },
  logDetailValue: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    textAlign: 'right'
  },
  detailSafe: { flex: 1, backgroundColor: '#f8fafc' },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0'
  },
  detailBackBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center'
  },
  detailTitle: { fontSize: 16, fontWeight: '800', color: '#0f172a' },
  detailSub: { fontSize: 12, color: '#64748b', marginTop: 2, fontWeight: '600' },
  detailBody: { padding: 16, paddingBottom: 40 },
  detailHeroCard: {
    backgroundColor: '#003580',
    borderRadius: 14,
    padding: 18,
    marginBottom: 12
  },
  detailHeroTemp: { fontSize: 28, fontWeight: '900', color: '#ffffff' },
  detailHeroMeta: { fontSize: 13, fontWeight: '700', color: '#bfdbfe', marginTop: 6 },
  detailCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    marginBottom: 12
  },
  detailSectionTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 10
  },
  detailImage: {
    width: '100%',
    height: 320,
    borderRadius: 12,
    backgroundColor: '#e2e8f0'
  },
  detailImageViewHint: {
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
  detailImageViewHintText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  detailImageLoading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 320,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1
  },
  detailImageEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 28,
    paddingHorizontal: 12,
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderStyle: 'dashed'
  },
  detailImageHint: {
    fontSize: 10,
    color: '#94a3b8',
    textAlign: 'center',
    marginTop: 4
  },
  logMeta: { fontSize: 12, color: '#64748b', marginTop: 4, fontWeight: '600' },
  logRef: { fontSize: 11, color: '#94a3b8', marginTop: 6, fontWeight: '700' },
  centerState: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  stateText: { fontSize: 13, color: '#64748b', textAlign: 'center', lineHeight: 18 },
  retryBtn: {
    marginTop: 8,
    backgroundColor: '#003580',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8
  },
  retryText: { color: '#fff', fontWeight: '800', fontSize: 12 },
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
    paddingHorizontal: 8,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.08,
    shadowRadius: 5
  },
  tabBarItem: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    flex: 1
  },
  tabBarLabel: {
    fontSize: 10,
    color: '#64748b',
    fontWeight: '600',
    marginTop: 3
  },
  tabBarLabelActive: {
    color: '#003580',
    fontWeight: 'bold'
  },
  dockReportFilterBar: {
    paddingBottom: 4,
    gap: 6,
  },
  dockReportSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: Platform.OS === 'ios' ? 6 : 3,
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
    gap: 6,
  },
  reportListClearBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: '#fee2e2',
    borderWidth: 1,
    borderColor: '#fecaca',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  dockReportDateInput: {
    flex: 1,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: Platform.OS === 'ios' ? 6 : 5,
    fontSize: 12,
    color: '#0f172a',
  },
  dockReportDateBtn: {
    justifyContent: 'center',
    minHeight: 34,
  },
  dockReportDateBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0f172a',
  },
  dockReportDateBtnPlaceholder: {
    color: '#94a3b8',
    fontWeight: '500',
  },
  dockReportCalendarBtn: {
    width: 34,
    minHeight: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bfdbfe',
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dockReportFilterActions: {
    flexDirection: 'row',
    gap: 6,
  },
  dockReportFilterBtnPrimary: {
    flex: 1,
    backgroundColor: '#003580',
    borderRadius: 8,
    paddingVertical: 7,
    alignItems: 'center',
  },
  dockReportFilterBtnPrimaryText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 12,
  },
  dockReportFilterBtnOutline: {
    flex: 1,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#003580',
    borderRadius: 8,
    paddingVertical: 7,
    alignItems: 'center',
  },
  dockReportFilterBtnOutlineText: {
    color: '#003580',
    fontWeight: '700',
    fontSize: 12,
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
  inwardDetailPhotoMeta: {
    fontSize: 10,
    color: '#64748b',
    lineHeight: 14,
    marginTop: 4,
    fontWeight: '600',
  },
  inwardDetailPhotoGps: {
    color: '#0369a1',
    fontWeight: '700',
  },
  doLogDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  doLogDetailLabel: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: '600',
    flex: 1,
  },
  doLogDetailValue: {
    fontSize: 12,
    color: '#0f172a',
    fontWeight: '700',
    flex: 1.2,
    textAlign: 'right',
  },
  doLogDetailLinkWrap: {
    flex: 1.2,
    alignItems: 'flex-end',
  },
  doLogDetailLinkText: {
    textAlign: 'right',
  },
  doLogDetailLinkActive: {
    color: '#0369a1',
    textDecorationLine: 'underline',
  },
  doDetailSafe: { flex: 1, backgroundColor: '#f8fafc' },
  doDetailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  doDetailBackBtn: {
    padding: 8,
    marginRight: 4,
  },
  doDetailTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0f172a',
  },
  doDetailSub: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2,
    lineHeight: 17,
  },
  doDetailBody: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 28,
  },
  doDetailHeroCard: {
    backgroundColor: '#003580',
    borderRadius: 0,
    paddingHorizontal: 16,
    paddingVertical: 18,
    marginBottom: 10,
  },
  doDetailHeroTemp: {
    fontSize: 32,
    fontWeight: '800',
    color: '#fff',
  },
  doDetailHeroMeta: {
    fontSize: 12,
    color: '#bfdbfe',
    marginTop: 6,
    lineHeight: 18,
  },
  doDetailHeroDelta: {
    fontSize: 12,
    fontWeight: '800',
    marginTop: 4,
    lineHeight: 16,
  },
  doDetailCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginHorizontal: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  doDetailSectionTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#003580',
    marginBottom: 8,
  },
  photoMetaLine: {
    fontSize: 12,
    color: '#475569',
    lineHeight: 18,
    marginBottom: 6,
  },
  reportsModeRow: {
    flexDirection: 'row',
    marginTop: 6,
    gap: 5,
    flexWrap: 'wrap',
  },
  reportsModeChip: {
    flexGrow: 1,
    flexBasis: '22%',
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
  },
  reportsModeChipActive: {
    backgroundColor: '#003580',
  },
  reportsModeChipText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#475569',
  },
  reportsModeChipTextActive: {
    color: '#ffffff',
  },
  reportsContentArea: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  doFilterPanel: {
    backgroundColor: '#fff',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  doFilterRow: {
    flexDirection: 'row',
    gap: 6,
  },
  reportsListBody: {
    padding: 8,
    paddingBottom: 88,
    flexGrow: 1,
  },
  reportsCenterState: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 8,
  },
  reportsStateText: {
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 18,
  },
  reportsRetryBtn: {
    marginTop: 8,
    backgroundColor: '#003580',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  reportsRetryText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 12,
  },
  sliderOuterContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    marginHorizontal: 8,
    marginBottom: 6,
    marginTop: 2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 5,
  },
  overviewSliderWrap: {
    marginHorizontal: 0,
    marginTop: 0,
    marginBottom: 10,
    flex: 1,
  },
  sliderScroll: {
    paddingRight: 6,
  },
  sliderCard: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: '#f8fafc',
    marginRight: 5,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  sliderCardActive: {
    backgroundColor: '#003580',
    borderColor: '#003580',
  },
  sliderDayName: {
    fontSize: 8,
    fontWeight: 'bold',
    color: '#64748b',
    textTransform: 'uppercase',
  },
  sliderDayNum: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#0f172a',
    marginTop: 1,
  },
  sliderTextActive: {
    color: '#ffffff',
  },
  sliderCalendarBtn: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 8,
    borderLeftWidth: 1,
    borderLeftColor: '#e2e8f0',
    width: 44,
  },
  sliderCalendarBtnText: {
    fontSize: 8,
    fontWeight: 'bold',
    color: '#003580',
    marginTop: 1,
  },
  logsSliderOuter: {
    marginHorizontal: 8,
    marginTop: 2,
    marginBottom: 4,
    padding: 4,
    borderRadius: 8,
  },
  logsSliderCard: {
    width: 34,
    height: 34,
    marginRight: 4,
    borderRadius: 5,
  },
  logsSliderDayName: {
    fontSize: 7,
  },
  logsSliderDayNum: {
    fontSize: 11,
    marginTop: 0,
  },
  logsSliderCalendarBtn: {
    width: 38,
    paddingLeft: 6,
  },
  logsSliderCalendarBtnText: {
    fontSize: 7,
    marginTop: 0,
  },
});

