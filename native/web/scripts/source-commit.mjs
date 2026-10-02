// Which commit a build of the web client came from.
//
// Shared by `vite.config.ts` (the commit is baked into the bundle, so it has to
// be known before the build starts) and `write-build-manifest.mjs` (which
// records it in `build.json`). Both must see the same answer, which is why the
// lookup lives in one place.

import { execFileSync } from 'node:child_process'

const COMMIT = /^[0-9a-f]{40}$/

/**
 * The 40-character commit the build is made from.
 *
 * `HERMIE_SOURCE_COMMIT` wins, so a build that runs outside a checkout (a
 * source archive, a container) can still name its commit; otherwise
 * `git rev-parse HEAD`. A value that is not 40 lowercase hex digits is an
 * error: a manifest that names something else cannot be checked out later.
 *
 * @param {{ env?: Record<string, string | undefined>, cwd?: string }} [options]
 * @returns {string}
 */
export function resolveSourceCommit({ env = process.env, cwd = process.cwd() } = {}) {
  const fromEnv = env.HERMIE_SOURCE_COMMIT?.trim().toLowerCase()

  if (fromEnv) {
    if (!COMMIT.test(fromEnv)) {
      throw new Error('HERMIE_SOURCE_COMMIT must be a full 40-character commit hash')
    }
    return fromEnv
  }

  let head
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    throw new Error(
      'Cannot tell which commit this is: not a git checkout. Set HERMIE_SOURCE_COMMIT to the 40-character hash.'
    )
  }

  if (!COMMIT.test(head)) {
    throw new Error(`git rev-parse HEAD answered "${head}", not a 40-character commit hash`)
  }
  return head
}

/**
 * True when the checkout has changes that are not committed. A build made from
 * such a tree claims a commit it does not match; the manifest script warns.
 *
 * @param {{ cwd?: string }} [options]
 * @returns {boolean}
 */
export function hasUncommittedChanges({ cwd = process.cwd() } = {}) {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return status.trim().length > 0
  } catch {
    return false
  }
}
