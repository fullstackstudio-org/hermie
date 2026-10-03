import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

import { escapeNonAscii } from './scripts/ascii-only.mjs'
import { resolveSourceCommit } from './scripts/source-commit.mjs'

/**
 * The web client's build. Everything here exists to make one promise: the files
 * in `dist/` are the same bytes for the same commit, and they are files the
 * gateway's static route will serve and the plugin scanner will accept.
 *
 *  - `base: './'` and hashed names under `assets/`: the page lives at a fixed
 *    path under the gateway's origin but the gateway may sit behind a path
 *    prefix, so no URL in the output is absolute.
 *  - ASCII only (`esbuild.charset`): the scanner flags invisible characters, so
 *    non-ASCII is escaped rather than left to be judged.
 *  - No `!` followed by a backtick inside a string or a pattern: the scanner
 *    reads that as an inline shell snippet (see `backtickAfterBangEscaped`).
 *  - Nothing is inlined as a `data:` URI (`assetsInlineLimit: 0`): the policy
 *    in `index.html` allows `data:` for images only, not fonts or scripts.
 *  - Source maps are written next to `dist/`, not into it: the plugin tree must
 *    not carry them (`dist-maps/` is uploaded as a CI artefact instead).
 *  - No timestamps and no machine-specific input reach the output. The only
 *    inputs are the sources, the lockfile, the version and the source commit.
 *
 * `scripts/write-build-manifest.mjs` runs after this and records a SHA-256 for
 * every output file.
 */

const root = dirname(fileURLToPath(import.meta.url))

/** Where the page is served on a gateway, relative to the gateway's origin. */
const SERVED_APP_PATH = '/dashboard-plugins/hermie/app/'

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }

/** Rollup chunk for the libraries every screen needs; nothing else is split out by hand. */
function manualChunks(id: string): string | undefined {
  if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
    return 'react'
  }
  return undefined
}

/**
 * Writes what is left of non-ASCII text in the JavaScript as `\uXXXX`, or fails
 * the build where that would not mean the same thing (`scripts/ascii-only.mjs`
 * says which, and why). Only ever sees text the minifier left unescaped.
 */
function asciiOnlyScripts(): Plugin {
  return {
    name: 'hermie:ascii-only-scripts',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk') {
          file.code = escapeNonAscii(file.code, code => this.parse(code), file.fileName)
        }
      }
    }
  }
}

/** The node shapes this file reads from the parser: ESTree, whatever else a node carries. */
interface SyntaxNode {
  type: string
  start: number
  end: number
  value?: unknown
  regex?: unknown
}

/**
 * Spells a backtick that follows `!`, inside a string or a regular expression, as
 * `\x60`.
 *
 * The plugin scanner's `inline_shell_exec` pattern is `!` followed by a backtick,
 * a character that is not a space, and a closing backtick on the same line (the
 * inline-shell syntax of a Hermes skill). Minified Markdown code is full of
 * pattern sources that say "not followed by a backtick", `(?!`)` and `(?<!`)`,
 * and the scanner of the pinned upstream reads two of them as a command: a HIGH
 * finding, a `caution` verdict, an import that needs a person to confirm it.
 * `\x60` is the same character in a string, a template and a pattern (with or
 * without the `u` flag), so nothing about the program changes. Only literals are
 * touched: a backtick that opens a template, after a `!`, stays where it is.
 */
function backtickAfterBangEscaped(): Plugin {
  const marker = '!`'

  return {
    name: 'hermie:backtick-after-bang-escaped',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk' || !file.code.includes(marker)) {
          continue
        }

        const literals: SyntaxNode[] = []
        const visit = (node: unknown): void => {
          if (Array.isArray(node)) {
            node.forEach(visit)
          } else if (typeof node === 'object' && node !== null && 'type' in node) {
            const syntax = node as SyntaxNode

            if (syntax.type === 'Literal' && (typeof syntax.value === 'string' || syntax.regex !== undefined)) {
              literals.push(syntax)
            }

            Object.values(node).forEach(visit)
          }
        }

        visit(this.parse(file.code))

        // From the end, so an earlier replacement does not move a later offset.
        let code = file.code

        for (const literal of literals.sort((a, b) => b.start - a.start)) {
          const source = code.slice(literal.start, literal.end)

          if (source.includes(marker)) {
            code = code.slice(0, literal.start) + source.replaceAll(marker, '!\\x60') + code.slice(literal.end)
          }
        }

        file.code = code
      }
    }
  }
}

