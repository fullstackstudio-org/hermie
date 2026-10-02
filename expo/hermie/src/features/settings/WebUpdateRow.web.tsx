/**
 * Updating the server that served this page, from the page it served.
 *
 * The whole exchange is two requests and a wait:
 *
 *  1. `GET /hermie/update` says which version is running, which is newest, and
 *     whether this install can replace itself at all. A Docker or `npm -g`
 *     install answers no and carries the command that does work — shown as
 *     text, never as a button that would fail.
 *  2. `POST /hermie/update` downloads, verifies and switches, then answers
 *     `{restarting: true}` and exits. From here that is indistinguishable from
 *     the server dying, so the row polls `/healthz` until a version comes back
 *     — and only reloads the page when the version it reports is the NEW one,
 *     because an old server that never restarted would answer just as happily.
 *
 * The poll gives up after a minute rather than spinning for ever. A server that
 * has not come back by then needs its logs read, not another request.
 */
import { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'

import { strings } from '../../i18n/strings'
import { Button, InsetGroup, InsetRow, InsetValueRow, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'

interface UpdateStatus {
  current: string
  latest: string | null
  publishedAt: string | null
  notesUrl: string | null
  canSelfUpdate: boolean
  updateAvailable: boolean
  reason?: string
}

type Phase = 'checking' | 'idle' | 'updating' | 'restarting' | 'failed'

const RESTART_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 1500

export function WebUpdateRow() {
  const theme = useTheme()
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [phase, setPhase] = useState<Phase>('checking')
  const [error, setError] = useState<string | null>(null)

  const check = useCallback(async (refresh = false) => {
    setPhase('checking')
    setError(null)

    try {
      const response = await fetch(`/hermie/update${refresh ? '?refresh=1' : ''}`, {
        headers: { accept: 'application/json' }
      })

      setStatus((await response.json()) as UpdateStatus)
      setPhase('idle')
    } catch {
      setStatus(null)
      setPhase('idle')
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  const update = async () => {
    setPhase('updating')
    setError(null)

    try {
      const response = await fetch('/hermie/update', { method: 'POST', credentials: 'include' })

      if (response.status === 401) {
        throw new Error(strings.settings.webUpdate.needsSignIn)
      }

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { detail?: string; reason?: string }

        throw new Error(body.detail ?? body.reason ?? `HTTP ${response.status}`)
      }

      const body = (await response.json()) as { version?: string }
      setPhase('restarting')
      await waitForRestart(body.version ?? '')
      window.location.reload()
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError))
      setPhase('failed')
    }
  }

  const current = status?.current ?? ''

  return (
    <InsetGroup
      header={strings.settings.webUpdate.header}
      {...(status?.reason
        ? {
            footer: (
              <Text color="textFaint" variant="meta">
                {status.reason}
              </Text>
            )
          }
        : {})}
    >
      <InsetValueRow
        label={strings.settings.webUpdate.running}
        value={current ? `Hermie Web ${current}` : strings.settings.unknown}
      />

      {phase === 'checking' ? (
        <InsetValueRow label={strings.settings.webUpdate.state} value={strings.settings.webUpdate.checking} />
      ) : phase === 'restarting' ? (
        <InsetValueRow label={strings.settings.webUpdate.state} value={strings.settings.webUpdate.restarting} />
      ) : phase === 'updating' ? (
        <InsetValueRow label={strings.settings.webUpdate.state} value={strings.settings.webUpdate.updating} />
      ) : status?.updateAvailable ? (
        <InsetValueRow
          label={strings.settings.webUpdate.state}
          value={strings.settings.webUpdate.available(status.latest ?? '')}
        />
      ) : (
        <InsetValueRow label={strings.settings.webUpdate.state} value={strings.settings.webUpdate.upToDate} />
      )}

      {error ? (
        <InsetRow>
          <Text color="dangerText" testID="web-update-error" variant="meta">
            {strings.settings.webUpdate.failed(error)}
          </Text>
        </InsetRow>
      ) : null}

      {status?.updateAvailable && status.canSelfUpdate ? (
        <InsetRow>
          <View style={{ gap: theme.space.sm, width: '100%' }}>
            <Button
              busy={phase === 'updating' || phase === 'restarting'}
              disabled={phase === 'updating' || phase === 'restarting'}
              onPress={() => void update()}
              testID="web-update-apply"
              title={strings.settings.webUpdate.apply}
            />
          </View>
        </InsetRow>
      ) : null}
    </InsetGroup>
  )
}

/** Poll `/healthz` until a DIFFERENT version answers, or until we give up. */
async function waitForRestart(expected: string): Promise<void> {
  const deadline = Date.now() + RESTART_TIMEOUT_MS

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))

    try {
      const response = await fetch('/healthz', { cache: 'no-store' })

      if (response.ok) {
        const body = (await response.json()) as { version?: string }

        if (!expected || body.version === expected) {
          return
        }
      }
    } catch {
      // The server is still down; that is what the wait is for.
    }
  }

  throw new Error(strings.settings.webUpdate.restartTimedOut)
}
