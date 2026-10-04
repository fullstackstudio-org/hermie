/**
 * What the gateway accepts as the two files of an `input.signature` answer, read after the request settled
 * (`contract/requests/README.md` section 8): a PNG begins with the PNG signature; an SVG is judged by an
 * ALLOWLIST, never by what is known to be dangerous. A port of `interactive_device.png_or_svg_problem` of the
 * fork (`_svg_problem`, `SVG_VALUES`), with a small strict XML reader where the fork uses `xml.parsers.expat`.
 *
 * The reader knows exactly the XML this allowlist can ever accept: an optional declaration at the very start, comments,
 * unprefixed elements with double- or single-quoted attributes, and whitespace. Everything else (a doctype, an
 * entity, a CDATA section, a processing instruction, a prefix, a second root, text) is refused, so where expat would
 * report an error or a handler would refuse, this refuses too.
 *
 * Only a word comes back (never a value of the file), and `null` for a file the gateway takes.
 */
import { isPySpace } from './verbatim'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
/** The only elements a drawn signature needs, written WITHOUT a prefix. */
export const SVG_ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'path',
  'polyline',
  'polygon',
  'line',
  'circle',
  'ellipse',
  'rect',
  'title',
  'desc'
])
export const SVG_MAX_DEPTH = 32

// ASCII whitespace only; keywords lowercase only; a number at most 32 characters (so a run of digits, sign, point
// and `e` is never longer, in `d` and `points` too).
const WS = '[ \\t\\r\\n]'
const NUM = '(?![0-9.eE+-]{33})[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?'
const LENGTH = `${NUM}(?:px|%|em|ex|pt|pc|mm|cm|in)?`
const SEP = '[ \\t\\r\\n,]+'
const PATH_CHARS = '(?:(?![0-9.eE+-]{33})[MmZzLlHhVvCcSsQqTtAa0-9eE+., \\t\\r\\n-])*'
const POINT_CHARS = '(?:(?![0-9.eE+-]{33})[0-9eE+., \\t\\r\\n-])*'

const COLOR_KEYWORDS = new Set(
  `none currentcolor transparent aliceblue antiquewhite aqua aquamarine azure beige bisque
black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson
cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange
darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink
deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod
gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon
lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon
mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise
mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered
orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple
rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue
slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
yellowgreen`.split(/\s+/)
)

const whole = (source: string): RegExp => new RegExp(`^(?:${source})$`)

const HEX = whole('#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})')
const RGB = whole(`rgba?\\(${WS}*${NUM}%?${WS}*(?:,${WS}*${NUM}%?${WS}*){2,3}\\)`)
const TRANSFORM_ONE = new RegExp(
  `(?:matrix|translate|scale|rotate|skewX|skewY)${WS}*\\(${WS}*${NUM}(?:${SEP}${NUM})*${WS}*\\)`,
  'y'
)

const isColor = (value: string): boolean => COLOR_KEYWORDS.has(value) || HEX.test(value) || RGB.test(value)

/** One or more of `matrix`, `translate`, `scale`, `rotate`, `skewX`, `skewY` of numbers: a walk, not one nested pattern. */
function isTransform(value: string): boolean {
  let position = 0
  let seen = false

  for (;;) {
    while (position < value.length && ' \t\r\n,'.includes(value[position] as string)) {
      position += 1
    }

    if (position === value.length) {
      return seen
    }

    TRANSFORM_ONE.lastIndex = position

    const match = TRANSFORM_ONE.exec(value)

    if (!match) {
      return false
    }

    seen = true
    position = TRANSFORM_ONE.lastIndex
  }
}

const pattern =
  (source: string) =>
  (value: string): boolean =>
    whole(source).test(value)

const isLength = pattern(LENGTH)
const isDashArray = (value: string): boolean => value === 'none' || pattern(`${LENGTH}(?:${SEP}${LENGTH})*`)(value)

