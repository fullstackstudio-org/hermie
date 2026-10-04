/**
 * The reader of a `review.diff` frame (`contract/requests` §7), held to the contract's examples and to every way a
 * frame can break §7 and §7.1: what a person is shown is exactly what the gateway built, and a frame that says one thing
 * and does another (an anchor the lines contradict, a header whose counts are not the lines', a line the eye cannot see)
 * is refused instead of drawn. And the answer: every hunk decided, `approved` only with at least one approved.
 */
import { describe, expect, it } from 'vitest'

import examplesSource from '../../../../../contract/requests/examples.json?raw'
import {
  composeDiffAnswer,
  DIFF_LIMITS,
  type DiffAsk,
  diffLayoutProblem,
  type DiffLine,
  hunkAnchor,
  lineCharProblem,
  parseHunkHeader,
  readInteractiveParams
} from './interactive-types'

interface Frame {
  id: string
  params: Record<string, unknown>
}

const examples = JSON.parse(examplesSource) as {
  methods: Record<
    string,
    {
      frames: Frame[]
      invalid_frames: { name: string; params: Record<string, unknown> }[]
      answers: { name: string; request: string; result: Record<string, unknown> }[]
    }
  >
}

const diff = examples.methods['review.diff']

if (!diff) {
  throw new Error('the contract has no review.diff')
}

const frameOf = (id: string): Record<string, unknown> => {
  const frame = diff.frames.find(entry => entry.id === id)

  if (!frame) {
    throw new Error(`example gone: ${id}`)
  }

  return frame.params
}

const read = (params: Record<string, unknown>): ReturnType<typeof readInteractiveParams> =>
  readInteractiveParams('review.diff', params)

const asked = (params: Record<string, unknown>): DiffAsk => {
  const result = read(params)

  if (!result.ok || result.ask.method !== 'review.diff') {
    throw new Error('refused')
  }

  return result.ask
}

/** A frame of one file and the given hunks (the settings example's envelope). */
const frame = (hunks: unknown[], patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...frameOf('req_diff_settings'),
  hunks,
  ...patch
})

// Four lines (two context, one removed, one added): old 3, new 3.
const MIDDLE = { header: '@@ -10,3 +10,3 @@', lines: [' before', '-old', '+new', ' after'] }

/** A hunk in the middle of a file: context around one changed line (`@@ -10,3 +10,3 @@`). */
const hunk = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'h1', ...MIDDLE, ...patch })

/** A line as the reader reads it, from its text with the marker. */
const line = (text: string): DiffLine =>
  text.startsWith('+')
    ? { type: 'added', text: text.slice(1) }
    : text.startsWith('-')
      ? { type: 'removed', text: text.slice(1) }
      : { type: 'context', text: text.slice(1) }

const refused = (hunks: unknown[], patch: Record<string, unknown> = {}): boolean => !read(frame(hunks, patch)).ok

