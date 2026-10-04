/**
 * The text-to-speech routes, pinned against `hermes_cli/web_routers/audio.py` and
 * `tools/voice_client_config.py`: what the app's "voice from your gateway" is built on.
 *
 * The properties worth a test are the ones a client gets wrong by assuming: `voice-config` carries a
 * provider's API key for a direct provider (and names a relayed provider only inside its reason), the
 * gateway as shipped takes no voice with a request, `speak-stream` answers in binary PCM between a
 * `start` and an `end`, and a provider with no chunked API answers `fallback`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeAudioOptions, type FakeGateway, type FakeGatewayOptions, startFakeGateway } from './server'

type Body = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const gateways: FakeGateway[] = []

afterEach(async () => {
  while (gateways.length) {
    await gateways.pop()?.close()
  }
})

const start = async (options: FakeGatewayOptions = {}): Promise<FakeGateway> => {
  const gateway = await startFakeGateway({ port: 0, ...options })
  gateways.push(gateway)

  return gateway
}

const get = async (gateway: FakeGateway, path: string): Promise<{ status: number; body: Body }> => {
  const response = await fetch(`${gateway.url}${path}`)

  return { status: response.status, body: await response.json().catch(() => null) }
}

const post = async (gateway: FakeGateway, path: string, body: unknown): Promise<{ status: number; body: Body }> => {
  const response = await fetch(`${gateway.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

  return { status: response.status, body: await response.json().catch(() => null) }
}

/** One speech session: the frames the gateway answered, in order, text as parsed JSON and binary as byte counts. */
const session = async (
  gateway: FakeGateway,
  frames: unknown[],
  query = '',
  options: { stopAfterFirstBinary?: boolean } = {}
): Promise<{ events: (Record<string, unknown> | number)[]; closeCode: number }> => {
  const socket = new WebSocket(`${gateway.wsUrl.replace('/api/ws', '')}/api/audio/speak-stream${query}`)
  const events: (Record<string, unknown> | number)[] = []

  return await new Promise((resolve, reject) => {
    socket.on('open', () => {
      for (const frame of frames) {
        socket.send(JSON.stringify(frame))
      }
    })
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        events.push((data as Buffer).length)

        if (options.stopAfterFirstBinary) {
          socket.send(JSON.stringify({ stop: true }))
        }
      } else {
        events.push(JSON.parse(String(data)) as Record<string, unknown>)
      }
    })
    socket.on('close', code => resolve({ events, closeCode: code }))
    socket.on('error', reject)
  })
}

describe('voice-config', () => {
  it('names a relayed provider only inside its reason, with no key', async () => {
    const { body } = await get(await start(), '/api/audio/voice-config')

    expect(body.ok).toBe(true)
    expect(body.tts).toEqual({ mode: 'relay', reason: "provider 'edge' has no client wire" })
  })

  it('hands a direct provider over with its API key, as the desktop wants it', async () => {
    const { body } = await get(await start({ audio: { provider: 'elevenlabs' } }), '/api/audio/voice-config')

    expect(body.tts.mode).toBe('direct')
    expect(body.tts.provider).toBe('elevenlabs')
    expect(body.tts.voice).toBe('voice-rachel')
    // A client that keeps or shows this value has leaked the gateway's key.
    expect(typeof body.tts.api_key).toBe('string')
  })

  it('advertises a voice per request only when the gateway takes one', async () => {
    const shipped = (await get(await start(), '/api/audio/voice-config')).body.tts
    const newer = (
      await get(
        await start({
          audio: {
            voiceSelection: true,
            edgeVoices: [{ id: 'nl-NL-ColetteNeural', name: 'Colette', language: 'nl-NL' }]
          }
        }),
        '/api/audio/voice-config'
      )
    ).body.tts

    expect(shipped).not.toHaveProperty('voice_selection')
    expect(newer.voice_selection).toBe(true)
    expect(newer.voices).toEqual([{ id: 'nl-NL-ColetteNeural', name: 'Colette', language: 'nl-NL' }])
  })

  it('is a 404 on a gateway with no audio routes', async () => {
    expect((await get(await start({ audio: false }), '/api/audio/voice-config')).status).toBe(404)
  })

  it('says how a voice may be heard first, only where that is free, and prosody', async () => {
    const paid = (await get(await start({ audio: { provider: 'openai' } }), '/api/audio/voice-config')).body.tts
    const eleven = (
      await get(
        await start({ audio: { provider: 'elevenlabs', voicePreview: 'sample', prosody: true } }),
        '/api/audio/voice-config'
      )
    ).body.tts
    const edge = (await get(await start({ audio: { voicePreview: 'speak' } }), '/api/audio/voice-config')).body.tts

    expect(paid).not.toHaveProperty('voice_preview')
    expect(paid).not.toHaveProperty('prosody')
    expect(eleven.voice_preview).toBe('sample')
    expect(eleven.prosody).toBe(true)
    expect(edge.voice_preview).toBe('speak')
  })

  it('says voices_error with no voices, and a cold cache is loading for a few answers and then listed', async () => {
    const edgeVoices = [{ id: 'nl-NL-ColetteNeural', name: 'Colette', language: 'nl-NL' }]
    const failed = (
      await get(
        await start({ audio: { voiceSelection: true, edgeVoices, voicesError: 'unavailable' } }),
        '/api/audio/voice-config'
      )
    ).body.tts
    const cold = await start({
      audio: { voiceSelection: true, edgeVoices, voicesError: 'loading', voicesLoadingAnswers: 2 }
    })
    const answers = [
      (await get(cold, '/api/audio/voice-config')).body.tts,
      (await get(cold, '/api/audio/voice-config')).body.tts,
      (await get(cold, '/api/audio/voice-config')).body.tts
    ]

    expect(failed.voices_error).toBe('unavailable')
    expect(failed.voices).toEqual([])
    expect(answers.map(tts => tts.voices_error)).toEqual(['loading', 'loading', undefined])
    expect(answers.map(tts => tts.voices.length)).toEqual([0, 0, 1])
  })
})

