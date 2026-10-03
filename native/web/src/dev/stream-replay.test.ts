import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type ChatState, visibleItems } from '@hermie/transcript'
import { describe, expect, it } from 'vitest'

import { applyStep, patchState, replay, type StreamScenario } from './stream-replay'
import { deltaTexts, LiveConversation, syntheticChat, syntheticItems } from './synthetic-chat'

const STREAMS = join(__dirname, '../../../../contract/transcript/streams')
const scenarios: StreamScenario[] = readdirSync(STREAMS)
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => JSON.parse(readFileSync(join(STREAMS, name), 'utf8')) as StreamScenario)

const visibleIds = (state: ChatState) =>
  visibleItems(state, { level: 'normal', showBotToBot: true, showThinking: true }).map(row => row.item.id)

/**
 * An item made live is named after its place in the chat (`a:8000` is the
 * assistant reply at sequence 8000), so behind a long history the same reply
 * has a larger number. Rows the gateway persisted keep their names.
 */
const unplaced = (id: string) => id.replace(/^([a-z]):\d+$/, '$1:#')

describe('the stream replay', () => {
  it('finds the recorded scenarios', () => {
    expect(scenarios.map(scenario => scenario.scenario)).toContain('plain-turn')
    expect(scenarios.length).toBeGreaterThanOrEqual(6)
  })

  it.each(scenarios.map(scenario => [scenario.scenario, scenario] as const))(
    '%s reaches every recorded checkpoint',
    (_name, scenario) => {
      const states = [...replay(scenario)]
      for (const checkpoint of scenario.checkpoints) {
        const state = states[checkpoint.after - 1] as ChatState
        expect(visibleIds(state), checkpoint.label).toEqual((checkpoint.visible.normal ?? []).map(row => row.item.id))
      }
    }
  )

  it.each(scenarios.map(scenario => [scenario.scenario, scenario] as const))(
    '%s plays out the same at the end of a 5,000-item chat',
    (_name, scenario) => {
      const history = syntheticItems(5_000)
      const historyIds = history.map(item => item.id)
      const states = [...replay(scenario, { history })]
      for (const checkpoint of scenario.checkpoints) {
        const ids = visibleIds(states[checkpoint.after - 1] as ChatState)
        expect(ids.slice(0, historyIds.length)).toEqual(historyIds)
        expect(ids.slice(historyIds.length).map(unplaced), checkpoint.label).toEqual(
          (checkpoint.visible.normal ?? []).map(row => unplaced(row.item.id))
        )
      }
    }
  )

  it('interim-reopen settles each note, each tool card and the answer once, at every verbosity', () => {
    const scenario = scenarios.find(entry => entry.scenario === 'interim-reopen') as StreamScenario
    const settled = scenario.checkpoints.find(checkpoint => checkpoint.label === 'settled')
    const states = [...replay(scenario)]
    const state = states[(settled?.after ?? 0) - 1] as ChatState
    const notes = ['Entry 90 is marked paid.', 'Looking the transfer up through the API', 'Everything checks out']

    for (const level of ['quiet', 'normal', 'verbose'] as const) {
      const shown = visibleItems(state, { level, showBotToBot: true, showThinking: true }).map(row => row.item)
      const texts = shown.flatMap(item => (item.kind === 'assistant' ? [item.text] : []))

      for (const note of notes) {
        expect(
          texts.filter(text => text.startsWith(note)),
          `${level}: ${note}`
        ).toHaveLength(1)
      }

      expect(new Set(texts).size, `${level}: assistant texts`).toBe(texts.length)

      const tools = shown.flatMap(item => (item.kind === 'tool' && item.name === 'terminal' ? [item] : []))

      // Quiet hides tool cards; the others show the two calls of the turn, once each.
      expect(tools, level).toHaveLength(level === 'quiet' ? 0 : 2)
      expect(new Set(tools.map(item => item.callKey)).size, `${level}: call keys`).toBe(tools.length)
    }
  })

  it('refuses a step it does not know, or one before the state exists', () => {
    expect(() => applyStep(undefined, { op: 'applyEvent', args: [] })).toThrow(/before createChatState/)
    const state = applyStep(undefined, { op: 'createChatState', args: ['tester', 's', 's'] })
    expect(() => applyStep(state, { op: 'noSuchStep', args: [] })).toThrow(/not an engine operation/)
    expect(patchState(state, { lastSeq: 4 }, ['botName'])).not.toHaveProperty('botName')
  })
})

describe('the synthetic chat', () => {
  it('holds 5,000 items, deterministically', () => {
    const chat = syntheticChat(5_000)
    expect(chat.order.length).toBeGreaterThanOrEqual(5_000)
    expect(visibleIds(chat)).toEqual(visibleIds(syntheticChat(5_000)))
    expect(new Set(chat.order.map(id => chat.items[id]?.kind))).toEqual(new Set(['user', 'assistant', 'tool']))
  })

  it('streams turns of recorded deltas on top of it, changing only the tail', () => {
    let chat = syntheticChat(500)
    const live = new LiveConversation(deltaTexts(scenarios), 30, chat)
    const before = new Map(chat.order.map(id => [id, chat.items[id]]))

    for (let tick = 0; tick < 3 * 34; tick += 1) {
      chat = live.step(chat, 1_800_000_000_000 + tick)
    }

    expect(live.deltas).toBe(3 * 29)
    for (const [id, item] of before) {
      expect(chat.items[id]).toBe(item)
    }
    const added = chat.order.slice(before.size).map(id => chat.items[id]?.kind)
    expect(added).toEqual(['user', 'tool', 'assistant', 'user', 'tool', 'assistant', 'user', 'tool', 'assistant'])
  })
})
