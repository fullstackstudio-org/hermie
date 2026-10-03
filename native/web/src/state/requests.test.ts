import { describe, expect, it } from 'vitest'

import { chatWith } from '../test-support/chat-fixtures'
import { createChatsStore } from './chats'
import { bindRequests, createRequestsStore } from './requests'

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

  return { chats, requests, stop, approval, clarify, queue: () => requests.getState().queue }
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
