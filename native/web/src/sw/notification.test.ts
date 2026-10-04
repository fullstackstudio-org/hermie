// @vitest-environment node
/**
 * What the worker shows for a push, read off the contract's own examples
 * (`contract/push/contract.json`, `examples`): the plugin builds the same data
 * bags and the same visible strings, so every example is a payload this worker
 * must handle, exactly as the contract says.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  buttonTitlesFor,
  closes,
  DEFAULT_TITLE,
  displayOf,
  inScope,
  launchUrlOf,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  PUSH_ACTION_ALLOW,
  PUSH_ACTION_DENY,
  PUSH_LAUNCH_PARAM,
  responseOf,
  tagOf
} from './notification'

interface ContractExample {
  name: string
  data: Record<string, unknown>
  title: string
  body: string
  category?: string
  silent?: boolean
}

interface Contract {
  examples: { list: ContractExample[] }
  category: { id: string; actions: { id: string; title: string }[] }
}

const here = dirname(fileURLToPath(import.meta.url))
const contract = JSON.parse(
  readFileSync(join(here, '..', '..', '..', '..', 'contract', 'push', 'contract.json'), 'utf8')
) as Contract

/** The Web Push payload the plugin sends for an example: `{title, body, data}`, or `{data}` alone for a clear. */
const payloadOf = (example: ContractExample): Record<string, unknown> =>
  example.silent ? { data: example.data } : { title: example.title, body: example.body, data: example.data }

const SCOPE = 'https://gw.example.test/dashboard-plugins/hermie/app/'

describe('every example of the contract', () => {
  it.each(contract.examples.list.map(example => [example.name, example] as const))('%s', (_name, example) => {
    const display = displayOf(payloadOf(example), ['en-GB'])

    if (example.silent) {
      // A clearing push shows nothing: it closes the notification it names.
      expect(display.kind).toBe('clear')

      return
    }

    expect(display.kind).toBe('show')

    if (display.kind !== 'show') {
      return
    }

    const { title, options } = display.notification

    // The visible strings exactly as the plugin sent them, and nothing of the data bag on screen.
    expect(title).toBe(example.title)
    expect(options.body).toBe(example.body)
    expect(options.data).toEqual(example.data)

    // The buttons exactly where the contract posts its category: an approval with a request id.
    const offered = options.actions.map(action => action.action)

    if (example.category === contract.category.id) {
      expect(offered).toEqual(contract.category.actions.map(action => action.id))
    } else {
      expect(offered).toEqual([])
    }

    expect(options.requireInteraction).toBe(example.data.type === 'request')
    expect(options.timestamp).toBe(1_790_000_000_000)
  })

  it('names the contract’s two actions, and only those', () => {
    expect([PUSH_ACTION_ALLOW, PUSH_ACTION_DENY]).toEqual(contract.category.actions.map(action => action.id))
  })
})

describe('a payload read defensively', () => {
  it.each([
    ['nothing', null],
    ['a string', 'hello'],
    ['an array', [1, 2]],
    ['an object with no title', { body: 'x' }],
    ['a title that is not a string', { title: 42, data: { bot: 'scout' } }],
    ['a blank title', { title: '   ', data: [] }]
  ])('shows a plain notification for %s', (_label, raw) => {
    const display = displayOf(raw)

    expect(display.kind).toBe('show')

    if (display.kind === 'show') {
      expect(display.notification.title).toBe(DEFAULT_TITLE)
      expect(display.notification.options.actions).toEqual([])
    }
  })

  it('cuts an over-long title and body rather than dropping them', () => {
    const display = displayOf({ title: 'x'.repeat(500), body: 'y'.repeat(5000), data: { bot: 'scout' } })

    if (display.kind !== 'show') {
      throw new Error('expected a notification')
    }

    expect(display.notification.title).toHaveLength(MAX_TITLE_LENGTH)
    expect(display.notification.options.body).toHaveLength(MAX_BODY_LENGTH)
  })

  it('offers no buttons for a request without a method, or for an approval without an id', () => {
    for (const data of [
      { type: 'request', bot: 'scout', requestId: 'appr-1' },
      { type: 'request', bot: 'scout', method: 'approval' },
      { type: 'request', bot: 'scout', method: 'confirm', requestId: 'srq-1', level: 'plain' }
    ]) {
      const display = displayOf({ title: 'scout', body: 'x', data })

      expect(display.kind === 'show' && display.notification.options.actions).toEqual([])
    }
  })

  it('names the buttons in the browser’s language when the client speaks it', () => {
    expect(buttonTitlesFor(['nl-NL', 'en'])).toEqual({ allow: 'Toestaan', deny: 'Weigeren' })
    expect(buttonTitlesFor(['fr-FR', 'de-AT'])).toEqual({ allow: 'Erlauben', deny: 'Ablehnen' })
    expect(buttonTitlesFor(['fr-FR'])).toEqual({ allow: 'Allow', deny: 'Deny' })
  })
})

