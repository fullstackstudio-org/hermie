/**
 * The way into the New bot page's chunk: no more than the dynamic import and the early ask, so the sidebar's link
 * can ask for the page as soon as a pointer or the focus reaches it without importing the page itself.
 */
export const loadNewBotPage = () => import('./NewBotPage')

/** Ask for the chunk early and ignore the answer: the page asks again, and handles a failure, when it renders. */
export const preloadNewBotPage = (): void => void loadNewBotPage().catch(() => undefined)
