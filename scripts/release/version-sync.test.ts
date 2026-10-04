import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * `scripts/set-version.mjs` writes the marketing version into six files
 * and four spots in `package-lock.json`, but nothing checked that a run of
 * it — or a hand edit afterwards — actually left them all agreeing. A file
 * drifted at 0.1.6 for two releases while everything else read 0.1.8 before
 * that script learned about it, and the lockfile's workspace entries drift on
 * every release that npm touches between tags, which is the "0.1.0/0.1.6 →
 * 0.1.8" churn builders kept seeing. This pins every one of those files, plus
 * the matching lockfile entries, to the root package.json's version, so a
 * stale one fails a real gate here instead of surfacing as install noise on
 * whichever machine notices next.
 *
 * (This suite used to live in `packages/hermie-web`, the old Hermie Web
 * server, which was one of the files it pinned. It moved here when that
 * package was removed.)
 *
 * `Cargo.lock` is pinned too: CI builds the desktop crate with `--locked`,
 * and a lock entry left at 0.1.0 while `Cargo.toml` said 0.1.9 failed that
 * job outright.
 *
 * The native Apple apps are the one deliberate exception. `MARKETING_VERSION`
 * in `native/apple/Config/Version.xcconfig` is their own line, set with
 * `set-version --native`, and it may run ahead of the Expo version until the
 * native apps replace the Expo app. What is pinned for it is the rule: a real
 * version, never behind the Expo line, because both upload to the same App
 * Store Connect record.
 *
 * `hermes-shared`, and the other private workspace packages
 * (`fake-gateway`, `gateway-client`, `transcript`), are deliberately left
 * out: they stay at `0.0.0` and never ship on their own, so they have
 * nothing to track.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
}

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Negative, zero or positive: the same order `set-version.mjs` applies to the two lines. */
function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [core = '', pre] = value.split('-', 2)
    return { numbers: core.split('.').map(Number), pre: pre !== undefined }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return Number(b.pre) - Number(a.pre)
}

/** Runs the script in `--check` mode, which never writes, and hands back what it said. */
function setVersionCheck(...args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [path.join(REPO, 'scripts/set-version.mjs'), ...args, '--check'], {
    cwd: REPO,
    encoding: 'utf8'
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
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

    // The crate's own entry in Cargo.lock, which `cargo test --locked` checks.
    const cargoLock = await readFile(path.join(REPO, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8')
    expect(cargoLock).toMatch(
      new RegExp(`^\\[\\[package\\]\\]\\nname = "hermie-desktop"\\nversion = "${escaped}"$`, 'm')
    )
  })

  it('keeps the native line in Version.xcconfig a real version, never behind the Expo line', async () => {
    const root = await readJson(path.join(REPO, 'package.json'))
    const version = root.version as string

    const xcconfig = await readFile(path.join(REPO, 'native/apple/Config/Version.xcconfig'), 'utf8')
    const assignments = [...xcconfig.matchAll(/^MARKETING_VERSION = (.*)$/gm)].map(match => match[1] ?? '')
    expect(assignments).toHaveLength(1)
    const native = assignments[0] ?? ''
    expect(native).toMatch(SEMVER)
    expect(compareVersions(native, version)).toBeGreaterThanOrEqual(0)
  })

  it('lists the Cargo.lock entry and the native rule in a --check run, with nothing to change', async () => {
    const root = await readJson(path.join(REPO, 'package.json'))
    const check = setVersionCheck(root.version as string)

    expect(check.status, check.output).toBe(0)
    expect(check.output).toContain('apps/desktop/src-tauri/Cargo.lock  the hermie-desktop package entry')
    expect(check.output).toMatch(/separate +native\/apple\/Config\/Version\.xcconfig {2}MARKETING_VERSION/)
    expect(check.output).toMatch(/rule +native\/apple\/Config\/Version\.xcconfig {2}native \S+ >= expo /)
    expect(check.output).not.toContain('would set')
  })

  it('treats a run with no version at all as a usage error', () => {
    expect(setVersionCheck().status).toBe(2)
  })

  it('refuses an Expo version that would put the native line behind it', () => {
    const check = setVersionCheck('999.0.0')
    expect(check.status).toBe(1)
    expect(check.output).toContain('would be behind the Expo line (999.0.0)')

    const both = setVersionCheck('999.0.0', '--native', '999.0.0')
    expect(both.status, both.output).toBe(0)
    expect(both.output).toContain('MARKETING_VERSION (the native line)')
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
  })

  it('leaves the private, unversioned workspace packages at 0.0.0', async () => {
    for (const workspace of ['fake-gateway', 'gateway-client', 'transcript']) {
      const pkg = await readJson(path.join(REPO, 'packages', workspace, 'package.json'))
      expect(pkg.version).toBe('0.0.0')
    }
  })
})
