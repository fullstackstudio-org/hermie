import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildManifest, serialiseManifest } from '../../native/web/scripts/write-build-manifest.mjs'
import { checkBundle, DEVELOPMENT_ONLY_MARKER, LIMITS, REFERENCE_POLICY } from './check-bundle.mjs'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

const POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'"

function documentWith({ head = '', policy = POLICY } = {}): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    '<script type="module" crossorigin src="./assets/index-AAAA.js"></script>',
    '<link rel="modulepreload" crossorigin href="./assets/react-BBBB.js">',
    '<link rel="stylesheet" crossorigin href="./assets/index-CCCC.css">',
    head,
    '</head><body><div id="root"></div></body></html>'
  ].join('\n')
}

/** A bundle the checker accepts: an entry that imports one chunk and lazily loads another. */
function goodFiles(): Record<string, string | Buffer> {
  return {
    'index.html': documentWith(),
    'assets/index-AAAA.js': 'import{a as e}from"./react-BBBB.js";e();const l=()=>import("./lazy-DDDD.js");',
    'assets/react-BBBB.js': 'export const a=()=>1;',
    'assets/lazy-DDDD.js': `export const b=${JSON.stringify('x'.repeat(2000))};`,
    'assets/index-CCCC.css': 'body{margin:0}'
  }
}

const roots: string[] = []

function write(
  files: Record<string, string | Buffer>,
  { manifest = true, tamper }: { manifest?: boolean; tamper?: (text: string) => string } = {}
): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermie-bundle-'))
  roots.push(dir)

  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }

  if (manifest) {
    const built = buildManifest(dir, {
      commit: COMMIT,
      packageJson: { version: '0.2.0', repository: { url: 'https://github.com/example-org/example-repo.git' } }
    })
    const text = serialiseManifest(built)
    writeFileSync(join(dir, 'build.json'), tamper ? tamper(text) : text)
  }
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('a good bundle', () => {
  it('passes and reports what it measured', () => {
    const { problems, stats } = checkBundle(write(goodFiles()))

    expect(problems).toEqual([])
    expect(stats.files).toBe(6)
    // The entry and the chunk it imports statically; the lazy chunk is not initial.
    expect(stats.initialFiles).toEqual(['assets/index-AAAA.js', 'assets/react-BBBB.js'])
    expect(stats.initialJsBytes).toBeGreaterThan(0)
    expect(stats.initialJsGzipBytes).toBeGreaterThan(0)
  })

  it('accepts the expected commit and rejects another', () => {
    const dir = write(goodFiles())

    expect(checkBundle(dir, { commit: COMMIT }).problems).toEqual([])
    expect(checkBundle(dir, { commit: 'f'.repeat(40) }).problems).toEqual([
      expect.stringContaining('sourceCommit is 0123')
    ])
  })
})

