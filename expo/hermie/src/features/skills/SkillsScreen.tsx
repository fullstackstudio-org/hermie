/**
 * Settings ▸ Skills: what is installed, and what the hub could add.
 *
 * The installed list joins two methods, and the join is the reason this page
 * exists rather than being a list. `skills.manage list` says what a bot HAS;
 * only `profiles.describe` says which of them are switched on, as the
 * complement of the stored disabled set. Neither method answers both.
 *
 * The switches therefore need a bot, and without one there are none — a switch
 * drawn at a guessed position is a switch that writes the guess back the first
 * time anybody touches it. The bot picker is the page's first control for that
 * reason, not as a convenience.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'

import { useGateway } from '../../gateway'
import { chatGatewayFor } from '../../gateway/link'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { useBotsStore } from '../../store/bots'
import { PageFrame, PageScrollView, type PageChromeBack } from '../../ui/chrome'
import { Button, InsetGroup, InsetRow, Text, TextField } from '../../ui/primitives'
import { SegmentedRow, SwitchRow } from '../../ui/sheets'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import { useTheme } from '../../ui/theme'
import {
  isUnknownAction,
  skillInstallCommand,
  SkillsController,
  type CatalogueSkill,
  type InstalledSkill
} from './skills-controller'
import { skillStrings } from './strings'

export interface SkillsScreenProps {
  /** The page's one back control, labelled with the page it returns to. */
  back?: PageChromeBack
  /** Preselect a bot, e.g. when the page is opened from that bot's sheet. */
  initialProfile?: string | null
}

