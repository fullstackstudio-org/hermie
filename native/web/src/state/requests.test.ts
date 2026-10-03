import { describe, expect, it } from 'vitest'

import { chatWith } from '../test-support/chat-fixtures'
import { createChatsStore } from './chats'
import { createPasskeysStore, type PasskeyConfirmation } from './passkeys'
import { bindRequests, createRequestsStore, type EngineRequest } from './requests'
import { createSecureInputStore, type SecurePrompt } from './secure-input'

/** A chat with a runtime session, which is what a question can be answered on. */
function setup() {
  const chats = createChatsStore()
  const requests = createRequestsStore()
  const stop = bindRequests(chats, requests)

  for (const bot of ['researcher', 'writer']) {
    chats.getState().hydrate(bot, chatWith(bot, [], { runtimeSessionId: `rt-${bot}` }))
  }

  const approval = (bot: string, id: string, command = 'ls'): void =>
    chats.getState().dispatchServerRequest(bot, { id, method: 'approval', params: { command, request_id: `a-${id}` } })
  const clarify = (bot: string, id: string, params: Record<string, unknown> = { question: 'Which?' }): void =>
    chats.getState().dispatchServerRequest(bot, { id, method: 'clarify', params })

  // No passkey store is bound here, so every entry is the engine's (the confirm kind has tests of its own
  // below); the list itself is handed back, because its identity is under test.
  const queue = (): readonly EngineRequest[] => requests.getState().queue as readonly EngineRequest[]

  return { chats, requests, stop, approval, clarify, queue }
}

describe('the open requests of every chat', () => {
  it('lists an approval and a clarify, each with the bot it belongs to', () => {
    const { approval, clarify, queue } = setup()

    approval('researcher', 'srq-1')
    clarify('writer', 'srq-2')

    expect(queue().map(entry => [entry.bot, entry.item.kind, entry.item.requestId])).toEqual([
      ['researcher', 'approval', 'srq-1'],
      ['writer', 'clarify', 'srq-2']
    ])
  })

  it('keeps them oldest first, in the order they were first seen, whichever chat they are in', () => {
    const { approval, clarify, queue } = setup()

    clarify('writer', 'srq-1')
    approval('researcher', 'srq-2')
    approval('writer', 'srq-3')

    expect(queue().map(entry => entry.item.requestId)).toEqual(['srq-1', 'srq-2', 'srq-3'])
  })

  it('takes a request off the list when it is answered, through the same store the controller writes', () => {
    const { chats, approval, queue } = setup()

    approval('researcher', 'srq-1')
    approval('researcher', 'srq-2')
    chats.getState().answer('researcher', 'srq-1', 'once')

    expect(queue().map(entry => entry.item.requestId)).toEqual(['srq-2'])
  })

  it('takes a request off the list when the gateway withdraws it', () => {
    const { chats, approval, queue } = setup()

    approval('researcher', 'srq-1')
    chats
      .getState()
      .dispatchEvent('researcher', { type: 'request.cancel', payload: { id: 'srq-1', reason: 'timeout' } })

    expect(queue()).toEqual([])
  })

  it('restores the requests a resume reports, the live one and the queue entry alike', () => {
    const { chats, queue } = setup()

    chats.getState().applySnapshot('researcher', {
      open_requests: [{ id: 'srq-9', method: 'clarify', params: { question: 'Which?', choices: ['a', 'b'] } }],
      pending_approval: { request_id: 'appr-1', command: 'rm -rf build' }
    })

    expect(queue().map(entry => [entry.bot, entry.item.kind])).toEqual([
      ['researcher', 'approval'],
      ['researcher', 'clarify']
    ])
  })

  it('does not list a chat that has no runtime session: there is nothing to answer on', () => {
    const { chats, approval, queue } = setup()

    approval('writer', 'srq-1')
    chats.getState().dropRuntime('writer')

    expect(queue()).toEqual([])
  })

  it('does not list a question that arrived already answered', () => {
    const { clarify, queue } = setup()

    clarify('researcher', 'srq-1', { question: 'Which?', answers: { q1: 'x' }, request_id: 'q1' })

    expect(queue()).toEqual([])
  })

  it('does not hand out a new list when a commit changed nothing about the requests', () => {
    const { chats, approval, queue } = setup()

    approval('researcher', 'srq-1')

    const before = queue()

    chats.getState().dispatchEvent('researcher', { type: 'message.start', payload: {} })
    chats.getState().dispatchEvent('researcher', { type: 'message.delta', payload: { text: 'hello' } })

    expect(queue()).toBe(before)
  })

  it('hands out a new list when a request changes (a locked answer)', () => {
    const { chats, clarify, queue } = setup()

    clarify('researcher', 'srq-1', {
      request_id: 'b1',
      questions: [
        { qid: 'q1', question: 'One?' },
        { qid: 'q2', question: 'Two?' }
      ]
    })

    const before = queue()

    chats.getState().answer('researcher', 'srq-1', { q1: 'yes' })

    expect(queue()).not.toBe(before)
    const item = queue()[0]?.item

    expect(item?.kind === 'clarify' ? item.locked : undefined).toEqual(['q1'])
  })

  it('empties the list when it is stopped, and follows nothing after', () => {
    const { approval, stop, queue } = setup()

    approval('researcher', 'srq-1')
    stop()
    approval('researcher', 'srq-2')

    expect(queue()).toEqual([])
  })
})

