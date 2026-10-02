/**
 * The browser half of `file-drop.tsx`. Read that file first.
 *
 * Same seam, different machinery: there is no `UIDropInteraction` in a browser
 * and no native module to probe, but there IS a drag-and-drop API, so the web
 * build answers `nativeDropView()` with a real view instead of `null` and
 * `DropZone` gets the same overlay it gets on an iPad.
 *
 * ## Why listeners on the DOM node and not props on the `View`
 *
 * React Native Web forwards a known set of props to the element it renders, and
 * the HTML5 drag events are not in it — `onDragOver` on a `View` reaches
 * nothing. The ref RNW hands back IS the DOM node, so the events are bound
 * there, in an effect, and removed with it.
 *
 * ## `preventDefault` on dragover is the whole feature
 *
 * A browser's default for a file dropped on a document is to NAVIGATE to it:
 * the page is replaced by the PDF the reader meant to attach and the draft is
 * gone. Cancelling `dragover` is what marks the element as a drop target and
 * stops that, and it has to happen on every `dragover`, not once.
 *
 * ## Why the depth counter
 *
 * `dragenter` and `dragleave` fire for every DESCENDANT the pointer crosses, so
 * dragging over a transcript full of bubbles fires a leave for the container
 * and an enter for the bubble, in that order. A boolean drops to false between
 * the two and the overlay strobes as the pointer moves. Counting entries and
 * exits and asking whether the count is above zero is the fix, and it is the
 * one piece of logic here worth testing on its own — hence `dropDepth`.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { View } from 'react-native'

import type { DroppedFile, NativeDropViewProps } from './file-drop.shared'

export type { DroppedFile, NativeDropViewProps } from './file-drop.shared'
export { normaliseDroppedFiles } from './file-drop.shared'

/** A browser can always take a drop; there is no module to probe for. */
export const HAS_NATIVE_FILE_DROP = typeof document !== 'undefined'

const FALLBACK_MIME_TYPE = 'application/octet-stream'

/**
 * The next nesting depth after one drag event.
 *
 * Pure, so the anti-flicker rule can be stated without a DOM. `drop` goes
 * straight to zero rather than decrementing: once the pointer has let go there
 * is no matching `dragleave` coming for any element it was inside, and
 * decrementing would strand the overlay on screen at depth 1 forever.
 */
export function dropDepth(depth: number, event: 'enter' | 'leave' | 'drop'): number {
  if (event === 'enter') {
    return depth + 1
  }

  if (event === 'drop') {
    return 0
  }

  // Clamped: a `dragleave` with no matching enter arrives whenever a drag
  // starts outside the document and ends over it, and a negative depth would
  // need two enters to show the overlay the next time.
  return Math.max(0, depth - 1)
}

/**
 * Whether a drag is carrying files rather than a text selection or a link.
 *
 * `types` is the only thing readable during a drag — `items` and `files` are
 * empty until the drop, by design, so a page cannot inspect what is being
 * dragged over it. A drag without `Files` in `types` gets no overlay, because
 * the composer cannot stage a dragged paragraph and an overlay that promises to
 * accept one is a lie that only resolves after the reader lets go.
 */
export function dragCarriesFiles(transfer: DataTransfer | null | undefined): boolean {
  if (!transfer) {
    return false
  }

  const types = transfer.types

  return types ? Array.prototype.indexOf.call(types, 'Files') !== -1 : false
}

/**
 * The dropped `File`s, in the shape the rest of the app already speaks.
 *
 * `body` carries the `File` itself, which is the part that matters: a browser's
 * `FormData` streams a `File` and rejects React Native's `{uri, name, type}`
 * blob, so an upload built from the URI alone would fail at the last step. The
 * object URL is still produced because it is what the composer's thumbnail
 * renders from.
 */
export function filesFromTransfer(transfer: DataTransfer | null | undefined): DroppedFile[] {
  const list = transfer?.files

  if (!list?.length) {
    return []
  }

  const files: DroppedFile[] = []

  for (let index = 0; index < list.length; index += 1) {
    const file = list.item(index)

    if (!file) {
      continue
    }

    files.push({
      body: file,
      mimeType: file.type || FALLBACK_MIME_TYPE,
      name: file.name || 'attachment',
      size: Number.isFinite(file.size) ? file.size : 0,
      uri: URL.createObjectURL(file)
    })
  }

  return files
}

function WebDropView({
  children,
  enabled = true,
  onDrop,
  onDropEnter,
  onDropExit,
  style,
  testID
}: NativeDropViewProps) {
  const host = useRef<unknown>(null)
  // The handlers are rebound whenever `enabled` flips, and a drag in flight
  // across that boundary would otherwise leave the count wrong.
  const depth = useRef(0)
  const handlers = useRef({ onDrop, onDropEnter, onDropExit })

  handlers.current = { onDrop, onDropEnter, onDropExit }

  useEffect(() => {
    // RNW's ref is the DOM node; on any other platform this file is not used
    // and on the server there is no node at all.
    const node = host.current as HTMLElement | null

    if (!node || !enabled) {
      return
    }

    const settle = (next: number) => {
      const was = depth.current > 0

      depth.current = next

      if (was !== next > 0) {
        ;(next > 0 ? handlers.current.onDropEnter : handlers.current.onDropExit)?.()
      }
    }

    const onEnter = (event: DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) {
        return
      }

      event.preventDefault()
      settle(dropDepth(depth.current, 'enter'))
    }

    const onOver = (event: DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) {
        return
      }

      // Cancelling this is what stops the browser navigating away to the file.
      event.preventDefault()

      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy'
      }
    }

    const onLeave = (event: DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) {
        return
      }

      settle(dropDepth(depth.current, 'leave'))
    }

    const onDropped = (event: DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) {
        return
      }

      event.preventDefault()
      settle(dropDepth(depth.current, 'drop'))

      const files = filesFromTransfer(event.dataTransfer)

      if (files.length) {
        // The same envelope the native view sends, so `DropZone` reads one
        // shape: it calls `normaliseDroppedFiles` on whatever arrives here.
        handlers.current.onDrop?.({ nativeEvent: { files } })
      }
    }

    node.addEventListener('dragenter', onEnter)
    node.addEventListener('dragover', onOver)
    node.addEventListener('dragleave', onLeave)
    node.addEventListener('drop', onDropped)

    return () => {
      node.removeEventListener('dragenter', onEnter)
      node.removeEventListener('dragover', onOver)
      node.removeEventListener('dragleave', onLeave)
      node.removeEventListener('drop', onDropped)

      // A component unmounting mid-drag owes the caller its exit, or the
      // overlay is left up on whatever replaces it.
      if (depth.current > 0) {
        depth.current = 0
        handlers.current.onDropExit?.()
      }
    }
  }, [enabled])

  return (
    <View ref={host as never} style={style} testID={testID}>
      {children as ReactNode}
    </View>
  )
}

/**
 * The view that accepts a drop, or `null` where there is no document — a
 * server render, or the unit-test renderer, both of which `DropZone` already
 * treats as "render the children bare".
 */
export function nativeDropView(): React.ComponentType<NativeDropViewProps> | null {
  return HAS_NATIVE_FILE_DROP ? WebDropView : null
}
