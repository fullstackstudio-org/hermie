/**
 * Sending a file: the upload, the path it picks, and the prompt that names it.
 *
 * The rules under test are not ours — they are two upstream constraints that
 * only line up in one place, and getting either wrong produces a failure that
 * looks like the other thing. `_resolve_managed_path` refuses a relative path
 * when no managed-files root is locked, and the gateway expands `@file:` with
 * `allowed_root` pinned to the session's cwd. So the upload has to go to an
 * ABSOLUTE path UNDER that cwd, and the prompt has to name the path the gateway
 * resolved rather than the one we asked for.
 *
 * See the 2026-09-19 section of docs/platform-notes.md for the source lines.
 */
import type { GatewayHttp } from '@hermie/gateway-client'

import {
  FileUploadError,
  fileReferenceFor,
  MAX_UPLOAD_BYTES,
  sanitiseUploadName,
  uploadFile,
  uploadPathFor,
  withFileReferences
} from '../src/features/chats/file-upload'

const FILE = { name: 'report.csv', size: 2048, mimeType: 'text/csv', uri: 'file:///tmp/report.csv' }

const http = { baseUrl: 'https://gateway.example.com', requestHeaders: async () => ({ authorization: 'Bearer t0k' }) }

/** A `fetch` that records the one call and answers like the real route. */
function fakeFetch(answer: { status?: number; body?: unknown } = {}) {
  const calls: { url: string; init: RequestInit }[] = []

  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })

    const status = answer.status ?? 200
    const body = answer.body ?? { ok: true, path: '/work/project/uploads/hermie/2026-09-19/aaaabbbb-report.csv' }

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    } as unknown as Response
  }) as unknown as typeof fetch

  return { impl, calls }
}

const run = (overrides: Partial<Parameters<typeof uploadFile>[0]> = {}, fetchImpl = fakeFetch().impl) =>
  uploadFile({
    http: http as unknown as GatewayHttp,
    file: FILE,
    cwd: '/work/project',
    fetchImpl,
    now: new Date('2026-09-19T10:00:00Z'),
    token: 'aaaabbbb',
    ...overrides
  })

describe('where the file goes', () => {
  it('puts it under the session cwd, dated, with a collision-proof prefix', () => {
    expect(uploadPathFor('/work/project', 'report.csv', { now: new Date(2026, 8, 19), token: 'aaaabbbb' })).toBe(
      '/work/project/uploads/hermie/2026-09-19/aaaabbbb-report.csv'
    )
  })

  it('does not double the separator on a cwd that ends in one', () => {
    expect(uploadPathFor('/work/project/', 'a.txt', { now: new Date(2026, 8, 19), token: 'zz' })).toBe(
      '/work/project/uploads/hermie/2026-09-19/zz-a.txt'
    )
  })

  it('strips a name that could climb out of the directory it was given', () => {
    expect(sanitiseUploadName('../../etc/passwd')).toBe('passwd')
    expect(sanitiseUploadName('/absolute/thing.txt')).toBe('thing.txt')
    expect(sanitiseUploadName('..')).toBe('attachment')
    expect(sanitiseUploadName('')).toBe('attachment')
    // Spaces and the rest become hyphens, so the path needs no quoting at all.
    expect(sanitiseUploadName('my notes (final).md')).toBe('my-notes-final-.md')
  })

  it('never lets a sanitised name grow a path separator back', () => {
    for (const name of ['a/b', 'a\\b', '..\\..\\x', 'a\u0000b']) {
      const cleaned = sanitiseUploadName(name)

      expect(cleaned).not.toMatch(/[/\\]/)
      expect(cleaned.split('.').every(part => part !== '.')).toBe(true)
    }
  })
})

describe('the reference the prompt carries', () => {
  it('is a bare @file: token for an ordinary path', () => {
    expect(fileReferenceFor('/work/p/uploads/a.txt')).toBe('@file:/work/p/uploads/a.txt')
  })

  it('wraps a path with a space in backticks, which upstream strips back off', () => {
    // Without them the reference ends at the space and the agent looks for
    // `/work/p/my` — a file not found rather than a file refused.
    expect(fileReferenceFor('/work/p/my file.txt')).toBe('@file:`/work/p/my file.txt`')
  })

  it('appends the references under the message rather than into it', () => {
    expect(withFileReferences('Have a look', ['/a/b.txt'])).toBe('Have a look\n\n@file:/a/b.txt')
    expect(withFileReferences('  ', ['/a/b.txt'])).toBe('@file:/a/b.txt')
    expect(withFileReferences('unchanged', [])).toBe('unchanged')
  })
})

