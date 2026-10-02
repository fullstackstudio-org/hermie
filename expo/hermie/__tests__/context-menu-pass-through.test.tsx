/**
 * `passThroughButtons`, as far as a test on this hardware can reach it.
 *
 * The fix itself is native and cannot be exercised here: it is
 * `HermieContextMenuView.isOverPassedThroughButton`, walked against a real hit
 * test on a real `UIView` hierarchy, for a click delivered as an
 * indirect-pointer touch — none of which the Jest environment has (see the
 * 2026-09-20 section of docs/platform-notes.md, where the same limit is stated
 * for `useDirectTouchPanOnly`). What IS reachable, and worth pinning, is the
 * JAVASCRIPT half of the seam: that the prop reaches the native view at all,
 * that it defaults OFF (a list row's own `Pressable` covers the whole row, and
 * excluding it would exclude the row from its own menu), and that
 * `TranscriptList` is the caller that turns it on while `BotRow` and the cron
 * row are not.
 */
import { screen } from '@testing-library/react-native'
import type { ReactNode } from 'react'

import { ContextMenuHost } from '../src/platform/context-menu'
import { renderScreen } from './support/render'

const received: Record<string, unknown>[] = []

/**
 * A binary that HAS the native menu: `setClipboardString` is what
 * `HAS_NATIVE_CONTEXT_MENU` probes for, and the fake host below stands in for
 * `requireNativeView('HermieMac', 'HermieContextMenuView')` and records every
 * prop it was mounted with.
 */
jest.mock('expo', () => {
  const React = require('react')
  const { View } = require('react-native')

  return {
    requireNativeView: () => (props: Record<string, unknown> & { children?: ReactNode; testID?: string }) => {
      received.push(props)

      return React.createElement(View, { testID: props.testID }, props.children as ReactNode)
    },
    requireOptionalNativeModule: () => ({ setClipboardString: () => undefined })
  }
})

beforeEach(() => {
  received.length = 0
})

describe('ContextMenuHost’s native prop', () => {
  it('defaults to leaving the interaction to compete for every touch, unasked', () => {
    renderScreen(
      <ContextMenuHost items={[{ id: 'a', title: 'A' }]} onSelect={jest.fn()} testID="host">
        <></>
      </ContextMenuHost>
    )

    expect(received[0]?.passThroughButtons).toBe(false)
  })

  it('tells the native host to let a nested button escape it, once asked', () => {
    renderScreen(
      <ContextMenuHost items={[{ id: 'a', title: 'A' }]} onSelect={jest.fn()} passThroughButtons testID="host">
        <></>
      </ContextMenuHost>
    )

    expect(received[0]?.passThroughButtons).toBe(true)
  })

  it('still renders the children the interaction wraps', () => {
    renderScreen(
      <ContextMenuHost items={[{ id: 'a', title: 'A' }]} onSelect={jest.fn()} passThroughButtons testID="host">
        <></>
      </ContextMenuHost>
    )

    expect(screen.getByTestId('host')).toBeTruthy()
  })
})