describe('what the static route and the plugin tree allow', () => {
  it('refuses extensions the dashboard route does not serve', () => {
    const dir = write({
      ...goodFiles(),
      'notes.txt': 'x',
      'module.wasm': 'x',
      'manifest.webmanifest': '{}',
      LICENSE: 'x'
    })
    const { problems } = checkBundle(dir)

    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('notes.txt: extension ".txt"'),
        expect.stringContaining('module.wasm: extension ".wasm"'),
        expect.stringContaining('manifest.webmanifest: extension ".webmanifest"'),
        expect.stringContaining('LICENSE: extension ""')
      ])
    )
  })

  it('refuses source maps even though the route would serve them', () => {
    const { problems } = checkBundle(write({ ...goodFiles(), 'assets/index-AAAA.js.map': '{}' }))

    expect(problems).toEqual([expect.stringContaining('index-AAAA.js.map: is a source map')])
  })

  it('refuses a symbolic link', () => {
    const dir = write(goodFiles(), { manifest: false })
    symlinkSync(join(dir, 'index.html'), join(dir, 'alias.html'))

    expect(checkBundle(dir).problems).toEqual(
      expect.arrayContaining([expect.stringContaining('alias.html: is a symbolic link')])
    )
  })

  it('refuses a file over the file limit', () => {
    const { problems } = checkBundle(write(goodFiles()), { limits: { maxFileBytes: 1000 } })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('assets/lazy-DDDD.js:')
    expect(problems[0]).toContain('over the 1000-byte file limit')
  })

  it('has the limits the gate holds', () => {
    expect(LIMITS).toEqual({
      maxFileBytes: 900_000,
      maxTotalBytes: 3_000_000,
      maxFiles: 80,
      maxInitialJsBytes: 600_000,
      maxInitialJsGzipBytes: 190_000
    })
  })

  it('refuses a bundle over the total or the file count', () => {
    const dir = write(goodFiles())

    expect(checkBundle(dir, { limits: { maxTotalBytes: 100 } }).problems).toEqual([
      expect.stringContaining('over the 100-byte limit')
    ])
    expect(checkBundle(dir, { limits: { maxFiles: 3 } }).problems).toEqual([
      expect.stringContaining('has 6 files, over the limit of 3')
    ])
  })

  it('refuses a non-ASCII byte in text files and ignores binaries', () => {
    const dir = write({
      ...goodFiles(),
      'assets/index-AAAA.js': 'import{a as e}from"./react-BBBB.js";const s="caf\u00e9";',
      'assets/index-CCCC.css': 'a::after{content:"\u2022"}',
      'data.json': '{"k":"\u200b"}',
      'icon.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe])
    })
    const { problems } = checkBundle(dir)

    expect(problems).toEqual([
      expect.stringContaining('assets/index-AAAA.js: holds a non-ASCII or control byte'),
      expect.stringContaining('assets/index-CCCC.css: holds a non-ASCII or control byte'),
      expect.stringContaining('data.json: holds a non-ASCII or control byte')
    ])
  })

  it('refuses a control character in a text file, and allows tab and newline', () => {
    const dir = write({
      ...goodFiles(),
      'assets/index-AAAA.js': 'import{a as e}from"./react-BBBB.js";const s=["a","b"].join("\u001f");\n',
      'assets/index-CCCC.css': 'a{\tcolor:red\n}\r\n'
    })
    const { problems } = checkBundle(dir)

    expect(problems).toEqual([expect.stringContaining('assets/index-AAAA.js: holds a non-ASCII or control byte')])
  })

  it('refuses development-only code', () => {
    const dir = write({
      ...goodFiles(),
      'assets/lazy-DDDD.js': `document.body.dataset.build=${JSON.stringify(DEVELOPMENT_ONLY_MARKER)};`
    })

    expect(checkBundle(dir).problems).toEqual([
      expect.stringContaining('assets/lazy-DDDD.js: holds development-only code')
    ])
  })
})

describe('initial JavaScript', () => {
  it('follows static imports from chunk to chunk and ignores dynamic ones', () => {
    const { stats } = checkBundle(
      write({
        ...goodFiles(),
        'assets/react-BBBB.js': 'import"./deep-EEEE.js";export const a=()=>1;',
        'assets/deep-EEEE.js': 'export const d=1;'
      })
    )

    expect(stats.initialFiles).toEqual(['assets/deep-EEEE.js', 'assets/index-AAAA.js', 'assets/react-BBBB.js'])
  })

  it('refuses a raw size over the limit', () => {
    const { problems } = checkBundle(write(goodFiles()), { limits: { maxInitialJsBytes: 50 } })

    expect(problems).toEqual([expect.stringContaining('initial JavaScript is')])
    expect(problems[0]).toContain('over the 50-byte limit')
  })

  it('refuses a gzipped size over the limit', () => {
    // Random on purpose, so it barely compresses; the raw size stays well under its own limit.
    const noise = randomBytes(3000).toString('base64')
    const dir = write({ ...goodFiles(), 'assets/react-BBBB.js': `export const a="${noise}";` })

    const { problems } = checkBundle(dir, { limits: { maxInitialJsGzipBytes: 500 } })

    expect(problems).toEqual([expect.stringContaining('bytes gzipped, over the 500-byte limit')])
  })

  it('reports an entry that is not in the bundle', () => {
    const files = goodFiles()
    delete files['assets/react-BBBB.js']
    const { problems } = checkBundle(write(files))

    expect(problems).toEqual(
      expect.arrayContaining([expect.stringContaining('loads assets/react-BBBB.js, which is not in the bundle')])
    )
  })
})

