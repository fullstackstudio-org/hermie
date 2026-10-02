/**
 * The push contract, from the app's side of it, and the compatibility window.
 *
 * `contract/push/contract.json` names one category, two action ids, one data
 * key for the request and one Android channel per type. The senders were moved
 * onto it in the same change, but a sender and an app are updated on different
 * days, so this build reads both the contract's spellings and the ones that came
 * before — and the old spellings must keep meaning exactly what they meant.
 *
 *   sender             category           request key   channel
 *   plugin (old)       request            requestId     <type>
 *   Hermie Web (old)   hermie.approval    request       none
 *   both (new)         hermie.request     requestId     <type>
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import type * as Notifications from 'expo-notifications'
import type * as ReactNative from 'react-native'
import { Platform } from 'react-native'

import {
  LEGACY_PUSH_ACTION_ALLOW,
  LEGACY_PUSH_ACTION_DENY,
  LEGACY_PUSH_REQUEST_CATEGORIES,
  PUSH_ACTION_ALLOW,
  PUSH_ACTION_DENY,
  PUSH_CHANNEL_DEFAULT,
  PUSH_CHANNELS,
  PUSH_REQUEST_CATEGORY,
  PUSH_TYPES_WITH_ACTIONS,
  pushTapOf,
  resolvePushTap,
  type OpenApproval,
  type PushResponse
} from '../src/features/push'
import type * as PushPlatformModule from '../src/features/push/platform'

const contract = JSON.parse(readFileSync(path.resolve(__dirname, '../../../contract/push/contract.json'), 'utf8')) as {
  category: { id: string; when: { type: string }; actions: { id: string }[] }
  android: { channels: { id: string; type: string }[] }
  data: { fields: { key: string }[] }
}

const ORIGINAL_OS = Platform.OS

const OPEN: OpenApproval[] = [{ request_id: 'appr-1', choices: ['once', 'session', 'deny'] }]

const tap = (actionIdentifier: string, data: Record<string, unknown>): PushResponse => ({ actionIdentifier, data })

describe('the app’s ids are the contract’s', () => {
  it('registers the contract’s category and action ids', () => {
    expect(PUSH_REQUEST_CATEGORY).toBe(contract.category.id)
    expect([PUSH_ACTION_ALLOW, PUSH_ACTION_DENY]).toEqual(contract.category.actions.map(action => action.id))
    expect(PUSH_TYPES_WITH_ACTIONS).toContain(contract.category.when.type)
  })

  it('declares one Android channel per type, named after the type', () => {
    expect(PUSH_CHANNELS.map(channel => ({ id: channel.id, type: channel.type }))).toEqual(contract.android.channels)
  })

  it('reads the request id under the contract’s key', () => {
    expect(contract.data.fields.map(field => field.key)).toContain('requestId')
  })
})

describe('a tap, from a sender on the contract', () => {
  it('reads Allow and Deny under the contract’s action ids', () => {
    const data = { bot: 'researcher', type: 'request', requestId: 'appr-1' }

    expect(pushTapOf(tap(PUSH_ACTION_ALLOW, data))).toMatchObject({ action: 'allow', requestId: 'appr-1' })
    expect(pushTapOf(tap(PUSH_ACTION_DENY, data))).toMatchObject({ action: 'deny', requestId: 'appr-1' })
  })

  it('answers the open approval it names, and only that one', () => {
    const allow = pushTapOf(tap('hermie.request.allow', { bot: 'researcher', requestId: 'appr-1' }))
    const forged = pushTapOf(tap('hermie.request.allow', { bot: 'researcher', requestId: 'appr-9' }))

    expect(allow && resolvePushTap({ tap: allow, pending: OPEN })).toEqual({
      kind: 'respond',
      bot: 'researcher',
      requestId: 'appr-1',
      choice: 'once'
    })
    expect(forged && resolvePushTap({ tap: forged, pending: OPEN })).toEqual({ kind: 'open-chat', bot: 'researcher' })
  })
})

describe('a tap, from a sender that predates the contract', () => {
  it('still reads the old `allow` and `deny` action ids', () => {
    const data = { bot: 'researcher', type: 'request', requestId: 'appr-1' }

    expect(LEGACY_PUSH_ACTION_ALLOW).toBe('allow')
    expect(LEGACY_PUSH_ACTION_DENY).toBe('deny')
    expect(pushTapOf(tap('allow', data))).toMatchObject({ action: 'allow', requestId: 'appr-1' })
    expect(pushTapOf(tap('deny', data))).toMatchObject({ action: 'deny', requestId: 'appr-1' })
  })

  it('reads Hermie Web’s old `request` key when `requestId` is absent', () => {
    const old = pushTapOf(tap('allow', { bot: 'researcher', type: 'request', request: 'appr-1' }))

    expect(old).toMatchObject({ action: 'allow', requestId: 'appr-1' })
    expect(old && resolvePushTap({ tap: old, pending: OPEN })).toMatchObject({ kind: 'respond', requestId: 'appr-1' })
  })

  it('prefers `requestId` when a payload carries both', () => {
    expect(
      pushTapOf(tap(PUSH_ACTION_ALLOW, { bot: 'researcher', requestId: 'appr-1', request: 'appr-other' }))?.requestId
    ).toBe('appr-1')
  })

  it('still degrades a button with no request id at all to opening the chat', () => {
    expect(pushTapOf(tap('allow', { bot: 'researcher', type: 'request' }))).toMatchObject({ action: 'open' })
    expect(pushTapOf(tap(PUSH_ACTION_DENY, { bot: 'researcher' }))).toMatchObject({ action: 'open' })
  })

  it('reads an unknown action id as a plain open, never as an answer', () => {
    expect(pushTapOf(tap('hermie.approval.allow', { bot: 'researcher', requestId: 'appr-1' }))).toMatchObject({
      action: 'open'
    })
  })
})

describe('what the platform registers', () => {
  type Calls = { categories: unknown[][]; channels: unknown[][] }
  type PlatformModule = typeof PushPlatformModule

  /**
   * `prepare` once, in a fresh module registry: it runs at most once per
   * process, and it reads `Platform.OS`, so each case loads its own copy with
   * the platform it wants and reads the calls off that copy's mock.
   */
  const prepare = async (os: 'ios' | 'android'): Promise<Calls> => {
    let loaded: { platform: PlatformModule; notifications: typeof Notifications } | undefined

    // Both registries: `react-native` resolves `Platform` lazily, so the copy
    // loaded below reads the outer one once the isolation scope has closed.
    Platform.OS = os

    jest.isolateModules(() => {
      const native = require('react-native') as typeof ReactNative

      native.Platform.OS = os
      loaded = {
        platform: require('../src/features/push/platform') as PlatformModule,
        notifications: require('expo-notifications') as typeof Notifications
      }
    })

    if (!loaded) {
      throw new Error('platform did not load')
    }

    await loaded.platform.pushPlatform.prepare()

    return {
      categories: (loaded.notifications.setNotificationCategoryAsync as jest.Mock).mock.calls,
      channels: (loaded.notifications.setNotificationChannelAsync as jest.Mock).mock.calls
    }
  }

  afterEach(() => {
    Platform.OS = ORIGINAL_OS
  })

  it('registers the contract’s category and the old senders’ names for it, with the same two actions', async () => {
    const { categories, channels } = await prepare('ios')
    const registered = categories.map(call => call[0] as string)

    expect(registered).toEqual([PUSH_REQUEST_CATEGORY, ...LEGACY_PUSH_REQUEST_CATEGORIES])
    expect(registered).toEqual(['hermie.request', 'request', 'hermie.approval'])

    for (const call of categories) {
      expect((call[1] as { identifier: string }[]).map(action => action.identifier)).toEqual([
        'hermie.request.allow',
        'hermie.request.deny'
      ])
    }

    expect(channels).toEqual([])
  })

  it('declares the seven type channels on Android, and the old default for the window', async () => {
    const { channels } = await prepare('android')
    const declared = channels.map(call => call[0] as string)

    expect(declared).toEqual([...contract.android.channels.map(channel => channel.id), PUSH_CHANNEL_DEFAULT])
    expect(declared).not.toContain('needs-input')
  })
})

describe('the web worker', () => {
  it('offers the contract’s action ids', () => {
    const worker = readFileSync(path.resolve(__dirname, '../public/hermie-push-sw.js'), 'utf8')

    expect(worker).toContain(`action: '${PUSH_ACTION_ALLOW}'`)
    expect(worker).toContain(`action: '${PUSH_ACTION_DENY}'`)
  })
})
