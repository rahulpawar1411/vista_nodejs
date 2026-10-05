import React from 'react';
import { View, Text, StyleSheet, Modal, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import FastTouchable from './FastTouchable';

const TouchableOpacity = FastTouchable;

/**
 * WHAT: Modal confirmation that an edit was saved successfully.
 * WHY: Gives clear feedback after master or assignment changes.
 * HOW: Transparent Modal with check icon and Done button calling onDone.
 */
export default function SavedChangesPopup({
  visible,
  title = 'Changes saved',
  message = 'Your updates were saved successfully.',
  doneLabel = 'Done',
  onDone
}) {
  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onDone}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Ionicons name="checkmark-circle" size={44} color="#059669" />
          </View>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          <TouchableOpacity style={styles.doneBtn} onPress={onDone} activeOpacity={0.85}>
            <Text style={styles.doneText}>{doneLabel}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28
  },
  card: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#fff',
    borderRadius: 18,
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: Platform.OS === 'ios' ? 20 : 16,
    alignItems: 'center'
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#ecfdf5',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12
  },
  title: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0f172a',
    textAlign: 'center'
  },
  message: {
    marginTop: 6,
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 18
  },
  doneBtn: {
    marginTop: 18,
    alignSelf: 'stretch',
    backgroundColor: '#003580',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center'
  },
  doneText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14
  }
});