describe('index.html', () => {
  it('refuses an inline script, an inline style and an inline handler', () => {
    const html = documentWith({
      head: '<script>run()</script><style>a{color:red}</style>'
    }).replace('<div id="root">', '<div id="root" style="color:red" onclick="run()">')
    const { problems } = checkBundle(write({ ...goodFiles(), 'index.html': html }))

    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('has an inline script'),
        expect.stringContaining('has a style element'),
        expect.stringContaining('has a style attribute'),
        expect.stringContaining('inline onclick handler')
      ])
    )
  })

  it('refuses a document without a policy, and a policy that allows inline code', () => {
    const bare = documentWith().replace(/<meta http-equiv[^>]*>/, '')
    expect(checkBundle(write({ ...goodFiles(), 'index.html': bare })).problems).toEqual(
      expect.arrayContaining([expect.stringContaining('no Content-Security-Policy meta element')])
    )

    const loose = documentWith({ policy: "default-src 'none'; script-src 'self' 'unsafe-inline'" })
    expect(checkBundle(write({ ...goodFiles(), 'index.html': loose })).problems).toEqual(
      expect.arrayContaining([expect.stringContaining("allows 'unsafe-inline'")])
    )
  })

  describe('the policy', () => {
    const policyProblems = (policy: string, mutate?: (html: string) => string) => {
      const html = documentWith({ policy })
      return checkBundle(write({ ...goodFiles(), 'index.html': mutate ? mutate(html) : html })).problems
    }
    const without = (directive: string) =>
      POLICY.split('; ')
        .filter(part => !part.startsWith(`${directive} `))
        .join('; ')

    it('is the one the document carries today, and the reference is written down', () => {
      const source = readFileSync(join(__dirname, '../../native/web/index.html'), 'utf8')
      const content = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(source)?.[1]

      expect(content).toBe(POLICY)
      expect(
        POLICY.split('; ').map(part => {
          const [name, ...sources] = part.split(' ')
          return [name, sources]
        })
      ).toEqual(Object.entries(REFERENCE_POLICY))
      expect(checkBundle(write(goodFiles())).problems).toEqual([])
    })

    it.each(['default-src', 'base-uri', 'object-src', 'require-trusted-types-for', 'trusted-types', 'frame-src'])(
      'refuses a policy that lacks %s',
      directive => {
        expect(policyProblems(without(directive))).toEqual(
          expect.arrayContaining([`index.html: the policy lacks the ${directive} directive`])
        )
      }
    )

    it('refuses a source added to a directive', () => {
      expect(policyProblems(POLICY.replace("img-src 'self'", "img-src 'self' https:"))).toEqual(
        expect.arrayContaining(['index.html: the policy img-src allows https:, which the reference does not'])
      )
      expect(policyProblems(POLICY.replace("connect-src 'self'", "connect-src 'self' wss://example.org"))).toEqual(
        expect.arrayContaining([expect.stringContaining('connect-src allows wss://example.org')])
      )
    })

    it('refuses a source taken out of a directive', () => {
      expect(policyProblems(POLICY.replace("img-src 'self' data: blob:", "img-src 'self'"))).toEqual(
        expect.arrayContaining([
          'index.html: the policy img-src lacks data:',
          'index.html: the policy img-src lacks blob:'
        ])
      )
    })

    it('refuses a directive the reference does not have, and a repeated one', () => {
      expect(policyProblems(`${POLICY}; frame-ancestors 'none'`)).toEqual(
        expect.arrayContaining(['index.html: the policy has a directive the reference does not: frame-ancestors'])
      )
      expect(policyProblems(`${POLICY}; script-src 'self' https://cdn.example`)).toEqual(
        expect.arrayContaining(['index.html: the policy repeats the script-src directive'])
      )
    })

    it('refuses a policy that is not the first thing the parser reads', () => {
      const early = documentWith().replace(
        '<meta charset="utf-8">',
        '<meta charset="utf-8"><script type="module" src="./assets/react-BBBB.js"></script>'
      )
      expect(checkBundle(write({ ...goodFiles(), 'index.html': early })).problems).toEqual(
        expect.arrayContaining(['index.html: a script element comes before the policy'])
      )

      const link = documentWith().replace(
        '<meta charset="utf-8">',
        '<link rel="stylesheet" href="./assets/index-CCCC.css">'
      )
      expect(checkBundle(write({ ...goodFiles(), 'index.html': link })).problems).toEqual(
        expect.arrayContaining(['index.html: a link element comes before the policy'])
      )
    })

    it('does not take a policy or a script inside a comment for the real one', () => {
      const commented = documentWith().replace(
        '<meta charset="utf-8">',
        `<!-- <meta http-equiv="Content-Security-Policy" content="${POLICY}"> <script src="x.js"></script> -->`
      )
      const without = commented.replace(/\n<meta http-equiv[^>]*>/, '')

      expect(checkBundle(write({ ...goodFiles(), 'index.html': without })).problems).toEqual(
        expect.arrayContaining([expect.stringContaining('no Content-Security-Policy meta element')])
      )
      expect(checkBundle(write({ ...goodFiles(), 'index.html': commented })).problems).toEqual([])
    })

    it('refuses a second policy element', () => {
      const twice = documentWith().replace(
        '<meta charset="utf-8">',
        `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}">`
      )
      expect(checkBundle(write({ ...goodFiles(), 'index.html': twice })).problems).toEqual(
        expect.arrayContaining(['index.html: has more than one Content-Security-Policy meta element'])
      )
    })
  })

  it('refuses a missing document', () => {
    const files = goodFiles()
    delete files['index.html']

    expect(checkBundle(write(files)).problems).toEqual(expect.arrayContaining(['index.html: missing']))
  })
})

