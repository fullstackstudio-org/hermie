// What the build does with non-ASCII text that is left in a JavaScript chunk
// (`asciiOnlyScripts` in `vite.config.ts` calls this).
//
// `esbuild.charset: 'ascii'` escapes non-ASCII in strings, templates and
// identifiers, but not inside a regular expression literal, so a quote like
// U+201D in a character class would reach the bundle as a non-ASCII byte and
// fail the plugin scanner. Writing it as `\uXXXX` means the same character in a
// string, a template and a pattern, so nothing about the program changes, but
// only when the text is replaced by what it means:
//
//   - after an ODD run of backslashes the character is itself escaped (a
//     pattern written as backslash, then the character), and putting a `\uXXXX`
//     there would read as an escaped backslash followed by the letters `u201c`.
//     The text no longer means what it did, so the build fails.
//   - in a TAGGED template the tag receives the raw text (`String.raw`), which
//     an escape would change, so the build fails there too.
//
// One difference is accepted and not detectable here: a regular expression
// literal's `.source` shows the escape, not the character. Nothing in the
// client reads it.

const NON_ASCII = /[^\t\n\r\x20-\x7e]/gu

/** One `\uXXXX` per UTF-16 unit: a character outside the BMP becomes the surrogate pair, which every literal reads as it. */
function escape(char) {
  return Array.from({ length: char.length }, (_, at) => `\\u${char.charCodeAt(at).toString(16).padStart(4, '0')}`).join(
    ''
  )
}

/**
 * The `[start, end)` ranges of every template's literal text that a tag receives.
 *
 * @param {unknown} program an ESTree program (`this.parse` of a Rollup plugin)
 * @returns {Array<[number, number]>}
 */
function taggedTemplateText(program) {
  const ranges = []
  const visit = node => {
    if (Array.isArray(node)) {
      node.forEach(visit)
    } else if (typeof node === 'object' && node !== null) {
      if (node.type === 'TaggedTemplateExpression') {
        for (const part of node.quasi.quasis) {
          ranges.push([part.start, part.end])
        }
      }
      Object.values(node).forEach(visit)
    }
  }

  visit(program)

  return ranges
}

/**
 * Writes every non-ASCII character of `code` as `\uXXXX`, or throws when that
 * would not mean the same thing (see the top of this file).
 *
 * @param {string} code the chunk
 * @param {(code: string) => unknown} parse the parser of the build (`this.parse`)
 * @param {string} [name] what to call the chunk in an error
 * @returns {string}
 */
export function escapeNonAscii(code, parse, name = 'chunk') {
  const found = [...code.matchAll(NON_ASCII)]

  if (found.length === 0) {
    return code
  }

  const tagged = taggedTemplateText(parse(code))
  const where = at =>
    `${name}: non-ASCII character U+${code.codePointAt(at).toString(16).toUpperCase()} at offset ${at}`

  for (const match of found) {
    const at = match.index

    if (tagged.some(([start, end]) => at >= start && at < end)) {
      throw new Error(`${where(at)} is in a tagged template, whose raw text an escape would change`)
    }

    let run = 0
    while (code[at - run - 1] === '\\') {
      run += 1
    }
    if (run % 2 === 1) {
      throw new Error(`${where(at)} follows a backslash, so it is already escaped and \\u would change its meaning`)
    }
  }

  return code.replace(NON_ASCII, escape)
}
