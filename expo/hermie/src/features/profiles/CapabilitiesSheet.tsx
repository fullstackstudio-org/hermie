/**
 * One bot's toolsets, skills and MCP servers, as three groups of switches.
 *
 * Every switch writes immediately. This sheet has no Save, and the reason is
 * the same one that governs the rest of the bot profile: a switch that waits
 * for a button is a switch that lies about the state of the world until the
 * button is pressed. The bot profile sheet keeps a Save for the two fields that
 * are TEXT (`description`, the soul) because those are edits in progress;
 * a toggle is not an edit in progress.
 *
 * Two things here are not obvious from the screen and are said in words:
 *
 *  - An UNPINNED bot follows the gateway's own toolset defaults, and the first
 *    switch anybody moves pins the whole list. That is upstream's behaviour,
 *    not ours, and it is worth a sentence because the alternative is a reader
 *    who turns one thing off and later finds the bot did not pick up a toolset
 *    the gateway added.
 *  - Changing MCP servers does not reach chats that are already running until
 *    the gateway reloads them, which costs every live chat its prompt cache.
 *    So the reload is offered, with the gateway's own warning, rather than done
 *    quietly — see {@link ReloadMcpSheet}.
 */
import { useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'

import type { ChatGateway } from '../../gateway/link'
import { BottomSheet, SheetEyebrow } from '../../ui/BottomSheet'
import { Button, InsetGroup, InsetRow, Text } from '../../ui/primitives'
import { SwitchRow } from '../../ui/sheets'
import { useTheme } from '../../ui/theme'
import { McpController } from '../mcp/mcp-controller'
import { CapabilitiesController, type Capabilities, type CapabilitySection } from './capabilities-controller'
import { profileStrings } from './strings'

export interface CapabilitiesSheetProps {
  visible: boolean
  onClose: () => void
  /**
   * The live connection, or null while there is none.
   *
   * A PROP rather than `useGateway()`, which is the same choice
   * `BotProfileSheet` made and for the same two reasons: this sheet is mounted
   * by that one, so it would inherit a provider requirement its parent
   * deliberately does not have — and a controller written against the
   * interface can be handed four functions by a test instead of a socket.
   */
  gateway: ChatGateway | null
  /** The bot's handle — the gateway's profile name, not its display name. */
  profile: string
  /** Live chat to reload MCP into, when there is one. */
  sessionId?: string | null
  /** Open the gateway-wide MCP page. Omitted hides the row. */
  onManageMcp?: () => void
}

export function CapabilitiesSheet({
  visible,
  onClose,
  gateway,
  profile,
  sessionId,
  onManageMcp
}: CapabilitiesSheetProps) {
  const theme = useTheme()
  const [state, setState] = useState<Capabilities | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [reloadPrompt, setReloadPrompt] = useState<string | null>(null)

  const controllers = useMemo(
    () =>
      gateway
        ? {
            capabilities: new CapabilitiesController(gateway),
            // `openUrl` is never reached from here: this sheet only ever calls
            // `reload`, and authorising a server is the MCP page's job.
            mcp: new McpController({ gateway, openUrl: () => undefined })
          }
        : null,
    [gateway]
  )

  useEffect(() => {
    if (!visible || !controllers) {
      return
    }

    let cancelled = false

    setState(null)
    setError(null)
    setNotice(null)
    void controllers.capabilities
      .load(profile)
      .then(loaded => {
        if (!cancelled) {
          setState(loaded)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })

    return () => {
      cancelled = true
    }
  }, [controllers, profile, visible])

  const write = (next: Capabilities, section: CapabilitySection) => {
    if (!controllers) {
      return
    }

    // Paint first, then write: every section replaces a whole list, so what is
    // sent has to be what the reader can see.
    const previous = state

    setState(next)
    setNotice(null)
    void controllers.capabilities
      .save(profile, next, section)
      .then(() => {
        if (section === 'mcp') {
          // A config change does not reach a chat that is already running. Ask
          // whether to apply it, rather than deciding for them.
          return controllers.mcp.reload({ sessionId }).then(result => {
            if (result.status === 'confirm_required') {
              setReloadPrompt(result.message)
            } else {
              setNotice(profileStrings.capabilities.reload.done)
            }
          })
        }

        return undefined
      })
      .catch((cause: unknown) => {
        setState(previous)
        setNotice(profileStrings.capabilities.saveFailed(cause instanceof Error ? cause.message : String(cause)))
      })
  }

  const toggle = (section: CapabilitySection, name: string, enabled: boolean) => {
    if (!state) {
      return
    }

    const flip = <T extends { name: string; enabled: boolean }>(rows: T[]): T[] =>
      rows.map(row => (row.name === name ? { ...row, enabled } : row))

    write(
      section === 'toolsets'
        ? { ...state, toolsets: flip(state.toolsets) }
        : section === 'skills'
          ? { ...state, skills: flip(state.skills) }
          : { ...state, mcpServers: flip(state.mcpServers) },
      section
    )
  }

  const reload = (always: boolean) => {
    setReloadPrompt(null)
    void controllers?.mcp
      .reload({ confirm: true, ...(always ? { always: true } : {}), sessionId })
      .then(() => setNotice(profileStrings.capabilities.reload.done))
      .catch((cause: unknown) =>
        setNotice(profileStrings.capabilities.reload.failed(cause instanceof Error ? cause.message : String(cause)))
      )
  }

  return (
    <>
      <BottomSheet
        accessibilityLabel={profileStrings.capabilities.title}
        onRequestClose={onClose}
        testID="bot-capabilities"
        visible={visible}
      >
        <View style={{ gap: theme.space.xl }}>
          <View style={{ gap: theme.space.xs }}>
            <SheetEyebrow>{profile}</SheetEyebrow>
            <Text variant="sheetTitle">{profileStrings.capabilities.title}</Text>
          </View>

          {error ? (
            <Text color="dangerText" testID="bot-capabilities-error">
              {profileStrings.capabilities.failed(error)}
            </Text>
          ) : state === null ? (
            <Text color="textMuted">{profileStrings.capabilities.loading}</Text>
          ) : (
            <>
              <InsetGroup
                footer={
                  <Text color="textMuted" variant="meta">
                    {state.toolsetsPinned
                      ? profileStrings.capabilities.toolsetsPinned
                      : profileStrings.capabilities.toolsetsUnpinned}
                  </Text>
                }
                header={profileStrings.capabilities.toolsets}
              >
                {state.toolsets.map(row => (
                  <SwitchRow
                    hint={
                      row.description
                        ? `${row.description} · ${profileStrings.capabilities.toolCount(row.toolCount)}`
                        : profileStrings.capabilities.toolCount(row.toolCount)
                    }
                    key={row.name}
                    label={row.label}
                    onChange={value => toggle('toolsets', row.name, value)}
                    testID={`capability-toolset-${row.name}`}
                    value={row.enabled}
                  />
                ))}
              </InsetGroup>

              <InsetGroup
                footer={
                  <Text color="textMuted" variant="meta">
                    {profileStrings.capabilities.skillsFooter}
                  </Text>
                }
                header={profileStrings.capabilities.skills}
              >
                {state.skills.length === 0 ? (
                  <InsetRow>
                    <Text color="textMuted">{profileStrings.capabilities.skillsEmpty}</Text>
                  </InsetRow>
                ) : (
                  state.skills.map(row => (
                    <SwitchRow
                      key={row.name}
                      label={row.name}
                      onChange={value => toggle('skills', row.name, value)}
                      testID={`capability-skill-${row.name}`}
                      value={row.enabled}
                    />
                  ))
                )}
              </InsetGroup>

              <InsetGroup
                footer={
                  <Text color="textMuted" variant="meta">
                    {profileStrings.capabilities.mcpFooter}
                  </Text>
                }
                header={profileStrings.capabilities.mcp}
              >
                {state.mcpServers.length === 0 ? (
                  <InsetRow>
                    <Text color="textMuted">{profileStrings.capabilities.mcpEmpty}</Text>
                  </InsetRow>
                ) : (
                  state.mcpServers.map(row => (
                    <SwitchRow
                      hint={row.transport}
                      key={row.name}
                      label={row.name}
                      onChange={value => toggle('mcp', row.name, value)}
                      testID={`capability-mcp-${row.name}`}
                      value={row.enabled}
                    />
                  ))
                )}
                {onManageMcp ? (
                  <InsetRow>
                    <Button
                      onPress={onManageMcp}
                      testID="capability-manage-mcp"
                      title={profileStrings.capabilities.manageMcp}
                      variant="secondary"
                    />
                  </InsetRow>
                ) : null}
              </InsetGroup>
            </>
          )}

          {notice ? (
            <Text color="textMuted" testID="bot-capabilities-notice" variant="meta">
              {notice}
            </Text>
          ) : null}
        </View>
      </BottomSheet>

      <ReloadMcpSheet
        message={reloadPrompt}
        onAlways={() => reload(true)}
        onCancel={() => setReloadPrompt(null)}
        onNow={() => reload(false)}
      />
    </>
  )
}

/**
 * The `reload.mcp` gate.
 *
 * Upstream can refuse this call by SUCCEEDING: without `confirm` it answers
 * `{status: 'confirm_required', message}` with a 200 and no error frame. The
 * desktop app never sees this — it always sends `confirm: true` — so this sheet
 * has no prior art to copy and is written from the gateway's own handler.
 *
 * The gateway's message is shown verbatim rather than paraphrased. It is the
 * only description of the cost that is guaranteed to match what the gateway
 * will actually do, and the two buttons say the rest.
 *
 * "Stop asking" is `always`, and it clears `approvals.mcp_reload_confirm` in
 * the GATEWAY's config — so it silences the CLI and the desktop app too. The
 * hint says so, because an opt-out that reaches further than the app it was
 * pressed in should not be a surprise.
 */
export function ReloadMcpSheet({
  message,
  onNow,
  onAlways,
  onCancel
}: {
  message: string | null
  onNow: () => void
  onAlways: () => void
  onCancel: () => void
}) {
  const theme = useTheme()
  const words = profileStrings.capabilities.reload

  return (
    <BottomSheet
      accessibilityLabel={words.title}
      onRequestClose={onCancel}
      testID="mcp-reload-confirm"
      visible={message !== null}
    >
      <View style={{ gap: theme.space.md }}>
        <SheetEyebrow>{words.eyebrow}</SheetEyebrow>
        <Text variant="sheetTitle">{words.title}</Text>
        <Text color="textMuted">{words.body}</Text>
        {message ? (
          <Text color="textFaint" testID="mcp-reload-message" variant="meta">
            {message}
          </Text>
        ) : null}

        <Button onPress={onNow} testID="mcp-reload-now" title={words.now} />
        <Button onPress={onAlways} testID="mcp-reload-always" title={words.always} variant="secondary" />
        <Text color="textMuted" variant="meta">
          {words.alwaysHint}
        </Text>
        <Button onPress={onCancel} title={words.later} variant="secondary" />
      </View>
    </BottomSheet>
  )
}
