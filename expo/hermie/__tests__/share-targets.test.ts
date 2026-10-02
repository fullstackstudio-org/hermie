/**
 * The file that lets a share extension send: which session each bot is, and the
 * two sentences the sheet says.
 *
 * The mirror of `widget-snapshot.test.ts` and for the same reason — the real
 * reader is Swift, in a process this suite cannot start, so the only place the
 * format can be pinned is here. What is worth pinning is narrow and all of it is
 * about REFUSING to write something the extension would act on wrongly: a bot
 * with no resolved chat, a duplicate, a roster longer than the sheet can show.
 */
import {
  buildShareTargets,
  parseShareTargets,
  serialiseShareTargets,
  SHARE_TARGET_BOT_PLACEHOLDER,
  SHARE_TARGETS_LIMIT,
  SHARE_TARGETS_VERSION
} from '../src/features/share/targets'

const copy = { sent: `Sent to ${SHARE_TARGET_BOT_PLACEHOLDER}`, queued: 'Later', sending: 'Sending…' }

const build = (bots: { name: string; session: string }[], over: Record<string, unknown> = {}) =>
  buildShareTargets({ bots, copy, now: 1_700_000_000_000, ...over })

describe('what is written', () => {
  it('carries one target per bot with a resolved chat', () => {
    const targets = build([
      { name: 'ada', session: 's-ada' },
      { name: 'bo', session: 's-bo' }
    ])

    expect(targets.version).toBe(SHARE_TARGETS_VERSION)
    expect(targets.targets).toEqual([
      { bot: 'ada', session: 's-ada' },
      { bot: 'bo', session: 's-bo' }
    ])
  })

  /**
   * The whole safety argument of this file. A bot with no session id is a bot
   * whose chat the app has not resolved yet — and resolving it is three decisions
   * the extension must not make, the last of which mints a forever-chat that
   * cannot be un-minted. Leaving it out queues that share for the app, which is
   * one launch of latency instead.
   */
  it('leaves out a bot whose chat has not been resolved', () => {
    expect(build([{ name: 'ada', session: '' }]).targets).toEqual([])
    expect(build([{ name: '', session: 's' }]).targets).toEqual([])
  })

  it('writes one entry per bot even when the roster repeats one', () => {
    expect(
      build([
        { name: 'ada', session: 'first' },
        { name: 'ada', session: 'second' }
      ]).targets
    ).toEqual([{ bot: 'ada', session: 'first' }])
  })

  it('caps the list', () => {
    const bots = Array.from({ length: SHARE_TARGETS_LIMIT + 5 }, (_, index) => ({
      name: `bot-${index}`,
      session: `s-${index}`
    }))

    expect(build(bots).targets).toHaveLength(SHARE_TARGETS_LIMIT)
  })

  it('stores the moment in seconds, because every other file in this feature does', () => {
    expect(build([]).generatedAt).toBe(1_700_000_000)
  })

  /**
   * The key is what stops a session id from the previous gateway being resumed on
   * the current one. Absent rather than empty when the app has no address yet: an
   * empty string would compare unequal to every credential's key and quietly
   * disable the feature.
   */
  it('names the gateway only when there is one', () => {
    expect(build([], { gatewayKey: 'abc123' }).gatewayKey).toBe('abc123')
    expect('gatewayKey' in build([])).toBe(false)
  })

  it('carries the sentences the extension has no other way to obtain', () => {
    expect(build([]).copy).toEqual(copy)
  })
})

describe('what is read back', () => {
  it('survives a round trip', () => {
    const targets = build([{ name: 'ada', session: 's-ada' }], { gatewayKey: 'abc123' })

    expect(parseShareTargets(serialiseShareTargets(targets))).toEqual(targets)
  })

  it('refuses a version this build does not understand', () => {
    expect(parseShareTargets(JSON.stringify({ version: SHARE_TARGETS_VERSION + 1, targets: [] }))).toBeNull()
    expect(parseShareTargets('not json')).toBeNull()
  })

  it('drops a target that is missing either half', () => {
    const json = JSON.stringify({
      version: SHARE_TARGETS_VERSION,
      generatedAt: 1,
      copy,
      targets: [{ bot: 'ada' }, { session: 's' }, 'nonsense', { bot: 'bo', session: 's-bo' }]
    })

    expect(parseShareTargets(json)?.targets).toEqual([{ bot: 'bo', session: 's-bo' }])
  })
})
