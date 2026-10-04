/**
 * Settings › Skills: what one bot has installed and switched on, and what the hub offers
 * (`core/manage/skills.ts`).
 *
 * The installed list carries a switch per skill, which is the bot's: the gateway stores the set that is OFF and
 * replaces it whole, so every switch writes the whole list as it is on screen. Writes go one after another and
 * each builds its list when its turn comes, so two quick clicks are two states in order and never two writes
 * racing; a refusal puts the list back to what the gateway last confirmed and says so.
 *
 * The hub is browsed a page at a time or searched. A row opens its details (what the hub knows of it, and its
 * own instructions in a box that scrolls) and installs it into the picked bot's skills; a gateway that cannot
 * install over its socket is told as the command to run where it is hosted. Nothing here uninstalls: the gateway
 * has no action for it, and the page says so once.
 *
 * Everything the hub or the gateway sends is somebody else's text and is drawn as characters.
 */
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  createSkillsClient,
  type HubPage,
  type HubSkill,
  type InstalledSkill,
  isUnknownAction,
  type SkillDetails,
  type SkillsClient,
  skillInstallCommand
} from '../../core/manage/skills'
import { routeErrorOf } from '../../core/manage/route-error'
import type { ManageTransport } from '../../core/manage/transport'
import { strings } from '../../generated/strings'
import { manageStrings } from '../../i18n/manage-strings'
import { useLocale } from '../../i18n/use-locale'
import { Button } from '../../ui/primitives'
import { Checkbox, SettingsPage } from './controls'
import { BotPicker, type Outcome, ProblemLine, StatusLine, useSelectedBot } from './manage-parts'
import { useManageTransport } from './manage-runtime'

const SEARCH_DELAY_MS = 300

/** The category a skill is filed under, in words; one the gateway made up is shown as it came. */
function categoryLabel(category: string): string {
  return category === 'bundled'
    ? manageStrings.skillsPage.bundled
    : category === 'installed'
      ? manageStrings.skillsPage.added
      : category
}

export function Skills(): ReactElement {
  useLocale()

  const transport = useManageTransport()
  const { choices, selected, select } = useSelectedBot()

  let body: ReactElement

  if (choices.length === 0) {
    body = <p className="hm-manage__text">{strings.memory.botsEmpty}</p>
  } else if (!transport) {
    body = <p className="hm-manage__text">{manageStrings.manageCommon.noGateway}</p>
  } else {
    const name = choices.find(choice => choice.name === selected)?.label ?? selected

    body = (
      <>
        <BotPicker label={strings.skills.botPicker} choices={choices} value={selected} onChange={select} />
        <p className="hm-manage__hint">{strings.skills.forBot({ name })}</p>
        <SkillsBody key={selected} gateway={transport.gateway} profile={selected} />
      </>
    )
  }

  return (
    <SettingsPage title={strings.skills.title} lead={strings.skills.subtitle}>
      {body}
    </SettingsPage>
  )
}

