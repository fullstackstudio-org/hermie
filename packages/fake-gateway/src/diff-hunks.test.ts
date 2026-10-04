/**
 * `diff-hunks.ts`: a unified diff as the bounded hunks of a `review.diff` request, and the patch put back
 * together from the approved ones (`contract/requests/README.md` §7). The round trips run on diffs real git made
 * (a modified file, a new one, a deleted one, a rename with edits, a file without a final newline) and are
 * applied again with `git apply`; the refusals pin the bounds and every way a diff cannot be shown as it is.
 * The cases are the gateway's own (`tests/tui_gateway/test_diff_hunks.py`), so the fake refuses what it refuses.
 */
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  chmodSync,
  existsSync,
  writeFileSync,
  unlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DiffError,
  MAX_DIFF_BYTES,
  MAX_DIFF_INDENT,
  MAX_DIFF_SPACE_RUN,
  MAX_DIFF_WHITESPACE,
  MAX_HEADER_CHARS,
  MAX_HUNK_LINES,
  MAX_HUNKS,
  MAX_LINE_CHARS,
  MAX_PATH_CHARS,
  NO_NEWLINE,
  TAB_STOP,
  anchorOf,
  composePatch,
  hasTrailingContext,
  headOldPath,
  headPath,
  headerProblem,
  lineProblem,
  parseDiff,
  pathProblem,
  textProblem,
  type FileHead,
  type ParsedDiff
} from './diff-hunks'

const hasGit = spawnSync('git', ['--version']).status === 0
const OLD = Array.from({ length: 40 }, (_, n) => `line ${n + 1}\n`).join('')

const modified = (...changes: [number, string][]): string => {
  const lines = OLD.split('\n')
    .slice(0, -1)
    .map(line => `${line}\n`)

  for (const [number, text] of changes) {
    lines[number - 1] = `${text}\n`
  }

  return lines.join('')
}

// ── a scratch repository ─────────────────────────────────────────────────────────────────────

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

class Repo {
  readonly root = mkdtempSync(join(tmpdir(), 'hermie-diff-'))
  private readonly env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com'
  }

  constructor() {
    roots.push(this.root)
    this.git('init', '-q')
    this.git('config', 'core.autocrlf', 'false')
  }

  git(...args: string[]): string {
    return this.run(args).stdout
  }

  run(args: string[], input?: string): { status: number; stdout: string; stderr: string } {
    const done = spawnSync('git', args, { cwd: this.root, env: this.env, ...(input === undefined ? {} : { input }) })

    return { status: done.status ?? 1, stdout: String(done.stdout), stderr: String(done.stderr) }
  }

  write(name: string, text: string | Buffer): void {
    const path = join(this.root, name)

    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }

  read(name: string): string {
    return readFileSync(join(this.root, name), 'utf8')
  }

  commit(): void {
    this.git('add', '-A')
    this.git('commit', '-q', '-m', 'x')
  }

  diff(...args: string[]): string {
    return this.git('diff', '--no-color', '--no-ext-diff', ...args)
  }

  apply(patch: string): void {
    const done = this.run(['apply', '--whitespace=nowarn', '-'], patch)

    if (done.status) {
      throw new Error(`git apply: ${done.stderr}`)
    }
  }
}

const parse = (text: unknown, path?: string): ParsedDiff => {
  const named = typeof text === 'string' && text.split('@@')[0]!.includes('--- ')

  return parseDiff(text, path ?? (named ? null : 'f.txt'))
}

const compose = (parsed: ParsedDiff, approved: string[]): string => composePatch(parsed.head, parsed.hunks, approved)

const refuses = (run: () => unknown, match: string | RegExp): void => {
  expect(run).toThrow(DiffError)
  expect(run).toThrow(match)
}

