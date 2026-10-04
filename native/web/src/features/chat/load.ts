/**
 * The way into the chat screen's chunk. The screen (the transcript, its item views, the
 * Markdown renderer, the composer, the message menu and what they read) is not part of the first
 * load: the list and the frame are drawn without it, and the entry only holds the dynamic import.
 * The app asks for the chunk as soon as it has drawn once, long before most readers open a chat,
 * and again when a route names a chat (`features/shell/App.tsx`).
 */
export const loadChatScreen = () => import('./ChatScreen')

/** Ask for the chunk early and ignore the answer: the page asks again, and handles a failure, when it renders. */
export const preloadChatScreen = (): void => void loadChatScreen().catch(() => undefined)
