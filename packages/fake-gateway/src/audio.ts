/**
 * The gateway's text-to-speech routes, as the fake serves them: `GET /api/audio/voice-config`,
 * `GET /api/audio/elevenlabs/voices`, `POST /api/audio/speak` and `WS /api/audio/speak-stream`
 * (`hermes_cli/web_routers/audio.py` and `tools/voice_client_config.py` of the fork).
 *
 * What is reproduced, because the app is built on it:
 *
 * - `voice-config` is the desktop's CLIENT-DIRECT config: for a provider a client could call itself
 *   (OpenAI, ElevenLabs, DeepInfra) it is `{"mode": "direct", "provider", "voice", …}` and carries
 *   the provider's API KEY; for every other provider (Edge, local engines) it is
 *   `{"mode": "relay", "reason": "provider 'edge' has no client wire"}` and the gateway speaks
 *   through `/api/audio/speak` itself. The fake sends a made-up key so a client that stored or
 *   showed it can be caught.
 * - `speak` answers `{ok, data_url, mime_type, provider}`; a missing text is a 400.
 * - `speak-stream` is one session per socket: text frames in (`{"text"}`, `{"done": true}`,
 *   `{"stop": true}`), `{"type": "start", "sample_rate", "channels"}` out with the first PCM frame,
 *   binary int16 little-endian PCM, then `{"type": "end"}`; `{"type": "fallback"}` when the provider
 *   has no chunked API. The route authenticates with `?ticket=` (or the subprotocol) or `?token=`.
 * - `elevenlabs/voices` answers `{available, voices: [{voice_id, name, label}]}` sorted by label, and
 *   `{available: false, voices: []}` with no key.
 *
 * What the gateway as shipped does NOT do, and so the fake does not unless asked
 * (`FakeAudioOptions.voiceSelection`): take a voice with a request. `TTSSpeakRequest` is `{text}`.
 */

export type FakeAudioProvider = 'edge' | 'elevenlabs' | 'openai'

export interface FakeAudioVoice {
  voice_id: string
  name: string
  category?: string
}

export interface FakeAudioOptions {
  /** The provider the text-to-speech chain is set to (default `edge`, which only the relay serves). */
  provider?: FakeAudioProvider
  /**
   * A gateway newer than the fork as shipped: `voice-config` says `voice_selection: true`, and `speak`
   * and the stream take a `voice` and speak it. Default false, the gateway as shipped.
   */
  voiceSelection?: boolean
  /** Edge's voices, which `voice-config` lists next to `voice_selection` (`voices`). */
  edgeVoices?: { id: string; name: string; language: string }[]
  /** Serve `speak-stream` (default true). False answers `{"type": "fallback"}`, a provider with no chunked API. */
  stream?: boolean
  /** ElevenLabs' voices (default: two premade and one cloned). */
  voices?: FakeAudioVoice[]
  /** `false` has no ElevenLabs key: `{available: false}`. */
  elevenLabsKey?: boolean
  /** How long `speak` and the stream hold their answer, in ms (default 0): a slow provider. */
  delayMs?: number
  /** How long the stream waits between its frames, in ms (default 5). */
  chunkDelayMs?: number
  /** Answer `speak` with this status instead of audio (a provider that failed). */
  speakStatus?: number
}

/** What a client asked of the audio routes, oldest first. */
export interface AudioRequest {
  kind: 'speak' | 'stream'
  text: string
  voice: string | null
  profile: string | null
}

export const DEFAULT_ELEVENLABS_VOICES: FakeAudioVoice[] = [
  { voice_id: 'voice-rachel', name: 'Rachel', category: 'premade' },
  { voice_id: 'voice-clone-1', name: 'My own voice', category: 'cloned' },
  { voice_id: 'voice-adam', name: 'Adam', category: 'premade' }
]

const FAKE_API_KEY = 'xi-fake-key-do-not-keep'

/** `_elevenlabs_voice_label`. */
const labelOf = (voice: FakeAudioVoice): string => (voice.category ? `${voice.name} (${voice.category})` : voice.name)

export const voiceConfigBody = (options: FakeAudioOptions): Record<string, unknown> => {
  const provider = options.provider ?? 'edge'
  const selection = options.voiceSelection === true
  const stt = { mode: 'relay', reason: 'local provider' }

  if (provider === 'elevenlabs') {
    return {
      ok: true,
      stt,
      tts: {
        mode: 'direct',
        wire: 'elevenlabs-tts',
        provider,
        base_url: 'https://api.elevenlabs.io/v1',
        api_key: FAKE_API_KEY,
        model: 'eleven_multilingual_v2',
        voice: 'voice-rachel',
        speed: null,
        min_len: 20,
        ...(selection ? { voice_selection: true } : {})
      }
    }
  }

  if (provider === 'openai') {
    return {
      ok: true,
      stt,
      tts: {
        mode: 'direct',
        wire: 'openai-speech',
        provider,
        base_url: 'https://api.openai.com/v1',
        api_key: FAKE_API_KEY,
        model: 'gpt-4o-mini-tts',
        voice: 'alloy',
        speed: 1,
        min_len: 20
      }
    }
  }

  return {
    ok: true,
    stt,
    tts: {
      mode: 'relay',
      reason: "provider 'edge' has no client wire",
      ...(selection ? { voice_selection: true, voices: options.edgeVoices ?? [] } : {})
    }
  }
}

export const elevenLabsVoicesBody = (options: FakeAudioOptions): Record<string, unknown> => {
  if (options.elevenLabsKey === false) {
    return { available: false, voices: [] }
  }

  const voices = (options.voices ?? DEFAULT_ELEVENLABS_VOICES).map(voice => ({
    voice_id: voice.voice_id,
    name: voice.name,
    label: labelOf(voice)
  }))

  voices.sort((left, right) => left.label.toLowerCase().localeCompare(right.label.toLowerCase()))

  return { available: true, voices }
}

/** A 16-bit mono WAV of a short sine: the tiny clip every answer carries. */
export const wavClip = (frames = 1600, sampleRate = 16000, frequency = 440): Buffer => {
  const data = Buffer.alloc(frames * 2)

  for (let index = 0; index < frames; index += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 8000), index * 2)
  }

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)

  return Buffer.concat([header, data])
}

/** The sine's raw PCM (what the stream sends), `frames` int16 samples. */
export const pcmClip = (frames: number, sampleRate: number, frequency = 440): Buffer => {
  const data = Buffer.alloc(frames * 2)

  for (let index = 0; index < frames; index += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 8000), index * 2)
  }

  return data
}

/** `POST /api/audio/speak`'s answer. */
export const speakBody = (options: FakeAudioOptions): Record<string, unknown> => ({
  ok: true,
  data_url: `data:audio/wav;base64,${wavClip().toString('base64')}`,
  mime_type: 'audio/wav',
  provider: options.provider ?? 'edge'
})

/** The sample rate of the stream's PCM. */
export const STREAM_SAMPLE_RATE = 24000

/** How many frames of PCM each binary message carries, and how many messages a sentence is. */
export const STREAM_CHUNK_FRAMES = 2400
export const STREAM_CHUNKS = 3
