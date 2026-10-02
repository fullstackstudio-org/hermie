/**
 * The browser half of `secondary-click.ts`.
 *
 * A chat row's menu — rename, archive, delete, add a divider — was reachable by
 * exactly one gesture: a long press. That is the right gesture on a phone and
 * it is a gesture nobody performs with a mouse; on a desktop the same menu is
 * a right click, which React Native has no event for, so the browser build
 * simply had no way to open it. Driving the list in a real browser is how that
 * was noticed: right-clicking a row did nothing at all.
 *
 * `onContextMenu` is a DOM event react-native-web forwards, so this is a prop
 * bag rather than a seam with a component in it. `preventDefault` is not
 * optional: without it the browser's own menu opens over the app's, which is
 * two menus for one gesture.
 *
 * The long press stays. It costs nothing, a touch-screen laptop is a real
 * thing, and removing it would be a second behaviour to keep in step.
 */
import type { SecondaryClickProps } from './secondary-click'

export type { SecondaryClickProps } from './secondary-click'

export function secondaryClick(open: () => void): SecondaryClickProps {
  return {
    onContextMenu: event => {
      event.preventDefault()
      open()
    }
  }
}
