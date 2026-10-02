import { render, screen } from '@testing-library/react-native'

import { AboutFooter, buildLine } from '../src/features/settings/AboutFooter'
import { ThemeProvider } from '../src/ui/theme'

/**
 * The About line is the first thing a bug report quotes, so what is asserted
 * here is that all THREE parts reach the screen — a line that silently loses
 * the commit still looks fine and answers nothing.
 *
 * `expo-constants` is mocked rather than read: under Jest there is no native
 * manifest, so the real module answers an empty config and the test would pass
 * on a line that says `Hermie 0.0.0 (?) · dev` whatever the code did.
 */
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: { version: '0.1.0', extra: { commit: '79ad86d', buildNumber: 68 } },
    nativeBuildVersion: '68'
  }
}))

it('names the version, the build number and the commit', () => {
  render(
    <ThemeProvider>
      <AboutFooter />
    </ThemeProvider>
  )

  const text = String(screen.getByTestId('about-footer').props.accessibilityLabel)

  expect(text).toBe('Hermie 0.1.0 (68) · 79ad86d')
  expect(screen.getByText('Hermie 0.1.0 (68) · 79ad86d')).toBeTruthy()
})

it('falls back to the config build number where there is no native one', () => {
  const Constants = require('expo-constants').default as { nativeBuildVersion: string | null }
  Constants.nativeBuildVersion = null

  try {
    expect(buildLine()).toBe('Hermie 0.1.0 (68) · 79ad86d')
  } finally {
    Constants.nativeBuildVersion = '68'
  }
})

it('says dev when the tree had no git history to read', () => {
  const Constants = require('expo-constants').default as { expoConfig: { extra: { commit: string } } }
  Constants.expoConfig.extra.commit = ''

  try {
    expect(buildLine()).toContain('· dev')
  } finally {
    Constants.expoConfig.extra.commit = '79ad86d'
  }
})
