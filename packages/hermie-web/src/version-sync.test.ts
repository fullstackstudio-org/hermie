import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * `scripts/set-version.mjs` writes the marketing version into seven files
 * and five spots in `package-lock.json`, but nothing checked that a run of
 * it — or a hand edit afterwards — actually left them all agreeing.
 * `packages/hermie-web/package.json` drifted at 0.1.6 for two releases while
 * everything else read 0.1.8 before that script learned about it, and the
 * lockfile's workspace entries drift on every release that npm touches
 * between tags, which is the "0.1.0/0.1.6 → 0.1.8" churn builders kept
 * seeing. This pins every one of those files, plus the matching lockfile
 * entries, to the root package.json's version, so a stale one fails a real
 * gate here instead of surfacing as install noise on whichever machine
 * notices next.
 *
 * `hermes-shared`, and the other private workspace packages
 * (`fake-gateway`, `gateway-client`, `transcript`), are deliberately left
 * out: they stay at `0.0.0` and never ship on their own, so they have
 * nothing to track.
 */

// `__dirname` rather than `import.meta`, matching tsconfig-test.test.ts in
// this same package: it compiles to CommonJS.
const PACKAGE = path.resolve(__dirname, '..')
const REPO = path.resolve(PACKAGE, '..', '..')

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
}

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('the release version, everywhere set-version.mjs writes it', () => {
  it('matches across every file the script manages', async () => {
    const root = await readJson(path.join(REPO, 'package.json'))
    const version = root.version as string
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
    const escaped = escapeForRegExp(version)

    const appPkg = await readJson(path.join(REPO, 'expo/hermie/package.json'))
    expect(appPkg.version).toBe(version)

    const appConfig = await readFile(path.join(REPO, 'expo/hermie/app.config.ts'), 'utf8')
    expect(appConfig).toMatch(new RegExp(`version:\\s*'${escaped}'`))

    const desktopPkg = await readJson(path.join(REPO, 'apps/desktop/package.json'))
    expect(desktopPkg.version).toBe(version)

    const tauriConf = await readJson(path.join(REPO, 'apps/desktop/src-tauri/tauri.conf.json'))
    expect(tauriConf.version).toBe(version)

    const cargoToml = await readFile(path.join(REPO, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8')
    expect(cargoToml).toMatch(new RegExp(`^version = "${escaped}"`, 'm'))

    const webPkg = await readJson(path.join(REPO, 'packages/hermie-web/package.json'))
    expect(webPkg.version).toBe(version)
  })

  it('matches in package-lock.json: the root document and every managed workspace entry', async () => {
    const root = await readJson(path.join(REPO, 'package.json'))
    const version = root.version as string

    const lock = (await readJson(path.join(REPO, 'package-lock.json'))) as {
      version: string
      packages: Record<string, { version: string } | undefined>
    }

    expect(lock.version).toBe(version)
    expect(lock.packages['']?.version).toBe(version)
    expect(lock.packages['expo/hermie']?.version).toBe(version)
    expect(lock.packages['apps/desktop']?.version).toBe(version)
    expect(lock.packages['packages/hermie-web']?.version).toBe(version)
  })

  it('leaves the private, unversioned workspace packages at 0.0.0', async () => {
    for (const workspace of ['fake-gateway', 'gateway-client', 'transcript']) {
      const pkg = await readJson(path.join(REPO, 'packages', workspace, 'package.json'))
      expect(pkg.version).toBe('0.0.0')
    }
  })
})
