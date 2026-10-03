import { describe, expect, it } from 'vitest'

import {
  attachmentRefName,
  attachmentsMatchKey,
  normalizedItemText,
  rowsToItems,
  stripUserText,
  type TranscriptRow
} from './rows-to-items'
import {
  attachedContextRow,
  authoredRow,
  authoredRowRest,
  authorlessRows,
  codexSidecarRow,
  cronBotChatBody,
  cronBotChatHeader,
  cronBotChatText,
  cronMirrorText,
  delegationBatchText,
  dmReplyProcessText,
  kanbanNotificationText,
  modelSwitchMarkerText,
  plainProcessText,
  priorContextText,
  restHistoryRows,
  rpcHistoryRows,
  steerWrapperBody,
  steerWrapperText
} from './__fixtures__/rows'
import type {
  AssistantItem,
  BotDmInItem,
  BotDmOutItem,
  CronDeliveryItem,
  NoticeItem,
  SubagentGroupItem,
  ToolItem,
  TranscriptItem,
  UserItem
} from './types'

const kinds = (rows: TranscriptRow[]) => rowsToItems(rows, 'rpc').map(item => item.kind)

/** The transcript no longer ends on a reply, so reach for it by kind. */
const lastAssistant = (items: readonly TranscriptItem[]) =>
  [...items].reverse().find((item): item is AssistantItem => item.kind === 'assistant')!

describe('rowsToItems (rpc history)', () => {
  const items = rowsToItems(rpcHistoryRows, 'rpc')

  it('projects every row it should keep and drops the hidden one', () => {
    expect(items.map(item => item.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'notice',
      'notice',
      'notice',
      'user',
      'user',
      'notice',
      'notice',
      'bot_dm_out',
      'subagent_group',
      'notice',
      'bot_dm_in',
      'assistant',
      'cron_delivery'
    ])
  })

  it('numbers items with a stable gap so live items fit between', () => {
    expect(items.map(item => item.seq)).toEqual(items.map((_item, index) => index * 1000))
  })

  it('names persisted rows after their durable row id', () => {
    expect(items[0]?.id).toBe('r:1')
    expect(items[0]?.rowId).toBe(1)
  })

  it('names tool rows after their tool id', () => {
    const tool = items.find(item => item.kind === 'tool') as ToolItem

    expect(tool.id).toBe('t:row-2')
    expect(tool.name).toBe('read_file')
  })

  it('keeps assistant reasoning from history', () => {
    const assistant = items[1] as AssistantItem

    expect(assistant.reasoning).toBe('The user wants a summary; read the file first.')
    expect(assistant.streaming).toBe(false)
    expect(assistant.status).toBe('complete')
  })

  it('leaves a history tool row honest about not knowing its result', () => {
    const tool = items.find(item => item.kind === 'tool') as ToolItem

    expect(tool.resultKnown).toBe(false)
    expect(tool.status).toBe('complete')
    expect(tool.summary).toBe('read_file(CHANGELOG.md)')
  })

  it.each([
    ['model_switch', 4],
    ['personality_switch', 5],
    ['auto_continue', 6]
  ])('turns %s into a notice', (kind, index) => {
    const notice = items[index] as NoticeItem

    expect(notice.kind).toBe('notice')
    expect(notice.noticeKind).toBe(kind)
  })

  it('keeps skill invocations and steers as user turns', () => {
    expect(items[7]).toMatchObject({ kind: 'user', text: '/release-notes', displayKind: 'skill_invocation' })
    expect(items[8]).toMatchObject({ kind: 'user', text: 'actually make it shorter', displayKind: 'steer' })
  })

  it('labels an unknown display kind rather than guessing', () => {
    expect(items[10]).toMatchObject({ kind: 'notice', noticeKind: 'unknown_display_kind', title: 'brand_new_kind' })
  })

  it('joins a process_complete delivery back onto the dispatch that sent it', () => {
    const dispatch = items.find(item => item.kind === 'bot_dm_out') as BotDmOutItem

    expect(dispatch.targetHandle).toBe('writer')
    expect(dispatch.message).toBe('Can you draft the announcement?')
    expect(dispatch.reply?.text).toBe('Draft is ready, I pushed it to the shared folder.')
    expect(dispatch.reply?.rowId).toBe(12)
    // The joined block is consumed, so it never also shows up as a notice.
    expect(items.filter(item => item.kind === 'notice' && item.noticeKind === 'process_complete')).toHaveLength(0)
  })

  it('closes the delegation group on the async completion row', () => {
    const group = items.find(item => item.kind === 'subagent_group') as SubagentGroupItem

    expect(group.goals).toEqual(['Audit deps', 'Write tests', 'Update docs'])
    expect(group.status).toBe('done')
    expect(group.completion).toContain('TASK 1/3')
  })

  it('reads an inbound DM as its own kind and attributes the reply after it', () => {
    const inbound = items.find(item => item.kind === 'bot_dm_in') as BotDmInItem

    expect(inbound.senderName).toBe('Writer')
    expect(inbound.senderHandle).toBe('writer')
    expect(inbound.text).toBe('The announcement draft is in docs/announce.md.')
    // We dispatched to @writer earlier in this exchange, so the reply answers us
    // and the next assistant turn addresses the human again.
    expect(inbound.answersOurDispatch).toBe(true)
    expect(lastAssistant(items).replyToBotHandle).toBeUndefined()
  })

  it('reads an unmarked cron delivery as its own kind, not as the owner speaking', () => {
    const cron = items.find(item => item.kind === 'cron_delivery') as CronDeliveryItem

    expect(cron).toMatchObject({
      id: 'r:16',
      rowId: 16,
      ts: 1_700_000_050,
      jobName: 'Inbox scan',
      shape: 'bot_chat',
      origin: 'history'
    })
    expect(cron.body).toBe(cronBotChatBody)
    // The header is gone from the body: the card draws the name, not the sentence.
    expect(cron.body).not.toContain('scheduled job, not the user')
    expect(cron.nameRedacted).toBeUndefined()
    // And it is not a user turn, which is the whole bug.
    expect(items.filter(item => item.kind === 'user' && item.text.includes('Cronjob'))).toHaveLength(0)
  })
})

