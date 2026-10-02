/**
 * Settings → Gateways: the one this device is talking to, in the parts a reader
 * checks it by, and every other one it knows about.
 *
 * Hermie Web has no "every other one": the server in front of it already
 * proxied it to a single gateway (`WEB_GATEWAY_BASE_URL`), so the page there
 * is purely informative — the category is "Gateway", singular, its summary is
 * the host alone, and the list, add and manage rows below do not draw at all.
 */
import { isExposedCleartext } from '@hermie/gateway-client'
import { useNavigation, type NavigationProp } from '@react-navigation/native'

import { useGateway } from '../../../gateway'
import { GatewayAddressRow } from '../../../gateway/GatewayAddressRow'
import { describeGatewayAddress } from '../../../gateway/gateway-stop'
import { RefreshNotice } from '../../../gateway/RefreshNotice'
import { TransportNotice } from '../../../gateway/TransportNotice'
import { WEB_GATEWAY_BASE_URL } from '../../../gateway/web-config'
import { strings } from '../../../i18n/strings'
import { pluginPresence, usePluginStore } from '../../../store/plugin'
import { InsetGroup, InsetValueRow } from '../../../ui/primitives'
import { GatewayList } from '../GatewaysScreen'
import type { SettingsParamList } from '../navigation/route-names'
import { SettingsPage } from '../navigation/SettingsPage'

/*
  Read through `?.` for the reason `GatewayTitle` gives: Settings is rendered by
  suites that stand in for the gateway context with the two or three fields they
  care about, and a summary is not worth a crash in any of them. One gateway is
  the right answer when nothing is known, because one is what every device had
  before the list existed.
*/
export function useSummary(): string {
  const { config, registry } = useGateway()
  const host = describeGatewayAddress(config?.baseUrl).host

  // Hermie Web can only ever have the one it is proxied to — the host on its
  // own, never "· n gateways" for a build that cannot count past it.
  return WEB_GATEWAY_BASE_URL
    ? strings.settings.categories.summary.gateway(host)
    : strings.settings.categories.summary.gateways(host, registry?.gateways.length ?? 1)
}

export function Page() {
  const navigation = useNavigation<NavigationProp<SettingsParamList>>()
  const { canRefresh, config, status } = useGateway()
  const advert = usePluginStore(state => state.advert)
  const presence = usePluginStore(pluginPresence)
  const token = config?.authMode === 'session_token'
  const address = describeGatewayAddress(config?.baseUrl)

  return (
    <SettingsPage route="Gateways">
      <InsetGroup
        header={strings.settings.gateway}
        /*
          Two notices, one footer slot, and they are about different things:
          the transport one is about the ADDRESS and only speaks for an exposed
          cleartext host — a tailnet gateway over http is the ordinary setup.
          The refresh one is about the CREDENTIAL, and it speaks wherever the
          stored sign-in has nothing to rotate with.
        */
        {...(isExposedCleartext(config?.baseUrl ?? '') || canRefresh === false
          ? {
              footer: (
                <>
                  <TransportNotice baseUrl={config?.baseUrl} testID="transport-notice" />
                  <RefreshNotice canRefresh={canRefresh !== false} testID="refresh-notice" />
                </>
              )
            }
          : {})}
      >
        <GatewayAddressRow baseUrl={config?.baseUrl} />
        {/*
          The same parts the stopped-gateway card prints, so an address read
          here and an address blamed by a failure read identically. Not in a
          browser: there the row above already answers "which gateway", and
          this app's own origin has a scheme and a port that say nothing about it.
        */}
        {WEB_GATEWAY_BASE_URL ? null : <InsetValueRow label={strings.settings.host} value={address.host} />}
        {WEB_GATEWAY_BASE_URL ? null : <InsetValueRow label={strings.settings.scheme} value={address.scheme} />}
        {WEB_GATEWAY_BASE_URL ? null : <InsetValueRow label={strings.settings.port} value={address.port} />}
        <InsetValueRow
          label={strings.settings.provider}
          value={
            token
              ? strings.settings.authModeToken
              : (config?.providerDisplayName ?? config?.provider ?? strings.settings.unknown)
          }
        />
        <InsetValueRow label={strings.settings.version} value={config?.version || strings.settings.unknown} />
        <InsetValueRow
          label={strings.settings.status}
          value={status ? strings.connection.status[status] : strings.settings.unknown}
        />
        {/*
          Whether the gateway-side plugin is there, which is what decides whether
          notifications can come from the gateway at all. "Checking…" rather than
          "Not installed" until a roster has actually arrived: the two look the
          same for a second and only one of them is a reason to send somebody to
          a shell.
        */}
        <InsetValueRow
          label={strings.settings.plugin}
          value={
            presence === 'unknown'
              ? strings.settings.pluginUnknown
              : presence === 'installed'
                ? strings.settings.pluginInstalled(advert?.version ?? '')
                : strings.settings.pluginAbsent
          }
        />
      </InsetGroup>

      {/*
        The list of gateways. In a browser there is nothing to list: Hermie Web
        fixes the gateway and the wizard there has no address step to add
        another one with.
      */}
      {WEB_GATEWAY_BASE_URL ? null : (
        <GatewayList
          onAdd={() => navigation.navigate('GatewayAdd')}
          onManage={id => navigation.navigate('GatewayDetail', { id })}
        />
      )}
    </SettingsPage>
  )
}