describe('the contract’s review.diff examples', () => {
  it('reads the settings change hunk by hunk, unpinned', () => {
    const ask = asked(frameOf('req_diff_settings'))

    expect(ask).toMatchObject({
      method: 'review.diff',
      kind: 'modify',
      path: 'app/settings.py',
      optional: false,
      actingUser: 'Ada'
    })
    expect(ask.oldPath).toBeUndefined()
    expect(ask.hunks.map(entry => entry.id)).toEqual(['h1', 'h2'])
    expect(ask.hunks[0]?.header).toBe('@@ -3,4 +3,4 @@ class Settings:')
    expect(ask.hunks[0]?.anchor).toBeUndefined()
    expect(ask.hunks[1]?.anchor).toBeUndefined()
    expect(ask.hunks[0]?.lines.map(line => line.type)).toEqual(['context', 'removed', 'added', 'context', 'context'])
    expect(ask.hunks[0]?.lines[1]).toEqual({ type: 'removed', text: '    currency = "USD"' })
  })

  it('reads a new file as the whole file, with the no-newline note', () => {
    const ask = asked(frameOf('req_diff_new_file'))

    expect(ask.kind).toBe('new')
    expect(ask.hunks[0]?.anchor).toBe('both')
    expect(ask.hunks[0]?.lines.map(line => line.type)).toEqual(['added', 'added', 'note'])
  })

  it('reads a rename with both paths, a deleted file as the whole file and an append as the end', () => {
    const rename = asked(frameOf('req_diff_rename'))

    expect(rename).toMatchObject({ kind: 'rename', path: 'app/accounts.py', oldPath: 'app/users.py' })
    expect(rename.hunks[0]?.anchor).toBe('start')
    expect(asked(frameOf('req_diff_delete')).hunks[0]?.anchor).toBe('both')
    expect(asked(frameOf('req_diff_append')).hunks[0]?.anchor).toBe('end')
  })

  it('keeps a tab a tab, as the contract’s Go example has it', () => {
    const ask = asked(frameOf('req_diff_go'))

    expect(ask.hunks[0]?.lines[1]).toEqual({ type: 'context', text: '\tfor i := 0; i < 3; i++ {' })
    expect(ask.hunks[0]?.lines[2]).toEqual({ type: 'removed', text: '\t\tfmt.Println(i)' })
  })

  it('refuses every invalid frame of the examples', () => {
    expect(diff.invalid_frames.length).toBeGreaterThan(15)

    for (const entry of diff.invalid_frames) {
      expect(read(entry.params).ok, entry.name).toBe(false)
    }
  })

  it('declines a version it does not know with its own reason', () => {
    expect(read({ ...frameOf('req_diff_settings'), v: 2 })).toEqual({ ok: false, reason: 'unsupported_version' })
  })

  it('has no Skip: a diff is rejected, never skipped', () => {
    const { optional: _optional, ...bare } = frameOf('req_diff_settings')

    expect(asked(bare).optional).toBe(false)
  })
})

describe('the answers of the examples', () => {
  const asks = (): Record<string, DiffAsk> =>
    Object.fromEntries(diff.frames.map(entry => [entry.id, asked(entry.params)]))

  it('are exactly what composeDiffAnswer builds from the decisions', () => {
    const byId = asks()

    for (const answer of diff.answers) {
      const ask = byId[answer.request]
      const result = answer.result as { decision: string; hunks: Record<string, string> }

      expect(ask, answer.name).toBeDefined()
      expect(
        composeDiffAnswer(ask as DiffAsk, result.hunks as Record<string, 'approved' | 'rejected'>),
        answer.name
      ).toEqual(result)
    }
  })
})

describe('composeDiffAnswer', () => {
  const ask = asked(frameOf('req_diff_settings'))

  it('says nothing while a hunk is undecided: a hunk is never decided for the person', () => {
    expect(composeDiffAnswer(ask, {})).toBeNull()
    expect(composeDiffAnswer(ask, { h1: 'approved' })).toBeNull()
    expect(composeDiffAnswer(ask, { h1: 'approved', h2: undefined })).toBeNull()
  })

  it('approves what the person approved, and rejects the rest, by id', () => {
    expect(composeDiffAnswer(ask, { h1: 'approved', h2: 'rejected' })).toEqual({
      decision: 'approved',
      hunks: { h1: 'approved', h2: 'rejected' }
    })
    expect(composeDiffAnswer(ask, { h1: 'rejected', h2: 'approved' })).toEqual({
      decision: 'approved',
      hunks: { h1: 'rejected', h2: 'approved' }
    })
    expect(composeDiffAnswer(ask, { h1: 'approved', h2: 'approved' })?.decision).toBe('approved')
  })

  it('is rejected when every hunk is: `approved` always has a hunk to apply', () => {
    expect(composeDiffAnswer(ask, { h1: 'rejected', h2: 'rejected' })).toEqual({
      decision: 'rejected',
      hunks: { h1: 'rejected', h2: 'rejected' }
    })
  })

  it('follows the request’s order and leaves out an id the request does not have', () => {
    const answer = composeDiffAnswer(ask, { h2: 'rejected', h9: 'approved', h1: 'approved' })

    expect(Object.keys(answer?.hunks ?? {})).toEqual(['h1', 'h2'])
    expect(answer?.hunks).not.toHaveProperty('h9')
  })

  it('carries nothing but the decision and the hunks: no text, no line, no comment', () => {
    expect(Object.keys(composeDiffAnswer(ask, { h1: 'approved', h2: 'approved' }) ?? {}).sort()).toEqual([
      'decision',
      'hunks'
    ])
  })
})

