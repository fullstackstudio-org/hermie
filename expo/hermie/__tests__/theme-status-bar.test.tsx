/**
 * The status bar follows the app's appearance, not the system's.
 *
 * Android starts with `windowLightStatusBar` unset — white icons — and
 * edge-to-edge makes the bar transparent, so on Hermie's light background
 * (#F2F2F7) the clock, the battery and the signal bars are invisible. It is
 * rendered from `ThemeProvider` because that is the one component that knows
 * which of the pinned and the system scheme won, and because it sits above
 * every screen and therefore survives navigation.
 */
import { render, screen } from '@testing-library/react-native'
import { StatusBar } from 'expo-status-bar'
import { Text } from 'react-native'

import { useSettingsStore } from '../src/store/settings'
import { ThemeProvider, useTheme } from '../src/ui/theme'

jest.mock('expo-status-bar', () => ({ StatusBar: jest.fn(() => null) }))

const statusBar = jest.mocked(StatusBar)

function Probe() {
  const theme = useTheme()

  return <Text testID="scheme">{theme.scheme}</Text>
}

beforeEach(() => {
  statusBar.mockClear()
  useSettingsStore.getState().reset()
})

/** The last style the bar was rendered with. */
const lastStyle = () => statusBar.mock.calls.at(-1)?.[0]?.style

describe('ThemeProvider', () => {
  it('draws dark ink under the light theme', () => {
    useSettingsStore.getState().setAppearance('light')

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    )

    expect(screen.getByTestId('scheme')).toHaveTextContent('light')
    expect(lastStyle()).toBe('dark')
  })

  it('draws light ink under the dark theme, even when the system disagrees', () => {
    useSettingsStore.getState().setAppearance('dark')

    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    )

    expect(screen.getByTestId('scheme')).toHaveTextContent('dark')
    expect(lastStyle()).toBe('light')
  })

  it('follows the pinned appearance when it changes', () => {
    useSettingsStore.getState().setAppearance('light')

    const view = render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    )

    useSettingsStore.getState().setAppearance('dark')
    view.rerender(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    )

    expect(lastStyle()).toBe('light')
  })
})
