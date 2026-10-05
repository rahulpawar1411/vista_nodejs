/**
 * Log photo + GPS UI (src/components/LogDetailPhotoLocation.js).
 * WHAT: Reusable rows, grids, and full-screen preview for log photos with location.
 * WHY: Customer, DO, and Sub-Admin detail screens share the same photo/GPS presentation.
 * HOW: Composes formatPhotoGps helpers with tappable map links and ImagePreviewModal.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  Modal,
  StatusBar,
  SafeAreaView,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import FastTouchable from './FastTouchable';
import {
  formatPhotoGps,
  formatPhotoCaptureMetadataLines,
  formatPhotoMetaCaption,
  formatChamberPhotoGps,
  openLocationInMaps,
  resolvePhotoMetaEntry,
} from '../utils/customerLogReportHelpers';

const TouchableOpacity = FastTouchable;
const PREVIEW_H = Math.round(Dimensions.get('window').height * 0.78);

/** WHAT: Label + tappable GPS line for log detail screens. WHY: Open maps from audit coordinates. */
export function GpsDetailRow({ label, lat, lng, accuracy, displayText }) {
  const text =
    displayText ||
    formatChamberPhotoGps({
      photo_capture_latitude: lat,
      photo_capture_longitude: lng,
      photo_capture_accuracy: accuracy,
    });
  if (!text) return null;
  const hasGps =
    lat != null &&
    lng != null &&
    Number.isFinite(parseFloat(lat)) &&
    Number.isFinite(parseFloat(lng));

  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <TouchableOpacity
        onPress={() => openLocationInMaps(lat, lng)}
        disabled={!hasGps}
        activeOpacity={hasGps ? 0.75 : 1}
        style={styles.linkWrap}
      >
        <Text style={[styles.value, hasGps && styles.linkActive]}>
          {text}
          {hasGps ? '  ↗' : ''}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

/** WHAT: Small time/location caption under a captured form photo. WHY: Show audit meta inline. */
export function PhotoCaptureCaption({ photo, formatClockTime }) {
  if (!photo || typeof photo !== 'object') return null;

  let time = '';
  try {
    time =
      photo.capturedAtStr ||
      (photo.capturedAt
        ? formatClockTime
          ? formatClockTime(photo.capturedAt)
          : String(photo.capturedAt)
        : '');
  } catch (_) {
    time = photo.capturedAtStr || '';
  }

  let gps = '';
  try {
    gps = formatPhotoGps(photo.latitude, photo.longitude, photo.accuracy) || '';
  } catch (_) {
    gps = '';
  }

  return (
    <View style={styles.formCaption}>
      <Text style={styles.formCaptionLine}>Time: {time || 'not recorded'}</Text>
      <TouchableOpacity
        onPress={() => openLocationInMaps(photo.latitude, photo.longitude)}
        disabled={!gps}
        activeOpacity={gps ? 0.75 : 1}
      >
        <Text style={[styles.formCaptionLine, gps ? styles.linkActive : styles.metaMuted]}>
          Location: {gps || 'not recorded'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

/** WHAT: Card listing all photo capture metadata lines for a log. WHY: Detail modal summary. */
export function PhotoCaptureMetaSection({ metadata }) {
  const lines = formatPhotoCaptureMetadataLines(metadata);
  if (!lines.length) return null;
  return (
    <View style={styles.metaCard}>
      <Text style={styles.metaTitle}>Photo capture time & location</Text>
      {lines.map((line) => (
        <Text key={line} style={styles.metaLine}>
          {line}
        </Text>
      ))}
    </View>
  );
}

/**
 * WHAT: Full-screen modal to view one log photo with optional GPS and time footer.
 * WHY: Operators need zoomable proof images without leaving the app.
 * HOW: Modal + Image; map link when lat/lng present.
 */
export function ImagePreviewModal({ visible, uri, label, onClose, locationText, lat, lng, timeText }) {
  if (!uri) return null;
  const hasGps =
    lat != null &&
    lng != null &&
    Number.isFinite(parseFloat(lat)) &&
    Number.isFinite(parseFloat(lng));
  return (
    <Modal
      visible={!!visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <SafeAreaView style={previewStyles.safe}>
        <View style={previewStyles.header}>
          <Text style={previewStyles.title} numberOfLines={1}>
            {label || 'Photo'}
          </Text>
          <TouchableOpacity
            style={previewStyles.closeBtn}
            onPress={onClose}
            activeOpacity={0.85}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="close" size={24} color="#ffffff" />
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          style={previewStyles.body}
          activeOpacity={1}
          onPress={onClose}
        >
          <Image
            source={{ uri }}
            style={previewStyles.image}
            resizeMode="contain"
          />
        </TouchableOpacity>
        {timeText || locationText ? (
          <View style={previewStyles.metaBar}>
            {timeText ? (
              <View style={previewStyles.metaRow}>
                <Ionicons name="time-outline" size={14} color="#fff" />
                <Text style={previewStyles.locationText}>Time: {timeText}</Text>
              </View>
            ) : null}
            {locationText ? (
              <TouchableOpacity
                style={previewStyles.metaRow}
                onPress={() => openLocationInMaps(lat, lng)}
                disabled={!hasGps}
                activeOpacity={hasGps ? 0.75 : 1}
              >
                <Ionicons name="location-outline" size={14} color="#fff" />
                <Text style={previewStyles.locationText}>Location: {locationText}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
        <Text style={previewStyles.hint}>Tap anywhere to close</Text>
      </SafeAreaView>
    </Modal>
  );
}

/**
 * WHAT: Grid of tappable log photos with GPS/time captions.
 * WHY: Inward/outward/chamber detail modals show many proof images consistently.
 * HOW: resolveUri builds CDN URL; opens ImagePreviewModal on tap.
 */
export function PhotoGridWithLocation({ photoItems, folderHint, photoMeta, resolveUri }) {
  const [preview, setPreview] = useState(null);
  if (!photoItems?.length) return null;
  return (
    <>
      <View style={styles.grid}>
        {photoItems.map((photo) => (
          <PhotoGridCell
            key={photo.key}
            photo={photo}
            folderHint={folderHint}
            photoMeta={photoMeta}
            resolveUri={resolveUri}
            onOpenPreview={(uri, label, loc) =>
              setPreview({
                uri,
                label,
                locationText: loc?.locationText || '',
                timeText: loc?.timeText || '',
                lat: loc?.lat,
                lng: loc?.lng
              })
            }
          />
        ))}
      </View>
      <ImagePreviewModal
        visible={!!preview}
        uri={preview?.uri}
        label={preview?.label}
        locationText={preview?.locationText}
        timeText={preview?.timeText}
        lat={preview?.lat}
        lng={preview?.lng}
        onClose={() => setPreview(null)}
      />
    </>
  );
}

function PhotoGridCell({ photo, folderHint, photoMeta, resolveUri, onOpenPreview }) {
  const candidates = (() => {
    const resolved = resolveUri(photo.path, folderHint);
    if (Array.isArray(resolved)) return resolved.filter(Boolean);
    return resolved ? [resolved] : [];
  })();
  const [idx, setIdx] = useState(0);
  const uri = candidates[idx] || null;
  const metaEntry = resolvePhotoMetaEntry(photoMeta, photo.fieldKey, photo.photoIndex ?? 0);
  const { time, gps, hasGps } = formatPhotoMetaCaption(metaEntry);

  return (
    <View style={styles.cell}>
      <Text style={styles.photoLabel} numberOfLines={2}>
        {photo.label}
      </Text>
      <TouchableOpacity
        style={styles.frame}
        activeOpacity={uri ? 0.85 : 1}
        disabled={!uri}
        onPress={() =>
          uri &&
          onOpenPreview(uri, photo.label, {
            locationText: gps || '',
            timeText: time || '',
            lat: metaEntry?.latitude,
            lng: metaEntry?.longitude
          })
        }
      >
        {uri ? (
          <Image
            source={{ uri }}
            style={styles.image}
            resizeMode="cover"
            onError={() => {
              if (idx + 1 < candidates.length) setIdx(idx + 1);
            }}
          />
        ) : (
          <View style={styles.placeholder} />
        )}
        {uri ? (
          <View style={styles.viewBadge}>
            <Ionicons name="expand-outline" size={12} color="#fff" />
          </View>
        ) : null}
      </TouchableOpacity>
      {time ? <Text style={styles.meta}>Time: {time}</Text> : null}
      {gps ? (
        <TouchableOpacity
          onPress={() => openLocationInMaps(metaEntry.latitude, metaEntry.longitude)}
          disabled={!hasGps}
          activeOpacity={hasGps ? 0.75 : 1}
        >
          <Text style={[styles.meta, hasGps && styles.linkActive]}>Location: {gps}</Text>
        </TouchableOpacity>
      ) : (
        <Text style={styles.metaMuted}>Location: not recorded</Text>
      )}
    </View>
  );
}

const previewStyles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: {
    flex: 1,
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
    marginRight: 12,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  image: {
    width: '100%',
    height: PREVIEW_H,
  },
  hint: {
    textAlign: 'center',
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    fontWeight: '600',
    paddingBottom: 16,
  },
  locationBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: 'rgba(15,23,42,0.85)',
  },
  metaBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: 'rgba(15,23,42,0.85)',
    gap: 6,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  locationText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  label: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: '600',
    flex: 1,
  },
  linkWrap: { flex: 1.2, alignItems: 'flex-end' },
  value: {
    fontSize: 12,
    color: '#0f172a',
    fontWeight: '700',
    textAlign: 'right',
  },
  linkActive: {
    color: '#0369a1',
    textDecorationLine: 'underline',
  },
  metaCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 10,
    marginBottom: 10,
  },
  metaTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 6,
  },
  metaLine: {
    fontSize: 11,
    color: '#475569',
    fontWeight: '600',
    marginBottom: 3,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  cell: {
    width: '47%',
    minWidth: 140,
    flexGrow: 1,
  },
  photoLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 4,
  },
  frame: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    flex: 1,
    backgroundColor: '#e2e8f0',
  },
  viewBadge: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(15,23,42,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  meta: {
    fontSize: 10,
    color: '#64748b',
    fontWeight: '600',
    marginTop: 4,
  },
  metaMuted: {
    fontSize: 10,
    color: '#94a3b8',
    fontWeight: '600',
    marginTop: 4,
  },
  formCaption: {
    marginTop: 6,
    gap: 2,
  },
  formCaptionLine: {
    fontSize: 11,
    color: '#334155',
    fontWeight: '700',
  },
});
