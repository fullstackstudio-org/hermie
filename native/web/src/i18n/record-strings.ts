/**
 * Strings only the web client has, that only the transcript's record of a signature, a location, a contact, a code or a
 * voice note says (`features/chat/items/OtherRow.tsx`), the chat's line about one this page could not show
 * (`features/notices/InteractiveNotice.tsx`) and the device sheets that name a kind of code or a field of a contact.
 *
 * The same table as `web-strings.ts`, under the same rules (one leaf, three languages; `web-strings.test.ts` reads it),
 * kept apart so that none of it is in the first load: the entry is within a few kilobytes of its budget, and the record
 * of a request is drawn by the chat's chunk, never by the entry. **Only a module that is itself loaded on demand may
 * import this file.** The words for a form, a file, a draft and a diff are `webStrings.chat.request`'s.
 */
import { activeLocale } from './active-locale'
import { type Branch, localise, type Translated } from './web-strings'

/** The strings, as written: every leaf in en, nl and de. */
export const RECORD_STRINGS_SOURCE = {
  /** The small line above a record in the transcript: what kind of request it was. */
  kind: {
    signature: {
      en: 'Signature',
      nl: 'Handtekening',
      de: 'Unterschrift'
    },
    location: {
      en: 'Location',
      nl: 'Locatie',
      de: 'Standort'
    },
    contact: {
      en: 'Contact',
      nl: 'Contact',
      de: 'Kontakt'
    },
    scan: {
      en: 'Code scan',
      nl: 'Codescan',
      de: 'Code-Scan'
    }
  },
  /** How a record of an answered request reads. Kinds and counts, never what was shared. */
  answered: {
    signed: {
      en: 'Signed',
      nl: 'Ondertekend',
      de: 'Unterschrieben'
    },
    voice: {
      en: 'Voice note sent',
      nl: 'Spraakbericht verstuurd',
      de: 'Sprachnachricht gesendet'
    },
    locationApproximate: {
      en: 'Approximate location shared',
      nl: 'Locatie bij benadering gedeeld',
      de: 'Ungefährer Standort geteilt'
    },
    locationPrecise: {
      en: 'Precise location shared',
      nl: 'Precieze locatie gedeeld',
      de: 'Genauer Standort geteilt'
    },
    contact: {
      en: ({ fields }: { fields: string }) => `Contact shared: ${fields}`,
      nl: ({ fields }: { fields: string }) => `Contact gedeeld: ${fields}`,
      de: ({ fields }: { fields: string }) => `Kontakt geteilt: ${fields}`
    },
    scan: {
      en: ({ kind }: { kind: string }) => `Code sent (${kind})`,
      nl: ({ kind }: { kind: string }) => `Code verstuurd (${kind})`,
      de: ({ kind }: { kind: string }) => `Code gesendet (${kind})`
    }
  },
  /** What a bot asked for, after a verb ("sent a signature"), for the chat's line about a request this page could not show. */
  what: {
    signature: {
      en: 'a signature',
      nl: 'een handtekening',
      de: 'eine Unterschrift'
    },
    location: {
      en: 'your location',
      nl: 'je locatie',
      de: 'deinen Standort'
    },
    contact: {
      en: 'a contact',
      nl: 'een contact',
      de: 'einen Kontakt'
    },
    scan: {
      en: 'a code scan',
      nl: 'een codescan',
      de: 'einen Code-Scan'
    }
  },
  /** The contract's contact fields, as a list's words. */
  contactField: {
    name: {
      en: 'name',
      nl: 'naam',
      de: 'Name'
    },
    phones: {
      en: 'phone numbers',
      nl: 'telefoonnummers',
      de: 'Telefonnummern'
    },
    emails: {
      en: 'email addresses',
      nl: 'e-mailadressen',
      de: 'E-Mail-Adressen'
    },
    postal: {
      en: 'postal addresses',
      nl: 'postadressen',
      de: 'Postadressen'
    },
    birthday: {
      en: 'birthday',
      nl: 'verjaardag',
      de: 'Geburtstag'
    },
    organization: {
      en: 'organisation',
      nl: 'organisatie',
      de: 'Organisation'
    }
  },
  /** The contract's symbologies, by the names they go by (mostly the same in every language). */
  symbology: {
    qr: {
      en: 'QR code',
      nl: 'QR-code',
      de: 'QR-Code'
    },
    ean13: {
      en: 'EAN-13',
      nl: 'EAN-13',
      de: 'EAN-13'
    },
    ean8: {
      en: 'EAN-8',
      nl: 'EAN-8',
      de: 'EAN-8'
    },
    code128: {
      en: 'Code 128',
      nl: 'Code 128',
      de: 'Code 128'
    },
    pdf417: {
      en: 'PDF417',
      nl: 'PDF417',
      de: 'PDF417'
    },
    datamatrix: {
      en: 'Data Matrix',
      nl: 'Data Matrix',
      de: 'Data Matrix'
    },
    aztec: {
      en: 'Aztec',
      nl: 'Aztec',
      de: 'Aztec'
    }
  }
} as const satisfies Branch

export type RecordStrings = Translated<typeof RECORD_STRINGS_SOURCE>

/** The records' web-only strings in the language the reader is using. */
export const recordStrings = localise(RECORD_STRINGS_SOURCE) as unknown as RecordStrings

/** `a, b and c` in the reader's language (the names of fields and of kinds of code, said as a list). */
export const listOf = (items: readonly string[]): string =>
  new Intl.ListFormat(activeLocale(), { type: 'conjunction' }).format(items)
