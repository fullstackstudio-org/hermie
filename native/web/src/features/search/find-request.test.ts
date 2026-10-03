import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { createFindRequests, useFindRequest } from './find-request'
import { filterByName, matchesName } from './name-filter'

describe('find requests', () => {
  it('holds one request, for one bot, with an id of its own', () => {
    const requests = createFindRequests()

    requests.request('researcher', '  invoice ')
    const first = requests.current()

    expect(first).toMatchObject({ bot: 'researcher', query: 'invoice' })

    requests.request('researcher', 'invoice')
    expect(requests.current()?.id).not.toBe(first?.id)
  })

  it('is settled by the id it was dealt with under, and a newer one survives an older settle', () => {
    const requests = createFindRequests()

    requests.request('researcher', 'a')
    const older = requests.current()!.id
    requests.request('writer', 'b')

    requests.settle(older)
    expect(requests.current()?.bot).toBe('writer')

    requests.settle(requests.current()!.id)
    expect(requests.current()).toBeNull()
  })

  it('asks for nothing with blank words', () => {
    const requests = createFindRequests()

    requests.request('researcher', '   ')
    expect(requests.current()).toBeNull()
  })

  it('reaches the chat of its own bot only, and follows a request made while it is open', () => {
    const requests = createFindRequests()
    const researcher = renderHook(() => useFindRequest('researcher', requests))
    const writer = renderHook(() => useFindRequest('writer', requests))

    act(() => requests.request('researcher', 'invoice'))

    expect(researcher.result.current?.query).toBe('invoice')
    expect(writer.result.current).toBeNull()
  })
})

describe('the name filter', () => {
  const bots = [
    { name: 'researcher', displayName: 'Ada' },
    { name: 'writer', displayName: 'Writer' },
    { name: 'ops', displayName: 'Ünsere Ops' }
  ]

  it('matches the shown name and the profile name, in any case', () => {
    expect(filterByName(bots, 'ada').map(bot => bot.name)).toEqual(['researcher'])
    expect(filterByName(bots, 'RESEARCH').map(bot => bot.name)).toEqual(['researcher'])
    expect(filterByName(bots, 'ünsere').map(bot => bot.name)).toEqual(['ops'])
  })

  it('keeps every bot for an empty or blank query, in order', () => {
    expect(filterByName(bots, '  ').map(bot => bot.name)).toEqual(['researcher', 'writer', 'ops'])
    expect(matchesName(bots[1]!, '')).toBe(true)
  })

  it('matches nothing it should not', () => {
    expect(filterByName(bots, 'zzz')).toEqual([])
  })
})
