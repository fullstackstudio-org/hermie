/**
 * The browser half of `GatewayAddressRow.tsx`, and the one place in the app
 * where "the gateway" and "the address this page talks to" are two different
 * strings.
 *
 * ## What was wrong
 *
 * `config.baseUrl` in a browser is `window.location.origin`, because Hermie Web
 * proxies the gateway onto its own origin — see `docs/web.md`. That is exactly
 * right for the code that dials it and exactly wrong as an answer to "which
 * gateway am I on": Settings and the wizard's last step both showed
 * `http://127.0.0.1:9120`, which is this app, while the sign-in step one screen
 * earlier said `talking to 127.0.0.1:9119` and was right. Two screens in one
 * flow naming two different things "the gateway" is the defect.
 *
 * ## What it shows instead
 *
 * The host from `/hermie/config.json`, which is the gateway Hermie Web was
 * started against and cannot be steered to anything else, with the proxy named
 * underneath it rather than hidden: a reader who wants to know why the address
 * bar disagrees with this row gets the answer in the row.
 *
 * The fetch is best-effort and shared with the rest of the app (the module
 * caches one promise). A server that does not answer costs the qualification
 * and falls back to the origin — which is still the address that works, just
 * not the one worth printing.
 */
import { useEffect, useState } from 'react'

import { strings } from '../i18n/strings'
import { InsetValueRow } from '../ui/primitives'
import type { GatewayAddressRowProps } from './GatewayAddressRow'
import { loadHermieWebConfig } from './web-config'

export type { GatewayAddressRowProps } from './GatewayAddressRow'

export function GatewayAddressRow({ baseUrl }: GatewayAddressRowProps) {
  const [gatewayHost, setGatewayHost] = useState<string | null>(null)

  useEffect(() => {
    let live = true

    void loadHermieWebConfig().then(config => {
      if (live && config?.gatewayHost) {
        setGatewayHost(config.gatewayHost)
      }
    })

    return () => {
      live = false
    }
  }, [])

  return (
    <InsetValueRow
      label={strings.settings.address}
      value={gatewayHost ?? baseUrl ?? strings.settings.unknown}
      {...(gatewayHost ? { detail: strings.settings.viaHermieWeb } : {})}
    />
  )
}