describe('what a hunk is pinned to (README §7)', () => {
  it('reads the header’s numbers, a missing count as 1, and the section text', () => {
    expect(parseHunkHeader('@@ -3,4 +5,6 @@ class Settings:')).toEqual({
      oldStart: 3,
      oldCount: 4,
      newStart: 5,
      newCount: 6,
      section: 'class Settings:'
    })
    expect(parseHunkHeader('@@ -3 +3,2 @@')).toMatchObject({ oldCount: 1, newCount: 2, section: '' })
    expect(parseHunkHeader('@@ nonsense @@')).toBeNull()
    expect(parseHunkHeader('@@ -3,4 +3,4 @@ ')).toBeNull()
    expect(parseHunkHeader('@@ -3,4 +3,4 @@\nx')).toBeNull()
  })

  it('is the start when the old side starts at line 0 or 1', () => {
    expect(hunkAnchor({ header: '@@ -1,3 +1,3 @@', lines: MIDDLE.lines.map(text => line(text)) })).toBe('start')
    expect(hunkAnchor({ header: '@@ -0,0 +1 @@', lines: [{ type: 'added', text: 'a' }] })).toBe('both')
    expect(hunkAnchor({ header: '@@ -2,3 +2,3 @@', lines: MIDDLE.lines.map(text => line(text)) })).toBeUndefined()
  })

  it('is the end when no context line follows the last change, the no-newline note aside', () => {
    const append = [line(' before'), line('+new')]

    expect(hunkAnchor({ header: '@@ -9,1 +9,2 @@', lines: append })).toBe('end')
    expect(hunkAnchor({ header: '@@ -9,1 +9,2 @@', lines: [...append, { type: 'note' }] })).toBe('end')
    expect(
      hunkAnchor({ header: '@@ -9,2 +9,2 @@', lines: [line('-old'), line('+new'), line(' after')] })
    ).toBeUndefined()
  })

  it('is shown whether or not the gateway said so: the lines decide what is true', () => {
    const ask = asked(frame([{ ...hunk(), header: '@@ -10,1 +10,2 @@', lines: [' before', '+new'] }]))

    expect(ask.hunks[0]?.anchor).toBe('end')
  })

  it('refuses an anchor the lines contradict', () => {
    // `start` for a hunk that starts at line 10; `end` with a context line after the change; `both` for a middle hunk.
    expect(refused([{ ...hunk(), ...MIDDLE, anchor: 'start' }])).toBe(true)
    expect(refused([{ ...hunk(), ...MIDDLE, anchor: 'end' }])).toBe(true)
    expect(refused([{ ...hunk(), ...MIDDLE, anchor: 'both' }])).toBe(true)
    expect(refused([{ ...hunk(), header: '@@ -1,3 +1,3 @@', lines: MIDDLE.lines, anchor: 'both' }])).toBe(true)
    expect(refused([{ ...hunk(), ...MIDDLE, anchor: 'start' }, hunk({ id: 'h2' })])).toBe(true)
    expect(refused([{ ...hunk(), header: '@@ -1,3 +1,3 @@', lines: MIDDLE.lines, anchor: 'start' }])).toBe(false)
  })

  it('only lets the last hunk end the file', () => {
    const tail = { id: 'h1', header: '@@ -10,1 +10,2 @@', lines: [' before', '+new'] }

    expect(refused([tail, hunk({ id: 'h2', header: '@@ -30,3 +31,3 @@' })])).toBe(true)
    expect(refused([hunk({ id: 'h1' }), { ...tail, id: 'h2', header: '@@ -30,1 +31,2 @@' }])).toBe(false)
    expect(refused([hunk({ id: 'h1' }), { ...tail, id: 'h2', header: '@@ -30,1 +31,2 @@', anchor: 'end' }])).toBe(false)
  })
})

