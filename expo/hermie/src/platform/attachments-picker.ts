/**
 * Opening the platform's file picker.
 *
 * A seam because "the platform's file picker" is `expo-document-picker` on the
 * phones and the Mac, and a hidden `<input type="file">` in a browser — and the
 * two hand back different things. Native gives a `file://` URI that `fetch` can
 * stream from without the bytes ever entering JavaScript; a browser gives a
 * `File`, which is what `FormData` wants there.
 *
 * The seam returns a `body` the upload appends to a `FormData` as-is, so
 * neither caller has to know which of the two it got.
 */
import * as DocumentPicker from 'expo-document-picker'

import type { PickedFileSource } from './platform-contracts'

export type { PickedFileSource } from './platform-contracts'

/**
 * `copyToCacheDirectory` is on, and it is load-bearing rather than a default
 * worth trimming: without it iOS hands back a URI inside the provider's own
 * sandbox, which stops resolving the moment the picker closes — and this
 * function returns before the upload starts.
 */
export async function openFilePicker(): Promise<PickedFileSource | null> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    multiple: false,
    copyToCacheDirectory: true
  })

  if (picked.canceled) {
    return null
  }

  const asset = picked.assets?.[0]

  if (!asset) {
    return null
  }

  return {
    uri: asset.uri,
    name: asset.name ?? null,
    size: typeof asset.size === 'number' ? asset.size : 0,
    mimeType: asset.mimeType ?? null,
    // React Native's `FormData` takes this shape and streams from the URI.
    body: { uri: asset.uri, name: asset.name ?? 'attachment', type: asset.mimeType ?? 'application/octet-stream' }
  }
}
