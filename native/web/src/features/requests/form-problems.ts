/**
 * What is wrong with a form field, in words: the gateway's problem names (`field:<id>:<problem>`, contract §4) as
 * a sentence next to the field they are about, in the reader's language. The same sentences serve the page's own
 * check (`core/requests/form-values.ts`, which names the problem before anything is sent) and a refusal, so a
 * field says the same thing either way.
 */
import { boundText, decimalsOf, type Problem, zoneOf } from '../../core/requests/form-values'
import type { FormField } from '../../core/requests/interactive-types'
import { sheetStrings } from '../../i18n/sheet-strings'

const text = (): (typeof sheetStrings.interactive.form)['problems'] => sheetStrings.interactive.form.problems

/** Whether a bound of this field is a moment (an earliest and a latest) rather than a value (a lowest and a highest). */
const isMoment = (field: FormField): boolean =>
  field.kind === 'date' || field.kind === 'time' || field.kind === 'datetime' || field.kind === 'daterange'

function formatText(field: FormField): string {
  const problems = text()

  switch (field.kind) {
    case 'text':
      return problems.formatText
    case 'number':
      return problems.formatNumber
    case 'amount':
      return problems.formatAmount({ currency: field.currency, decimals: decimalsOf(field.currency) })
    case 'date':
      return problems.formatDate
    case 'time':
      return problems.formatTime
    case 'datetime':
      return problems.formatDatetime
    case 'daterange':
      return problems.formatRange
    default:
      return problems.other
  }
}

/**
 * The sentence for `problem` on `field`. `unknown` is a problem name this build has no sentence for (a later
 * contract's); `device` is this device's zone, for a datetime whose request names none.
 */
export function problemText(field: FormField, problem: Problem | 'unknown', device: string): string {
  const problems = text()

  switch (problem) {
    case 'missing':
      return problems.missing
    case 'type':
      return problems.type
    case 'format':
      return formatText(field)
    case 'too_long':
      return field.kind === 'text' ? problems.tooLong({ max: field.maxLength }) : problems.other
    case 'zone':
      return problems.zone({ zone: zoneOf(field, device) })
    case 'offset':
      return problems.offset
    case 'order':
      return problems.order
    case 'not_an_option':
      return problems.notAnOption
    case 'duplicate':
      return problems.duplicate
    case 'below_min': {
      const min = boundText(field, 'min', device)

      return min === ''
        ? problems.belowMinPlain
        : isMoment(field)
          ? problems.belowMinWhen({ min })
          : problems.belowMinValue({ min })
    }
    case 'above_max': {
      const max = boundText(field, 'max', device)

      return max === ''
        ? problems.aboveMaxPlain
        : isMoment(field)
          ? problems.aboveMaxWhen({ max })
          : problems.aboveMaxValue({ max })
    }
    case 'not_integer':
      return problems.notInteger
    case 'step':
      return field.kind === 'number' && field.step !== undefined
        ? problems.step({ step: String(field.step), from: String(field.min ?? 0) })
        : problems.other
    case 'too_few':
      return field.kind === 'choice' && field.minSelected !== undefined
        ? problems.tooFew({ min: field.minSelected })
        : problems.other
    case 'too_many':
      return field.kind === 'choice' && field.maxSelected !== undefined
        ? problems.tooMany({ max: field.maxSelected })
        : problems.other
    default:
      return problems.other
  }
}
