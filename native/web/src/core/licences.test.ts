/**
 * The licence list the build carries, read defensively: a package without a name is dropped, a text is
 * found by its hash, and a file that is not a list is refused with a reason a page can show.
 */
import { describe, expect, it, vi } from 'vitest'

import { loadLicences, type LicenceFetch, parseLicences } from './licences'

const FILE = {
  generatedBy: 'x',
  packages: [
    { name: 'react', version: '19.1.0', licence: 'MIT', repository: 'https://example.test/react', text: 'aaa' },
    { name: 'no-text', version: '1.0.0', licence: 'ISC' },
    { name: 'no-licence', version: '2.0.0', text: 'bbb' },
    { version: '3.0.0', licence: 'MIT' },
    'junk'
  ],
  texts: { aaa: 'MIT License\n\nCopyright', bbb: 'Some other text' }
}

describe('parseLicences', () => {
  it('reads each package with its text found by hash, and drops what is not a package', () => {
    expect(parseLicences(FILE)).toEqual({
      packages: [
        {
          name: 'react',
          version: '19.1.0',
          licence: 'MIT',
          repository: 'https://example.test/react',
          text: 'MIT License\n\nCopyright'
        },
        { name: 'no-text', version: '1.0.0', licence: 'ISC', repository: '', text: '' },
        { name: 'no-licence', version: '2.0.0', licence: '', repository: '', text: 'Some other text' }
      ]
    })
  })

  it('gives an empty text for a hash the file does not hold', () => {
    expect(parseLicences({ packages: [{ name: 'a', text: 'zzz' }], texts: {} })?.packages[0]?.text).toBe('')
    expect(parseLicences({ packages: [{ name: 'a', text: 'zzz' }] })?.packages[0]?.text).toBe('')
  })

  it('refuses what is not a list', () => {
    expect(parseLicences(null)).toBeNull()
    expect(parseLicences([])).toBeNull()
    expect(parseLicences({ packages: 'x' })).toBeNull()
    expect(parseLicences({ packages: Array.from({ length: 1001 }, () => ({ name: 'a' })) })).toBeNull()
  })
})

describe('loadLicences', () => {
  const answer = (ok: boolean, status: number, body: unknown): LicenceFetch =>
    vi.fn(async () => ({ ok, status, json: async () => body }))

  it('fetches the address it is given and reads the answer', async () => {
    const fetchImpl = answer(true, 200, FILE)
    const list = await loadLicences('https://gw.example.test/app/licenses.json', fetchImpl)

    expect(list.packages).toHaveLength(3)
    expect(fetchImpl).toHaveBeenCalledWith('https://gw.example.test/app/licenses.json', undefined)
  })

  it('hands the abort signal on', async () => {
    const fetchImpl = answer(true, 200, FILE)
    const controller = new AbortController()

    await loadLicences('x', fetchImpl, controller.signal)

    expect(fetchImpl).toHaveBeenCalledWith('x', { signal: controller.signal })
  })

  it('rejects with the status of a refusal, and with a reason for a file that is not a list', async () => {
    await expect(loadLicences('x', answer(false, 404, {}))).rejects.toThrow('HTTP 404')
    await expect(loadLicences('x', answer(true, 200, { nope: true }))).rejects.toThrow('not a licence list')
  })
})