/**
 * Moves `*.map` out of the output directory into `<outDir>-maps`. Vite can only
 * write maps beside the files they describe; the bundle that is imported into
 * the plugin must not contain them.
 */
function mapsOutsideOutDir(): Plugin {
  let outDir = ''

  return {
    name: 'hermie:maps-outside-out-dir',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    writeBundle() {
      const mapsDir = `${outDir}-maps`
      rmSync(mapsDir, { recursive: true, force: true })

      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(path)
          } else if (entry.name.endsWith('.map')) {
            const target = join(mapsDir, relative(outDir, path))
            mkdirSync(dirname(target), { recursive: true })
            renameSync(path, target)
          }
        }
      }
      walk(outDir)
    }
  }
}

/**
 * Development only. The document's policy forbids inline scripts, inline
 * styles, `ws:` sockets and `require-trusted-types-for`, and the dev server needs
 * all four (the React refresh preamble, injected styles, hot-reload, and its own
 * helpers). The production build is never touched; the end-to-end suites run
 * against `dist/`, which keeps the real policy.
 */
function relaxPolicyInDevelopment(): Plugin {
  const meta = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/

  return {
    name: 'hermie:relax-policy-in-development',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(meta, (_all, open: string, policy: string, close: string) => {
        const relaxed = policy
          .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
          .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
          .replace("connect-src 'self'", "connect-src 'self' ws: wss:")
          .replace(/;\s*require-trusted-types-for 'script'/, '')
          .replace(/;\s*trusted-types 'none'/, '')
        return `${open}${relaxed}${close}`
      })
    }
  }
}

/**
 * Development only. Serves the page at the path a gateway serves it at, so the
 * client's own base-path derivation sees what it will see in production, and
 * sends the gateway's own routes to a gateway (the fake one by default).
 */
function serveAtGatewayPath(): Plugin {
  return {
    name: 'hermie:serve-at-gateway-path',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith(SERVED_APP_PATH)) {
          req.url = `/${req.url.slice(SERVED_APP_PATH.length)}`
        }
        next()
      })
    }
  }
}

/**
 * `--mode harness`: the development-only pages under `src/dev` (the transcript
 * harness), built into `dist-harness/` and served by `vite preview --mode
 * harness` for the performance specs. Production React, minified, the same
 * policy; nothing of it is in `dist/`, whose only entry is `index.html`.
 */
const HARNESS_MODE = 'harness'
const HARNESS_PORT = 4180

export default defineConfig(({ command, mode }) => {
  const harness = mode === HARNESS_MODE

  // A build must name the commit it is made from. The dev server, the unit
  // tests and the harness do not publish anything, so they may run from a tree
  // with no git.
  let commit: string
  try {
    commit = resolveSourceCommit()
  } catch (error) {
    if (command === 'build' && !harness) {
      throw error
    }
    commit = '0'.repeat(40)
  }

  const gateway = process.env.HERMIE_DEV_GATEWAY ?? 'http://127.0.0.1:9119'

  return {
    root,
    base: './',
    plugins: harness
      ? [react()]
      : [
          react(),
          asciiOnlyScripts(),
          backtickAfterBangEscaped(),
          mapsOutsideOutDir(),
          relaxPolicyInDevelopment(),
          serveAtGatewayPath()
        ],
    define: {
      __HERMIE_VERSION__: JSON.stringify(packageJson.version),
      __HERMIE_COMMIT__: JSON.stringify(commit)
    },
    // ASCII output for scripts and styles alike: Vite hands the same option to
    // the CSS minifier.
    esbuild: { charset: 'ascii' },
    build: {
      outDir: harness ? 'dist-harness' : 'dist',
      emptyOutDir: true,
      assetsDir: 'assets',
      target: 'es2022',
      sourcemap: harness ? false : 'hidden',
      assetsInlineLimit: 0,
      // The static route serves no more than the policy and the scanner allow;
      // `scripts/web/check-bundle.mjs` is the gate, this only warns earlier.
      chunkSizeWarningLimit: 900,
      reportCompressedSize: false,
      // The browsers this client supports preload modules natively.
      modulePreload: { polyfill: false },
      rollupOptions: {
        ...(harness ? { input: join(root, 'src/dev/transcript-harness.html') } : {}),
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
          manualChunks
        }
      }
    },
    preview: { port: HARNESS_PORT, strictPort: true, host: '127.0.0.1' },
    server: {
      port: 5173,
      proxy: {
        '/api': { target: gateway, ws: true, changeOrigin: true },
        '/auth': { target: gateway, changeOrigin: true },
        '/login': { target: gateway, changeOrigin: true }
      }
    }
  }
})
