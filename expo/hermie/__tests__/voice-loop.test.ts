/**
 * The hands-free loop, with every side of it faked.
 *
 * Fake timers throughout, because two of the four rules this machine exists to
 * enforce are timers — the silence that ends an utterance and the second the
 * transcript is shown before it goes — and a suite that waited for them in real
 * time would be three seconds long and flaky.
 */
import { SILENCE_MS, VOICE_IDLE, VoiceLoop, type VoicePhase } from '../src/features/voice/voice-loop'
import type { RecognitionEngine, RecognitionRequest } from '../src/platform/platform-contracts'

function harness(over: { confirm?: boolean } = {}) {
  let request: RecognitionRequest | null = null
  const sent: string[] = []
  const spoken: string[] = []
  const phases: VoicePhase[] = []
  let finishSpeaking: (() => void) | null = null
  let accept: (() => void) | null = null
  let stopSpeakingCalls = 0
  let aborts = 0
  let starts = 0
  const listening: boolean[] = []

  const engine: RecognitionEngine = {
    available: true,
    async requestPermission() {
      return 'granted'
    },
    async supportedLanguages() {
      return []
    },
    start(next) {
      starts += 1
      request = next
    },
    stop() {
      // The real seam asks for a final result; the fake leaves that to the test,
      // because the two orderings (a final, or a bare `end`) are both real.
    },
    abort() {
      aborts += 1
      request = null
    }
  }

  const loop = new VoiceLoop({
    engine,
    confirm: over.confirm ?? true,
    onChange: state => phases.push(state.phase),
    onListeningChange: value => listening.push(value),
    send: text => {
      sent.push(text)

      return new Promise<void>(resolve => {
        accept = resolve
      })
    },
    speak: (text, done) => {
      spoken.push(text)
      finishSpeaking = done
    },
    stopSpeaking: () => {
      stopSpeakingCalls += 1
    }
  })

  return {
    loop,
    sent,
    spoken,
    phases,
    listening,
    get aborts() {
      return aborts
    },
    get starts() {
      return starts
    },
    get stopSpeakingCalls() {
      return stopSpeakingCalls
    },
    hear: (text: string) => request?.onPartial?.(text),
    final: (text: string) => request?.onFinal?.(text),
    ended: () => request?.onEnd?.(),
    failed: (failure: Parameters<NonNullable<RecognitionRequest['onError']>>[0]) => request?.onError?.(failure),
    volume: (level: number) => request?.onVolume?.(level),
    /** The chat accepting the turn. */
    accepted: async () => {
      accept?.()
      await Promise.resolve()
    },
    /** The speaker finishing the reply. */
    finished: () => finishSpeaking?.()
  }
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

describe('the loop', () => {
  it('starts by listening, and says so', () => {
    const h = harness()

    expect(h.loop.snapshot).toEqual(VOICE_IDLE)

    h.loop.start()

    expect(h.loop.snapshot.phase).toBe('listening')
    expect(h.listening).toEqual([true])
  })

  it('goes all the way round: heard, confirmed, sent, answered, spoken, listening again', async () => {
    const h = harness()

    h.loop.start()
    h.hear('what is the plan')
    h.final('what is the plan')

    expect(h.loop.snapshot).toMatchObject({ phase: 'confirming', transcript: 'what is the plan' })

    jest.advanceTimersByTime(1000)

    expect(h.sent).toEqual(['what is the plan'])
    expect(h.loop.snapshot.phase).toBe('sending')

    await h.accepted()

    expect(h.loop.snapshot.phase).toBe('waiting')

    h.loop.replied('Here it is.')

    expect(h.spoken).toEqual(['Here it is.'])
    expect(h.loop.snapshot.phase).toBe('speaking')

    h.finished()

    expect(h.loop.snapshot.phase).toBe('listening')
  })

  it('never sends an empty transcript', () => {
    const h = harness()

    h.loop.start()
    h.final('   ')
    jest.advanceTimersByTime(5000)

    expect(h.sent).toEqual([])
    // Round again rather than stopping: a throat cleared is not a message and
    // is not a reason to leave voice mode either.
    expect(h.loop.snapshot.phase).toBe('listening')
    expect(h.starts).toBe(2)
  })

  it('ends the utterance on silence when the recognizer volunteers no final', () => {
    const h = harness({ confirm: false })

    h.loop.start()
    h.hear('send it')
    jest.advanceTimersByTime(SILENCE_MS)
    // The seam asked for a final and the session simply closed, which is what
    // some recognizers do. What was heard IS the utterance.
    h.ended()

    expect(h.sent).toEqual(['send it'])
  })

  it('does not arm the silence timer before anything has been heard', () => {
    const h = harness({ confirm: false })

    h.loop.start()
    jest.advanceTimersByTime(SILENCE_MS * 3)
    h.ended()

    // A reader who takes five seconds to begin must not have been cut off, and
    // the empty session goes round again rather than sending nothing.
    expect(h.sent).toEqual([])
    expect(h.loop.snapshot.phase).toBe('listening')
  })

  it('restarts the silence timer on every new thing heard', () => {
    const h = harness({ confirm: false })

    h.loop.start()
    h.hear('one')
    jest.advanceTimersByTime(SILENCE_MS - 1)
    h.hear('one two')
    jest.advanceTimersByTime(SILENCE_MS - 1)

    expect(h.loop.snapshot.phase).toBe('listening')

    jest.advanceTimersByTime(1)
    h.ended()

    expect(h.sent).toEqual(['one two'])
  })

  it('sends straight away when the confirmation is switched off', () => {
    const h = harness({ confirm: false })

    h.loop.start()
    h.final('go')

    expect(h.sent).toEqual(['go'])
  })

  it('lets the reader take it back during the confirmation', () => {
    const h = harness()

    h.loop.start()
    h.final('cancel this one')
    h.loop.cancel()
    jest.advanceTimersByTime(5000)

    expect(h.sent).toEqual([])
    expect(h.loop.snapshot.phase).toBe('listening')
  })

  it('interrupts the reply and listens again', async () => {
    const h = harness({ confirm: false })

    h.loop.start()
    h.final('go')
    // The turn has to be ACCEPTED before there is a turn to answer: `replied`
    // is ignored while the send is still in the air, which is what keeps a
    // stray reply from being read as the answer to a message not yet on the
    // conversation.
    await h.accepted()
    h.loop.replied('A very long answer.')
    h.loop.interrupt()

    expect(h.stopSpeakingCalls).toBe(1)
    expect(h.loop.snapshot.phase).toBe('listening')

    // The speaker calling back after it was cut must not start a second round.
    const starts = h.starts

    h.finished()

    expect(h.starts).toBe(starts)
  })

  it('does nothing when a tap lands in any phase but speaking', () => {
    const h = harness()

    h.loop.start()
    h.loop.interrupt()

    // A tap that stopped the microphone would make the ring a button whose
    // meaning changes under the finger.
    expect(h.loop.snapshot.phase).toBe('listening')
    expect(h.stopSpeakingCalls).toBe(0)
  })

  it('listens again rather than stalling when a turn produced no words', async () => {
    const h = harness({ confirm: false })

    h.loop.start()
    h.final('go')
    await h.accepted()
    h.loop.replied('   ')

    expect(h.spoken).toEqual([])
    expect(h.loop.snapshot.phase).toBe('listening')
  })

  it('treats a silence with nothing in it as a pause, not a failure', () => {
    const h = harness()

    h.loop.start()
    h.failed('no-speech')

    // Stopping the whole mode because somebody paused to think would make it
    // unusable; everything else does stop, so a broken recognizer cannot spin.
    expect(h.loop.snapshot.phase).toBe('listening')
  })

  it('stops on any other failure', () => {
    const h = harness()

    h.loop.start()
    h.failed('audio-capture' as never)

    expect(h.loop.snapshot).toMatchObject({ phase: 'error' })
    expect(h.listening).toEqual([true, false])
  })

  it('leaves from any phase, closing the microphone and the speaker', () => {
    const h = harness({ confirm: false })

    h.loop.start()
    h.final('go')
    h.loop.replied('Talking.')
    h.loop.leave()

    expect(h.aborts).toBe(1)
    expect(h.stopSpeakingCalls).toBe(1)
    expect(h.loop.snapshot).toEqual(VOICE_IDLE)
  })

  it('ignores everything from the session it left', async () => {
    const h = harness()

    h.loop.start()
    h.loop.leave()
    h.final('said after leaving')
    jest.advanceTimersByTime(5000)

    expect(h.sent).toEqual([])
    expect(h.loop.snapshot).toEqual(VOICE_IDLE)
  })

  it('ignores a reply for a turn it is no longer waiting on', () => {
    const h = harness({ confirm: false })

    h.loop.start()
    h.loop.replied('an answer to nothing')

    expect(h.spoken).toEqual([])
  })

  it('follows the input level while listening', () => {
    const h = harness()

    h.loop.start()
    h.volume(0.4)

    expect(h.loop.snapshot.level).toBeCloseTo(0.4)
  })

  it('stops rather than retrying when the send itself fails', async () => {
    const failing = new VoiceLoop({
      engine: {
        available: true,
        async requestPermission() {
          return 'granted'
        },
        async supportedLanguages() {
          return []
        },
        start(request) {
          // Answer immediately so the test does not need a handle on it.
          request.onFinal?.('go')
        },
        stop() {},
        abort() {}
      },
      confirm: false,
      send: async () => {
        throw new Error('no gateway')
      },
      speak: (_text, done) => done(),
      stopSpeaking: () => undefined
    })

    failing.start()
    await Promise.resolve()
    await Promise.resolve()

    // The reader can see the overlay and decide. A loop that retried a send
    // nobody can make would talk to itself.
    expect(failing.snapshot.phase).toBe('error')
  })
})
