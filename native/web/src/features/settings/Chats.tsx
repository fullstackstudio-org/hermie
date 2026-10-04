/**
 * Settings, Chats: what a conversation shows until the reader says otherwise, and whether this
 * browser keeps the transcripts it has read.
 *
 * **The defaults** are the chat view's (`state/chat-view.ts`): the verbosity, bot-to-bot and thinking a
 * conversation without a setting of its own follows. They are changed through `setDefaults`, and a
 * conversation that has its own keeps it (the chat's options panel says which it is on). They are kept
 * in this browser under the signed-in person; the account's synced `defaults` is not read by this client
 * yet.
 *
 * **The transcript cache** (`platform/chat-cache.ts`) is where an opened conversation and the roster are
 * kept so they paint before the gateway has answered. It is the reader's to switch off, and "Clear now"
 * empties it at once. Switching it off clears what is stored too: a setting that stopped new copies and
 * left the old ones would not mean what it says. The choice is the browser's (`device.transcriptCache`),
 * so it survives a sign-out; the transcripts do not (sign-out clears them).
 */
import { type ReactElement, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { chatViewStore, VERBOSITIES } from '../../state/chat-view'
import { settingsStore } from '../../state/settings'
import { Button } from '../../ui/primitives'
import { Checkbox, RadioGroup, type RadioOption, SettingsPage } from './controls'
import { useSettingsRuntime } from './settings-runtime'

interface Message {
  tone: 'ok' | 'danger'
  text: string
}

export function Chats(): ReactElement {
  useLocale()

  const runtime = useSettingsRuntime()
  const defaults = useStore(
    chatViewStore,
    useShallow(state => state.defaults)
  )
  const cacheOn = useStore(settingsStore, state => state.transcriptCache)
  const [message, setMessage] = useState<Message | null>(null)
  const [clearing, setClearing] = useState(false)
  /** The newest clear: an older one that settles after it must not say its piece. */
  const run = useRef(0)

  const words = sheetStrings.settings.chats

  const verbosityOptions: RadioOption<(typeof VERBOSITIES)[number]>[] = VERBOSITIES.map(value => ({
    value,
    label: strings.chat.options.verbosityOptions[value]
  }))

  const clear = async (done: string): Promise<void> => {
    const mine = ++run.current

    setClearing(true)

    try {
      await runtime?.clearTranscriptCache()

      if (mine === run.current) {
        setMessage({ tone: 'ok', text: done })
      }
    } catch {
      if (mine === run.current) {
        setMessage({ tone: 'danger', text: words.cacheFailed })
      }
    } finally {
      if (mine === run.current) {
        setClearing(false)
      }
    }
  }

  const keep = (enabled: boolean): void => {
    settingsStore.getState().setTranscriptCache(enabled)

    if (enabled) {
      setMessage({ tone: 'ok', text: words.cacheOn })

      return
    }

    // Off means nothing is left behind: what is stored goes now.
    void clear(words.cacheOff)
  }

  return (
    <SettingsPage title={strings.app.settings.categories.chats}>
      <h3 className="hm-settings-page__heading">{words.defaultsHeading}</h3>

      <RadioGroup
        legend={strings.app.settings.defaultVerbosity}
        value={defaults.level}
        options={verbosityOptions}
        onChange={level => chatViewStore.getState().setDefaults({ level })}
        hint={strings.app.settings.defaultVerbosityHint}
        layout="wrap"
      />

      <Checkbox
        label={strings.app.settings.showBotToBot}
        checked={defaults.showBotToBot}
        onChange={showBotToBot => chatViewStore.getState().setDefaults({ showBotToBot })}
      />

      <Checkbox
        label={strings.app.settings.showThinking}
        checked={defaults.showThinking}
        onChange={showThinking => chatViewStore.getState().setDefaults({ showThinking })}
      />

      <p className="hm-set__hint">{words.defaultsNote}</p>

      <h3 className="hm-settings-page__heading">{words.cacheHeading}</h3>

      <Checkbox label={words.cacheKeep} checked={cacheOn} onChange={keep} hint={words.cacheHint} />

      <div className="hm-settings-page__actions">
        <Button
          variant="quiet"
          disabled={runtime === null}
          aria-busy={clearing}
          onClick={() => {
            // Not disabled while it works: a button that disables itself drops the focus the reader was using.
            if (clearing) {
              return
            }

            setMessage(null)
            void clear(words.cacheCleared)
          }}
        >
          {words.cacheClear}
        </Button>
      </div>

      <p className="hm-settings-page__message" role="status" data-tone={message?.tone}>
        {message?.text ?? ''}
      </p>
    </SettingsPage>
  )
}
