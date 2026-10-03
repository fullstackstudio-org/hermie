/**
 * Making the rest of the page unreachable while a modal layer is open.
 *
 * `inert` does the whole job in the browsers this client targets: what it is set
 * on takes no focus, no click and no assistive technology's attention. The layer
 * sits inside the app's own root rather than beside it, so what has to go inert
 * is every sibling of the layer and of each of its ancestors, up to the body: the
 * layer and the path to it stay live, everything else does not.
 *
 * An element that carries `data-modal-keep` is left alone. That is for the
 * layer's own polite status region, which sits beside the dialog and must still
 * be heard.
 *
 * Returns the undo, which puts back exactly what was there (an element that was
 * already inert stays inert). Calls nest: each undo restores what its own call
 * changed.
 */

/** Present on a sibling that stays live while the layer is open. */
export const MODAL_KEEP_ATTRIBUTE = 'data-modal-keep'

export function isolateModal(host: Element): () => void {
  const changed: Element[] = []
  const body = host.ownerDocument.body
  let node: Element | null = host

  while (node && node !== body) {
    const parent: Element | null = node.parentElement

    if (!parent) {
      break
    }

    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || sibling.hasAttribute('inert') || sibling.hasAttribute(MODAL_KEEP_ATTRIBUTE)) {
        continue
      }

      // Scripts and styles take no focus; leave them be so nothing churns.
      if (sibling.tagName === 'SCRIPT' || sibling.tagName === 'STYLE') {
        continue
      }

      sibling.setAttribute('inert', '')
      changed.push(sibling)
    }

    node = parent
  }

  return () => {
    for (const element of changed) {
      element.removeAttribute('inert')
    }
  }
}