describe('confirmations beside the engine', () => {
  const confirmation = (id: string, overrides: Partial<PasskeyConfirmation> = {}): PasskeyConfirmation => ({
    id,
    sessionId: 'rt-researcher',
    title: 'Pay invoice',
    summary: 'Pay 120.00 EUR.',
    detail: null,
    baseUrl: 'https://gw.example.test',
    userName: 'Alex',
    expiresAt: null,
    phase: { kind: 'waiting' },
    answerMayHaveArrived: false,
    version: 1,
    dismissed: false,
    ...overrides
  })

  function setupBoth() {
    const chats = createChatsStore()
    const requests = createRequestsStore()
    const passkeys = createPasskeysStore()
    const stop = bindRequests(chats, requests, passkeys)

    chats.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-researcher' }))
    chats.getState().bindRuntime('researcher', 'rt-researcher')

    return { chats, requests, passkeys, stop, queue: () => requests.getState().queue }
  }

  it('queues a confirmation the passkey model shows, under the bot whose session it is in, after what came first', () => {
    const { chats, passkeys, queue } = setupBoth()

    chats.getState().dispatchServerRequest('researcher', {
      id: 'srq-1',
      method: 'approval',
      params: { command: 'ls', request_id: 'a-1' }
    })
    passkeys.setState({ confirmations: [confirmation('srq-2'), confirmation('srq-3', { sessionId: 'rt-elsewhere' })] })

    expect(
      queue().map(entry => [
        entry.kind,
        entry.bot,
        entry.kind === 'engine' ? entry.item.requestId : entry.kind === 'connection' ? entry.opId : entry.id
      ])
    ).toEqual([
      ['engine', 'researcher', 'srq-1'],
      ['confirm', 'researcher', 'srq-2'],
      ['confirm', undefined, 'srq-3']
    ])
  })

  it('follows a confirmation through its phases and takes it off once it is closed', () => {
    const { passkeys, queue } = setupBoth()

    passkeys.setState({ confirmations: [confirmation('srq-1')] })
    passkeys.setState({ confirmations: [confirmation('srq-1', { phase: { kind: 'received' }, version: 2 })] })

    expect(queue()).toEqual([
      { kind: 'confirm', key: 'confirm\u0000srq-1', bot: 'researcher', id: 'srq-1', version: 2 }
    ])

    passkeys.setState({
      confirmations: [confirmation('srq-1', { phase: { kind: 'received' }, version: 3, dismissed: true })]
    })

    expect(queue()).toEqual([])
  })

  it('names the bot once the chat on that session is bound, after the confirmation arrived', () => {
    const { chats, passkeys, queue } = setupBoth()

    passkeys.setState({ confirmations: [confirmation('srq-1', { sessionId: 'rt-writer' })] })
    expect(queue()[0]?.bot).toBeUndefined()

    chats.getState().hydrate('writer', chatWith('writer', [], { runtimeSessionId: 'rt-writer' }))
    chats.getState().bindRuntime('writer', 'rt-writer')

    expect(queue()[0]?.bot).toBe('writer')
  })

  it('lets go of the confirmations when it is stopped', () => {
    const { passkeys, stop, queue } = setupBoth()

    passkeys.setState({ confirmations: [confirmation('srq-1')] })
    stop()
    passkeys.setState({ confirmations: [confirmation('srq-2')] })

    expect(queue()).toEqual([])
  })
})

describe('secure prompts beside the engine', () => {
  const prompt = (id: string, bot: string, seq: number, method = 'sudo'): SecurePrompt => ({
    id,
    method,
    ask: { kind: 'sudo', command: 'ls' },
    bot,
    sessionId: `rt-${bot}`,
    deadline: null,
    earlierLost: null,
    seq
  })

  function setupSecure() {
    const chats = createChatsStore()
    const requests = createRequestsStore()
    const passkeys = createPasskeysStore()
    const secure = createSecureInputStore()
    const stop = bindRequests(chats, requests, passkeys, secure)

    chats.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-researcher' }))
    chats.getState().bindRuntime('researcher', 'rt-researcher')

    return { chats, requests, passkeys, secure, stop, queue: () => requests.getState().queue }
  }

  it('queues the prompts the secure input model holds, in its order, after what came first', () => {
    const { chats, secure, queue } = setupSecure()

    chats.getState().dispatchServerRequest('researcher', {
      id: 'srq-1',
      method: 'approval',
      params: { command: 'ls', request_id: 'a-1' }
    })
    secure.setState({ prompts: [prompt('srq-3', 'writer', 2, 'vault.code'), prompt('srq-2', 'researcher', 1)] })

    expect(
      queue().map(entry => [
        entry.kind,
        entry.bot,
        entry.kind === 'engine' ? entry.item.requestId : entry.kind === 'connection' ? entry.opId : entry.id
      ])
    ).toEqual([
      ['engine', 'researcher', 'srq-1'],
      ['secure', 'researcher', 'srq-2'],
      ['secure', 'writer', 'srq-3']
    ])
    expect(queue()[2]).toEqual({
      kind: 'secure',
      key: 'secure\u0000srq-3',
      bot: 'writer',
      id: 'srq-3',
      method: 'vault.code'
    })
  })

  it('follows a prompt to another chat and takes it off once the model lets go of it', () => {
    const { secure, queue } = setupSecure()

    secure.setState({ prompts: [prompt('srq-1', 'researcher', 1)] })
    secure.setState({ prompts: [prompt('srq-1', 'writer', 1)] })

    expect(queue().map(entry => entry.bot)).toEqual(['writer'])

    secure.setState({ prompts: [] })

    expect(queue()).toEqual([])
  })

  it('lets go of the prompts when it is stopped, and listens no more', () => {
    const { secure, stop, queue } = setupSecure()

    secure.setState({ prompts: [prompt('srq-1', 'researcher', 1)] })
    stop()
    secure.setState({ prompts: [prompt('srq-2', 'researcher', 2)] })

    expect(queue()).toEqual([])
  })
})
