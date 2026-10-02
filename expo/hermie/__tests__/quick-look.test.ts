/**
 * Looking at an attachment, rather than choosing somewhere to send it.
 *
 * A tap on a file chip used to open the share sheet on every Apple target, and a
 * share sheet is a list of DESTINATIONS — reading the PDF somebody attached
 * meant picking an app to read it in first. `QLPreviewController` is the verb a
 * reader means, and it is iOS API, so the phones and the iPad get it too; the
 * Mac is only what made the old behaviour obvious.
 *
 * The native half — presenting the controller over whatever is on screen — is
 * not reachable from here and is reasoned in `HermieQuickLook.swift`. It takes
 * `file://` and nothing else now; the fetch that used to live in it is on this
 * side, where the credentials are. What IS worth holding still is everything
 * around it, because all of it is either a decision or a refusal:
 *
 *  - **the order.** Quick Look first, the share sheet only when it could not
 *    show the file. A change that flipped those would still "open the file" on
 *    every platform and would be invisible in every screenshot.
 *  - **every refusal is a `false`, never a throw.** Android, the browser, a
 *    type with no previewer, an older binary with no `previewFile` at all: the
 *    caller's fallback has to be one branch, not a message it has to read.
 *  - **an attachment with no URI opens nothing.** The gateway stores an upload
 *    on its own disk and serves nothing back, so most chips in a transcript are
 *    a name and a path on another machine. An empty share sheet would be worse
 *    than doing nothing.
 *  - **a remote one is fetched with this gateway's headers, or not at all.**
 *    The share sheet is not a fallback for a download that could not be made:
 *    handing the system the URL this could not authenticate to would only move
 *    the 401 somewhere with nowhere to report it.
 */
import type { GatewayHttp } from '@hermie/gateway-client'

import { openInQuickLook } from '../src/platform/quick-look'
import { openAttachmentFile } from '../src/features/chats/open-attachment'
import { previewFileName } from '../src/platform/attachment-cache'

const mockPreviewFile = jest.fn<Promise<boolean>, [string, string | undefined]>()
const mockSupportsQuickLook = jest.fn<boolean, []>()
const mockShareFile = jest.fn<Promise<boolean>, [string, string | undefined]>()
const mockCache = jest.fn<Promise<string | null>, [string, string, Record<string, string>]>()

/**
 * Read through getters, not captured.
 *
 * The seam asks the registry for the module ONCE, at its own module load, and
 * Babel hoists both that load and this `jest.mock` above the `const`s above — so
 * a factory that captured the spies would hand over `undefined` and every
 * assertion here would pass for the wrong reason.
 */
jest.mock('expo', () => ({
  requireOptionalNativeModule: () => ({
    get previewFile() {
      return mockPreviewFile
    },
    get supportsQuickLook() {
      return mockSupportsQuickLook
    }
  })
}))

jest.mock('../src/platform/share-file', () => ({
  SHARE_FILE_VERB: 'share',
  shareFile: (uri: string, name?: string) => mockShareFile(uri, name)
}))

/*
  The caches directory is a native module; what is under test is WHICH headers
  reach it and what the answer is used for. `previewFileName` is imported from
  the real module above rather than through this mock, because it is pure.
*/
jest.mock('../src/platform/attachment-cache', () => ({
  previewFileName: jest.requireActual('../src/platform/attachment-cache.web').previewFileName,
  cacheRemoteAttachment: (url: string, name: string, headers: Record<string, string>) => mockCache(url, name, headers)
}))

beforeEach(() => {
  mockPreviewFile.mockReset()
  mockPreviewFile.mockResolvedValue(true)
  mockSupportsQuickLook.mockReset()
  mockSupportsQuickLook.mockReturnValue(true)
  mockShareFile.mockReset()
  mockShareFile.mockResolvedValue(true)
  mockCache.mockReset()
  mockCache.mockResolvedValue('file:///caches/attachment-previews/1-1/report.pdf')
})

