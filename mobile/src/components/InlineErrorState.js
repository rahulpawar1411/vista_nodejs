import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import FastTouchable from './FastTouchable';

const TouchableOpacity = FastTouchable;

/**
 * WHAT: Centered error message with optional Retry button for failed fetches.
 * WHY: Customer/Sub-Admin lists should recover without leaving the screen.
 * HOW: Shows icon + message; calls onRetry when the user taps Retry.
 */
export default function InlineErrorState({
  message,
  onRetry,
  retryLabel = 'Retry',
  icon = 'cloud-offline-outline'
}) {
  if (!message) return null;
  return (
    <View style={styles.wrap}>
      <Ionicons name={icon} size={28} color="#dc2626" />
      <Text style={styles.text}>{message}</Text>
      {onRetry ? (
        <TouchableOpacity style={styles.btn} onPress={onRetry} activeOpacity={0.85}>
          <Text style={styles.btnText}>{retryLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 28,
    paddingHorizontal: 20,
    gap: 10
  },
  text: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 19
  },
  btn: {
    marginTop: 4,
    backgroundColor: '#003580',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 9
  },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 13 }
});
