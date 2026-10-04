/**
 * Settings, This gateway: what the page knows about the gateway it belongs to, read only.
 *
 * The host and address are the page's own (the gateway serves this client, so the gateway is where the
 * page came from); the Hermes version is what the gateway's status route said at boot; the plugin, its
 * version and its modules are the plugin's advert as the roster carried it (`state/plugin.ts`); the web
 * client is this build (`build-info.ts`) set against the build the plugin says it carries
 * (`gateway-facts.ts`). Every string that came from the gateway is cleaned to one line and drawn as
 * text.
 *
 * There is nothing to change here, on purpose: what the operator decides (which modules run, who may use
 * the gateway) is the plugin's configuration on the gateway itself (plan, "Plugin config additions").
 */
import { type ReactElement } from 'react'
import { useStore } from 'zustand'

import { buildLabel, clientVersion, sourceCommit } from '../../build-info'
import { displayText, NAME_LIMIT } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { pluginPresence, pluginStore } from '../../state/plugin'
import { Fact, SettingsPage } from './controls'
import { asModuleState, carriedLabel, webUpdateOf } from './gateway-facts'
import { useSettingsRuntime } from './settings-runtime'

const VERSION_LIMIT = 64

const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export function Gateway(): ReactElement {
  useLocale()

  const runtime = useSettingsRuntime()
  const advert = useStore(pluginStore, state => state.advert)
  const presence = useStore(pluginStore, pluginPresence)
  const words = sheetStrings.settings.gateway

  const hermes = displayText(runtime?.hermesVersion ?? '', VERSION_LIMIT)
  const pluginVersion = displayText(advert?.version ?? '', VERSION_LIMIT)
  const update = webUpdateOf(advert, { version: clientVersion, commit: sourceCommit })
  const modules = Object.entries(advert?.modules ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const carried = advert?.web ? carriedLabel(advert.web.version, advert.web.commit) : ''

  return (
    <SettingsPage title={sheetStrings.settings.title.gateway} lead={words.operatorNote}>
      <dl className="hm-facts">
        <Fact label={strings.app.settings.host}>{runtime ? hostOf(runtime.gatewayBaseUrl) : '-'}</Fact>
        {runtime ? (
          <Fact label={words.address} mono>
            {runtime.gatewayBaseUrl}
          </Fact>
        ) : null}
        <Fact label={words.hermesVersion}>{hermes || strings.app.settings.unknown}</Fact>
        <Fact label={strings.app.settings.plugin}>
          {presence === 'unknown'
            ? strings.app.settings.pluginUnknown
            : presence === 'absent'
              ? strings.app.settings.pluginAbsent
              : strings.app.settings.pluginInstalled({ version: pluginVersion })}
        </Fact>
        {presence === 'installed' ? (
          <Fact label={words.modules}>
            {modules.length === 0 ? (
              words.noModules
            ) : (
              <ul className="hm-facts__list">
                {modules.map(([name, state]) => {
                  const known = asModuleState(state)

                  return (
                    <li key={name}>
                      <span className="hm-facts__name">{displayText(name, NAME_LIMIT)}</span>
                      {': '}
                      {known ? words.moduleState[known] : displayText(state, NAME_LIMIT)}
                    </li>
                  )
                })}
              </ul>
            )}
          </Fact>
        ) : null}
        <Fact label={words.thisPage} mono>
          {buildLabel}
        </Fact>
        {presence === 'installed' ? (
          <Fact label={words.pluginWeb} {...(carried ? { mono: true } : {})}>
            {carried || words.pluginWebNone}
          </Fact>
        ) : null}
        {presence === 'installed' ? (
          <Fact label={words.update}>
            {update.kind === 'differs'
              ? words.updateDiffers({ carried: update.carried })
              : update.kind === 'current'
                ? words.updateCurrent
                : words.updateUnknown}
          </Fact>
        ) : null}
      </dl>
      {presence === 'absent' ? <p className="hm-settings-page__text">{webStrings.shell.noPlugin}</p> : null}
    </SettingsPage>
  )
}
