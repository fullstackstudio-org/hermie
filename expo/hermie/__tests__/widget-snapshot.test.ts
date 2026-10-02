/**
 * What the home-screen widgets are told.
 *
 * A widget process has no gateway and no store: it reads one file and draws it.
 * So every question a widget can answer is answered here, in a pure function,
 * and this file is the only place any of it is checked — there is no component
 * test on the other side of a Swift and a Kotlin renderer.
 *
 * The cases worth writing down are the ones where a plausible implementation
 * says something FALSE on a surface nobody can tap through to correct: a green
 * dot for an unreachable gateway, a count that includes an archived bot, a
 * colour initials cannot be read on.
 */
import { createChatState, type ChatState, type TranscriptItem } from '@hermie/transcript'

import type { Bot } from '../src/store/bots'
import { ACCENTS } from '../src/ui/tokens'
import {
  needsInputCount,
  projectWidgetSnapshot,
  sameWidgetContent,
  widgetAvatarPath,
  WIDGET_BOT_CAP,
  WIDGET_BOT_LIMIT,
  WIDGET_FOLDER_BOT_LIMIT,
  WIDGET_SNAPSHOT_VERSION,
  type WidgetSnapshotInput
} from '../src/features/widgets/snapshot'

const NOW = 1_770_000_000_000

function bot(name: string, overrides: Partial<Bot> = {}): Bot {
  return {
    name,
    displayName: name,
    description: '',
    model: 'example-provider/example-model',
    provider: 'example-provider',
    isDefault: false,
    hasAvatar: false,
    uiMetaRevision: 0,
    canonical: { id: `s-${name}`, resolvedId: `s-${name}`, preview: '', lastActive: 1_700, messageCount: 1 },
    ...overrides
  }
}

function input(overrides: Partial<WidgetSnapshotInput> = {}): WidgetSnapshotInput {
  return {
    bots: [bot('researcher')],
    nameOrder: 'profile',
    chats: {},
    running: {},
    lastSeen: {},
    accents: {},
    labels: {},
    archived: {},
    folders: [],
    mutes: {},
    gatewayReady: true,
    avatars: {},
    now: NOW,
    ...overrides
  }
}

/** A chat with `count` finished assistant replies, each stamped after `at`. */
function chatWithReplies(name: string, count: number, at: number): ChatState {
  const state = createChatState(name, 's', 's')

  for (let index = 0; index < count; index += 1) {
    const id = `a${index}`
    const item = { kind: 'assistant', id, text: 'hello', ts: at + index, interim: false } as unknown as TranscriptItem

    state.items[id] = item
    state.order.push(id)
  }

  return state
}

/** The same chat, plus `dms` bot-to-bot rows stamped after the replies. */
function chatWithDmTail(name: string, replies: number, dms: number, at: number): ChatState {
  const state = chatWithReplies(name, replies, at)

  for (let index = 0; index < dms; index += 1) {
    const id = `d${index}`
    const item = {
      kind: 'bot_dm_in',
      id,
      senderName: 'Writer',
      senderHandle: 'writer',
      text: 'still working on it',
      ts: at + replies + index
    } as unknown as TranscriptItem

    state.items[id] = item
    state.order.push(id)
  }

  return state
}

/** A chat parked on an approval nobody has answered. */
function chatAwaitingApproval(name: string): ChatState {
  const state = createChatState(name, 's', 's')
  const item = { kind: 'approval', id: 'r1', state: 'open' } as unknown as TranscriptItem

  state.items.r1 = item
  state.order.push('r1')

  return state
}

