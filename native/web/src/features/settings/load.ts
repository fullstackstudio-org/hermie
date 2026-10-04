/**
 * The way into the Settings chunk. Settings is not part of the first load: the host (the home, the
 * way back, the section a route names) is one chunk, fetched when a settings route is opened or when a
 * pointer or the focus reaches the link to it, and each sizeable section is a chunk of its own inside
 * it (`SettingsHost.tsx`). This file is the only thing the entry imports from here, and it holds no
 * more than the dynamic import.
 */
export const loadSettingsHost = () => import('./SettingsHost')

/** Ask for the chunk early and ignore the answer: the page asks again, and handles a failure, when it renders. */
export const preloadSettingsHost = (): void => void loadSettingsHost().catch(() => undefined)