/** attribute → does the value match its grammar. */
export const SVG_VALUES: Readonly<Record<string, (value: string) => boolean>> = {
  xmlns: value => value === SVG_NAMESPACE,
  version: pattern('1\\.[01]'),
  viewBox: pattern(`${NUM}(?:${SEP}${NUM}){3}`),
  width: isLength,
  height: isLength,
  preserveAspectRatio: pattern('(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?: (?:meet|slice))?'),
  transform: isTransform,
  d: pattern(PATH_CHARS),
  points: pattern(POINT_CHARS),
  x: isLength,
  y: isLength,
  x1: isLength,
  y1: isLength,
  x2: isLength,
  y2: isLength,
  cx: isLength,
  cy: isLength,
  r: isLength,
  rx: isLength,
  ry: isLength,
  fill: isColor,
  stroke: isColor,
  'fill-opacity': isLength,
  opacity: isLength,
  'stroke-opacity': isLength,
  'stroke-width': isLength,
  'stroke-miterlimit': isLength,
  'stroke-dashoffset': isLength,
  'fill-rule': pattern('nonzero|evenodd'),
  'stroke-linecap': pattern('butt|round|square'),
  'stroke-linejoin': pattern('miter|round|bevel'),
  'stroke-dasharray': isDashArray
}

class Refused extends Error {}

const refuse = (word: string): never => {
  throw new Refused(word)
}

/** Control, format, private-use and surrogate characters other than tab, CR and LF. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u

const NAME = '[A-Za-z_:][A-Za-z0-9._:-]*'
// Sticky patterns, matched at an absolute position: the file is never sliced (a megabyte of tags stays linear).
const DECLARATION = new RegExp(
  `<\\?xml${WS}+version${WS}*=${WS}*(?:"1\\.[0-9]+"|'1\\.[0-9]+')(?:${WS}+encoding${WS}*=${WS}*(?:"([A-Za-z][A-Za-z0-9._-]*)"|'([A-Za-z][A-Za-z0-9._-]*)'))?(?:${WS}+standalone${WS}*=${WS}*(?:"(?:yes|no)"|'(?:yes|no)'))?${WS}*\\?>`,
  'y'
)
const START_TAG = new RegExp(`<(${NAME})`, 'y')
const ATTRIBUTE = new RegExp(`${WS}+(${NAME})${WS}*=${WS}*(?:"([^<"]*)"|'([^<']*)')`, 'y')
const TAG_END = new RegExp(`${WS}*(/?)>`, 'y')
const END_TAG = new RegExp(`</(${NAME})${WS}*>`, 'y')

/** The match of a sticky pattern at exactly `position`, or `null`. */
function at(pattern: RegExp, text: string, position: number): RegExpExecArray | null {
  pattern.lastIndex = position

  return pattern.exec(text)
}

/** Why `text` is not a plain drawn SVG, or `null` (a word, for tests; never put in a reply). */
function svgProblem(text: string): string | null {
  if (text.includes('&') || text.toLowerCase().includes('url(')) {
    return 'reference'
  }

  for (const ch of text) {
    if (ch !== '\t' && ch !== '\r' && ch !== '\n' && HIDDEN.test(ch)) {
      return 'control'
    }
  }

  try {
    parse(text)

    return null
  } catch (error) {
    if (error instanceof Refused) {
      return error.message
    }

    return 'xml'
  }
}

