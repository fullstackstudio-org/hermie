/**
 * Delivering the outbox: one entry, one chat, one message.
 *
 * Every port is a fake here, which is the point of them being ports — the
 * questions worth asking are about ORDER and about what survives a failure, and
 * neither needs a gateway:
 *
 *  - a photograph and a note are ONE prompt, not two messages;
 *  - the chat is opened before the upload, because the upload needs the working
 *    directory the resume reports;
 *  - the entry is cleared AFTER the send and never before;
 *  - a send that failed leaves the entry exactly where it was.
 */
import { ShareDelivery, type ShareDeliveryPorts } from '../src/features/share/share-delivery'
import type { PendingShare, ShareOutboxEntry } from '../src/features/share/outbox'
import { SHARE_MANIFEST_VERSION } from '../src/features/share/outbox'

type Call = string

function entryFor(over: Record<string, unknown> = {}, files: Record<string, string> = {}): ShareOutboxEntry {
  const id = (over.id as string) ?? 'e1'
  const { claim, ...manifest } = over

  return {
    id,
    manifest: JSON.stringify({
      version: SHARE_MANIFEST_VERSION,
      id,
      note: 'have a look',
      createdAt: 10,
      items: [],
      ...manifest
    }),
    ...(claim === undefined ? {} : { claim: claim as string }),
    files
  }
}

/** What a share extension writes immediately before it submits. */
const claimed = (bot: string): string => JSON.stringify({ version: 1, bot, at: 42 })

function harness(entries: ShareOutboxEntry[], over: Partial<ShareDeliveryPorts> = {}) {
  const calls: Call[] = []
  let remaining = [...entries]
  const sent: { bot: string; text: string; attachments: unknown[] }[] = []
  let waiting: readonly PendingShare[] = []

  const ports: ShareDeliveryPorts = {
    inbox: {
      available: true,
      async list() {
        calls.push('list')

        return remaining.map(entry => ({ ...entry }))
      },
      async clear(id) {
        calls.push(`clear:${id}`)
        remaining = remaining.filter(entry => entry.id !== id)

        return true
      },
      // Outward traffic, which this flow never uses: the targets file is written
      // by `useShareTargetSync` and read by a share extension. Here so the port
      // is the real one rather than a narrower shape this test invented.
      async writeTargets() {
        calls.push('writeTargets')

        return true
      }
    },
    ready: () => true,
    open: async bot => {
      calls.push(`open:${bot}`)
    },
    upload: async (bot, file) => {
      calls.push(`upload:${bot}:${file.name}`)

      return { path: `/work/${file.name}`, reference: `@file:/work/${file.name}`, filename: file.name, size: file.size }
    },
    readImage: async (uri, filename) => {
      calls.push(`image:${filename}`)

      return { filename, base64: 'AAAA' }
    },
    send: async (bot, text, attachments) => {
      calls.push(`send:${bot}`)
      sent.push({ bot, text, attachments })
    },
    onChange: next => {
      waiting = next
    },
    ...over
  }

  return { calls, ports, sent, delivery: new ShareDelivery(ports), waiting: () => waiting }
}

