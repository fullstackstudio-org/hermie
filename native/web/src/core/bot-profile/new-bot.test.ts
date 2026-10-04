/**
 * The New bot page's model: the handle's rules (a transcription of upstream's), the params `profiles.create`
 * takes, and the order of what happens after it (create, read the roster, check the bot is listed).
 */
import { describe, expect, it, vi } from 'vitest'

import {
  checkProfileName,
  createBot,
  createParamsFor,
  EMPTY_NEW_BOT_DRAFT,
  loadModelChoices,
  NewBotFailure,
  normalizeProfileName,
  suggestProfileName
} from './new-bot'

describe('the handle', () => {
  it('is lowered and trimmed, as upstream normalises it', () => {
    expect(normalizeProfileName('  Scout ')).toBe('scout')
    expect(normalizeProfileName('DEFAULT')).toBe('default')
  })

  it('accepts a legal name and says nothing about it', () => {
    expect(checkProfileName('Scout-2')).toEqual({ handle: 'scout-2', ok: true, problem: null, warning: null })
    expect(checkProfileName('a_b-9').ok).toBe(true)
    expect(checkProfileName('x'.repeat(64)).ok).toBe(true)
  })

  it('asks for a handle when nothing was typed', () => {
    expect(checkProfileName('   ').problem).toEqual({ kind: 'empty' })
  })

  it('refuses the built-in bot with its own reason, before the reserved list can say it', () => {
    expect(checkProfileName('Default').problem).toEqual({ kind: 'default' })
  })

  it('refuses what the directory name cannot be, and suggests one that can', () => {
    expect(checkProfileName('My Work').problem).toEqual({ kind: 'invalid', suggestion: 'my-work' })
    expect(checkProfileName('-lead').problem).toEqual({ kind: 'invalid', suggestion: 'lead' })
    expect(checkProfileName('x'.repeat(65)).ok).toBe(false)
    expect(checkProfileName('Ünï').problem).toMatchObject({ kind: 'invalid' })
  })

  it('suggests a stand-in when nothing of what was typed is usable', () => {
    expect(suggestProfileName('!!!')).toBe('my-work')
    expect(suggestProfileName('Hello World!')).toBe('hello-world')
  })

  it.each(['hermes', 'test', 'tmp', 'root', 'sudo'])('refuses %s as reserved', name => {
    expect(checkProfileName(name).problem).toEqual({ kind: 'reserved', name })
  })

  it('refuses a name the roster already holds, whatever its case', () => {
    expect(checkProfileName('Writer', ['writer', 'researcher']).problem).toEqual({ kind: 'taken', name: 'writer' })
  })

  it('warns, and does not refuse, a name that is also a hermes subcommand', () => {
    expect(checkProfileName('cron')).toMatchObject({ ok: true, warning: { kind: 'subcommand', name: 'cron' } })
  })
})

describe('the params', () => {
  it('sends only the handle for an empty draft', () => {
    expect(createParamsFor({ ...EMPTY_NEW_BOT_DRAFT, handle: 'scout' })).toEqual({ name: 'scout' })
  })

  it('sends the model and the provider together, or neither', () => {
    expect(createParamsFor({ ...EMPTY_NEW_BOT_DRAFT, handle: 'a', model: 'p/m', provider: 'p' })).toEqual({
      name: 'a',
      model: 'p/m',
      provider: 'p'
    })
    expect(createParamsFor({ ...EMPTY_NEW_BOT_DRAFT, handle: 'a', model: 'p/m' })).toEqual({ name: 'a' })
    expect(createParamsFor({ ...EMPTY_NEW_BOT_DRAFT, handle: 'a', provider: 'p' })).toEqual({ name: 'a' })
  })

  it('trims the description, drops an empty one, and names the source of a clone', () => {
    expect(createParamsFor({ ...EMPTY_NEW_BOT_DRAFT, handle: 'a', description: '  Looks ahead.  ' })).toEqual({
      name: 'a',
      description: 'Looks ahead.'
    })
    expect(createParamsFor({ ...EMPTY_NEW_BOT_DRAFT, handle: 'a', description: ' ' })).toEqual({ name: 'a' })
    expect(createParamsFor({ ...EMPTY_NEW_BOT_DRAFT, handle: 'b', cloneFrom: 'writer' })).toEqual({
      name: 'b',
      clone_from: 'writer'
    })
  })

  it('never names mirror_credentials: upstream defaults it to true and a bot without it has no provider', () => {
    expect('mirror_credentials' in createParamsFor({ ...EMPTY_NEW_BOT_DRAFT, handle: 'a' })).toBe(false)
  })
})