describe('the tag', () => {
  it('is one per conversation of a bot, a request by its stored conversation', () => {
    expect(tagOf({ bot: 'scout', sessionId: 's1' })).toBe('hermie:scout:s1')
    expect(tagOf({ bot: 'scout', type: 'request', sessionId: 'runtime', sessionKey: 'stored' })).toBe(
      'hermie:scout:stored'
    )
    expect(tagOf({ bot: 'scout', session: 'old' })).toBe('hermie:scout:old')
    expect(tagOf({ bot: 'scout' })).toBe('hermie:scout')
    expect(tagOf({})).toBe('hermie')
  })
})

describe('a clearing push', () => {
  const approval = contract.examples.list.find(example => example.name === 'approval')
  const cleared = contract.examples.list.find(example => example.name === 'clear_approval_answered')
  const clarify = contract.examples.list.find(example => example.name === 'clarify_without_request_id')
  const clarifyCleared = contract.examples.list.find(example => example.name === 'clear_clarify_timeout')

  it('closes the notification it names by event id, or by request id', () => {
    for (const [shown, clear] of [
      [approval, cleared],
      [clarify, clarifyCleared]
    ] as const) {
      const display = displayOf(payloadOf(clear as ContractExample))

      if (display.kind !== 'clear') {
        throw new Error('expected a clear')
      }

      expect(closes(display.target, (shown as ContractExample).data)).toBe(true)
    }
  })

  it('closes nothing of another bot, and nothing it does not name', () => {
    const display = displayOf(payloadOf(cleared as ContractExample))

    if (display.kind !== 'clear') {
      throw new Error('expected a clear')
    }

    expect(closes(display.target, { ...(approval as ContractExample).data, bot: 'writer' })).toBe(false)
    expect(closes(display.target, { bot: 'scout', type: 'message', eventId: 'message:0' })).toBe(false)
    expect(closes({ bot: 'scout', requestId: '', replaces: '' }, { bot: 'scout', requestId: '' })).toBe(false)
  })
})

describe('a click', () => {
  it('hands the page the button and the data, whole', () => {
    expect(responseOf('', { bot: 'scout' })).toEqual({ actionIdentifier: 'default', data: { bot: 'scout' } })
    expect(responseOf(PUSH_ACTION_ALLOW, null)).toEqual({ actionIdentifier: PUSH_ACTION_ALLOW, data: {} })
  })

  it('goes only to a window that is the client, never to another page of the origin', () => {
    expect(inScope(`${SCOPE}index.html#/chat/scout`, SCOPE)).toBe(true)
    expect(inScope(`${SCOPE}?x=1`, SCOPE)).toBe(true)
    expect(inScope('https://gw.example.test/dashboard', SCOPE)).toBe(false)
    expect(inScope(`${SCOPE}licenses.json`, SCOPE)).toBe(false)
    expect(inScope('https://gw.example.test/dashboard-plugins/other/app/index.html', SCOPE)).toBe(false)
  })

  it('opens the client with the click in its address when no window is open', () => {
    const url = new URL(launchUrlOf(SCOPE, { actionIdentifier: 'default', data: { bot: 'scout' } }))

    expect(`${url.origin}${url.pathname}`).toBe(`${SCOPE}index.html`)
    expect(JSON.parse(url.searchParams.get(PUSH_LAUNCH_PARAM) ?? '')).toEqual({
      actionIdentifier: 'default',
      data: { bot: 'scout' }
    })
  })
})