describe('an entry that names its chat', () => {
  it('opens the chat, moves the files, and sends one message', async () => {
    const { calls, delivery, sent } = harness([
      entryFor(
        {
          bot: 'lance-vance',
          items: [
            { kind: 'image', path: 'shot.jpg', filename: 'shot.jpg', mimeType: 'image/jpeg', size: 9 },
            { kind: 'file', path: 'notes.pdf', filename: 'notes.pdf', mimeType: 'application/pdf', size: 4 },
            { kind: 'url', text: 'https://example.org' }
          ]
        },
        { 'shot.jpg': 'file:///tmp/shot.jpg', 'notes.pdf': 'file:///tmp/notes.pdf' }
      )
    ])

    await delivery.pump()

    // The chat FIRST: the upload needs the working directory the resume reports.
    expect(calls).toEqual([
      'list',
      'open:lance-vance',
      'image:shot.jpg',
      'upload:lance-vance:notes.pdf',
      'send:lance-vance',
      'clear:e1'
    ])

    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toBe('have a look\n\nhttps://example.org')
    expect(sent[0]?.attachments).toEqual([
      { kind: 'image', filename: 'shot.jpg', base64: 'AAAA' },
      { kind: 'file', filename: 'notes.pdf', path: '/work/notes.pdf' }
    ])
  })

  it('clears the entry only after the send, so nothing can be lost in the gap', async () => {
    const { calls, delivery } = harness([entryFor({ bot: 'b' })])

    await delivery.pump()

    expect(calls.indexOf('send:b')).toBeLessThan(calls.indexOf('clear:e1'))
  })

  /**
   * The one thing that must not happen on a failure: somebody's file quietly
   * discarded because a gateway answered 500.
   */
  it('leaves the entry alone when the send fails', async () => {
    const { calls, delivery, waiting } = harness([entryFor({ bot: 'b' })], {
      send: async () => {
        throw new Error('gateway said no')
      }
    })

    await delivery.pump()

    expect(calls.filter(call => call.startsWith('clear'))).toEqual([])
    expect(waiting().map(share => share.id)).toEqual(['e1'])
  })

  /**
   * And the other half, which is what the badge promises: a foreground, a
   * reconnect or a share link each start a new pump, and each tries again.
   * Within ONE pump an entry is attempted once, so a refusing gateway cannot
   * be hammered as fast as the event loop allows.
   */
  it('tries again on the next pump, and only once within one', async () => {
    let attempts = 0
    const { delivery } = harness([entryFor({ bot: 'b' })], {
      send: async () => {
        attempts += 1

        throw new Error('gateway said no')
      }
    })

    await delivery.pump()
    expect(attempts).toBe(1)

    await delivery.pump()
    expect(attempts).toBe(2)
  })

  it('does nothing at all while the gateway is down, but still reads the outbox', async () => {
    const { calls, delivery, waiting } = harness([entryFor({ bot: 'b' })], { ready: () => false })

    await delivery.pump()

    expect(calls).toEqual(['list'])
    // The badge is the whole of what the feature can offer here, and it needs
    // the entry to have been read.
    expect(waiting().map(share => share.id)).toEqual(['e1'])
  })
})

describe('an entry with no chat on it — Android’s ACTION_SEND', () => {
  it('waits, and is published so the picker can ask', async () => {
    const { calls, delivery, waiting } = harness([entryFor()])

    await delivery.pump()

    expect(calls).toEqual(['list'])
    expect(waiting()).toHaveLength(1)
    expect(waiting()[0]).not.toHaveProperty('bot')
  })

  it('is sent once a chat is picked', async () => {
    const { calls, delivery, sent } = harness([entryFor()])

    await delivery.pump()
    await delivery.assign('e1', 'researcher')

    expect(calls).toContain('send:researcher')
    expect(sent[0]?.bot).toBe('researcher')
  })

  it('takes the note the picker typed over the one the manifest carried', async () => {
    const { delivery, sent } = harness([entryFor()])

    await delivery.pump()
    await delivery.assign('e1', 'researcher', 'my own words')

    expect(sent[0]?.text).toBe('my own words')
  })

  it('keeps the manifest’s note when the picker sent none', async () => {
    const { delivery, sent } = harness([entryFor()])

    await delivery.pump()
    await delivery.assign('e1', 'researcher')

    expect(sent[0]?.text).toBe('have a look')
  })

  it('discards without sending', async () => {
    const { calls, delivery, sent, waiting } = harness([entryFor()])

    await delivery.pump()
    await delivery.discard('e1')

    expect(sent).toHaveLength(0)
    expect(calls).toContain('clear:e1')
    expect(waiting()).toHaveLength(0)
  })
})