describe('rowsToItems (rest history)', () => {
  const items = rowsToItems(restHistoryRows, 'rest')

  it('accepts content / display_content and a numeric id', () => {
    expect(items[0]).toMatchObject({ kind: 'user', id: 'r:1', rowId: 1, text: 'Summarise the release notes.' })
    expect((items[1] as AssistantItem).reasoning).toBe('Read the file first.')
  })

  it('produces the same ids for the rows both transports carry', () => {
    const rpc = rowsToItems(
      rpcHistoryRows.filter(row => [1, 2, 14, 15, 16].includes(Number(row.row_id))),
      'rpc'
    )

    expect(items.filter(item => item.rowId !== undefined).map(item => item.id)).toEqual(rpc.map(item => item.id))
  })

  it('flags the unsolicited inbound DM and its answering turn', () => {
    const inbound = items.find(item => item.kind === 'bot_dm_in') as BotDmInItem

    expect(inbound.answersOurDispatch).toBeUndefined()
    expect(lastAssistant(items).replyToBotHandle).toBe('writer')
  })

  it('projects a cron delivery identically from either transport, id included', () => {
    // One delivery, one row, each transport's own aliases for its fields. Same
    // item and same id — `reconcile` pairs on both, so a REST/RPC switch mid-chat
    // must not turn one card into two. `seq` is positional and is renumbered by
    // `reconcile`, so the row stands alone here to keep it comparable.
    const fromRpc = rowsToItems([{ role: 'user', text: cronBotChatText, timestamp: 1_700_000_050, row_id: 16 }], 'rpc')
    const fromRest = rowsToItems(
      [
        { role: 'user', content: 'raw stored body', display_content: cronBotChatText, timestamp: 1_700_000_050, id: 16 }
      ],
      'rest'
    )

    expect(fromRest).toEqual(fromRpc)
    expect(fromRest[0]?.id).toBe('r:16')
    // And the same delivery inside the full fixture keeps that id.
    expect(items.find(item => item.kind === 'cron_delivery')?.id).toBe('r:16')
  })
})

