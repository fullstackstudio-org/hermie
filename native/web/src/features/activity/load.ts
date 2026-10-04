/**
 * The way into the Activity chunk: the timeline page is fetched when `#/activity` is opened, or earlier, when a
 * pointer or the focus reaches the link to it in the sidebar. See `features/cron/load.ts`.
 */
export const loadActivityPage = () => import('./ActivityPage')

/** Ask for the chunk early and ignore the answer: the page asks again, and handles a failure, when it renders. */
export const preloadActivityPage = (): void => void loadActivityPage().catch(() => undefined)
