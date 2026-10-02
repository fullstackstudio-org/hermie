/**
 * Which road `Regenerate` takes, and the two cases where it takes neither.
 */
import type { TranscriptItem } from '@hermie/transcript'

import { regenerateLastTurn, regenerateTargetIsOwn, type RegenerateSource } from '../src/features/chats/regenerate'

let seq = 0

const row = (item: Partial<TranscriptItem> & { kind: TranscriptItem['kind'] }) => ({
  item: { id: `i${(seq += 1)}`, origin: 'history', seq, version: 1, ...item } as TranscriptItem
})

const ME = { id: 'authentik:me' }
const COLLEAGUE = { id: 'authentik:robin', name: 'Robin Vale' }

const source = (over: Partial<RegenerateSource> = {}): RegenerateSource => ({
  items: [
    row({ kind: 'user', text: 'Introduce yourself.' } as never),
    row({ interim: false, kind: 'assistant', streaming: false, text: 'I am researcher.' } as never)
  ],
  knowsSlashCommand: () => false,
  runSlash: async () => undefined,
  send: async () => undefined,
  turnActive: false,
  ...over
})

describe('regenerating the last reply', () => {
  it('goes down the slash path when the catalogue has /retry', async () => {
    const runSlash = jest.fn(async () => undefined)
    const send = jest.fn(async () => undefined)

    const outcome = await regenerateLastTurn(source({ knowsSlashCommand: name => name === 'retry', runSlash, send }))

    expect(outcome).toEqual({ kind: 'retried' })
    // The gateway's own command re-runs the turn on its side, so the
    // conversation gains a reply and not a second copy of the prompt.
    expect(runSlash).toHaveBeenCalledWith('/retry')
    expect(send).not.toHaveBeenCalled()
  })

  it('sends the previous prompt again on a gateway that has no /retry', async () => {
    const runSlash = jest.fn(async () => undefined)
    const send = jest.fn(async () => undefined)

    const outcome = await regenerateLastTurn(source({ runSlash, send }))

    expect(outcome).toEqual({ kind: 'resent', text: 'Introduce yourself.' })
    expect(send).toHaveBeenCalledWith('Introduce yourself.')
    expect(runSlash).not.toHaveBeenCalled()
  })

  it('repeats the reader’s own turn, not whatever happens to be last', async () => {
    const send = jest.fn(async () => undefined)

    await regenerateLastTurn(
      source({
        items: [
          row({ kind: 'user', text: 'The real prompt.' } as never),
          row({ interim: false, kind: 'assistant', streaming: false, text: 'A reply.' } as never),
          // A scheduler and another bot both write rows on this side of the
          // conversation; neither is something the reader asked for.
          row({ body: 'Nightly report.', jobName: 'scan', kind: 'cron_delivery', shape: 'header' } as never),
          row({ kind: 'bot_dm_in', senderName: 'Writer', text: 'Anything else?' } as never)
        ],
        send
      })
    )

    expect(send).toHaveBeenCalledWith('The real prompt.')
  })

  it('refuses while a turn is running, before it asks the catalogue anything', async () => {
    const runSlash = jest.fn(async () => undefined)
    const send = jest.fn(async () => undefined)
    const knowsSlashCommand = jest.fn(() => true)

    expect(await regenerateLastTurn(source({ knowsSlashCommand, runSlash, send, turnActive: true }))).toEqual({
      kind: 'busy'
    })

    expect(runSlash).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(knowsSlashCommand).not.toHaveBeenCalled()
  })

  it('refuses when there is no prompt in the conversation to repeat', async () => {
    const send = jest.fn(async () => undefined)

    expect(
      await regenerateLastTurn(
        source({
          items: [row({ body: 'Nightly report.', jobName: 'scan', kind: 'cron_delivery', shape: 'header' } as never)],
          send
        })
      )
    ).toEqual({ kind: 'nothing' })

    expect(send).not.toHaveBeenCalled()
  })

  it('lets a gateway failure through rather than swallowing it as a refusal', async () => {
    await expect(
      regenerateLastTurn(
        source({
          knowsSlashCommand: () => true,
          runSlash: async () => {
            throw new Error('the worker died')
          }
        })
      )
    ).rejects.toThrow('the worker died')
  })
})

