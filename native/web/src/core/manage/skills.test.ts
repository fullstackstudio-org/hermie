/**
 * The skills readers and calls: the category map is flattened and sorted, a skill with no switch known is not
 * guessed on, a switch writes the whole disabled set, a write the gateway did not apply is a failure, and the hub's
 * two actions answer under two different keys.
 */
import { describe, expect, it } from 'vitest'

import { aSkillsGateway } from '../../test-support/skills-gateway'
import { createSkillsClient, detailsOf, isUnknownAction, skillInstallCommand, skillRows } from './skills'

describe('skillRows', () => {
  it('flattens the category map, sorts by name, and leaves the switch unknown when nobody asked', () => {
    expect(skillRows({ installed: ['xlsx'], bundled: ['pdf', 'docx'] }, null)).toEqual([
      { name: 'docx', category: 'bundled', enabled: null },
      { name: 'pdf', category: 'bundled', enabled: null },
      { name: 'xlsx', category: 'installed', enabled: null }
    ])
  })

  it('takes a skill the bot has never been told about as on, and reads nothing from a missing or odd map', () => {
    expect(skillRows({ installed: ['a', 'b'] }, new Map([['a', false]])).map(row => row.enabled)).toEqual([false, true])
    expect(skillRows(null, null)).toEqual([])
    expect(skillRows({ installed: 'nope' as unknown as string[] }, null)).toEqual([])
  })
})

describe('detailsOf', () => {
  it('is nothing for the empty object the hub answers when the identifier resolves nowhere', () => {
    expect(detailsOf({})).toBeNull()
    expect(detailsOf(null)).toBeNull()
    expect(detailsOf({ name: 'pdf', tags: ['official', 4 as unknown as string], skill_md_preview: '# pdf' })).toEqual({
      name: 'pdf',
      description: '',
      source: null,
      identifier: null,
      tags: ['official'],
      preview: '# pdf'
    })
  })
})

describe('the helpers', () => {
  it('names the command for an older gateway, and recognises its refusal by code or by words', () => {
    expect(skillInstallCommand('xlsx', 'writer')).toBe('hermes --profile writer skills install xlsx')
    expect(isUnknownAction(Object.assign(new Error('x'), { code: 4017 }))).toBe(true)
    expect(isUnknownAction(new Error('Unknown skills action: install'))).toBe(true)
    expect(isUnknownAction(new Error('the hub is down'))).toBe(false)
  })
})

describe('the client', () => {
  it('writes the whole disabled set, inverted, under the bot’s name', async () => {
    const gateway = aSkillsGateway({ installed: { writer: ['a', 'b', 'c'] }, disabled: { writer: [] } })
    const client = createSkillsClient(gateway.transport.gateway)

    await client.writeSwitches('writer', [
      { name: 'a', enabled: false },
      { name: 'b', enabled: true },
      { name: 'c', enabled: false }
    ])

    expect(gateway.rpc.at(-1)).toEqual({
      method: 'profiles.configure',
      params: { name: 'writer', disabled_skills: ['a', 'c'] }
    })
  })

  it('fails a write the gateway accepted and did not apply, which no error frame would say', async () => {
    const gateway = aSkillsGateway()

    gateway.transport.gateway.request = (async () => ({ ok: true, applied: { skills: false } })) as never

    await expect(createSkillsClient(gateway.transport.gateway).writeSwitches('writer', [])).rejects.toThrow()
  })

  it('reads a search from `results` and a browse from `items`, and pages only the browse', async () => {
    const gateway = aSkillsGateway({ hubPages: 3 })
    const client = createSkillsClient(gateway.transport.gateway)

    expect(await client.hub('xl', 1)).toMatchObject({
      items: [{ name: 'xlsx', identifier: 'xlsx' }],
      page: 1,
      totalPages: 1
    })
    expect(await client.hub('', 2)).toMatchObject({
      page: 2,
      totalPages: 3,
      items: [{ identifier: 'pdf-2' }, { identifier: 'xlsx-2' }, { identifier: 'video-2' }]
    })
  })

  it('still lists when profiles.describe is not there, with no switches', async () => {
    const gateway = aSkillsGateway({ noDescribe: true })

    expect(await createSkillsClient(gateway.transport.gateway).installed('researcher')).toEqual([
      { name: 'docx', category: 'installed', enabled: null },
      { name: 'pdf', category: 'bundled', enabled: null }
    ])
  })
})