describe('build.json', () => {
  it('must exist', () => {
    expect(checkBundle(write(goodFiles(), { manifest: false })).problems).toEqual([
      expect.stringContaining('build.json: missing')
    ])
  })

  it('refuses a file whose byte changed after the build', () => {
    const dir = write(goodFiles())
    writeFileSync(join(dir, 'assets/index-CCCC.css'), 'body{margin:1}')
    const { problems } = checkBundle(dir)

    expect(problems).toEqual([
      expect.stringContaining('assets/index-CCCC.css: does not match build.json (sha256 differs)')
    ])
  })

  it('refuses a changed length with the same hash entry', () => {
    const dir = write(goodFiles())
    writeFileSync(join(dir, 'assets/index-CCCC.css'), 'body{margin:0}x')

    expect(checkBundle(dir).problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('(15 bytes, listed 14)'),
        expect.stringContaining('totalBytes is')
      ])
    )
  })

  it('refuses a file the manifest does not list', () => {
    const dir = write(goodFiles())
    writeFileSync(join(dir, 'assets/extra.js'), 'export {}')

    expect(checkBundle(dir).problems).toEqual(
      expect.arrayContaining(['assets/extra.js: is in the bundle but not listed in build.json'])
    )
  })

  it('refuses a listed file that is gone', () => {
    const dir = write(goodFiles())
    rmSync(join(dir, 'assets/lazy-DDDD.js'))

    expect(checkBundle(dir).problems).toEqual(
      expect.arrayContaining(['build.json: lists assets/lazy-DDDD.js, which is not in the bundle'])
    )
  })

  it('refuses a manifest that is not in canonical form', () => {
    const dir = write(goodFiles(), { tamper: text => text.replace(/\n$/, '') })

    expect(checkBundle(dir).problems).toEqual([expect.stringContaining('not in canonical form')])
  })

  it('refuses a commit that is not 40 hex digits and a manifest that is not JSON', () => {
    const shortCommit = write(goodFiles(), { tamper: text => text.replace(COMMIT, COMMIT.slice(0, 12)) })
    expect(checkBundle(shortCommit).problems).toEqual([
      expect.stringContaining('"sourceCommit" must be a 40-character')
    ])

    const broken = write(goodFiles(), { tamper: () => '{' })
    expect(checkBundle(broken).problems).toEqual([expect.stringContaining('build.json: is not valid JSON')])
  })

  it('refuses a missing build directory', () => {
    expect(checkBundle(join(tmpdir(), 'hermie-bundle-does-not-exist')).problems).toEqual([
      expect.stringContaining('no such build directory')
    ])
  })
})
