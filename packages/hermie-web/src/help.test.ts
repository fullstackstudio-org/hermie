import { describe, expect, it } from 'vitest'

import { HELP } from './help'

/**
 * A container is configured entirely from the environment — there is no
 * `docker run image --flag value` in a Kubernetes Deployment, which sets
 * `env`, not `args`. `--help` is the one place an operator who has never read
 * `deploy/web/README.md` finds out a flag has an environment counterpart at
 * all, so every flag that this package resolves from the environment
 * (`options.ts`, `resolveOptions`) has to name it here.
 */
describe('--help', () => {
  const text = HELP

  const flagsWithEnv: readonly [flag: string, env: string][] = [
    ['--gateway', 'HERMIE_GATEWAY_URL'],
    ['--port', 'HERMIE_PORT'],
    ['--host', 'HERMIE_HOST'],
    ['--public-url', 'HERMIE_PUBLIC_URL'],
    ['--web-public-url', 'HERMIE_WEB_PUBLIC_URL'],
    ['--pass-host', 'HERMIE_PASS_HOST'],
    ['--static', 'HERMIE_STATIC_DIR'],
    ['--login-return', 'HERMIE_LOGIN_RETURN'],
    ['--install-root', 'HERMIE_INSTALL_ROOT'],
    ['--no-self-update', 'HERMIE_SELF_UPDATE'],
    ['--cache-max-mb', 'HERMIE_CACHE_MAX_MB'],
    ['--push', 'HERMIE_PUSH'],
    ['--gateway-token', 'HERMIE_GATEWAY_TOKEN'],
    ['--state-dir', 'HERMIE_STATE_DIR'],
    ['--vapid-subject', 'HERMIE_VAPID_SUBJECT'],
    ['--push-server-requests', 'HERMIE_PUSH_SERVER_REQUESTS'],
    ['--push-relays', 'HERMIE_PUSH_RELAYS'],
    ['--allow-insecure-oidc', 'HERMIE_ALLOW_INSECURE_OIDC'],
    ['--no-oidc', 'HERMIE_OIDC'],
    ['--admins', 'HERMIE_ADMINS']
  ]

  it.each(flagsWithEnv)('lists the flag %s and its environment variable %s', (flag, env) => {
    expect(text).toContain(flag)
    expect(text).toContain(env)
  })

  it('names hash-secret and its env-only variable, with no flag for the plaintext secret', () => {
    expect(text).toContain('hash-secret')
    expect(text).toContain('HERMIE_LOCAL_ADMIN_PASSWORD_HASH')
  })
})
