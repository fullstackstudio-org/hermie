/**
 * The slice of a connection the interactive model listens to, driven by hand: the
 * secure input fake's requests, `request.cancel` events and status, plus the
 * `request.answer` calls the model makes (answered by the test) and the `4041`
 * errors it sends (with their `data.reason`, as `failWithData` would carry them).
 */
import type { ConnectionStatus } from '@hermie/gateway-client'

import type { FailWithData, InteractiveEngine, InteractiveGateway } from '../core/requests/interactive'
import { type FakeSecureGateway, fakeSecureGateway, type Reply } from './secure-input-gateway'

export interface AnswerCall {
  method: string
  params: Record<string, unknown>
}

export interface FakeInteractiveGateway {
  gateway: InteractiveGateway
  /** Every `request.answer` (and other call) the model made, in order. */
  calls: AnswerCall[]
  /** Every reply a request got on its own frame, in order. */
  replies: Reply[]
  /** Every `4041` the model sent with its `data.reason`, in order. */
  declined: { id: string; code: number; message: string; reason: unknown }[]
  /** How the next calls are answered; a rejection is the gateway's error. Defaults to `{status: 'ok'}`. */
  onCall: { handler: (call: AnswerCall) => unknown | Promise<unknown> }
  failWithData: FailWithData
  deliver: FakeSecureGateway['deliver']
  cancel: FakeSecureGateway['cancel']
  status(status: ConnectionStatus): void
}

export function fakeInteractiveGateway(initial: ConnectionStatus = 'ready'): FakeInteractiveGateway {
  const base = fakeSecureGateway(initial)
  const calls: AnswerCall[] = []
  const declined: FakeInteractiveGateway['declined'] = []
  const onCall: FakeInteractiveGateway['onCall'] = { handler: () => ({ status: 'ok' }) }
  const gateway = {
    ...base.gateway,
    request: async (method: string, params: Record<string, unknown>) => {
      const call = { method, params }

      calls.push(call)

      return onCall.handler(call)
    }
  } as unknown as InteractiveGateway

  return {
    gateway,
    calls,
    replies: base.replies,
    declined,
    onCall,
    failWithData: (request, code, message, data) => {
      declined.push({ id: request.id, code, message, reason: data.reason })
      request.fail(code, message)
    },
    deliver: base.deliver,
    cancel: base.cancel,
    status: base.status
  }
}

/** What the transcript engine was told, in order. */
export type EngineCall =
  | {
      call: 'asked'
      bot: string
      id: string
      method: string
      title: string
      summary: string
      optional: boolean
      replayed: boolean
    }
  | { call: 'answered'; bot: string; id: string; summary: Record<string, unknown> }
  | { call: 'ended'; bot: string; id: string; reason: string }

export function recordingEngine(): { engine: InteractiveEngine; calls: EngineCall[] } {
  const calls: EngineCall[] = []

  return {
    calls,
    engine: {
      asked: (bot, request) => void calls.push({ call: 'asked', bot, ...request }),
      answered: (bot, id, summary) => void calls.push({ call: 'answered', bot, id, summary: { ...summary } }),
      ended: (bot, id, reason) => void calls.push({ call: 'ended', bot, id, reason })
    }
  }
}
