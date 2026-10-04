/**
 * The composer's microphone through the whole composer, against a browser that has a recogniser and one that does
 * not: the button is drawn only where there is something behind it, what is heard goes into the field, a send ends
 * the session, and what went wrong is one line under the field. A fake `SpeechRecognition` on the window.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { voiceSettingsStore } from '../../state/voice-settings'
import { chatWith } from '../../test-support/chat-fixtures'
import { resetShellStores } from '../../test-support/shell-stores'
import { voiceActivityStore } from '../voice/activity'
import { type ChatScreenController, ChatRuntimeContext } from './chat-runtime'
import { Composer } from './Composer'

interface FakeSession {
  lang: string
  started: boolean
  aborted: boolean
  hear: (transcript: string, final?: boolean) => void
  fail: (error: string) => void
  end: () => void
}

/** Install a recogniser on the window; the sessions it makes are kept for the test to speak into. */
function installRecognition(): FakeSession[] {
  const sessions: FakeSession[] = []

  class FakeRecognition {
    lang = ''
    continuous = false
    interimResults = false
    onresult: ((event: { resultIndex: number; results: unknown[] }) => void) | null = null
    onerror: ((event: { error: string }) => void) | null = null
    onend: (() => void) | null = null
    started = false
    aborted = false

    constructor() {
      sessions.push(this as unknown as FakeSession)
    }

    start(): void {
      this.started = true
    }

    stop(): void {
      return undefined
    }

    abort(): void {
      this.aborted = true
    }

    hear(transcript: string, final = false): void {
      this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal: final })] })
    }

    fail(error: string): void {
      this.onerror?.({ error })
    }

    end(): void {
      this.onend?.()
    }
  }

  Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: FakeRecognition })

  return sessions
}

const removeRecognition = (): void => {
  Reflect.deleteProperty(window, 'webkitSpeechRecognition')
  Reflect.deleteProperty(window, 'SpeechRecognition')
}

function fakeController() {
  const controller = {
    send: vi.fn(async () => undefined),
    stopTurn: vi.fn(async () => undefined),
    editQueued: vi.fn((): string | undefined => undefined),
    deleteQueued: vi.fn(),
    steerQueued: vi.fn(async () => 'queued'),
    querySlash: vi.fn(async () => ({ items: [] })),
    runSlash: vi.fn(async () => ({})),
    slashRouteFor: vi.fn((): string | null => null),
    startNewConversation: vi.fn(async () => undefined)
  }

  return controller as unknown as typeof controller & ChatScreenController
}

function mount(controller = fakeController()) {
  render(
    <ChatRuntimeContext.Provider value={{ controller, gatewayBaseUrl: 'http://gateway.test' }}>
      <Composer chatKey="researcher" botName="Dr. Researcher" />
    </ChatRuntimeContext.Provider>
  )

  return { controller, field: screen.getByRole('textbox') as HTMLTextAreaElement }
}

const settle = (): Promise<void> => act(async () => undefined)

beforeEach(() => {
  resetShellStores()
  resetActiveLocale()
  connectionStore.getState().setStatus('ready', null)
  chatsStore.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1' }))
  removeRecognition()
})

afterEach(() => {
  removeRecognition()
  voiceActivityStore.getState().setDictating(false)
  voiceSettingsStore.getState().reset()
})

describe('where the browser has no recogniser', () => {
  it('draws no microphone at all, not one that explains itself', async () => {
    mount()
    await settle()

    expect(screen.queryByRole('button', { name: 'Dictate' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  })
})

describe('where the browser has one', () => {
  it('draws the microphone beside the field, and puts what is heard into it', async () => {
    const sessions = installRecognition()
    const { field } = mount()

    fireEvent.change(field, { target: { value: 'Remind me to' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Dictate' }))

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ started: true })
    expect(screen.getByRole('status').textContent).toBe('Listening…')

    act(() => sessions[0]?.hear('call'))
    act(() => sessions[0]?.hear('call the plumber'))

    expect(field.value).toBe('Remind me to call the plumber')
  })

  it('is a draft like any other: nothing is sent until the reader sends it', async () => {
    const sessions = installRecognition()
    const { controller, field } = mount()

    fireEvent.click(await screen.findByRole('button', { name: 'Dictate' }))
    act(() => sessions[0]?.hear('ship it', true))
    act(() => sessions[0]?.end())
    await settle()

    expect(field.value).toBe('ship it')
    expect(controller.send).not.toHaveBeenCalled()
  })

  it('ends the session when the message is sent, so a late result cannot put the sentence back', async () => {
    const sessions = installRecognition()
    const { controller, field } = mount()

    fireEvent.click(await screen.findByRole('button', { name: 'Dictate' }))
    act(() => sessions[0]?.hear('ship it'))
    expect(field.value).toBe('ship it')

    fireEvent.keyDown(field, { key: 'Enter' })
    await settle()

    expect(controller.send).toHaveBeenCalledExactlyOnceWith('researcher', 'ship it')
    expect(field.value).toBe('')
    expect(sessions[0]?.aborted).toBe(true)

    act(() => sessions[0]?.hear('ship it now', true))
    expect(field.value).toBe('')
  })

  it('says why it did not work in one line, and puts the line away on the next try', async () => {
    const sessions = installRecognition()

    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Dictate' }))
    act(() => sessions[0]?.fail('not-allowed'))
    act(() => sessions[0]?.end())

    expect(screen.getByRole('alert').textContent).toBe('Hermie needs the microphone to take dictation.')

    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says nothing was heard, calmly, and leaves the draft alone', async () => {
    const sessions = installRecognition()
    const { field } = mount()

    fireEvent.change(field, { target: { value: 'typed before' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Dictate' }))
    act(() => sessions[0]?.end())

    expect(screen.getByRole('status').textContent).toBe('Nothing was heard.')
    expect(field.value).toBe('typed before')
  })

  it('listens in the language the reader chose', async () => {
    const sessions = installRecognition()

    voiceSettingsStore.getState().setDictationLanguage('de')
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Dictate' }))

    expect(sessions[0]?.lang).toBe('de')
  })
})
