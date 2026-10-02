// Settings as routes: the registry, the stack, and the host that lays them out.
export { AccountRow, type AccountRowProps } from './AccountRow'
export {
  CATEGORY_TINTS,
  categoryWell,
  isSettingsCategory,
  SETTINGS_CATEGORY_LOOK,
  type SettingsCategoryLook
} from './category-look'
export { CategoryHeaderCard, type CategoryHeaderCardProps } from './CategoryHeaderCard'
export { CategoryMark, type CategoryMarkProps, type CategoryMarkSize } from './CategoryMark'
export { CategoryRow, type CategoryRowProps, type CategoryRowVariant } from './CategoryRow'
export {
  isSettingsRouteVisible,
  SETTINGS_ROUTE_META,
  settingsChain,
  settingsDescendants,
  settingsTitle,
  type SettingsRouteMeta
} from './route-meta'
export {
  SETTINGS_CATEGORIES,
  SETTINGS_ROUTE_NAMES,
  settingsRouteFrom,
  type SettingsCategoryName,
  type SettingsParamList,
  type SettingsRouteName
} from './route-names'
export {
  SETTINGS_ROUTES,
  settingsCategory,
  visibleCategories,
  visibleCategoryGroups,
  visibleSettingsRouteNames,
  type SettingsCategory,
  type SettingsRoute
} from './routes'
export { matchCategory, SettingsCategoryList, type SettingsCategoryListProps } from './SettingsCategoryList'
export { SETTINGS_SPLIT_MIN_WIDTH, SettingsHost, type SettingsHostProps } from './SettingsHost'
export {
  SettingsHostChromeContext,
  SettingsPage,
  SettingsScroll,
  useSettingsBack,
  type SettingsHostChrome,
  type SettingsPageProps
} from './SettingsPage'
export { SettingsStack, type SettingsStackProps } from './SettingsStack'