describe('stripUserText', () => {
  it('drops the attached-context block and the warnings tail', () => {
    const stripped = stripUserText(String(attachedContextRow.text))

    expect(stripped.text).toBe('Look at and tell me what broke.')
    expect(stripped.attachments).toEqual(['@file:/srv/app/server.ts', '@image:/tmp/shot.png'])
  })

  it('leaves an ordinary message untouched', () => {
    expect(stripUserText('just a question')).toEqual({ text: 'just a question' })
  })

  it('reads a file-only prompt as no text and one reference', () => {
    // The whole bug: this is what a send with an attachment and no words
    // projects to on BOTH sides, so the reference is all there is to pair on.
    expect(stripUserText('@file:/srv/work/uploads/hermie/2026-09-20/ab-ui.xml')).toEqual({
      text: '',
      attachments: ['@file:/srv/work/uploads/hermie/2026-09-20/ab-ui.xml']
    })
  })
})

describe('attachment references as a comparison key', () => {
  it('reads the name out of a reference, quoted or not', () => {
    expect(attachmentRefName('@file:/srv/work/uploads/hermie/2026-09-20/8setj4h3-ui.xml')).toBe('8setj4h3-ui.xml')
    expect(attachmentRefName('@file:"/srv/work/my notes.txt"')).toBe('my notes.txt')
    expect(attachmentRefName('@file:`/srv/work/my notes.txt`')).toBe('my notes.txt')
    expect(attachmentRefName('@image:shot.png')).toBe('shot.png')
  })

  it('matches the same attachment described with and without its path', () => {
    // An attached image is the asymmetric case: the client named it, the gateway
    // chose where to put it, and only the name survives both.
    expect(attachmentsMatchKey(['@image:shot.png'])).toBe(
      attachmentsMatchKey(['@image:/srv/work/.hermes/images/shot.png'])
    )
  })

  it('ignores the order two references were listed in', () => {
    expect(attachmentsMatchKey(['@file:/a/one.txt', '@image:two.png'])).toBe(
      attachmentsMatchKey(['@image:/srv/two.png', '@file:/a/one.txt'])
    )
  })

  it('separates a picture from a document of the same name', () => {
    expect(attachmentsMatchKey(['@image:diagram.png'])).not.toBe(attachmentsMatchKey(['@file:diagram.png']))
  })

  it('is empty for a turn that carries nothing, so text alone decides', () => {
    expect(attachmentsMatchKey(undefined)).toBe('')
    expect(attachmentsMatchKey([])).toBe('')
  })
})

describe('rowsToItems edge cases', () => {
  it('recovers a reply that only survives in the codex sidecar', () => {
    const items = rowsToItems([codexSidecarRow], 'rpc')

    expect(items).toHaveLength(1)
    expect((items[0] as AssistantItem).text).toBe('Recovered reply.')
  })

  it('keeps a non-delivery process completion as a notice', () => {
    const items = rowsToItems(
      [{ role: 'user', row_id: 5, display_kind: 'process_complete', text: plainProcessText }],
      'rpc'
    )

    expect(items[0]).toMatchObject({ kind: 'notice', noticeKind: 'process_complete' })
    expect((items[0] as NoticeItem).body).toContain('error TS2345')
    expect((items[0] as NoticeItem).completions).toHaveLength(1)
  })

  it('keeps a delivery completion as a notice when no dispatch precedes it', () => {
    const items = rowsToItems(
      [{ role: 'user', row_id: 5, display_kind: 'process_complete', text: dmReplyProcessText }],
      'rpc'
    )

    expect(items[0]).toMatchObject({ kind: 'notice', noticeKind: 'process_complete' })
    expect((items[0] as NoticeItem).completions?.[0]?.sid).toBe('proc-2f9c')
  })

  it('drops rows with nothing to show', () => {
    expect(
      kinds([
        { role: 'assistant', text: '' },
        { role: 'user', text: '   ' }
      ])
    ).toEqual([])
  })

  it('ignores roles it does not model', () => {
    expect(kinds([{ role: 'developer', text: 'scaffolding' }])).toEqual([])
  })
})

