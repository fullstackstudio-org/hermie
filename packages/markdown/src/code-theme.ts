/**
 * highlight.js scope → colour, per scheme.
 *
 * The palette is tuned against `surfaceRaised` (`#E9E9ED` light, `#28282C`
 * dark), which is what a code block sits on, so every entry keeps AA contrast
 * there rather than against the page background.
 */
export type CodeScheme = 'light' | 'dark'

const LIGHT: Record<string, string> = {
  addition: '#217844',
  attr: '#836C28',
  attribute: '#836C28',
  built_in: '#0B4F79',
  bullet: '#9B2393',
  char: '#C41A16',
  class: '#005A5B',
  code: '#3A3A44',
  comment: '#5A6673',
  deletion: '#B42332',
  doctag: '#5A6673',
  emphasis: '#3A3A44',
  formula: '#3A3A44',
  function: '#0F68A0',
  keyword: '#9B2393',
  link: '#0063CC',
  literal: '#1C00CF',
  meta: '#643820',
  name: '#9B2393',
  number: '#1C00CF',
  operator: '#5C5C65',
  params: '#3A3A44',
  property: '#836C28',
  punctuation: '#5C5C65',
  quote: '#5A6673',
  regexp: '#C41A16',
  section: '#0F68A0',
  'selector-tag': '#9B2393',
  strong: '#17171B',
  string: '#C41A16',
  subst: '#3A3A44',
  symbol: '#643820',
  tag: '#9B2393',
  title: '#0F68A0',
  type: '#005A5B',
  variable: '#4A4A55'
}

const DARK: Record<string, string> = {
  addition: '#76D995',
  attr: '#D0BF69',
  attribute: '#D0BF69',
  built_in: '#9EE8F2',
  bullet: '#FF7AB2',
  char: '#FF8170',
  class: '#ACF2E4',
  code: '#DCDCE4',
  comment: '#8A93A0',
  deletion: '#FF9AA4',
  doctag: '#8A93A0',
  emphasis: '#DCDCE4',
  formula: '#DCDCE4',
  function: '#67B7FF',
  keyword: '#FF7AB2',
  link: '#62ACFF',
  literal: '#D9C97C',
  meta: '#C5A88F',
  name: '#FF7AB2',
  number: '#D9C97C',
  operator: '#B0B0BA',
  params: '#DCDCE4',
  property: '#D0BF69',
  punctuation: '#B0B0BA',
  quote: '#8A93A0',
  regexp: '#FF8170',
  section: '#67B7FF',
  'selector-tag': '#FF7AB2',
  strong: '#F5F5F7',
  string: '#FF8170',
  subst: '#DCDCE4',
  symbol: '#C5A88F',
  tag: '#FF7AB2',
  title: '#67B7FF',
  type: '#ACF2E4',
  variable: '#C7C7D1'
}

/** `undefined` means "no scope colour" — the caller uses its own text colour. */
export function codeScopeColor(scope: string | undefined, scheme: CodeScheme): string | undefined {
  if (!scope) {
    return undefined
  }

  const map = scheme === 'dark' ? DARK : LIGHT

  return map[scope] ?? map[scope.split('.')[0] ?? ''] ?? undefined
}
