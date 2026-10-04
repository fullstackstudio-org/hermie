/**
 * The sheet for a `device.contact` request: one contact, picked with the browser's own Contact Picker, reduced to the
 * fields the bot asked for and the person ticks (`contract/requests/README.md` section 10).
 *
 *  - **Only what was asked.** The picker is opened for exactly the properties the request's fields map to
 *    (`PICKER_PROPERTIES`: name, tel, email, address); what a browser cannot read at all (a birthday, an organisation)
 *    is said, never guessed. Nothing the request did not list is ever read.
 *  - **The person decides what goes.** What the picked contact has is shown as plain text beside a checkbox per field,
 *    all ticked; only the ticked ones are sent, and nothing at all is sent while none is ticked.
 *  - **The picker is the consent** for reading a contact (a browser needs no Contacts permission for it). It opens only
 *    on a press, as a browser requires.
 *  - Nothing of the contact is kept: it lives in this sheet's state and in the one answer.
 */
import { type ReactElement, useEffect, useId, useState } from 'react'

import type { ContactAsk, ContactField } from '../../core/requests/interactive-types'
import { listOf, recordStrings } from '../../i18n/record-strings'
import { deviceStrings } from '../../i18n/device-strings'
import { useLocale } from '../../i18n/use-locale'
import { Button } from '../../ui/primitives'
import { DEFAULT_TAP_GUARD_MS } from './ApprovalSheet'
import {
  type ContactCandidate,
  candidateOf,
  contactAnswer,
  type PickedContact,
  PICKER_PROPERTIES
} from './device-answers'
import { type DeviceSheetProps, refusalIn, ShareActions, useAlive } from './device-frame'
import { InteractiveFrame, RefusalAlert, SendStatus, useSending, useTapGuard } from './interactive-frame'
import { useReportBusy } from './sheet-busy'

/** The slice of the Contact Picker the sheet uses. */
export interface ContactsApi {
  select(properties: string[], options?: { multiple?: boolean }): Promise<PickedContact[]>
  getProperties?(): Promise<string[]>
}

export interface ContactSheetProps extends DeviceSheetProps<ContactAsk> {
  /** The browser's picker; the page's own unless a test hands in its own. */
  contacts?: ContactsApi | undefined
}

const pageContacts = (): ContactsApi | undefined =>
  typeof navigator === 'undefined' ? undefined : (navigator as unknown as { contacts?: ContactsApi }).contacts

/** The fields of a candidate that have something in them, in the contract's order. */
const present = (candidate: ContactCandidate, fields: readonly ContactField[]): ContactField[] =>
  fields.filter(field => {
    const value = candidate[field as keyof ContactCandidate]

    return value !== undefined && value.length > 0
  })

