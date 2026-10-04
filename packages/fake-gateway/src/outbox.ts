import { createHash, randomBytes } from 'node:crypto'

import { OUTBOX_SAMPLES, type OutboxKind, type OutboxSample, type OutboxSampleName } from './outbox-samples'

/**
 * The files a bot shares, and `GET /api/files/outbox/{id}/{name}?profile=<profile>`, by `contract/outbox/`
 * (the fork's `tui_gateway/outbox.py` and its route).
 *
 * The fork copies a file the agent named (`MEDIA:<path>`) into the profile's `outbox/<token>/` at the end of a
 * turn and sends `attachments` with `message.complete`. This fake has no agent and no disk: a scenario reply names
 * the files it shares (`ScenarioReply.attachments`: a sample, or a name with its bytes), the bytes are held in
 * memory under a fresh token, and the route answers what the contract says it answers: the access rule (the
 * profile asked for and the recorded name; anything else is a 404 that does not say whether the file exists), the
 * headers every answer carries, the disposition per kind, one byte range (`206`/`416`), `If-Range` and
 * `If-None-Match`.
 */

/** A file a scenario shares: one of the samples (`OUTBOX_SAMPLES`), or a name with its content. */
export type ScenarioAttachment =
  | { sample: OutboxSampleName; name?: string }
  | { name: string; mime: string; kind?: OutboxKind; text?: string; base64?: string }

export interface OutboxFile {
  id: string
  profile: string
  name: string
  mime: string
  kind: OutboxKind
  body: Buffer
  sha256: string
  createdAt: number
}

/** The wire shape of one attachment (`contract/outbox/schema.json`). */
export interface WireAttachment {
  id: string
  name: string
  mime: string
  kind: OutboxKind
  size: number
  sha256: string
  created_at: number
  url: string
}

/** One request to the route, as the fake records it. */
export interface OutboxRequest {
  id: string
  name: string
  profile: string | null
  method: string
  range: string | null
  status: number
}

/** `name` as the route's address spells it: percent-encoded, as Python's `urllib.parse.quote` does. */
export function quoteName(name: string): string {
  return encodeURIComponent(name).replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function wireOf(file: OutboxFile): WireAttachment {
  return {
    id: file.id,
    name: file.name,
    mime: file.mime,
    kind: file.kind,
    size: file.body.length,
    sha256: file.sha256,
    created_at: file.createdAt,
    url: `/api/files/outbox/${file.id}/${quoteName(file.name)}`
  }
}

/** Keep `body` for `profile` under a new token. */
export function storeFile(
  files: Map<string, OutboxFile>,
  profile: string,
  sample: OutboxSample,
  now: number
): OutboxFile {
  const file: OutboxFile = {
    id: randomBytes(24).toString('base64url'),
    profile,
    name: sample.name,
    mime: sample.mime,
    kind: sample.kind,
    body: sample.body,
    sha256: createHash('sha256').update(sample.body).digest('hex'),
    createdAt: now
  }

  files.set(file.id, file)

  return file
}

/** A scenario's attachment as a sample to keep. */
export function sampleOf(entry: ScenarioAttachment): OutboxSample {
  if ('sample' in entry) {
    const sample = OUTBOX_SAMPLES[entry.sample]()

    return entry.name ? { ...sample, name: entry.name } : sample
  }

  return {
    name: entry.name,
    mime: entry.mime,
    kind: entry.kind ?? 'file',
    body: entry.base64 !== undefined ? Buffer.from(entry.base64, 'base64') : Buffer.from(entry.text ?? '', 'utf8')
  }
}

/** What a range header asks for, on a file of `size` bytes. */
export type RangeAnswer =
  { kind: 'whole' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' }

const RANGE_SPEC = /^(\d*)-(\d*)$/u

/**
 * `bytes=first-last`, `first-` or `-suffix` is one range: `206`. A range that starts past the end, ends before it
 * starts, is malformed (a number of more than 18 digits included) or asks for zero bytes is `416`. Another unit,
 * or several ranges, is the whole file.
 */
export function rangeOf(header: string | undefined, size: number): RangeAnswer {
  if (header === undefined || !header.startsWith('bytes=')) {
    return { kind: 'whole' }
  }

  const spec = header.slice('bytes='.length).trim()

  if (spec.includes(',')) {
    return { kind: 'whole' }
  }

  const match = RANGE_SPEC.exec(spec)

  if (!match || (match[1] === '' && match[2] === '') || (match[1] ?? '').length > 18 || (match[2] ?? '').length > 18) {
    return { kind: 'unsatisfiable' }
  }

  const first = match[1] === '' ? undefined : Number(match[1])
  const last = match[2] === '' ? undefined : Number(match[2])

  if (first === undefined) {
    const suffix = last as number

    return suffix === 0 || size === 0
      ? { kind: 'unsatisfiable' }
      : { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 }
  }

  if (first >= size || (last !== undefined && last < first)) {
    return { kind: 'unsatisfiable' }
  }

  return { kind: 'partial', start: first, end: Math.min(last ?? size - 1, size - 1) }
}

/** Types a browser would run in the page's origin: the route labels them `application/octet-stream`. */
const ACTIVE_TYPES =
  /^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|(?:application|text)\/(?:xml|(?:x-)?javascript|ecmascript))\b/iu
const DOCUMENT_DESTINATIONS = new Set(['document', 'iframe', 'frame', 'embed', 'object'])

/** `content_type` and `disposition` of an answer (`examples.json`: `dispositions`). */
export function presentation(
  file: Pick<OutboxFile, 'kind' | 'mime'>,
  secFetchDest?: string
): { contentType: string; disposition: 'inline' | 'attachment' } {
  const inline = file.kind !== 'file'
  const pageRequest = file.kind === 'pdf' && secFetchDest !== undefined && DOCUMENT_DESTINATIONS.has(secFetchDest)

  return {
    contentType: !inline && ACTIVE_TYPES.test(file.mime) ? 'application/octet-stream' : file.mime,
    disposition: inline && !pageRequest ? 'inline' : 'attachment'
  }
}

const asciiName = (name: string): string => name.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_')

export interface OutboxAnswer {
  status: 200 | 206 | 304 | 404 | 416
  headers: Record<string, string>
  body?: Buffer
}

export interface OutboxQuery {
  method: string
  id: string
  name: string
  /** The raw `profile` query value, if any. */
  profile: string | null
  /** The dashboard's own profile, for a request without `profile`. */
  defaultProfile: string
  range?: string
  ifRange?: string
  ifNoneMatch?: string
  secFetchDest?: string
}

/**
 * What every answer of the route carries (`contract/outbox/` §4), a 404 included: the file's own headers (`ETag`,
 * the disposition, `Accept-Ranges`) say something about a file, and a 404 has none to say it about.
 */
const SAFETY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer'
}

