/**
 * Where an element gets a shared file's bytes from.
 *
 * With the cookie session the address is the answer (`OutboxFiles.direct`): the element loads it, sends the cookie,
 * and a video seeks by byte ranges. With the shared token an element has no way to carry the header, so the bytes
 * are fetched (`OutboxFiles.fetch`) and the element gets a `blob:` URL of them, which this hook mints and revokes.
 *
 * Fetching is the costly case, so it waits: for the element to be near the screen (`on: 'visible'`, a picture) or
 * for the reader to ask (`on: 'press'`, a video or a sound, which are held whole in memory), and a file bigger than
 * `maxBytes` is never fetched at all (`too-large`: the download is the way).
 *
 * The blob is typed here, by the kind of file (`blobFor`), never by what the answer said: a picture is only a
 * raster type, a video `video/*`, a sound `audio/*`, and anything else is opaque bytes an element will not play.
 * A picture's blob is also given back after its row has been out of sight for a while (`OFFSCREEN_RELEASE_MS`)
 * and fetched again when the row comes near the screen: a chat of many pictures does not hold them all.
 */
import type { OutboxAttachment } from '@hermie/transcript'
import { useCallback, useEffect, useRef, useState } from 'react'

import { blobFor, type OutboxFailure, outboxHref } from '../../../core/chats/outbox-files'
import { useItemContext } from './item-context'
import { useItemHost } from './item-host'

/** How long a picture's row stays out of sight before the page lets go of its bytes. */
export const OUTBOX_OFFSCREEN_RELEASE_MS = 60_000

export type OutboxSource =
  /** Not asked for yet: the element is not near the screen, or nobody pressed. */
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; src: string }
  /** `invalid`: the file's address is not one this page may ask the gateway for. */
  | { state: 'failed'; reason: OutboxFailure | 'invalid' }

export interface UseOutboxSourceOptions {
  /** When a fetched file is asked for: once it is near the screen, or when `load` is called. */
  on: 'visible' | 'press'
  /** The largest file that is fetched, in bytes. */
  maxBytes: number
}

export interface OutboxSourceHandle {
  source: OutboxSource
  /** Put on the element whose arrival near the screen starts the fetch (`on: 'visible'`). */
  watch: (element: HTMLElement | null) => void
  /** Start the fetch now (`on: 'press'`). */
  load: () => void
  /** The address as it is, for a link that works on its own (the cookie session), or `null`. */
  href: string | null
  /** Whether `href` loads as it is. */
  direct: boolean
}

export function useOutboxSource(file: OutboxAttachment, options: UseOutboxSourceOptions): OutboxSourceHandle {
  const host = useItemHost()
  const { gatewayBaseUrl, profile } = useItemContext()
  const outbox = host.outbox
  const href = outboxHref(file, gatewayBaseUrl, profile)
  const direct = outbox === undefined || outbox.direct
  const tooLarge = file.size > options.maxBytes
  const [wanted, setWanted] = useState(false)
  const [fetched, setFetched] = useState<
    { state: 'loading' } | { state: 'ready'; src: string } | { state: 'failed'; reason: OutboxFailure } | null
  >(null)
  const observer = useRef<IntersectionObserver | null>(null)
  const release = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const { on, maxBytes } = options

  const watch = useCallback(
    (element: HTMLElement | null) => {
      observer.current?.disconnect()
      observer.current = null
      // A new element reports where it is as soon as it is watched; what the last one said no longer counts.
      clearTimeout(release.current)
      release.current = undefined

      if (!element || on !== 'visible' || direct) {
        return
      }

      if (typeof IntersectionObserver === 'undefined') {
        setWanted(true)

        return
      }

      // The observer stays on the element for as long as it is there: it asks for the bytes when the row comes
      // near the screen and gives them back once it has been away for a while.
      const next = new IntersectionObserver(
        entries => {
          const near = entries.at(-1)?.isIntersecting ?? false

          clearTimeout(release.current)
          release.current = undefined

          if (near) {
            setWanted(true)
          } else {
            release.current = setTimeout(() => setWanted(false), OUTBOX_OFFSCREEN_RELEASE_MS)
          }
        },
        { rootMargin: '300px' }
      )

      next.observe(element)
      observer.current = next
    },
    [on, direct]
  )

  useEffect(
    () => () => {
      observer.current?.disconnect()
      clearTimeout(release.current)
    },
    []
  )

  const load = useCallback(() => setWanted(true), [])

  useEffect(() => {
    if (direct || !wanted || !href || tooLarge || !outbox) {
      return undefined
    }

    const controller = new AbortController()
    let made: string | undefined

    setFetched({ state: 'loading' })
    outbox
      .fetch(href, { signal: controller.signal, maxBytes })
      .then(bytes => {
        if (controller.signal.aborted) {
          return
        }

        made = URL.createObjectURL(blobFor(file.kind, bytes))
        setFetched({ state: 'ready', src: made })
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setFetched({
            state: 'failed',
            reason:
              cause && typeof cause === 'object' && 'reason' in cause
                ? ((cause as { reason: OutboxFailure }).reason ?? 'unreachable')
                : 'unreachable'
          })
        }
      })

    return () => {
      controller.abort()

      if (made) {
        URL.revokeObjectURL(made)
      }

      setFetched(null)
    }
  }, [direct, wanted, href, tooLarge, outbox, maxBytes, file.kind])

  let source: OutboxSource

  if (!href) {
    source = { state: 'failed', reason: 'invalid' }
  } else if (direct) {
    source = { state: 'ready', src: href }
  } else if (tooLarge) {
    source = { state: 'failed', reason: 'too-large' }
  } else {
    source = fetched ?? { state: 'idle' }
  }

  return { source, watch, load, href, direct }
}
