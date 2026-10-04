/**
 * The licence list the build carries (`licenses.json`, beside the page), read for Settings, About.
 *
 * The file is generated from the client's production dependency tree by
 * `scripts/generate-third-party-licenses.mjs --web` and has the shape the Expo app bundles: a list of
 * packages (name, version, the licence each declares, where its source is, the hash of its licence
 * text) and the licence texts by hash, identical texts stored once. It is read defensively: it is a
 * file served beside the page, and a build that lacks it, or carries one in a shape this reader does
 * not know, is a sentence on the About page and nothing else. Every string in it is drawn as text.
 */

/** The part of `fetch` this uses, so a test can hand in its own. */
export type LicenceFetch = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>

export interface LicencePackage {
  name: string
  version: string
  /** The identifier the package declares; empty when it declares none. */
  licence: string
  /** Where its source is, as a plain string; empty when the file names none. */
  repository: string
  /** The licence text the package carries; empty when it ships no licence file. */
  text: string
}

export interface LicenceList {
  packages: LicencePackage[]
}

/** More packages than a client of this size has, so a file that lists more is not read. */
const MAX_PACKAGES = 1000

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Read a parsed `licenses.json`, or `null` when it is not one. */
export function parseLicences(value: unknown): LicenceList | null {
  if (!isObject(value) || !Array.isArray(value.packages) || value.packages.length > MAX_PACKAGES) {
    return null
  }

  const texts = isObject(value.texts) ? value.texts : {}
  const packages: LicencePackage[] = []

  for (const entry of value.packages) {
    if (!isObject(entry) || text(entry.name) === '') {
      continue
    }

    const hash = text(entry.text)

    packages.push({
      name: text(entry.name),
      version: text(entry.version),
      licence: text(entry.licence),
      repository: text(entry.repository),
      text: hash === '' ? '' : text(texts[hash])
    })
  }

  return { packages }
}

/** Fetch and read the list. Rejects with an `Error` whose message names what went wrong. */
export async function loadLicences(
  url: string,
  fetchImpl: LicenceFetch = (input, init) => globalThis.fetch(input, init),
  signal?: AbortSignal
): Promise<LicenceList> {
  const response = await fetchImpl(url, signal ? { signal } : undefined)

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  const list = parseLicences(await response.json())

  if (!list) {
    throw new Error('not a licence list')
  }

  return list
}
