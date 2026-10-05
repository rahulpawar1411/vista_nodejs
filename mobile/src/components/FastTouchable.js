/**
 * WHAT: Drop-in button wrapper with instant press feedback.
 * WHY: Default TouchableOpacity can feel sluggish on long DO shift screens.
 * HOW: Pressable with unstable_pressDelay=0 and opacity change while pressed.
 */
import React from 'react';
import { Pressable } from 'react-native';

export default function FastTouchable({
  style,
  children,
  disabled = false,
  onPress,
  onLongPress,
  hitSlop,
  pressBorder: _pressBorder,
  activeOpacity = 0.55,
  // ignored RN TouchableOpacity compat props
  delayPressIn: _delayPressIn,
  ...rest
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={hitSlop ?? { top: 6, bottom: 6, left: 6, right: 6 }}
      unstable_pressDelay={0}
      style={({ pressed }) => [
        style,
        pressed && !disabled && { opacity: activeOpacity }
      ]}
      {...rest}
    >
      {children}
    </Pressable>
  );
}