function parse(text: string): void {
  let position = 0
  let depth = 0
  let rooted = false
  const stack: string[] = []

  if (text.startsWith('<?xml')) {
    const declaration = at(DECLARATION, text, 0)

    if (!declaration) {
      refuse('xml')
    } else {
      const encoding = declaration[1] ?? declaration[2]

      if (encoding !== undefined && !['utf-8', 'utf8'].includes(encoding.toLowerCase())) {
        refuse('encoding')
      }

      position = declaration[0].length
    }
  }

  while (position < text.length) {
    if (text[position] !== '<') {
      const next = text.indexOf('<', position)
      const data = text.slice(position, next === -1 ? text.length : next)

      if (data.includes(']]>')) {
        refuse('xml')
      }

      if (depth === 0) {
        // Outside the root only XML whitespace is well-formed.
        if (/[^ \t\r\n]/.test(data)) {
          refuse('xml')
        }
      } else if (![...data].every(isPySpace)) {
        refuse('text') // a drawn signature has no text: `title` and `desc` may be there, empty
      }

      position = next === -1 ? text.length : next
      continue
    }

    if (text.startsWith('<!--', position)) {
      const end = text.indexOf('-->', position + 4)
      const body = end === -1 ? '' : text.slice(position + 4, end)

      if (end === -1 || body.includes('--') || body.endsWith('-')) {
        refuse('xml')
      }

      position = end + 3
      continue
    }

    if (text.startsWith('<!', position)) {
      refuse(text.startsWith('<![CDATA[', position) ? 'cdata' : 'doctype')
    }

    if (text.startsWith('<?', position)) {
      refuse('instruction')
    }

    if (text.startsWith('</', position)) {
      const close = at(END_TAG, text, position)

      if (!close || depth === 0 || stack.pop() !== close[1]) {
        refuse('xml')
      }

      depth -= 1
      position += (close as RegExpExecArray)[0].length
      continue
    }

    const open = at(START_TAG, text, position)

    if (!open) {
      refuse('xml')
    }

    const name = (open as RegExpExecArray)[1] as string
    let cursor = position + (open as RegExpExecArray)[0].length
    const attributes = new Map<string, string>()

    for (;;) {
      const attribute = at(ATTRIBUTE, text, cursor)

      if (!attribute) {
        break
      }

      if (attributes.has(attribute[1] as string)) {
        refuse('xml') // a duplicate attribute is not well-formed
      }

      // Attribute-value normalisation: every tab, CR, LF (a CR LF pair as one) becomes a space.
      attributes.set(attribute[1] as string, (attribute[2] ?? attribute[3] ?? '').replace(/\r\n|[\t\r\n]/g, ' '))
      cursor += attribute[0].length
    }

    const tail = at(TAG_END, text, cursor)

    if (!tail) {
      refuse('xml')
    }

    cursor += (tail as RegExpExecArray)[0].length

    if (rooted && depth === 0) {
      refuse('xml') // junk after the document element
    }

    depth += 1

    if (depth > SVG_MAX_DEPTH || !SVG_ELEMENTS.has(name) || (depth === 1) !== (name === 'svg')) {
      refuse('element')
    }

    for (const [key, value] of attributes) {
      const check = SVG_VALUES[key]

      if (check === undefined || value.includes('\\') || value.toLowerCase().includes('url(')) {
        refuse('attribute')
      }

      if (value !== value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')) {
        refuse('value') // no whitespace at either end, for every attribute
      }

      if (key === 'xmlns' && depth !== 1) {
        refuse('namespace')
      }

      if (!(check as (value: string) => boolean)(value)) {
        refuse('value')
      }
    }

    if (depth === 1) {
      rooted = true

      if (attributes.get('xmlns') !== SVG_NAMESPACE) {
        refuse('namespace')
      }
    }

    if ((tail as RegExpExecArray)[1] === '/') {
      depth -= 1
    } else {
      stack.push(name)
    }

    position = cursor
  }

  if (depth !== 0 || !rooted) {
    refuse('xml')
  }
}

/**
 * `type` when a signature file (`head`: ALL of it) is not what its declared `mime` says, else `null`: a PNG begins
 * with the PNG signature; an SVG passes the allowlist (UTF-8, no doctype or entity, only the allowlisted drawing
 * elements and attributes, each value matching its grammar).
 */
export function pngOrSvgProblem(mime: string, head: Uint8Array): string | null {
  if (mime === 'image/png') {
    return PNG_SIGNATURE.every((byte, index) => head[index] === byte) ? null : 'type'
  }

  if (mime !== 'image/svg+xml') {
    return 'type'
  }

  let text: string

  try {
    // Strictly UTF-8; a leading byte order mark is fine (a second one is a format character, refused below).
    text = new TextDecoder('utf-8', { fatal: true }).decode(head)
  } catch {
    return 'type'
  }

  return svgProblem(text) === null ? null : 'type'
}

/** The word of the first problem, for a test that wants to know why (`null` for a file that passes). */
export const svgProblemWord = (head: Uint8Array): string | null => {
  try {
    return svgProblem(new TextDecoder('utf-8', { fatal: true }).decode(head))
  } catch {
    return 'encoding'
  }
}
