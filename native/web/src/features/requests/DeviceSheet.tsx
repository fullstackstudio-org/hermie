/**
 * The sheet for a request that reaches for the device, chosen by its method: a signature, the location, a contact, a
 * code, a voice note. The choice is made here, inside the device sheets' chunk, so that the request layer in the first
 * load holds one element for all of them instead of five (`device-sheets.ts`).
 *
 * `renderPicker` is what a voice note falls back to when the person would rather pick an audio file: the layer's own file
 * sheet for the same request.
 */
import type { ReactElement } from 'react'

import type { InteractiveRequest } from '../../state/interactive'
import { ContactSheet } from './ContactSheet'
import type { DeviceSheetProps } from './device-frame'
import { LocationSheet } from './LocationSheet'
import { ScanSheet } from './ScanSheet'
import { SignatureSheet } from './SignatureSheet'
import { VoiceSheet } from './VoiceSheet'

export interface DeviceSheetSwitchProps extends Omit<DeviceSheetProps<InteractiveRequest['ask']>, 'request'> {
  request: InteractiveRequest
  renderPicker: () => ReactElement | null
}

export function DeviceSheet({ request, renderPicker, ...props }: DeviceSheetSwitchProps): ReactElement | null {
  const { ask } = request

  switch (ask.method) {
    case 'input.signature':
      return <SignatureSheet request={{ ...request, ask }} {...props} />
    case 'device.location':
      return <LocationSheet request={{ ...request, ask }} {...props} />
    case 'device.contact':
      return <ContactSheet request={{ ...request, ask }} {...props} />
    case 'device.scan':
      return <ScanSheet request={{ ...request, ask }} {...props} />
    case 'input.file':
      return <VoiceSheet request={{ ...request, ask }} renderPicker={renderPicker as () => ReactElement} {...props} />
    default:
      return null
  }
}