/**
 * HERM-83: in the group chat, `lastPrompt` repeats only the reader's own
 * words, never a colleague's — and `regenerateTargetIsOwn` answers the same
 * question for the menu, so the line is never offered only to be refused.
 */
describe('whose turn Regenerate repeats, in the group chat', () => {
  it('resends the reader’s own newest turn exactly as outside the group chat', async () => {
    const send = jest.fn(async () => undefined)

    const outcome = await regenerateLastTurn(
      source({
        groupChat: true,
        items: [
          row({ author: ME, kind: 'user', text: 'Introduce yourself.' } as never),
          row({ interim: false, kind: 'assistant', streaming: false, text: 'I am researcher.' } as never)
        ],
        ownAuthorId: ME.id,
        send
      })
    )

    expect(outcome).toEqual({ kind: 'resent', text: 'Introduce yourself.' })
    expect(send).toHaveBeenCalledWith('Introduce yourself.')
  })

  it('refuses a colleague’s newest turn rather than resending it under the reader’s name', async () => {
    const send = jest.fn(async () => undefined)

    const outcome = await regenerateLastTurn(
      source({
        groupChat: true,
        items: [
          row({ author: COLLEAGUE, kind: 'user', text: 'What is our runway?' } as never),
          row({ interim: false, kind: 'assistant', streaming: false, text: 'Six months.' } as never)
        ],
        ownAuthorId: ME.id,
        send
      })
    )

    expect(outcome).toEqual({ kind: 'nothing' })
    expect(send).not.toHaveBeenCalled()
  })

  it('still resends an unattributed turn, exactly as before `author` existed', async () => {
    const send = jest.fn(async () => undefined)

    const outcome = await regenerateLastTurn(
      source({
        groupChat: true,
        items: [
          row({ kind: 'user', text: 'Introduce yourself.' } as never),
          row({ interim: false, kind: 'assistant', streaming: false, text: 'I am researcher.' } as never)
        ],
        ownAuthorId: ME.id,
        send
      })
    )

    expect(outcome).toEqual({ kind: 'resent', text: 'Introduce yourself.' })
  })

  it('never falls back to an older prompt of the reader’s own once a colleague has spoken since', async () => {
    // Robin's question is the newest turn; the reply being regenerated
    // answered THAT, not the reader's own earlier turn. Resending the older
    // prompt would send an answer to a question nobody just asked.
    const send = jest.fn(async () => undefined)

    const outcome = await regenerateLastTurn(
      source({
        groupChat: true,
        items: [
          row({ author: ME, kind: 'user', text: 'The real prompt.' } as never),
          row({ interim: false, kind: 'assistant', streaming: false, text: 'A reply.' } as never),
          row({ author: COLLEAGUE, kind: 'user', text: 'What is our runway?' } as never)
        ],
        ownAuthorId: ME.id,
        send
      })
    )

    expect(outcome).toEqual({ kind: 'nothing' })
    expect(send).not.toHaveBeenCalled()
  })

  it('is unaffected outside the group chat, even with a foreign-looking author on the row', () => {
    const items = [row({ author: COLLEAGUE, kind: 'user', text: 'What is our runway?' } as never)]

    expect(regenerateTargetIsOwn(items, { groupChat: false, ownAuthorId: ME.id })).toBe(true)
  })

  it('answers the same way `lastPrompt` decides, for the menu to ask before offering the line', () => {
    const ownNewest = [
      row({ author: ME, kind: 'user', text: 'Introduce yourself.' } as never),
      row({ interim: false, kind: 'assistant', streaming: false, text: 'I am researcher.' } as never)
    ]
    const colleagueNewest = [
      row({ author: COLLEAGUE, kind: 'user', text: 'What is our runway?' } as never),
      row({ interim: false, kind: 'assistant', streaming: false, text: 'Six months.' } as never)
    ]

    expect(regenerateTargetIsOwn(ownNewest, { groupChat: true, ownAuthorId: ME.id })).toBe(true)
    expect(regenerateTargetIsOwn(colleagueNewest, { groupChat: true, ownAuthorId: ME.id })).toBe(false)
    // Nothing to repeat at all is not an authorship refusal — the "nothing"
    // outcome in `regenerateLastTurn` covers that separately.
    expect(regenerateTargetIsOwn([], { groupChat: true, ownAuthorId: ME.id })).toBe(true)
  })
})
