import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveSourceCommit } from '../../native/web/scripts/source-commit.mjs'
import { buildManifest, serialiseManifest } from '../../native/web/scripts/write-build-manifest.mjs'
import { differences } from './check-reproducible.mjs'

const roots: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermie-scripts-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveSourceCommit', () => {
  const commit = 'abcdef0123456789abcdef0123456789abcdef01'

  it('prefers HERMIE_SOURCE_COMMIT and normalises its case', () => {
    expect(resolveSourceCommit({ env: { HERMIE_SOURCE_COMMIT: ` ${commit.toUpperCase()}\n` } })).toBe(commit)
  })

  it('refuses a value that is not a full commit hash', () => {
    expect(() => resolveSourceCommit({ env: { HERMIE_SOURCE_COMMIT: commit.slice(0, 12) } })).toThrow('40-character')
  })

  it('refuses to guess outside a checkout', () => {
    expect(() => resolveSourceCommit({ env: {}, cwd: scratch() })).toThrow('HERMIE_SOURCE_COMMIT')
  })
})

describe('the build manifest', () => {
  const packageJson = {
    version: '0.2.0',
    repository: { type: 'git', url: 'https://github.com/example-org/example-repo.git' }
  }
  const commit = '0123456789abcdef0123456789abcdef01234567'

  it('lists every file with its SHA-256 and size, sorted, and not itself', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'index.html'), '<html></html>')
    writeFileSync(join(dir, 'assets', 'b.js'), 'bb')
    writeFileSync(join(dir, 'assets', 'a.js'), 'a')
    writeFileSync(join(dir, 'build.json'), 'stale')

    const manifest = buildManifest(dir, { commit, packageJson })

    expect(Object.keys(manifest.files)).toEqual(['assets/a.js', 'assets/b.js', 'index.html'])
    expect(manifest.files['assets/a.js']).toEqual({
      sha256: createHash('sha256').update('a').digest('hex'),
      bytes: 1
    })
    expect(manifest.totalBytes).toBe(1 + 2 + '<html></html>'.length)
    expect(manifest).toMatchObject({
      v: 1,
      name: 'hermie-web-client',
      version: '0.2.0',
      sourceRepo: 'example-org/example-repo',
      sourceCommit: commit
    })
  })

  it('serialises canonically: sorted keys, two-space indent, trailing newline, no timestamp', () => {
    const text = serialiseManifest({ z: 1, a: { y: [{ b: 1, a: 2 }], x: 0 } })

    expect(text).toBe(
      [
        '{',
        '  "a": {',
        '    "x": 0,',
        '    "y": [',
        '      {',
        '        "a": 2,',
        '        "b": 1',
        '      }',
        '    ]',
        '  },',
        '  "z": 1',
        '}',
        ''
      ].join('\n')
    )
  })

  it('gives the same bytes for the same files, whatever order they were written in', () => {
    const first = scratch()
    const second = scratch()
    for (const [dir, order] of [
      [first, ['a.js', 'b.js']],
      [second, ['b.js', 'a.js']]
    ] as const) {
      for (const name of order) {
        writeFileSync(join(dir, name), name)
      }
    }

    expect(serialiseManifest(buildManifest(first, { commit, packageJson }))).toBe(
      serialiseManifest(buildManifest(second, { commit, packageJson }))
    )
  })

  it('needs a repository in package.json to name the source', () => {
    expect(() => buildManifest(scratch(), { commit, packageJson: { version: '0.2.0' } })).toThrow('repository')
  })
})

describe('differences', () => {
  it('is empty for identical builds and names what differs otherwise', () => {
    const one = new Map([
      ['a.js', '1'],
      ['b.js', '2']
    ])

    expect(differences(one, new Map(one))).toEqual([])
    expect(
      differences(
        one,
        new Map([
          ['a.js', '1'],
          ['b.js', 'changed'],
          ['c.js', '3']
        ])
      )
    ).toEqual(['b.js: bytes differ', 'c.js: only in the second build'])
    expect(differences(one, new Map([['a.js', '1']]))).toEqual(['b.js: only in the first build'])
  })
})