describe('elevenlabs/voices/{id}/preview', () => {
  it('answers a tiny real MP3 as audio/mpeg and records the request', async () => {
    const gateway = await start({ audio: { voicePreview: 'sample' } })
    const response = await fetch(`${gateway.url}/api/audio/elevenlabs/voices/voice-rachel/preview?profile=writer`)
    const bytes = Buffer.from(await response.arrayBuffer())

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
    expect(bytes.length).toBeGreaterThan(100)
    expect(bytes.length).toBeLessThan(4096)
    // An MPEG audio frame: 11 sync bits.
    expect(bytes[0]).toBe(0xff)
    expect((bytes[1] as number) & 0xe0).toBe(0xe0)
    expect(gateway.state.audioRequests).toEqual([
      { kind: 'preview', text: '', voice: 'voice-rachel', profile: 'writer' }
    ])
  })

  it('is a 404 for a voice with no sample, an unknown voice, and a gateway with no key', async () => {
    const voices = [{ voice_id: 'quiet', name: 'Quiet', preview: false }]
    const quiet = await start({ audio: { voices } })

    expect((await get(quiet, '/api/audio/elevenlabs/voices/quiet/preview')).status).toBe(404)
    expect((await get(quiet, '/api/audio/elevenlabs/voices/nobody/preview')).status).toBe(404)
    expect(
      (await get(await start({ audio: { elevenLabsKey: false } }), '/api/audio/elevenlabs/voices/voice-rachel/preview'))
        .status
    ).toBe(404)
  })

  it('reads a percent-encoded voice id', async () => {
    const gateway = await start({ audio: { voices: [{ voice_id: 'a b/c', name: 'Odd' }] } })

    expect((await fetch(`${gateway.url}/api/audio/elevenlabs/voices/a%20b%2Fc/preview`)).status).toBe(200)
  })
})

describe('elevenlabs/voices', () => {
  it('lists the voices by label, cloned ones with theirs', async () => {
    const { body } = await get(await start(), '/api/audio/elevenlabs/voices')

    expect(body.available).toBe(true)
    expect(body.voices.map((voice: { label: string }) => voice.label)).toEqual([
      'Adam (premade)',
      'My own voice (cloned)',
      'Rachel (premade)'
    ])
    expect(body.voices[1]).toEqual({
      voice_id: 'voice-clone-1',
      name: 'My own voice',
      label: 'My own voice (cloned)',
      preview: true
    })
  })

  it('says per voice whether the gateway has a sample of it', async () => {
    const { body } = await get(
      await start({
        audio: {
          voices: [
            { voice_id: 'with', name: 'With' },
            { voice_id: 'without', name: 'Without', preview: false }
          ]
        }
      }),
      '/api/audio/elevenlabs/voices'
    )

    expect(body.voices.map((voice: { voice_id: string; preview: boolean }) => [voice.voice_id, voice.preview])).toEqual(
      [
        ['with', true],
        ['without', false]
      ]
    )
  })

  it('says unavailable with no key', async () => {
    const { body } = await get(await start({ audio: { elevenLabsKey: false } }), '/api/audio/elevenlabs/voices')

    expect(body).toEqual({ available: false, voices: [] })
  })
})