describe('projectWidgetSnapshot', () => {
  it('stamps the version and the time it was generated', () => {
    const snapshot = projectWidgetSnapshot(input())

    expect(snapshot.version).toBe(WIDGET_SNAPSHOT_VERSION)
    expect(snapshot.generatedAt).toBe(NOW)
  })

  it('orders by recency rather than by the owner arrangement', () => {
    const snapshot = projectWidgetSnapshot(
      input({
        bots: [
          bot('alpha', { canonical: { id: 'a', resolvedId: 'a', preview: '', lastActive: 100, messageCount: 1 } }),
          bot('beta', { canonical: { id: 'b', resolvedId: 'b', preview: '', lastActive: 900, messageCount: 1 } }),
          bot('gamma', { canonical: { id: 'g', resolvedId: 'g', preview: '', lastActive: 500, messageCount: 1 } })
        ]
      })
    )

    expect(snapshot.bots.map(entry => entry.name)).toEqual(['beta', 'gamma', 'alpha'])
  })

  /** Two bots that never spoke would otherwise swap places on every write. */
  it('breaks a tie by name, so the file does not churn', () => {
    const noSession = { canonical: undefined }
    const snapshot = projectWidgetSnapshot({
      ...input({ bots: [bot('zulu', noSession), bot('alpha', noSession)] })
    })

    expect(snapshot.bots.map(entry => entry.name)).toEqual(['alpha', 'zulu'])
  })

  it('leaves archived bots out entirely', () => {
    const snapshot = projectWidgetSnapshot(
      input({ bots: [bot('researcher'), bot('retired')], archived: { retired: true } })
    )

    expect(snapshot.bots.map(entry => entry.name)).toEqual(['researcher'])
  })

  it('keeps no more than the cap', () => {
    const many = Array.from({ length: WIDGET_BOT_LIMIT + 5 }, (_, index) =>
      bot(`bot-${index}`, {
        canonical: { id: `s${index}`, resolvedId: `s${index}`, preview: '', lastActive: index, messageCount: 1 }
      })
    )

    expect(projectWidgetSnapshot(input({ bots: many })).bots).toHaveLength(WIDGET_BOT_LIMIT)
  })

  /**
   * The one lie a glanceable surface must not tell. `presenceOf` already answers
   * `offline` for an unusable gateway; this pins that the widget file inherits
   * that rule rather than reporting whatever the roster last cached.
   */
  it('reports every bot offline while the gateway is not ready', () => {
    const snapshot = projectWidgetSnapshot(
      input({ bots: [bot('researcher'), bot('writer')], gatewayReady: false, running: { researcher: true } })
    )

    expect(snapshot.bots.map(entry => entry.presence)).toEqual(['offline', 'offline'])
  })

  it('is working when the roster placed a busy session on the bot', () => {
    const snapshot = projectWidgetSnapshot(input({ running: { researcher: true } }))

    expect(snapshot.bots[0]?.presence).toBe('working')
  })

  it('is needs-input, and says so twice, while an approval is open', () => {
    const snapshot = projectWidgetSnapshot(input({ chats: { researcher: chatAwaitingApproval('researcher') } }))

    expect(snapshot.bots[0]?.presence).toBe('needsInput')
    expect(snapshot.bots[0]?.needsInput).toBe(true)
    expect(needsInputCount(snapshot)).toBe(1)
  })

  it('counts unread against the same watermark the chat row uses', () => {
    const snapshot = projectWidgetSnapshot(
      input({ chats: { researcher: chatWithReplies('researcher', 3, 500) }, lastSeen: { researcher: 501 } })
    )

    // Stamps are 500, 501 and 502; the watermark is 501, so one is unread.
    expect(snapshot.bots[0]?.unread).toBe(1)
  })

  it('has nothing to count for a chat the app never opened', () => {
    expect(projectWidgetSnapshot(input()).bots[0]?.unread).toBe(0)
  })

  /**
   * A widget is the loudest place a count appears, and bot-to-bot traffic is the
   * cheapest thing to produce a lot of.
   *
   * Two teammate messages land after the two replies. The count stays at the two
   * replies, and a chat whose WHOLE tail is teammate chatter counts nothing at
   * all — there is no badge to be had from agents talking amongst themselves.
   */
  it('leaves bot-to-bot rows out of the count', () => {
    const withTail = projectWidgetSnapshot(
      input({ chats: { researcher: chatWithDmTail('researcher', 2, 2, 500) }, lastSeen: { researcher: 499 } })
    )

    expect(withTail.bots[0]?.unread).toBe(2)

    const onlyDms = projectWidgetSnapshot(
      input({ chats: { researcher: chatWithDmTail('researcher', 0, 3, 500) }, lastSeen: { researcher: 499 } })
    )

    expect(onlyDms.bots[0]?.unread).toBe(0)
  })

  it('strips the markdown off the last line the way the chat row does', () => {
    const snapshot = projectWidgetSnapshot(
      input({
        bots: [
          bot('researcher', {
            canonical: {
              id: 's',
              resolvedId: 's',
              preview: '## Retry semantics\n\nand so on',
              lastActive: 1,
              messageCount: 1
            }
          })
        ]
      })
    )

    expect(snapshot.bots[0]?.lastLine).not.toContain('#')
    expect(snapshot.bots[0]?.lastLine).toContain('Retry semantics')
  })

  /**
   * `bubble` and not `fill`. Lime's fill is `#C7FF4A`, which white measures
   * about 1.3 : 1 against — initials drawn on it would be initials nobody can
   * read, and no native side has a palette of its own to correct it with.
   */
  it('takes the colour from the accent value white is readable on', () => {
    const snapshot = projectWidgetSnapshot(input({ accents: { researcher: 'lime' } }))

    expect(snapshot.bots[0]?.colour).toBe(ACCENTS.lime.bubble)
    expect(snapshot.bots[0]?.colour).not.toBe(ACCENTS.lime.fill)
  })

  it('falls back to the Blue preset accent for a chat with no colour', () => {
    expect(projectWidgetSnapshot(input()).bots[0]?.colour).toBe(ACCENTS.default.bubble)
  })

  it('names an avatar only once the file is actually in the container', () => {
    expect(projectWidgetSnapshot(input({ avatars: {} })).bots[0]?.avatarPath).toBeUndefined()
    expect(projectWidgetSnapshot(input({ avatars: { researcher: true } })).bots[0]?.avatarPath).toBe(
      widgetAvatarPath('researcher')
    )
  })

  it('escapes a bot name that would otherwise leave its directory', () => {
    expect(widgetAvatarPath('../../etc/passwd')).toBe('avatars/..%2F..%2Fetc%2Fpasswd.png')
  })

  it('draws the app’s primary name, and takes the initial off that', () => {
    const withBoth = { bots: [bot('researcher', { displayName: 'Onderzoeker' })] }

    // The widget has room for ONE name, so it draws the app's primary one —
    // the handle under the shipping default — and the initial follows it.
    const leading = projectWidgetSnapshot(input(withBoth))

    expect(leading.bots[0]?.displayName).toBe('researcher')
    expect(leading.bots[0]?.initials).toBe('R')

    // Switch the order in Settings and the home screen follows.
    const friendly = projectWidgetSnapshot(input({ ...withBoth, nameOrder: 'display' }))

    expect(friendly.bots[0]?.displayName).toBe('Onderzoeker')
    expect(friendly.bots[0]?.initials).toBe('O')

    // `name` is the deep link's key and the avatar file's key either way.
    expect(leading.bots[0]?.name).toBe('researcher')
    expect(friendly.bots[0]?.name).toBe('researcher')
  })
})

