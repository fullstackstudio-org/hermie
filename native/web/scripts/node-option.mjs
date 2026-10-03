// Asks a Node binary whether it starts with a flag in `NODE_OPTIONS`. Node refuses
// to start on a flag it does not know ("is not allowed in NODE_OPTIONS"), so the
// only reliable test is to start it with the flag and look at the exit status; a
// version number says nothing about a flag that was added, renamed or unflagged
// between releases. Used by `run-vitest.mjs`.

import { spawnSync } from 'node:child_process'

/** `NODE_OPTIONS` with `flag` added to what it holds. */
export function withNodeOption(flag, options = process.env.NODE_OPTIONS) {
  return [options, flag].filter(Boolean).join(' ')
}

/**
 * @param {string} flag e.g. `--no-webstorage`
 * @param {{ execPath?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {boolean} whether `execPath` (this Node by default) starts with `flag` in `NODE_OPTIONS`
 */
export function acceptsNodeOption(flag, options = {}) {
  const env = options.env ?? process.env
  const probe = spawnSync(options.execPath ?? process.execPath, ['-e', ''], {
    env: { ...env, NODE_OPTIONS: withNodeOption(flag, env.NODE_OPTIONS) },
    stdio: 'ignore'
  })

  return probe.status === 0
}
