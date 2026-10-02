/**
 * Who this is, at the bottom of the chat list.
 *
 * [ADR-0025](../../../../docs/adr/0025-hermie-web-is-a-service-layer.md). Hermie
 * Web is a service now: an operator sets the gateway up once and everybody else
 * signs in, which makes "which account is this tab" a question that gets asked.
 * The gateway has always been able to answer it — `/api/auth/me` — and the app
 * has always asked, once, to decide what a bot may be told about the person
 * holding the device. It was simply never on screen anywhere but Settings.
 *
 * ## What it draws, and what it refuses to invent
 *
 * The name comes down the same ladder the context section uses
 * (`effectiveDisplayName`): the gateway's display name, else the local part of
 * the address it signed them in with, else the subject with its provider prefix
 * removed. **`/api/auth/me` carries no avatar field**, so there is no picture to
 * fetch and none is invented — the mark is the app's own initial-drawn avatar,
 * the same one a bot gets.
 *
 * ## Why it can be empty
 *
 * On a gateway with no accounts there is nobody to name. `readIdentity` answers
 * `owner` there, which is a placeholder and not a person, so this row does not
 * draw at all rather than introducing the reader to themselves as "owner".
 *
 * ## One block, not two
 *
 * In a browser this is also where "Hermie Web x.y.z · <gateway>" belongs. It is
 * the same footer and the same question — what am I connected to, and as whom —
 * so it is one block with one hairline above it. Settings keeps the row that
 * can UPDATE that version; this only says which one is running, and off the web
 * it says nothing, because `loadHermieWebConfig` answers `null` where there is
 * no such server.
 */
import { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'

import { Avatar } from '../../chat-ui'
import { type HermieWebConfig, loadHermieWebConfig } from '../../gateway/web-config'
import { strings } from '../../i18n/strings'
import { effectiveDisplayName, useDeviceContextStore } from '../../store/device-context'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'

export interface SidebarIdentityProps {
  /**
   * What "Sign out" does. Absent means the row is drawn without one — the
   * screen that owns this footer may not have a gateway in scope, and a button
   * that does nothing is worse than a name with no button under it.
   */
  onSignOut?: (() => void) | undefined
}

/** `Hermie Web 0.1.2 · 127.0.0.1:9119`, or `''` where there is no such server. */
export function serviceLine(config: HermieWebConfig | null): string {
  if (!config) {
    return ''
  }

  const version = config.version ? strings.sidebar.hermieWeb(config.version) : ''
  const host = config.gatewayHost

  return [version, host].filter(Boolean).join(' · ')
}

export function SidebarIdentity({ onSignOut }: SidebarIdentityProps) {
  const theme = useTheme()
  const gated = useDeviceContextStore(state => state.gated)
  const displayName = useDeviceContextStore(state => state.displayName)
  const email = useDeviceContextStore(state => state.email)
  const userId = useDeviceContextStore(state => state.userId)
  const [config, setConfig] = useState<HermieWebConfig | null>(null)

  useEffect(() => {
    let live = true

    void loadHermieWebConfig().then(answer => {
      if (live) {
        setConfig(answer)
      }
    })

    return () => {
      live = false
    }
  }, [])

  // A gateway with no accounts names nobody, and `owner` is a placeholder
  // rather than a person.
  const name = gated ? effectiveDisplayName({ displayName, email, userId }) : ''
  const service = serviceLine(config)

  if (!name && !service) {
    return null
  }

  return (
    <View
      style={{
        borderTopColor: theme.hairlineSoft,
        borderTopWidth: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.sm,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.sm
      }}
      testID="sidebar-identity"
    >
      {name ? <Avatar name={name} size={28} /> : null}

      <View style={{ flex: 1, minWidth: 0 }}>
        {name ? (
          <Text numberOfLines={1} testID="sidebar-identity-name" variant="preview">
            {name}
          </Text>
        ) : null}
        {service ? (
          <Text color="textFaint" numberOfLines={1} testID="sidebar-identity-service" variant="meta">
            {service}
          </Text>
        ) : null}
      </View>

      {name && onSignOut ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={onSignOut}
          style={{ paddingHorizontal: theme.space.xs, paddingVertical: 2 }}
          testID="sidebar-sign-out"
        >
          <Text color="textMuted" variant="meta">
            {strings.settings.signOut}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}
