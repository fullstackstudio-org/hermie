/**
 * The handle rules, against the cases upstream's own validator distinguishes.
 *
 * Each block names the upstream rule it stands for. The ones worth reading
 * twice are `default` (legal id, refused create, and the only name normalised
 * case-insensitively) and the subcommand collision (a warning, never a
 * refusal) — both are places where the obvious implementation is wrong in a way
 * no round trip would reveal until a bot had already been made or a legal name
 * had already been rejected.
 */
import { checkProfileName, normalizeProfileName, suggestProfileName } from '../src/features/profiles/profile-name'

describe('normalizeProfileName — hermes_cli/profiles.py::normalize_profile_name', () => {
  it('strips and lower-cases, because the directory name is the id', () => {
    expect(normalizeProfileName('  Scout  ')).toBe('scout')
    expect(normalizeProfileName('RESEARCHER')).toBe('researcher')
  })

  it('matches `default` case-insensitively, which is the one name that gets that', () => {
    expect(normalizeProfileName('Default')).toBe('default')
    expect(normalizeProfileName('DEFAULT')).toBe('default')
  })

  it('answers empty for whitespace, so the caller can say so rather than send it', () => {
    expect(normalizeProfileName('   ')).toBe('')
  })
})

describe('checkProfileName — PROFILE_ID_RE', () => {
  it('accepts the shapes the pattern allows', () => {
    for (const name of ['scout', 'a', 'bot-2', 'bot_2', '9lives', 'a'.repeat(64)]) {
      expect(checkProfileName(name).ok).toBe(true)
    }
  })

  it('refuses what it does not: spaces, punctuation, a leading separator, 65 characters', () => {
    for (const name of ['my bot', 'bot!', 'bot.two', '-bot', '_bot', 'a'.repeat(65)]) {
      expect(checkProfileName(name).ok).toBe(false)
    }
  })

  /**
   * Upstream lower-cases at the ingress point and validates strictly, so a
   * title-cased name is VALID once normalised. A client that ran the regex over
   * the raw input would reject `Scout`, which the gateway accepts.
   */
  it('accepts a title-cased name by normalising it first', () => {
    const verdict = checkProfileName('Scout')

    expect(verdict.ok).toBe(true)
    expect(verdict.handle).toBe('scout')
  })

  it('ends the message with a name the reader could accept instead', () => {
    expect(checkProfileName('My Work').error).toContain('my-work')
  })
})

describe('checkProfileName — reserved names', () => {
  it('refuses the five that collide with Hermes or a system binary', () => {
    for (const name of ['hermes', 'test', 'tmp', 'root', 'sudo']) {
      expect(checkProfileName(name)).toMatchObject({ ok: false, error: expect.stringContaining('reserved') })
    }
  })

  /**
   * `default` is in `_RESERVED_NAMES` and yet `validate_profile_name` returns
   * early for it, so it never reaches the reserved branch. `create_profile`
   * refuses it separately, and says something else: it is the built-in profile
   * at `~/.hermes`, not a name that collides with one.
   */
  it('refuses `default` as the built-in rather than as a reserved word', () => {
    const verdict = checkProfileName('Default')

    expect(verdict.ok).toBe(false)
    expect(verdict.error).toContain('built-in')
    expect(verdict.error).not.toContain('reserved')
  })
})

describe('checkProfileName — a name already on the roster', () => {
  it('says so inline instead of waiting for FileExistsError', () => {
    expect(checkProfileName('writer', ['researcher', 'writer'])).toMatchObject({
      ok: false,
      error: expect.stringContaining('already exists')
    })
  })

  it('compares the normalised handle, not what was typed', () => {
    expect(checkProfileName('Writer', ['writer']).ok).toBe(false)
  })
})

describe('checkProfileName — a hermes subcommand', () => {
  /**
   * The distinction this whole set exists for: `check_alias_collision` only
   * declines to write the wrapper script. `create_profile` does not consult it,
   * so the bot is created either way and refusing here would invent a rule.
   */
  it('lets the name through and warns about the shortcut it costs', () => {
    const verdict = checkProfileName('gateway')

    expect(verdict.ok).toBe(true)
    expect(verdict.error).toBeNull()
    expect(verdict.warning).toContain('hermes gateway')
  })

  it('leaves an ordinary name without a warning', () => {
    expect(checkProfileName('scout').warning).toBeNull()
  })
})

describe('suggestProfileName', () => {
  it('derives a legal id from prose', () => {
    expect(suggestProfileName('My Work')).toBe('my-work')
    expect(suggestProfileName('Ops & Alerts')).toBe('ops-alerts')
  })

  it('falls back when nothing usable is left', () => {
    expect(suggestProfileName('!!!')).toBe('my-work')
  })
})