describe('what a line is allowed to be (README §7.1)', () => {
  const withLine = (text: string, marker = '+'): unknown[] => [
    { id: 'h1', header: '@@ -10,2 +10,3 @@', lines: [' before', `${marker}${text}`, ' after'].slice(0, 3) }
  ]
  // `-10,2 +10,3` holds one added line between two context lines.
  const ok = (text: string): boolean => read(frame(withLine(text))).ok

  it('takes ordinary code, a blank line, a tab and an astral character', () => {
    expect(ok('const a = 1')).toBe(true)
    expect(ok('\tindented with a tab')).toBe(true)
    expect(ok('x := "😀"')).toBe(true)
    expect(ok('a  b')).toBe(true)
  })

  it.each([
    ['a carriage return', 'a\rb'],
    ['a line feed', 'a\nb'],
    ['a vertical tab', 'a\u000bb'],
    ['a line separator', 'a b'],
    ['a right-to-left override', 'a‮b'],
    ['a bidi isolate', 'a⁧b'],
    ['a zero-width space', 'a​b'],
    ['a zero-width joiner', 'a‍b'],
    ['a byte order mark', 'a﻿b'],
    ['a no-break space', 'a b'],
    ['a blank Hangul letter', 'aㅤb'],
    ['a variation selector', 'a️b'],
    ['a tag character', 'a\u{e0041}b'],
    ['a control character', 'a\u0007b'],
    ['an unassigned code point', 'a\u{378}b'],
    ['five combining marks in a row', 'á̂̃̄̅b'],
    ['whitespace at the end', 'a '],
    ['a tab at the end', 'a\t'],
    ['a combining mark at the start', '́a'],
    ['a combining mark right after a space', 'a ́b'],
    ['a combining mark right after a tab', 'a\t́b']
  ])('refuses %s', (_name, text) => {
    expect(ok(text)).toBe(false)
  })

  it('refuses a line without a marker, with a marker the contract does not have, and an empty one', () => {
    expect(refused([{ ...hunk(), lines: ['plain', '-old', '+new'] }])).toBe(true)
    expect(refused([{ ...hunk(), lines: ['*star', '-old', '+new'] }])).toBe(true)
    expect(refused([{ ...hunk(), lines: ['', '-old', '+new'] }])).toBe(true)
    expect(refused([{ ...hunk(), lines: [7, '-old', '+new'] }])).toBe(true)
  })

  it('counts at most 500 code points in a line, the marker included, a tab as one', () => {
    expect(ok('x'.repeat(499))).toBe(true)
    expect(ok('x'.repeat(500))).toBe(false)
    expect(ok('😀'.repeat(499))).toBe(true)
    expect(ok('😀'.repeat(500))).toBe(false)
    expect(ok(`${'\t'.repeat(10)}${'x'.repeat(489)}`)).toBe(true)
  })

  it('takes a blank context line, a single space', () => {
    expect(read(frame([{ id: 'h1', header: '@@ -10,2 +10,3 @@', lines: [' ', '+new', ' after'] }])).ok).toBe(true)
  })
})

