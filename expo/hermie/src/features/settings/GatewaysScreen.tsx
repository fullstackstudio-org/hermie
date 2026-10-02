/**
 * Every gateway this device knows about, and the one it is talking to.
 *
 * Three pieces, because they are one flow: the list (drawn on the Gateways
 * category page), one gateway's own page (`GatewayDetail`), and the setup
 * wizard in "add" mode (`GatewayAdd`). The two pages are ROUTES in the Settings
 * stack, so their back control is the stack's and neither draws one of its own
 * — see `navigation/SettingsPage.tsx`.
 *
 * Two decisions are worth stating because the alternative is what a reader
 * would expect:
 *
 *  - **Adding does not switch.** The wizard here writes a new entry and comes
 *    straight back; the gateway the reader is on stays connected the whole
 *    time. Somebody describing a second machine has not asked to be moved onto
 *    it, and an add that switched would tear down a socket mid-conversation.
 *  - **The destructive act is on the gateway's own page**, not on its row. A
 *    row that can both connect and delete is a row where a mis-tap costs a
 *    conversation.
 */
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, View } from 'react-native'

import { useGateway } from '../../gateway'
import { gatewayLabel, gatewaysInOrder, type GatewayRecord } from '../../gateway/registry'
import { strings } from '../../i18n/strings'
import { Icon, ICON_SIZE } from '../../ui/Icon'
import { PageChromeSpacer } from '../../ui/chrome'
import { InsetButtonRow, InsetGroup, InsetValueRow, Text, TextField } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { OnboardingNavigator } from '../onboarding'
import type { SettingsParamList } from './navigation/route-names'
import { SettingsPage } from './navigation/SettingsPage'

/** What a row says under the name: the address, the sign-in, and the auth kind. */
export function describeGateway(gateway: GatewayRecord): string {
  const text = strings.settings.gateways
  const who =
    gateway.authKind === 'session_token'
      ? text.authModeToken
      : gateway.signedInUser
        ? text.signedInAs(gateway.signedInUser)
        : text.signedOut

  return `${gateway.address} · ${who}`
}

export interface GatewayListProps {
  onManage: (id: string) => void
  onAdd: () => void
}

/** The list and the add row, as the Gateways category page draws them. */
export function GatewayList({ onManage, onAdd }: GatewayListProps) {
  const text = strings.settings.gateways
  const { registry, gatewayId, switchGateway } = useGateway()
  /*
    Defensively, for the reason `GatewayTitle` gives: Settings is rendered by
    suites that stand in for the gateway context with the two or three fields
    they care about, and an empty list is a better answer than a crash in one of
    them.
  */
  const gateways = registry ? gatewaysInOrder(registry) : []

  return (
    <>
      <InsetGroup footer={text.hint} header={text.header} testID="settings-gateways">
        {gateways.map(gateway => (
          <GatewayRow
            active={gateway.id === gatewayId}
            gateway={gateway}
            key={gateway.id}
            onManage={() => onManage(gateway.id)}
            onSwitch={() => void switchGateway(gateway.id)}
          />
        ))}
      </InsetGroup>

      <InsetGroup footer={text.addHint}>
        <InsetButtonRow onPress={onAdd} testID="gateways-add" title={text.add} />
      </InsetGroup>
    </>
  )
}

/**
 * Settings → Gateways → Add: the setup wizard, minting a new entry.
 *
 * No `onCancel`: the page's own back control is the way out, and a Cancel in
 * the card beside it would be a second one.
 *
 * The wizard does not scroll under the chrome — it is a card whose first step
 * has a field and a button at the top — so it clears the glass with a spacer
 * instead. `PageChromeSpacer` is a CHILD of the frame, and that is the whole
 * point: the chrome's measured height only reaches inside `PageFrame`, so a
 * `usePageChromeHeight()` called out here, in the component that renders the
 * frame, reads the context's default of 0 for ever. It did, and the wizard's
 * first row was drawn under the header with the header taking its taps.
 */
export function GatewayAddPage() {
  const navigation = useNavigation()
  const { refreshRegistry } = useGateway()

  const finish = useCallback(async () => {
    // The wizard wrote a new entry; this provider's copy of the list is the one
    // every screen reads, so it has to be told. Nothing switches — see the note
    // at the top of the file.
    await refreshRegistry()

    if (navigation.canGoBack()) {
      navigation.goBack()
    }
  }, [navigation, refreshRegistry])

  return (
    <SettingsPage route="GatewayAdd" scroll={false}>
      <PageChromeSpacer />
      <View style={{ flex: 1 }}>
        <OnboardingNavigator
          // `null` is what makes this an ADD rather than an edit: the wizard mints
          // an entry instead of writing into the one that is live.
          gatewayId={null}
          onComplete={finish}
        />
      </View>
    </SettingsPage>
  )
}

interface GatewayRowProps {
  gateway: GatewayRecord
  active: boolean
  onSwitch: () => void
  onManage: () => void
}

/**
 * One gateway.
 *
 * Three targets, and they are deliberately far apart: the body connects, the
 * word beside it SAYS that it connects, and the trailing word opens the page
 * that can delete. A single row carrying all of it would make "remove everything
 * on this device" a mis-tap away from "read my messages".
 *
 * The middle one is new and it is the whole point of the row. Tapping the body
 * has always switched, and the footer under the list has always said so — but a
 * sentence under a list is not a label on a control, and the owner read the list
 * as a list of things to look at. The word is only on the rows it would do
 * something to; the live one wears the tick instead.
 */