describe.skipIf(!hasGit)('real diffs, applied again', () => {
  it('round-trips a modified file through every hunk', () => {
    const repo = new Repo()

    repo.write('a.txt', OLD)
    repo.commit()

    const next = modified([3, 'line three'], [20, 'line twenty'], [38, 'line thirty-eight'])

    repo.write('a.txt', next)

    const text = repo.diff()
    const parsed = parse(text)

    expect(parsed.head).toEqual({ kind: 'modify', old: 'a.txt', new: 'a.txt' })
    expect(headPath(parsed.head)).toBe('a.txt')
    expect(parsed.hunks.map(h => h.id)).toEqual(['h1', 'h2', 'h3'])
    expect(parsed.hunks.every(h => h.header.startsWith('@@ -'))).toBe(true)

    const patch = compose(parsed, ['h1', 'h2', 'h3'])

    // git's own text, but for the `index` line the gateway never writes.
    expect(patch).toBe(
      text
        .split('\n')
        .filter(line => !line.startsWith('index '))
        .join('\n')
    )
    repo.git('checkout', '--', 'a.txt')
    repo.apply(patch)
    expect(repo.read('a.txt')).toBe(next)
  })

  // hunk id -> (first line index, end index, replacement), on the 40 lines of OLD
  const EDITS: Record<string, [number, number, string[]]> = {
    h1: [2, 3, ['line three', 'an added line', 'another']], // +2 lines
    h2: [19, 20, ['line twenty']], // +-0
    h3: [37, 38, ['line thirty-eight', 'extra']] // +1
  }

  const edited = (ids: string[]): string[] => {
    const lines = OLD.split('\n').slice(0, -1)

    for (const id of [...ids].sort().reverse()) {
      const [first, end, next] = EDITS[id]!

      lines.splice(first, end - first, ...next)
    }

    return lines
  }

  it.each([['h1'], ['h2'], ['h3'], ['h1', 'h3'], ['h2', 'h3'], ['h1', 'h2']])(
    'applies the subset %s alone: the new-side start follows the hunks left out',
    (...approved) => {
      const repo = new Repo()

      repo.write('a.txt', OLD)
      repo.commit()
      repo.write('a.txt', `${edited(Object.keys(EDITS)).join('\n')}\n`)

      const parsed = parse(repo.diff())

      expect(parsed.hunks).toHaveLength(3)
      repo.git('checkout', '--', 'a.txt')
      repo.apply(compose(parsed, approved))
      expect(repo.read('a.txt').split('\n').slice(0, -1)).toEqual(edited(approved))
    }
  )

  it('keeps the no-newline marker of a file without a final newline', () => {
    const repo = new Repo()

    repo.write('a.txt', 'one\ntwo\nthree')
    repo.commit()
    repo.write('a.txt', 'one\ntwo\nthree\nfour')

    const text = repo.diff()

    expect(text).toContain(NO_NEWLINE)

    const parsed = parse(text)

    expect(parsed.hunks[0]!.lines).toEqual([' one', ' two', '-three', NO_NEWLINE, '+three', '+four', NO_NEWLINE])
    repo.git('checkout', '--', 'a.txt')
    repo.apply(compose(parsed, ['h1']))
    expect(repo.read('a.txt')).toBe('one\ntwo\nthree\nfour')
  })

  it('round-trips the marker after both sides', () => {
    const repo = new Repo()

    repo.write('a.txt', 'one\ntwo')
    repo.commit()
    repo.write('a.txt', 'one\n2')

    const parsed = parse(repo.diff())

    expect(parsed.hunks[0]!.lines.filter(line => line === NO_NEWLINE)).toHaveLength(2)
    repo.git('checkout', '--', 'a.txt')
    repo.apply(compose(parsed, ['h1']))
    expect(repo.read('a.txt')).toBe('one\n2')
  })

  it('round-trips a new file', () => {
    const repo = new Repo()

    repo.write('keep.txt', 'x\n')
    repo.commit()
    repo.write('docs/new.txt', 'first\nsecond\n')
    repo.git('add', '-A')

    const text = repo.diff('--cached')

    expect(text).toContain('new file mode 100644')

    const parsed = parse(text)

    expect(parsed.head).toEqual({ kind: 'new', old: null, new: 'docs/new.txt' })
    expect(headPath(parsed.head)).toBe('docs/new.txt')
    expect(parsed.hunks[0]!.header).toBe('@@ -0,0 +1,2 @@')

    const patch = compose(parsed, ['h1'])

    expect(
      patch.startsWith(
        'diff --git a/docs/new.txt b/docs/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/docs/new.txt\n@@ -0,0 +1,2 @@\n+first\n+second\n'
      )
    ).toBe(true)
    repo.git('reset', '-q', '--hard')
    repo.git('clean', '-fdq')
    expect(existsSync(join(repo.root, 'docs', 'new.txt'))).toBe(false)
    repo.apply(patch)
    expect(repo.read('docs/new.txt')).toBe('first\nsecond\n')
  })

  it('round-trips a deleted file', () => {
    const repo = new Repo()

    repo.write('gone.txt', 'bye\nnow\n')
    repo.commit()
    unlinkSync(join(repo.root, 'gone.txt'))

    const parsed = parse(repo.diff())

    expect(parsed.head).toEqual({ kind: 'delete', old: 'gone.txt', new: null })
    expect(headPath(parsed.head)).toBe('gone.txt')

    const patch = compose(parsed, ['h1'])

    expect(patch).toContain('deleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n')
    repo.git('checkout', '--', 'gone.txt')
    repo.apply(patch)
    expect(existsSync(join(repo.root, 'gone.txt'))).toBe(false)
  })

  it('round-trips a rename with edits', () => {
    const repo = new Repo()

    repo.write('old name.txt', OLD)
    repo.write('other.txt', 'keep\n')
    repo.commit()
    mkdirSync(join(repo.root, 'new'))
    repo.git('mv', 'old name.txt', 'new/name.txt')

    const next = modified([5, 'line five'])

    repo.write('new/name.txt', next)
    repo.git('add', '-A')

    const text = repo.diff('--cached', '-M')

    expect(text).toContain('rename from old name.txt')
    expect(text).toContain('rename to new/name.txt')

    const parsed = parse(text)

    expect(parsed.head).toMatchObject({ kind: 'rename', old: 'old name.txt', new: 'new/name.txt' })
    expect(headPath(parsed.head)).toBe('new/name.txt')
    expect(headOldPath(parsed.head)).toBe('old name.txt')
    expect(parsed.head.similarity).toBeGreaterThan(50)

    const patch = compose(parsed, ['h1'])

    expect(patch).toContain(
      'rename from old name.txt\nrename to new/name.txt\n--- a/old name.txt\n+++ b/new/name.txt\n'
    )
    repo.git('reset', '-q', '--hard')
    repo.apply(patch)
    expect(existsSync(join(repo.root, 'old name.txt'))).toBe(false)
    expect(repo.read('new/name.txt')).toBe(next)
  })

  it('reads a diff whose own line ending is CRLF like the LF one', () => {
    const repo = new Repo()

    repo.write('a.txt', OLD)
    repo.commit()
    repo.write('a.txt', modified([3, 'three'], [30, 'thirty']))

    const text = repo.diff()

    expect(parse(text.replaceAll('\n', '\r\n'))).toEqual(parse(text))
    expect(parse(text.replaceAll('\n', '\r\n').replace(/[\r\n]+$/, ''))).toEqual(parse(text))
  })

  it('refuses content with a carriage return, never rewrites it', () => {
    const repo = new Repo()

    repo.write('w.txt', 'a\r\nb\r\nc\r\n')
    repo.commit()
    repo.write('w.txt', 'a\r\nB\r\nc\r\n')
    refuses(() => parse(repo.diff()), /Hunk h1, line 1 .*U\+000D/)
  })

  it('refuses a binary diff', () => {
    const repo = new Repo()

    repo.write('img.bin', Buffer.from(Array.from({ length: 256 }, (_, n) => n)))
    repo.commit()
    repo.write('img.bin', Buffer.from(Array.from({ length: 256 }, (_, n) => 255 - n)))

    for (const text of [repo.diff(), repo.diff('--binary')]) {
      refuses(() => parse(text), /binary/)
    }
  })

  it('refuses a diff of two files', () => {
    const repo = new Repo()

    repo.write('a.txt', '1\n')
    repo.write('b.txt', '1\n')
    repo.commit()
    repo.write('a.txt', '2\n')
    repo.write('b.txt', '2\n')
    refuses(() => parse(repo.diff()), /more than one file/)
  })

  it('creates or deletes only regular files of mode 100644', () => {
    const repo = new Repo()

    repo.write('keep.txt', 'x\n')
    repo.commit()
    symlinkSync('keep.txt', join(repo.root, 'link'))
    repo.write('run.sh', 'echo hi\n')
    chmodSync(join(repo.root, 'run.sh'), 0o755)
    repo.git('add', '-A')

    for (const name of ['link', 'run.sh']) {
      const text = repo.diff('--cached', '--', name)

      expect(text).toContain('new file mode')
      refuses(() => parseDiff(text), /mode (120000 is a symbolic link|100755 is an executable file)/)
    }

    repo.write('plain.txt', 'a\n')
    repo.git('add', 'plain.txt')
    expect(parseDiff(repo.diff('--cached', '--', 'plain.txt')).head.kind).toBe('new')
  })

  it('round-trips a tab-indented Go diff', () => {
    const go = 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfor i := 0; i < 3; i++ {\n\t\tfmt.Println(i)\n\t}\n}\n'
    const repo = new Repo()

    repo.write('main.go', go)
    repo.write('Makefile', 'all:\n\tgo build ./...\n')
    repo.commit()

    const next = go
      .replace('i < 3', 'i < 5')
      .replace('\t\tfmt.Println(i)', '\t\tfmt.Println(i)\n\t\tfmt.Println(i * 2)')

    repo.write('main.go', next)

    const text = repo.diff('--', 'main.go')

    expect(text).toContain('\t\tfmt.Println(i * 2)')

    const parsed = parseDiff(text)

    expect(parsed.hunks.some(h => h.lines.some(line => line.startsWith('+\t\tfmt.Println(i * 2)')))).toBe(true)
    repo.git('checkout', '--', 'main.go')
    repo.apply(
      compose(
        parsed,
        parsed.hunks.map(h => h.id)
      )
    )
    expect(repo.read('main.go')).toBe(next)
    repo.write('Makefile', 'all:\n\tgo build ./...\n\tgo test ./...\n')

    const make = parseDiff(repo.diff('--', 'Makefile'))

    expect(make.hunks[0]!.lines.at(-1)).toBe('+\tgo test ./...')
  })

  const HEAD_APP = '--- a/app.py\n+++ b/app.py\n'
  const APP = 'def handler():\n    load()\n    check_auth()\n    serve()\n'

  it.each([
    [
      'after an added line in the middle',
      '@@ -1,4 +1,5 @@\n def handler():\n     load()\n+    # MARKER\n\\ No newline at end of file\n     check_auth()\n     serve()\n',
      '    # MARKER    check_auth()'
    ],
    [
      'after a context line at the end of the hunk',
      '@@ -2,2 +2,3 @@\n     load()\n+    # MARKER\n     check_auth()\n\\ No newline at end of file\n',
      '    check_auth()    serve()'
    ]
  ])(
    'refuses a marker that would glue a line to the next (%s), a shape git apply really takes',
    (_name, body, glued) => {
      const repo = new Repo()

      repo.write('app.py', APP)
      repo.commit()
      repo.apply(HEAD_APP + body)
      expect(repo.read('app.py')).toContain(glued)
      refuses(() => parseDiff(HEAD_APP + body), /No newline at end of file/)
    }
  )

  const HEAD_F = '--- a/f.txt\n+++ b/f.txt\n'

  it.each([
    // git apply puts a hunk without context at the END of the file, not at the line the header says
    ['x\na\nb\na\n', '@@ -2 +2 @@ x\n-a\n+X\n', 'x\na\nb\nX\n'],
    ['1\n2\n3\n4\n5\n', '@@ -3,0 +4 @@\n+NEW\n', '1\n2\n3\n4\n5\nNEW\n']
  ])('refuses a hunk without context where git apply would put it elsewhere', (content, body, landed) => {
    const repo = new Repo()

    repo.write('f.txt', content)
    repo.commit()
    repo.apply(HEAD_F + body)
    expect(repo.read('f.txt')).toBe(landed)
    refuses(() => parseDiff(HEAD_F + body), /no context line and starts at line/)
  })

  it('lands a last hunk without trailing context at the end whatever its header says, and says so with an anchor', () => {
    const repo = new Repo()

    repo.write('f.txt', 'a\nb\nc\nb\n')
    repo.commit()

    const parsed = parseDiff(`${HEAD_F}@@ -2,1 +2,2 @@\n b\n+X\n`)

    expect(parsed.hunks[0]!.anchor).toBe('end')
    repo.apply(compose(parsed, ['h1']))
    expect(repo.read('f.txt')).toBe('a\nb\nc\nb\nX\n')
    repo.git('checkout', '--', 'f.txt')
    repo.write('f.txt', 'a\nb\n')
    repo.apply(compose(parsed, ['h1']))
    expect(repo.read('f.txt')).toBe('a\nb\nX\n')
  })

  it('keeps the zero start of a new file', () => {
    const repo = new Repo()

    repo.write('keep.txt', 'x\n')
    repo.commit()
    repo.apply(compose(parseDiff('--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n'), ['h1']))
    expect(repo.read('n.txt')).toBe('a\nb\n')
  })
})

