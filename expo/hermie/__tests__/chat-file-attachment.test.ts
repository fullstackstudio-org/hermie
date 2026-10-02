/**
 * The controller's half of sending a file.
 *
 * Two things it owns and the pure helpers cannot: WHERE the upload goes, which
 * depends on this session's working directory, and what the submitted prompt
 * ends up saying. The second is the one that breaks quietly — an upload that
 * works and a prompt that does not name the path produces a bot that never
 * mentions the file and a user who thinks the app ate it.
 *
 * The image path is asserted here too, unchanged, because a union type over
 * attachments is exactly the change that silently routes an image down the wrong
 * road.
 */
import type { GatewayHttp } from '@hermie/gateway-client'
import type { UserItem } from '@hermie/transcript'

import { BotsController } from '../src/features/bots/bots-controller'
import { ChatController } from '../src/features/chats/chat-controller'
import { MemoryChatCache } from '../src/platform/chat-cache'
import { botFromProfileRow, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { FakeChatGateway } from './support/fake-chat-gateway'

const RESEARCHER = botFromProfileRow({
  name: 'researcher',
  path: '/root/.hermes/profiles/researcher',
  display_name: 'Researcher',
  canonical_session: {
    id: 'stored-researcher',
    resolved_id: 'tip-researcher',
    title: 'Bot Chat',
    last_active: 1_700_000_100,
    message_count: 0
  }
})

const FILE = { name: 'report.csv', size: 2048, mimeType: 'text/csv', uri: 'file:///tmp/report.csv' }

let fetchCalls: { url: string; init: RequestInit }[] = []
let fetchAnswer: { status: number; body: unknown }
let originalFetch: typeof fetch

const http = {
  baseUrl: 'https://gateway.example.com',
  requestHeaders: async () => ({ authorization: 'Bearer t0k' })
} as unknown as GatewayHttp

const started: ChatController[] = []

/** The controller, with a session whose `info.cwd` the gateway reported. */
function setup(options: { cwd?: string | null } = {}) {
  const gateway = new FakeChatGateway()
  const cache = new MemoryChatCache()
  const botsController = new BotsController({ gateway, store: useBotsStore, cache })
  const controller = new ChatController({
    gateway,
    chats: useChatsStore,
    bots: useBotsStore,
    botsController,
    http,
    cache
  })

  gateway
    .reply('session.resume', {
      session_id: 'runtime-1',
      stored_session_id: 'tip-researcher',
      message_count: 0,
      messages: [],
      info: {
        desktop_contract: 7,
        // The session's working directory. This is what makes an upload path
        // legal on both sides at once.
        ...(options.cwd === null ? {} : { cwd: options.cwd ?? '/work/project' })
      },
      open_requests: []
    })
    .reply('session.history', { count: 0, messages: [] })
    .reply('session.events.since', {
      events: [],
      latest_seq: 1,
      truncated: false,
      count: 0,
      epoch: 'e1',
      open_requests: []
    })
    .reply('profiles.list', { profiles: [] })
    .reply('image.attach_bytes', { ok: true })
    .reply('prompt.submit', { status: 'streaming' })

  useBotsStore.getState().setBots([RESEARCHER])
  gateway.restMessages = null
  started.push(controller)

  return { gateway, controller }
}

beforeEach(() => {
  useChatsStore.getState().reset()
  useBotsStore.getState().reset()
  fetchCalls = []
  fetchAnswer = { status: 200, body: { ok: true, path: '/work/project/uploads/hermie/2026-09-19/tok-report.csv' } }
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init })

    return {
      ok: fetchAnswer.status >= 200 && fetchAnswer.status < 300,
      status: fetchAnswer.status,
      json: async () => fetchAnswer.body
    } as unknown as Response
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch

  for (const controller of started.splice(0)) {
    controller.stop()
  }
})

it("uploads into the session's own working directory", async () => {
  const { controller } = setup()
  await controller.openChat(RESEARCHER)

  const result = await controller.uploadFile('researcher', FILE)

  expect(fetchCalls).toHaveLength(1)

  const sent = (fetchCalls[0]!.init.body as FormData).get('path')

  expect(String(sent)).toMatch(/^\/work\/project\/uploads\/hermie\/\d{4}-\d{2}-\d{2}\/[a-z0-9]{8}-report\.csv$/)
  expect(result.path).toBe('/work/project/uploads/hermie/2026-09-19/tok-report.csv')
})

it('refuses the upload when the session never reported a working directory', async () => {
  const { controller } = setup({ cwd: null })
  await controller.openChat(RESEARCHER)

  await expect(controller.uploadFile('researcher', FILE)).rejects.toMatchObject({
    name: 'FileUploadError',
    reason: 'no-workspace'
  })
  expect(fetchCalls).toHaveLength(0)
})

