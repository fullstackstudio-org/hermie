/**
 * What the bot profile sends and how it reads the answers: the three capability lists with their three
 * polarities, the description trimmed, the picture and its removal, the reload, and `applied` read for the
 * one section a request meant.
 */
import { describe, expect, it } from 'vitest'

import { detailsOf, skillsToolsetOff } from './details'
import { BotProfileFailure, classifyFailure, looksForbidden } from './failure'
import {
  avatarParams,
  checkApplied,
  clearAvatarParams,
  descriptionParams,
  mcpParams,
  modelAnswer,
  modelChoicesOf,
  modelParams,
  reloadAnswer,
  reloadMcpParams,
  skillsParams,
  soulParams,
  toolsetDefaultsParams,
  toolsetsParams
} from './params'

const toolsets = [
  { name: 'files', label: 'Files', details: '', toolCount: 6, enabled: true },
  { name: 'web', label: 'Web', details: '', toolCount: 3, enabled: false },
  { name: 'terminal', label: 'Terminal', details: '', toolCount: 2, enabled: true }
]

describe('params', () => {
  it('trims the description as the gateway stores it', () => {
    expect(descriptionParams('writer', '  Writes things.\n')).toEqual({ name: 'writer', description: 'Writes things.' })
  })

  it('writes the toolsets that are ON, whole: a pin of what is on screen', () => {
    expect(toolsetsParams('writer', toolsets)).toEqual({ name: 'writer', enabled_toolsets: ['files', 'terminal'] })
  })

  it('asks for the gateway’s defaults with an empty list, which is not the same as nothing on', () => {
    expect(toolsetDefaultsParams('writer')).toEqual({ name: 'writer', enabled_toolsets: [] })
  })

  it('writes the skills that are OFF, whole: the opposite polarity of MCP in the same call', () => {
    const skills = [
      { name: 'pdf', enabled: true, transport: '' },
      { name: 'docx', enabled: false, transport: '' }
    ]

    expect(skillsParams('writer', skills)).toEqual({ name: 'writer', disabled_skills: ['docx'] })
    expect(mcpParams('writer', skills)).toEqual({ name: 'writer', enabled_mcp_servers: ['pdf'] })
  })

  it('sends the picture as bare base64, and takes it away with clear', () => {
    expect(avatarParams('writer', 'AAAA')).toEqual({ name: 'writer', asset: 'avatar', data: 'AAAA' })
    expect(clearAvatarParams('writer')).toEqual({ name: 'writer', asset: 'avatar', clear: true })
  })

  it('asks for a reload without confirm until the person has answered', () => {
    expect(reloadMcpParams()).toEqual({})
    expect(reloadMcpParams({ sessionId: 's1' })).toEqual({ session_id: 's1' })
    expect(reloadMcpParams({ confirm: true, always: true, sessionId: 's1' })).toEqual({
      confirm: true,
      always: true,
      session_id: 's1'
    })
  })
})

describe('what an answer says', () => {
  it('takes a section that was applied, and refuses one that was not', () => {
    expect(() => checkApplied({ ok: true, applied: { skills: true } }, 'skills')).not.toThrow()
    expect(() => checkApplied({ ok: true, applied: { skills: false } }, 'skills')).toThrow(BotProfileFailure)
    // The request named one section; another being reported is not the answer to it.
    expect(() => checkApplied({ ok: true, applied: { toolsets: true } }, 'skills')).toThrow(BotProfileFailure)
  })

  it('reads the MCP section under the gateway’s word for it', () => {
    expect(() => checkApplied({ applied: { mcp_servers: true } }, 'mcp_servers')).not.toThrow()
    expect(() => checkApplied({ applied: { mcp: true } }, 'mcp_servers')).toThrow(BotProfileFailure)
  })

  it('takes an answer with no `applied` at its word', () => {
    expect(() => checkApplied({ ok: true }, 'description')).not.toThrow()
    expect(() => checkApplied(undefined, 'description')).not.toThrow()
    expect(() => checkApplied({ applied: [] }, 'description')).not.toThrow()
  })

  it('tells a reload from a question the gateway wants answered, and drops its command-line prose', () => {
    expect(reloadAnswer({ status: 'reloaded', loaded_rev: 'r1' })).toEqual({ kind: 'reloaded' })
    expect(reloadAnswer({ status: 'confirm_required', message: 'Reply `/reload-mcp now`' })).toEqual({
      kind: 'confirm',
      message: 'Reply `/reload-mcp now`'
    })
    expect(reloadAnswer(null)).toEqual({ kind: 'reloaded' })
  })
})

