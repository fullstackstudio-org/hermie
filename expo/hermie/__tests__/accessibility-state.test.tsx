/**
 * Which spelling of an accessibility state the app is allowed to author.
 *
 * `accessibilityState={{ selected }}` is the React Native spelling and it never
 * reached the browser: react-native-web's prop table takes `aria-selected`,
 * `aria-expanded`, `aria-checked`, `aria-disabled` and `aria-busy`, and drops an
 * `accessibilityState` object on the floor. So every tab in the strip, every
 * disclosure in the transcript and every switch in a sheet shipped to the web
 * with no state on it at all, while the native builds announced it correctly and
 * the tests agreed with the native builds.
 *
 * Two assertions, because the fix has two halves that can fail separately.
 *
 *  1. **Nothing authors the old spelling.** A source sweep, not a render: a
 *     single `accessibilityState` anywhere is a control whose state stops at the
 *     bundle, and no renderer test would catch the one component nobody thought
 *     to render.
 *  2. **The native announcement is unchanged.** React Native normalises the aria
 *     props back into `accessibilityState` on the host node, so this is a
 *     re-spelling rather than a behaviour change — which is exactly what has to
 *     be pinned, since the native app is the reference the web is measured
 *     against.
 */
import { render, screen } from '@testing-library/react-native'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { Pressable } from 'react-native'

import { SidebarFooter } from '../src/features/bots'
import { ThemeProvider } from '../src/ui/theme'

const SRC = path.join(__dirname, '..', 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry)

    if (statSync(full).isDirectory()) {
      return sourceFiles(full)
    }

    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

describe('the spelling of an accessibility state', () => {
  it('is never `accessibilityState`, which the browser build cannot hear', () => {
    const offenders = sourceFiles(SRC).filter(file => readFileSync(file, 'utf8').includes('accessibilityState='))

    expect(offenders.map(file => path.relative(SRC, file))).toEqual([])
  })

  it('still reaches a native host node as `accessibilityState`', () => {
    render(<Pressable accessibilityRole="tab" aria-selected testID="probe" />)

    // React Native's own normalisation, pinned because the whole argument for
    // re-spelling 30-odd call sites is that it costs the native side nothing.
    expect(screen.getByTestId('probe').props.accessibilityState).toEqual({ selected: true })
  })

  it('marks the current tab in the strip', () => {
    render(
      <ThemeProvider>
        <SidebarFooter current="chats" onOpenSection={jest.fn()} />
      </ThemeProvider>
    )

    expect(screen.getByTestId('tab-chats').props.accessibilityState).toEqual({ selected: true })
    expect(screen.getByTestId('tab-settings').props.accessibilityState).toEqual({ selected: false })
  })
})
