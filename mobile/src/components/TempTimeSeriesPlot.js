/**
 * TempTimeSeriesPlot — scrollable temperature chart for Customer reports.
 * WHAT: Line chart of chamber readings over days with compliance band shading.
 * WHY: Customers visualize cold-chain performance without exporting spreadsheets.
 * HOW: Maps points to canvas coordinates; tap dots for Morning/Evening detail tooltips.
 */
import React, { useMemo, useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  ScrollView,
  Pressable
} from 'react-native';
import {
  getChamberTempDeviation,
  getChamberTempRange,
  normalizeChamberZone,
  pickComplianceZone,
  chamberZoneStyle
} from '../utils/dedupeInventoryLots';

const CHART_H = 200;
const Y_AXIS_W = 36; // fixed left scale −30…+30 — flush left
const PAD = { top: 12, right: 12, bottom: 26, left: 8 }; // scrollable plot padding
const POINT_GAP = 24;
const LINE_H = StyleSheet.hairlineWidth;
const DOT = 5;
const HIT = 28;
const TIP_W = 96;

const Y_MIN = -30;
const Y_MAX = 30;
const Y_TICK_STEP = 5;

const ZONE_ORDER = ['Frozen', 'Chilled', 'Dry', 'Other'];

function resolveZone(raw, fallback = '') {
  return (
    pickComplianceZone(raw) ||
    normalizeChamberZone(raw) ||
    pickComplianceZone(fallback) ||
    normalizeChamberZone(fallback) ||
    'Other'
  );
}

function zoneColor(zone) {
  return chamberZoneStyle(zone).color;
}

function zoneBg(zone) {
  return chamberZoneStyle(zone).bg;
}

function zoneLabel(zone) {
  return zone === 'Chilled' ? 'Chiller' : zone;
}