describe('details', () => {
  it('reads the editor snapshot, with every list whole and the gateway’s defaults when it says nothing', () => {
    const details = detailsOf(
      {
        name: 'writer',
        description: 'Writes.',
        soul: 'Be terse.',
        model: { provider: 'p', default: 'm' },
        skills: [{ name: 'pdf' }, { name: 'docx', enabled: false }, { name: '' }],
        toolsets: [
          { name: 'files', label: 'Files', description: 'Read files.', tool_count: 6, enabled: true },
          { name: 'web' }
        ],
        toolsets_pinned: true,
        mcp_servers: [{ name: 'github', enabled: false, transport: 'http' }, { name: 'local' }]
      },
      'fallback'
    )

    expect(details).toEqual({
      name: 'writer',
      description: 'Writes.',
      soul: 'Be terse.',
      model: { provider: 'p', model: 'm' },
      toolsets: [
        { name: 'files', label: 'Files', details: 'Read files.', toolCount: 6, enabled: true },
        { name: 'web', label: 'web', details: '', toolCount: 0, enabled: true }
      ],
      toolsetsPinned: true,
      skills: [
        { name: 'pdf', enabled: true, transport: '' },
        { name: 'docx', enabled: false, transport: '' }
      ],
      mcpServers: [
        { name: 'github', enabled: false, transport: 'http' },
        { name: 'local', enabled: true, transport: 'stdio' }
      ]
    })
  })

  it('falls back to the profile asked about, and to nothing for a model that is not pinned', () => {
    const details = detailsOf({ name: '', model: {} }, 'writer')

    expect(details.name).toBe('writer')
    expect(details.model).toEqual({ provider: '', model: '' })
    expect(details.toolsetsPinned).toBe(false)
    expect(details.skills).toEqual([])
  })

  it('knows when the Skills toolset is off', () => {
    const base = detailsOf({ name: 'a', model: {}, toolsets: [{ name: 'skills', enabled: false }] }, 'a')

    expect(skillsToolsetOff(base)).toBe(true)
    expect(skillsToolsetOff(detailsOf({ name: 'a', model: {}, toolsets: [{ name: 'skills' }] }, 'a'))).toBe(false)
    expect(skillsToolsetOff(detailsOf({ name: 'a', model: {} }, 'a'))).toBe(false)
  })
})

describe('failures', () => {
  const rpc = (message: string, code?: number): Error =>
    Object.assign(new Error(message), code === undefined ? {} : { code })

  it('sorts what a call throws by what the page should do about it', () => {
    expect(classifyFailure(rpc('no such method', -32601)).kind).toBe('unsupported')
    expect(classifyFailure(rpc('nope', 4030)).kind).toBe('forbidden')
    expect(classifyFailure(rpc('Forbidden for this account', 4000)).kind).toBe('forbidden')
    expect(classifyFailure(rpc('Unknown profile: x', 5063)).kind).toBe('not_found')
    expect(classifyFailure(rpc('gateway not connected')).kind).toBe('offline')
    expect(classifyFailure(rpc('request timed out')).kind).toBe('offline')
    expect(classifyFailure(rpc('disk full', 5000)).kind).toBe('refused')
    expect(classifyFailure('plain text').kind).toBe('refused')
  })

  it('keeps the gateway’s own words as the detail', () => {
    expect(classifyFailure(rpc('Read-only account.', 4030)).detail).toBe('Read-only account.')
  })

  it('does not take an operating-system error for a denial', () => {
    expect(looksForbidden('Read-only file system')).toBe(false)
    expect(looksForbidden('Permission denied: /home/x/config.yaml')).toBe(false)
    expect(classifyFailure(rpc('OSError: Read-only file system', 5000)).kind).toBe('refused')
    expect(looksForbidden('You do not have permission to edit this profile')).toBe(true)
  })

  it('leaves a failure that is already sorted as it is', () => {
    const failure = new BotProfileFailure('last_toolset')

    expect(classifyFailure(failure)).toBe(failure)
  })
})

describe('the personality and the model', () => {
  it('sends the soul exactly as typed, whitespace included, and an empty one as empty', () => {
    expect(soulParams('writer', '  Be brief.\n')).toEqual({ name: 'writer', soul: '  Be brief.\n' })
    expect(soulParams('writer', '')).toEqual({ name: 'writer', soul: '' })
  })

  it('sends the model id as the inventory spells it and the provider in its own field, never joined', () => {
    expect(modelParams('writer', { provider: 'openrouter', model: 'anthropic/claude-x' })).toEqual({
      name: 'writer',
      model: 'anthropic/claude-x',
      provider: 'openrouter'
    })
    expect(modelParams('writer', { provider: 'p', model: 'm' }, true)).toEqual({
      name: 'writer',
      model: 'm',
      provider: 'p',
      confirm_expensive_model: true
    })
  })

  it('reads a model answer: a guarded model asks with the gateway’s words, an applied one is checked, and one not applied fails', () => {
    expect(modelAnswer({ ok: true, applied: {}, confirm_required: true, confirm_message: 'x costs more.' })).toEqual({
      kind: 'confirm',
      message: 'x costs more.'
    })
    expect(modelAnswer({ confirm_required: true })).toEqual({ kind: 'confirm', message: '' })
    expect(modelAnswer({ ok: true, applied: { model: true } })).toEqual({ kind: 'applied' })
    expect(() => modelAnswer({ ok: true, applied: {} })).toThrow(BotProfileFailure)
    // An answer with no `applied` at all reports nothing, and is taken at its word.
    expect(modelAnswer({ ok: true })).toEqual({ kind: 'applied' })
  })

  it('flattens the inventory in the gateway’s order, skipping a provider with no slug, a model with no name and a repeat', () => {
    expect(
      modelChoicesOf({
        providers: [
          { slug: 'a', name: 'Provider A', models: ['m1', 'm1', '', 'm2'] },
          { name: 'No slug', models: ['x'] },
          { slug: 'b', models: ['m1'] },
          null
        ]
      })
    ).toEqual([
      { provider: 'a', providerName: 'Provider A', model: 'm1', id: 'a/m1' },
      { provider: 'a', providerName: 'Provider A', model: 'm2', id: 'a/m2' },
      { provider: 'b', providerName: 'b', model: 'm1', id: 'b/m1' }
    ])
    expect(modelChoicesOf(null)).toEqual([])
    expect(modelChoicesOf({})).toEqual([])
  })
})
