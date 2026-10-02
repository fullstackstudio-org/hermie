/**
 * No identifier reaches the screen.
 *
 * The cron detail printed the gateway's raw `ok` two rows under a humanised
 * `Success`, which reads as two different facts about the same run. The rule is
 * not "translate the ones we know about" — an unknown status still has to
 * arrive as words, because dropping it would lose information and printing it
 * raw is the thing this exists to stop.
 */
import { humaniseStatus } from '../src/i18n/humanise'

describe('humaniseStatus', () => {
  it('gives one word to every spelling of the same outcome', () => {
    expect(humaniseStatus('ok')).toBe('Success')
    expect(humaniseStatus('success')).toBe('Success')
    expect(humaniseStatus('OK')).toBe('Success')
    expect(humaniseStatus('failed')).toBe('Failed')
    expect(humaniseStatus('error')).toBe('Failed')
    expect(humaniseStatus('pending')).toBe('Waiting')
    expect(humaniseStatus('queued')).toBe('Waiting')
  })

  it('makes a status it has never seen readable rather than dropping it', () => {
    expect(humaniseStatus('rate_limited')).toBe('Rate limited')
    expect(humaniseStatus('needs-review')).toBe('Needs review')
  })

  it('says nothing when there is nothing to say', () => {
    expect(humaniseStatus(null)).toBeNull()
    expect(humaniseStatus(undefined)).toBeNull()
    expect(humaniseStatus('  ')).toBeNull()
  })
})