const NOT_FOUND: OutboxAnswer = {
  status: 404,
  headers: { ...SAFETY_HEADERS, 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ detail: 'Not Found' }))
}

/** The route's answer. */
export function answerOutbox(files: ReadonlyMap<string, OutboxFile>, query: OutboxQuery): OutboxAnswer {
  const file = files.get(query.id)
  const profile = ((query.profile ?? query.defaultProfile).trim() || 'default').toLowerCase()

  if (!file || file.name !== query.name || file.profile !== profile) {
    return NOT_FOUND
  }

  const { contentType, disposition } = presentation(file, query.secFetchDest)
  const size = file.body.length
  const etag = `"${file.sha256}"`
  const common = {
    ...SAFETY_HEADERS,
    'accept-ranges': 'bytes',
    etag,
    'cache-control': 'private, max-age=86400',
    'content-type': contentType,
    'content-disposition': `${disposition}; filename="${asciiName(file.name)}"; filename*=UTF-8''${quoteName(file.name)}`
  }

  if (query.ifNoneMatch !== undefined && query.ifNoneMatch.split(',').some(tag => tag.trim() === etag)) {
    return { status: 304, headers: { ...common, 'content-length': '0' } }
  }

  // `If-Range` with another validator: the whole file, as if no range was asked.
  const range =
    query.ifRange !== undefined && query.ifRange.trim() !== etag
      ? { kind: 'whole' as const }
      : rangeOf(query.range, size)

  if (range.kind === 'unsatisfiable') {
    return { status: 416, headers: { ...common, 'content-range': `bytes */${size}`, 'content-length': '0' } }
  }

  if (range.kind === 'partial') {
    const body = file.body.subarray(range.start, range.end + 1)

    return {
      status: 206,
      headers: {
        ...common,
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
        'content-length': String(body.length)
      },
      ...(query.method === 'HEAD' ? {} : { body })
    }
  }

  return {
    status: 200,
    headers: { ...common, 'content-length': String(size) },
    ...(query.method === 'HEAD' ? {} : { body: file.body })
  }
}
