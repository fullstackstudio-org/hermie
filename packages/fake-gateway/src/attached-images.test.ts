/**
 * `GET /api/files/images/{name}?profile=<profile>`, as the fake serves it from `profileHomes`.
 *
 * The route is `hermes_cli/web_routers/files.py::get_attached_image`: one name with an image suffix, a regular
 * file directly in `<profile home>/images/`, no link at either step, at most 25 MB, a 404 for everything it will
 * not serve (with no hint whether the file exists), the gate's own auth (header or cookie, never `?token=`).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ATTACHED_IMAGE_MAX_BYTES } from './attached-images'
import { type FakeGateway, type FakeGatewayOptions, startFakeGateway } from './server'

/** A 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const OTHER = Buffer.from('GIF89a-the-other-profile')

const gateways: FakeGateway[] = []
let scratch = ''
let defaultHome = ''
let researcherHome = ''

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'fake-attached-images-'))
  defaultHome = join(scratch, 'default')
  researcherHome = join(scratch, 'researcher')
  mkdirSync(join(defaultHome, 'images'), { recursive: true })
  mkdirSync(join(researcherHome, 'images'), { recursive: true })
  writeFileSync(join(defaultHome, 'images', 'upload_1.png'), PNG)
  writeFileSync(join(researcherHome, 'images', 'upload_2.gif'), OTHER)
})

afterEach(async () => {
  while (gateways.length) {
    await gateways.pop()?.close()
  }

  rmSync(scratch, { recursive: true, force: true })
})

const start = async (options: FakeGatewayOptions = {}): Promise<FakeGateway> => {
  const gateway = await startFakeGateway({
    port: 0,
    auth: 'token',
    token: 's3cret',
    profileHomes: { default: defaultHome, researcher: researcherHome },
    ...options
  })

  gateways.push(gateway)

  return gateway
}

const get = (
  gateway: FakeGateway,
  path: string,
  headers: Record<string, string> = { 'x-hermes-session-token': 's3cret' }
) => fetch(`${gateway.url}${path}`, { headers })

describe('GET /api/files/images/{name}', () => {
  it('serves a profile’s own image, as the image it is', async () => {
    const gateway = await start()
    const response = await get(gateway, '/api/files/images/upload_1.png?profile=default')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-disposition')).toBe('inline; filename="upload_1.png"')
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true)
    expect(gateway.state.attachedImageRequests).toEqual([{ name: 'upload_1.png', profile: 'default', status: 200 }])
  })

  it('serves a named profile from that profile’s folder and never from another’s', async () => {
    const gateway = await start()

    const own = await get(gateway, '/api/files/images/upload_2.gif?profile=researcher')

    expect(own.status).toBe(200)
    expect(own.headers.get('content-type')).toBe('image/gif')
    expect(Buffer.from(await own.arrayBuffer()).equals(OTHER)).toBe(true)

    // The default profile's picture is not the researcher's, and the other way round.
    expect((await get(gateway, '/api/files/images/upload_1.png?profile=researcher')).status).toBe(404)
    expect((await get(gateway, '/api/files/images/upload_2.gif?profile=default')).status).toBe(404)
  })

  it('answers the dashboard’s own profile when none is given', async () => {
    const gateway = await start()

    expect((await get(gateway, '/api/files/images/upload_1.png')).status).toBe(200)
  })

  it('refuses a profile it does not have (404) and a name that is no profile name (400)', async () => {
    const gateway = await start()

    expect((await get(gateway, '/api/files/images/upload_1.png?profile=ghost')).status).toBe(404)
    expect((await get(gateway, '/api/files/images/upload_1.png?profile=a%20b')).status).toBe(400)
    expect((await get(gateway, '/api/files/images/upload_1.png?profile=..%2Fx')).status).toBe(400)
  })

  it('answers 404 for a profile with no home, and for no homes at all', async () => {
    const gateway = await start({ profileHomes: { default: defaultHome } })

    expect((await get(gateway, '/api/files/images/upload_2.gif?profile=researcher')).status).toBe(404)

    const bare = await start({ profileHomes: {} })

    expect((await get(bare, '/api/files/images/upload_1.png?profile=default')).status).toBe(404)
  })

  it.each([
    ['a name that is not an image', 'upload_1.txt'],
    ['an image type the route does not serve', 'upload_1.heic'],
    ['a name with no suffix', 'upload_1'],
    ['a missing file', 'nothing.png'],
    ['a dot first', '.hidden.png'],
    ['two dots in a row', 'a..b.png'],
    ['a name with a space', 'my%20shot.png']
  ])('answers 404 for %s', async (_what, name) => {
    writeFileSync(join(defaultHome, 'images', 'upload_1.txt'), 'x')
    writeFileSync(join(defaultHome, 'images', 'upload_1'), 'x')
    writeFileSync(join(defaultHome, 'images', 'upload_1.heic'), PNG)
    writeFileSync(join(defaultHome, 'images', '.hidden.png'), PNG)
    writeFileSync(join(defaultHome, 'images', 'a..b.png'), PNG)
    writeFileSync(join(defaultHome, 'images', 'my shot.png'), PNG)

    const gateway = await start()

    expect((await get(gateway, `/api/files/images/${name}?profile=default`)).status).toBe(404)
  })

  it('does not reach a nested path: the name is one path segment', async () => {
    mkdirSync(join(defaultHome, 'images', 'sub'))
    writeFileSync(join(defaultHome, 'images', 'sub', 'deep.png'), PNG)

    const gateway = await start()

    expect((await get(gateway, '/api/files/images/sub/deep.png?profile=default')).status).toBe(404)
    expect((await get(gateway, '/api/files/images/sub%2Fdeep.png?profile=default')).status).toBe(404)
    expect((await get(gateway, '/api/files/images/..%2Fupload_1.png?profile=default')).status).toBe(404)
  })

  it('never follows a link, at the file or at the folder', async () => {
    writeFileSync(join(scratch, 'secret.png'), PNG)
    symlinkSync(join(scratch, 'secret.png'), join(defaultHome, 'images', 'linked.png'))

    const gateway = await start()

    expect((await get(gateway, '/api/files/images/linked.png?profile=default')).status).toBe(404)

    // The folder itself a link: nothing in it is served.
    rmSync(join(researcherHome, 'images'), { recursive: true })
    symlinkSync(join(defaultHome, 'images'), join(researcherHome, 'images'))

    expect((await get(gateway, '/api/files/images/upload_1.png?profile=researcher')).status).toBe(404)
  })

  it('answers 404 for a folder named like an image', async () => {
    mkdirSync(join(defaultHome, 'images', 'folder.png'))

    const gateway = await start()

    expect((await get(gateway, '/api/files/images/folder.png?profile=default')).status).toBe(404)
  })

  it('refuses an image over the cap', async () => {
    writeFileSync(join(defaultHome, 'images', 'big.png'), Buffer.alloc(ATTACHED_IMAGE_MAX_BYTES + 1))

    const gateway = await start()

    expect((await get(gateway, '/api/files/images/big.png?profile=default')).status).toBe(413)
  })

  it('takes an uppercase suffix as the image it is', async () => {
    writeFileSync(join(defaultHome, 'images', 'SHOT.PNG'), PNG)

    const gateway = await start()
    const response = await get(gateway, '/api/files/images/SHOT.PNG?profile=default')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
  })

  it('needs the gate’s credentials, and never takes a token in the address', async () => {
    const gateway = await start()

    expect((await get(gateway, '/api/files/images/upload_1.png?profile=default', {})).status).toBe(401)
    expect((await get(gateway, '/api/files/images/upload_1.png?profile=default&token=s3cret', {})).status).toBe(401)
  })

  it('answers GET alone', async () => {
    const gateway = await start()
    const response = await fetch(`${gateway.url}/api/files/images/upload_1.png?profile=default`, {
      method: 'DELETE',
      headers: { 'x-hermes-session-token': 's3cret' }
    })

    expect(response.status).toBe(405)
    expect(await response.text()).toContain('Method Not Allowed')
  })
})
