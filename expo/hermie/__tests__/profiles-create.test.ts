/**
 * Making a bot: the params that go out, and the order of what happens after.
 *
 * The ordering assertions are the ones worth keeping. `profiles.create` does
 * not mint a conversation, so the only thing between a new bot and a forked
 * chat is that the canonical session is resolved the ordinary way, AFTER the
 * roster has been re-read — and a controller that resolved against the typed
 * name, or before the refresh, would pass every test that only checked the
 * create call.
 */
import { FakeChatGateway } from './support/fake-chat-gateway'

import { createParamsFor, ProfilesController, type NewBotDraft } from '../src/features/profiles/profiles-controller'
import type { Bot } from '../src/store/bots'

const draft = (overrides: Partial<NewBotDraft> = {}): NewBotDraft => ({
  handle: 'scout',
  description: '',
  model: '',
  provider: '',
  cloneFrom: null,
  ...overrides
})

const botNamed = (name: string): Bot => ({
  name,
  displayName: name,
  description: '',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0
})

const createdReply = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ok: true,
  name: 'scout',
  path: '/root/.hermes/profiles/scout',
  soul_written: false,
  model_set: false,
  mirrored: { env: true, auth: true, model_inherited: true, voice: true },
  ...overrides
})

describe('createParamsFor', () => {
  it('sends the handle alone when nothing else was filled in', () => {
    expect(createParamsFor(draft())).toEqual({ name: 'scout' })
  })

  /**
   * `mirror_credentials` defaults to true upstream and a bare create leaves the
   * bot with no provider at all, so the safe thing is to say nothing. A test
   * that asserted `mirror_credentials: true` would look equivalent and would
   * lock in a parameter we deliberately do not send.
   */
  it('never names mirror_credentials, so upstream keeps its default', () => {
    expect(createParamsFor(draft())).not.toHaveProperty('mirror_credentials')
  })

  it('omits clone_from rather than sending null', () => {
    expect(createParamsFor(draft({ cloneFrom: null }))).not.toHaveProperty('clone_from')
    expect(createParamsFor(draft({ cloneFrom: 'writer' })).clone_from).toBe('writer')
  })

  /**
   * `_pin_profile_model` runs only `if model and provider`. One without the
   * other pins nothing, so sending a half pair is a silent no-op.
   */
  it('sends model and provider together or not at all', () => {
    expect(createParamsFor(draft({ model: 'a/b', provider: '' }))).not.toHaveProperty('model')
    expect(createParamsFor(draft({ model: '', provider: 'a' }))).not.toHaveProperty('provider')
    expect(createParamsFor(draft({ model: 'a/b', provider: 'a' }))).toMatchObject({ model: 'a/b', provider: 'a' })
  })

  it('drops a description that is only spaces', () => {
    expect(createParamsFor(draft({ description: '   ' }))).not.toHaveProperty('description')
  })
})

describe('ProfilesController.create', () => {
  const build = (
    gateway: FakeChatGateway,
    roster: Bot[]
  ): { controller: ProfilesController; order: string[]; resolved: string[] } => {
    const order: string[] = []
    const resolved: string[] = []
    const controller = new ProfilesController({
      gateway,
      refreshRoster: async () => {
        order.push('refresh')

        return roster
      },
      resolveCanonical: async bot => {
        order.push('resolve')
        resolved.push(bot.name)

        return { id: `session-${bot.name}` }
      }
    })

    return { controller, order, resolved }
  }

  it('creates, then refreshes the roster, then resolves the chat — in that order', async () => {
    const gateway = new FakeChatGateway().reply('profiles.create', createdReply())
    const { controller, order } = build(gateway, [botNamed('scout')])

    const created = await controller.create(draft())

    expect(gateway.methodOrder()).toEqual(['profiles.create'])
    expect(order).toEqual(['refresh', 'resolve'])
    expect(created.sessionId).toBe('session-scout')
  })

  /**
   * The gateway normalises the handle and answers the name it STORED. A
   * controller that resolved against what the form held would look up a
   * profile that does not exist, and the failure would only show on a bot whose
   * name needed normalising.
   */
  it('resolves against the name the gateway stored, not the one that was typed', async () => {
    const gateway = new FakeChatGateway().reply('profiles.create', createdReply({ name: 'scout' }))
    const { controller, resolved } = build(gateway, [botNamed('scout')])

    const created = await controller.create(draft({ handle: 'scout' }))

    expect(created.name).toBe('scout')
    expect(resolved).toEqual(['scout'])
  })

  it('never mints a session itself — resolveCanonical is the only path', async () => {
    const gateway = new FakeChatGateway().reply('profiles.create', createdReply())
    const { controller } = build(gateway, [botNamed('scout')])

    await controller.create(draft())

    expect(gateway.methodOrder()).not.toContain('session.create')
    expect(gateway.methodOrder()).not.toContain('session.list')
  })

  it('says so when the new bot has neither a pin nor an inherited model', async () => {
    const gateway = new FakeChatGateway().reply(
      'profiles.create',
      createdReply({ model_set: false, mirrored: { env: false, auth: false, model_inherited: false, voice: false } })
    )
    const { controller } = build(gateway, [botNamed('scout')])

    expect((await controller.create(draft())).withoutModel).toBe(true)
  })

  it('treats an inherited model as a model', async () => {
    const gateway = new FakeChatGateway().reply('profiles.create', createdReply())
    const { controller } = build(gateway, [botNamed('scout')])

    expect((await controller.create(draft())).withoutModel).toBe(false)
  })

  it('fails loudly when the roster does not show the bot the gateway just made', async () => {
    const gateway = new FakeChatGateway().reply('profiles.create', createdReply())
    const { controller } = build(gateway, [])

    await expect(controller.create(draft())).rejects.toThrow(/did not list it/)
  })

  it('lets the gateway’s refusal through rather than dressing it up', async () => {
    const gateway = new FakeChatGateway().reply('profiles.create', () => {
      throw new Error("Profile name 'sudo' is reserved")
    })
    const { controller, order } = build(gateway, [])

    await expect(controller.create(draft({ handle: 'sudo' }))).rejects.toThrow(/reserved/)
    // Nothing after the create ran, so no roster read and no session anywhere.
    expect(order).toEqual([])
  })
})
