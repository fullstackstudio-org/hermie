/**
 * The last line in Settings: which build this is.
 *
 * `Hermie 0.1.0 (68) · 79ad86d` — the marketing version, the build number and
 * the commit it was made from. It exists because every bug report starts with
 * "which version", and "the one I installed" is not an answer: a version string
 * alone cannot tell two builds of 0.1.0 apart, and the short hash can.
 *
 * Where the three come from:
 *
 *  - The version is `expoConfig.version`, the same string the stores show.
 *  - The build number is the native one where there IS one — Apple's
 *    `CFBundleVersion`, Android's `versionCode` — and falls back to
 *    `extra.buildNumber` in a browser, which is the value those two were derived
 *    from in the first place (see `app.config.ts`).
 *  - The commit is `extra.commit`, filled from `git rev-parse` when the config
 *    was evaluated, and `dev` in a checkout with no git history.
 *
 * A long press copies the line. On a platform with no pasteboard the seam says
 * so and nothing happens, rather than the row pretending it worked.
 */
import Constants from 'expo-constants'
import { Pressable } from 'react-native'

import { copyToClipboard } from '../../platform/clipboard'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'

export function buildLine(): string {
  const config = Constants.expoConfig
  const extra = (config?.extra ?? {}) as { commit?: unknown; buildNumber?: unknown }
  const version = config?.version ?? '0.0.0'
  const build =
    Constants.nativeBuildVersion ??
    (typeof extra.buildNumber === 'number' || typeof extra.buildNumber === 'string' ? String(extra.buildNumber) : '?')
  const commit = typeof extra.commit === 'string' && extra.commit ? extra.commit : 'dev'

  return `Hermie ${version} (${build}) · ${commit}`
}

export function AboutFooter() {
  const theme = useTheme()
  const line = buildLine()

  return (
    <Pressable
      accessibilityLabel={line}
      accessibilityRole="text"
      onLongPress={() => copyToClipboard(line)}
      style={{ alignItems: 'center', paddingVertical: theme.space.md }}
      testID="about-footer"
    >
      <Text color="textFaint" variant="meta">
        {line}
      </Text>
    </Pressable>
  )
}