describe('creating', () => {
  const answer = { ok: true, name: 'scout', path: '/p/scout', model_set: false, mirrored: { model_inherited: true } }

  it('creates, reads the roster and reports the stored name', async () => {
    const order: string[] = []
    const request = vi.fn(async () => {
      order.push('create')

      return answer
    })
    const refreshRoster = vi.fn(async () => {
      order.push('refresh')
    })

    const made = await createBot(
      { gateway: { request: request as never }, refreshRoster },
      { ...EMPTY_NEW_BOT_DRAFT, handle: 'scout' },
      name => name === 'scout'
    )

    expect(made).toEqual({ name: 'scout', withoutModel: false })
    expect(order).toEqual(['create', 'refresh'])
    expect(request).toHaveBeenCalledWith('profiles.create', { name: 'scout' })
  })

  it('looks the bot up by the name the gateway stored, not by what was typed', async () => {
    const request = vi.fn(async () => ({ ...answer, name: 'stored' }))
    const listed = vi.fn(() => true)

    const made = await createBot(
      { gateway: { request: request as never }, refreshRoster: async () => undefined },
      { ...EMPTY_NEW_BOT_DRAFT, handle: 'typed' },
      listed
    )

    expect(made.name).toBe('stored')
    expect(listed).toHaveBeenCalledWith('stored')
  })

  it('says a bot has no model when the gateway pinned none and inherited none', async () => {
    const request = vi.fn(async () => ({ ...answer, model_set: false, mirrored: {} }))

    const made = await createBot(
      { gateway: { request: request as never }, refreshRoster: async () => undefined },
      { ...EMPTY_NEW_BOT_DRAFT, handle: 'scout' },
      () => true
    )

    expect(made.withoutModel).toBe(true)
  })

  it('does not count a pinned model as missing', async () => {
    const request = vi.fn(async () => ({ ...answer, model_set: true, mirrored: {} }))

    const made = await createBot(
      { gateway: { request: request as never }, refreshRoster: async () => undefined },
      { ...EMPTY_NEW_BOT_DRAFT, handle: 'scout' },
      () => true
    )

    expect(made.withoutModel).toBe(false)
  })

  it('throws the gateway’s refusal as a refusal, without reading the roster', async () => {
    const refreshRoster = vi.fn()
    const request = vi.fn(async () => {
      throw Object.assign(new Error("Profile 'scout' already exists"), { code: 4062 })
    })

    const failure = await createBot(
      { gateway: { request: request as never }, refreshRoster },
      { ...EMPTY_NEW_BOT_DRAFT, handle: 'scout' },
      () => true
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(NewBotFailure)
    expect(failure).toMatchObject({ kind: 'refused', detail: "Profile 'scout' already exists" })
    expect(refreshRoster).not.toHaveBeenCalled()
  })

  it('throws not_listed when the bot was made and the roster does not show it', async () => {
    const failure = await createBot(
      { gateway: { request: (async () => answer) as never }, refreshRoster: async () => undefined },
      { ...EMPTY_NEW_BOT_DRAFT, handle: 'scout' },
      () => false
    ).catch((error: unknown) => error)

    expect(failure).toMatchObject({ kind: 'not_listed', detail: 'scout' })
  })

  it('carries on when the roster read fails: the listing check decides', async () => {
    const made = await createBot(
      {
        gateway: { request: (async () => answer) as never },
        refreshRoster: () => Promise.reject(new Error('offline'))
      },
      { ...EMPTY_NEW_BOT_DRAFT, handle: 'scout' },
      () => true
    )

    expect(made.name).toBe('scout')
  })
})

describe('the models on offer', () => {
  it('lists every provider’s models as the pair a create takes, asking for configured providers only', async () => {
    const request = vi.fn(async () => ({
      providers: [
        { slug: 'p1', name: 'Provider One', models: ['m1', 'p1/already'] },
        { slug: 'p2', name: '', models: ['m2'] },
        { slug: 'p3', name: 'No models' }
      ]
    }))

    const choices = await loadModelChoices({ request: request as never })

    expect(request).toHaveBeenCalledWith('model.options', { explicit_only: true })
    expect(choices.map(choice => [choice.model, choice.provider, choice.providerName])).toEqual([
      ['p1/m1', 'p1', 'Provider One'],
      ['p1/already', 'p1', 'Provider One'],
      ['p2/m2', 'p2', 'p2']
    ])
  })

  it('offers nothing, rather than an error, when the gateway cannot say', async () => {
    expect(await loadModelChoices({ request: (() => Promise.reject(new Error('nope'))) as never })).toEqual([])
  })
})
