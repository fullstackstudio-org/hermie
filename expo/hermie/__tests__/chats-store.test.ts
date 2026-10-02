import { useChatsStore } from '../src/store/chats'

const IDS = { storedSessionId: 'stored-1', resolvedSessionId: 'stored-1' }

beforeEach(() => {
  useChatsStore.getState().reset()
})

describe('the chat store', () => {
  it('creates a chat once and keeps its identity', () => {
    const store = useChatsStore.getState()

    store.ensure('researcher', IDS)
    store.setDraft('researcher', 'hello')
    store.ensure('researcher', IDS)

    const chat = useChatsStore.getState().chats.researcher

    expect(chat?.storedSessionId).toBe('stored-1')
    expect(chat?.draft).toBe('hello')
  })

  it('updates the resolved id when a compression lineage moved on', () => {
    useChatsStore.getState().ensure('researcher', IDS)
    useChatsStore.getState().ensure('researcher', { storedSessionId: 'stored-1', resolvedSessionId: 'tip-9' })

    expect(useChatsStore.getState().chats.researcher?.resolvedSessionId).toBe('tip-9')
  })

  it('routes an event to the bot that owns its runtime session', () => {
    const store = useChatsStore.getState()

    store.ensure('researcher', IDS)
    store.ensure('writer', { storedSessionId: 'stored-2', resolvedSessionId: 'stored-2' })
    store.bindRuntime('researcher', 'runtime-a')
    store.bindRuntime('writer', 'runtime-b')

    expect(useChatsStore.getState().botForRuntime('runtime-b')).toBe('writer')
    expect(useChatsStore.getState().botForRuntime('runtime-zzz')).toBeUndefined()
  })

  it('drops the previous runtime id when the gateway rebuilds a session', () => {
    const store = useChatsStore.getState()

    store.ensure('researcher', IDS)
    store.bindRuntime('researcher', 'runtime-old')
    store.bindRuntime('researcher', 'runtime-new')

    const state = useChatsStore.getState()

    expect(state.runtimeToBot).toEqual({ 'runtime-new': 'researcher' })
    expect(state.chats.researcher?.runtimeSessionId).toBe('runtime-new')
  })

  it('keeps the transcript when a session is reclaimed and only forgets the runtime id', () => {
    const store = useChatsStore.getState()

    store.ensure('researcher', IDS)
    store.bindRuntime('researcher', 'runtime-a')
    store.beginTurn('researcher', 'hello')
    store.dropRuntime('researcher')

    const state = useChatsStore.getState()

    expect(state.runtimeToBot).toEqual({})
    expect(state.chats.researcher?.runtimeSessionId).toBeUndefined()
    expect(state.chats.researcher?.order).toHaveLength(1)
  })

  it('paints an optimistic turn and settles it against the submit status', () => {
    const store = useChatsStore.getState()

    store.ensure('researcher', IDS)
    store.beginTurn('researcher', 'summarise the notes')

    const painted = useChatsStore.getState().chats.researcher
    const firstId = painted?.order[0] ?? ''

    expect(painted?.items[firstId]).toMatchObject({ kind: 'user', pending: true, origin: 'optimistic' })
    expect(painted?.turn).toMatchObject({ active: true, local: true })

    useChatsStore.getState().settleTurn('researcher', { status: 'streaming' })

    expect(useChatsStore.getState().chats.researcher?.items[firstId]).toMatchObject({ pending: false })
  })

  it('reduces streamed events into one assistant bubble', () => {
    const store = useChatsStore.getState()

    store.ensure('researcher', IDS)
    store.beginTurn('researcher', 'hello')
    store.dispatchEvent('researcher', { type: 'message.start', seq: 1, payload: {} })
    store.dispatchEvent('researcher', { type: 'message.delta', seq: 2, payload: { text: 'Hi ' } })
    store.dispatchEvent('researcher', { type: 'message.delta', seq: 3, payload: { text: 'there.' } })
    store.dispatchEvent('researcher', { type: 'message.complete', seq: 4, payload: { text: 'Hi there.' } })

    const chat = useChatsStore.getState().chats.researcher!
    const assistants = chat.order.map(id => chat.items[id]).filter(item => item?.kind === 'assistant')

    expect(assistants).toHaveLength(1)
    expect(assistants[0]).toMatchObject({ text: 'Hi there.', streaming: false })
    expect(chat.turn.active).toBe(false)
  })

  it('ignores a replayed event at or below the watermark', () => {
    const store = useChatsStore.getState()

    store.ensure('researcher', IDS)
    store.dispatchEvent('researcher', { type: 'message.delta', seq: 5, payload: { text: 'once' } })
    store.dispatchEvent('researcher', { type: 'message.delta', seq: 5, payload: { text: 'twice' } })

    const chat = useChatsStore.getState().chats.researcher!
    const assistant = chat.order.map(id => chat.items[id]).find(item => item?.kind === 'assistant')

    expect(assistant).toMatchObject({ text: 'once' })
  })

  it('records an approval request and the answer given to it', () => {
    const store = useChatsStore.getState()

    store.ensure('researcher', IDS)
    store.dispatchServerRequest('researcher', {
      id: 'srq-1',
      method: 'approval',
      params: { request_id: 'appr-1', command: 'rm -rf build', choices: ['once', 'deny'] }
    })

    const opened = useChatsStore.getState().chats.researcher!
    const itemId = opened.byRequestId['srq-1'] ?? ''

    expect(opened.items[itemId]).toMatchObject({ kind: 'approval', approvalId: 'appr-1', state: 'open' })

    useChatsStore.getState().answer('researcher', 'srq-1', 'once')

    expect(useChatsStore.getState().chats.researcher?.items[itemId]).toMatchObject({
      state: 'answered',
      answer: 'once'
    })
  })

  it('reports the live chats a sessions.changed sweep has to visit', () => {
    const store = useChatsStore.getState()

    store.ensure('researcher', IDS)
    store.ensure('writer', { storedSessionId: 'stored-2', resolvedSessionId: 'stored-2' })
    store.markLive('researcher')

    expect(Object.keys(useChatsStore.getState().live)).toEqual(['researcher'])
  })

  it('is a no-op on a bot that has no chat rather than a crash', () => {
    expect(() => useChatsStore.getState().dispatchEvent('nobody', { type: 'message.start' })).not.toThrow()
    expect(useChatsStore.getState().chats.nobody).toBeUndefined()
  })
})
