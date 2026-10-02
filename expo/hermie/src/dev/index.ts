/**
 * Development-only entry points.
 *
 * Everything under `src/dev` is behind `__DEV__` at its own source and behind
 * `#if DEBUG` in the one native constant it reads. See `launch-intent.ts` for the
 * three gates and why a screen-opening back door gets all three.
 */
import { DEV_LAUNCH_INTENT, type DevOverlaySection, type DevSettingsPage } from './launch-intent'

export { DevGallery } from './DevGallery'
export {
  DEV_LAUNCH_INTENT,
  parseDevLaunchArguments,
  type DevGatewaySeed,
  type DevLaunchIntent,
  type DevOpenTarget,
  type DevOverlaySection,
  type DevSettingsPage
} from './launch-intent'
export { seedDevGateway } from './seed-gateway'

/**
 * Where a shell should start, when a launch argument said so.
 *
 * The shells take this rather than reading the intent themselves: both of them
 * already own "which bot is selected" and "which section is open", and a second
 * reader of the same fact is a second place for the two layouts to disagree.
 */
export interface DevInitialView {
  bot?: string
  section?: DevOverlaySection
  page?: DevSettingsPage
}

export function devInitialView(): DevInitialView | undefined {
  const open = DEV_LAUNCH_INTENT?.open

  if (open?.kind === 'chat') {
    return { bot: open.bot }
  }

  if (open?.kind === 'overlay') {
    return { section: open.section, ...(open.page ? { page: open.page } : {}) }
  }

  return undefined
}
