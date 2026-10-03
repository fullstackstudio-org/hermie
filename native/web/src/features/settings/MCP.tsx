/**
 * What the gateway says about its MCP endpoint, and the clients connected to it
 * (`#/settings/mcp`; `contract/gateway/mcp.md`): whether MCP is on, the endpoint,
 * the command and the JSON config to add it to a client (each with a Copy
 * button), the gateway's own instructions, and the connected clients with
 * Revoke. The native apps' Settings › MCP page, kept to what a browser needs.
 *
 * Hermie never speaks MCP and runs no server: everything here is the gateway's
 * text, drawn as plain text and copied exactly as it came (the command and the
 * config are never built from the endpoint, and never run). The page reads the
 * list when it is opened and follows `mcp.changed` and the tab's return to the
 * foreground (`McpModel.watch`).
 *
 * A gateway with no MCP (404) gets one sentence and nothing else; a session
 * without a person (403 `no_identity`, 401) is told to sign in. A revoke asks
 * first, ends the grant at once, and treats "there is no such grant" as done.
 */
import { type ReactElement, useEffect, useId, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'

import { McpRouteError } from '../../core/mcp/client'
import { displayText, NAME_LIMIT } from '../../core/requests/secure-input'
import { formatDateTime } from '../../i18n/format'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { writeClipboard } from '../../platform/clipboard'
import { type McpState, mcpStore } from '../../state/mcp'
import { Button } from '../../ui/primitives'
import { useMcpRuntime } from './mcp-runtime'
import './mcp.css'

interface Message {
  tone: 'ok' | 'danger'
  text: string
}

/** How far an address or an error from the gateway runs before it is cut. */
const ADDRESS_LIMIT = 64
const FAILURE_LIMIT = 200
/** The gateway's own instructions are a few sentences. */
const INSTRUCTIONS_LIMIT = 2000

/** What a failed revoke says. */
export function revokeFailure(error: unknown, host: string): string {
  const words = sheetStrings.mcp.settings

  if (error instanceof McpRouteError) {
    if (error.error === 'origin_not_listed') {
      return words.originNotListed({ host })
    }

    if (error.kind === 'no_identity') {
      return words.signIn
    }

    if (error.kind === 'not_offered') {
      return words.notOffered
    }
  }

  return words.revokeFailed({
    message: displayText(error instanceof Error ? error.message : String(error), FAILURE_LIMIT)
  })
}

/** A client's name as it is drawn: the gateway's text, cleaned to one line, or a word for "no name". */
const clientLabel = (name: string): string => displayText(name, NAME_LIMIT) || sheetStrings.mcp.settings.unnamed

export function Mcp({ store = mcpStore }: { store?: StoreApi<McpState> }): ReactElement {
  useLocale()

  const runtime = useMcpRuntime()
  const status = useStore(store, state => state.status)
  const problem = useStore(store, state => state.problem)
  const loaded = useStore(store, state => state.loaded)
  const change = useStore(store, state => state.change)
  const words = sheetStrings.mcp.settings
  const ids = useId()
  const clientsRef = useRef<HTMLHeadingElement>(null)
  /** The Revoke button that takes the focus back once the row has drawn it again (Cancel). */
  const refocus = useRef<string | null>(null)
  // A change that was already there when the page opened is not news.
  const seenChange = useRef(change?.id ?? 0)
  const [message, setMessage] = useState<Message | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  // Read now, and follow the gateway while the page is open.
  useEffect(() => runtime?.watch(), [runtime])

  useEffect(() => {
    if (refocus.current !== null) {
      document.getElementById(`${ids}-revoke-${refocus.current}`)?.focus()
      refocus.current = null
    }
  })

  // Something changed that this page did not do: say it, in the gateway's words for the client.
  useEffect(() => {
    if (!change || change.id === seenChange.current) {
      return
    }

    seenChange.current = change.id

    const name = clientLabel(change.clientName)

    setMessage({
      tone: 'ok',
      text:
        change.change === 'granted'
          ? words.changedGranted({ name })
          : change.change === 'revoked'
            ? words.revoked({ name })
            : words.changedOther
    })
  }, [change, words])

  const copy = (text: string): void => {
    void writeClipboard(text).then(copied =>
      setMessage({ tone: copied ? 'ok' : 'danger', text: copied ? words.copied : words.notCopied })
    )
  }

  const revoke = (id: string, name: string): void => {
    if (!runtime || revoking !== null) {
      return
    }

    setConfirming(null)
    setRevoking(id)
    setMessage(null)

    void runtime
      .revoke(id)
      .then(result => {
        setMessage({ tone: 'ok', text: result === 'gone' ? words.gone : words.revoked({ name }) })
        // The row is gone: the list's heading is where the reader is.
        clientsRef.current?.focus()
      })
      .catch((error: unknown) => setMessage({ tone: 'danger', text: revokeFailure(error, runtime.host) }))
      .finally(() => setRevoking(null))
  }

  const cancel = (id: string): void => {
    refocus.current = id
    setConfirming(null)
  }

  const notOffered = problem?.kind === 'not_offered'
  let state: string | null = null

  if (problem?.kind === 'sign_in') {
    state = words.signIn
  } else if (problem?.kind === 'failed') {
    state = words.failed({ message: displayText(problem.message, FAILURE_LIMIT) })
  } else if (!status && !loaded) {
    state = words.loading
  }

  return (
    <section className="hm-mcp" aria-labelledby={`${ids}-title`}>
      <h2 className="hm-mcp__title" id={`${ids}-title`}>
        {webStrings.mcp.settings.title}
      </h2>

      {notOffered ? (
        <p className="hm-mcp__state">{words.notOffered}</p>
      ) : (
        <>
          <p className="hm-mcp__text">{words.intro}</p>
          {state ? <p className="hm-mcp__state">{state}</p> : null}
          {problem?.kind === 'failed' ? (
            <Button variant="quiet" className="hm-mcp__retry" onClick={() => void runtime?.refresh()}>
              {words.retry}
            </Button>
          ) : null}
        </>
      )}

      {status && !notOffered && problem?.kind !== 'sign_in' ? (
        <>
          <p className="hm-mcp__state">{words.on}</p>

          <h3 className="hm-mcp__heading">{words.endpointTitle}</h3>
          <div className="hm-mcp__copyable">
            <code className="hm-mcp__code" data-mcp="endpoint">
              {status.endpointUrl}
            </code>
            <Button variant="quiet" aria-label={words.copyEndpoint} onClick={() => copy(status.endpointUrl)}>
              {words.copy}
            </Button>
          </div>

          <h3 className="hm-mcp__heading">{words.commandTitle}</h3>
          <p className="hm-mcp__text">{words.commandHelp}</p>
          <div className="hm-mcp__copyable">
            <code className="hm-mcp__code" data-mcp="command">
              {status.command}
            </code>
            <Button variant="quiet" aria-label={words.copyCommand} onClick={() => copy(status.command)}>
              {words.copy}
            </Button>
          </div>

          <h3 className="hm-mcp__heading">{words.configTitle}</h3>
          <p className="hm-mcp__text">{words.configHelp}</p>
          <div className="hm-mcp__copyable">
            <pre className="hm-mcp__code" data-mcp="config">
              {status.configJson}
            </pre>
            <Button variant="quiet" aria-label={words.copyConfig} onClick={() => copy(status.configJson)}>
              {words.copy}
            </Button>
          </div>

          {status.instructions ? (
            <>
              <h3 className="hm-mcp__heading">{words.instructionsTitle}</h3>
              <p className="hm-mcp__text hm-mcp__instructions">
                {displayText(status.instructions, INSTRUCTIONS_LIMIT)}
              </p>
            </>
          ) : null}

          <h3 className="hm-mcp__heading" ref={clientsRef} tabIndex={-1}>
            {words.clientsTitle}
          </h3>
          {status.grants.length === 0 ? (
            <p className="hm-mcp__text">{words.empty}</p>
          ) : (
            <ul className="hm-mcp__list" aria-label={words.clientsTitle}>
              {status.grants.map(grant => {
                const name = clientLabel(grant.clientName)
                const createdIp = displayText(grant.createdIp, ADDRESS_LIMIT)
                const lastUsedIp = displayText(grant.lastUsedIp, ADDRESS_LIMIT)
                const created = formatDateTime(grant.createdAt * 1000)

                return (
                  <li key={grant.id} className="hm-mcp__item" data-grant={grant.id}>
                    <div className="hm-mcp__item-text">
                      <span className="hm-mcp__name">{name}</span>
                      <span className="hm-mcp__meta">
                        {createdIp
                          ? words.allowedFrom({ date: created, address: createdIp })
                          : words.allowed({ date: created })}
                      </span>
                      <span className="hm-mcp__meta">
                        {grant.lastUsedAt === null
                          ? words.neverUsed
                          : lastUsedIp
                            ? words.lastUsedFrom({ date: formatDateTime(grant.lastUsedAt * 1000), address: lastUsedIp })
                            : words.lastUsed({ date: formatDateTime(grant.lastUsedAt * 1000) })}
                      </span>
                      {grant.expiresAt !== null ? (
                        <span className="hm-mcp__meta">
                          {words.expires({ date: formatDateTime(grant.expiresAt * 1000) })}
                        </span>
                      ) : null}
                    </div>

                    {confirming === grant.id ? (
                      <div className="hm-mcp__confirm" role="group" aria-label={words.revokeNamed({ name })}>
                        <p className="hm-mcp__text">{words.revokeQuestion({ name })}</p>
                        <div className="hm-mcp__confirm-buttons">
                          <Button
                            variant="quiet"
                            data-tone="danger"
                            className="hm-mcp__revoke"
                            aria-label={words.revokeNamed({ name })}
                            onClick={() => revoke(grant.id, name)}
                          >
                            {words.revoke}
                          </Button>
                          {/* Cancel takes the focus: a revoke is never one stray Enter away. */}
                          <Button variant="quiet" autoFocus onClick={() => cancel(grant.id)}>
                            {words.cancel}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        variant="quiet"
                        data-tone="danger"
                        className="hm-mcp__revoke"
                        id={`${ids}-revoke-${grant.id}`}
                        aria-label={words.revokeNamed({ name })}
                        disabled={revoking !== null || runtime === null}
                        onClick={() => setConfirming(grant.id)}
                      >
                        {words.revoke}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      ) : null}

      <p className="hm-mcp__message" role="status" data-tone={message?.tone}>
        {message?.text ?? ''}
      </p>
    </section>
  )
}
