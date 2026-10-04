/**
 * Settings, Notifications: whether this browser is notified by the gateway's
 * plugin, about what, and with how much text (plan W-25).
 *
 * What it says, in order:
 *
 *  - why notifications cannot be offered here, when they cannot: plain http, a
 *    browser without Push, Safari on an iPhone or iPad outside a Home Screen app,
 *    no plugin, a plugin that sends no Web Push, a plugin too old to publish its
 *    key (`core/push/platform.ts`);
 *  - the switch, which asks the browser's permission from the reader's own
 *    gesture, and what the registration is doing (off, being checked, on,
 *    blocked in the browser, or failed in the browser's own words);
 *  - the types (the seven of `contract/push/contract.json`) and the preview, kept
 *    in this browser and written into its row;
 *  - "Register again", which subscribes afresh with the gateway's key and
 *    writes a fresh row (what brings back a row the plugin retired), and "Send a
 *    test notification" where the plugin offers it (`push.test`).
 *
 * The per-chat types are in each chat's options (`features/chat/ChatOptionsPanel.tsx`).
 * The work is the controller's (`core/push/sync.ts`), reached through the push
 * store; this page only draws and asks.
 */
import { PUSH_TYPES } from '@hermie/gateway-client/push'
import { type ReactElement, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'
import { useShallow } from 'zustand/react/shallow'

import { offersTestNotification, type PushBrowser, type PushUnavailable, pushSupport } from '../../core/push/platform'
import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { pagePushBrowser } from '../../platform/web-push'
import { pushTypeLabel } from '../push/type-labels'
import { type PluginState, pluginStore } from '../../state/plugin'
import { type PushState, type PushTestOutcome, pushStore } from '../../state/push'
import { Button } from '../../ui/primitives'
import { Checkbox, SettingsPage } from './controls'

function unavailableText(reason: PushUnavailable): string {
  const words = sheetStrings.push.unavailable

  switch (reason) {
    case 'insecure':
      return words.insecure
    case 'ios-home-screen':
      return words.iosHomeScreen
    case 'browser':
      return words.browser
    case 'unknown':
      return words.unknown
    case 'no-plugin':
      return words.noPlugin
    case 'webpush-off':
      return words.webpushOff
    case 'plugin-too-old':
      return words.pluginTooOld
  }
}

function testText(outcome: PushTestOutcome): string {
  const words = sheetStrings.push.testResult

  switch (outcome.kind) {
    case 'sent':
      return words.sent
    case 'refused':
      return words.refused({ outcome: outcome.outcome })
    case 'not-registered':
      return words.notRegistered
    case 'busy':
      return words.busy({ seconds: outcome.retryAfter })
    case 'failed':
      return outcome.status > 0 ? words.failed({ status: outcome.status }) : words.unreachable
  }
}

export interface NotificationsProps {
  /** The page's own unless a test hands in its own. */
  browser?: PushBrowser
  pluginState?: StoreApi<PluginState>
  pushState?: StoreApi<PushState>
}

export function Notifications({
  browser = pagePushBrowser,
  pluginState = pluginStore,
  pushState = pushStore
}: NotificationsProps = {}): ReactElement {
  useLocale()

  const plugin = useStore(
    pluginState,
    useShallow(state => ({ read: state.read, advert: state.advert }))
  )
  const push = useStore(
    pushState,
    useShallow(state => ({
      enabled: state.enabled,
      types: state.types,
      preview: state.preview,
      address: state.address,
      phase: state.phase,
      busy: state.busy,
      failure: state.failure,
      controller: state.controller
    }))
  )
  const [permission, setPermission] = useState(() => browser.permission())
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  /** The newest test: an older one that settles after it must not say its piece. */
  const run = useRef(0)

  // The permission can change in the browser's own settings while this page is open.
  useEffect(() => {
    setPermission(browser.permission())
  }, [browser, push.enabled, push.busy, push.phase])

  const support = pushSupport(browser.environment(), plugin)
  const controller = push.controller
  const words = sheetStrings.push
  const offered = support.ok && controller !== null
  const registered = push.enabled && push.address !== null

  const status = !push.enabled
    ? permission === 'denied' && support.ok
      ? words.status.denied
      : words.status.off
    : push.failure
      ? words.status.failed({ message: push.failure })
      : registered
        ? words.status.registered
        : words.status.checking

  const toggle = (on: boolean): void => {
    // One change at a time: a press while the last one is being carried out does nothing.
    if (!controller || push.busy) {
      return
    }

    setMessage(null)

    void (on ? controller.enable() : controller.disable()).finally(() => setPermission(browser.permission()))
  }

  const sendTest = async (): Promise<void> => {
    if (!controller) {
      return
    }

    const mine = ++run.current

    setMessage(null)

    const outcome = await controller.sendTest()

    if (mine === run.current) {
      setMessage({ tone: outcome.kind === 'sent' ? 'ok' : 'danger', text: testText(outcome) })
    }
  }

  return (
    <SettingsPage title={strings.app.settings.categories.notifications} lead={words.intro}>
      {support.ok ? null : (
        <p
          className="hm-settings-page__message"
          role="status"
          data-tone={support.reason === 'unknown' ? 'ok' : 'danger'}
        >
          {unavailableText(support.reason)}
        </p>
      )}

      <Checkbox
        label={words.enable}
        checked={push.enabled}
        disabled={!offered && !push.enabled}
        onChange={toggle}
        busy={push.busy}
        hint={status}
      />

      {push.enabled ? (
        <>
          <fieldset className="hm-set">
            <legend className="hm-set__legend">{strings.app.settings.notifications.types}</legend>
            <div className="hm-set__options" data-layout="column">
              {PUSH_TYPES.map(type => (
                <label className="hm-choice" key={type}>
                  <input
                    type="checkbox"
                    checked={push.types[type]}
                    onChange={event => pushState.getState().setType(type, event.currentTarget.checked)}
                  />
                  <span className="hm-choice__label">{pushTypeLabel(type)}</span>
                </label>
              ))}
            </div>
            <p className="hm-set__hint">{strings.app.settings.notifications.typesHint}</p>
          </fieldset>

          <Checkbox
            label={strings.app.settings.notifications.preview}
            checked={push.preview}
            onChange={preview => pushState.getState().setPreview(preview)}
            hint={strings.app.settings.notifications.previewHint}
          />

          <div className="hm-settings-page__actions">
            <Button
              variant="quiet"
              disabled={!offered}
              aria-busy={push.busy}
              onClick={() => {
                // Not disabled while it works: a button that disables itself drops the focus the reader was using.
                if (push.busy) {
                  return
                }

                setMessage(null)
                void controller?.reregister()
              }}
            >
              {words.reregister}
            </Button>
            {offersTestNotification(plugin.advert) && registered ? (
              <Button variant="quiet" disabled={!offered} onClick={() => void sendTest()}>
                {words.test}
              </Button>
            ) : null}
          </div>
          <p className="hm-set__hint">{words.reregisterHint}</p>
        </>
      ) : null}

      <p className="hm-settings-page__message" role="status" data-tone={message?.tone}>
        {message?.text ?? ''}
      </p>
    </SettingsPage>
  )
}