describe('cron deliveries in a transcript', () => {
  it('projects the platform-mirror shape too', () => {
    const items = rowsToItems([{ role: 'user', row_id: 5, text: cronMirrorText }], 'rpc')

    expect(items[0]).toMatchObject({
      kind: 'cron_delivery',
      jobName: 'Morning Brief',
      body: 'Two deploys overnight, both green.',
      shape: 'mirror'
    })
  })

  it('carries the redaction flag through to the item', () => {
    const items = rowsToItems(
      [{ role: 'user', row_id: 5, text: `${cronBotChatHeader('[REDACTED - redaction failed]')}\n\nscrubbed` }],
      'rpc'
    )

    expect(items[0]).toMatchObject({ kind: 'cron_delivery', nameRedacted: true })
  })

  it('keeps a header the header arrived without a body yet', () => {
    const items = rowsToItems([{ role: 'user', row_id: 5, text: cronBotChatHeader('Inbox scan') }], 'rpc')

    // An empty body is still a delivery: the card says the job ran and said
    // nothing, which is not the same as no row at all.
    expect(items[0]).toMatchObject({ kind: 'cron_delivery', jobName: 'Inbox scan', body: '' })
  })

  it('leaves a quoted header a user turn', () => {
    const items = rowsToItems([{ role: 'user', row_id: 5, text: `why does it say ${cronBotChatText}` }], 'rpc')

    expect(items[0]?.kind).toBe('user')
  })

  it('leaves a header inside a fenced code block a user turn', () => {
    const items = rowsToItems(
      [{ role: 'user', row_id: 5, text: ['```', cronBotChatHeader('Inbox scan'), '```'].join('\n') }],
      'rpc'
    )

    expect(items[0]?.kind).toBe('user')
  })

  it('leaves a genuine message that merely starts with a bracket a user turn', () => {
    expect(kinds([{ role: 'user', row_id: 5, text: '[urgent] the build is red' }])).toEqual(['user'])
  })

  it('never fires on a row the gateway already labelled', () => {
    // A `display_kind` is a real marker; the header is only a heuristic, so the
    // marker wins and these stay what the gateway said they were.
    const items = rowsToItems(
      [
        { role: 'user', row_id: 1, text: cronBotChatText, display_kind: 'steer' },
        { role: 'user', row_id: 2, text: cronMirrorText, display_kind: 'skill_invocation' },
        { role: 'user', row_id: 3, text: cronBotChatText, display_kind: 'internal_notification' },
        { role: 'user', row_id: 4, text: cronBotChatText, display_kind: 'hidden' }
      ],
      'rpc'
    )

    expect(items.map(item => item.kind)).toEqual(['user', 'user', 'notice'])
    expect((items[0] as UserItem).displayKind).toBe('steer')
  })

  it('never fires on a role that is not user', () => {
    expect(kinds([{ role: 'system', text: cronBotChatText }])).toEqual(['user'])
    expect(kinds([{ role: 'assistant', text: cronBotChatText }])).toEqual(['assistant'])
  })

  it('reconciles on a text key both transports agree about', () => {
    const [rpc] = rowsToItems([{ role: 'user', text: cronBotChatText }], 'rpc') as [CronDeliveryItem]
    const [rest] = rowsToItems([{ role: 'user', display_content: cronBotChatText }], 'rest') as [CronDeliveryItem]

    expect(normalizedItemText(rpc)).toBe(normalizedItemText(rest))
    expect(normalizedItemText(rpc)).toContain('Inbox scan')
    expect(normalizedItemText(rpc)).toContain(cronBotChatBody.replace(/\s+/gu, ' ').trim())
  })
})

/**
 * The rows a gateway injects to start a turn, arriving without the
 * `display_kind` that would have named them.
 *
 * Over REST the column is not in the payload at all, and an older gateway never
 * wrote it — so the same row that is a card on one transport used to be the
 * owner's own bubble on the other, signed by somebody who never typed it.
 */
