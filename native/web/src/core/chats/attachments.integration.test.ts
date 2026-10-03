// @vitest-environment node
/**
 * The attachment tray against the fake gateway's upload route
 * (`POST /api/files/upload-stream`, the shape `packages/fake-gateway`'s
 * `file-upload.test.ts` pins down), through the real `uploadFile` and the
 * runtime's own `fetch` and `FormData`.
 *
 * What it proves: a staged file lands under the session's working directory
 * with every byte and becomes a chip whose input names that path; the gateway's
 * own refusal reaches the chip in its words; a cancelled upload leaves nothing
 * staged and nothing stored; and Retry sends the same file again.
 */
import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import type { GatewayHttp } from '@hermie/gateway-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AttachmentTray } from './attachments'
import { uploadFile } from './file-upload'

const CWD = '/root/projects/researcher'

const gateways: FakeGateway[] = []

afterEach(async () => {
  while (gateways.length) {
    await gateways.pop()?.close()
  }
})

async function setup(options: { cwd?: string; uploadDelayMs?: number } = {}) {
  const gateway = await startFakeGateway({
    port: 0,
    ...(options.uploadDelayMs ? { uploadDelayMs: options.uploadDelayMs } : {})
  })

  gateways.push(gateway)

  const http = { baseUrl: gateway.url, requestHeaders: async () => ({}) } as unknown as GatewayHttp
  const cwd = options.cwd ?? CWD
  const tray = new AttachmentTray({
    upload: (file, { signal }) => uploadFile({ http, file, cwd, signal }),
    readBase64: async file => Buffer.from(await file.arrayBuffer()).toString('base64')
  })

  return { gateway, tray }
}

const waitFor = <T>(check: () => T): Promise<T> => vi.waitFor(check, { timeout: 5_000, interval: 10 })

describe('the tray on the fake gateway', () => {
  it('uploads a staged file into the session’s workspace and stages the path the gateway answered', async () => {
    const { gateway, tray } = await setup()
    const text = 'name,score\nada,10\n'

    tray.add([new File([text], 'scores 2026.csv', { type: 'text/csv' })])

    await waitFor(() => expect(tray.getSnapshot()[0]?.status).toBe('ready'))

    const [stored] = [...gateway.state.uploadedFiles.values()]

    expect(stored?.path).toMatch(
      /^\/root\/projects\/researcher\/uploads\/hermie\/\d{4}-\d{2}-\d{2}\/[a-z0-9]{8}-scores-2026\.csv$/u
    )
    expect(stored?.bytes).toBe(new TextEncoder().encode(text).length)
    expect(tray.take()?.inputs).toEqual([{ kind: 'file', filename: 'scores 2026.csv', path: stored?.path }])
  })

  it('shows the gateway’s own reason on the chip it refused', async () => {
    // A relative working directory: the managed-files route with no locked root refuses it outright.
    const { gateway, tray } = await setup({ cwd: 'projects/researcher' })

    tray.add([new File(['hello'], 'notes.txt', { type: 'text/plain' })])

    await waitFor(() => expect(tray.getSnapshot()[0]?.status).toBe('failed'))

    expect(tray.getSnapshot()[0]?.problem).toEqual({ reason: 'refused', detail: 'Path must be absolute' })
    expect(gateway.state.uploadedFiles.size).toBe(0)
    expect(tray.blocked).toBe(true)
  })

  it('takes a cancelled upload away, and the gateway keeps nothing of it', async () => {
    const { gateway, tray } = await setup({ uploadDelayMs: 400 })

    tray.add([new File(['a'.repeat(4096)], 'big.log', { type: 'text/plain' })])
    await new Promise(resolve => setTimeout(resolve, 100))
    tray.remove(tray.getSnapshot()[0]!.id)

    expect(tray.getSnapshot()).toEqual([])

    await new Promise(resolve => setTimeout(resolve, 500))

    expect(gateway.state.uploadedFiles.size).toBe(0)
    expect(tray.getSnapshot()).toEqual([])
  })

  it('sends the same file again on retry, to a fresh path', async () => {
    const { gateway, tray } = await setup()
    let refuse = true
    const realFetch = globalThis.fetch

    // The first attempt dies on the way; the second goes through.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (refuse) {
        refuse = false
        throw new TypeError('network connection was lost')
      }

      return realFetch(input, init)
    })

    tray.add([new File(['retry me'], 'again.txt', { type: 'text/plain' })])
    await waitFor(() => expect(tray.getSnapshot()[0]?.status).toBe('failed'))
    expect(tray.getSnapshot()[0]?.problem).toMatchObject({ reason: 'failed' })

    tray.retry(tray.getSnapshot()[0]!.id)
    await waitFor(() => expect(tray.getSnapshot()[0]?.status).toBe('ready'))

    expect([...gateway.state.uploadedFiles.values()].map(entry => entry.bytes)).toEqual([8])
    vi.restoreAllMocks()
  })
})