describe('sameWidgetContent', () => {
  it('ignores the timestamp, which changes on every store notification', () => {
    const first = projectWidgetSnapshot(input())
    const second = projectWidgetSnapshot(input({ now: NOW + 60_000 }))

    expect(sameWidgetContent(first, second)).toBe(true)
  })

  it('notices a change a reader would see', () => {
    const first = projectWidgetSnapshot(input())
    const second = projectWidgetSnapshot(input({ running: { researcher: true } }))

    expect(sameWidgetContent(first, second)).toBe(false)
  })

  it('is false against nothing written yet, so the first write always happens', () => {
    expect(sameWidgetContent(null, projectWidgetSnapshot(input()))).toBe(false)
  })
})

/**
 * A widget pinned to one folder.
 *
 * The folder is the only part of the owner's arrangement that reaches a home
 * screen, and the two numbers on it follow the CHAT LIST's rules rather than
 * the per-bot rules the rows follow. That divergence is the thing most worth
 * pinning here, because it is the one a reader will notice and report.
 */
describe('the folders a widget can be pinned to', () => {
  const folder = (bots: string[]) => ({ id: 'f1', name: 'Finance', bots })

  it('carries each folder with its contents in recency order', () => {
    const snapshot = projectWidgetSnapshot(
      input({
        bots: [
          bot('older', { canonical: { id: 'a', resolvedId: 'a', preview: '', lastActive: 100, messageCount: 1 } }),
          bot('newer', { canonical: { id: 'b', resolvedId: 'b', preview: '', lastActive: 900, messageCount: 1 } })
        ],
        // Written in the arrangement's order, which is NOT the widget's.
        folders: [folder(['older', 'newer'])]
      })
    )

    expect(snapshot.folders).toHaveLength(1)
    expect(snapshot.folders[0]?.bots).toEqual(['newer', 'older'])
    expect(snapshot.folders[0]?.size).toBe(2)
  })

  /**
   * The divergence, stated as a test. A muted chat contributes nothing to its
   * OWN badge — a widget is the loudest place a count appears — and everything
   * to its folder's, because a summary that drops part of what it is
   * summarising removes information rather than aggregating it.
   */
  it('counts a muted chat in the folder and not on its row', () => {
    const snapshot = projectWidgetSnapshot(
      input({
        bots: [bot('quiet')],
        chats: { quiet: chatWithReplies('quiet', 4, 2_000) },
        mutes: { quiet: 0 },
        folders: [folder(['quiet'])]
      })
    )

    expect(snapshot.bots[0]?.unread).toBe(0)
    expect(snapshot.folders[0]?.unread).toBe(4)
  })

  /** The other half of the same rule, and it points the other way. */
  it('leaves a muted chat out of the needs-input count', () => {
    const snapshot = projectWidgetSnapshot(
      input({
        bots: [bot('quiet'), bot('loud')],
        chats: { quiet: chatAwaitingApproval('quiet'), loud: chatAwaitingApproval('loud') },
        mutes: { quiet: 0 },
        folders: [folder(['quiet', 'loud'])]
      })
    )

    expect(snapshot.folders[0]?.needsInput).toBe(1)
  })

  /** The aggregate reads the same predicate, so it had better agree. */
  it('leaves bot-to-bot rows out of the folder aggregate too', () => {
    const snapshot = projectWidgetSnapshot(
      input({
        bots: [bot('busy'), bot('chatty')],
        chats: {
          busy: chatWithDmTail('busy', 2, 5, 2_000),
          chatty: chatWithDmTail('chatty', 0, 9, 2_000)
        },
        folders: [folder(['busy', 'chatty'])]
      })
    )

    expect(snapshot.folders[0]?.unread).toBe(2)
  })

  it('counts every bot inside, not only the ones that fit', () => {
    const many = Array.from({ length: WIDGET_FOLDER_BOT_LIMIT + 3 }, (_, index) => bot(`b${index}`))
    const chats = Object.fromEntries(many.map(entry => [entry.name, chatWithReplies(entry.name, 1, 2_000)]))

    const snapshot = projectWidgetSnapshot(
      input({ bots: many, chats, folders: [folder(many.map(entry => entry.name))] })
    )

    expect(snapshot.folders[0]?.bots).toHaveLength(WIDGET_FOLDER_BOT_LIMIT)
    expect(snapshot.folders[0]?.size).toBe(many.length)
    expect(snapshot.folders[0]?.unread).toBe(many.length)
  })

  it('leaves an archived bot out of both the list and the count', () => {
    const snapshot = projectWidgetSnapshot(
      input({
        bots: [bot('kept'), bot('gone')],
        chats: { gone: chatWithReplies('gone', 3, 2_000) },
        archived: { gone: true },
        folders: [folder(['kept', 'gone'])]
      })
    )

    expect(snapshot.folders[0]?.bots).toEqual(['kept'])
    expect(snapshot.folders[0]?.size).toBe(1)
    expect(snapshot.folders[0]?.unread).toBe(0)
  })

  /**
   * A widget configured for one of these would be permanently empty, and the
   * picker offering it would be a picker offering a dead end.
   */
  it('drops a folder whose bots have all left the roster', () => {
    expect(projectWidgetSnapshot(input({ bots: [bot('here')], folders: [folder(['ghost'])] })).folders).toEqual([])
  })

  it('writes the colour as hex, the same way a bot’s is written', () => {
    const snapshot = projectWidgetSnapshot(
      input({ bots: [bot('a')], folders: [{ id: 'f1', name: 'Finance', colour: 'lime', bots: ['a'] }] })
    )

    expect(snapshot.folders[0]?.colour).toBe(ACCENTS.lime.bubble)
    expect(projectWidgetSnapshot(input({ folders: [folder(['researcher'])] })).folders[0]).not.toHaveProperty('colour')
  })

  /**
   * The reason the bot list changed shape at all. A folder whose members have
   * all been quiet for a week would otherwise fall off the end of the twelve
   * most recent and leave a widget pinned to it permanently empty.
   */
  it('keeps a folder’s bots in the file even when they are not recent', () => {
    const recent = Array.from({ length: WIDGET_BOT_LIMIT }, (_, index) =>
      bot(`r${index}`, {
        canonical: { id: `r${index}`, resolvedId: `r${index}`, preview: '', lastActive: 9_000 + index, messageCount: 1 }
      })
    )
    const stale = bot('stale', {
      canonical: { id: 'stale', resolvedId: 'stale', preview: '', lastActive: 1, messageCount: 1 }
    })

    const snapshot = projectWidgetSnapshot(input({ bots: [...recent, stale], folders: [folder(['stale'])] }))

    expect(snapshot.bots.map(entry => entry.name)).toContain('stale')
    // And the unconfigured widgets are untouched: they read the front of the
    // same list, which is the same twelve it always was.
    expect(snapshot.bots.slice(0, WIDGET_BOT_LIMIT).map(entry => entry.name)).not.toContain('stale')
  })

  it('never writes more than the file’s ceiling, however many folders there are', () => {
    const many = Array.from({ length: WIDGET_BOT_CAP + 10 }, (_, index) =>
      bot(`b${index}`, {
        canonical: { id: `b${index}`, resolvedId: `b${index}`, preview: '', lastActive: index, messageCount: 1 }
      })
    )

    const folders = Array.from({ length: 6 }, (_, index) => ({
      id: `f${index}`,
      name: `Folder ${index}`,
      bots: many.slice(index * 5, index * 5 + 5).map(entry => entry.name)
    }))

    expect(projectWidgetSnapshot(input({ bots: many, folders })).bots.length).toBeLessThanOrEqual(WIDGET_BOT_CAP)
  })

  /**
   * A folder's badge counts muted chats, so a message into a silenced
   * conversation moves a number no bot row shows. Comparing the rows alone
   * would drop that write and leave a folder widget stale for exactly the case
   * it was configured to watch.
   */
  it('notices a change that only a folder can see', () => {
    const before = projectWidgetSnapshot(
      input({ bots: [bot('quiet')], mutes: { quiet: 0 }, folders: [folder(['quiet'])] })
    )
    const after = projectWidgetSnapshot(
      input({
        bots: [bot('quiet')],
        chats: { quiet: chatWithReplies('quiet', 2, 2_000) },
        mutes: { quiet: 0 },
        folders: [folder(['quiet'])]
      })
    )

    expect(JSON.stringify(before.bots)).toBe(JSON.stringify(after.bots))
    expect(sameWidgetContent(before, after)).toBe(false)
  })
})
