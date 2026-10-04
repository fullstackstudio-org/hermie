import { JsonRpcGatewayError } from '@hermes/shared/json-rpc-channel'
import { describe, expect, it } from 'vitest'

import { ownedElsewhereDetails } from './session-ownership'

const SENTENCE = 'This chat is open in another Hermes window/terminal. Use it there, or start a new chat here.'

const refusal = (message: string, data: unknown = { reason: 'SESSION_NOT_OWNED' }, code = 4090) =>
  new JsonRpcGatewayError(message, { code, data })

describe('ownedElsewhereDetails', () => {
  it('reads the gateway’s details line, without its label', () => {
    expect(
      ownedElsewhereDetails(refusal(`${SENTENCE}\nDetails: session 20260923_143304_1025bb opened by cli 4m ago.`))
    ).toBe('session 20260923_143304_1025bb opened by cli 4m ago.')
  })

  it('puts a details text of several lines on one', () => {
    expect(ownedElsewhereDetails(refusal(`${SENTENCE}\nDetails: session a\nopened by cli\r\n4m ago.`))).toBe(
      'session a opened by cli 4m ago.'
    )
  })

  it('is the refusal, with an empty line, when the gateway sent no details', () => {
    expect(ownedElsewhereDetails(refusal(SENTENCE))).toBe('')
  })

  it('is nothing else: another reason, no reason, no code, or no error at all', () => {
    expect(ownedElsewhereDetails(refusal(SENTENCE, { reason: 'INVALID_PARAMS' }))).toBeNull()
    expect(ownedElsewhereDetails(refusal(SENTENCE, {}))).toBeNull()
    expect(ownedElsewhereDetails(refusal(SENTENCE, null))).toBeNull()
    expect(
      ownedElsewhereDetails(new JsonRpcGatewayError(SENTENCE, { data: { reason: 'SESSION_NOT_OWNED' } }))
    ).toBeNull()
    expect(ownedElsewhereDetails(new Error(SENTENCE))).toBeNull()
    expect(ownedElsewhereDetails(SENTENCE)).toBeNull()
    expect(ownedElsewhereDetails(null)).toBeNull()
  })
})
