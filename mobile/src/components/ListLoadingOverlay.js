import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';

/**
 * WHAT: Semi-transparent spinner card over a list that already has rows.
 * WHY: Refresh should not replace the whole list with a blank loading screen.
 * HOW: Absolute overlay with pointerEvents none so scrolling still works underneath.
 */
export default function ListLoadingOverlay({ visible, label = 'Loading…' }) {
  if (!visible) return null;
  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={styles.card}>
        <ActivityIndicator size="small" color="#003580" />
        <Text style={styles.label}>{label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(248, 250, 252, 0.55)',
    zIndex: 20,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#0f172a',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
  },
});
