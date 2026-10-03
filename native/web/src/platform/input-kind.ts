/**
 * Whether a keyboard is likely to be in front of the reader, as far as a page can
 * tell.
 *
 * The composer's rule for Return is the native apps' (`features/chat/send-key.ts`):
 * with a keyboard attached Return sends and Shift+Return breaks the line; with
 * none, the key on a software keyboard is the only way to write a second line, so
 * there it breaks the line and the Send button sends. A page cannot ask for a
 * keyboard. What it can read is whether a precise pointer (a mouse, a trackpad)
 * is attached: a phone has none, and a laptop, a desktop and an iPad with a
 * trackpad do. Where the answer is unknown (no `matchMedia`), a keyboard is
 * assumed, which is the rule the plan states.
 */

/** The part of `window` this reads, so a test can hand in its own. */
export interface InputEnvironment {
  matchMedia?: (query: string) => { matches: boolean }
}

const pageEnvironment = (): InputEnvironment | null => (typeof window === 'undefined' ? null : window)

/** A mouse or a trackpad is attached to this device. */
export function hasFinePointer(environment: InputEnvironment | null = pageEnvironment()): boolean {
  if (!environment?.matchMedia) {
    return true
  }

  try {
    return environment.matchMedia('(any-pointer: fine)').matches
  } catch {
    return true
  }
}
