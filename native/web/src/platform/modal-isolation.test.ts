import { afterEach, describe, expect, it } from 'vitest'

import { isolateModal, MODAL_KEEP_ATTRIBUTE } from './modal-isolation'

afterEach(() => {
  document.body.replaceChildren()
})

/** body > root > [app, layer > [status (kept), scrim]], and a noscript beside root. */
function page() {
  const root = document.createElement('div')
  const app = document.createElement('div')
  const layer = document.createElement('div')
  const status = document.createElement('div')
  const scrim = document.createElement('div')
  const beside = document.createElement('div')

  status.setAttribute(MODAL_KEEP_ATTRIBUTE, '')
  layer.append(status, scrim)
  root.append(app, layer)
  document.body.append(root, beside)

  return { root, app, layer, status, scrim, beside }
}

describe('isolating a modal layer from the page', () => {
  it('makes everything but the layer and the path to it inert', () => {
    const { app, layer, status, scrim, root, beside } = page()

    isolateModal(scrim)

    expect(app.hasAttribute('inert')).toBe(true)
    expect(beside.hasAttribute('inert')).toBe(true)
    expect(scrim.hasAttribute('inert')).toBe(false)
    expect(layer.hasAttribute('inert')).toBe(false)
    expect(root.hasAttribute('inert')).toBe(false)
    expect(status.hasAttribute('inert')).toBe(false)
  })

  it('puts back exactly what it changed, and leaves what was already inert as it was', () => {
    const { app, beside } = page()

    beside.setAttribute('inert', '')

    const undo = isolateModal(document.body.querySelector('div > div > div:last-child') as Element)

    expect(app.hasAttribute('inert')).toBe(true)

    undo()

    expect(app.hasAttribute('inert')).toBe(false)
    expect(beside.hasAttribute('inert')).toBe(true)
  })

  it('does not touch scripts and styles, which take no focus', () => {
    const { scrim } = page()
    const script = document.createElement('script')
    const style = document.createElement('style')

    document.body.append(script, style)
    isolateModal(scrim)

    expect(script.hasAttribute('inert')).toBe(false)
    expect(style.hasAttribute('inert')).toBe(false)
  })
})
