/**
 * Skills: the category map, the inverted write, and the two-keyed hub.
 *
 * Three shapes here are traps rather than details, and each has a case of its
 * own: `skills.manage list` answers an OBJECT of arrays with no enabled flag,
 * `profiles.configure` takes the DISABLED list whole, and `search` and `browse`
 * answer under different keys with different fields.
 */
import { FakeChatGateway } from './support/fake-chat-gateway'

import {
  isUnknownAction,
  skillInstallCommand,
  SkillsController,
  skillRows,
  type InstalledSkill
} from '../src/features/skills/skills-controller'

const rows = (...entries: [string, boolean | null][]): InstalledSkill[] =>
  entries.map(([name, enabled]) => ({ name, category: 'installed', enabled }))

describe('skillRows', () => {
  /**
   * `get_available_skills()` answers `{category: [names]}`. A client that
   * expected an array reads nothing out of it and paints an empty page, which
   * looks like a bot with no skills rather than like a bug.
   */
  it('flattens the category map rather than expecting a list', () => {
    expect(skillRows({ bundled: ['pdf', 'docx'], installed: ['xlsx'] }, null).map(row => row.name)).toEqual([
      'docx',
      'pdf',
      'xlsx'
    ])
  })

  it('keeps the category each skill was filed under', () => {
    expect(skillRows({ bundled: ['pdf'] }, null)[0]?.category).toBe('bundled')
  })

  /**
   * `null` is "nobody asked about a bot", which is a different thing from
   * "off". The page draws those rows without a switch, because a switch shown
   * at a guessed position is a switch that writes the guess back.
   */
  it('leaves enabled null when no bot was named', () => {
    expect(skillRows({ bundled: ['pdf'] }, null)[0]?.enabled).toBeNull()
  })

  it('treats a skill the describe call never mentioned as on', () => {
    const merged = skillRows({ bundled: ['pdf', 'docx'] }, new Map([['pdf', false]]))

    expect(merged.find(row => row.name === 'docx')?.enabled).toBe(true)
    expect(merged.find(row => row.name === 'pdf')?.enabled).toBe(false)
  })

  it('survives a gateway that answers no skills at all', () => {
    expect(skillRows(null, null)).toEqual([])
  })
})

describe('SkillsController.installed', () => {
  it('joins the list against the bot’s own switches', async () => {
    const gateway = new FakeChatGateway()
      .reply('skills.manage', { skills: { bundled: ['pdf', 'docx'] } })
      .reply('profiles.describe', {
        name: 'writer',
        model: {},
        skills: [
          { name: 'pdf', enabled: false },
          { name: 'docx', enabled: true }
        ]
      })

    const installed = await new SkillsController({ gateway }).installed('writer')

    expect(installed.find(row => row.name === 'pdf')?.enabled).toBe(false)
    expect(gateway.lastCall('skills.manage')).toEqual({ action: 'list', profile: 'writer' })
  })

  it('still lists the skills when the bot’s configuration cannot be read', async () => {
    const gateway = new FakeChatGateway()
      .reply('skills.manage', { skills: { bundled: ['pdf'] } })
      .reply('profiles.describe', () => {
        throw new Error('unknown method')
      })

    const installed = await new SkillsController({ gateway }).installed('writer')

    expect(installed).toHaveLength(1)
    expect(installed[0]?.enabled).toBeNull()
  })

  it('does not ask about a bot when none was named', async () => {
    const gateway = new FakeChatGateway().reply('skills.manage', { skills: {} })

    await new SkillsController({ gateway }).installed()

    expect(gateway.methodOrder()).toEqual(['skills.manage'])
    expect(gateway.lastCall('skills.manage')).toEqual({ action: 'list' })
  })
})