describe('an injected row with no display_kind', () => {
  const only = (text: string) => rowsToItems([{ role: 'user', row_id: 40, text }], 'rpc')[0] as NoticeItem

  it('draws a fan-out report as a notice, not as the owner speaking', () => {
    expect(only(delegationBatchText)).toMatchObject({
      kind: 'notice',
      noticeKind: 'async_delegation_complete',
      title: 'ASYNC DELEGATION BATCH COMPLETE — deleg_1bd47ada',
      body: delegationBatchText,
      rowId: 40
    })
  })

  it('closes the delegation group the report belongs to, exactly as the labelled row does', () => {
    const items = rowsToItems(
      [
        { role: 'tool', name: 'delegate_task', tool_id: 'call_d1', args: { tasks: [{ goal: 'Audit deps' }] } },
        { role: 'user', row_id: 41, text: delegationBatchText }
      ],
      'rpc'
    )

    expect(items[0]).toMatchObject({ kind: 'subagent_group', status: 'done', completion: delegationBatchText })
  })

  it('draws a background process, a compaction handoff and a kanban dispatch as notices', () => {
    expect(only(plainProcessText).noticeKind).toBe('process_complete')
    expect(only(priorContextText).noticeKind).toBe('internal_notification')
    expect(only(kanbanNotificationText + '\ndetails').noticeKind).toBe('internal_notification')
  })

  it('pairs with the same row described by its display_kind, because both say the same thing', () => {
    // The titles differ on purpose — the labelled row is titled by the gateway,
    // this one by its own header — and reconciliation must pair them anyway.
    const [labelled] = rowsToItems(
      [{ role: 'user', row_id: 42, text: delegationBatchText, display_kind: 'async_delegation_complete' }],
      'rpc'
    ) as [NoticeItem]
    const unlabelled = only(delegationBatchText)

    expect(labelled.title).not.toBe(unlabelled.title)
    expect(normalizedItemText(labelled)).toBe(normalizedItemText(unlabelled))
  })

  it('still leaves a message that merely opens with a bracket a user turn', () => {
    expect(kinds([{ role: 'user', row_id: 43, text: '[ok] done' }])).toEqual(['user'])
    expect(kinds([{ role: 'user', row_id: 44, text: '[1] first item\n[2] second item' }])).toEqual(['user'])
  })
})

/**
 * The wrapper a mid-turn steer is delivered in.
 *
 * `agent/prompt_builder.py::format_steer_marker` writes it, and every word of it
 * is addressed to the model: whose words these are, and that a replay is not a
 * new delivery. A chat loaded from history showed all three lines in the bubble.
 */
describe('a persisted steer row', () => {
  const row = (extra: Partial<TranscriptRow> = {}) =>
    rowsToItems(
      [{ role: 'user', row_id: 50, text: steerWrapperText, display_kind: 'steer', ...extra }],
      'rpc'
    )[0] as UserItem

  it('shows only the words the user typed', () => {
    expect(row()).toMatchObject({ kind: 'user', text: steerWrapperBody, displayKind: 'steer' })
  })

  it('is a steer even on a gateway that did not label it', () => {
    expect(row({ display_kind: null })).toMatchObject({ kind: 'user', text: steerWrapperBody, displayKind: 'steer' })
  })

  it('pairs with the optimistic bubble, which never saw the wrapper', () => {
    const [persisted] = rowsToItems([{ role: 'user', row_id: 51, text: steerWrapperText }], 'rpc') as [UserItem]

    expect(normalizedItemText(persisted)).toBe(steerWrapperBody)
  })
})

