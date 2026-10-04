/**
 * The sheets that reach for the device through axe, in both colour schemes and every language, in each state a person
 * meets them in: a location, a contact before and after it is picked, a code before the camera starts, a voice note,
 * a signature pad empty and drawn. jsdom has no layout, so contrast is run in a real browser
 * (`e2e/requests-device.spec.ts`); this checks the structure: names, labels, groups, roles, the dialog's relations.
 */
import { act, fireEvent, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { setLanguageChoice } from '../../i18n/locale'
import { applyTheme } from '../../platform/theme-target'
import {
  button,
  contactFrame,
  dialog,
  type Harness,
  locationFrame,
  mount,
  raise,
  scanFrame,
  setup,
  signatureFrame,
  teardown,
  voiceFrame
} from '../../test-support/interactive-layer'
import { preloadRequestSheets } from './request-sheets'

beforeAll(async () => {
  await preloadRequestSheets()
})

let harness: Harness
const stubbed: string[] = []

beforeEach(() => {
  harness = setup()
  Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: vi.fn() }, configurable: true })
  Object.defineProperty(navigator, 'contacts', {
    value: {
      getProperties: async () => ['name', 'tel', 'email', 'address'],
      select: async () => [{ name: ['Bram de Vries'], tel: ['+31 6 12345678'] }]
    },
    configurable: true
  })
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true })
  stubbed.push('geolocation', 'contacts', 'mediaDevices')
  vi.stubGlobal('MediaRecorder', class {})
  vi.stubGlobal(
    'BarcodeDetector',
    class {
      static getSupportedFormats = async (): Promise<string[]> => ['qr_code']
    }
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => null) as never)
})

afterEach(() => {
  teardown(harness)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()

  for (const name of stubbed.splice(0)) {
    delete (navigator as unknown as Record<string, unknown>)[name]
  }

  document.documentElement.removeAttribute('data-tint')
})

async function violations(): Promise<string[]> {
  const result = await axe.run(document.documentElement, { rules: { 'color-contrast': { enabled: false } } })

  return result.violations.map(
    violation => `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
  )
}

const settle = (): Promise<void> =>
  act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 30))
  })

/** Every device sheet in turn, each checked once it is on screen. */
async function everySheet(): Promise<void> {
  mount(harness)

  const steps: [string, string, Record<string, unknown>][] = [
    ['device.location', 'srq-1', locationFrame({ precision: 'precise' })],
    ['device.contact', 'srq-2', contactFrame({ fields: ['name', 'phones', 'birthday'] })],
    ['device.scan', 'srq-3', scanFrame({ formats: ['qr', 'ean13'] })],
    ['input.file', 'srq-4', voiceFrame()],
    ['input.signature', 'srq-5', signatureFrame()]
  ]

  for (const [method, id, frame] of steps) {
    raise(harness, id, method, frame)
    // The device chunk is fetched when the first request for it is on the page.
    await screen.findByRole('dialog', { name: /^(?!\s*$).+/u })
    await vi.waitFor(() => expect(dialog().querySelector('.hm-requests__pending')).toBeNull())
    await settle()
    expect(await violations(), method).toEqual([])
    act(() => harness.gw.cancel(id, 'interrupted'))
  }
}

describe.each(['light', 'dark'] as const)('in the %s scheme', scheme => {
  beforeEach(() => applyTheme({ scheme, tint: 'blue' }))

  it('has no violation on any device sheet', everySheet)

  it('has no violation on a contact once it is picked', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'device.contact', contactFrame())
    await screen.findByRole('dialog', { name: 'A contact to share' })
    await settle()
    await act(async () => {
      fireEvent.click(button('Choose a contact'))
    })
    await settle()

    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0)
    expect(await violations()).toEqual([])
  })
})

describe.each(['nl', 'de'] as const)('in %s', locale => {
  beforeEach(async () => {
    await setLanguageChoice(locale)
  })

  it('has no violation on any device sheet', everySheet)
})
