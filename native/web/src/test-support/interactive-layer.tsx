/**
 * The request layer over the real interactive model and a hand-driven connection, for the tests of the three
 * interactive sheets (`FormSheet`, `FileSheet`, `DraftSheet`): `setup()` before each test, `teardown()` after, then
 * `mount()` and `raise()` a request the way the gateway delivers it.
 */
import { act, render, screen, within } from '@testing-library/react'

import { InteractiveModel } from '../core/requests/interactive'
import { resetActiveLocale } from '../i18n/active-locale'
import { ChatRuntimeContext, type ChatSessionRuntime } from '../features/chat/chat-runtime'
import { InteractiveRuntimeContext } from '../features/requests/interactive-runtime'
import { RequestLayer } from '../features/requests/RequestLayer'
import { chatsStore } from '../state/chats'
import { connectionStore } from '../state/connection'
import { interactiveStore } from '../state/interactive'
import { requestLaterStore } from '../state/request-later'
import { bindRequests, requestsStore } from '../state/requests'
import { chatWith } from './chat-fixtures'
import { type FakeInteractiveGateway, fakeInteractiveGateway } from './interactive-gateway'
import { manualTimers, type ManualTimers } from './secure-input-gateway'
import { aBot, resetShellStores, seedRoster } from './shell-stores'

export const NOW_SECONDS = 1_000

export interface Harness {
  gw: FakeInteractiveGateway
  timers: ManualTimers
  model: InteractiveModel
  stopBinding: () => void
}

/** What `uploadFileTo` is given when a test hands the layer a controller. */
export type UploadCall = { path: string; file: { name: string; size: number; mimeType: string; body?: unknown } }

export function setup(): Harness {
  resetShellStores()
  requestsStore.getState().reset()
  interactiveStore.getState().reset()
  requestLaterStore.getState().reset()
  resetActiveLocale()
  document.documentElement.lang = 'en'
  document.title = 'Hermie'
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' }), aBot('writer')])
  chatsStore.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1' }))
  chatsStore.getState().bindRuntime('researcher', 'rt-1')

  const timers = manualTimers(NOW_SECONDS * 1000)
  const gw = fakeInteractiveGateway()
  const model = new InteractiveModel({
    gateway: gw.gateway,
    chatFor: id => chatsStore.getState().runtimeToBot[id],
    watchChats: listener => chatsStore.subscribe(() => listener()),
    failWithData: gw.failWithData,
    gatewayName: 'gw.example.test',
    now: () => timers.now(),
    timers
  })

  model.start()

  return {
    gw,
    timers,
    model,
    stopBinding: bindRequests(chatsStore, requestsStore, undefined, undefined, undefined, interactiveStore)
  }
}

export function teardown(harness: Harness): void {
  harness.stopBinding()
  harness.model.stop()
  resetActiveLocale()
}

/** The layer over a page with a field behind it; `uploadFileTo` is the controller's upload, when a test has one. */
export function mount(
  harness: Harness,
  options: {
    tapGuardMs?: number
    uploadFileTo?: (path: string, file: UploadCall['file'], options: { signal?: AbortSignal }) => Promise<unknown>
  } = {}
) {
  const runtime = options.uploadFileTo
    ? ({
        controller: { uploadFileTo: options.uploadFileTo },
        gatewayBaseUrl: 'http://gateway.test'
      } as unknown as ChatSessionRuntime)
    : null

  return render(
    <ChatRuntimeContext.Provider value={runtime}>
      <InteractiveRuntimeContext.Provider value={harness.model}>
        <main>
          <label>
            Draft
            <textarea />
          </label>
        </main>
        <RequestLayer tapGuardMs={options.tapGuardMs ?? 0} />
      </InteractiveRuntimeContext.Provider>
    </ChatRuntimeContext.Provider>
  )
}

/** Deliver a request the way the gateway does: a server request frame on the connection. */
export function raise(
  harness: Harness,
  id: string,
  method: string,
  params: Record<string, unknown>,
  replayed = false
): void {
  void act(() => {
    harness.gw.deliver(id, method, params, replayed)
  })
}

export const dialog = (): HTMLElement => screen.getByRole('dialog')
export const button = (name: string | RegExp): HTMLElement => within(dialog()).getByRole('button', { name })
export const queryButton = (name: string | RegExp): HTMLElement | null =>
  within(dialog()).queryByRole('button', { name })

