/**
 * Settings, for the shells: the name they have always mounted, now pointing at
 * `navigation/SettingsHost`.
 *
 * The screen used to be one long `ScrollView` with ten `showX` booleans that
 * swapped the whole page for a subpage, each drawing its own back control in
 * its own shape — the root cause of HERM-101. It is a native stack over a
 * category list now (HERM-108); nothing about the call sites changed except the
 * name of the development-only entry point, which is a route rather than a page
 * flag.
 */
export {
  SettingsHost as SettingsScreen,
  type SettingsHostProps as SettingsScreenProps
} from './navigation/SettingsHost'
