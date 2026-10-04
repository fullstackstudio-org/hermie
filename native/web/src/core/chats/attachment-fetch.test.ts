import { describe, expect, it, vi } from 'vitest'

import {
  type AttachmentFetcher,
  attachedImageRoute,
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

describe('the route for an image attached to a chat', () => {
  const home = '/root/.hermes'
  const named = `${home}/profiles/researcher`

  it('is asked for a path in the default profile’s images folder, as that profile', () => {
    expect(attachedImageRoute(`@image:${home}/images/upload_20261004_160406_1.png`, 'default')).toBe(
      '/api/files/images/upload_20261004_160406_1.png?profile=default'
    )
    // Quotes and the `[Image attached at: …]` handle's reference are the same path.
    expect(attachedImageRoute(`@image:"${home}/images/upload_1.JPG"`, 'default')).toBe(
      '/api/files/images/upload_1.JPG?profile=default'
    )
    expect(attachedImageRoute(`${home}/images/a-b_c.webp`, 'default')).toBe(
      '/api/files/images/a-b_c.webp?profile=default'
    )
  })

  it('is asked for a path in a named profile’s own images folder, as that profile', () => {
    expect(attachedImageRoute(`@image:${named}/images/upload_2.png`, 'researcher')).toBe(
      '/api/files/images/upload_2.png?profile=researcher'
    )
  })

  it('never asks for another profile’s folder, in either direction', () => {
    // The default profile's folder, for a named profile's chat.
    expect(attachedImageRoute(`${home}/images/upload_1.png`, 'researcher')).toBeNull()
    // Another profile's folder, for the researcher's chat and for the default's.
    expect(attachedImageRoute(`${home}/profiles/writer/images/upload_1.png`, 'researcher')).toBeNull()
    expect(attachedImageRoute(`${home}/profiles/writer/images/upload_1.png`, 'default')).toBeNull()
    // The named profile's folder, for the default profile's chat.
    expect(attachedImageRoute(`${named}/images/upload_1.png`, 'default')).toBeNull()
    // A folder that only has the profile's name in it.
    expect(attachedImageRoute(`${home}/researcher/images/upload_1.png`, 'researcher')).toBeNull()
    expect(attachedImageRoute(`${home}/profiles/researcher2/images/upload_1.png`, 'researcher')).toBeNull()
    expect(attachedImageRoute(`${home}/profiles/researcher/x/images/upload_1.png`, 'researcher')).toBeNull()
  })

  it('never asks for a nested path or a file that is not directly in images/', () => {
    expect(attachedImageRoute(`${home}/images/sub/upload_1.png`, 'default')).toBeNull()
    expect(attachedImageRoute(`${home}/images/images/upload_1.png`, 'default')).toBeNull()
    expect(attachedImageRoute(`${home}/workspace/upload_1.png`, 'default')).toBeNull()
    expect(attachedImageRoute(`${home}/images`, 'default')).toBeNull()
    expect(attachedImageRoute('/images/upload_1.png', 'default')).toBeNull()
  })

  it('never asks for what the route would not serve, or a path it cannot trust', () => {
    for (const refused of [
      `${home}/images/upload_1.heic`,
      `${home}/images/upload_1.pdf`,
      `${home}/images/upload_1`,
      `${home}/images/.hidden.png`,
      `${home}/images/a..b.png`,
      `${home}/images/my shot.png`,
      `${home}/images/up%2Fload.png`,
      `${home}/images/a.png?x=1`,
      `${home}/images/a.png#top`,
      `${home}/../images/a.png`,
      `${home}/./images/a.png`,
      `${home}//images/a.png`,
      `${home}\\images\\a.png`,
      `//host${home}/images/a.png`,
      'images/a.png',
      'https://example.com/images/a.png',
      '/api/files/images/a.png'
    ]) {
      expect(attachedImageRoute(refused, 'default'), refused).toBeNull()
    }

    // A profile name the gateway would not take is not put in an address.
    expect(attachedImageRoute(`${home}/images/a.png`, 'Not A Profile')).toBeNull()
    expect(attachedImageRoute(`${home}/images/a.png`, '')).toBeNull()
  })
})

describe('fetching an attached image', () => {
  const path = '/root/.hermes/images/upload_1.png'
  const route = '/api/files/images/upload_1.png?profile=default'

  it('asks the attached-image route first, as the chat’s profile, and nothing else when it answers', async () => {
    const files = fetcher({ [route]: PNG_URI })

    expect(await fetchAttachment(files, `@image:${path}`, 'default')).toMatchObject({
      kind: 'image',
      src: PNG_URI,
      name: 'upload_1.png'
    })
    expect(files.asked).toEqual([route])
  })

  it('never puts a credential in the address it asks for', async () => {
    const files = fetcher({ [route]: PNG_URI })

    await fetchAttachment(files, `@image:${path}`, 'default')

    expect(files.asked.join(' ')).not.toMatch(/token|bearer|auth/iu)
  })

  it('is the existing routes for a path in another profile’s folder, and for a chat with no profile', async () => {
    const writer = '/root/.hermes/profiles/writer/images/upload_1.png'
    const other = fetcher({ [`/api/files/download?path=${writer}`]: PNG_URI })

    expect(await fetchAttachment(other, `@image:${writer}`, 'researcher')).toMatchObject({ kind: 'image' })
    expect(other.asked).toEqual([`/api/files/download?path=${writer}`])

    const bare = fetcher({ [`/api/files/download?path=${path}`]: PNG_URI })

    expect(await fetchAttachment(bare, `@image:${path}`)).toMatchObject({ kind: 'image' })
    expect(bare.asked).toEqual([`/api/files/download?path=${path}`])
  })

  it('is the existing routes for a nested path, whatever the profile', async () => {
    const nested = '/root/.hermes/images/sub/upload_1.png'
    const files = fetcher({})

    expect(await fetchAttachment(files, `@image:${nested}`, 'default')).toBeNull()
    expect(files.asked).toEqual([`/api/files/download?path=${nested}`, `/api/media?path=${nested}`])
  })

  it('falls back to the existing routes when the gateway has no such image, and is null when they have none either', async () => {
    const files = fetcher({})

    expect(await fetchAttachment(files, `@image:${path}`, 'default')).toBeNull()
    expect(files.asked).toEqual([route, `/api/files/download?path=${path}`, `/api/media?path=${path}`])
  })

  it('is what the loader asks for, with its profile', async () => {
    const files = fetcher({ [route]: PNG_URI })

    expect(await createAttachmentLoader(files, 'default')(`@image:${path}`)).toMatchObject({ kind: 'image' })
    expect(files.asked).toEqual([route])
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
