/**
 * The way into the Crons chunk. The Crons pages (the list, one cron, the editor, a run) are not part of the first
 * load: they are one chunk, fetched when a Crons route is opened, or earlier, when a pointer or the focus reaches
 * the link to them in the sidebar. A run's transcript is a chunk inside it (`CronsPage.tsx`). This file is the
 * only thing the entry imports from here besides the runtime context, and it holds no more than the dynamic import.
 */
export const loadCronsPage = () => import('./CronsPage')

/** Ask for the chunk early and ignore the answer: the page asks again, and handles a failure, when it renders. */
export const preloadCronsPage = (): void => void loadCronsPage().catch(() => undefined)