describe('layout, in columns (README §7.1)', () => {
  const tabs = (count: number): string => '\t'.repeat(count)

  it('counts a space as one column, a tab to the next multiple of 8, any other character as one', () => {
    expect(diffLayoutProblem(`${tabs(12)}x`)).toBe(false)
    expect(diffLayoutProblem(`${tabs(13)}x`)).toBe(true)
    expect(diffLayoutProblem(`${' '.repeat(96)}x`)).toBe(false)
    expect(diffLayoutProblem(`${' '.repeat(97)}x`)).toBe(true)
    // A tab after three columns reaches 8, not 11.
    expect(diffLayoutProblem(`abc\t${' '.repeat(26)}x`)).toBe(false)
    expect(diffLayoutProblem(`abc\t${' '.repeat(28)}x`)).toBe(true)
  })

  it('bounds a run inside the line to 32 columns, counted from where it starts', () => {
    expect(diffLayoutProblem(`a${' '.repeat(32)}b`)).toBe(false)
    expect(diffLayoutProblem(`a${' '.repeat(33)}b`)).toBe(true)
    expect(diffLayoutProblem(`a${tabs(4)}b`)).toBe(false)
    // Four tab stops from column 1 reach column 32: 31 columns. A fifth is 39.
    expect(diffLayoutProblem(`a${tabs(5)}b`)).toBe(true)
    // 400 tabs inside a line, and the mixed ` \t` repeated, push the text far out of view.
    expect(diffLayoutProblem(`a${tabs(400)}b`)).toBe(true)
    expect(diffLayoutProblem(`a${' \t'.repeat(40)}b`)).toBe(true)
  })

  it('bounds all the whitespace of a line together to 160 columns, the indent included', () => {
    // Six tab levels (48), then runs of 32 separated by a character: 48 + 3×32 = 144; a fourth makes 176.
    const run = `${' '.repeat(32)}x`

    expect(diffLayoutProblem(`${tabs(6)}x${run}${run}${run}`)).toBe(false)
    expect(diffLayoutProblem(`${tabs(6)}x${run}${run}${run}${run}`)).toBe(true)
  })

  it('lets six tab levels, a Python body eight 4-space levels deep and three tab-aligned comments through', () => {
    expect(diffLayoutProblem(`${tabs(6)}return x`)).toBe(false)
    expect(diffLayoutProblem(`${' '.repeat(32)}return x`)).toBe(false)
    expect(diffLayoutProblem('a = 1\t# one\t# two\t# three')).toBe(false)
  })

  it('refuses a frame whose line breaks a limit, and takes the same line within them', () => {
    const lines = (text: string): unknown[] => [
      { id: 'h1', header: '@@ -10,2 +10,3 @@', lines: [' before', `+${text}`, ' after'] }
    ]

    expect(read(frame(lines(`${tabs(12)}x`))).ok).toBe(true)
    expect(read(frame(lines(`${tabs(13)}x`))).ok).toBe(false)
    expect(read(frame(lines(`a${tabs(400)}b`))).ok).toBe(false)
  })

  it('has the limits the contract names', () => {
    expect(DIFF_LIMITS).toMatchObject({ indent: 96, spaceRun: 32, whitespace: 160, lineChars: 500, tabStop: 8 })
  })
})

describe('one line of text (the character rule)', () => {
  it('refuses what is hidden and takes what is shown, with nothing stripped first', () => {
    expect(lineCharProblem('plain text')).toBe(false)
    expect(lineCharProblem('a\tb')).toBe(true)
    expect(lineCharProblem('a\tb', { tab: true })).toBe(false)
    expect(lineCharProblem('a ')).toBe(true)
    expect(lineCharProblem('a​')).toBe(true)
    expect(lineCharProblem('́a')).toBe(false)
    expect(lineCharProblem('́a', { blankMarks: true })).toBe(true)
  })
})