/** Just enough of the client: the one method this path calls. */
function gatewayHttp(headers: Record<string, string> = { Authorization: 'Bearer token' }): GatewayHttp {
  return { requestHeaders: async () => headers } as unknown as GatewayHttp
}

describe('the Quick Look seam', () => {
  it('hands the native side the URI and the app filename', async () => {
    await expect(openInQuickLook('file:///tmp/report.pdf', 'report.pdf')).resolves.toBe(true)

    expect(mockPreviewFile).toHaveBeenCalledWith('file:///tmp/report.pdf', 'report.pdf')
  })

  it('answers false for a file the previewer would not show', async () => {
    mockPreviewFile.mockResolvedValue(false)

    await expect(openInQuickLook('file:///tmp/thing.xyz', 'thing.xyz')).resolves.toBe(false)
  })

  it('answers false rather than rejecting when the native call fails', async () => {
    mockPreviewFile.mockRejectedValue(new Error('no window'))

    await expect(openInQuickLook('file:///tmp/report.pdf', 'report.pdf')).resolves.toBe(false)
  })

  it('does not call the native side for an empty URI', async () => {
    await expect(openInQuickLook('', 'report.pdf')).resolves.toBe(false)

    expect(mockPreviewFile).not.toHaveBeenCalled()
  })
})

describe('opening an attachment', () => {
  it('previews it, and does not open the share sheet as well', async () => {
    await expect(openAttachmentFile({ name: 'report.pdf', uri: 'file:///tmp/report.pdf' })).resolves.toBe('quick-look')

    expect(mockPreviewFile).toHaveBeenCalledTimes(1)
    expect(mockShareFile).not.toHaveBeenCalled()
  })

  it('falls back to the share sheet when the previewer cannot show it', async () => {
    mockPreviewFile.mockResolvedValue(false)

    await expect(openAttachmentFile({ name: 'thing.xyz', uri: 'file:///tmp/thing.xyz' })).resolves.toBe('shared')

    expect(mockShareFile).toHaveBeenCalledWith('file:///tmp/thing.xyz', 'thing.xyz')
  })

  it('tries the previewer FIRST, which is the whole ordering', async () => {
    const order: string[] = []

    mockPreviewFile.mockImplementation(async () => {
      order.push('quick-look')

      return false
    })
    mockShareFile.mockImplementation(async () => {
      order.push('share')

      return true
    })

    await openAttachmentFile({ name: 'thing.xyz', uri: 'file:///tmp/thing.xyz' })

    expect(order).toEqual(['quick-look', 'share'])
  })

  it('does nothing at all for a reference this device has no bytes for', async () => {
    await expect(openAttachmentFile({ name: 'quarterly-figures.xlsx' })).resolves.toBe('nothing')

    expect(mockPreviewFile).not.toHaveBeenCalled()
    expect(mockShareFile).not.toHaveBeenCalled()
  })
})

/**
 * A remote attachment: fetched here, with this connection's credentials.
 *
 * The Swift used to do this with a bare `URLSession.shared.data(from:)`, which
 * carried no bearer and no operator front-door header \u2014 so on a gated gateway
 * it was not a file that failed to preview, it was a request that could never
 * have succeeded. The fetch is on this side now because this is where
 * `GatewayHttp` is, and `HermieQuickLook.swift` takes `file://` only.
 */