// ── the head ─────────────────────────────────────────────────────────────────────────────────

const HUNK = '@@ -1,2 +1,2 @@\n a\n-b\n+c\n'

const hunkText = (lines: string[], header?: string): string => {
  const old = lines.filter(line => line[0] === ' ' || line[0] === '-').length
  const now = lines.filter(line => line[0] === ' ' || line[0] === '+').length

  return `${header ?? `@@ -${old ? 1 : 0},${old} +1,${now} @@`}\n${lines.map(line => `${line}\n`).join('')}`
}

describe('the head', () => {
  it('takes the agent’s path for bare hunks, and needs it', () => {
    const parsed = parseDiff(HUNK, 'src/f.py')

    expect(parsed.head).toEqual({ kind: 'modify', old: 'src/f.py', new: 'src/f.py' })
    expect(compose(parsed, ['h1'])).toBe(`diff --git a/src/f.py b/src/f.py\n--- a/src/f.py\n+++ b/src/f.py\n${HUNK}`)
    refuses(() => parseDiff(HUNK), /path is required/)
    refuses(() => parseDiff(HUNK, null), /path is required/)
  })

  it('reads plain diff -u headers without prefixes and with timestamps', () => {
    const parsed = parseDiff(
      `--- f.py\t2026-10-03 10:00:00.000000000 +0200\n+++ f.py\t2026-10-03 10:01:00.000000000 +0200\n${HUNK}`
    )

    expect(parsed.head).toEqual({ kind: 'modify', old: 'f.py', new: 'f.py' })
    expect(compose(parsed, ['h1']).startsWith('diff --git a/f.py b/f.py\n--- a/f.py\n+++ b/f.py\n@@')).toBe(true)
  })

  it('writes the patch from the stored head, never from the agent’s header text', () => {
    const parsed = parseDiff(
      `diff --git a/shown.txt b/elsewhere.txt\nindex 1234567..89abcde 100644\n--- a/shown.txt\t2026\n+++ b/shown.txt\n${HUNK}`
    )
    const patch = compose(parsed, ['h1'])

    expect(patch).not.toMatch(/elsewhere|index|2026/)
    expect(patch.split('\n').slice(0, 3)).toEqual([
      'diff --git a/shown.txt b/shown.txt',
      '--- a/shown.txt',
      '+++ b/shown.txt'
    ])
  })

  it.each([
    [`--- a/x\n+++ b/y\n${HUNK}`, /two different files/],
    [`--- /dev/null\n+++ /dev/null\n${HUNK}`, /both sides/],
    [`--- a/../x\n+++ b/../x\n${HUNK}`, /\.\. segment/],
    [`--- /etc/passwd\n+++ /etc/passwd\n${HUNK}`, /absolute/],
    [`--- "a/x y"\n+++ "b/x y"\n${HUNK}`, /quoted/],
    [`--- a/x\n${HUNK}`, /followed by/],
    [`--- a/x\n+++ b/x\n--- a/x\n+++ b/x\n${HUNK}`, /followed by/],
    [`diff --git a/x b/x\n${HUNK}`, /no '--- '/],
    [`new file mode 100644\n--- a/x\n+++ b/x\n${HUNK}`, /new, deleted or renamed/],
    [`deleted file mode 100644\n--- /dev/null\n+++ b/x\n${HUNK}`, /new but also deleted/],
    [`rename from x\nrename to y\n--- a/x\n+++ b/x\n${HUNK}`, /new, deleted or renamed/],
    [`new file mode 10064\n--- /dev/null\n+++ b/x\n${HUNK}`, /six octal/],
    [`similarity index 190%\n--- a/x\n+++ b/y\n${HUNK}`, /similarity/],
    [`old mode 100644\nnew mode 100755\n--- a/x\n+++ b/x\n${HUNK}`, /change of a file's mode/],
    [`\`\`\`diff\n${HUNK}\`\`\`\n`, /not part of a unified diff/],
    ['', /required/],
    ['   \n\n', /required/],
    ['--- a/x\n+++ b/x\n', /no hunk/]
  ])('refuses what the head may not say: %#', (text, match) => {
    refuses(() => parse(text), match)
  })

  it('needs the agent’s path to be the file the diff changes', () => {
    const text = `--- a/x.txt\n+++ b/x.txt\n${HUNK}`

    expect(parse(text, 'x.txt').head).toEqual({ kind: 'modify', old: 'x.txt', new: 'x.txt' })
    refuses(() => parse(text, 'y.txt'), /not the file the diff changes/)
    refuses(() => parseDiff(HUNK, '../etc/passwd'), /cannot be used/)
    refuses(() => parseDiff(HUNK, 'p'.repeat(301)), /cannot be used/)

    const renamed = `similarity index 80%\nrename from a.txt\nrename to b.txt\n--- a/a.txt\n+++ b/b.txt\n${HUNK}`

    expect(headPath(parse(renamed, 'b.txt').head)).toBe('b.txt')
    expect(headOldPath(parse(renamed, 'b.txt').head)).toBe('a.txt')
    refuses(() => parse(renamed, 'a.txt'), /not the file/)
    expect(parse('deleted file mode 100644\n--- a/a.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n', 'a.txt').head.kind).toBe(
      'delete'
    )
  })

  it('says what happens to the file', () => {
    expect(parseDiff(`--- a/x\n+++ b/x\n${HUNK}`).head.kind).toBe('modify')
    expect(parseDiff('--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+a\n').head.kind).toBe('new')

    const deleted = parseDiff('--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n').head

    expect([deleted.kind, headPath(deleted), headOldPath(deleted)]).toEqual(['delete', 'x', null])

    const renamed = parseDiff(`rename from x\nrename to y/z\n--- a/x\n+++ b/y/z\n${HUNK}`).head

    expect([renamed.kind, headPath(renamed), headOldPath(renamed)]).toEqual(['rename', 'y/z', 'x'])
  })

  it('does not let a rename also be new or deleted', () => {
    const base = `rename from a.txt\nrename to b.txt\n--- a/a.txt\n+++ b/b.txt\n${HUNK}`

    expect(parseDiff(base).head.kind).toBe('rename')

    for (const line of ['new file mode 100644\n', 'deleted file mode 100644\n']) {
      refuses(() => parseDiff(line + base), /renamed but also new or deleted/)
    }
  })

  it('gives a new file only added lines and a deleted one only removed lines', () => {
    expect(parseDiff('--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n').head.kind).toBe(
      'new'
    )
    expect(parseDiff('--- a/g\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n\\ No newline at end of file\n').head.kind).toBe(
      'delete'
    )
    refuses(
      () => parseDiff('--- /dev/null\n+++ b/n\n@@ -0,1 +1,2 @@\n-a\n+b\n+c\n'),
      /the file is new, so every line must be added/
    )
    refuses(
      () => parseDiff('--- /dev/null\n+++ b/n\n@@ -1,1 +1,2 @@\n a\n+b\n'),
      /the file is new, so every line must be added/
    )
    refuses(
      () => parseDiff('--- a/g\n+++ /dev/null\n@@ -1,1 +0,1 @@\n-a\n+b\n'),
      /the file is deleted, so every line must be removed/
    )
    refuses(
      () => parseDiff('--- a/g\n+++ /dev/null\n@@ -1,2 +0,1 @@\n a\n-b\n'),
      /the file is deleted, so every line must be removed/
    )
  })

  it.each([
    ['120000', 'a symbolic link'],
    ['160000', 'a submodule'],
    ['100755', 'an executable file']
  ])('refuses to delete a file of mode %s', (mode, what) => {
    refuses(() => parseDiff(`deleted file mode ${mode}\n--- a/n\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`), what)
  })

  it.each([
    ['new file mode 120000\n', /mode 120000 is a symbolic link/],
    ['new file mode 160000\n', /mode 160000 is a submodule/],
    ['new file mode 100755\n', /mode 100755 is an executable file/],
    ['new file mode 100664\n', /mode 100664 is not a regular file/],
    ['new file mode 100644\nindex 0000000..1234567 100755\n', /mode 100755 is an executable file/],
    ['new file mode 100644\nindex 0000000..1234567 120000\n', /mode 120000 is a symbolic link/],
    ['new file mode 100644\nindex zzzz..1234567\n', /index line looks like/],
    ['new file mode 1006\n', /six octal digits/]
  ])('refuses a mode other than 100644: %s', (header, match) => {
    refuses(() => parseDiff(`diff --git a/n b/n\n${header}--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+x\n`), match)
  })

  it('keeps the plain head of a new file and of a modified one', () => {
    expect(
      parseDiff(
        'diff --git a/n b/n\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+x\n'
      ).head
    ).toEqual({ kind: 'new', old: null, new: 'n' })
    expect(parseDiff('index 1234567..89abcde 100644\n--- a/n\n+++ b/n\n@@ -1 +1 @@\n-x\n+y\n').head.kind).toBe('modify')
  })
})

// ── the hunks ────────────────────────────────────────────────────────────────────────────────

describe('the hunks', () => {
  it('reads a hunk by its counts, so a dashed line is content', () => {
    const parsed = parse(
      hunkText([' keep', '--- not a header', '+++ not a header either', '+added'], '@@ -1,2 +1,3 @@')
    )

    expect(parsed.hunks[0]!.lines).toEqual([' keep', '--- not a header', '+++ not a header either', '+added'])
  })

  it('reads two hunks and a section text', () => {
    const text =
      hunkText([' a', '-b', '+c', ' d'], '@@ -1,3 +1,3 @@ def f(x):') + hunkText([' z', '+y'], '@@ -9 +9,2 @@')
    const parsed = parse(text)

    expect(parsed.hunks.map(h => h.header)).toEqual(['@@ -1,3 +1,3 @@ def f(x):', '@@ -9 +9,2 @@'])
    expect(parsed.hunks.map(h => h.id)).toEqual(['h1', 'h2'])
    expect(parse(`${text}\n\n`).hunks).toEqual(parsed.hunks) // blank lines at the end of the text are not a hunk
  })

  it('reads a blank context line as one space or as an empty line', () => {
    const spaced = '@@ -1,3 +1,3 @@\n a\n \n-b\n+c\n'
    const empty = '@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n'

    expect(parse(spaced).hunks[0]!.lines).toEqual([' a', ' ', '-b', '+c'])
    expect(parse(empty)).toEqual(parse(spaced))
  })

  it.each([
    ['@@ -1,2 +1,2 @@\n a\n-b\n', /the diff ends first/],
    ['@@ -1,1 +1,1 @@\n a\n b\n', /not part of a hunk/],
    ['@@ -1,1 +1,1 @@\n a\n-b\n+c\n', /not part of a hunk/],
    ['@@ -1,2 +1,0 @@\n-a\n+b\n', /does not fit the header's counts/],
    ['@@ -1,2 +1,0 @@\n a\n', /does not fit the header's counts/],
    ['@@ -1 +1 @@\n-a\n+b\nstray\n', /not part of a hunk/],
    ['@@ -1 +1 @@\n-a\n+b\n\\ No newline\n', /not part of a hunk/],
    ['@@ -1 +1 @@\n\\ No newline at end of file\n-a\n+b\n', /must follow a line/],
    [
      '@@ -1,2 +1,2 @@\n a\n\\ No newline at end of file\n\\ No newline at end of file\n-b\n+c\n',
      /after a context line/
    ],
    ['@@@ -1,2 -1,2 +1,2 @@@\n a\n', /not of the form/],
    ['@@ -1,2 +1,2\n a\n', /not of the form/],
    ['@@ -1 +1 @@\n?a\n+b\n', /does not fit/],
    ['@@ -1 +1 @@ \u202ebidi\n-a\n+b\n', /cannot be shown/],
    ['@@ -1 +1 @@ tab\t\n-a\n+b\n', /whitespace at the end/]
  ])('refuses a hunk whose counts or lines do not fit: %#', (text, match) => {
    refuses(() => parse(text), match)
  })

  it('allows a tab in a hunk header’s section text', () => {
    expect(parse('@@ -1 +1 @@ func\t(a int)\n-a\n+b\n').hunks[0]!.header).toBe('@@ -1 +1 @@ func\t(a int)')
  })
})

describe('the bounds', () => {
  it('are the contract’s', () => {
    expect([MAX_DIFF_BYTES, MAX_HUNKS, MAX_HUNK_LINES, MAX_LINE_CHARS, MAX_HEADER_CHARS, MAX_PATH_CHARS]).toEqual([
      65_536, 200, 400, 500, 200, 300
    ])
  })

  const many = (count: number): string =>
    Array.from({ length: count }, (_, n) => `@@ -${n * 5 + 1},3 +${n * 5 + 1},3 @@\n c\n-a\n+b\n d\n`).join('')

  it('allow at most two hundred hunks', () => {
    expect(parse(many(200)).hunks).toHaveLength(200)
    refuses(() => parse(many(201)), /more than 200 hunks/)
  })

  it('allow at most four hundred lines in a hunk', () => {
    const hunk = (count: number): string => `@@ -1,${count} +1,${count} @@\n${' x\n'.repeat(count)}`

    expect(parse(hunk(400)).hunks[0]!.lines).toHaveLength(400)
    refuses(() => parse(hunk(401)), /Hunk h1: it has more than 400 lines/)
    refuses(() => parse(`@@ -1,399 +1,399 @@\n${' x\n'.repeat(398)}-a\n+b\n${NO_NEWLINE}\n`), /more than 400 lines/)
  })

  it('allow at most five hundred characters in a line, its marker included', () => {
    expect(parse(hunkText([`+${'x'.repeat(499)}`])).hunks[0]!.lines[0]).toBe(`+${'x'.repeat(499)}`)
    refuses(() => parse(hunkText([`+${'x'.repeat(500)}`])), /it is 501 characters \(at most 500\)/)
  })

  it('allow a header of at most two hundred characters', () => {
    const ok = `@@ -1 +1 @@ ${'f'.repeat(200 - '@@ -1 +1 @@ '.length)}`

    expect(ok).toHaveLength(200)
    expect(parse(hunkText(['-a', '+b'], ok)).hunks[0]!.header).toBe(ok)
    refuses(() => parse(hunkText(['-a', '+b'], `@@ -1 +1 @@ ${'f'.repeat(200)}`)), /at most 200/)
    expect(headerProblem(ok)).toBe('')
  })

  it('allow at most 64 KiB of diff, counted in bytes', () => {
    const hunk = `@@ -1,3 +1,3 @@\n a\n-${'b'.repeat(480)}\n+${'c'.repeat(480)}\n d\n`
    const one = Buffer.byteLength(hunk)
    const count = Math.floor(MAX_DIFF_BYTES / one) + 1

    expect(count).toBeLessThanOrEqual(MAX_HUNKS)
    refuses(() => parse(hunk.repeat(count)), /the limit is 65536/)
    expect(parse(hunk.repeat(count - 1)).hunks).toHaveLength(count - 1)
    refuses(() => parse(`@@ -1 +1 @@\n-é\n+${'é'.repeat(40_000)}\n`), /bytes/)
  })
})

describe('every line passes the verbatim rules', () => {
  it.each([
    ['+trailing tab\t', 'whitespace at the end'],
    ['-\t', 'whitespace at the end'],
    [`+tab\t then spaces${' '.repeat(33)}y`, 'columns of spaces and tabs in a row'],
    [`+${' '.repeat(90)}\t\tx`, 'indented 104 columns'],
    ['+bidi \u202e text', 'U+202E'],
    ['+zero\u200bwidth', 'U+200B'],
    ['+nbsp\u00a0here', 'U+00A0'],
    ['+soft\u00adhyphen', 'U+00AD'],
    ['+trailing space ', 'whitespace at the end'],
    ['-trailing\u3000', 'U+3000'],
    [`+x${' '.repeat(33)}y`, '33 columns of spaces and tabs in a row'],
    [`+${' '.repeat(97)}x`, 'indented 97 columns'],
    ['+   ', 'whitespace at the end'],
    ['+bell\x07', 'U+0007'],
    ['+cr\rinside', 'U+000D'],
    ['+line\u2028sep', 'U+2028'],
    ['+private\ue000use', 'U+E000'],
    [`+${'\u0301'.repeat(5)}`, 'too many combining marks']
  ])('refuses %j', (line, why) => {
    const other = line[0] === '+' ? '-a' : '+a'

    refuses(() => parse(hunkText([other, line])), why)
  })

  it('takes the marker off first: the rest is a line of text', () => {
    expect(lineProblem(' ')).toBe('')
    expect(lineProblem('+')).toBe('')
    expect(lineProblem('-')).toBe('')
    expect(lineProblem('  ')).not.toBe('')
    expect(lineProblem('+ ')).not.toBe('')
    expect(lineProblem(` ${' '.repeat(96)}x`)).toBe('')
    expect(lineProblem(` ${' '.repeat(97)}x`)).not.toBe('')
    expect(lineProblem(`+x${' '.repeat(32)}y`)).toBe('')
    expect(lineProblem(`+x${' '.repeat(33)}y`)).not.toBe('')
    expect(lineProblem('?x')).not.toBe('')
    expect(lineProblem('')).not.toBe('')
    expect(lineProblem(NO_NEWLINE)).toBe('')
    expect(lineProblem('\\ No newline')).not.toBe('')
    expect(lineProblem('+déjà vu \u{1f600}')).toBe('')
  })

  it('names the hunk and the line in an error and quotes little', () => {
    const text = hunkText([' a', ' b', `+x\u202ey${'z'.repeat(100)}`])
    let message = ''

    try {
      parse(text)
    } catch (error) {
      message = (error as Error).message
    }

    expect(message.startsWith('Hunk h1, line 3 (line 4 of the diff)')).toBe(true)
    expect(message.length).toBeLessThan(300)
    expect(message).toContain('...')
  })

  it('refuses a diff that is not text', () => {
    for (const bad of [null, undefined, 3, Buffer.from('@@ -1 +1 @@\n-a\n+b\n'), ['@@']]) {
      refuses(() => parseDiff(bad, 'f.txt'), /required/)
    }

    refuses(() => parse('@@ -1 +1 @@\n-a\n+\ud800\n'), /surrogate/)
  })
})

describe('tabs and layout limits', () => {
  it('allows a tab leading and inside a line, and counts it as one character', () => {
    for (const line of ['+\tif x {', ' \t\treturn a\tb', '-\t\t// comment\twith a tab', '+a\tb']) {
      expect(lineProblem(line), line).toBe('')
    }

    expect(lineProblem('+\t')).not.toBe('') // a tab at the end is whitespace nobody sees
    expect(lineProblem(`+${'\t'.repeat(4)}${'x'.repeat(495)}`)).toBe('') // 500 code points: a tab counts as one
    expect(lineProblem(`+${'\t'.repeat(4)}${'x'.repeat(496)}`)).not.toBe('') // 501
  })

  it('limits the indent to 96 columns and any other run to 32, in columns with a tab stop every 8', () => {
    const problem = lineProblem

    expect([TAB_STOP, MAX_DIFF_INDENT, MAX_DIFF_SPACE_RUN]).toEqual([8, 96, 32])
    expect(problem(`+${'\t'.repeat(6)}x`)).toBe('')
    expect(problem(`+${'\t'.repeat(12)}x`)).toBe('')
    expect(problem(`+${'\t'.repeat(13)}x`)).not.toBe('')
    expect(problem(`+${'\t'.repeat(300)}x`)).not.toBe('')
    expect(problem(`+${' \t'.repeat(200)}x`)).not.toBe('') // mixed: every pair is a stop
    expect(problem(`+${' '.repeat(4)}${'\t'.repeat(11)}x`)).toBe('') // 4 spaces and a tab are 8 columns, then 88 more
    expect(problem(`+${' '.repeat(9)}${'\t'.repeat(11)}x`)).toBe('') // 9 -> 16, then 80 more = 96
    expect(problem(`+${' '.repeat(9)}${'\t'.repeat(12)}x`)).not.toBe('') // 104
    expect(problem(`+${' '.repeat(96)}x`)).toBe('')
    expect(problem(`+${' '.repeat(97)}x`)).not.toBe('')
    expect(problem(`+x${' '.repeat(32)}y`)).toBe('')
    expect(problem(`+x${' '.repeat(33)}y`)).not.toBe('')
    expect(problem(`+x${' '.repeat(40)}y`)).not.toBe('')
    expect(problem('+x\t\t\ty')).toBe('') // 23 columns
    expect(problem('+x\t\t\t\ty')).toBe('') // 31
    expect(problem('+x\t\t\t\t\ty')).not.toBe('') // 39
    expect(problem(`+x${'\t'.repeat(400)}y`)).not.toBe('')
    expect(problem(`+\tx${' '.repeat(8)}\ty`)).toBe('') // col 9 -> 16: 15 columns
    expect(problem(`+x${' '.repeat(16)}\t${' '.repeat(16)}y`)).not.toBe('') // a tab is part of the run: 39 columns

    // ordinary Go, Python and Makefile lines pass
    for (const line of [
      '+\t\t\tif err != nil {',
      ' \t\t\t\t\t\treturn nil',
      '-\tgo build ./...',
      '+all:\tdeps',
      `+${' '.repeat(32)}return value`,
      `+x = 1${' '.repeat(20)}# a trailing comment aligned far right`
    ]) {
      expect(problem(line), line).toBe('')
    }

    // every other character the README refuses stays refused
    for (const bad of ['+\x0b', '+a\x0cb', '+a\rb', '+a\u00a0b', '+a\u202eb', '+a\u200bb', '+a\x00b', '+\ta\u202eb']) {
      expect(problem(bad), JSON.stringify(bad)).not.toBe('')
    }
  })

  it.each([
    [`x${`${' '.repeat(32)}\u{16fe4}`.repeat(14)}MARKER`], // a Khitan filler between runs
    [`x${`${' '.repeat(32)}\u0301`.repeat(14)}MARKER`], // a combining mark between runs
    [`x${`${'\t'.repeat(4)}\u0345`.repeat(14)}MARKER`],
    [`x${`${' '.repeat(32)}\u200b`.repeat(14)}MARKER`],
    [`x${`${' '.repeat(30)}y`.repeat(6)}z`], // runs of 30 apart: 180 columns in all
    ['\u0301x'],
    ['x \u0301y'],
    ['x\t\u0301y']
  ])('refuses padding kept apart by something invisible: %#', text => {
    expect(lineProblem(`+${text}`)).not.toBe('')
  })

  it('caps the whitespace of a line at 160 columns in all', () => {
    expect(MAX_DIFF_WHITESPACE).toBe(160)
    expect(lineProblem(`+x${`${' '.repeat(30)}y`.repeat(5)}`)).toBe('') // 150
    expect(lineProblem(`+${' '.repeat(96)}x${`${' '.repeat(32)}y`.repeat(2)}`)).toBe('') // 96 + 64 = 160
    expect(lineProblem(`+${' '.repeat(96)}x${`${' '.repeat(32)}y`.repeat(2)} z`)).not.toBe('') // 161
    expect(lineProblem(`+${'\t'.repeat(12)}x${`${'\t'.repeat(4)}y`.repeat(2)}`)).toBe('')
    expect(lineProblem(`+${'\t'.repeat(12)}x${`${'\t'.repeat(4)}y`.repeat(2)}\tz`)).not.toBe('')
    expect(lineProblem(`+x${`${' '.repeat(30)}y`.repeat(6)}`)).toContain('columns of spaces and tabs in all')
  })

  it('allows a combining mark on a letter and refuses one after a space', () => {
    expect(lineProblem('+café au lait')).toBe('')
    expect(lineProblem('+é\u0301')).toBe('')
    expect(lineProblem('+a \u0301')).toContain('combining mark after a space')
    expect(lineProblem('+\u0301a')).toContain('combining mark after a space')
    expect(lineProblem('+\u0301')).not.toBe('')
    expect(textProblem('\u0301a')).not.toBe('')
    expect(lineProblem('+a\u{16fe4}')).not.toBe('')
  })
})

describe('the no-newline marker', () => {
  const HEAD_APP = '--- a/app.py\n+++ b/app.py\n'

  it.each([
    [
      '@@ -1,4 +1,4 @@\n def handler():\n-    load()\n\\ No newline at end of file\n+    load()\n     check_auth()\n     serve()\n',
      /allowed only once after the last old/
    ],
    [
      '@@ -1,2 +1,3 @@\n def handler():\n+    # MARKER\n\\ No newline at end of file\n     load()\n',
      /allowed only once after the last new/
    ],
    [
      '@@ -1,1 +1,2 @@\n def handler():\n+    # MARKER\n\\ No newline at end of file\n@@ -4 +5 @@\n-    serve()\n+    serve(1)\n',
      /only in the last hunk/
    ],
    [
      '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n@@ -3 +3 @@\n-c\n+d\n',
      /only in the last hunk/
    ],
    ['@@ -1 +1 @@\n a\n\\ No newline at end of file\n', /does not fit|ends first|after a context line/],
    [
      '@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file\n\\ No newline at end of file\n',
      /not part of a hunk|must follow/
    ],
    ['@@ -1 +1 @@\n-a\n\\ No newline at end of file\n\\ No newline at end of file\n+b\n', /must follow a line/]
  ])('is only after the last line of a side in the last hunk: %#', (body, match) => {
    refuses(() => parseDiff(HEAD_APP + body), match)
  })

  it.each([
    '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n', // old side only
    '@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n', // new side only
    '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n', // both
    '@@ -3,2 +3,3 @@\n x\n-a\n\\ No newline at end of file\n+a\n+b\n\\ No newline at end of file\n',
    '@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n'
  ])('is kept at the end of the last hunk: %#', body => {
    const parsed = parseDiff(HEAD_APP + body)

    expect(parsed.hunks.at(-1)!.lines).toContain(NO_NEWLINE)
    expect(compose(parsed, ['h1']).endsWith(body)).toBe(true)
  })
})

describe('paths', () => {
  it.each([
    ['x\ny'],
    ['x\ry'],
    ['ok.txt\n--- a/ok.txt\n+++ b/ok.txt\n@@ -1 +1 @@\n-x\n+MARKER'],
    ['a\x00b'],
    ['a\x07b'],
    ['a\x7fb'],
    ['a\u202eb']
  ])('refuses a path with a control or hidden character: %#', path => {
    expect(pathProblem(path)).not.toBe('')
    refuses(() => parseDiff(HUNK, path), /cannot be used/)
  })

  it.each([['.git/hooks/pre-commit'], ['.GIT/config'], ['a/.Git/x'], ['.git'], ['sub/.git']])(
    'never takes a git directory as a path: %s',
    path => {
      expect(pathProblem(path)).toContain('a .git segment')
      refuses(() => parseDiff(HUNK, path), /\.git segment/)
      refuses(() => parseDiff(`--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`), /\.git segment/)
      refuses(
        () =>
          parseDiff(
            `similarity index 90%\nrename from ok.txt\nrename to ${path}\n--- a/ok.txt\n+++ b/${path}\n${HUNK}`
          ),
        /\.git segment/
      )
    }
  )

  it.each([
    ['.gitignore'],
    ['.github/workflows/ci.yml'],
    ['dir/.gitattributes'],
    ['git/x'],
    ['a -> b/c'],
    ['a b/c d.txt'],
    ['dir/.hidden'],
    ['a.b/c.d'],
    ['a/b.c']
  ])('accepts a name that only looks like trouble: %s', path => {
    expect(pathProblem(path)).toBe('')
  })

  it.each([[' a/b'], ['a/ b'], ['a /b'], ['a/b '], ['a./b'], ['a/b.'], ['a/...'], ['dir./f']])(
    'refuses a segment with a space at an end or a trailing dot: %j',
    path => {
      expect(pathProblem(path)).not.toBe('')
      refuses(() => parseDiff(HUNK, path), /cannot be used/)
    }
  )
})

describe('composePatch', () => {
  it('moves the new-side start of a hunk back by the net change of the rejected hunks before it', () => {
    const hunks = [
      { id: 'h1', header: '@@ -3,1 +3,3 @@', lines: [' a', '+b', '+c'] },
      { id: 'h2', header: '@@ -20 +22 @@ def f():', lines: ['-x', '+y'] },
      { id: 'h3', header: '@@ -38,2 +40,1 @@', lines: [' k', '-z'] }
    ]
    const head: FileHead = { kind: 'modify', old: 'f.py', new: 'f.py' }

    expect(composePatch(head, hunks, ['h2']).split('\n')[3]).toBe('@@ -20 +20 @@ def f():')
    // h1 added two lines and is left out: 40 - 2
    expect(composePatch(head, hunks, ['h3']).split('\n')[3]).toBe('@@ -38,2 +38,1 @@')

    const both = composePatch(head, hunks, ['h2', 'h3']).split('\n')

    expect(both).toContain('@@ -20 +20 @@ def f():')
    expect(both).toContain('@@ -38,2 +38,1 @@')

    const everything = composePatch(head, hunks, ['h1', 'h2', 'h3']).split('\n')

    expect(everything.filter(line => line.startsWith('@@'))).toEqual(hunks.map(h => h.header)) // nothing moved
    expect(
      composePatch(head, hunks, ['h3']).startsWith(
        'diff --git a/f.py b/f.py\n--- a/f.py\n+++ b/f.py\n@@ -38,2 +38,1 @@\n'
      )
    ).toBe(true)
    expect(composePatch(head, hunks, [])).toBe('')
    expect(composePatch(head, hunks, ['h9'])).toBe('')
  })

  it('writes only what the head names', () => {
    const head: FileHead = { kind: 'modify', old: 'f.py', new: 'f.py' }

    expect(composePatch(head, [{ id: 'h1', header: '@@ -1 +1 @@', lines: ['-a', '+b'] }], ['h1'])).toBe(
      'diff --git a/f.py b/f.py\n--- a/f.py\n+++ b/f.py\n@@ -1 +1 @@\n-a\n+b\n'
    )
  })
})

describe('anchors: where git apply pins a hunk whatever the header says', () => {
  it('computes the anchor of a hunk', () => {
    expect(anchorOf('@@ -5,3 +5,3 @@', [' a', '-b', '+c', ' d'])).toBeNull() // context on both sides, mid-file
    expect(anchorOf('@@ -2,1 +2,2 @@', [' b', '+X'])).toBe('end') // nothing after the change
    expect(anchorOf('@@ -1,2 +1,3 @@', [' a', '-b', '+c', ' d'])).toBe('start') // old start 1
    expect(anchorOf('@@ -0,0 +1,2 @@', ['+a', '+b'])).toBe('both') // a new file
    expect(anchorOf('@@ -1,2 +0,0 @@', ['-a', '-b'])).toBe('both') // a removed file
    expect(anchorOf('@@ -1 +1 @@', ['-a', '+b'])).toBe('both') // the whole file
    expect(anchorOf('@@ -9,2 +9,2 @@', [' a', '-b', '+c'])).toBe('end')
    expect(anchorOf('@@ -9,3 +9,3 @@', [' a', '-b', '-c', NO_NEWLINE, '+C'])).toBe('end')
    expect(hasTrailingContext([' a', '-b', ' c'])).toBe(true)
    expect(hasTrailingContext([' a', '-b'])).toBe(false)
    expect(hasTrailingContext([])).toBe(false)
  })

  it('carries the anchor on the hunk, and leaves it off when the hunk is not pinned', () => {
    const parsed = parseDiff('--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n@@ -9,1 +9,2 @@\n z\n+tail\n')

    expect(parsed.hunks.map(h => h.anchor)).toEqual(['start', 'end'])

    const mid = parseDiff('--- a/f\n+++ b/f\n@@ -5,3 +5,3 @@\n a\n-b\n+c\n d\n').hunks[0]!

    expect('anchor' in mid).toBe(false)
  })

  it.each([
    '@@ -2,1 +2,2 @@\n b\n+X\n@@ -4,2 +5,2 @@\n d\n-e\n+E\n',
    '@@ -1,2 +1,3 @@\n a\n b\n+X\n@@ -5,2 +6,2 @@\n e\n-b\n+B\n'
  ])('refuses a leading-context hunk in the middle of a diff: %#', body => {
    refuses(
      () => parseDiff(`--- a/f.txt\n+++ b/f.txt\n${body}`),
      /Hunk h1: it has no context line after its last change but another hunk follows/
    )
  })

  it('lets only the last hunk lack trailing context', () => {
    const head = '--- a/f.txt\n+++ b/f.txt\n'

    expect(
      parseDiff(`${head}@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -9,1 +9,2 @@\n z\n+tail\n`).hunks.map(h => h.anchor)
    ).toEqual(['start', 'end'])
    refuses(
      () => parseDiff(`${head}@@ -2,2 +2,3 @@\n a\n b\n+X\n@@ -9,2 +10,2 @@\n z\n-y\n+Y\n`),
      /another hunk follows/
    )
    refuses(
      () =>
        parseDiff(`${head}@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -5,1 +5,2 @@\n z\n+w\n@@ -9,2 +10,2 @@\n z\n-y\n+Y\n`),
      /Hunk h2: it has no context line after its last change/
    )
  })

  it.each([
    ['@@ -2 +2 @@\n-a\n+b\n'],
    ['@@ -5,2 +5 @@\n-a\n-b\n+c\n'],
    ['@@ -3,0 +4 @@\n+NEW\n'],
    ['@@ -1,0 +2 @@\n+NEW\n']
  ])('says to include context when a hunk has none: %#', body => {
    refuses(
      () => parseDiff(`--- a/f.txt\n+++ b/f.txt\n${body}`),
      /Include unchanged lines around the change \(git diff -U3, never -U0\)/
    )
  })
})
