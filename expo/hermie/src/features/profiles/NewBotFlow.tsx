/**
 * The New-bot flow, from the sheet to the open chat.
 *
 * It is a component rather than a hook because it owns a sheet, and it is ONE
 * component rather than one per entry point because the three steps after
 * "Create" — create, refresh the roster, resolve the canonical chat — must not
 * have two implementations. ADR-0007 allows exactly one way for a Bot Chat to
 * come into existence, and a second copy of this flow would be a second way.
 *
 * `onOpened` is optional, and that is the difference between the two callers.
 * From the chat list, making a bot should land the reader in its conversation.
 * From Settings there is nowhere to land — the bot appears in the list, which
 * is where they will look for it — so Settings passes nothing and the sheet
 * simply closes.
 */
import { prettyModelName } from '@hermie/transcript'
import { useEffect, useMemo, useState } from 'react'

import { useChatRuntime } from '../chats/ChatRuntime'
import { useBotsStore, type Bot } from '../../store/bots'
import { useGateway } from '../../gateway'
import { chatGatewayFor } from '../../gateway/link'
import { NewBotSheet, type ModelChoice } from './NewBotSheet'
import { ProfilesController, type NewBotDraft } from './profiles-controller'
import { profileStrings } from './strings'

export interface NewBotFlowProps {
  visible: boolean
  onClose: () => void
  /** Called with the new bot once its canonical chat has been resolved. */
  onOpened?: (bot: Bot, sessionId: string) => void
}

export function NewBotFlow({ visible, onClose, onOpened }: NewBotFlowProps) {
  const { connection } = useGateway()
  const runtime = useChatRuntime()
  const bots = useBotsStore(state => state.bots)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<readonly ModelChoice[]>([])

  const controller = useMemo(() => {
    const botsController = runtime?.bots

    if (!connection || !botsController) {
      return null
    }

    return new ProfilesController({
      gateway: chatGatewayFor(connection),
      refreshRoster: () => botsController.refresh(),
      resolveCanonical: bot => botsController.resolveCanonical(bot)
    })
  }, [connection, runtime])

  useEffect(() => {
    if (!visible || !connection) {
      return
    }

    setError(null)

    let cancelled = false

    /*
      `explicit_only` keeps the list to providers this gateway is actually
      configured for: `include_unconfigured` would offer models the new bot
      could never reach, which is a worse first experience than inheriting.

      A failure here is not an error the reader needs. Without the picker the
      bot inherits the launch profile's model, which is what most people want
      anyway — so the field simply does not appear.
    */
    void chatGatewayFor(connection)
      .request('model.options', { explicit_only: true })
      .then(options => {
        if (cancelled) {
          return
        }

        setModels(
          (options.providers ?? []).flatMap(provider =>
            (provider.models ?? []).map(model => ({
              // The same formatter the chat's own model picker uses. The
              // inventory writes wire ids, and a reader choosing a model for a
              // brand-new bot should be reading the same words here as in the
              // chat they will open next.
              //
              // The provider is a SECTION now rather than a prefix on every
              // label. Repeating it on each row was the only way a horizontal
              // strip could say it, and it is what made the labels too long to
              // survive being squeezed into one segment each.
              label: prettyModelName(model),
              detail: `${provider.slug}/${model}`,
              model: `${provider.slug}/${model}`,
              provider: provider.slug,
              providerName: provider.name || provider.slug
            }))
          )
        )
      })
      .catch(() => setModels([]))

    return () => {
      cancelled = true
    }
  }, [connection, visible])

  const create = (draft: NewBotDraft) => {
    if (!controller) {
      return
    }

    setBusy(true)
    setError(null)

    void controller
      .create(draft)
      .then(created => {
        onClose()
        onOpened?.(created.bot, created.sessionId)
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  return (
    <NewBotSheet
      busy={busy}
      cloneable={bots.map(bot => bot.name)}
      error={error}
      models={models}
      onCancel={onClose}
      onCreate={create}
      taken={bots.map(bot => bot.name)}
      visible={visible}
    />
  )
}

export { profileStrings }
