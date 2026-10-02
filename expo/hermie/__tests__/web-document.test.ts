/**
 * The document around the browser build, and the one seam that corrects it.
 *
 * `public/index.html` is the only place this app can say anything about the
 * DOCUMENT rather than about the React tree inside it, and three of the things
 * it says are opening bids that `platform/status-bar.web.tsx` overwrites once
 * the app knows which theme won. The pair is held together by the NAMES of two
 * custom properties, and nothing else — rename one side and the page keeps the
 * default preset's colours for ever, silently, in a build nobody looks at with
 * a pinned theme.
 *
 * So this is a source test rather than a render: there is no DOM under the
 * native test renderer, and the failure this guards against is a rename, which
 * a renderer would not catch either.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const template = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
const seam = readFileSync(path.join(__dirname, '..', 'src', 'platform', 'status-bar.web.tsx'), 'utf8')

describe('the document the browser build ships in', () => {
  it.each(['--hermie-background', '--hermie-focus'])('declares %s and lets the live theme overwrite it', property => {
    // Declared for both schemes, so the value is right before the bundle runs…
    expect(template).toContain(`${property}: #`)
    expect(template.match(new RegExp(`${property}:`, 'g'))).toHaveLength(2)
    // …and named by the seam, so it is right afterwards as well.
    expect(seam).toContain(`'${property}'`)
  })

  it('rings the keyboard focus itself, at the theme accent', () => {
    // Every button, row, tab and link in the app is a real focusable element and
    // was getting the user agent's ring in the SYSTEM accent. `:focus-visible`
    // rather than `:focus`: a ring on every mouse click is noise on a chat list.
    expect(template).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--hermie-focus\)/)
    expect(template).not.toMatch(/[^-]:focus\s*\{/)
  })

  it('draws no ring around anything you type into', () => {
    /*
      The exemption, and its exact extent.

      A text box has a caret, which says where the keyboard is; a ring around it
      is a second and louder announcement of the same thing, on the element
      somebody looks at for most of the time they spend in this app. Buttons,
      rows, tabs and links have no caret, so the rule above still covers them —
      and the assertion below is deliberately about which selectors are
      exempted, because a rule that grew to `*:focus-visible { outline: none }`
      would pass a looser test and make the app undrivable without a mouse.
    */
    const withoutComments = template.replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = [...withoutComments.matchAll(/([^{}]+)\{\s*outline:\s*none;?\s*\}/g)]

    // Exactly one rule turns a ring off, and these are the only things it names.
    expect(rules).toHaveLength(1)
    expect(
      (rules[0]?.[1] ?? '')
        .split(',')
        .map(selector => selector.trim())
        .filter(Boolean)
        .sort()
    ).toEqual([
      '[contenteditable]:focus-visible',
      'input:focus-visible',
      'select:focus-visible',
      'textarea:focus-visible'
    ])
  })

  it('gives a heading element no size, weight or margin of its own', () => {
    // `accessibilityRole="header"` makes react-native-web render a real
    // `<h1>`…`<h6>`. RNW's own reset covers `Text` and not the `View` a heading
    // can also be, so the date stamp's box inherited `font-size: 1.5em` from the
    // element it had become.
    expect(template).toMatch(/h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{[^}]*font: inherit;[^}]*margin: 0;/)
  })

  it('keeps the two tokens the exporter substitutes out of its own prose', () => {
    // The substitution is a `String.replace` with a string pattern, so it
    // replaces the FIRST occurrence and stops: a token named in the comment is
    // the one that gets replaced, and the real one ships verbatim.
    for (const token of ['%LANG_ISO_CODE%', '%WEB_TITLE%']) {
      expect(template.match(new RegExp(token, 'g'))).toHaveLength(1)
    }
  })
})
