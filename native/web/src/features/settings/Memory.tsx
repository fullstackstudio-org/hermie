/**
 * Settings › Memory: what one bot remembers, as the Hermie plugin's memory routes serve it
 * (`core/manage/memory.ts`).
 *
 * Two files, never one merged list: MEMORY.md (what the bot has written down about its work) and USER.md (about
 * the person), each with the size the store spends on it. An entry is edited in place with a draft the reader
 * saves (Replace) or drops (Cancel, which puts the entry back as the gateway has it); an entry is removed only
 * after a question; a new one is added from a field under the file. The search is the plugin's, not a filter over
 * what is drawn, so the page and the bot's own `/memory` agree about what "matching" means. Under it, a
 * disclosure shows what each backend holds exactly as stored (read only), and the providers that cannot be
 * listed are named as such.
 *
 * The routes belong to the plugin, so three states come before any page: the advert not read yet (a sentence,
 * not an accusation), no `memory.browse` (what to install), and `memory.browse` without `memory.edit` (the page
 * without its controls, and a line saying why). The graph of the Expo app is not drawn here.
 *
 * Everything an answer holds is the bot's text and is drawn as characters. The store's own sentence for a
 * refused write is shown as it came.
 */
import { hasPluginCapability, PLUGIN_CAPABILITIES } from '@hermie/gateway-client/plugin'
import { type ReactElement, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'

import {
  createMemoryClient,
  type MemoryBackendRaw,
  type MemoryClient,
  type MemoryEntry,
  type MemoryListing,
  type MemoryTarget,
  MEMORY_TARGETS,
  type MemoryWriteAnswer
} from '../../core/manage/memory'
import { routeErrorOf } from '../../core/manage/route-error'
import { strings } from '../../generated/strings'
import { manageStrings } from '../../i18n/manage-strings'
import { useLocale } from '../../i18n/use-locale'
import { pluginPresence, pluginStore } from '../../state/plugin'
import { Button } from '../../ui/primitives'
import { SettingsPage } from './controls'
import { BotPicker, ConfirmAction, type Outcome, ProblemLine, StatusLine, useSelectedBot } from './manage-parts'
import { useManageTransport } from './manage-runtime'

/** The files' own names: they are what the plugin and Hermes call them, in every language. */
const FILE_NAME: Record<MemoryTarget, string> = { memory: 'MEMORY.md', user: 'USER.md' }

/** How long the search waits after the last keystroke. */
const SEARCH_DELAY_MS = 250

type Availability = 'unknown' | 'missing' | 'read_only' | 'editable'

function useAvailability(): Availability {
  const advert = useStore(pluginStore, state => state.advert)
  const read = useStore(pluginStore, state => state.read)

  if (pluginPresence({ advert, read }) === 'unknown') {
    return 'unknown'
  }

  if (!hasPluginCapability(advert, PLUGIN_CAPABILITIES.memoryBrowse)) {
    return 'missing'
  }

  return hasPluginCapability(advert, PLUGIN_CAPABILITIES.memoryEdit) ? 'editable' : 'read_only'
}

/** What a failed read says: 403 is a switch, anything else is the failure with its reason. */
function readFailure(failure: unknown): string {
  const error = routeErrorOf(failure)

  return error.status === 403 ? manageStrings.memoryPage.switchedOff : strings.memory.failed({ reason: error.message })
}

export function Memory(): ReactElement {
  useLocale()

  const transport = useManageTransport()
  const availability = useAvailability()
  const { choices, selected, select } = useSelectedBot()

  let body: ReactElement | null = null

  if (availability === 'unknown') {
    body = <p className="hm-manage__text">{strings.memory.missing.unknown}</p>
  } else if (availability === 'missing') {
    body = (
      <div className="hm-manage__form">
        <p className="hm-manage__confirm-question">{strings.memory.missing.title}</p>
        <p className="hm-manage__text">{strings.memory.missing.body}</p>
        <p className="hm-manage__hint">{strings.memory.missing.install}</p>
        <code className="hm-manage__code">{strings.memory.raw.missingCommand}</code>
      </div>
    )
  } else if (choices.length === 0) {
    body = <p className="hm-manage__text">{strings.memory.botsEmpty}</p>
  } else if (!transport) {
    body = <p className="hm-manage__text">{manageStrings.manageCommon.noGateway}</p>
  } else {
    body = (
      <>
        <BotPicker label={strings.skills.botPicker} choices={choices} value={selected} onChange={select} />
        <MemoryBody key={selected} http={transport.http} profile={selected} editable={availability === 'editable'} />
      </>
    )
  }

  return (
    <SettingsPage title={strings.memory.title} lead={strings.memory.botsHint}>
      {body}
    </SettingsPage>
  )
}

function MemoryBody({
  http,
  profile,
  editable
}: {
  http: NonNullable<ReturnType<typeof useManageTransport>>['http']
  profile: string
  editable: boolean
}): ReactElement {
  const client = useMemo(() => createMemoryClient(http, profile), [http, profile])
  const [listing, setListing] = useState<MemoryListing | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MemoryEntry[] | null>(null)
  const [searching, setSearching] = useState(false)
  const searchId = useId()
  const reads = useRef(0)
  const searches = useRef(0)
  const headings = useRef<Partial<Record<MemoryTarget, HTMLHeadingElement | null>>>({})

  const load = useCallback(async (): Promise<void> => {
    const mine = ++reads.current

    try {
      const next = await client.list()

      if (mine === reads.current) {
        setListing(next)
        setProblem(null)
      }
    } catch (failure) {
      if (mine === reads.current) {
        setProblem(readFailure(failure))
      }
    }
  }, [client])

  const search = useCallback(
    async (text: string): Promise<void> => {
      const mine = ++searches.current

      if (!text.trim()) {
        setResults(null)
        setSearching(false)

        return
      }

      setSearching(true)

      try {
        const found = await client.search(text)

        if (mine === searches.current) {
          setResults(found)
        }
      } catch (failure) {
        if (mine === searches.current) {
          setResults(null)
          setOutcome({ tone: 'danger', text: routeErrorOf(failure).message })
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
    void load()

    return () => {
      reads.current += 1
      searches.current += 1
    }
  }, [load])

  useEffect(() => {
    const timer = setTimeout(() => void search(query), SEARCH_DELAY_MS)

    return () => clearTimeout(timer)
  }, [query, search])

  /** A write, then the re-read the positions and the usage need. Resolves true when it landed. */
  const write = async (run: () => Promise<MemoryWriteAnswer>, done: string): Promise<boolean> => {
    setBusy(true)
    setOutcome(null)

    const answer = await run()

    if (answer.success) {
      await load()

      if (query.trim()) {
        await search(query)
      }

      setOutcome({ tone: 'ok', text: done })
    } else {
      setOutcome({ tone: 'danger', text: answer.error ?? strings.memory.failed({ reason: '' }) })
    }

    setBusy(false)

    return answer.success
  }

  const remove = async (entry: MemoryEntry): Promise<void> => {
    if (await write(() => client.remove(entry), manageStrings.memoryPage.removed)) {
      // The row the reader was on is gone: its file's heading is where they are.
      headings.current[entry.target]?.focus()
    }
  }

  return (
    <>
      {!editable ? <p className="hm-manage__text">{strings.memory.readOnly}</p> : null}

      <div className="hm-manage__field">
        <label className="hm-manage__label" htmlFor={`${searchId}-field`}>
          {strings.memory.search.placeholder}
        </label>
        <input
          id={`${searchId}-field`}
          className="hm-manage__input"
          type="search"
          value={query}
          autoComplete="off"
          aria-describedby={`${searchId}-hint`}
          onChange={event => setQuery(event.currentTarget.value)}
        />
        <p className="hm-manage__hint" id={`${searchId}-hint`}>
          {strings.memory.search.hint}
        </p>
      </div>

      <StatusLine outcome={outcome} />

      {problem ? <ProblemLine text={problem} retryLabel={strings.memory.retry} onRetry={() => void load()} /> : null}

      {!listing && !problem ? <p className="hm-manage__text">{strings.memory.loading}</p> : null}

      {query.trim() ? (
        <SearchResults
          query={query}
          results={results}
          searching={searching}
          editable={editable}
          busy={busy}
          onReplace={(entry, text) => write(() => client.replace(entry, text), manageStrings.memoryPage.replaced)}
          onRemove={remove}
        />
      ) : (
        listing &&
        MEMORY_TARGETS.map(target => {
          const section = listing.sections.find(row => row.target === target)

          return (
            <FileSection
              key={target}
              target={target}
              section={section ?? null}
              editable={editable}
              busy={busy}
              headingRef={node => {
                headings.current[target] = node
              }}
              onAdd={text => write(() => client.add(target, text), manageStrings.memoryPage.added)}
              onReplace={(entry, text) => write(() => client.replace(entry, text), manageStrings.memoryPage.replaced)}
              onRemove={remove}
            />
          )
        })
      )}

      {listing ? <Providers listing={listing} /> : null}

      <RawDisclosure client={client} />
    </>
  )
}

function FileSection({
  target,
  section,
  editable,
  busy,
  headingRef,
  onAdd,
  onReplace,
  onRemove
}: {
  target: MemoryTarget
  section: MemoryListing['sections'][number] | null
  editable: boolean
  busy: boolean
  headingRef: (node: HTMLHeadingElement | null) => void
  onAdd: (text: string) => Promise<boolean>
  onReplace: (entry: MemoryEntry, text: string) => Promise<boolean>
  onRemove: (entry: MemoryEntry) => Promise<void>
}): ReactElement {
  const id = useId()
  const [draft, setDraft] = useState('')
  const entries = section?.entries ?? []

  return (
    <section className="hm-manage__section" aria-labelledby={`${id}-title`}>
      <h3 className="hm-manage__heading" id={`${id}-title`} ref={headingRef} tabIndex={-1}>
        {FILE_NAME[target]}
      </h3>
      <p className="hm-manage__hint">{strings.memory.sectionHint[target]}</p>
      {section ? <Usage target={target} section={section} /> : null}

      {entries.length === 0 ? (
        <p className="hm-manage__text">{strings.memory.empty[target]}</p>
      ) : (
        <ul className="hm-manage__list" aria-label={FILE_NAME[target]}>
          {entries.map(entry => (
            <EntryRow
              key={`${entry.id}:${entry.text}`}
              entry={entry}
              editable={editable}
              busy={busy}
              onReplace={onReplace}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}

      {editable ? (
        <form
          className="hm-manage__form"
          onSubmit={event => {
            event.preventDefault()

            if (draft.trim() && !busy) {
              void onAdd(draft).then(added => {
                if (added) {
                  setDraft('')
                }
              })
            }
          }}
        >
          <div className="hm-manage__field">
            <label className="hm-manage__label" htmlFor={`${id}-add`}>
              {strings.memory.add.label({ target: FILE_NAME[target] })}
            </label>
            <textarea
              id={`${id}-add`}
              className="hm-manage__textarea"
              value={draft}
              placeholder={strings.memory.add.placeholder}
              onChange={event => setDraft(event.currentTarget.value)}
            />
          </div>
          <div className="hm-manage__actions">
            <Button type="submit" disabled={busy || !draft.trim()}>
              {strings.memory.add.action}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  )
}

/** How full a file is: the bar and the store's own numbers, or the characters alone on a gateway with no limit. */
function Usage({
  target,
  section
}: {
  target: MemoryTarget
  section: MemoryListing['sections'][number]
}): ReactElement {
  const label = strings.memory.usageLabel({ target: FILE_NAME[target], percent: section.percent })

  return (
    <div className="hm-manage__usage">
      {section.limit > 0 ? (
        <meter
          className="hm-manage__meter"
          min={0}
          max={section.limit}
          value={Math.min(section.chars, section.limit)}
          aria-label={label}
        />
      ) : null}
      <span className="hm-manage__meta">
        {section.limit > 0
          ? strings.memory.usage({ chars: section.chars, limit: section.limit })
          : strings.memory.usageUnbounded({ chars: section.chars })}
      </span>
    </div>
  )
}

function EntryRow({
  entry,
  editable,
  busy,
  onReplace,
  onRemove
}: {
  entry: MemoryEntry
  editable: boolean
  busy: boolean
  onReplace: (entry: MemoryEntry, text: string) => Promise<boolean>
  onRemove: (entry: MemoryEntry) => Promise<void>
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.text)
  const edit = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)

  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false
      edit.current?.focus()
    }
  }, [editing])

  const stop = (): void => {
    refocus.current = true
    setEditing(false)
  }

  const save = (): void => {
    if (draft.trim() && draft !== entry.text) {
      // Replaced: the row is drawn again from the re-read; a refusal keeps the draft where it is.
      void onReplace(entry, draft)
    } else {
      stop()
    }
  }

  return (
    <li className="hm-manage__item" data-entry={entry.id}>
      {editing ? (
        <>
          <textarea
            className="hm-manage__textarea"
            data-mono="true"
            autoFocus
            value={draft}
            aria-label={manageStrings.memoryPage.entryText({ index: entry.index + 1, file: FILE_NAME[entry.target] })}
            onChange={event => setDraft(event.currentTarget.value)}
          />
          <div className="hm-manage__actions">
            <Button disabled={busy || !draft.trim() || draft === entry.text} onClick={save}>
              {strings.memory.edit.save}
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setDraft(entry.text)
                stop()
              }}
            >
              {strings.memory.edit.cancel}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="hm-manage__body" dir="auto">
            {entry.text}
          </p>
          <span className="hm-manage__meta">{manageStrings.memoryPage.entryChars({ count: entry.chars })}</span>
          {editable ? (
            <div className="hm-manage__actions">
              <Button
                ref={edit}
                variant="quiet"
                disabled={busy}
                aria-label={manageStrings.memoryPage.editEntry({
                  index: entry.index + 1,
                  file: FILE_NAME[entry.target]
                })}
                onClick={() => {
                  setDraft(entry.text)
                  setEditing(true)
                }}
              >
                {strings.memory.edit.action}
              </Button>
              <ConfirmAction
                label={strings.memory.remove.action}
                accessibleName={manageStrings.memoryPage.removeEntry({
                  index: entry.index + 1,
                  file: FILE_NAME[entry.target]
                })}
                question={strings.memory.remove.confirmTitle}
                detail={strings.memory.remove.confirmBody}
                confirmLabel={strings.memory.remove.confirm}
                cancelLabel={strings.memory.remove.cancel}
                disabled={busy}
                onConfirm={() => void onRemove(entry)}
              />
            </div>
          ) : null}
        </>
      )}
    </li>
  )
}

function SearchResults({
  query,
  results,
  searching,
  editable,
  busy,
  onReplace,
  onRemove
}: {
  query: string
  results: MemoryEntry[] | null
  searching: boolean
  editable: boolean
  busy: boolean
  onReplace: (entry: MemoryEntry, text: string) => Promise<boolean>
  onRemove: (entry: MemoryEntry) => Promise<void>
}): ReactElement {
  if (results === null) {
    return <p className="hm-manage__text">{searching ? strings.memory.search.searching : ''}</p>
  }

  if (results.length === 0) {
    return <p className="hm-manage__text">{strings.memory.search.none({ query })}</p>
  }

  return (
    <section aria-label={strings.memory.search.count({ found: results.length })}>
      <p className="hm-manage__meta" role="status">
        {strings.memory.search.count({ found: results.length })}
      </p>
      <ul className="hm-manage__list">
        {results.map(entry => (
          <EntryRow
            key={`${entry.id}:${entry.text}`}
            entry={entry}
            editable={editable}
            busy={busy}
            onReplace={onReplace}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </section>
  )
}

/** The memory providers the gateway has; an external one cannot be listed, and the page says so once. */
function Providers({ listing }: { listing: MemoryListing }): ReactElement | null {
  const external = listing.providers.filter(provider => !provider.enumerable)

  if (external.length === 0) {
    return null
  }

  return (
    <section>
      <h3 className="hm-manage__heading">{strings.memory.providers.header}</h3>
      <ul className="hm-manage__list">
        {external.map(provider => (
          <li key={provider.name} className="hm-manage__item">
            <div className="hm-manage__item-head">
              <span className="hm-manage__name">{provider.name}</span>
              <span className="hm-manage__badge">{strings.memory.providers.notBrowsable}</span>
            </div>
            {provider.description ? <span className="hm-manage__meta">{provider.description}</span> : null}
          </li>
        ))}
      </ul>
      <p className="hm-manage__hint">{strings.memory.providers.hint}</p>
    </section>
  )
}

/** What each backend holds exactly as stored, read only; fetched when the disclosure is first opened. */
function RawDisclosure({ client }: { client: MemoryClient }): ReactElement {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'missing' }
    | { kind: 'failed'; text: string }
    | { kind: 'ready'; backends: MemoryBackendRaw[] }
  >({ kind: 'idle' })

  const open = (): void => {
    if (state.kind !== 'idle' && state.kind !== 'failed') {
      return
    }

    setState({ kind: 'loading' })

    client
      .raw()
      .then(backends => setState({ kind: 'ready', backends }))
      .catch((failure: unknown) => {
        const error = routeErrorOf(failure)

        setState(error.status === 404 ? { kind: 'missing' } : { kind: 'failed', text: error.message })
      })
  }

  return (
    <details
      className="hm-manage__disclosure"
      onToggle={event => {
        if (event.currentTarget.open) {
          open()
        }
      }}
    >
      <summary className="hm-manage__summary">{strings.memory.tabs.raw}</summary>
      {state.kind === 'loading' ? <p className="hm-manage__text">{strings.memory.raw.loading}</p> : null}
      {state.kind === 'failed' ? <ProblemLine text={state.text} onRetry={open} /> : null}
      {state.kind === 'missing' ? (
        <div className="hm-manage__form">
          <p className="hm-manage__text">{strings.memory.raw.missing}</p>
          <p className="hm-manage__hint">{strings.memory.raw.missingHint}</p>
          <code className="hm-manage__code">{strings.memory.raw.missingCommand}</code>
        </div>
      ) : null}
      {state.kind === 'ready' ? (
        state.backends.length === 0 ? (
          <p className="hm-manage__text">{strings.memory.raw.none}</p>
        ) : (
          <div className="hm-manage__form">
            <p className="hm-manage__hint">{strings.memory.raw.readOnly}</p>
            {state.backends.map(backend => (
              <RawBackend key={backend.name} backend={backend} />
            ))}
          </div>
        )
      ) : null}
    </details>
  )
}

function RawBackend({ backend }: { backend: MemoryBackendRaw }): ReactElement {
  return (
    <section className="hm-manage__form">
      <h4 className="hm-manage__name">{backend.label}</h4>
      {!backend.available ? <p className="hm-manage__text">{strings.memory.raw.unavailable}</p> : null}
      {backend.note ? <p className="hm-manage__text">{backend.note}</p> : null}
      {backend.available && backend.documents.length === 0 && !backend.note ? (
        <p className="hm-manage__text">{strings.memory.raw.notListable}</p>
      ) : null}
      {backend.documents.map(document => (
        <div key={document.id} className="hm-manage__field">
          <span className="hm-manage__meta">
            {document.label} · {strings.memory.raw.chars({ chars: document.chars })}
          </span>
          {document.content ? (
            // A box of a fixed height that scrolls inside: reachable by keyboard, named by what it holds.
            <pre className="hm-manage__scroll" tabIndex={0} aria-label={document.label} dir="auto">
              {document.content}
            </pre>
          ) : (
            <p className="hm-manage__text">{strings.memory.raw.emptyDocument}</p>
          )}
          {document.truncated ? <p className="hm-manage__hint">{strings.memory.raw.truncated}</p> : null}
        </div>
      ))}
    </section>
  )
}
