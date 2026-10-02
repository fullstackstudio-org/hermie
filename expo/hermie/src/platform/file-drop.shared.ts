/**
 * The parts of the file-drop seam that do not depend on where the drop came
 * from: the file shape, the host view's props, and the payload reader.
 *
 * Here rather than in `file-drop.tsx` for the reason `web-config.shared.ts`
 * spells out at length: `./file-drop` read from inside `file-drop.web.tsx`
 * resolves to `file-drop.web.tsx` itself, so a `.web` file that re-exports a
 * value from its own twin re-exports it from itself and the export becomes a
 * getter returning its own getter. Reading the name then overflows the stack
 * before the call — which is what `normaliseDroppedFiles` did in the browser
 * build, on the one gesture this module exists for.
 *
 * Nothing imports this file directly; import `./file-drop` and let the bundler
 * pick.
 */
import type { ReactNode } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'

/** One file as the native side hands it over. Same four fields the picker produces. */
export interface DroppedFile {
  uri: string
  name: string
  size: number
  mimeType: string
  /**
   * The `FormData` part, where the platform has one of its own.
   *
   * Absent on the native side, which streams from the URI. A browser drop
   * carries the `File` here for the same reason the browser PICKER does: a
   * browser's `FormData` streams a `File` and rejects React Native's
   * `{uri, name, type}` blob, so an upload rebuilt from the object URL alone
   * would fail at the last step. Mirrors `PickedFile.body`.
   */
  body?: unknown
}

export interface NativeDropViewProps {
  enabled?: boolean
  onDrop?: (event: { nativeEvent: { files?: unknown } }) => void
  onDropEnter?: () => void
  onDropExit?: () => void
  style?: StyleProp<ViewStyle>
  children?: ReactNode
  testID?: string
}

const FALLBACK_MIME_TYPE = 'application/octet-stream'

/**
 * Read a drop payload back, defensively.
 *
 * The bridge carries `[[String: Any]]`, which is to say: anything. A drop is a
 * gesture the reader made with a file they care about, so the failure mode that
 * matters is not a wrong field — it is a payload shape that throws while the
 * chat is open. Every item without a URI is dropped, every other field falls
 * back, and a payload that is not a list at all reads as no files.
 *
 * Exported and pure so the mapping can be stated in a test, which is the only
 * half of this seam that can be checked without a Mac and a Finder.
 */
export function normaliseDroppedFiles(payload: unknown): DroppedFile[] {
  if (!Array.isArray(payload)) {
    return []
  }

  const files: DroppedFile[] = []

  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') {
      continue
    }

    const item = raw as Partial<Record<keyof DroppedFile, unknown>>
    const uri = typeof item.uri === 'string' ? item.uri : ''

    if (!uri) {
      continue
    }

    const name = typeof item.name === 'string' && item.name ? item.name : (uri.split('/').pop() ?? 'attachment')

    files.push({
      mimeType: typeof item.mimeType === 'string' && item.mimeType ? item.mimeType : FALLBACK_MIME_TYPE,
      name: decodeURIComponent(name),
      size: typeof item.size === 'number' && Number.isFinite(item.size) && item.size > 0 ? item.size : 0,
      uri,
      // Carried through rather than rebuilt: the browser drop puts the `File`
      // here and only that object can be streamed by a browser's `FormData`.
      // The native side sends nothing, and the key stays absent.
      ...(item.body === undefined || item.body === null ? {} : { body: item.body })
    })
  }

  return files
}
