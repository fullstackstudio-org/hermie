/**
 * Searching the bots' transcripts: the fan-out, and the hits it refuses.
 *
 * Everything here follows from one property of `GET /api/sessions/search`: it
 * searches ONE profile, so this is N requests and each of them can fail on its
 * own. The cases are mostly about what happens to the other N-1 when one does.
 */
import { hitIsCanonical, orderMatches, searchBotChats } from '../src/features/search'
import type { Bot } from '../src/store/bots'

const bot = (name: string, id = `stored-${name}`): Bot => ({
  name,
  displayName: name,
  description: '',
  model: 'm',
  provider: 'p',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: { id, resolvedId: id, preview: '', lastActive: 0, messageCount: 0 }
})

/** An http seam that answers per profile, and records who was asked. */
function gateway(answers: Record<string, unknown>) {
  const asked: string[] = []

  return {
    asked,
    http: {
      get: (async (path: string) => {
        const profile = new URL(path, 'http://x').searchParams.get('profile') ?? ''

        asked.push(profile)

        const answer = answers[profile]

        if (answer instanceof Error) {
          throw answer
        }

        return answer ?? { results: [] }
      }) as <T>(path: string) => Promise<T>
    }
  }
}

const hit = (sessionId: string, patch: Record<string, unknown> = {}) => ({
  results: [{ session_id: sessionId, snippet: '>>>invoice<<< again', last_active: 100, ...patch }]
})

describe('searchBotChats', () => {
  it('asks every bot, because the route searches one profile at a time', async () => {
    const seam = gateway({ researcher: hit('stored-researcher'), writer: hit('stored-writer') })

    const matches = await searchBotChats({
      bots: [bot('researcher'), bot('writer')],
      http: seam.http,
      query: 'invoice'
    })

    expect(seam.asked.sort()).toEqual(['researcher', 'writer'])
    expect(matches.map(match => match.bot).sort()).toEqual(['researcher', 'writer'])
  })

  it('keeps the other bots when one profile fails', async () => {
    // A 404 for a profile that was renamed under us is one missing row. It is
    // not a reason to show an empty search.
    const seam = gateway({ researcher: new Error('HTTP 404'), writer: hit('stored-writer') })

    const matches = await searchBotChats({
      bots: [bot('researcher'), bot('writer')],
      http: seam.http,
      query: 'invoice'
    })

    expect(matches.map(match => match.bot)).toEqual(['writer'])
  })

  it('drops a hit that is not this bot’s forever-chat', async () => {
    // A profile holds sessions Hermie does not show — a cron run, a CLI
    // session. Opening the Bot Chat on the strength of one would land the
    // reader in a conversation that does not contain what they searched for.
    const seam = gateway({ researcher: hit('cron_job-nightly_1789') })

    expect(await searchBotChats({ bots: [bot('researcher')], http: seam.http, query: 'invoice' })).toEqual([])
  })

  it('takes a hit found through its compression root', async () => {
    const seam = gateway({
      researcher: hit('stored-researcher-tip', { lineage_root: 'stored-researcher' })
    })

    const matches = await searchBotChats({ bots: [bot('researcher')], http: seam.http, query: 'invoice' })

    expect(matches[0]?.sessionId).toBe('stored-researcher-tip')
  })

  it('asks nobody for a blank query', async () => {
    const seam = gateway({})

    expect(await searchBotChats({ bots: [bot('researcher')], http: seam.http, query: '   ' })).toEqual([])
    expect(seam.asked).toEqual([])
  })

  it('answers nothing once the query it was started for has been abandoned', async () => {
    const seam = gateway({ researcher: hit('stored-researcher') })
    const controller = new AbortController()
    const running = searchBotChats({
      bots: [bot('researcher')],
      http: seam.http,
      query: 'invoice',
      signal: controller.signal
    })

    controller.abort()

    // Not a rejection: the only caller is a field somebody is still typing in,
    // and a superseded query is not an error anybody wants to read about.
    expect(await running).toEqual([])
  })
})

describe('the order', () => {
  it('is newest first, then by name so two equal stamps never flap', () => {
    expect(
      orderMatches([
        { bot: 'writer', sessionId: 'w', snippet: '', at: 10 },
        { bot: 'researcher', sessionId: 'r', snippet: '', at: 10 },
        { bot: 'builder', sessionId: 'b', snippet: '', at: 40 }
      ]).map(match => match.bot)
    ).toEqual(['builder', 'researcher', 'writer'])
  })
})

describe('hitIsCanonical', () => {
  it('accepts either id the roster knows the chat under', () => {
    const subject = bot('researcher')

    subject.canonical = { id: 'stored', resolvedId: 'tip', preview: '', lastActive: 0, messageCount: 0 }

    expect(hitIsCanonical(subject, { sessionId: 'stored', snippet: '', archived: false })).toBe(true)
    expect(hitIsCanonical(subject, { sessionId: 'tip', snippet: '', archived: false })).toBe(true)
    expect(hitIsCanonical(subject, { sessionId: 'other', snippet: '', archived: false })).toBe(false)
  })

  it('refuses everything for a bot whose chat has not been resolved yet', () => {
    const subject = bot('researcher')

    delete subject.canonical

    expect(hitIsCanonical(subject, { sessionId: 'stored-researcher', snippet: '', archived: false })).toBe(false)
  })
})
