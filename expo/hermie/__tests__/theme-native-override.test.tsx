/**
 * Pinning the theme has to reach UIKit, not only the token set.
 *
 * Half of what the app draws is a native material: `expo-glass-effect`'s
 * `UIGlassEffect` and `expo-blur`'s `UIBlurEffect` take their appearance from the
 * window's trait collection, which follows the SYSTEM scheme. With the theme
 * pinned to Light on a Mac running Dark, every glass panel came out murky dark
 * glass under light ink. `Appearance.setColorScheme` sets
 * `overrideUserInterfaceStyle` on every window of every connected scene, and
 * `null` releases it — which is what "System" has to do, rather than pinning
 * whatever the system happened to say at the time.
 */
import { render } from '@testing-library/react-native'
import { Appearance, Text } from 'react-native'

import { useSettingsStore } from '../src/store/settings'
import { ThemeProvider } from '../src/ui/theme'

jest.mock('expo-status-bar', () => ({ StatusBar: jest.fn(() => null) }))

const setColorScheme = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => {})

beforeEach(() => {
  setColorScheme.mockClear()
  useSettingsStore.getState().reset()
})

afterAll(() => {
  setColorScheme.mockRestore()
})

const lastCall = () => setColorScheme.mock.calls.at(-1)?.[0]

function Provider() {
  return (
    <ThemeProvider>
      <Text>{'anything'}</Text>
    </ThemeProvider>
  )
}

describe('ThemeProvider and the window', () => {
  it('overrides the window when the appearance is pinned to light', () => {
    useSettingsStore.getState().setAppearance('light')

    render(<Provider />)

    expect(lastCall()).toBe('light')
  })

  it('overrides the window when the appearance is pinned to dark', () => {
    useSettingsStore.getState().setAppearance('dark')

    render(<Provider />)

    expect(lastCall()).toBe('dark')
  })

  it('releases the override on System rather than pinning the current scheme', () => {
    useSettingsStore.getState().setAppearance('system')

    render(<Provider />)

    expect(lastCall()).toBeNull()
  })

  it('follows a change of appearance', () => {
    useSettingsStore.getState().setAppearance('dark')
    const view = render(<Provider />)
    expect(lastCall()).toBe('dark')

    useSettingsStore.getState().setAppearance('system')
    view.rerender(<Provider />)

    expect(lastCall()).toBeNull()
  })

  it('pins the development override too, so a screenshot is not half system', () => {
    useSettingsStore.getState().setAppearance('system')

    render(
      <ThemeProvider forceScheme="dark">
        <Text>{'anything'}</Text>
      </ThemeProvider>
    )

    expect(lastCall()).toBe('dark')
  })
})