function SkillsBody({ gateway, profile }: { gateway: ManageTransport['gateway']; profile: string }): ReactElement {
  const client = useMemo(() => createSkillsClient(gateway), [gateway])
  const [rows, setRows] = useState<InstalledSkill[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [writing, setWriting] = useState<ReadonlySet<string>>(new Set())
  /** The rows as the latest click left them: what a write built on its turn reads. */
  const current = useRef<InstalledSkill[] | null>(null)
  /** The rows the gateway last confirmed: where a refused write puts them back. */
  const confirmed = useRef<InstalledSkill[] | null>(null)
  const tail = useRef<Promise<void>>(Promise.resolve())
  const reads = useRef(0)

  const show = useCallback((next: InstalledSkill[] | null): void => {
    current.current = next
    setRows(next)
  }, [])

  const load = useCallback(async (): Promise<void> => {
    const mine = ++reads.current

    try {
      const next = await client.installed(profile)

      if (mine === reads.current) {
        confirmed.current = next
        show(next)
        setProblem(null)
      }
    } catch (failure) {
      if (mine === reads.current) {
        setProblem(strings.skills.failed({ reason: routeErrorOf(failure).message }))
      }
    }
  }, [client, profile, show])

  useEffect(() => {
    void load()

    return () => {
      reads.current += 1
    }
  }, [load])

  const toggle = (name: string, enabled: boolean): void => {
    show((current.current ?? []).map(row => (row.name === name ? { ...row, enabled } : row)))
    setWriting(set => new Set(set).add(name))
    setOutcome(null)

    tail.current = tail.current.then(async () => {
      try {
        const sent = current.current ?? []

        await client.writeSwitches(profile, sent)
        confirmed.current = sent
      } catch (failure) {
        show(confirmed.current)
        setOutcome({ tone: 'danger', text: strings.skills.toggleFailed({ reason: routeErrorOf(failure).message }) })
      } finally {
        setWriting(set => {
          const next = new Set(set)

          next.delete(name)

          return next
        })
      }
    })
  }

  const installedNames = useMemo(() => new Set((rows ?? []).map(row => row.name)), [rows])

  return (
    <>
      <StatusLine outcome={outcome} />

      <section aria-labelledby={`skills-installed-${profile}`}>
        <h3 className="hm-manage__heading" id={`skills-installed-${profile}`}>
          {strings.skills.installed}
        </h3>
        <p className="hm-manage__hint">{strings.skills.installedFooter}</p>

        {problem ? <ProblemLine text={problem} retryLabel={strings.memory.retry} onRetry={() => void load()} /> : null}
        {!rows && !problem ? <p className="hm-manage__text">{strings.skills.loading}</p> : null}
        {rows && rows.length === 0 ? <p className="hm-manage__text">{strings.skills.installedEmpty}</p> : null}

        {rows && rows.length > 0 ? (
          <ul className="hm-manage__list" aria-label={strings.skills.installed}>
            {rows.map(row => (
              <li key={row.name} className="hm-manage__item">
                {row.enabled === null ? (
                  <div className="hm-manage__item-head">
                    <span className="hm-manage__name">{row.name}</span>
                    <span className="hm-manage__badge">{categoryLabel(row.category)}</span>
                  </div>
                ) : (
                  <Checkbox
                    label={row.name}
                    checked={row.enabled}
                    busy={writing.has(row.name)}
                    hint={manageStrings.skillsPage.switchHint({ category: categoryLabel(row.category) })}
                    onChange={enabled => toggle(row.name, enabled)}
                  />
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {rows && rows.length > 0 ? <p className="hm-manage__hint">{manageStrings.skillsPage.noUninstall}</p> : null}
      </section>

      <Hub
        client={client}
        profile={profile}
        installedNames={installedNames}
        onInstalled={name => {
          setOutcome({ tone: 'ok', text: strings.skills.installed_({ name }) })

          return load()
        }}
        onFailed={text => setOutcome({ tone: 'danger', text })}
      />
    </>
  )
}

function Hub({
  client,
  profile,
  installedNames,
  onInstalled,
  onFailed
}: {
  client: SkillsClient
  profile: string
  installedNames: ReadonlySet<string>
  onInstalled: (name: string) => Promise<void>
  onFailed: (text: string) => void
}): ReactElement {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<HubPage | null>(null)
  const [items, setItems] = useState<HubSkill[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [command, setCommand] = useState<string | null>(null)
  const searches = useRef(0)

  const read = useCallback(
    async (text: string, number: number): Promise<void> => {
      const mine = ++searches.current

      setSearching(true)

      try {
        const answer = await client.hub(text, number)

        if (mine === searches.current) {
          setPage(answer)
          setItems(previous => {
            if (number <= 1) {
              return answer.items
            }

            // A page that repeats what is already drawn adds nothing: a key is one skill.
            const known = new Set(previous.map(item => item.identifier))

            return [...previous, ...answer.items.filter(item => !known.has(item.identifier))]
          })
          setProblem(null)
        }
      } catch (failure) {
        if (mine === searches.current) {
          setProblem(strings.skills.failed({ reason: routeErrorOf(failure).message }))
        }
      } finally {
        if (mine === searches.current) {
          setSearching(false)
        }
      }
    },
    [client]
  )

  useEffect(() => {
    const timer = setTimeout(() => void read(query, 1), query === '' ? 0 : SEARCH_DELAY_MS)

    return () => {
      clearTimeout(timer)
      searches.current += 1
    }
  }, [query, read])

  const install = async (hit: HubSkill): Promise<void> => {
    setInstalling(hit.identifier)
    setCommand(null)

    try {
      const name = await client.install(hit.identifier, profile)

      await onInstalled(name)
    } catch (failure) {
      if (isUnknownAction(failure)) {
        setCommand(skillInstallCommand(hit.identifier, profile))
      } else {
        onFailed(strings.skills.installFailed({ reason: routeErrorOf(failure).message }))
      }
    } finally {
      setInstalling(null)
    }
  }

  return (
    <section aria-labelledby={`skills-hub-${profile}`}>
      <h3 className="hm-manage__heading" id={`skills-hub-${profile}`}>
        {strings.skills.catalogue}
      </h3>

      <div className="hm-manage__field">
        <label className="hm-manage__label" htmlFor={`skills-search-${profile}`}>
          {strings.skills.search}
        </label>
        <input
          id={`skills-search-${profile}`}
          className="hm-manage__input"
          type="search"
          autoComplete="off"
          placeholder={strings.skills.searchPlaceholder}
          value={query}
          onChange={event => setQuery(event.currentTarget.value)}
        />
      </div>

      {command ? (
        <div className="hm-manage__form" role="status">
          <p className="hm-manage__text">{strings.skills.cliOnly}</p>
          <code className="hm-manage__code">{command}</code>
        </div>
      ) : null}

      {problem ? (
        <ProblemLine text={problem} retryLabel={strings.memory.retry} onRetry={() => void read(query, 1)} />
      ) : null}
      {searching && items.length === 0 ? (
        <p className="hm-manage__text">{query.trim() ? strings.skills.searching : strings.skills.loading}</p>
      ) : null}
      {!searching && !problem && page && items.length === 0 ? (
        <p className="hm-manage__text">{strings.skills.catalogueEmpty}</p>
      ) : null}

      {items.length > 0 ? (
        <ul className="hm-manage__list" aria-label={strings.skills.catalogue}>
          {items.map(hit => (
            <HubRow
              key={hit.identifier}
              hit={hit}
              client={client}
              profile={profile}
              installed={installedNames.has(hit.name)}
              installing={installing === hit.identifier}
              busy={installing !== null}
              onInstall={() => void install(hit)}
            />
          ))}
        </ul>
      ) : null}

      {page && !query.trim() && page.page < page.totalPages ? (
        <div className="hm-manage__actions">
          <Button variant="quiet" disabled={searching} onClick={() => void read('', page.page + 1)}>
            {manageStrings.skillsPage.showMore}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

function HubRow({
  hit,
  client,
  profile,
  installed,
  installing,
  busy,
  onInstall
}: {
  hit: HubSkill
  client: SkillsClient
  profile: string
  installed: boolean
  installing: boolean
  busy: boolean
  onInstall: () => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [details, setDetails] = useState<
    { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'ready'; details: SkillDetails | null } | null
  >(null)

  const toggle = (): void => {
    const next = !open

    setOpen(next)

    if (next && (details === null || details.kind === 'failed')) {
      setDetails({ kind: 'loading' })

      client
        .inspect(hit.identifier, profile)
        .then(found => setDetails({ kind: 'ready', details: found }))
        .catch((failure: unknown) => setDetails({ kind: 'failed', message: routeErrorOf(failure).message }))
    }
  }

  return (
    <li className="hm-manage__item" data-skill={hit.identifier}>
      <div className="hm-manage__item-head">
        <span className="hm-manage__name">{hit.name}</span>
        {hit.source ? (
          <span className="hm-manage__badge">{manageStrings.skillsPage.source({ source: hit.source })}</span>
        ) : null}
        {hit.trust ? (
          <span className="hm-manage__badge">{manageStrings.skillsPage.trust({ trust: hit.trust })}</span>
        ) : null}
      </div>
      {hit.description ? <p className="hm-manage__body">{hit.description}</p> : null}

      <div className="hm-manage__actions">
        <Button
          variant="quiet"
          aria-expanded={open}
          aria-label={
            open
              ? manageStrings.skillsPage.hideDetailsOf({ name: hit.name })
              : manageStrings.skillsPage.detailsOf({ name: hit.name })
          }
          onClick={toggle}
        >
          {open ? manageStrings.skillsPage.hideDetails : manageStrings.skillsPage.details}
        </Button>
        {installed ? (
          <span className="hm-manage__badge" data-tone="ok">
            {strings.skills.alreadyInstalled}
          </span>
        ) : (
          <Button
            disabled={busy}
            aria-label={manageStrings.skillsPage.installName({ name: hit.name })}
            onClick={onInstall}
          >
            {installing ? strings.skills.installing : strings.skills.install}
          </Button>
        )}
      </div>

      {open ? (
        <div className="hm-manage__form">
          {details?.kind === 'loading' ? (
            <p className="hm-manage__text">{manageStrings.skillsPage.loadingDetails}</p>
          ) : null}
          {details?.kind === 'failed' ? (
            <p className="hm-manage__problem-text" role="alert">
              {manageStrings.skillsPage.detailsFailed({ message: details.message })}
            </p>
          ) : null}
          {details?.kind === 'ready' && details.details === null ? (
            <p className="hm-manage__text">{manageStrings.skillsPage.noDetails}</p>
          ) : null}
          {details?.kind === 'ready' && details.details ? (
            <DetailsView name={hit.name} found={details.details} />
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function DetailsView({ name, found }: { name: string; found: SkillDetails }): ReactElement {
  return (
    <>
      {found.description ? <p className="hm-manage__body">{found.description}</p> : null}
      {found.identifier ? <span className="hm-manage__meta">{found.identifier}</span> : null}
      {found.tags.length > 0 ? (
        <span className="hm-manage__meta">{manageStrings.skillsPage.tags({ tags: found.tags.join(', ') })}</span>
      ) : null}
      {found.preview ? (
        <pre
          className="hm-manage__scroll"
          tabIndex={0}
          aria-label={manageStrings.skillsPage.previewOf({ name })}
          dir="auto"
        >
          {found.preview}
        </pre>
      ) : null}
    </>
  )
}