describe('entries it cannot use', () => {
  /**
   * A manifest from a build this one does not understand, or one whose files
   * the system has reclaimed, can never be delivered. Keeping it would be an
   * outbox that only grows, in a container nobody can inspect.
   */
  it('clears an unreadable entry rather than retrying it forever', async () => {
    const { calls, delivery, waiting } = harness([
      { id: 'bad', manifest: '{not json', files: {} },
      { id: 'old', manifest: JSON.stringify({ version: 99, id: 'old' }), files: {} }
    ])

    await delivery.pump()

    expect(calls).toEqual(['list', 'clear:bad', 'clear:old'])
    expect(waiting()).toHaveLength(0)
  })

  it('sends nothing when there is no inbox on this platform', async () => {
    const { calls, delivery } = harness([entryFor({ bot: 'b' })], {
      inbox: {
        available: false,
        async list() {
          return []
        },
        async clear() {
          return false
        }
      }
    })

    await delivery.pump()

    expect(calls).toEqual([])
  })

  it('refuses a bot the roster does not have, and keeps the entry', async () => {
    const { calls, delivery, waiting } = harness([entryFor({ bot: 'ghost' })], {
      open: async bot => {
        throw new Error(`${bot} is not a bot on this gateway.`)
      }
    })

    await delivery.pump()

    expect(calls).toEqual(['list'])
    expect(waiting().map(share => share.id)).toEqual(['e1'])
  })
})

describe('two shares at once', () => {
  it('delivers them oldest first', async () => {
    const { calls, delivery } = harness([
      entryFor({ id: 'later', bot: 'b', createdAt: 20 }),
      entryFor({ id: 'earlier', bot: 'b', createdAt: 10 })
    ])

    await delivery.pump()

    expect(calls.filter(call => call.startsWith('clear'))).toEqual(['clear:earlier', 'clear:later'])
  })

  /**
   * Two pumps overlapping is the ordinary case: a foreground and a gateway
   * becoming ready happen within a frame of each other. Without the guard both
   * would read the same entry and send it twice.
   */
  it('does not deliver the same entry twice when two pumps overlap', async () => {
    const { calls, delivery } = harness([entryFor({ bot: 'b' })])

    await Promise.all([delivery.pump(), delivery.pump()])

    expect(calls.filter(call => call === 'send:b')).toHaveLength(1)
  })
})

/**
 * An entry a share extension got as far as submitting.
 *
 * This is the half of ADR-0026 that lives in TypeScript, and the only part of the
 * new path that can be tested without a phone. The rule is one sentence and both
 * directions of it are wrong: an entry whose claim is still there may have
 * arrived, so sending it can duplicate a message in somebody's chat, and dropping
 * it can lose what they shared. So it is neither sent nor dropped until a person
 * has answered.
 */
describe('a claimed entry', () => {
  it('is not delivered, however complete it looks', async () => {
    const { calls, delivery, waiting } = harness([entryFor({ bot: 'b', claim: claimed('b') })])

    await delivery.pump()

    expect(calls).toEqual(['list'])
    expect(waiting().map(share => share.id)).toEqual(['e1'])
    expect(waiting()[0]?.claim).toEqual({ version: 1, bot: 'b', at: 42 })
  })

  it('is not cleared either, so nothing is lost while it waits to be asked about', async () => {
    const { calls, delivery } = harness([entryFor({ bot: 'b', claim: claimed('b') })])

    await delivery.pump()
    await delivery.pump()

    expect(calls.filter(call => call.startsWith('clear'))).toEqual([])
  })

  it('goes once the person says to send it again', async () => {
    const { calls, delivery, waiting } = harness([entryFor({ bot: 'b', claim: claimed('b') })])

    await delivery.pump()
    await delivery.assign('e1', 'b')

    expect(calls).toContain('send:b')
    expect(calls).toContain('clear:e1')
    expect(waiting()).toEqual([])
  })

  it('goes for good when the person discards it instead', async () => {
    const { calls, delivery, waiting } = harness([entryFor({ bot: 'b', claim: claimed('b') })])

    await delivery.pump()
    await delivery.discard('e1')

    expect(calls).not.toContain('send:b')
    expect(calls).toContain('clear:e1')
    expect(waiting()).toEqual([])
  })

  /**
   * One claimed entry must not hold up an unclaimed one behind it. They are
   * separate shares and the question about the first is not a question about the
   * second.
   */
  it('does not block the entries around it', async () => {
    const { calls, delivery } = harness([
      entryFor({ id: 'asked', bot: 'b', createdAt: 10, claim: claimed('b') }),
      entryFor({ id: 'plain', bot: 'b', createdAt: 20 })
    ])

    await delivery.pump()

    expect(calls.filter(call => call.startsWith('clear'))).toEqual(['clear:plain'])
  })
})
