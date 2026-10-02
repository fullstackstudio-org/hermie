import { buildLabel } from './build-info'

/**
 * What the client shows until there is a client: the build it came from. It
 * talks to no gateway, so it also serves as the smoke page the bundle checks
 * and the first plugin import are exercised with.
 */
export function Placeholder() {
  return (
    <main className="placeholder">
      <h1>Hermie</h1>
      <p>The web client is under construction. This page only shows the build it came from.</p>
      <p>
        <span>Build </span>
        <code>{buildLabel}</code>
      </p>
    </main>
  )
}