describe('speak', () => {
  it('answers a data URL of a tiny clip', async () => {
    const gateway = await start()
    const { status, body } = await post(gateway, '/api/audio/speak?profile=researcher', { text: 'Hello there.' })

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.mime_type).toBe('audio/wav')
    expect(body.provider).toBe('edge')

    const bytes = Buffer.from(String(body.data_url).split(',')[1] as string, 'base64')

    expect(bytes.subarray(0, 4).toString()).toBe('RIFF')
    expect(bytes.subarray(8, 12).toString()).toBe('WAVE')
    expect(gateway.state.audioRequests).toEqual([
      { kind: 'speak', text: 'Hello there.', voice: null, profile: 'researcher' }
    ])
  })

  it('refuses a blank text', async () => {
    expect((await post(await start(), '/api/audio/speak', { text: '   ' })).status).toBe(400)
  })

  it('takes no voice, as the gateway ships: the field is ignored', async () => {
    const gateway = await start()

    await post(gateway, '/api/audio/speak', { text: 'Hi.', voice: 'voice-adam' })

    expect(gateway.state.audioRequests[0]?.voice).toBeNull()
  })

  it('takes the voice on a gateway that offers it', async () => {
    const gateway = await start({ audio: { voiceSelection: true } })

    await post(gateway, '/api/audio/speak', { text: 'Hi.', voice: 'voice-adam' })

    expect(gateway.state.audioRequests[0]?.voice).toBe('voice-adam')
  })

  it('can refuse a voice with a 400 whose detail is {code, message}', async () => {
    const gateway = await start({
      audio: { voiceSelection: true, speakError: { code: 'unknown_voice', message: 'No such voice' } }
    })
    const { status, body } = await post(gateway, '/api/audio/speak', { text: 'Hi.', voice: 'nope' })

    expect(status).toBe(400)
    expect(body.detail).toEqual({ code: 'unknown_voice', message: 'No such voice' })
  })

  it('can fail like a provider that failed', async () => {
    expect((await post(await start({ audio: { speakStatus: 500 } }), '/api/audio/speak', { text: 'Hi.' })).status).toBe(
      500
    )
  })
})

describe('speak-stream', () => {
  it('sends start, the PCM in binary frames and end', async () => {
    const gateway = await start()
    const { events } = await session(
      gateway,
      [{ text: 'One sentence. ' }, { text: 'And another.', done: true }],
      '?profile=writer'
    )

    expect(events[0]).toEqual({ type: 'start', sample_rate: 24000, channels: 1 })
    expect(events.slice(1, 4)).toEqual([4800, 4800, 4800])
    expect(events[4]).toEqual({ type: 'end' })
    expect(gateway.state.audioRequests).toEqual([
      { kind: 'stream', text: 'One sentence. And another.', voice: null, profile: 'writer' }
    ])
  })

  it('answers fallback when the provider has no chunked API', async () => {
    const { events } = await session(await start({ audio: { stream: false } }), [{ text: 'Hi.', done: true }])

    expect(events).toEqual([{ type: 'fallback' }])
  })

  it('can refuse the voice with an error frame and close, with no audio', async () => {
    const gateway = await start({
      audio: { voiceSelection: true, streamError: { code: 'unknown_voice', message: 'No such voice' } }
    })
    const { events, closeCode } = await session(gateway, [{ text: 'Hi.', voice: 'nope', done: true }])

    expect(events).toEqual([{ type: 'error', code: 'unknown_voice', message: 'No such voice' }])
    expect(closeCode).toBe(1005)
    expect(gateway.state.audioRequests).toEqual([{ kind: 'stream', text: 'Hi.', voice: 'nope', profile: null }])
  })

  it('counts a stop in the middle as a barge-in', async () => {
    const gateway = await start({ audio: { chunkDelayMs: 100 } })

    await session(gateway, [{ text: 'A long sentence.', done: true }], '', { stopAfterFirstBinary: true })

    // The client sees the close before the server has finished with its own end of it.
    await vi.waitFor(() => expect(gateway.state.audioStreamsCancelled).toBe(1))
  })

  it('refuses a socket with no credential on a gated gateway, and takes a ticket on the query', async () => {
    const options: FakeAudioOptions = {}
    const gateway = await start({ auth: 'native', audio: options })

    expect((await session(gateway, [{ text: 'Hi.', done: true }])).closeCode).toBe(4401)

    const minted = await fetch(`${gateway.url}/api/auth/ws-ticket`, { method: 'POST', headers: nativeHeaders(gateway) })
    const { ticket } = (await minted.json()) as { ticket: string }
    const { events } = await session(gateway, [{ text: 'Hi.', done: true }], `?ticket=${encodeURIComponent(ticket)}`)

    expect(events[events.length - 1]).toEqual({ type: 'end' })
  })
})

/** What a native-PKCE gateway wants on a REST call: a bearer minted by its own token endpoint. */
const nativeHeaders = (gateway: FakeGateway): Record<string, string> => {
  const token = [...gateway.state.accessTokens][0] ?? mintAccessToken(gateway)

  return { authorization: `Bearer ${token}` }
}

const mintAccessToken = (gateway: FakeGateway): string => {
  const token = `test-access-${gateway.state.accessTokens.size + 1}`
  gateway.state.accessTokens.add(token)

  return token
}