describe('SkillsController.setSkillEnabled', () => {
  /**
   * The inversion, and the reason it has to be the whole list:
   * `save_disabled_skills` REPLACES the stored set. Sending only the skill that
   * changed would switch every other disabled one back on.
   */
  it('sends the whole disabled list, not the one that changed', async () => {
    const gateway = new FakeChatGateway().reply('profiles.configure', { ok: true, applied: { skills: true } })

    await new SkillsController({ gateway }).setSkillEnabled(
      'writer',
      rows(['pdf', false], ['docx', true], ['xlsx', false]),
      'docx',
      false
    )

    expect(gateway.lastCall('profiles.configure')).toEqual({
      name: 'writer',
      disabled_skills: ['pdf', 'docx', 'xlsx']
    })
  })

  it('sends an empty list when the last one is switched back on', async () => {
    const gateway = new FakeChatGateway().reply('profiles.configure', { ok: true, applied: { skills: true } })

    await new SkillsController({ gateway }).setSkillEnabled('writer', rows(['pdf', false]), 'pdf', true)

    expect(gateway.lastCall('profiles.configure')).toEqual({ name: 'writer', disabled_skills: [] })
  })

  /**
   * `applied` reports each section separately and a `false` there is a write
   * that did not land — with no error frame to notice. A controller that
   * trusted the absence of a throw would leave the switch in its new position
   * and the bot in its old one.
   */
  it('refuses to call a section applied when the gateway says it was not', async () => {
    const gateway = new FakeChatGateway().reply('profiles.configure', { ok: false, applied: { skills: false } })

    await expect(
      new SkillsController({ gateway }).setSkillEnabled('writer', rows(['pdf', true]), 'pdf', false)
    ).rejects.toThrow(/did not apply/)
  })
})

describe('SkillsController.search', () => {
  /**
   * `search` answers `results` and `browse` answers `items`. One method, two
   * result keys, chosen by the action — so a reader who clears the search box
   * gets the catalogue only if the controller switches keys with it.
   */
  it('reads `results` when searching and `items` when browsing', async () => {
    const gateway = new FakeChatGateway().reply('skills.manage', params =>
      params.action === 'search'
        ? { results: [{ name: 'xlsx', description: 'Spreadsheets.' }] }
        : { items: [{ name: 'pdf', description: 'PDFs.', source: 'bundled' }], page: 1, total_pages: 1 }
    )
    const controller = new SkillsController({ gateway })

    expect((await controller.search('xlsx'))[0]?.name).toBe('xlsx')
    expect(gateway.lastCall('skills.manage')).toMatchObject({ action: 'search', query: 'xlsx' })

    expect((await controller.search(''))[0]?.name).toBe('pdf')
    expect(gateway.lastCall('skills.manage')).toMatchObject({ action: 'browse', page: 1 })
  })

  it('treats a whitespace query as a browse', async () => {
    const gateway = new FakeChatGateway().reply('skills.manage', { items: [], page: 1 })

    await new SkillsController({ gateway }).search('   ')

    expect(gateway.lastCall('skills.manage')).toMatchObject({ action: 'browse' })
  })
})

describe('SkillsController.install', () => {
  /**
   * Install works over the SOCKET — `_skills_install` calls
   * `do_install(skip_confirm=True)`. The desktop's main Skills tab installs
   * over REST, so reading only that code would suggest this button cannot
   * exist. It can.
   */
  it('installs into the named bot and answers the stored name', async () => {
    const gateway = new FakeChatGateway().reply('skills.manage', { installed: true, name: 'xlsx' })

    expect(await new SkillsController({ gateway }).install('xlsx', 'writer')).toBe('xlsx')
    expect(gateway.lastCall('skills.manage')).toEqual({ action: 'install', query: 'xlsx', profile: 'writer' })
  })

  it('lets the gateway’s refusal through', async () => {
    const gateway = new FakeChatGateway().reply('skills.manage', () => {
      throw new Error("skill 'nope' not found in the hub")
    })

    await expect(new SkillsController({ gateway }).install('nope')).rejects.toThrow(/not found/)
  })
})

describe('the CLI fallback', () => {
  it('names the profile when there is one, because the skill lands in its directory', () => {
    expect(skillInstallCommand('xlsx')).toBe('hermes skills install xlsx')
    expect(skillInstallCommand('xlsx', 'writer')).toBe('hermes --profile writer skills install xlsx')
  })

  /**
   * An older gateway refuses the action itself rather than the skill, and that
   * is the only case where the page should send somebody to a shell.
   */
  it('recognises a gateway that has no install action at all', () => {
    expect(isUnknownAction(new Error('unknown skills action: install'))).toBe(true)
    expect(isUnknownAction(new Error("skill 'nope' not found in the hub"))).toBe(false)
  })
})
