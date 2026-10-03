import { describe, expect, it } from 'vitest'

import { createMcpStore, mcpStore } from './mcp'

describe('the MCP store', () => {
  it('starts with nothing read and nothing wrong', () => {
    expect(createMcpStore().getState()).toMatchObject({
      status: null,
      problem: null,
      loading: false,
      loaded: false,
      change: null
    })
  })

  it('is forgotten by reset, and every store is its own', () => {
    const store = createMcpStore()

    store.setState({
      loaded: true,
      problem: { kind: 'not_offered' },
      change: { id: 1, change: 'granted', clientName: 'x' }
    })
    store.getState().reset()

    expect(store.getState()).toMatchObject({ loaded: false, problem: null, change: null })
    expect(mcpStore).not.toBe(store)
  })
})
