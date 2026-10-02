/**
 * "Address", in the Gateway group — Settings and the wizard's last step.
 *
 * Off the web there is nothing to explain: the address is the one the owner
 * typed and the app talks to it directly, so this is the plain row it always
 * was. `GatewayAddressRow.web.tsx` is the one with something to say.
 */
import { strings } from '../i18n/strings'
import { InsetValueRow } from '../ui/primitives'

export interface GatewayAddressRowProps {
  /** The base URL the app is configured against; absent before it has one. */
  baseUrl: string | null | undefined
}

export function GatewayAddressRow({ baseUrl }: GatewayAddressRowProps) {
  return <InsetValueRow label={strings.settings.address} value={baseUrl || strings.settings.unknown} />
}