export function SkillsScreen({ back, initialProfile = null }: SkillsScreenProps) {
  const theme = useTheme()
  const { connection } = useGateway()
  const bots = useBotsStore(state => state.bots)
  const [profile, setProfile] = useState<string | null>(initialProfile)
  const [installed, setInstalled] = useState<InstalledSkill[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [catalogue, setCatalogue] = useState<CatalogueSkill[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [cliFallback, setCliFallback] = useState<string | null>(null)

  const controller = useMemo(
    () => (connection ? new SkillsController({ gateway: chatGatewayFor(connection) }) : null),
    [connection]
  )

  const load = useCallback(async () => {
    if (!controller) {
      return
    }

    try {
      setInstalled(await controller.installed(profile))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [controller, profile])

  useEffect(() => {
    void load()
  }, [load])

  // The catalogue is only read when it is asked for. `search` and `browse` both
  // reach the hub over the network, and doing that on arrival would make a page
  // about what is already installed wait on what is not.
  const runSearch = () => {
    if (!controller) {
      return
    }

    setCatalogue(null)
    setNotice(null)
    void controller
      .search(query)
      .then(setCatalogue)
      .catch((cause: unknown) => {
        setCatalogue([])
        setNotice(cause instanceof Error ? cause.message : String(cause))
      })
  }

  const toggle = (row: InstalledSkill, enabled: boolean) => {
    if (!controller || !profile || !installed) {
      return
    }

    // Paint the new position first: the write replaces a whole list, so the
    // list the controller is given must be the one the reader can see.
    const next = installed.map(entry => (entry.name === row.name ? { ...entry, enabled } : entry))

    setInstalled(next)
    setNotice(null)
    void controller.setSkillEnabled(profile, installed, row.name, enabled).catch((cause: unknown) => {
      setNotice(skillStrings.toggleFailed(cause instanceof Error ? cause.message : String(cause)))

      return load()
    })
  }

  const install = (skill: CatalogueSkill) => {
    if (!controller) {
      return
    }

    setBusy(skill.name)
    setNotice(null)
    setCliFallback(null)
    void controller
      .install(skill.name, profile)
      .then(name => {
        setNotice(skillStrings.installed_(name))

        return load()
      })
      .catch((cause: unknown) => {
        if (isUnknownAction(cause)) {
          setCliFallback(skillInstallCommand(skill.name, profile))

          return
        }

        setNotice(skillStrings.installFailed(cause instanceof Error ? cause.message : String(cause)))
      })
      .finally(() => setBusy(null))
  }

  const installedNames = new Set((installed ?? []).map(row => row.name))

  return (
    <PageFrame {...(back ? { back } : {})} subtitle={skillStrings.subtitle} title={skillStrings.title}>
      <PageScrollView
        contentContainerStyle={{
          alignSelf: 'center',
          gap: theme.space.xl,
          maxWidth: FORM_MAX_WIDTH,
          padding: theme.space.lg,
          width: '100%'
        }}
        ref={directTouchPanRef}
      >
        {bots.length ? (
          <InsetGroup
            footer={
              <Text color="textMuted" variant="meta">
                {profile ? skillStrings.forBot(profile) : skillStrings.noBot}
              </Text>
            }
          >
            <InsetRow>
              <SegmentedRow
                label={skillStrings.botPicker}
                onChange={value => setProfile(value === skillStrings.noBot ? null : value)}
                options={[
                  { value: skillStrings.noBot, label: '—' },
                  ...bots.map(bot => ({ value: bot.name, label: bot.name }))
                ]}
                testID="skills-bot"
                value={profile ?? skillStrings.noBot}
              />
            </InsetRow>
          </InsetGroup>
        ) : null}

        <InsetGroup
          footer={
            <Text color="textMuted" variant="meta">
              {skillStrings.installedFooter}
            </Text>
          }
          header={skillStrings.installed}
        >
          {error ? (
            <InsetRow>
              <Text color="dangerText" testID="skills-error">
                {skillStrings.failed(error)}
              </Text>
            </InsetRow>
          ) : installed === null ? (
            <InsetRow>
              <Text color="textMuted">{skillStrings.loading}</Text>
            </InsetRow>
          ) : installed.length === 0 ? (
            <InsetRow>
              <Text color="textMuted">{skillStrings.installedEmpty}</Text>
            </InsetRow>
          ) : (
            installed.map(row =>
              row.enabled === null ? (
                <InsetRow key={row.name}>
                  <Text>{row.name}</Text>
                </InsetRow>
              ) : (
                <SwitchRow
                  key={row.name}
                  label={row.name}
                  onChange={value => toggle(row, value)}
                  testID={`skills-toggle-${row.name}`}
                  value={row.enabled}
                />
              )
            )
          )}
        </InsetGroup>

        <InsetGroup header={skillStrings.catalogue}>
          <InsetRow>
            <TextField
              autoCapitalize="none"
              autoCorrect={false}
              label={skillStrings.search}
              onChangeText={setQuery}
              onSubmitEditing={runSearch}
              placeholder={skillStrings.searchPlaceholder}
              testID="skills-search"
              value={query}
            />
          </InsetRow>
          <InsetRow>
            <Button onPress={runSearch} testID="skills-search-go" title={skillStrings.search} variant="secondary" />
          </InsetRow>

          {catalogue === null ? null : catalogue.length === 0 ? (
            <InsetRow>
              <Text color="textMuted">{skillStrings.catalogueEmpty}</Text>
            </InsetRow>
          ) : (
            catalogue.map(skill => (
              <InsetRow key={skill.name}>
                <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.md }}>
                  <View style={{ flex: 1, gap: theme.space.xxs }}>
                    <Text>{skill.name}</Text>
                    {skill.description ? (
                      <Text color="textMuted" variant="meta">
                        {skill.description}
                      </Text>
                    ) : null}
                  </View>
                  {installedNames.has(skill.name) ? (
                    <Text color="textMuted" variant="meta">
                      {skillStrings.alreadyInstalled}
                    </Text>
                  ) : (
                    <Button
                      busy={busy === skill.name}
                      onPress={() => install(skill)}
                      testID={`skills-install-${skill.name}`}
                      title={skillStrings.install}
                      variant="secondary"
                    />
                  )}
                </View>
              </InsetRow>
            ))
          )}
        </InsetGroup>

        {cliFallback ? (
          <InsetGroup>
            <InsetRow>
              <View style={{ gap: theme.space.xs }}>
                <Text color="textMuted" variant="meta">
                  {skillStrings.cliOnly}
                </Text>
                <Text selectable testID="skills-cli" variant="code">
                  {cliFallback}
                </Text>
              </View>
            </InsetRow>
          </InsetGroup>
        ) : null}

        {notice ? (
          <Text color="textMuted" testID="skills-notice" variant="meta">
            {notice}
          </Text>
        ) : null}
      </PageScrollView>
    </PageFrame>
  )
}