describe('the [System: …] wrapper, on the history path', () => {
  const unwrapped =
    'The active model for this chat has changed to k3 via provider moonshot. From this point forward, use this ' +
    'runtime metadata when answering questions about what model/provider is active.'

  it('comes off a row the gateway labelled, whichever label it used', () => {
    const rows: TranscriptRow[] = [
      { role: 'user', text: modelSwitchMarkerText, display_kind: 'model_switch', row_id: 1 },
      { role: 'user', text: modelSwitchMarkerText, display_kind: 'personality_switch', row_id: 2 },
      { role: 'user', text: modelSwitchMarkerText, display_kind: 'auto_continue', row_id: 3 }
    ]

    for (const item of rowsToItems(rows, 'rpc')) {
      expect((item as NoticeItem).body).toBe(unwrapped)
    }
  })

  it('comes off a row nothing labelled, to exactly the same words', () => {
    const [item] = rowsToItems([{ role: 'user', text: modelSwitchMarkerText, row_id: 9 }], 'rpc')

    expect(item).toMatchObject({ kind: 'notice', noticeKind: 'system_note', body: unwrapped })
  })

  it('leaves the two descriptions of one row saying the same thing', () => {
    /*
      The whole reason the unwrap sits in one place. A labelled row keeps the
      gateway's own title and an unlabelled one gets a title made from the
      sentence, so the two disagree about what the row is CALLED — which
      ADR-0018 allows. They must not disagree about what it SAYS: that is the
      key the two are paired on, and a mismatch paints the row twice.
    */
    const [labelled] = rowsToItems(
      [{ role: 'user', text: modelSwitchMarkerText, display_kind: 'model_switch', row_id: 1 }],
      'rpc'
    )
    const [bare] = rowsToItems([{ role: 'user', text: modelSwitchMarkerText, row_id: 1 }], 'rpc')

    expect((labelled as NoticeItem).title).not.toBe((bare as NoticeItem).title)
    expect(normalizedItemText(labelled!)).toBe(normalizedItemText(bare!))
  })

  it('leaves a body that is not a system note alone', () => {
    const [item] = rowsToItems([{ role: 'user', text: plainProcessText, row_id: 4 }], 'rpc')

    expect((item as NoticeItem).body).toBe('error TS2345: Argument of type string is not assignable.')
  })
})

describe('display_metadata.author (HERM-83)', () => {
  it('projects a valid author, leaving an unrelated metadata key alone', () => {
    const [item] = rowsToItems([authoredRow], 'rpc')

    expect((item as UserItem).author).toEqual({ id: 'oidc:user-a', name: 'Robin' })
  })

  it('projects no author when the stamp is a string, not an object', () => {
    const [item] = rowsToItems([authorlessRows.stringAuthor!], 'rpc')

    expect((item as UserItem).author).toBeUndefined()
  })

  it('projects no author for an empty author object', () => {
    const [item] = rowsToItems([authorlessRows.emptyAuthor!], 'rpc')

    expect((item as UserItem).author).toBeUndefined()
  })

  it('projects no author for a blank id', () => {
    const [item] = rowsToItems([authorlessRows.blankId!], 'rpc')

    expect((item as UserItem).author).toBeUndefined()
  })

  it('projects no author for a numeric id', () => {
    const [item] = rowsToItems([authorlessRows.numericId!], 'rpc')

    expect((item as UserItem).author).toBeUndefined()
  })

  it('drops the whole author when the id is valid but the name is not a string', () => {
    // D2: "accepting only a non-empty string id and a string name, and dropping
    // the whole thing otherwise" — a valid id does not entitle the row to a
    // half-formed author. The id is a real, usable identity here; the row still
    // gets none, because keeping it would mean this file decides on its own
    // which malformed shapes are "close enough", and the gateway never sent one.
    const [item] = rowsToItems([authorlessRows.numericName!], 'rpc')

    expect((item as UserItem).author).toBeUndefined()
  })

  it('projects no author when display_metadata itself is not an object', () => {
    const [item] = rowsToItems([authorlessRows.nonObjectMetadata!], 'rpc')

    expect((item as UserItem).author).toBeUndefined()
  })

  it('resolves the same author from the REST and the RPC shape of one row', () => {
    const [fromRpc] = rowsToItems([authoredRow], 'rpc')
    const [fromRest] = rowsToItems([authoredRowRest], 'rest')

    expect(fromRest).toEqual(fromRpc)
    expect((fromRest as UserItem).author).toEqual({ id: 'oidc:user-a', name: 'Robin' })
  })
})