describe('uploading', () => {
  it('posts multipart to the stream route with the auth headers and no content-type', async () => {
    const fetcher = fakeFetch()
    const result = await run({}, fetcher.impl)

    expect(fetcher.calls).toHaveLength(1)
    expect(fetcher.calls[0]!.url).toBe('https://gateway.example.com/api/files/upload-stream')
    expect(fetcher.calls[0]!.init.method).toBe('POST')
    expect(fetcher.calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer t0k' })
    // The runtime sets it, because only it knows the boundary it generated.
    expect(Object.keys(fetcher.calls[0]!.init.headers ?? {}).map(key => key.toLowerCase())).not.toContain(
      'content-type'
    )

    const body = fetcher.calls[0]!.init.body as FormData

    expect(body.get('path')).toBe('/work/project/uploads/hermie/2026-09-19/aaaabbbb-report.csv')
    expect(body.get('overwrite')).toBe('true')
    expect(result.path).toBe('/work/project/uploads/hermie/2026-09-19/aaaabbbb-report.csv')
    expect(result.reference).toBe('@file:/work/project/uploads/hermie/2026-09-19/aaaabbbb-report.csv')
  })

  it("references the gateway's resolved path, not the one we asked for", async () => {
    // A symlinked home is the ordinary case: the gateway resolves it and the
    // reference has to name what IT will resolve, or the containment check runs
    // against a different path than the upload did.
    const fetcher = fakeFetch({
      body: { ok: true, path: '/private/work/project/uploads/hermie/x/aaaabbbb-report.csv' }
    })
    const result = await run({}, fetcher.impl)

    expect(result.path).toBe('/private/work/project/uploads/hermie/x/aaaabbbb-report.csv')
    expect(result.reference).toContain('/private/work/project/')
  })

  it('refuses a file over the cap before any bytes move', async () => {
    const fetcher = fakeFetch()

    await expect(run({ file: { ...FILE, size: MAX_UPLOAD_BYTES + 1 } }, fetcher.impl)).rejects.toMatchObject({
      name: 'FileUploadError',
      reason: 'too-large'
    })

    expect(fetcher.calls).toHaveLength(0)
  })

  it('refuses rather than guessing when the session has no working directory', async () => {
    const fetcher = fakeFetch()

    await expect(run({ cwd: undefined }, fetcher.impl)).rejects.toMatchObject({ reason: 'no-workspace' })
    // A plausible wrong directory would upload fine and then produce a
    // reference the agent refuses, which is the worst of the outcomes.
    expect(fetcher.calls).toHaveLength(0)
  })

  it('treats a root working directory as no working directory', async () => {
    const fetcher = fakeFetch()

    // A session created with no cwd reports `/`. It is truthy, so it used to get
    // past the guard above, and `uploadPathFor` then strips the slash and uploads
    // to `/uploads/hermie/…` — the filesystem root of the gateway's own machine.
    // Seen against a real gateway on 2026-09-21.
    for (const cwd of ['/', '//', '///']) {
      await expect(run({ cwd }, fetcher.impl)).rejects.toMatchObject({ reason: 'no-workspace' })
    }

    expect(fetcher.calls).toHaveLength(0)
  })

  it("reports a gateway refusal as refused, with the gateway's own reason", async () => {
    const fetcher = fakeFetch({ status: 403, body: { detail: 'Path outside managed files root' } })

    await expect(run({}, fetcher.impl)).rejects.toMatchObject({
      reason: 'refused',
      status: 403,
      message: expect.stringContaining('Path outside managed files root')
    })
  })

  it('maps a 413 back onto too-large, whatever the client thought the size was', async () => {
    const fetcher = fakeFetch({ status: 413, body: { detail: 'File is too large' } })

    await expect(run({}, fetcher.impl)).rejects.toMatchObject({ reason: 'too-large' })
  })

  it('reports a transport failure as failed rather than as a refusal', async () => {
    const impl = (async () => {
      throw new Error('Network request failed')
    }) as unknown as typeof fetch

    await expect(run({}, impl)).rejects.toMatchObject({ reason: 'failed' })
  })

  it('reports progress at both ends, and does not invent a curve between them', async () => {
    const seen: number[] = []

    await run({ onProgress: fraction => seen.push(fraction) })

    // React Native's fetch has no upload-progress event. Two honest values beat
    // a fake one that stalls at 90%.
    expect(seen).toEqual([0, 1])
  })

  it('is a FileUploadError, so a caller can narrow on it', async () => {
    const caught = await run({ cwd: undefined }).catch((error: unknown) => error)

    expect(caught).toBeInstanceOf(FileUploadError)
  })
})
