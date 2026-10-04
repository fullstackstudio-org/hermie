/**
 * What this browser can do about voice, asked of the page's own window.
 *
 * Two different questions with two different answers, which is why the controls come and go separately:
 *
 *  - **Speaking** is `speechSynthesis`, which Safari, Chrome and Firefox have all shipped for years. It is the
 *    browser's own voices on this device, and nothing is sent anywhere.
 *  - **Listening** is `SpeechRecognition`, which never became a standard everybody shipped. Chrome has it as
 *    `webkitSpeechRecognition` and Safari has it too, and both send the audio to their vendor's servers
 *    (Google's, Apple's) to be turned into text, with no switch to stop that. Firefox does not have it at all.
 *
 * A control for a capability the browser lacks is not drawn: there is nothing a reader could do about it, and a
 * permanently disabled button is a worse answer than a composer that does not offer the feature. Static for the
 * life of a page, so the answer is read when a screen asks and never subscribed to.
 *
 * Small on purpose: the chat screen and the composer read it on every chat, and everything else in `features/voice`
 * is fetched only when a reader uses it.
 */

/** The part of a window these checks read, so a test hands in its own. */
export interface VoiceWindow {
  speechSynthesis?: unknown
  SpeechSynthesisUtterance?: unknown
  SpeechRecognition?: unknown
  webkitSpeechRecognition?: unknown
}

const pageWindow = (): VoiceWindow | null => {
  try {
    return typeof window === 'undefined' ? null : (window as unknown as VoiceWindow)
  } catch {
    // A document with a restrictive policy can throw on the property access.
    return null
  }
}

/** Whether this browser can read a reply aloud. */
export function canSpeak(win: VoiceWindow | null = pageWindow()): boolean {
  try {
    return Boolean(win) && Boolean(win?.speechSynthesis) && typeof win?.SpeechSynthesisUtterance === 'function'
  } catch {
    return false
  }
}

/** Whether this browser can take dictation: `SpeechRecognition`, or Chrome's and Safari's prefixed name for it. */
export function canDictate(win: VoiceWindow | null = pageWindow()): boolean {
  try {
    return typeof win?.SpeechRecognition === 'function' || typeof win?.webkitSpeechRecognition === 'function'
  } catch {
    return false
  }
}

/** Neither half is there: the Settings section is not listed. */
export const hasVoice = (win: VoiceWindow | null = pageWindow()): boolean => canSpeak(win) || canDictate(win)
