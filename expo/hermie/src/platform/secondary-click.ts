/**
 * A secondary click, where the platform has no such event.
 *
 * React Native's `Pressable` offers `onLongPress` and nothing else, so on iOS
 * and Android this hands back nothing: a long press is the gesture there, and
 * it is already wired. The Mac has its own answer again — the system menu, via
 * `platform/context-menu.tsx` — and that one is a native view rather than an
 * event.
 *
 * The browser is the odd one out and `secondary-click.web.ts` is where it is
 * handled: see that file for what was wrong.
 */
export interface SecondaryClickProps {
  onContextMenu?: (event: { preventDefault: () => void }) => void
}

export function secondaryClick(_open: () => void): SecondaryClickProps {
  return {}
}
