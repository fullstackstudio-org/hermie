/**
 * Where a notification tap lands (ADR-0017, amended 2026-09-22): the cases of
 * the Expo app's `pushDestinationOf` and the Apple apps' `PushTapRules`, as
 * routes of this client.
 */
import { describe, expect, it } from 'vitest'

import { formatRoute } from '../shell/router'
import { answersInPlace, pushRouteOf, type PushTapTarget, sessionKindOf } from './push-destination'

const CANONICAL = ['stored-researcher', 'resolved-researcher']
const tap = (over: Partial<PushTapTarget> = {}): PushTapTarget => ({
  bot: 'researcher',
  sessionId: '',
  sessionKind: '',
  ...over
})
const hashOf = (target: PushTapTarget, ids: readonly string[] = CANONICAL): string =>
  formatRoute(pushRouteOf(target, ids))

describe('pushRouteOf', () => {
  it('opens the chat for a payload that names no conversation, as every tap did before', () => {
    expect(hashOf(tap())).toBe('#/chat/researcher')
  })

  it('opens the chat for a canonical one, whatever id it carries', () => {
    expect(hashOf(tap({ sessionKind: 'canonical', sessionId: 'something-else' }))).toBe('#/chat/researcher')
  })

  it.each(['branch', 'other'] as const)('opens a %s in the viewer', kind => {
    expect(hashOf(tap({ sessionKind: kind, sessionId: 'old-1' }))).toBe('#/chat/researcher/s/old-1')
  })

  it('compares an id with no kind against both ids of the canonical chat', () => {
    expect(hashOf(tap({ sessionId: 'stored-researcher' }))).toBe('#/chat/researcher')
    expect(hashOf(tap({ sessionId: 'resolved-researcher' }))).toBe('#/chat/researcher')
    expect(hashOf(tap({ sessionId: 'old-1' }))).toBe('#/chat/researcher/s/old-1')
  })

  it('opens the chat rather than guess, while the roster holds no canonical id', () => {
    expect(hashOf(tap({ sessionId: 'old-1' }), [])).toBe('#/chat/researcher')
  })

  it('keeps a name and an id that are not plain words one segment each', () => {
    expect(hashOf(tap({ bot: 'a/b', sessionKind: 'branch', sessionId: 'x/y' }))).toBe('#/chat/a%2Fb/s/x%2Fy')
  })
})

describe('answersInPlace', () => {
  it('answers only where the tap lands in the bot’s own chat', () => {
    expect(answersInPlace(tap(), CANONICAL)).toBe(true)
    expect(answersInPlace(tap({ sessionKind: 'canonical', sessionId: 'stored-researcher' }), CANONICAL)).toBe(true)
  })

  it('answers nothing for a branch or another conversation: the reader lands there and answers in place', () => {
    expect(answersInPlace(tap({ sessionKind: 'branch', sessionId: 'b-1' }), CANONICAL)).toBe(false)
    expect(answersInPlace(tap({ sessionKind: 'other', sessionId: 'o-1' }), CANONICAL)).toBe(false)
    // No kind, and an id that is not the canonical chat's: it opens the viewer, so it answers nothing either.
    expect(answersInPlace(tap({ sessionId: 'old-1' }), CANONICAL)).toBe(false)
  })
})

describe('sessionKindOf', () => {
  it('reads the three kinds and nothing else', () => {
    expect(sessionKindOf('branch')).toBe('branch')
    expect(sessionKindOf(' other ')).toBe('other')
    expect(sessionKindOf('canonical')).toBe('canonical')
    expect(sessionKindOf('subagent')).toBe('')
    expect(sessionKindOf(3)).toBe('')
  })
})