it('submits the prompt with the reference appended, and paints what the row will say', async () => {
  const { gateway, controller } = setup()
  await controller.openChat(RESEARCHER)

  const uploaded = await controller.uploadFile('researcher', FILE)

  await controller.send('researcher', 'Summarise this', [{ kind: 'file', filename: 'report.csv', path: uploaded.path }])

  const submitted = gateway.calls.filter(call => call.method === 'prompt.submit')

  expect(submitted).toHaveLength(1)
  expect(submitted[0]!.params).toMatchObject({
    session_id: 'runtime-1',
    profile: 'researcher',
    text: `Summarise this\n\n@file:${uploaded.path}`
  })

  // The painted bubble has to match the row's PROJECTION, not the submit. The
  // gateway stores the body verbatim and `stripUserText` lifts the directive out
  // of the text into `attachments` on the way back, so a bubble painted with the
  // directive still in its text pairs with nothing and shows up twice.
  const items = Object.values(useChatsStore.getState().chats.researcher?.items ?? {})
  const user = items.filter(entry => entry.kind === 'user')

  expect(user).toHaveLength(1)
  // `attachments` holds the DIRECTIVE, which is what the row holds too. The chip
  // shows `report.csv` because `attachmentName` reads the name off it at render
  // time — storing the friendly name here instead left the two sides of one send
  // with nothing in common when the prompt had no words to pair on.
  expect(user[0]).toMatchObject({ text: 'Summarise this', attachments: [`@file:${uploaded.path}`] })
})

it('paints one bubble for a file sent with no text, and still one after the sweep', async () => {
  const { gateway, controller } = setup()
  await controller.openChat(RESEARCHER)

  const uploaded = await controller.uploadFile('researcher', FILE)

  // The reported send: an attachment and nothing typed.
  await controller.send('researcher', '', [{ kind: 'file', filename: 'report.csv', path: uploaded.path }])

  const reference = `@file:${uploaded.path}`

  expect(gateway.lastCall('prompt.submit')).toMatchObject({ text: reference })
  expect(userBubbles()).toHaveLength(1)

  // The row the gateway wrote for it, folded in the way a `sessions.changed`
  // sweep does. Nothing links it to the bubble above but what the two carry.
  gateway.restMessages = [{ role: 'user', row_id: 11, text: reference, timestamp: 1_700_000_200 }]
  await controller.reconcileTailFor('researcher')

  expect(userBubbles()).toHaveLength(1)
  expect(userBubbles()[0]).toMatchObject({ rowId: 11, text: '', attachments: [reference] })
})

/** The human's own bubbles in the researcher's chat. */
function userBubbles() {
  const chat = useChatsStore.getState().chats.researcher

  return (chat?.order ?? []).map(id => chat?.items[id]).filter((item): item is UserItem => item?.kind === 'user')
}

it('sends nothing at all when the upload failed', async () => {
  const { gateway, controller } = setup()
  await controller.openChat(RESEARCHER)

  fetchAnswer = { status: 403, body: { detail: 'Path outside managed files root' } }

  await expect(controller.uploadFile('researcher', FILE)).rejects.toMatchObject({ reason: 'refused' })

  // A typed failure and no turn: the reference would have named a path the
  // gateway does not have, and the bot would have reported a missing file
  // instead of the upload being reported as refused.
  expect(gateway.calls.filter(call => call.method === 'prompt.submit')).toHaveLength(0)
})

it('leaves the image path exactly as it was', async () => {
  const { gateway, controller } = setup()
  await controller.openChat(RESEARCHER)

  await controller.send('researcher', 'Look at this', [{ filename: 'shot.jpg', base64: 'AAAA' }])

  expect(gateway.calls.filter(call => call.method === 'image.attach_bytes')).toMatchObject([
    { params: { session_id: 'runtime-1', profile: 'researcher', content_base64: 'AAAA', filename: 'shot.jpg' } }
  ])
  // No reference text: an image is attached, not referenced.
  expect(gateway.calls.find(call => call.method === 'prompt.submit')?.params).toMatchObject({ text: 'Look at this' })
})

it('attaches the images and references the files in one turn', async () => {
  const { gateway, controller } = setup()
  await controller.openChat(RESEARCHER)

  await controller.send('researcher', 'Both', [
    { filename: 'shot.jpg', base64: 'AAAA' },
    { kind: 'file', filename: 'report.csv', path: '/work/project/uploads/hermie/d/tok-report.csv' }
  ])

  expect(gateway.calls.filter(call => call.method === 'image.attach_bytes')).toHaveLength(1)
  expect(gateway.calls.find(call => call.method === 'prompt.submit')?.params).toMatchObject({
    text: 'Both\n\n@file:/work/project/uploads/hermie/d/tok-report.csv'
  })
})
