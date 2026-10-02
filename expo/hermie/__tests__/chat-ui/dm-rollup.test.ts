/**
 * The bot-to-bot roll-up: more than three consecutive asides collapse into one
 * summary (§6.6).
 *
 * "Consecutive" is a question about what is VISIBLE, which is the part worth
 * pinning: a hidden placeholder between two rows does not break the run, but a
 * tool row does — the reader can see the tool row, so the asides are not adjacent
 * on screen.
 *
 * And a run holds BOTH DIRECTIONS. An answer standing between two dispatches is
 * the same silhouette as the rows around it, so it belongs to the same group;
 * gathering only dispatches split one exchange into two runs with a row between
 * them that belonged to neither.
 */
import { hasReply, ROLLUP_THRESHOLD, rollupDmRuns } from '../../src/chat-ui'
import type { BotDmInItem, BotDmOutItem, TranscriptItem, VisibleItem } from '../../src/chat-ui/types'

const AT = 1_767_000_000

function dm(id: string, options: { handle?: string; reply?: string; error?: string } = {}): VisibleItem {
  const item: BotDmOutItem = {
    dispatch: { status: options.error ? 'failed' : 'queued', ...(options.error ? { error: options.error } : {}) },
    id,
    kind: 'bot_dm_out',
    message: `message ${id}`,
    origin: 'history',
    seq: 0,
    target: options.handle ?? 'Writer',
    targetHandle: options.handle ?? 'writer',
    toolId: id,
    ts: AT,
    version: 0,
    ...(options.reply ? { reply: { text: options.reply, ts: AT + 1 } } : {})
  }

  return { item, presentation: 'collapsed' }
}

function dmIn(id: string, options: { handle?: string } = {}): VisibleItem {
  const item: BotDmInItem = {
    id,
    kind: 'bot_dm_in',
    origin: 'history',
    senderHandle: options.handle ?? 'writer',
    senderName: options.handle ?? 'Writer',
    seq: 0,
    text: `answer ${id}`,
    ts: AT,
    version: 0
  }

  return { item, presentation: 'collapsed' }
}

function other(id: string): VisibleItem {
  return {
    item: {
      id,
      kind: 'status',
      origin: 'history',
      seq: 0,
      statusKind: 'compaction',
      text: id,
      version: 0
    } as TranscriptItem,
    presentation: 'chip'
  }
}

describe('hasReply', () => {
  it('counts an answer and not a failure', () => {
    expect(hasReply(dm('a', { reply: 'yes' }).item as BotDmOutItem)).toBe(true)
    expect(hasReply(dm('b').item as BotDmOutItem)).toBe(false)

    // A `reply` carrying an error is a failure, not an answer. Counting it would
    // make "5 messages · 5 replies" out of five failures.
    const failed = dm('c').item as BotDmOutItem

    failed.reply = { error: 'refused', text: '' }
    expect(hasReply(failed)).toBe(false)
  })
})

describe('rollupDmRuns', () => {
  it('leaves a run at the threshold as separate lines', () => {
    const entries = Array.from({ length: ROLLUP_THRESHOLD }, (_, index) => dm(`d${index}`))
    const roles = rollupDmRuns(entries)

    expect(Object.values(roles).every(role => role.role === 'line')).toBe(true)
  })

  it('rolls up one more than the threshold', () => {
    const entries = Array.from({ length: ROLLUP_THRESHOLD + 1 }, (_, index) => dm(`d${index}`))
    const roles = rollupDmRuns(entries)

    expect(roles.d0?.role).toBe('rollupHead')
    expect(roles.d1).toEqual({ role: 'rollupMember', runId: 'd0' })
  })

  it('counts the messages and only the replies that came back', () => {
    const entries = [
      dm('d0', { reply: 'ok' }),
      dm('d1', { reply: 'ok' }),
      dm('d2', { reply: 'ok' }),
      dm('d3', { reply: 'ok' }),
      dm('d4')
    ]
    const head = rollupDmRuns(entries).d0

    expect(head?.role).toBe('rollupHead')
    expect(head?.role === 'rollupHead' && head.run.items).toHaveLength(5)
    expect(head?.role === 'rollupHead' && head.run.replies).toBe(4)
    expect(head?.role === 'rollupHead' && head.run.handle).toBe('writer')
  })

  it('reports no single handle when the run went to more than one teammate', () => {
    const entries = [dm('d0'), dm('d1'), dm('d2'), dm('d3', { handle: 'builder' })]
    const head = rollupDmRuns(entries).d0

    expect(head?.role === 'rollupHead' && head.run.handle).toBeUndefined()
  })

  it('breaks a run at a row the reader can see', () => {
    const entries = [dm('d0'), dm('d1'), other('s'), dm('d2'), dm('d3'), dm('d4'), dm('d5')]
    const roles = rollupDmRuns(entries)

    // The first two are their own short run; the four after the status row roll up.
    expect(roles.d0?.role).toBe('line')
    expect(roles.d1?.role).toBe('line')
    expect(roles.d2?.role).toBe('rollupHead')
    expect(roles.d5).toEqual({ role: 'rollupMember', runId: 'd2' })
  })

  it('looks through a hidden row', () => {
    const hidden = { ...other('h'), presentation: 'hidden-placeholder' as const }
    const entries = [dm('d0'), dm('d1'), hidden, dm('d2'), dm('d3')]
    const roles = rollupDmRuns(entries)

    expect(roles.d0?.role).toBe('rollupHead')
    expect(roles.d3).toEqual({ role: 'rollupMember', runId: 'd0' })
  })

  it('has nothing to say about a list with no asides in it', () => {
    expect(rollupDmRuns([other('a'), other('b')])).toEqual({})
  })

  it('folds both directions into one run', () => {
    // Two errands, an answer, two more: five rows the reader sees as one
    // exchange, so one roll-up rather than two runs of two with a row loose
    // between them.
    const entries = [dm('d0', { reply: 'ok' }), dm('d1'), dmIn('i0'), dm('d2'), dm('d3')]
    const roles = rollupDmRuns(entries)
    const head = roles.d0

    expect(head?.role).toBe('rollupHead')
    expect(head?.role === 'rollupHead' && head.run.items.map(item => item.kind)).toEqual([
      'bot_dm_out',
      'bot_dm_out',
      'bot_dm_in',
      'bot_dm_out',
      'bot_dm_out'
    ])
    // The counterpart is the same teammate in both directions, so the run can
    // still name them.
    expect(head?.role === 'rollupHead' && head.run.handle).toBe('writer')
    // Only the dispatch that was answered counts. An inbound row is somebody
    // else's message, not an answer to one of ours.
    expect(head?.role === 'rollupHead' && head.run.replies).toBe(1)
    expect(roles.i0).toEqual({ role: 'rollupMember', runId: 'd0' })
  })

  it('rolls up a run of inbound rows on its own', () => {
    const entries = Array.from({ length: ROLLUP_THRESHOLD + 1 }, (_, index) => dmIn(`i${index}`))
    const roles = rollupDmRuns(entries)

    expect(roles.i0?.role).toBe('rollupHead')
    expect(roles.i3).toEqual({ role: 'rollupMember', runId: 'i0' })
  })

  it('reports no single handle when the two directions name different teammates', () => {
    const entries = [dm('d0'), dm('d1'), dmIn('i0', { handle: 'builder' }), dm('d2')]
    const head = rollupDmRuns(entries).d0

    expect(head?.role === 'rollupHead' && head.run.handle).toBeUndefined()
  })
})
