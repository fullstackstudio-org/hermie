/**
 * Whether an element is near the part of the page the reader can see: what a
 * code block asks before it colours itself.
 *
 * A long history holds hundreds of listings, and a coloured listing is a span
 * per token where a plain one is a single text node. Measured in WebKit on a
 * 2,000-row chat, colouring every listing at once tripled the cost of every
 * full style and layout pass of the transcript (which the list's own resize and
 * scroll work, and every script that reads the page, pay for). So a listing is
 * drawn plain, with exactly the same characters and therefore the same size,
 * and is coloured once it comes within a viewport's height of being seen; it
 * stays coloured after that.
 *
 * "Seen" is measured against the scroll container the block is in, when one is
 * provided (`ScrollRootContext`, the transcript), because an observer on the
 * viewport only sees a block once it is inside the container's own clip and so
 * could not colour it ahead of the reader. Without a container it is the page.
 * Where the browser has no `IntersectionObserver` (a test's simulated document)
 * everything counts as near.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** The element a block scrolls inside, when it is not the page. */
export const ScrollRootContext = createContext<RefObject<Element | null> | null>(null)

/** How far outside the visible area "near" reaches: a viewport's height above and below. */
const MARGIN = '100% 0px 100% 0px'

interface Watcher {
  observer: IntersectionObserver
  callbacks: Map<Element, () => void>
}

/** One observer per scroll container (and one for the page), shared by every block in it. */
const watchers = new WeakMap<object, Watcher>()
const PAGE = {}

function watcherFor(root: Element | null): Watcher {
  const key = root ?? PAGE
  let watcher = watchers.get(key)

  if (!watcher) {
    const callbacks = new Map<Element, () => void>()
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const callback = callbacks.get(entry.target)

            callbacks.delete(entry.target)
            observer.unobserve(entry.target)
            callback?.()
          }
        }
      },
      { root, rootMargin: MARGIN }
    )

    watcher = { observer, callbacks }
    watchers.set(key, watcher)
  }

  return watcher
}

/**
 * Near now, without waiting for an observer's first report (which arrives after
 * the frame is painted, and would show a visible block plain for a frame).
 *
 * An element inside a skipped `content-visibility: auto` subtree is far by the
 * browser's own judgement, and is answered without reading its geometry, which
 * would make the browser lay out the subtree it is skipping.
 */
function nearNow(element: Element, root: Element | null): boolean {
  const check = (element as Element & { checkVisibility?: (options?: object) => boolean }).checkVisibility

  if (typeof check !== 'function' || !check.call(element, { contentVisibilityAuto: true })) {
    return false
  }

  const box = element.getBoundingClientRect()
  const area = root
    ? root.getBoundingClientRect()
    : { top: 0, bottom: element.ownerDocument.documentElement.clientHeight }
  const reach = area.bottom - area.top

  return box.bottom >= area.top - reach && box.top <= area.bottom + reach
}

/**
 * `true` once the element behind `ref` has come near the visible area; `false`
 * until then, and always while `enabled` is false.
 */
export function useNearViewport(ref: RefObject<Element | null>, enabled: boolean): boolean {
  const rootRef = useContext(ScrollRootContext)
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  // Set by the layout effect when the block is near on its first frame, so the observer is not started for it.
  const nearAtMount = useRef(false)

  // Before the frame is painted. The container's own ref may not be attached yet on the first
  // render (a parent's ref is attached after its children's layout effects), so this measures
  // against the page when it has no container yet: the transcript fills most of it.
  useLayoutEffect(() => {
    const element = ref.current

    if (enabled && !near && element && nearNow(element, rootRef?.current ?? null)) {
      nearAtMount.current = true
      setNear(true)
    }
  }, [enabled, near, ref, rootRef])

  // After every ref is attached: watch against the container itself, so its own clip does not
  // hide the block from the observer until it is already in view.
  useEffect(() => {
    const element = ref.current

    if (!enabled || near || nearAtMount.current || !element) {
      return undefined
    }

    const watcher = watcherFor(rootRef?.current ?? null)

    watcher.callbacks.set(element, () => setNear(true))
    watcher.observer.observe(element)

    return () => {
      watcher.callbacks.delete(element)
      watcher.observer.unobserve(element)
    }
  }, [enabled, near, ref, rootRef])

  return near
}
