import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Image,
  Text,
  StyleSheet,
  ActivityIndicator,
  Animated,
  Easing,
  StatusBar
} from 'react-native';

const VISTA_WORDS = ['Visibility', 'Inspection', 'Stock', 'Trust', 'Audit'];
const SLIDE_FROM = -56;

/** WHAT: Length of splash animation in ms. WHY: App.js waits for intro + session restore. */
export const SPLASH_ANIMATION_MS = 3200;

/**
 * WHAT: Branded loading screen with logo animation and optional “Loading session…”.
 * WHY: Hides AsyncStorage session restore and gives a polished first impression.
 * HOW: Animated.sequence for logo/VISTA words; onAnimationComplete when finished.
 */
export default function SplashScreen({
  onAnimationComplete,
  playIntro = true,
  waitingForSession = false
} = {}) {
  const [introDone, setIntroDone] = useState(!playIntro);

  const logoOpacity = useRef(new Animated.Value(playIntro ? 0 : 1)).current;
  const logoScale = useRef(new Animated.Value(playIntro ? 0.94 : 1)).current;

  const vistaOpacity = useRef(new Animated.Value(playIntro ? 0 : 1)).current;
  const vistaX = useRef(new Animated.Value(playIntro ? SLIDE_FROM : 0)).current;

  const wordAnims = useRef(
    VISTA_WORDS.map(() => ({
      opacity: new Animated.Value(playIntro ? 0 : 1),
      x: new Animated.Value(playIntro ? SLIDE_FROM : 0)
    }))
  ).current;

  const spinnerOpacity = useRef(new Animated.Value(playIntro ? 0 : 1)).current;
  const finishedRef = useRef(false);

  const showWaitingSpinner = introDone && waitingForSession;

  useEffect(() => {
    if (!playIntro) {
      setIntroDone(true);
      if (!finishedRef.current) {
        finishedRef.current = true;
        try {
          onAnimationComplete?.();
        } catch (_) {
          /* ignore */
        }
      }
      return undefined;
    }

    const notifyDone = () => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      setIntroDone(true);
      try {
        onAnimationComplete?.();
      } catch (_) {
        /* ignore */
      }
    };

    const slideIn = (opacity, x, duration = 420, delay = 0) =>
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration,
          delay,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true
        }),
        Animated.timing(x, {
          toValue: 0,
          duration,
          delay,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true
        })
      ]);

    const wordSequence = wordAnims.map((w) => slideIn(w.opacity, w.x, 380, 0));

    const anim = Animated.sequence([
      Animated.parallel([
        Animated.timing(logoOpacity, {
          toValue: 1,
          duration: 480,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true
        }),
        Animated.timing(logoScale, {
          toValue: 1,
          duration: 520,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true
        })
      ]),
      Animated.delay(120),
      slideIn(vistaOpacity, vistaX, 440),
      Animated.delay(80),
      Animated.stagger(110, wordSequence),
      Animated.timing(spinnerOpacity, {
        toValue: 1,
        duration: 360,
        delay: 60,
        useNativeDriver: true
      }),
      Animated.delay(420)
    ]);

    anim.start(({ finished }) => {
      if (finished) notifyDone();
    });

    return () => {
      try {
        anim.stop();
      } catch (_) {
        /* ignore */
      }
    };
  }, [
    playIntro,
    logoOpacity,
    logoScale,
    vistaOpacity,
    vistaX,
    wordAnims,
    spinnerOpacity,
    onAnimationComplete
  ]);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <View style={styles.center}>
        <Animated.View
          style={{
            opacity: logoOpacity,
            transform: [{ scale: logoScale }]
          }}
        >
          <Image
            source={require('../../assets/logo.png')}
            style={styles.logo}
            resizeMode="contain"
          />
        </Animated.View>

        <View style={styles.vistaBlock}>
          <Animated.View
            style={{
              opacity: vistaOpacity,
              transform: [{ translateX: vistaX }]
            }}
          >
            <Text style={styles.vistaName}>VISTA</Text>
          </Animated.View>

          <View style={styles.vistaLineRow}>
            {VISTA_WORDS.map((word, i) => (
              <Animated.View
                key={word}
                style={[
                  styles.vistaWordWrap,
                  {
                    opacity: wordAnims[i].opacity,
                    transform: [{ translateX: wordAnims[i].x }]
                  }
                ]}
              >
                <Text style={styles.vistaWord}>{word}</Text>
                {i < VISTA_WORDS.length - 1 ? (
                  <Text style={styles.vistaDot}> · </Text>
                ) : null}
              </Animated.View>
            ))}
          </View>
        </View>

        <Animated.View style={[styles.spinnerWrap, { opacity: spinnerOpacity }]}>
          <ActivityIndicator size="small" color="#003580" />
          {showWaitingSpinner ? (
            <Text style={styles.waitingText}>Loading session…</Text>
          ) : null}
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center'
  },
  center: {
    alignItems: 'center',
    paddingHorizontal: 28
  },
  logo: {
    width: 120,
    height: 120
  },
  vistaBlock: {
    marginTop: 14,
    alignItems: 'center',
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e2e8f0',
    minWidth: 260
  },
  vistaName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    letterSpacing: 3,
    textAlign: 'center'
  },
  vistaLineRow: {
    marginTop: 6,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4
  },
  vistaWordWrap: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  vistaWord: {
    fontSize: 10,
    fontWeight: '500',
    color: '#64748b',
    lineHeight: 14
  },
  vistaDot: {
    fontSize: 10,
    fontWeight: '500',
    color: '#94a3b8',
    lineHeight: 14
  },
  spinnerWrap: {
    marginTop: 14,
    alignItems: 'center',
    justifyContent: 'center'
  },
  waitingText: {
    marginTop: 8,
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b'
  }
});