describe('row identity', () => {
  const rpcTool: TranscriptRow = {
    role: 'tool',
    name: 'read_file',
    tool_call_id: 'call_0',
    row_id: 12,
    call_row_id: 11,
    call_index: 0,
    context: 'read_file(a.md)'
  }
  const restTool: TranscriptRow = {
    role: 'tool',
    name: 'read_file',
    tool_id: 'call_0',
    id: 12,
    call_row_id: 11,
    call_index: 1
  }

  it('reads an RPC tool row by its tool_call_id, its row id and its call identity', () => {
    const [item] = rowsToItems([rpcTool], 'rpc') as ToolItem[]

    expect(item).toMatchObject({ id: 't:call_0', toolId: 'call_0', rowId: 12, callKey: '11/0' })
  })

  it('reads a REST tool row by its tool_id, its id and its call identity', () => {
    const [item] = rowsToItems([restTool], 'rest') as ToolItem[]

    expect(item).toMatchObject({ id: 't:call_0', toolId: 'call_0', rowId: 12, callKey: '11/1' })
  })

  it('prefers tool_id over tool_call_id and falls back to the row index', () => {
    const rows: TranscriptRow[] = [
      { role: 'tool', name: 'a', tool_id: 'one', tool_call_id: 'two' },
      { role: 'tool', name: 'b' }
    ]

    expect((rowsToItems(rows, 'rpc') as ToolItem[]).map(item => item.toolId)).toEqual(['one', 'row-1'])
  })

  it('leaves a tool row with no identity exactly as it was', () => {
    const [item] = rowsToItems([{ role: 'tool', name: 'read_file', tool_id: 'call_1' }], 'rpc') as ToolItem[]

    expect(item).not.toHaveProperty('callKey')
    expect(item).not.toHaveProperty('rowId')
  })

  it('refuses half a call identity and malformed halves', () => {
    const rows: TranscriptRow[] = [
      { role: 'tool', name: 'a', tool_id: 'x', call_row_id: 11 },
      { role: 'tool', name: 'b', tool_id: 'y', call_index: 0 },
      { role: 'tool', name: 'c', tool_id: 'z', call_row_id: '11', call_index: 0 },
      { role: 'tool', name: 'd', tool_id: 'w', call_row_id: 11, call_index: -1 }
    ]

    for (const item of rowsToItems(rows, 'rpc') as ToolItem[]) {
      expect(item.callKey).toBeUndefined()
    }
  })

  it('carries the call identity onto a message_agent and a delegate_task row', () => {
    const rows: TranscriptRow[] = [
      {
        role: 'tool',
        name: 'message_agent',
        tool_id: 'dm',
        args: { target: '@bob', message: 'hi' },
        call_row_id: 3,
        call_index: 0
      },
      { role: 'tool', name: 'delegate_task', tool_id: 'dg', args: { goal: 'g' }, call_row_id: 3, call_index: 1 }
    ]
    const [dm, group] = rowsToItems(rows, 'rpc')

    expect((dm as BotDmOutItem).callKey).toBe('3/0')
    expect((group as SubagentGroupItem).callKey).toBe('3/1')
  })

  it('reads the turn id off a user row, from an object or from its JSON text', () => {
    const rows: TranscriptRow[] = [
      { role: 'user', text: 'hello', row_id: 1, display_metadata: { author: { id: 'a:1' }, turn_id: 'abc123' } },
      { role: 'user', text: 'again', row_id: 2, display_metadata: JSON.stringify({ turn_id: 'def456' }) },
      { role: 'user', text: 'plain', row_id: 3 },
      { role: 'user', text: 'empty', row_id: 4, display_metadata: { turn_id: '' } },
      { role: 'user', text: 'wrong', row_id: 5, display_metadata: { turn_id: 7 } }
    ]

    expect((rowsToItems(rows, 'rpc') as UserItem[]).map(item => item.turnId)).toEqual([
      'abc123',
      'def456',
      undefined,
      undefined,
      undefined
    ])
  })
})