export function ContactSheet({
  request,
  gateway,
  titleId,
  descriptionId,
  onAnswer,
  onSkip,
  onLater,
  onCannotShow,
  contacts,
  shown = true,
  tapGuardMs = DEFAULT_TAP_GUARD_MS,
  now
}: ContactSheetProps): ReactElement {
  useLocale()

  const { ask } = request
  const ids = useId()
  const armed = useTapGuard(tapGuardMs, request.id, shown)
  const sending = useSending()
  const alive = useAlive()
  const picker = contacts ?? pageContacts()
  const [properties, setProperties] = useState<readonly string[] | null>(null)
  const [candidate, setCandidate] = useState<ContactCandidate | null>(null)
  const [ticked, setTicked] = useState<ReadonlySet<ContactField>>(new Set())
  const [picking, setPicking] = useState(false)
  const [failed, setFailed] = useState(false)
  /** The gateway's refusal is about a contact that was changed since: it is out of date. */
  const [changed, setChanged] = useState(false)

  useEffect(() => {
    setChanged(false)
  }, [request.refusal])

  // What this browser's picker can read: asked once; a browser that cannot say is taken to read the four it can.
  useEffect(() => {
    let live = true

    void (picker?.getProperties?.() ?? Promise.resolve(['name', 'tel', 'email', 'address'])).then(
      list => live && setProperties(list),
      () => live && setProperties(['name', 'tel', 'email', 'address'])
    )

    return () => {
      live = false
    }
  }, [picker])

  useReportBusy(picking || sending.pending)

  const locked = !armed || sending.pending || sending.finished
  const busy = locked || picking
  // The fields of the request this browser can read, and the ones it cannot.
  const readable = ask.fields.filter(field => {
    const property = PICKER_PROPERTIES[field]

    return property !== undefined && (properties === null || properties.includes(property))
  })
  const unreadable = ask.fields.filter(field => !readable.includes(field))
  const names = (fields: readonly ContactField[]): string =>
    listOf(fields.map(field => recordStrings.contactField[field]))
  const words = deviceStrings.contact
  const have = candidate === null ? [] : present(candidate, readable)

  async function choose(): Promise<void> {
    if (busy || !picker || readable.length === 0) {
      return
    }

    // Only the properties the request asked for, mapped to the picker's own names.
    const wanted = [...new Set(readable.flatMap(field => PICKER_PROPERTIES[field] ?? []))]

    setPicking(true)
    setFailed(false)

    try {
      const picked = await picker.select(wanted, { multiple: false })

      if (!alive.current) {
        return
      }

      // Dismissed without a choice: nothing changes.
      if (picked.length > 0 && picked[0]) {
        const next = candidateOf(picked[0], readable)

        setCandidate(next)
        setTicked(new Set(present(next, readable)))
        setChanged(true)
        sending.clearNotice()
      }
    } catch {
      if (alive.current) {
        setFailed(true)
      }
    } finally {
      if (alive.current) {
        setPicking(false)
      }
    }
  }

  const answer = candidate === null ? null : contactAnswer(ask.fields, candidate, ticked)
  const refusal = changed ? null : refusalIn(request.refusal, { 'contact:empty': words.refusedEmpty })

  function toggle(field: ContactField): void {
    setTicked(previous => {
      const next = new Set(previous)

      if (next.has(field)) {
        next.delete(field)
      } else {
        next.add(field)
      }

      return next
    })
    setChanged(true)
    sending.clearNotice()
  }

  /** The value of one field, as the lines it is shown by. */
  const linesOf = (field: ContactField): string[] => {
    const value = candidate?.[field as keyof ContactCandidate]

    return value === undefined ? [] : typeof value === 'string' ? [value] : value
  }

  return (
    <InteractiveFrame
      request={request}
      gateway={gateway}
      title={words.title}
      titleId={titleId}
      descriptionId={descriptionId}
      receiver={words.receiver}
      {...(now ? { now } : {})}
      status={
        <>
          <RefusalAlert text={refusal} />
          <SendStatus notice={sending.notice} />
          {failed ? (
            <p className="hm-requests__phase" role="alert" data-tone="danger">
              {words.failed}
            </p>
          ) : null}
        </>
      }
      actions={
        <ShareActions
          optional={ask.optional}
          busy={busy}
          sending={sending}
          onLater={onLater}
          onSkip={onSkip}
          onCannotShow={onCannotShow}
        >
          {readable.length === 0 && properties !== null ? (
            <Button
              className="hm-requests__action"
              variant="quiet"
              disabled={locked}
              onClick={() => sending.declined(onCannotShow('not_supported_on_device'))}
            >
              {deviceStrings.common.cannotDo}
            </Button>
          ) : (
            <>
              <Button
                className="hm-requests__action"
                variant={candidate === null ? 'primary' : 'quiet'}
                disabled={busy || !picker || properties === null}
                data-contact-choose=""
                onClick={() => void choose()}
              >
                {candidate === null ? words.choose : words.chooseAnother}
              </Button>
              {candidate !== null && have.length > 0 ? (
                <Button
                  className="hm-requests__action"
                  variant="primary"
                  disabled={busy || answer === null}
                  data-contact-send=""
                  onClick={() => answer && void sending.run(() => onAnswer(answer))}
                >
                  {words.send}
                </Button>
              ) : null}
            </>
          )}
        </ShareActions>
      }
    >
      <div className="hm-contact__asked">
        <p className="hm-form__hint">{words.asked({ fields: names(ask.fields) })}</p>
        {unreadable.length > 0 && readable.length > 0 ? (
          <p className="hm-form__hint">{words.unreadable({ fields: names(unreadable) })}</p>
        ) : null}
        {readable.length === 0 && properties !== null ? <p className="hm-form__error">{words.none}</p> : null}
      </div>

      {candidate !== null ? (
        have.length === 0 ? (
          <p className="hm-form__error" role="status">
            {words.empty}
          </p>
        ) : (
          <fieldset className="hm-form__field hm-form__group" disabled={busy} data-contact-fields="">
            <legend className="hm-requests__label">{words.legend}</legend>
            <ul className="hm-contact__fields">
              {have.map(field => {
                const id = `${ids}-${field}`

                return (
                  <li className="hm-contact__field" key={field} data-contact-field={field}>
                    <label className="hm-requests__choice" htmlFor={id}>
                      <input id={id} type="checkbox" checked={ticked.has(field)} onChange={() => toggle(field)} />
                      <span>{recordStrings.contactField[field]}</span>
                    </label>
                    <ul className="hm-contact__values">
                      {linesOf(field).map((line, index) => (
                        <li key={index} data-agent-text="">
                          {line}
                        </li>
                      ))}
                    </ul>
                  </li>
                )
              })}
            </ul>
            {answer === null ? <p className="hm-form__hint">{words.noneTicked}</p> : null}
          </fieldset>
        )
      ) : null}
    </InteractiveFrame>
  )
}
