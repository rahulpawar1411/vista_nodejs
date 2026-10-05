/**
 * DatePickerField — calendar modal for YYYY-MM-DD form fields.
 * WHAT: Tappable field that opens a month grid to pick a date.
 * WHY: Native date inputs vary; one consistent picker for inward/outward forms.
 * HOW: value/onChange as YYYY-MM-DD strings; minDate disables earlier days.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, Modal, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import FastTouchable from './FastTouchable';

const TouchableOpacity = FastTouchable;

const WEEK_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dateToYYYYMMDD(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseYYYYMMDD(value) {
  if (!value || !String(value).includes('-')) return null;
  const parts = String(value).split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  const [yyyy, mm, dd] = parts;
  const d = new Date(yyyy, mm - 1, dd);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDisplayDate(value) {
  const d = parseYYYYMMDD(value);
  if (!d) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function getCalendarDays(dateObj) {
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
}

/** WHAT: Controlled date field + calendar modal. WHY/HOW: See file header; wires label/value/onChange. */
export default function DatePickerField({
  label,
  value,
  onChange,
  required = false,
  invalid = false,
  minDate = '',
  placeholder = 'Select date',
}) {
  const [open, setOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => parseYYYYMMDD(value) || new Date());

  const monthName = calendarMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
  const days = useMemo(() => getCalendarDays(calendarMonth), [calendarMonth]);
  const todayStr = dateToYYYYMMDD(new Date());
  const display = value ? formatDisplayDate(value) : placeholder;

  const openCalendar = () => {
    setCalendarMonth(parseYYYYMMDD(value) || new Date());
    setOpen(true);
  };

  const handleSelect = (dateObj) => {
    const picked = dateToYYYYMMDD(dateObj);
    if (minDate && picked < minDate) return;
    onChange(picked);
    setOpen(false);
  };

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, invalid && styles.labelInvalid]}>
        {label}
        {required ? <Text style={styles.reqStar}> *</Text> : null}
      </Text>
      <TouchableOpacity
        style={[styles.trigger, invalid && styles.triggerInvalid]}
        onPress={openCalendar}
        activeOpacity={0.8}
      >
        <Ionicons name="calendar-outline" size={18} color="#003580" />
        <Text
          style={[styles.triggerText, !value && styles.triggerPlaceholder]}
          numberOfLines={1}
        >
          {display}
        </Text>
        {value ? <Ionicons name="checkmark-circle" size={18} color="#16a34a" /> : null}
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.overlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{label}</Text>
            {minDate ? (
              <Text style={styles.modalHint}>Earliest: {formatDisplayDate(minDate)}</Text>
            ) : null}

            <View style={styles.monthRow}>
              <TouchableOpacity
                onPress={() => {
                  const prev = new Date(calendarMonth);
                  prev.setMonth(prev.getMonth() - 1);
                  setCalendarMonth(prev);
                }}
              >
                <Ionicons name="chevron-back" size={22} color="#003580" />
              </TouchableOpacity>
              <Text style={styles.monthText}>{monthName}</Text>
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

            <View style={styles.weekRow}>
              {WEEK_DAYS.map((d) => (
                <Text key={d} style={styles.weekDay}>
                  {d[0]}
                </Text>
              ))}
            </View>

            <View style={styles.daysGrid}>
              {days.map((d, index) => {
                if (!d) {
                  return <View key={`empty-${index}`} style={styles.dayCell} />;
                }
                const dateStr = dateToYYYYMMDD(d);
                const isSelected = dateStr === value;
                const isToday = dateStr === todayStr;
                const isDisabled = minDate && dateStr < minDate;

                return (
                  <TouchableOpacity
                    key={dateStr}
                    style={[
                      styles.dayCell,
                      isSelected && styles.dayCellSelected,
                      isToday && !isSelected && styles.dayCellToday,
                      isDisabled && styles.dayCellDisabled,
                    ]}
                    onPress={() => !isDisabled && handleSelect(d)}
                    disabled={isDisabled}
                  >
                    <Text
                      style={[
                        styles.dayText,
                        isSelected && styles.dayTextSelected,
                        isDisabled && styles.dayTextDisabled,
                      ]}
                    >
                      {d.getDate()}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity style={styles.closeBtn} onPress={() => setOpen(false)}>
              <Text style={styles.closeBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: 8,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: '#475569',
    marginBottom: 4,
  },
  labelInvalid: {
    color: '#dc2626',
  },
  reqStar: {
    color: '#ef4444',
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'ios' ? 8 : 7,
  },
  triggerInvalid: {
    borderColor: '#fca5a5',
    backgroundColor: '#fef2f2',
  },
  triggerText: {
    flex: 1,
    fontSize: 13,
    color: '#0f172a',
    fontWeight: '500',
  },
  triggerPlaceholder: {
    color: '#94a3b8',
    fontWeight: '400',
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 4,
  },
  modalHint: {
    fontSize: 11,
    color: '#64748b',
    marginBottom: 12,
  },
  monthRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  monthText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
  },
  weekRow: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  weekDay: {
    width: '14.28%',
    textAlign: 'center',
    fontSize: 10,
    color: '#64748b',
    fontWeight: '700',
  },
  daysGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  dayCell: {
    width: '14.28%',
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
  },
  dayCellSelected: {
    backgroundColor: '#003580',
  },
  dayCellToday: {
    borderWidth: 1,
    borderColor: '#93c5fd',
  },
  dayCellDisabled: {
    opacity: 0.35,
  },
  dayText: {
    fontSize: 13,
    color: '#0f172a',
    fontWeight: '500',
  },
  dayTextSelected: {
    color: '#fff',
    fontWeight: '700',
  },
  dayTextDisabled: {
    color: '#94a3b8',
  },
  closeBtn: {
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 20,
  },
  closeBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#003580',
  },
});
