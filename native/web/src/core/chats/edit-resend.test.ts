/**
 * Putting the reader's own turn back in the composer: which turn, and what the
 * field holds afterwards.
 */
import type { TranscriptItem } from '@hermie/transcript'
import { describe, expect, it } from 'vitest'

import { assistantItem, noticeItem, userItem } from '../../test-support/chat-fixtures'
import { editResendTarget, editResendText, mergeIntoDraft } from './edit-resend'

const rows = (...items: TranscriptItem[]) => items.map(item => ({ item }))

describe('the turn that may be put back', () => {
  it('is the newest turn with words in it, whatever came after', () => {
    const items = rows(
      userItem('old', {}, 'u1'),
      assistantItem('answer', {}, 'a1'),
      userItem('newest', {}, 'u2'),
      assistantItem('reply', {}, 'a2'),
      noticeItem('later', {}, 'n1')
    )

    expect(editResendTarget(items, {})).toBe('u2')
  })

  it('is nothing in a chat with no turn of the reader’s, or with only wordless ones', () => {
    expect(editResendTarget([], {})).toBeNull()
    expect(editResendTarget(rows(assistantItem('hello')), {})).toBeNull()
    expect(editResendTarget(rows(userItem('  ', {}, 'u1')), {})).toBeNull()
  })

  it('is the reader’s own turn outside the group chat, before an identity is known, and on an unattributed row', () => {
    const colleague = userItem('theirs', { author: { id: 'oidc:2', name: 'Colleague' } }, 'u1')

    expect(editResendTarget(rows(colleague), { groupChat: false, ownAuthorId: 'oidc:1' })).toBe('u1')
    expect(editResendTarget(rows(colleague), { groupChat: true })).toBe('u1')
    expect(editResendTarget(rows(userItem('mine', {}, 'u2')), { groupChat: true, ownAuthorId: 'oidc:1' })).toBe('u2')
  })

  it('is nothing when the newest turn of the group chat is a colleague’s, and never an older one of the reader’s', () => {
    const items = rows(
      userItem('mine', { author: { id: 'oidc:1' } }, 'u1'),
      assistantItem('answer', {}, 'a1'),
      userItem('theirs', { author: { id: 'oidc:2', name: 'Colleague' } }, 'u2')
    )

    expect(editResendTarget(items, { groupChat: true, ownAuthorId: 'oidc:1' })).toBeNull()
    expect(
      editResendTarget(rows(userItem('mine', { author: { id: 'oidc:1' } }, 'u3')), {
        groupChat: true,
        ownAuthorId: 'oidc:1'
      })
    ).toBe('u3')
  })
})

describe('the text the field gets', () => {
  it('is the words, with the references of the attachments on the next line', () => {
    expect(editResendText('look at this', [])).toBe('look at this')
    expect(editResendText('look at this', ['@file:a.txt', '/tmp/b.png'])).toBe('look at this\n@file:a.txt /tmp/b.png')
    expect(editResendText('', ['@file:a.txt'])).toBe('@file:a.txt')
  })

  it('goes ahead of what the reader had typed, which is kept, and is all there is in an empty field', () => {
    expect(mergeIntoDraft('', 'the turn')).toBe('the turn')
    expect(mergeIntoDraft('  \n', 'the turn')).toBe('the turn')
    expect(mergeIntoDraft('half a thought', 'the turn')).toBe('the turn\nhalf a thought')
  })
})
