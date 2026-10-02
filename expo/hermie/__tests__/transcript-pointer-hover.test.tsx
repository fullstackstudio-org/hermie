/**
 * Nothing in the conversation lights up because a mouse went past it.
 *
 * Reported from the Mac build: moving the pointer over the chat window draws a
 * blurred highlight over it. That is `UIContextMenuInteraction`'s own pointer
 * effect doing what it is designed to do — at the wrong size. The host view was
 * built for a LIST ROW, where a row-sized highlight is how the system says "this
 * is a thing you can act on"; a transcript row is as wide as the window and as
 * tall as a reply, so the same effect is a platter the size of a message
 * following the mouse across the text.
 *
 * Two things are asserted, and the second is the one that keeps it fixed:
 *
 *  - the transcript's menu host asks for no hover effect, while a LIST row still
 *    asks for one — this is a difference between callers, not a global switch;
 *  - no container in the transcript or the chat column carries a hover handler
 *    of its own, so a future `useHover` on a big box cannot quietly reintroduce
 *    the same thing from the JavaScript side.
 *
 * The native half is reasoned, not watched, and the first attempt at it was
 * WRONG in a way this file could not see: the host added a `UIPointerInteraction`
 * unconditionally and answered `styleFor:` with the system's own style where the
 * effect was meant to be off, which is the highlight rather than the absence of
 * one — and a highlight on a host that wraps a whole transcript row composites a
 * blurred preview of the lot. `previewForHighlightingMenuWithConfiguration` was
 * believed to cover it and does not; that delegate method belongs to the context
 * MENU and the pointer effect never calls it. The host now installs no pointer
 * interaction at all where the effect is off and sets `hoverStyle` to nil, which
 * is the property UIKit actually applies hover through. See
 * `HermieContextMenuView.swift` and docs/platform-notes.md.
 */
import { screen } from '@testing-library/react-native'

import { TranscriptList } from '../src/chat-ui'
import { assistantItem, userItem } from '../src/chat-ui/fixtures'
import { renderScreen } from './support/render'

const hosts: { hoverEffect?: boolean; testID?: string }[] = []

jest.mock('../src/platform/context-menu', () => {
  const { View: RNView } = jest.requireActual('react-native')
  const actual = jest.requireActual('../src/platform/context-menu')

  return {
    ...actual,
    HAS_NATIVE_CONTEXT_MENU: true,
    ContextMenuHost: ({
      children,
      hoverEffect,
      testID
    }: {
      children: React.ReactNode
      hoverEffect?: boolean
      testID?: string
    }) => {
      hosts.push({ hoverEffect, testID })

      return <RNView testID={testID}>{children}</RNView>
    }
  }
})

beforeEach(() => {
  hosts.length = 0
})

describe('the pointer over a transcript', () => {
  it('asks the menu host for no hover effect', () => {
    renderScreen(
      <TranscriptList
        items={[
          { item: assistantItem, presentation: 'full' },
          { item: userItem, presentation: 'full' }
        ]}
      />
    )

    const transcriptHosts = hosts.filter(host => host.testID?.startsWith('transcript-menu-'))

    expect(transcriptHosts.length).toBeGreaterThan(0)
    expect(transcriptHosts.every(host => host.hoverEffect === false)).toBe(true)
  })

  it('turns it off per CALLER, not for the app', () => {
    // The host was built for a list row and keeps its default there — a chat
    // row, a cron row and a bot in the sidebar all want the highlight, because
    // a row-sized one is how the system says a row is actionable. The only
    // hosts that ask for `false` are the transcript's, and asking for it is
    // what a host has to DO: the prop is absent everywhere else.
    renderScreen(<TranscriptList items={[{ item: assistantItem, presentation: 'full' }]} />)

    for (const host of hosts) {
      expect(host.testID?.startsWith('transcript-menu-')).toBe(true)
      expect(host.hoverEffect).toBe(false)
    }
  })

  it('has no hover handler on any container in the conversation', () => {
    // `onPointerEnter` is what `useHover` spreads, and it is free to put on a
    // 44pt control. On the transcript's own boxes it would be the same bug
    // again, drawn by us instead of by UIKit.
    renderScreen(<TranscriptList items={[{ item: assistantItem, presentation: 'full' }]} />)

    const hovered = screen.UNSAFE_root.findAll(
      node => typeof node.props?.onPointerEnter === 'function' || typeof node.props?.onPointerLeave === 'function'
    )

    expect(hovered).toEqual([])
  })
})
