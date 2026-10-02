/**
 * There is no Liquid Glass in a browser.
 *
 * Both probes answer false, so `material.ts` settles on `blur` — which on the
 * web is `expo-blur`'s `backdrop-filter`, a real blur of what is behind the
 * surface. The two components are never rendered once the probes are false;
 * they exist so the module has the same shape on every platform, and they fall
 * back to a plain `View` rather than throwing, because a component that throws
 * is a blank page.
 */
import { View, type ViewProps } from 'react-native'

export function isLiquidGlassAvailable(): boolean {
  return false
}

export function isGlassEffectAPIAvailable(): boolean {
  return false
}

export function GlassView({
  colorScheme: _colorScheme,
  glassEffectStyle: _glassEffectStyle,
  tintColor: _tintColor,
  ...rest
}: ViewProps & { colorScheme?: string; glassEffectStyle?: string; tintColor?: string }) {
  return <View {...rest} />
}

export function GlassContainer({ spacing: _spacing, ...rest }: ViewProps & { spacing?: number }) {
  return <View {...rest} />
}
