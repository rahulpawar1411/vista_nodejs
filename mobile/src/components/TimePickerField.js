/**
 * TimePickerField — scroll wheel time picker for HH:mm fields.
 * WHAT: Opens a compact popup to pick hour and minute in 24-hour format.
 * WHY: Dock forms need consistent time entry on iOS and Android.
 * HOW: value/onChange as "HH:mm" strings; parses optional date prefix in stored values.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  ScrollView,
  StyleSheet,
  Platform,
  Dimensions,
  Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import FastTouchable from './FastTouchable';

const TouchableOpacity = FastTouchable;

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
const POPUP_W = 248;
const POPUP_BASE_H = 72;
const POPUP_GAP = 6;
const ROW_H = 34;
const LIST_H = ROW_H * 5;
const SELECT_W = 78;

const WP = {
  border: '#c3c4c7',
  borderFocus: '#2271b1',
  bg: '#fff',
  bgInput: '#fff',
  bgHover: '#f6f7f7',
  text: '#1d2327',
  muted: '#646970',
  primary: '#2271b1',
};

function parseTimeHHMM(value) {
  const raw = String(value || '').trim();
  if (!raw) return { hour: '00', minute: '00' };
  const part = raw.includes(' ') ? raw.split(/\s+/).pop() : raw;
  const [h = '00', m = '00'] = part.split(':');
  return {
    hour: String(Math.min(23, Math.max(0, parseInt(h, 10) || 0))).padStart(2, '0'),
    minute: String(Math.min(59, Math.max(0, parseInt(m, 10) || 0))).padStart(2, '0'),
  };
}

function formatTime24(h, m) {
  return `${h}:${m}`;
}

function MiniSelect({ value, options, onChange, open, onOpen, label }) {
  const listRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const idx = Math.max(0, options.indexOf(value));
    const offset = Math.max(0, idx * ROW_H - ROW_H * 2);
    setTimeout(() => {
      listRef.current?.scrollTo({ y: offset, animated: false });
    }, 50);
  }, [open, value, options]);

  return (
    <View style={styles.selectCol}>
      <Text style={styles.selectColLabel}>{label}</Text>
      <TouchableOpacity
        style={[styles.selectBox, open && styles.selectBoxOpen]}
        onPress={onOpen}
        activeOpacity={0.9}
      >
        <Text style={styles.selectValue}>{value}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={WP.muted} />
      </TouchableOpacity>
      {open ? (
        <View style={styles.selectList}>
          <ScrollView
            ref={listRef}
            style={{ height: LIST_H }}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
          >
            {options.map((opt) => (
              <TouchableOpacity
                key={opt}
                style={[styles.selectOption, opt === value && styles.selectOptionActive]}
                onPress={() => onChange(opt)}
              >
                <Text style={[styles.selectOptionText, opt === value && styles.selectOptionTextActive]}>
                  {opt}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

/** WHAT: Controlled time field + hour/minute popup. WHY/HOW: See file header. */
export default function TimePickerField({
  label,
  value,
  onChange,
  required = false,
  invalid = false,
  placeholder = 'Select time',
}) {
  const parsed = parseTimeHHMM(value);
  const [open, setOpen] = useState(false);
  const [draftHour, setDraftHour] = useState(parsed.hour);
  const [draftMinute, setDraftMinute] = useState(parsed.minute);
  const [hourOpen, setHourOpen] = useState(false);
  const [minuteOpen, setMinuteOpen] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const triggerRef = useRef(null);

  const listOpen = hourOpen || minuteOpen;
  const popupHeight = POPUP_BASE_H + (listOpen ? LIST_H + 28 : 0);
  const display = value ? formatTime24(parsed.hour, parsed.minute) : '';

  const openPicker = () => {
    const p = parseTimeHHMM(value);
    setDraftHour(p.hour);
    setDraftMinute(p.minute);
    setHourOpen(false);
    setMinuteOpen(false);

    triggerRef.current?.measureInWindow((x, y, width, height) => {
      const screenW = Dimensions.get('window').width;
      let top = y - popupHeight - POPUP_GAP;
      const above = top >= 8;
      if (!above) top = y + height + POPUP_GAP;
      let left = x + width / 2 - POPUP_W / 2;
      left = Math.max(8, Math.min(left, screenW - POPUP_W - 8));

      setAnchor({ top, left, above });
      setOpen(true);
    });
  };

  const closeAll = () => {
    setOpen(false);
    setHourOpen(false);
    setMinuteOpen(false);
  };

  const apply = () => {
    onChange(formatTime24(draftHour, draftMinute));
    closeAll();
  };

  const popupPos = anchor
    ? { top: anchor.top, left: anchor.left }
    : { top: '30%', left: '50%', marginLeft: -POPUP_W / 2 };

  return (
    <View style={styles.wrap}>
      {label ? (
        <Text style={[styles.label, invalid && styles.labelInvalid]}>
          {label}
          {required ? <Text style={styles.req}> *</Text> : null}
        </Text>
      ) : null}

      <View ref={triggerRef} collapsable={false}>
        <TouchableOpacity
          style={[styles.input, invalid && styles.inputInvalid, open && styles.inputFocus]}
          onPress={openPicker}
          activeOpacity={0.95}
        >
          <Text style={[styles.inputText, !display && styles.placeholder]} numberOfLines={1}>
            {display || placeholder}
          </Text>
          {String(value || '').trim() ? (
            <Ionicons name="checkmark-circle" size={16} color="#16a34a" />
          ) : null}
        </TouchableOpacity>
      </View>

      <Modal visible={open} transparent animationType="fade" onRequestClose={closeAll}>
        <Pressable style={styles.backdrop} onPress={closeAll}>
          <Pressable
            style={[styles.popup, popupPos, listOpen && { minHeight: popupHeight }]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.popupInner}>
              <View style={styles.topRow}>
                <Text style={styles.preview}>{formatTime24(draftHour, draftMinute)}</Text>
                <TouchableOpacity style={styles.okBtn} onPress={apply}>
                  <Text style={styles.okBtnText}>OK</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.row}>
                <MiniSelect
                  label="Hour"
                  value={draftHour}
                  options={HOURS}
                  open={hourOpen}
                  onOpen={() => {
                    setHourOpen(true);
                    setMinuteOpen(false);
                  }}
                  onChange={(h) => {
                    setDraftHour(h);
                    setHourOpen(false);
                  }}
                />
                <Text style={styles.sep}>:</Text>
                <MiniSelect
                  label="Min"
                  value={draftMinute}
                  options={MINUTES}
                  open={minuteOpen}
                  onOpen={() => {
                    setMinuteOpen(true);
                    setHourOpen(false);
                  }}
                  onChange={(m) => {
                    setDraftMinute(m);
                    setMinuteOpen(false);
                  }}
                />
              </View>

              {!listOpen ? <Text style={styles.hint}>Tap Hour or Min · 24h</Text> : null}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: WP.text,
    marginBottom: 4,
  },
  labelInvalid: {
    color: '#d63638',
  },
  req: {
    color: '#d63638',
  },
  input: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 30,
    paddingHorizontal: 8,
    paddingVertical: Platform.OS === 'ios' ? 7 : 5,
    backgroundColor: WP.bgInput,
    borderWidth: 1,
    borderColor: WP.border,
    borderRadius: 3,
  },
  inputFocus: {
    borderColor: WP.borderFocus,
  },
  inputInvalid: {
    borderColor: '#d63638',
  },
  inputText: {
    flex: 1,
    fontSize: 13,
    color: WP.text,
    fontVariant: ['tabular-nums'],
    marginRight: 6,
  },
  placeholder: {
    color: WP.muted,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  popup: {
    position: 'absolute',
    width: POPUP_W,
    backgroundColor: WP.bg,
    borderWidth: 1,
    borderColor: WP.border,
    borderRadius: 4,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.14,
        shadowRadius: 6,
      },
      android: { elevation: 8 },
    }),
  },
  popupInner: {
    padding: 10,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#dcdcde',
  },
  preview: {
    fontSize: 18,
    fontWeight: '700',
    color: WP.primary,
    fontVariant: ['tabular-nums'],
  },
  okBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 3,
    backgroundColor: WP.primary,
  },
  okBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#fff',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 6,
  },
  sep: {
    fontSize: 18,
    fontWeight: '700',
    color: WP.muted,
    marginTop: 28,
  },
  selectCol: {
    width: SELECT_W,
    flex: 1,
    maxWidth: SELECT_W,
  },
  selectColLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: WP.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  selectBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 32,
    paddingHorizontal: 8,
    backgroundColor: WP.bg,
    borderWidth: 1,
    borderColor: WP.border,
    borderRadius: 3,
  },
  selectBoxOpen: {
    borderColor: WP.borderFocus,
    backgroundColor: '#f0f6fc',
  },
  selectValue: {
    fontSize: 15,
    color: WP.text,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  selectList: {
    marginTop: 6,
    backgroundColor: WP.bg,
    borderWidth: 1,
    borderColor: WP.border,
    borderRadius: 3,
  },
  selectOption: {
    height: ROW_H,
    justifyContent: 'center',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f0f0f1',
  },
  selectOptionActive: {
    backgroundColor: WP.bgHover,
  },
  selectOptionText: {
    fontSize: 15,
    color: WP.text,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  selectOptionTextActive: {
    color: WP.primary,
    fontWeight: '800',
  },
  hint: {
    fontSize: 11,
    color: WP.muted,
    marginTop: 8,
    textAlign: 'center',
  },
});
