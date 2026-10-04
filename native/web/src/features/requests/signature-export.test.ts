// @vitest-environment node
/**
 * What a drawn signature becomes: the SVG held to the gateway's own allowlist (`contract/requests` section 8, judged by
 * the fake gateway's port of the fork's reader), over the contract's example strokes and over thousands of random ones
 * (a pad reports whatever a device does: points outside the pad, NaN, huge and tiny numbers, a single touch), and the
 * statement's SHA-256 held to the contract's example hashes and to the platform's.
 */
import { createHash } from 'node:crypto'

import { pngOrSvgProblem, svgProblemWord } from '@hermie/fake-gateway'
import { describe, expect, it } from 'vitest'

import examplesSource from '../../../../../contract/requests/examples.json?raw'
import {
  extend,
  inkOf,
  MAX_POINTS,
  MIN_INK,
  PAD,
  type Point,
  signatureSvg,
  statementSha256,
  strokePath,
  type Stroke
} from './signature-export'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** The gateway's verdict on an SVG file's text: `null` when it takes it. */
const problem = (svg: string): string | null => svgProblemWord(bytes(svg))

/** A deterministic stream of numbers in `[0, 1)`: the same strokes on every run, so a failure can be found again. */
function random(seed: number): () => number {
  let state = seed >>> 0

  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0

    return state / 2 ** 32
  }
}

const NASTY = [
  NaN,
  Infinity,
  -Infinity,
  -0,
  0,
  1e21,
  -1e21,
  1e-9,
  599.99999,
  600.05,
  200.04,
  -0.04,
  123456789.123456789
]

/** A stroke the way a hostile or broken device might make one. */
function strokeFrom(next: () => number, length: number): Stroke {
  return Array.from({ length }, (): Point => {
    const pick = (span: number): number => {
      const roll = next()

      // Mostly on the pad, sometimes off it, sometimes something no pointer should report.
      return roll < 0.08
        ? (NASTY[Math.floor(next() * NASTY.length)] as number)
        : roll < 0.2
          ? (next() - 0.5) * span * 6
          : next() * span
    }

    return { x: pick(PAD.width), y: pick(PAD.height) }
  })
}

const EXAMPLE: Stroke[] = [
  [
    { x: 40, y: 150 },
    { x: 80, y: 60 },
    { x: 120, y: 140 },
    { x: 160, y: 70 },
    { x: 200, y: 130 }
  ],
  [
    { x: 220, y: 100 },
    { x: 400, y: 100 }
  ],
  [{ x: 300, y: 40 }]
]

