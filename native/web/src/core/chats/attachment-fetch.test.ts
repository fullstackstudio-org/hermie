import { describe, expect, it, vi } from 'vitest'

import {
  type AttachmentFetcher,
  attachmentRoute,
  createAttachmentLoader,
  fetchAttachment,
  judge,
  namesAPicture
} from './attachment-fetch'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG_URI = `data:image/png;base64,${PNG}`
const HEIC = btoa(String.fromCharCode(0, 0, 0, 0x18, ...[...'ftypheic'].map(c => c.charCodeAt(0)), 0, 0, 0, 0))

const fetcher = (answers: Record<string, string | null>): AttachmentFetcher & { asked: string[] } => {
  const asked: string[] = []

  return {
    asked,
    fetchPicture: async path => {
      asked.push(path)
      const uri = answers[path]

      return uri ? { kind: 'ready', dataUri: uri } : { kind: 'missing' }
    }
  }
}

describe('what an attachment reference is asked of the gateway as', () => {
  it('asks a path on the gateway’s disk of its managed-files route', () => {
    expect(attachmentRoute('@file:/root/uploads/hermie/9eh14f1h-Image-2026-10-04-at-16.31.52')).toEqual({
      primary: '/api/files/download?path=/root/uploads/hermie/9eh14f1h-Image-2026-10-04-at-16.31.52',
      media: null,
      name: '9eh14f1h-Image-2026-10-04-at-16.31.52'
    })
  })

  it('adds the picture route for a picture, and escapes what a query would misread', () => {
    expect(attachmentRoute('@image:"/root/my shot&1.png"')).toEqual({
      primary: '/api/files/download?path=/root/my%20shot%261.png',
      media: '/api/media?path=/root/my%20shot%261.png',
      name: 'my shot&1.png'
    })
  })

  it('passes a path the gateway serves under /api/files as it is', () => {
    expect(attachmentRoute('/api/files/chart.png')?.primary).toBe('/api/files/chart.png')
    expect(attachmentRoute('api/files/a/b.pdf')?.primary).toBe('/api/files/a/b.pdf')
  })

  it('does not ask for a name, a web address or a path that climbs', () => {
    for (const refused of [
      '@image:Image',
      '@image:photo.png',
      '@image:"https://example.com/a.png"',
      '@file://evil.example/a',
      '@file:/srv/a/../../etc/passwd',
      '/api/files/../secret',
      '/api/files/%2e%2e/secret',
      '@file:/srv/a\\b',
      ''
    ]) {
      expect(attachmentRoute(refused), refused).toBeNull()
    }
  })

  it('knows a picture by its marker or its extension', () => {
    expect(namesAPicture('@image:/x/y')).toBe(true)
    expect(namesAPicture('@file:/x/y.JPEG')).toBe(true)
    expect(namesAPicture('@file:/x/9eh14f1h-Image-2026-10-04-at-16.31.52')).toBe(false)
    expect(namesAPicture('@file:/x/report.pdf')).toBe(false)
  })
})

describe('what comes back is judged by its first bytes', () => {
  it('calls a picture a picture whatever the gateway said it was', () => {
    expect(judge(`data:application/octet-stream;base64,${PNG}`, 'upload')).toEqual({
      kind: 'image',
      src: PNG_URI,
      name: 'upload'
    })
  })

  it('keeps a file that is not a picture a file, and a picture the browser cannot draw a file', () => {
    const text = judge(`data:text/csv;base64,${btoa('a,b\n1,2\n')}`, 'rows.csv')

    expect(text).toMatchObject({ kind: 'file', name: 'rows.csv' })
    expect(text?.kind === 'file' && text.blob.size).toBe(8)
    expect(judge(`data:image/heic;base64,${HEIC}`, 'x.heic')?.kind).toBe('file')
  })

  it('says nothing for what is not a data URI', () => {
    expect(judge('https://example.com/a.png', 'a')).toBeNull()
    expect(judge('data:image/png;base64', 'a')).toBeNull()
  })
})

describe('fetching one reference', () => {
  it('is the managed-files route first', async () => {
    const files = fetcher({ '/api/files/download?path=/root/up/1': `data:application/octet-stream;base64,${PNG}` })

    expect(await fetchAttachment(files, '@file:/root/up/1')).toMatchObject({ kind: 'image', src: PNG_URI })
    expect(files.asked).toEqual(['/api/files/download?path=/root/up/1'])
  })

  it('tries the picture route when the files route keeps a picture back', async () => {
    const answer = btoa(JSON.stringify({ data_url: PNG_URI }))
    const files = fetcher({
      '/api/media?path=/root/.hermes/images/upload_1.png': `data:application/json;base64,${answer}`
    })

    expect(await fetchAttachment(files, '@image:/root/.hermes/images/upload_1.png')).toMatchObject({
      kind: 'image',
      src: PNG_URI
    })
    expect(files.asked).toEqual([
      '/api/files/download?path=/root/.hermes/images/upload_1.png',
      '/api/media?path=/root/.hermes/images/upload_1.png'
    ])
  })

  it('is null when the gateway hands nothing over, and never asks for what it has no route for', async () => {
    const files = fetcher({})

    expect(await fetchAttachment(files, '@file:/root/gone.pdf')).toBeNull()
    expect(await fetchAttachment(files, '@image:"https://example.com/a.png"')).toBeNull()
    expect(files.asked).toEqual(['/api/files/download?path=/root/gone.pdf'])
  })
})

describe('the loader', () => {
  it('makes one request of two asks, and asks again after a refusal', async () => {
    const files = fetcher({ '/api/files/download?path=/root/a.png': PNG_URI })
    const load = createAttachmentLoader(files)

    const [one, two] = await Promise.all([load('@image:/root/a.png'), load('@image:/root/a.png')])

    expect(one).toBe(two)
    expect(files.asked).toHaveLength(1)

    await load('@file:/root/missing.pdf')
    await load('@file:/root/missing.pdf')
    expect(files.asked.filter(path => path.endsWith('missing.pdf'))).toHaveLength(2)
  })

  it('fetches a few at a time', async () => {
    let running = 0
    let peak = 0
    const release: (() => void)[] = []
    const slow: AttachmentFetcher = {
      fetchPicture: async () => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise<void>(resolve => release.push(resolve))
        running -= 1

        return { kind: 'ready', dataUri: PNG_URI }
      }
    }
    const load = createAttachmentLoader(slow)
    const all = Promise.all(Array.from({ length: 8 }, (_, index) => load(`@image:/root/${index}.png`)))

    for (let round = 0; round < 30; round += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
      release.splice(0).forEach(done => done())
    }

    expect((await all).every(result => result?.kind === 'image')).toBe(true)
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('answers null when the fetch throws', async () => {
    const load = createAttachmentLoader({ fetchPicture: vi.fn().mockRejectedValue(new Error('offline')) })

    expect(await load('@image:/root/a.png')).toBeNull()
  })
})