/** The `result` of the last `request.answer` the model made, or `undefined` when it made none. */
export function lastAnswer(harness: Harness): Record<string, unknown> | undefined {
  const call = harness.gw.calls.filter(entry => entry.method === 'request.answer').at(-1)

  return call?.params.result as Record<string, unknown> | undefined
}

/** A form frame; `fields` and anything else are laid over it. */
export const formFrame = (fields: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: 'rt-1',
  v: 1,
  title: 'Hotel booking',
  summary: 'Fill this in and I will book it.',
  expires_at: NOW_SECONDS + 300,
  optional: true,
  fields,
  ...extra
})

export const fileFrame = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: 'rt-1',
  v: 1,
  title: 'Receipt',
  summary: 'Send me the parking receipt.',
  expires_at: NOW_SECONDS + 300,
  optional: true,
  accept: 'any',
  multiple: false,
  upload: {
    dir: '/home/ada/work/uploads/hermie/2026-10-04',
    max_bytes: 1_000_000,
    max_total_bytes: 2_000_000,
    max_files: 3,
    strip_metadata: false
  },
  ...extra
})

const DEVICE_UPLOAD = {
  dir: '/home/ada/work/uploads/hermie/2026-10-04',
  max_bytes: 1_048_576,
  max_total_bytes: 2_097_152,
  max_files: 2,
  strip_metadata: false
}

const deviceFrame = (extra: Record<string, unknown>): Record<string, unknown> => ({
  session_id: 'rt-1',
  v: 1,
  expires_at: NOW_SECONDS + 300,
  optional: true,
  ...extra
})

/** A signature (the contract's rental agreement); anything else is laid over it. */
export const signatureFrame = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
  deviceFrame({
    title: 'Sign the agreement',
    summary: 'Sign to confirm you accept the rental agreement.',
    statement: 'I have read the rental agreement dated 3 October 2026 and agree to its terms.',
    signer_name: 'Ada Lovelace',
    upload: DEVICE_UPLOAD,
    ...extra
  })

export const locationFrame = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
  deviceFrame({
    title: 'Where are you?',
    summary: 'I need your location to find the nearest branch.',
    precision: 'approximate',
    ...extra
  })

export const contactFrame = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
  deviceFrame({
    title: 'Who should I call?',
    summary: 'Pick the person and I will take their number.',
    fields: ['name', 'phones'],
    ...extra
  })

export const scanFrame = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
  deviceFrame({ title: 'Scan the box', summary: 'Scan the code on the box.', ...extra })

/** A voice note: an `input.file` request for a recording. */
export const voiceFrame = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
  deviceFrame({
    title: 'Tell me about it',
    summary: 'Record a short voice note.',
    accept: 'audio',
    capture: 'audio',
    multiple: false,
    upload: DEVICE_UPLOAD,
    ...extra
  })

/** A diff review: two hunks of `app/settings.py`, neither pinned (the contract's own example); anything else is laid over it. */
export const diffFrame = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: 'rt-1',
  v: 1,
  title: 'Changes to settings.py',
  summary: 'I changed the default currency and the retry limit.',
  expires_at: NOW_SECONDS + 300,
  optional: false,
  kind: 'modify',
  path: 'app/settings.py',
  hunks: [
    {
      id: 'h1',
      header: '@@ -3,4 +3,4 @@ class Settings:',
      lines: [
        '     name = "booking"',
        '-    currency = "USD"',
        '+    currency = "EUR"',
        '     locale = "nl-NL"',
        '     debug = False'
      ]
    },
    {
      id: 'h2',
      header: '@@ -20,3 +20,4 @@ def retry():',
      lines: ['     attempts = 0', '-    limit = 3', '+    limit = 5', '+    backoff = 2', '     return attempts']
    }
  ],
  ...extra
})

export const draftFrame = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: 'rt-1',
  v: 1,
  title: 'Reply to Bram',
  summary: 'Approve or reject it.',
  expires_at: NOW_SECONDS + 300,
  optional: false,
  kind: 'mail',
  text: 'Hi Bram,\n\nThursday works.\n\nAda',
  subject: 'Re: lunch',
  recipients: ['bram@example.test'],
  editable: true,
  ...extra
})