describe('the SVG of a signature', () => {
  it('is what the gateway takes, for a drawing with strokes, a dot, and nothing at all', () => {
    expect(problem(signatureSvg(EXAMPLE))).toBeNull()
    expect(problem(signatureSvg([[{ x: 10, y: 10 }]]))).toBeNull()
    expect(problem(signatureSvg([]))).toBeNull()
    expect(pngOrSvgProblem('image/svg+xml', bytes(signatureSvg(EXAMPLE)))).toBeNull()
  })

  it('is not an accident of the check: the same check refuses what the contract forbids', () => {
    const good = signatureSvg(EXAMPLE)

    expect(problem(good.replace('stroke="#000000"', 'stroke="currentColor"'))).not.toBeNull()
    expect(problem(good.replace('<g ', '<g onclick="x" '))).not.toBeNull()
    expect(problem(good.replace('M', 'M&amp;'))).not.toBeNull()
    expect(problem(good.replace('<rect', '<text>hi</text><rect'))).not.toBeNull()
    expect(problem(good.replace('d="M', 'd="url(#a)M'))).not.toBeNull()
    expect(problem(good.replace('<svg ', '<svg:svg '))).not.toBeNull()
    expect(problem(`<?xml version="1.0" encoding="UTF-16"?>${good}`)).not.toBeNull()
    expect(problem(good.replace('stroke-width="2.5"', `stroke-width="${'1'.repeat(33)}"`))).not.toBeNull()
  })

  it('is one line of plain ASCII with nothing it does not need', () => {
    const svg = signatureSvg(EXAMPLE)

    expect(svg).toMatch(/^[\x20-\x7e]+$/u)
    expect(svg).not.toMatch(/[&\\]|url\(|<\?|<!|\n|\r|\t/u)
    expect([...svg.matchAll(/<([a-z]+)/gu)].map(match => match[1])).toEqual([
      'svg',
      'rect',
      'g',
      'path',
      'path',
      'path'
    ])
    // Every attribute is one the contract lists (and written as it is, `viewBox` being SVG's own camel case).
    const names = [...svg.matchAll(/ ([A-Za-z-]+)="/gu)].map(match => match[1])

    expect(new Set(names)).toEqual(
      new Set([
        'xmlns',
        'width',
        'height',
        'viewBox',
        'fill',
        'stroke',
        'stroke-width',
        'stroke-linecap',
        'stroke-linejoin',
        'd'
      ])
    )
  })

  it('holds for random strokes, including the ones no pointer should ever report (property test)', () => {
    const next = random(20_261_004)

    for (let round = 0; round < 400; round += 1) {
      const strokes = Array.from({ length: 1 + Math.floor(next() * 6) }, () =>
        strokeFrom(next, 1 + Math.floor(next() * (round % 7 === 0 ? 400 : 12)))
      )
      const svg = signatureSvg(strokes)

      expect(problem(svg), `round ${round}: ${svg.slice(0, 200)}`).toBeNull()

      // Every coordinate in the file is on the pad, and a number of at most a few characters.
      for (const path of svg.matchAll(/ d="([^"]*)"/gu)) {
        for (const run of (path[1] as string).match(/[0-9.]+/gu) ?? []) {
          expect(run.length, run).toBeLessThanOrEqual(10)
        }

        const numbers = (path[1] as string).match(/[0-9.]+/gu)?.map(Number) ?? []

        expect(Math.max(...numbers, 0)).toBeLessThanOrEqual(PAD.width)
      }
    }
  })

  it('holds for a scribble of the most points a pad takes, and stays far below a megabyte', () => {
    const next = random(7)
    const long: Point[] = Array.from({ length: MAX_POINTS }, () => ({ x: next() * PAD.width, y: next() * PAD.height }))
    const svg = signatureSvg([long])

    expect(problem(svg)).toBeNull()
    expect(bytes(svg).length).toBeLessThan(1_048_576)
  })

  it('leaves a stroke with no usable point out of the file', () => {
    const svg = signatureSvg([
      [{ x: NaN, y: 1 }],
      [
        { x: 10, y: 10 },
        { x: Infinity, y: 4 }
      ]
    ])

    expect(svg.match(/<path /gu)?.length).toBe(1)
    expect(problem(svg)).toBeNull()
  })
})

describe('a stroke’s path', () => {
  it('is a dot for one point, a line for two, and a curve through the midpoints for more', () => {
    expect(strokePath([{ x: 10, y: 20 }])).toBe('M10 20L10 20')
    expect(
      strokePath([
        { x: 10, y: 20 },
        { x: 30.04, y: 40.06 }
      ])
    ).toBe('M10 20L30 40.1')
    expect(
      strokePath([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 0 }
      ])
    ).toBe('M0 0Q10 10 15 5L20 0')
    expect(strokePath([])).toBe('')
  })

  it('clamps to the pad, rounds to a tenth and never writes -0 or an exponent', () => {
    expect(
      strokePath([
        { x: -5, y: -0.04 },
        { x: 1e21, y: 1e-9 }
      ])
    ).toBe('M0 0L600 0')
  })
})

describe('what a pad takes', () => {
  it('skips a sample that is no step from the last one, and one that is not a point', () => {
    const start: Stroke = [{ x: 10, y: 10 }]

    expect(extend(start, { x: 10.2, y: 10.1 })).toBe(start)
    expect(extend(start, { x: NaN, y: 3 })).toBe(start)
    expect(extend(start, { x: 11, y: 10 })).toEqual([
      { x: 10, y: 10 },
      { x: 11, y: 10 }
    ])
  })

  it('counts ink as the length of the strokes, so a stray touch is not a signature', () => {
    expect(inkOf([[{ x: 5, y: 5 }]])).toBe(0)
    expect(
      inkOf([
        [
          { x: 0, y: 0 },
          { x: 3, y: 4 }
        ]
      ])
    ).toBe(5)
    expect(inkOf(EXAMPLE)).toBeGreaterThan(MIN_INK)
    expect(
      inkOf([
        [
          { x: 0, y: 0 },
          { x: NaN, y: 4 }
        ]
      ])
    ).toBe(0)
  })
})

describe('the statement’s fingerprint', () => {
  const contract = JSON.parse(examplesSource) as {
    methods: Record<
      string,
      {
        frames: { id: string; params: { statement: string } }[]
        answers: { name: string; result: { statement_sha256?: string } }[]
        invalid_answers: { name: string; result: { statement_sha256?: string } }[]
      }
    >
  }
  const signature = contract.methods['input.signature'] as (typeof contract.methods)[string]
  const lease = signature.frames.find(frame => frame.id === 'req_sig_lease')?.params.statement as string

  it('is the contract’s own for the contract’s own statement', async () => {
    const signed = signature.answers.find(answer => answer.name === 'signed')?.result.statement_sha256

    expect(await statementSha256(lease)).toBe(signed)
  })

  it('is the SHA-256 of the UTF-8 bytes exactly as they came: no trimming, no normalising, no new line endings', async () => {
    const withNewline = signature.invalid_answers.find(answer => answer.name === 'hash_of_statement_with_newline')
    const texts = [
      lease,
      `${lease}\n`,
      `${lease} `,
      ` ${lease}`,
      'Café',
      'Café',
      'a\r\nb',
      'a\nb',
      'Zoë \u{1F600} 署名',
      'x'.repeat(500)
    ]

    for (const text of texts) {
      expect(await statementSha256(text), JSON.stringify(text)).toBe(
        createHash('sha256').update(text, 'utf8').digest('hex')
      )
    }

    // NFC and NFD of the same word are two different statements; a trailing newline is another.
    expect(await statementSha256('Café')).not.toBe(await statementSha256('Café'))
    expect(await statementSha256(`${lease}\n`)).toBe(withNewline?.result.statement_sha256)
    expect(await statementSha256(lease)).not.toBe(withNewline?.result.statement_sha256)
  })

  it('is lower case hex of 64 digits', async () => {
    expect(await statementSha256('x')).toMatch(/^[0-9a-f]{64}$/u)
  })
})
