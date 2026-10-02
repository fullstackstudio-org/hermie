/**
 * Hand-written templates for the string functions the probes in `convert.ts`
 * cannot read.
 *
 * Keep this list short and honest. An entry is only allowed where the
 * mechanical conversion FAILS for that language: `npm run i18n` refuses an
 * override the probes could have produced themselves (it would go stale
 * silently the next time the TypeScript changed), and it checks every override
 * against the TypeScript function over the same argument grid as a mechanical
 * template — so when somebody edits one of these functions, the export fails
 * here until the template below says the same thing again.
 *
 * The template language is described at the top of `template.ts`.
 */
import type { Locale } from '../../expo/hermie/src/i18n/locales'
import type { Template } from './template'

export interface Override {
  /** Why the probes cannot do this one. Shown by `npm run i18n` and kept in the catalogue. */
  reason: string
  /** Per language. A language left out is converted mechanically. */
  templates: Partial<Record<Locale, Template>>
}

export const OVERRIDES: Readonly<Record<string, Override>> = {
  'chat.clarify.outcome': {
    reason:
      'Compares two arguments (answered >= total) before it looks at the count, which no probe of one argument at a time can see.',
    templates: {
      en: {
        kind: 'select',
        test: { op: 'gte', left: 'answered', right: 'total' },
        then: { kind: 'plural', arg: 'total', forms: { one: 'Answered', other: 'Answered all {total}' } },
        else: 'Answered {answered} of {total}'
      },
      nl: {
        kind: 'select',
        test: { op: 'gte', left: 'answered', right: 'total' },
        then: { kind: 'plural', arg: 'total', forms: { one: 'Beantwoord', other: 'Alle {total} beantwoord' } },
        else: '{answered} van {total} beantwoord'
      },
      de: {
        kind: 'select',
        test: { op: 'gte', left: 'answered', right: 'total' },
        then: { kind: 'plural', arg: 'total', forms: { one: 'Beantwortet', other: 'Alle {total} beantwortet' } },
        else: '{answered} von {total} beantwortet'
      }
    }
  }
}