describe('an attachment the gateway serves', () => {
  const REMOTE = 'https://gateway.example.com/api/attachments/7'
  const CACHED = 'file:///caches/attachment-previews/1-1/report.pdf'

  it('is fetched with the headers the rest of this connection uses', async () => {
    await expect(openAttachmentFile({ name: 'report.pdf', uri: REMOTE }, { http: gatewayHttp() })).resolves.toBe(
      'quick-look'
    )

    expect(mockCache).toHaveBeenCalledWith(REMOTE, 'report.pdf', { Authorization: 'Bearer token' })
  })

  /** Including whatever the operator put in front of the gateway. */
  it('carries the front-door headers too, because requestHeaders is where both are', async () => {
    const headers = { 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 'secret', Authorization: 'Bearer token' }

    await openAttachmentFile({ name: 'report.pdf', uri: REMOTE }, { http: gatewayHttp(headers) })

    expect(mockCache).toHaveBeenCalledWith(REMOTE, 'report.pdf', headers)
  })

  it('hands the previewer the local copy, never the URL', async () => {
    await openAttachmentFile({ name: 'report.pdf', uri: REMOTE }, { http: gatewayHttp() })

    expect(mockPreviewFile).toHaveBeenCalledWith(CACHED, 'report.pdf')
  })

  /** And the share sheet gets the local copy as well, for a type with no previewer. */
  it('shares the copy rather than an address the other app would have to authenticate to', async () => {
    mockPreviewFile.mockResolvedValue(false)
    mockCache.mockResolvedValue('file:///caches/attachment-previews/1-1/thing.xyz')

    await expect(openAttachmentFile({ name: 'thing.xyz', uri: REMOTE }, { http: gatewayHttp() })).resolves.toBe(
      'shared'
    )

    expect(mockShareFile).toHaveBeenCalledWith('file:///caches/attachment-previews/1-1/thing.xyz', 'thing.xyz')
  })

  /**
   * With no gateway there is nothing to authenticate with, and the share sheet
   * is not a fallback for that: handing the system the URL this could not fetch
   * moves the 401 somewhere with nowhere to report it.
   */
  it('does nothing when there is no gateway to fetch it with', async () => {
    await expect(openAttachmentFile({ name: 'report.pdf', uri: REMOTE })).resolves.toBe('nothing')

    expect(mockCache).not.toHaveBeenCalled()
    expect(mockPreviewFile).not.toHaveBeenCalled()
    expect(mockShareFile).not.toHaveBeenCalled()
  })

  it('does nothing when the download refused', async () => {
    mockCache.mockResolvedValue(null)

    await expect(openAttachmentFile({ name: 'report.pdf', uri: REMOTE }, { http: gatewayHttp() })).resolves.toBe(
      'nothing'
    )

    expect(mockShareFile).not.toHaveBeenCalled()
  })

  /** `requestHeaders` reaches the credential provider, which can fail. */
  it('does nothing when the credentials could not be resolved', async () => {
    const http = {
      requestHeaders: async () => {
        throw new Error('no credential')
      }
    } as unknown as GatewayHttp

    await expect(openAttachmentFile({ name: 'report.pdf', uri: REMOTE }, { http })).resolves.toBe('nothing')
  })

  it('leaves a local attachment alone, with no fetch and no gateway needed', async () => {
    await expect(openAttachmentFile({ name: 'report.pdf', uri: 'file:///tmp/report.pdf' })).resolves.toBe('quick-look')

    expect(mockCache).not.toHaveBeenCalled()
  })
})

/**
 * The cached copy's filename, which decides which previewer Quick Look picks.
 *
 * A gateway route ends in `/attachments/7`, so a copy named after the URL
 * previews as nothing at all. It is named after what the transcript knows \u2014
 * and that is somebody else's string, so it is flattened to a leaf first.
 */
describe('the name a cached copy is written under', () => {
  it('keeps the extension, because that is what picks the previewer', () => {
    expect(previewFileName('quarterly-figures.xlsx')).toBe('quarterly-figures.xlsx')
  })
})

describe('the browser half of the seam', () => {
  it('never previews, so the caller downloads instead', async () => {
    // Required rather than imported so the native mock above cannot answer for it.
    const web = jest.requireActual('../src/platform/quick-look.web') as {
      CAN_QUICK_LOOK: boolean
      openInQuickLook: (uri: string, name?: string) => Promise<boolean>
    }

    expect(web.CAN_QUICK_LOOK).toBe(false)
    await expect(web.openInQuickLook('blob:https://hermie.dev/abc', 'report.pdf')).resolves.toBe(false)
  })
})
