/**
 * The two attachments of a message that have to be fetched before they are anything: a picture the gateway
 * holds on its disk (an attached image's `[Image attached at: <path>]` handle), and a file whose chip is a
 * control.
 *
 * Both ask the host (`ItemHost.loadAttachment`), which asks the gateway's own files routes and judges what
 * comes back by its first bytes (`core/chats/attachment-fetch.ts`), so a picture is a picture whatever its
 * name says and a chip never does nothing:
 *
 *  - **A picture** is a frame from the first moment, the size of the card it will be (`data-reserved`), so the
 *    row never changes height when the bytes arrive; it is fetched once it is on screen, and when the gateway
 *    does not hand it over it becomes the compact file chip with the reason under its name.
 *  - **A file's chip** opens what it names: a picture in the viewer (an upload with no extension, say), any
 *    other file as a download. When the gateway refuses, the chip says so under its name.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'

import { sheetStrings } from '../../../i18n/sheet-strings'
import { saveBlob } from '../../../platform/files'
import { FileChip } from './FileChip'
import { ImageCard } from './ImageCard'
import { useItemHost } from './item-host'
import './media.css'

type Layout = 'solo' | 'cell'

export interface RemotePictureProps {
  reference: string
  name: string
  layout: Layout
  onAccent: boolean
}

type Phase =
  | { kind: 'waiting' }
  | { kind: 'ready'; src: string; name: string }
  /** A file the browser cannot draw as a picture: a chip that saves it. */
  | { kind: 'file' }
  | { kind: 'failed' }

function RemotePictureImpl({ reference, name, layout, onAccent }: RemotePictureProps) {
  const host = useItemHost()
  const frame = useRef<HTMLSpanElement>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'waiting' })
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined')

  // Fetched once it is near the screen: a long history does not ask for every picture in it.
  useEffect(() => {
    const element = frame.current

    if (visible || !element) {
      return undefined
    }

    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setVisible(true)
        }
      },
      { rootMargin: '300px' }
    )

    observer.observe(element)

    return () => observer.disconnect()
  }, [visible])

  useEffect(() => {
    if (!visible) {
      return undefined
    }

    let alive = true

    void (host.loadAttachment?.(reference) ?? Promise.resolve(null)).then(loaded => {
      if (!alive) {
        return
      }

      setPhase(
        loaded?.kind === 'image'
          ? { kind: 'ready', src: loaded.src, name: loaded.name }
          : loaded
            ? { kind: 'file' }
            : { kind: 'failed' }
      )
    })

    return () => {
      alive = false
    }
  }, [host, reference, visible])

  if (phase.kind === 'ready') {
    return (
      <ImageCard
        src={phase.src}
        name={name || phase.name}
        layout={layout}
        onAccent={onAccent}
        reserve
        onOpen={opener => host.openImage({ src: phase.src, name: name || phase.name }, opener)}
      />
    )
  }

  if (phase.kind === 'failed' || phase.kind === 'file') {
    return <OpenableChip reference={reference} name={name} onAccent={onAccent} failed={phase.kind === 'failed'} />
  }

  return (
    <span
      ref={frame}
      className="hm-image"
      data-layout={layout}
      data-reserved="true"
      data-state="waiting"
      data-on-accent={onAccent}
      aria-busy="true"
    />
  )
}

/** A picture to be fetched, in a frame the size of its card. */
export const RemotePicture = memo(RemotePictureImpl)

export interface OpenableChipProps {
  reference: string
  name: string
  size?: number
  onAccent: boolean
  /** Start out refused: the picture that could not be fetched, drawn as the chip it falls back to. */
  failed?: boolean
}

function OpenableChipImpl({ reference, name, size, onAccent, failed = false }: OpenableChipProps) {
  const host = useItemHost()
  const [state, setState] = useState<'idle' | 'opening' | 'failed'>(failed ? 'failed' : 'idle')
  const loadAttachment = host.loadAttachment

  const open = useCallback(() => {
    if (!loadAttachment) {
      return
    }

    setState('opening')

    void loadAttachment(reference).then(loaded => {
      if (!loaded) {
        setState('failed')

        return
      }

      setState('idle')

      if (loaded.kind === 'image') {
        host.openImage({ src: loaded.src, name: loaded.name }, null)
      } else {
        saveBlob(loaded.blob, loaded.name)
      }
    })
  }, [host, loadAttachment, reference])

  return (
    <FileChip
      name={name}
      onAccent={onAccent}
      {...(size !== undefined ? { size } : {})}
      {...(loadAttachment ? { onOpen: open } : {})}
      {...(state === 'opening' ? { status: 'uploading' as const } : {})}
      {...(state === 'failed' ? { error: sheetStrings.attachments.openFailed } : {})}
    />
  )
}

/** A file's chip that opens what it names, or says it could not. */
export const OpenableChip = memo(OpenableChipImpl)