function GatewayRow({ gateway, active, onSwitch, onManage }: GatewayRowProps) {
  const theme = useTheme()
  const text = strings.settings.gateways

  return (
    <View
      style={{
        alignItems: 'center',
        flexDirection: 'row',
        paddingRight: theme.space.lg
      }}
      testID={`gateway-row-${gateway.id}`}
    >
      <Pressable
        accessibilityRole="button"
        aria-selected={active}
        disabled={active}
        onPress={onSwitch}
        style={({ pressed }) => ({
          backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
          flex: 1,
          gap: theme.space.xxs,
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.md
        })}
        testID={`gateway-switch-${gateway.id}`}
      >
        <Text variant="preview">{gatewayLabel(gateway)}</Text>
        <Text color="textMuted" variant="meta">
          {describeGateway(gateway)}
        </Text>
        {active ? (
          <Text color="accentText" testID={`gateway-active-${gateway.id}`} variant="meta">
            {text.active}
          </Text>
        ) : null}
      </Pressable>

      {active ? (
        <Icon
          color={theme.colors.accentText}
          name="check"
          size={ICON_SIZE.inline}
          style={{ marginRight: theme.space.sm }}
          testID={`gateway-tick-${gateway.id}`}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={onSwitch}
          style={{ cursor: 'pointer', padding: theme.space.sm }}
          testID={`gateway-use-${gateway.id}`}
        >
          <Text color="accentText" variant="meta">
            {text.use}
          </Text>
        </Pressable>
      )}

      <Pressable
        accessibilityRole="button"
        onPress={onManage}
        style={{ cursor: 'pointer', padding: theme.space.sm }}
        testID={`gateway-manage-${gateway.id}`}
      >
        <Text color="textMuted" variant="meta">
          {text.manage}
        </Text>
      </Pressable>
    </View>
  )
}

/** Settings → Gateways → one gateway: what it is called, and the three things you can do to it. */
export function GatewayDetailPage() {
  const route = useRoute<RouteProp<SettingsParamList, 'GatewayDetail'>>()
  const navigation = useNavigation()
  const id = route.params.id
  const text = strings.settings.gateways
  const { registry, gatewayId, renameGateway, signOutOf, removeGateway, switchGateway } = useGateway()
  const gateway = registry?.gateways.find(entry => entry.id === id)
  const [name, setName] = useState(gateway?.name ?? '')
  const [confirming, setConfirming] = useState(false)
  /*
    Once, whichever asks first. "Remove" goes back AND empties the entry, and a
    page that is still sliding out when the registry catches up would otherwise
    see itself missing and go back a second time — out of Gateways as well.
  */
  const leaving = useRef(false)
  const onClose = useCallback(() => {
    if (!leaving.current && navigation.canGoBack()) {
      leaving.current = true
      navigation.goBack()
    }
  }, [navigation])

  // Removed from under us — by this page, on the way out. The list is where
  // the reader should be, and it is already correct. An effect rather than a
  // call during render: going back is a navigation, not a render result.
  const missing = !gateway

  useEffect(() => {
    if (missing) {
      onClose()
    }
  }, [missing, onClose])

  if (!gateway) {
    return null
  }

  const active = gateway.id === gatewayId

  return (
    <SettingsPage route="GatewayDetail" title={gatewayLabel(gateway)}>
      <InsetGroup footer={text.nameHint} header={text.detailTitle}>
        <TextField
          label={text.name}
          onChangeText={setName}
          onSubmitEditing={() => void renameGateway(gateway.id, name)}
          testID="gateway-name"
          value={name}
        />
        <InsetButtonRow
          disabled={name.trim() === gateway.name}
          onPress={() => void renameGateway(gateway.id, name)}
          testID="gateway-rename"
          title={text.save}
        />
      </InsetGroup>

      <InsetGroup>
        <InsetValueRow label={strings.settings.address} value={gateway.address} />
        <InsetValueRow
          label={strings.settings.provider}
          value={gateway.authKind === 'session_token' ? text.authModeToken : gateway.authKind}
        />
        <InsetValueRow label={strings.settings.user} value={gateway.signedInUser ?? text.signedOut} />
      </InsetGroup>

      {active ? null : (
        <InsetGroup footer={text.connectHint}>
          <InsetButtonRow
            onPress={() => {
              void switchGateway(gateway.id)
              onClose()
            }}
            testID="gateway-connect"
            title={text.connect}
          />
        </InsetGroup>
      )}

      <InsetGroup footer={`${text.removeHint} ${text.removeNotifyNote}`}>
        <InsetButtonRow
          detail={text.signOutHint}
          onPress={() => void signOutOf(gateway.id)}
          testID="gateway-sign-out"
          title={text.signOut}
        />
        {confirming ? (
          <InsetButtonRow
            detail={text.removeConfirm}
            onPress={() => {
              void removeGateway(gateway.id)
              onClose()
            }}
            testID="gateway-remove-confirm"
            title={text.removeConfirmAction}
            tone="danger"
          />
        ) : null}
        {confirming ? (
          <InsetButtonRow onPress={() => setConfirming(false)} title={text.keepIt} tone="text" />
        ) : (
          <InsetButtonRow
            onPress={() => setConfirming(true)}
            testID="gateway-remove"
            title={text.remove}
            tone="danger"
          />
        )}
      </InsetGroup>
    </SettingsPage>
  )
}