function toMs(dayKey, shift) {
  const base = String(dayKey || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return null;
  const hh = String(shift || '').toLowerCase().startsWith('eve') ? '18' : '09';
  const d = new Date(`${base}T${hh}:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

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

function formatDayLabel(dayKey) {
  const s = String(dayKey || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const [, m, d] = s.split('-');
  return `${d}/${m}`;
}

function formatMonthDayLabel(dayKey) {
  const s = String(dayKey || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const day = Number(s.slice(8, 10));
  return Number.isFinite(day) ? String(day) : '';
}

function formatMonthLabel(dayKey) {
  const s = String(dayKey || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const mi = Number(s.slice(5, 7)) - 1;
  if (mi < 0 || mi > 11) return '';
  return MONTH_SHORT[mi];
}

function formatFullDate(dayKey) {
  const s = String(dayKey || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const [y, m, d] = s.split('-');
  const mi = Number(m) - 1;
  return `${Number(d)} ${MONTH_SHORT[mi] || m} ${y}`;
}

function formatTemp(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return `${n % 1 === 0 ? n : n.toFixed(1)}°C`;
}

function formatBoxesShort(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return `${n % 1 === 0 ? n : n.toFixed(1)} bx`;
}

function monthKey(dayKey) {
  return String(dayKey || '').slice(0, 7);
}

function avgTemps(list) {
  if (!list.length) return null;
  const sum = list.reduce((a, b) => a + b, 0);
  return Math.round((sum / list.length) * 10) / 10;
}

/**
 * WHAT: Renders the chart given filtered temperature points and zone preset.
 * WHY: CustomerScreen passes server log rows after date/zone filters.
 * HOW: Computes plot width from point count; horizontal ScrollView for long ranges.
 */
export default function TempTimeSeriesPlot({
  points = [],
  selectedZone = 'Frozen',
  rangePreset = 'week',
  dateFrom = '',
  dateTo = '',
  title = 'Temperature over time',
  emptyLabel = 'No temperature readings in this range.'
}) {
  const activeZone = ZONE_ORDER.includes(selectedZone) ? selectedZone : 'Frozen';
  const band = useMemo(() => getChamberTempRange(activeZone), [activeZone]);
  const lineColor = zoneColor(activeZone);
  const byMonth = rangePreset === 'year';
  const byMonthDay = rangePreset === 'month' || rangePreset === 'week';

  const [selectedIdx, setSelectedIdx] = useState(null);
  const skipDismissRef = useRef(false);

  const dayShifts = useMemo(() => {
    const map = new Map();
    (Array.isArray(points) ? points : []).forEach((p) => {
      if (String(p.status || '').toLowerCase() === 'pending') return;
      if (p.temp == null || p.temp === '') return;
      const temp = Number(p.temp);
      if (!Number.isFinite(temp)) return;
      const dayKey = String(p.dayKey || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return;
      const zone = resolveZone(p.chamberType || p.sourceLog?.chamber_type, '');
      if (zone !== activeZone) return;
      const shift = String(p.shift || '').toLowerCase().startsWith('eve')
        ? 'Evening'
        : 'Morning';
      const boxRaw = p.boxCount ?? p.box_count ?? p.sourceLog?.box_count ?? null;
      const boxNum =
        boxRaw == null || boxRaw === '' ? null : Number(boxRaw);
      const boxes = boxNum != null && Number.isFinite(boxNum) ? boxNum : null;
      let row = map.get(dayKey);
      if (!row) {
        row = {
          dayKey,
          morning: [],
          evening: [],
          morningBoxes: [],
          eveningBoxes: [],
          clients: new Set()
        };
        map.set(dayKey, row);
      }
      const clientName = String(
        p.client || p.client_name || p.sourceLog?.client_name || ''
      ).trim();
      if (clientName) row.clients.add(clientName);
      if (shift === 'Evening') {
        row.evening.push(temp);
        if (boxes != null) row.eveningBoxes.push(boxes);
      } else {
        row.morning.push(temp);
        if (boxes != null) row.morningBoxes.push(boxes);
      }
    });
    const sumBoxes = (list) => {
      if (!list.length) return null;
      return list.reduce((a, b) => a + b, 0);
    };
    const out = new Map();
    map.forEach((row, key) => {
      const clients = Array.from(row.clients);
      out.set(key, {
        dayKey: key,
        morning: avgTemps(row.morning),
        evening: avgTemps(row.evening),
        morningBoxes: sumBoxes(row.morningBoxes),
        eveningBoxes: sumBoxes(row.eveningBoxes),
        clients,
        clientLabel:
          clients.length === 0
            ? null
            : clients.length === 1
              ? clients[0]
              : `${clients[0]} +${clients.length - 1}`
      });
    });
    return out;
  }, [points, activeZone]);

  const dayMarkers = useMemo(() => {
    const rows = [];
    dayShifts.forEach((row) => {
      if (row.morning == null) return;
      const ms = toMs(row.dayKey, 'Morning');
      if (ms == null) return;
      const deviation = getChamberTempDeviation(row.morning, activeZone);
      rows.push({
        key: row.dayKey,
        dayKey: row.dayKey,
        ms,
        temp: row.morning,
        outOfRange: Boolean(deviation),
        empty: false,
        morning: row.morning,
        evening: row.evening,
        morningBoxes: row.morningBoxes,
        eveningBoxes: row.eveningBoxes,
        clientLabel: row.clientLabel,
        clients: row.clients
      });
    });
    return rows.sort((a, b) => a.ms - b.ms);
  }, [dayShifts, activeZone]);

  const markers = useMemo(() => {
    if (byMonth) {
      const buckets = new Map();
      dayMarkers.forEach((r) => {
        const mk = monthKey(r.dayKey);
        if (!/^\d{4}-\d{2}$/.test(mk)) return;
        const prev = buckets.get(mk);
        if (!prev) {
          buckets.set(mk, {
            key: mk,
            dayKey: `${mk}-01`,
            ms: toMs(`${mk}-01`, 'Morning'),
            mornings: r.morning != null ? [r.morning] : [],
            evenings: r.evening != null ? [r.evening] : [],
            morningBoxes: r.morningBoxes != null ? r.morningBoxes : 0,
            eveningBoxes: r.eveningBoxes != null ? r.eveningBoxes : 0,
            hasMorningBoxes: r.morningBoxes != null,
            hasEveningBoxes: r.eveningBoxes != null,
            clients: new Set(r.clients || []),
            outOfRange: r.outOfRange
          });
        } else {
          if (r.morning != null) prev.mornings.push(r.morning);
          if (r.evening != null) prev.evenings.push(r.evening);
          if (r.morningBoxes != null) {
            prev.morningBoxes += r.morningBoxes;
            prev.hasMorningBoxes = true;
          }
          if (r.eveningBoxes != null) {
            prev.eveningBoxes += r.eveningBoxes;
            prev.hasEveningBoxes = true;
          }
          (r.clients || []).forEach((c) => prev.clients.add(c));
          prev.outOfRange = prev.outOfRange || r.outOfRange;
        }
      });
      return Array.from(buckets.values())
        .map((b) => {
          const morning = avgTemps(b.mornings);
          const evening = avgTemps(b.evenings);
          const clients = Array.from(b.clients || []);
          return {
            key: b.key,
            dayKey: b.dayKey,
            ms: b.ms,
            temp: morning,
            outOfRange: b.outOfRange,
            empty: morning == null,
            morning,
            evening,
            morningBoxes: b.hasMorningBoxes ? b.morningBoxes : null,
            eveningBoxes: b.hasEveningBoxes ? b.eveningBoxes : null,
            clientLabel:
              clients.length === 0
                ? null
                : clients.length === 1
                  ? clients[0]
                  : `${clients[0]} +${clients.length - 1}`
          };
        })
        .filter((b) => !b.empty)
        .sort((a, b) => a.ms - b.ms);
    }

    if (byMonthDay) {
      let from = String(dateFrom || '').slice(0, 10);
      let to = String(dateTo || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return dayMarkers;
      }
      if (rangePreset === 'month') {
        const y = Number(from.slice(0, 4));
        const m = Number(from.slice(5, 7));
        if (y && m) {
          const last = new Date(y, m, 0).getDate();
          const mm = String(m).padStart(2, '0');
          from = `${y}-${mm}-01`;
          to = `${y}-${mm}-${String(last).padStart(2, '0')}`;
        }
      }
      const byDay = new Map(dayMarkers.map((r) => [r.dayKey, r]));
      const out = [];
      const cursor = new Date(`${from}T12:00:00`);
      const end = new Date(`${to}T12:00:00`);
      if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return dayMarkers;
      while (cursor <= end) {
        const yy = cursor.getFullYear();
        const mo = String(cursor.getMonth() + 1).padStart(2, '0');
        const dd = String(cursor.getDate()).padStart(2, '0');
        const dayKey = `${yy}-${mo}-${dd}`;
        const hit = byDay.get(dayKey);
        const shiftHit = dayShifts.get(dayKey);
        const ms = toMs(dayKey, 'Morning');
        if (hit) {
          out.push({
            ...hit,
            empty: false,
            morning: hit.morning ?? shiftHit?.morning ?? null,
            evening: hit.evening ?? shiftHit?.evening ?? null,
            morningBoxes: hit.morningBoxes ?? shiftHit?.morningBoxes ?? null,
            eveningBoxes: hit.eveningBoxes ?? shiftHit?.eveningBoxes ?? null,
            clientLabel: hit.clientLabel ?? shiftHit?.clientLabel ?? null
          });
        } else {
          out.push({
            key: dayKey,
            dayKey,
            ms,
            temp: null,
            outOfRange: false,
            empty: true,
            morning: shiftHit?.morning ?? null,
            evening: shiftHit?.evening ?? null,
            morningBoxes: shiftHit?.morningBoxes ?? null,
            eveningBoxes: shiftHit?.eveningBoxes ?? null,
            clientLabel: shiftHit?.clientLabel ?? null
          });
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      return out;
    }

    return dayMarkers;
  }, [dayMarkers, dayShifts, byMonth, byMonthDay, dateFrom, dateTo, rangePreset]);

  useEffect(() => {
    setSelectedIdx(null);
  }, [markers, activeZone, rangePreset]);

  const screenW = Dimensions.get('window').width - 48;
  const scrollAreaW = Math.max(80, screenW - Y_AXIS_W);
  const plotW = Math.max(
    scrollAreaW,
    PAD.left + PAD.right + Math.max(1, markers.length) * POINT_GAP
  );
  const innerW = Math.max(40, plotW - PAD.left - PAD.right);
  const innerH = CHART_H - PAD.top - PAD.bottom;

  const layout = useMemo(() => {
    const yMin = Y_MIN;
    const yMax = Y_MAX;
    const n = Math.max(1, markers.length);
    const xOfIdx = (idx) =>
      PAD.left + (n <= 1 ? innerW / 2 : (idx / (n - 1)) * innerW);
    const yOf = (v) => {
      const clamped = Math.min(yMax, Math.max(yMin, Number(v)));
      return PAD.top + ((yMax - clamped) / (yMax - yMin)) * innerH;
    };
    const yTicks = [];
    for (let t = yMin; t <= yMax + 0.001; t += Y_TICK_STEP) {
      yTicks.push(t);
    }
    return { xOfIdx, yOf, yTicks, yMin, yMax };
  }, [markers.length, innerW, innerH]);

  const filledMarkers = useMemo(
    () => markers.filter((m) => !m.empty && m.temp != null),
    [markers]
  );

  const segments = useMemo(() => {
    const out = [];
    const filledIdx = [];
    markers.forEach((m, i) => {
      if (!m.empty && m.temp != null) filledIdx.push(i);
    });
    for (let k = 0; k < filledIdx.length - 1; k += 1) {
      const i = filledIdx[k];
      const j = filledIdx[k + 1];
      const a = markers[i];
      const b = markers[j];
      const x1 = layout.xOfIdx(i);
      const y1 = layout.yOf(a.temp);
      const x2 = layout.xOfIdx(j);
      const y2 = layout.yOf(b.temp);
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      out.push({
        key: `seg-${i}-${j}`,
        left: (x1 + x2) / 2 - len / 2,
        top: (y1 + y2) / 2 - LINE_H / 2,
        width: Math.max(1, len),
        angle,
        color: lineColor
      });
    }
    return out;
  }, [markers, layout, lineColor]);

  const active = selectedIdx != null ? markers[selectedIdx] : null;
  const showTip =
    active &&
    !active.empty &&
    (active.morning != null || active.evening != null || active.temp != null);

  const tipX = selectedIdx != null ? layout.xOfIdx(selectedIdx) : null;
  const tipLeft =
    tipX == null
      ? 0
      : Math.min(
          Math.max(4, tipX - TIP_W / 2),
          Math.max(4, plotW - TIP_W - 4)
        );

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.sub}>
            {filledMarkers.length
              ? `${filledMarkers.length} ${zoneLabel(activeZone)} ${
                  byMonth ? 'month' : 'day'
                } reading${filledMarkers.length === 1 ? '' : 's'}${band ? ` · ${band.label}` : ''} · tap dot`
              : `${zoneLabel(activeZone)} ${byMonth ? 'yearly' : 'daily'} temperature · −30…+30°C`}
          </Text>
        </View>
        <Text style={[styles.unitBadge, { color: lineColor, backgroundColor: zoneBg(activeZone) }]}>
          °C
        </Text>
      </View>

      {!filledMarkers.length ? (
        <Text style={styles.empty}>{emptyLabel}</Text>
      ) : (
        <View style={styles.chartRow}>
          {/* Fixed Y scale −30…+30 */}
          <View style={[styles.yAxis, { width: Y_AXIS_W, height: CHART_H }]}>
            {layout.yTicks.map((v, i) => (
              <Text
                key={`yl-${i}`}
                style={[
                  styles.axisY,
                  {
                    top: layout.yOf(v) - 7,
                    width: Y_AXIS_W - 2
                  }
                ]}
              >
                {`${v > 0 ? '+' : ''}${v}°C`}
              </Text>
            ))}
          </View>

          <ScrollView
            horizontal
            style={{ flex: 1 }}
            showsHorizontalScrollIndicator
            bounces={false}
            contentContainerStyle={{ paddingBottom: 2 }}
          >
            <View style={[styles.plot, { width: plotW, height: CHART_H }]}>
              {/* Tap empty chart area to dismiss popup */}
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={() => {
                  if (skipDismissRef.current) return;
                  setSelectedIdx(null);
                }}
              />

              {/* Cyan theme only below 0°C (bottom side) */}
              <View
                pointerEvents="none"
                style={[
                  styles.band,
                  {
                    left: PAD.left,
                    width: innerW,
                    top: layout.yOf(0),
                    height: Math.max(0, layout.yOf(Y_MIN) - layout.yOf(0))
                  }
                ]}
              />

              {layout.yTicks.map((v, i) => (
                <View
                  key={`yg-${i}`}
                  pointerEvents="none"
                  style={[
                    styles.gridH,
                    {
                      left: PAD.left,
                      width: innerW,
                      top: layout.yOf(v)
                    }
                  ]}
                />
              ))}

              {markers.map((slot, idx) => {
                const x = layout.xOfIdx(idx);
                return (
                  <View
                    key={`vg-${slot.key}`}
                    pointerEvents="none"
                    style={[
                      styles.gridV,
                      {
                        left: x,
                        top: PAD.top,
                        height: innerH
                      }
                    ]}
                  />
                );
              })}

              {segments.map((s) => (
                <View
                  key={s.key}
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    left: s.left,
                    top: s.top,
                    width: s.width,
                    height: LINE_H,
                    backgroundColor: s.color,
                    transform: [{ rotate: `${s.angle}deg` }]
                  }}
                />
              ))}

              {markers.map((m, idx) => {
                if (m.empty || m.temp == null) return null;
                const x = layout.xOfIdx(idx);
                const y = layout.yOf(m.temp);
                const selected = selectedIdx === idx;
                const size = selected ? DOT + 3 : DOT;
                return (
                  <View key={`pt-${m.key}`} pointerEvents="box-none">
                    <Text
                      pointerEvents="none"
                      style={[
                        styles.tempLabel,
                        {
                          left: x - 14,
                          top: y - 16,
                          color: m.outOfRange ? '#c2410c' : lineColor,
                          fontWeight: selected ? '900' : '800'
                        }
                      ]}
                      numberOfLines={1}
                    >
                      {m.temp % 1 === 0 ? m.temp : Number(m.temp).toFixed(1)}
                    </Text>
                    <Pressable
                      onPress={() => {
                        skipDismissRef.current = true;
                        setSelectedIdx((prev) => (prev === idx ? null : idx));
                        setTimeout(() => {
                          skipDismissRef.current = false;
                        }, 50);
                      }}
                      hitSlop={10}
                      style={[
                        styles.dotHit,
                        {
                          left: x - HIT / 2,
                          top: y - HIT / 2,
                          width: HIT,
                          height: HIT,
                          zIndex: 12
                        }
                      ]}
                    >
                      <View
                        style={[
                          styles.dot,
                          {
                            width: size,
                            height: size,
                            borderRadius: size / 2,
                            backgroundColor: m.outOfRange ? '#ea580c' : lineColor
                          }
                        ]}
                      />
                    </Pressable>
                  </View>
                );
              })}

              {showTip && tipX != null ? (
                <View
                  pointerEvents="none"
                  style={[
                    styles.tipBox,
                    {
                      left: tipLeft,
                      top: 4,
                      borderColor: lineColor
                    }
                  ]}
                >
                  <Text style={styles.tipDate} numberOfLines={1}>
                    {byMonth
                      ? `${formatMonthLabel(active.dayKey)} ${String(active.dayKey).slice(0, 4)}`
                      : formatFullDate(active.dayKey)}
                  </Text>
                  {active.clientLabel ? (
                    <Text style={styles.tipClient} numberOfLines={1}>
                      {active.clientLabel}
                    </Text>
                  ) : null}
                  <Text style={[styles.tipRow, { color: lineColor }]} numberOfLines={1}>
                    {`M ${formatTemp(active.morning ?? (byMonth ? active.temp : null))} · ${formatBoxesShort(active.morningBoxes)}`}
                  </Text>
                  <Text style={[styles.tipRow, { color: '#475569' }]} numberOfLines={1}>
                    {`E ${formatTemp(active.evening)} · ${formatBoxesShort(active.eveningBoxes)}`}
                  </Text>
                </View>
              ) : null}

              {markers.map((slot, idx) => {
                const x = layout.xOfIdx(idx);
                const label = byMonth
                  ? formatMonthLabel(slot.dayKey)
                  : byMonthDay
                    ? formatMonthDayLabel(slot.dayKey)
                    : formatDayLabel(slot.dayKey);
                return (
                  <Text
                    key={`xlabel-${slot.key}`}
                    style={[
                      styles.axisX,
                      {
                        left: x - (byMonth ? 14 : byMonthDay ? 10 : 16),
                        top: CHART_H - 22,
                        width: byMonth ? 28 : byMonthDay ? 20 : 32,
                        color: selectedIdx === idx ? lineColor : '#64748b',
                        fontWeight: selectedIdx === idx ? '800' : '700'
                      }
                    ]}
                    numberOfLines={1}
                  >
                    {label}
                  </Text>
                );
              })}
            </View>
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 12,
    marginBottom: 4,
    paddingTop: 12,
    paddingHorizontal: 10,
    paddingBottom: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
    overflow: 'hidden'
  },
  headRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 8,
    paddingHorizontal: 2
  },
  title: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a'
  },
  sub: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b'
  },
  unitBadge: {
    fontSize: 10,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999
  },
  empty: {
    paddingVertical: 22,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '600',
    color: '#94a3b8'
  },
  chartRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginHorizontal: -10 // pull Y-axis to card's full left edge
  },
  yAxis: {
    position: 'relative',
    backgroundColor: '#ffffff',
    zIndex: 2,
    paddingLeft: 2
  },
  plot: {
    position: 'relative',
    overflow: 'hidden'
  },
  band: {
    position: 'absolute',
    backgroundColor: 'rgba(20, 184, 166, 0.08)',
    borderRadius: 4
  },
  gridH: {
    position: 'absolute',
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#e8eef5'
  },
  gridV: {
    position: 'absolute',
    width: StyleSheet.hairlineWidth,
    backgroundColor: '#eef2f7'
  },
  axisY: {
    position: 'absolute',
    left: 2,
    fontSize: 8,
    fontWeight: '700',
    color: '#64748b',
    textAlign: 'left'
  },
  axisX: {
    position: 'absolute',
    fontSize: 8,
    fontWeight: '700',
    color: '#64748b',
    textAlign: 'center'
  },
  dotHit: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10
  },
  tempLabel: {
    position: 'absolute',
    width: 28,
    fontSize: 7,
    fontWeight: '800',
    textAlign: 'center',
    zIndex: 11
  },
  dot: {
    borderWidth: 1.5,
    borderColor: '#ffffff'
  },
  tipBox: {
    position: 'absolute',
    width: TIP_W,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    backgroundColor: '#ffffff',
    shadowColor: '#0f172a',
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
    zIndex: 20
  },
  tipDate: {
    fontSize: 8,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 1
  },
  tipClient: {
    fontSize: 8,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 2
  },
  tipRow: {
    fontSize: 9,
    fontWeight: '700',
    marginTop: 1
  }
});