describe('a frame that is not what the gateway builds (README §7)', () => {
  it('has hunks numbered h1…h999, each once, and at least one', () => {
    expect(refused([])).toBe(true)
    expect(refused([hunk({ id: 'h0' })])).toBe(true)
    expect(refused([hunk({ id: 'h1000' })])).toBe(true)
    expect(refused([hunk({ id: 'intro' })])).toBe(true)
    expect(refused([hunk(), hunk()])).toBe(true)
    expect(refused([hunk({ id: 'h999' })])).toBe(false)
  })

  it('has at most 200 hunks of at most 400 lines', () => {
    const many = (count: number): unknown[] =>
      Array.from({ length: count }, (_, index) => ({
        id: `h${index + 1}`,
        header: `@@ -${index * 10 + 5},3 +${index * 10 + 5},3 @@`,
        lines: [' before', '-old', '+new', ' after']
      }))
    const longHunk = (count: number): unknown[] => [
      {
        id: 'h1',
        header: `@@ -10,${count + 1} +10,${count + 1} @@`,
        lines: Array.from({ length: count + 1 }, (_, index) => (index === 0 ? ' before' : ' ctx'))
      }
    ]

    expect(refused(many(200))).toBe(false)
    expect(refused(many(201))).toBe(true)
    expect(refused([{ id: 'h1', header: '@@ -10,0 +10,0 @@', lines: [] }])).toBe(true)
    // A hunk with nothing but context has no change to put anywhere; the contract's bound is on the count of lines.
    expect(refused(longHunk(399))).toBe(false)
    expect(refused(longHunk(400))).toBe(true)
  })

  it('has a header of the contract’s shape that agrees with the lines it heads', () => {
    expect(refused([hunk({ header: '@@ nonsense @@' })])).toBe(true)
    expect(refused([hunk({ header: '@@ -10,3 +10,3 @@ ' })])).toBe(true)
    expect(refused([hunk({ header: '@@ -10,3 +10,3 @@\nclass' })])).toBe(true)
    expect(refused([hunk({ header: '@@ -10,3 +10,3 @@ ' + 'x'.repeat(200) })])).toBe(true)
    // Counts that are not the lines': the person would see one change and the patch would hold another.
    expect(refused([hunk({ header: '@@ -10,4 +10,3 @@' })])).toBe(true)
    expect(refused([hunk({ header: '@@ -10,3 +10,4 @@' })])).toBe(true)
    // A count left out is 1.
    expect(refused([{ id: 'h1', header: '@@ -10 +10 @@', lines: ['-old', '+new'] }])).toBe(false)
  })

  it('takes a tab in the section text of a header, and refuses a hidden character in it', () => {
    expect(refused([hunk({ header: '@@ -10,3 +10,3 @@ func\t(x)' })])).toBe(false)
    expect(refused([hunk({ header: '@@ -10,3 +10,3 @@ func‮(x)' })])).toBe(true)
  })

  it('has no key on a hunk the contract does not have', () => {
    expect(refused([hunk({ approved: true })])).toBe(true)
    expect(refused([hunk({ anchor: 'middle' })])).toBe(true)
  })

  it('puts git’s no-newline note after a changed line of the last hunk, and nowhere else', () => {
    const note = '\\ No newline at end of file'

    expect(refused([{ id: 'h1', header: '@@ -10,1 +10,1 @@', lines: ['-old', note, '+new', note] }])).toBe(false)
    expect(refused([{ id: 'h1', header: '@@ -10,2 +10,2 @@', lines: [' before', note, '+new'] }])).toBe(true)
    expect(refused([{ id: 'h1', header: '@@ -10,1 +10,1 @@', lines: [note, '-old', '+new'] }])).toBe(true)
    expect(refused([{ id: 'h1', header: '@@ -10,1 +10,1 @@', lines: ['-old', '+new', note, note] }])).toBe(true)
    expect(
      refused([
        { id: 'h1', header: '@@ -10,2 +10,2 @@', lines: ['-old', note, '+new', ' after'] },
        hunk({ id: 'h2', header: '@@ -30,3 +30,3 @@' })
      ])
    ).toBe(true)
    // Altered text is not the note.
    expect(refused([{ id: 'h1', header: '@@ -10,1 +10,1 @@', lines: ['-old', '\\ No newline', '+new'] }])).toBe(true)
  })

  it('has a path that is relative, of one line, without a .. or .git segment', () => {
    for (const path of [
      '',
      '/etc/passwd',
      '../x',
      'a/../x',
      '.git/config',
      'a/.git/hooks',
      'a\nb',
      'a‮b',
      'p'.repeat(301)
    ]) {
      expect(refused([hunk()], { path }), path).toBe(true)
    }

    expect(refused([hunk()], { path: 'src/.gitignore' })).toBe(false)
    expect(refused([hunk()], { path: 'p'.repeat(300) })).toBe(false)
    expect(refused([hunk()], { path: undefined })).toBe(true)
  })

  it('has an old path for a rename and only for a rename', () => {
    expect(refused([hunk()], { kind: 'rename' })).toBe(true)
    expect(refused([hunk()], { kind: 'rename', old_path: '../x' })).toBe(true)
    expect(refused([hunk()], { kind: 'rename', old_path: 'a/old.py' })).toBe(false)
    expect(refused([hunk()], { kind: 'modify', old_path: 'a/old.py' })).toBe(true)
    expect(refused([hunk()], { kind: 'move' })).toBe(true)
  })

  it('shows a new file only as added lines and a deleted file only as removed ones', () => {
    const added = { id: 'h1', header: '@@ -0,0 +1,2 @@', lines: ['+a', '+b'] }
    const removed = { id: 'h1', header: '@@ -1,2 +0,0 @@', lines: ['-a', '-b'] }

    expect(refused([added], { kind: 'new' })).toBe(false)
    expect(refused([removed], { kind: 'delete' })).toBe(false)
    expect(refused([removed], { kind: 'new' })).toBe(true)
    expect(refused([added], { kind: 'delete' })).toBe(true)
    expect(refused([{ id: 'h1', header: '@@ -1,3 +1,3 @@', lines: ['+a', ' b', '-c'] }], { kind: 'new' })).toBe(true)
  })
})
