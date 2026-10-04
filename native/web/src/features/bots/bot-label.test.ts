import { describe, expect, it } from 'vitest'

import { BOT_NAME_LIMIT } from '../../core/requests/secure-input'
import { botLabel } from './bot-label'

describe('a bot’s name as the page shows it', () => {
  it('is the display name, unchanged when there is nothing to clean', () => {
    expect(botLabel('Dr. Researcher', 'researcher')).toBe('Dr. Researcher')
  })

  it('drops direction overrides, isolates and zero-width characters', () => {
    expect(botLabel('\u202EEvil\u2060\u2066 name\u2069', 'evil')).toBe('Evil name')
  })

  it('bounds an overlong name with an ellipsis', () => {
    const label = botLabel('x'.repeat(500), 'long')

    expect([...label].length).toBeLessThanOrEqual(BOT_NAME_LIMIT + 1)
    expect(label.endsWith('…')).toBe(true)
  })

  it('falls back to the route name, cleaned, when the display name is missing or has nothing visible', () => {
    expect(botLabel(undefined, 'ghost')).toBe('ghost')
    expect(botLabel('\u2060\u202E', 'ghost\u2060')).toBe('ghost')
  })
})
