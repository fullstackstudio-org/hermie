import { describe, expect, it } from 'vitest'

import type { ModelChoice } from '../../core/chat-controller'
import { MODEL_SEARCH_FROM, modelGroups, otherModelCount } from './model-choices'

const catalogue: ModelChoice[] = [
  { id: 'example-provider/example-model', label: 'example-model', provider: 'Example Provider' },
  { id: 'example-provider/expensive-model', label: 'expensive-model', provider: 'Example Provider' },
  { id: 'second-provider/reasoner-2', label: 'reasoner-2', provider: 'Second Provider' },
  { id: 'bare-model', label: 'bare-model', provider: '' }
]

describe('the model picker’s list', () => {
  it('cuts the gateway’s models into one group per provider, in the gateway’s order', () => {
    const groups = modelGroups(catalogue, 'example-provider/example-model')

    expect(groups.map(group => group.provider)).toEqual(['Example Provider', 'Second Provider', null])
    expect(groups[0]?.models.map(model => model.id)).toEqual([
      'example-provider/example-model',
      'example-provider/expensive-model'
    ])
    // The wire id is what a switch sends; the label is what a reader calls it.
    expect(groups[1]?.models[0]).toEqual({ id: 'second-provider/reasoner-2', label: expect.any(String) })
  })

  it('keeps the model the chat is on above the groups when the inventory does not list it', () => {
    const groups = modelGroups(catalogue, 'hand-set/odd-model')

    expect(groups[0]).toMatchObject({ provider: null, models: [{ id: 'hand-set/odd-model' }] })
    expect(groups).toHaveLength(4)
  })

  it('is just the current model when the inventory is empty, and nothing when there is no model either', () => {
    expect(modelGroups([], 'a/b')).toEqual([{ provider: null, models: [{ id: 'a/b', label: expect.any(String) }] }])
    expect(modelGroups([], '')).toEqual([])
  })

  it('searches the name, the wire id and the provider, in any case', () => {
    const ids = (query: string): string[] =>
      modelGroups(catalogue, 'second-provider/reasoner-2', query).flatMap(group => group.models.map(model => model.id))

    expect(ids('EXPENSIVE')).toEqual(['example-provider/expensive-model', 'second-provider/reasoner-2'])
    expect(ids('second provider')).toEqual(['second-provider/reasoner-2'])
    expect(ids('  ')).toHaveLength(4)
  })

  it('never searches the chat’s own model out of its picker, and counts the others', () => {
    const groups = modelGroups(catalogue, 'example-provider/example-model', 'nothing like this')

    expect(groups.flatMap(group => group.models.map(model => model.id))).toEqual(['example-provider/example-model'])
    expect(otherModelCount(groups, 'example-provider/example-model')).toBe(0)
    expect(otherModelCount(modelGroups(catalogue, 'x'), 'x')).toBe(catalogue.length)
  })

  it('offers a search from eight models', () => {
    expect(MODEL_SEARCH_FROM).toBe(8)
  })
})
