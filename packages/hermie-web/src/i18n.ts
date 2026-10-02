/**
 * The three server-rendered pages' own languages: `/setup`, `/admin` and
 * `/oidc`, negotiated on `Accept-Language`.
 *
 * These pages are NOT part of the app bundle — they are painted by this package
 * before anything is configured, and on the morning the bundle does not load —
 * so they cannot reach into `expo/hermie/src/i18n/`. They carry their own small
 * tables instead, and keep the same three rules that file tree keeps
 * (`docs/i18n.md`):
 *
 *  - **English is the source, not a fallback of last resort.** Every sentence is
 *    authored in English; a catalogue supplies another language for the strings
 *    somebody has got to, and a key with no translation paints the English one.
 *    That is what lets a round add copy without stopping to translate it.
 *  - **The KIND of a key is not optional.** A key that interpolates is a
 *    function, and a catalogue that answers it with a bare string is ignored:
 *    a missing argument would be a sentence with a hole in it.
 *  - **The glossary holds.** `Hermie`, `Hermes`, `gateway`, `token`, `OIDC`,
 *    `VAPID`, `push`, `scrypt`, every URL, every path and every shell command
 *    stay in English in all three languages, because a reader who translates
 *    them here has to translate them back the moment they open the gateway's
 *    own dashboard.
 *
 * Zero dependencies, on purpose and permanently: the released artefact is a
 * self-contained CommonJS `dist/server` with no `node_modules` beside it, so
 * nothing outside this package may be imported except `node:` builtins.
 *
 * ## Why the device's language and not a setting
 *
 * There is no language picker here and there should not be one. A reader meets
 * `/oidc/authorize` once per sign-in and has nowhere to keep a preference; the
 * operator meets `/setup` once in the life of a deployment. `Accept-Language`
 * is the only thing either of them has already said.
 */
import type { IncomingMessage } from 'node:http'

/** The languages these pages are painted in. English is the source. */
export type WebLocale = 'en' | 'nl' | 'de'

export const WEB_LOCALES: readonly WebLocale[] = ['en', 'nl', 'de']

const isWebLocale = (value: string): value is WebLocale => (WEB_LOCALES as readonly string[]).includes(value)

/** One entry of an `Accept-Language` header, once it has been read. */
interface LanguageRange {
  /** The primary subtag, lowercased: `nl-BE` is `nl`, because there is no Flemish copy. */
  language: string
  /** The `;q=` weight, `1` where the entry carried none. */
  quality: number
  /** Where it stood in the header, so equal weights keep the order the client wrote. */
  position: number
}

/**
 * Read `Accept-Language` and answer one of the three languages.
 *
 * A real parse rather than a `startsWith`, because the header a browser sends
 * is routinely `nl-BE,nl;q=0.9,en-US;q=0.8,en;q=0.7` and everything that
 * matters is in the parts a prefix match throws away: the weights decide the
 * order rather than the position, `q=0` is a REFUSAL rather than a weak
 * preference, and the region is dropped because Hermie has no Flemish or
 * Austrian copy and pretending otherwise would mean catalogues that are 99%
 * the same.
 *
 * Every way of being wrong ends in English: an empty header, a header of
 * punctuation, a weight that is not a number, a language nobody here speaks.
 * That is the same answer the app gives a device it does not recognise, and it
 * is the safe one — English is the language every sentence here was written in,
 * so it is the only one that is complete by construction.
 */
export function negotiateLocale(header: string | undefined | null): WebLocale {
  if (!header) {
    return 'en'
  }

  const ranges: LanguageRange[] = []

  header.split(',').forEach((entry, position) => {
    const parts = entry.split(';')
    const tag = (parts[0] ?? '').trim().toLowerCase()

    // `*` is "anything you have", which is what the default already is.
    if (!tag || tag === '*') {
      return
    }

    const language = tag.split('-')[0] ?? ''

    if (!/^[a-z]{2,8}$/.test(language)) {
      return
    }

    let quality = 1

    for (const parameter of parts.slice(1)) {
      const match = /^\s*q\s*=\s*(\d+(?:\.\d+)?)\s*$/i.exec(parameter)

      // A parameter that is not a weight — `;level=1` and friends — says
      // nothing about preference, so it is passed over rather than fatal.
      if (!match) {
        continue
      }

      const value = Number(match[1])

      // A weight outside 0..1 is not a weight. The entry carrying it is dropped
      // rather than guessed at, which is how a malformed header ends up
      // answering English.
      if (!Number.isFinite(value) || value > 1) {
        return
      }

      quality = value
    }

    // `q=0` means "not this one", and a refused language can never be chosen,
    // not even when it is the only one left in the header.
    if (quality === 0) {
      return
    }

    ranges.push({ language, quality, position })
  })

  ranges.sort((left, right) => right.quality - left.quality || left.position - right.position)

  for (const range of ranges) {
    if (isWebLocale(range.language)) {
      return range.language
    }
  }

  return 'en'
}

/** The language one incoming request asked for. */
export function localeOf(request: IncomingMessage): WebLocale {
  const raw = request.headers['accept-language']

  return negotiateLocale(Array.isArray(raw) ? raw[0] : raw)
}

/** What goes in `<html lang="…">`. The primary subtag, because that is all these pages know. */
export function htmlLang(locale: WebLocale): string {
  return locale
}

/**
 * Every human-readable sentence on the three pages.
 *
 * A function wherever the copy interpolates, so a translation can put the value
 * where its own grammar wants it rather than where English wanted it.
 *
 * **Interpolated values arrive already escaped.** Several of these sentences
 * carry markup of their own — `<code>`, `<strong>`, `<em>` — so a table is
 * trusted source and the values handed to it are run through `escapeHtml` by
 * the caller first. A catalogue is source code in this repository; a user id is
 * not.
 */
export interface WebStrings {
  common: {
    signIn: string
    save: string
    /** The `<h1>` of both administration pages. */
    administration: string
    /** Their `<title>`, which is longer because a tab strip has no context. */
    administrationTitle: string
    administratorSecret: string
    yes: string
    no: string
    /** The two days a roster says in words instead of in digits. */
    today: string
    yesterday: string
    /** A short month name, by zero-based index, for every older date. */
    monthShort: (month: number) => string
    /** The link into one person's own detail, and the one that closes it. */
    details: string
    /**
     * The same link, named for whoever it opens.
     *
     * A list of twenty rows is a list of twenty links called "Details", which
     * is useless to anybody reading the page through a list of its links. The
     * visible word stays short and this is what the link is actually called.
     */
    detailsFor: (name: string) => string
    close: string
  }
  setup: {
    /** Both the `<title>` and the `<h1>`. */
    title: string
    intro: string
    gatewayHeading: string
    gatewayIntro: string
    addressLabel: string
    probeButton: string
    loginHeading: string
    loginIntro: string
    loginNote: string
    providerLabel: string
    providerPlaceholder: string
    saveHeading: string
    saveIntro: string
    adminSecretLabel: string
    adminSecretNote: string
    saveButton: string
    footer: (version: string) => string
    /**
     * The sentences the inline script says.
     *
     * Injected into the page as one JSON literal rather than spliced in one at
     * a time, so there is a single place where the escaping has to be right.
     * The two that interpolate are rendered with `{name}` markers and filled in
     * by the script: a function cannot cross into a `<script>` element, and a
     * translation has to stay free to reorder the pieces around the value.
     */
    script: {
      probing: (address: string) => string
      probed: (version: string, flows: string) => string
      noSignIn: string
      didNotWork: string
      asking: string
      saving: string
      savedNothingCanAdmin: string
      savedOpening: string
      loginStored: string
    }
    /** The page the gateway's redirect lands on at the end of the service login. */
    callback: {
      nothingWaitingTitle: string
      nothingWaitingDetail: string
      failedTitle: string
      noCode: string
      signedInTitle: string
      signedInDetail: string
      back: string
    }
  }
  admin: {
    /**
     * The left-hand nav.
     *
     * Each label is the page's own heading or a shortening of it. A nav that
     * renames the page it links to is the inconsistency this restructure was
     * supposed to remove, so `cache` is the one abbreviation and it is a
     * shortening rather than a different word.
     */
    nav: {
      overview: string
      people: string
      push: string
      cache: string
      branding: string
      features: string
      identity: string
      danger: string
    }
    footer: {
      /**
       * The software and its version.
       *
       * Deliberately not the deployment's name: the header already carries
       * that, and a footer that repeated it would say "Acme Chat — Acme Chat".
       * What an operator needs down here is what this IS and which build.
       */
      version: (version: string) => string
    }
    overview: {
      title: string
      intro: string
      /** The two figures a first glance is for, and the link onward from each. */
      peopleSeen: (count: number) => string
      accountsHere: (count: number) => string
    }
    danger: {
      title: string
      intro: string
    }
    /**
     * Starting the setup over.
     *
     * Every sentence here names one file's worth of consequence, because the
     * operator is about to lose configuration nothing can hand back and the one
     * honest way to ask is to list it. The keys are separate rather than one
     * block of markup so a translator sees each consequence as its own sentence.
     */
    reset: {
      heading: string
      intro: string
      alsoCache: string
      alsoPush: string
      button: string
      confirmTitle: string
      confirmIntro: string
      clearsHeading: string
      clearsGateway: string
      clearsAdministrators: string
      clearsBranding: string
      clearsServiceLogin: string
      clearsPeople: string
      keepsHeading: string
      keepsIdentity: string
      keepsCache: string
      keepsPush: string
      /** What will happen at the end, which depends on where the gateway came from. */
      thenSetup: string
      thenStays: (gatewayUrl: string) => string
      pushKeepsRunning: string
      cancel: string
      confirmButton: string
    }
    signIn: {
      intro: string
      secretNote: string
      wrongSecret: string
    }
    forbidden: {
      title: string
      knownAs: (viewer: string) => string
      unknown: string
      note: string
    }
    /** The label on the overview's gateway row. The address itself is not copy. */
    gateway: string
    service: {
      heading: string
      version: string
      upToDate: string
      updateAvailable: (version: string) => string
      serviceLogin: string
      pushDaemon: string
      running: string
      notRunning: string
      vapidKey: string
      messageCache: string
      cacheOff: string
      cacheFill: (entries: number, used: string, cap: string) => string
      cacheHits: string
      hitRate: (percent: number, total: number) => string
      nothingAsked: string
      userList: string
      fromGateway: string
      fromSeen: string
      updateButton: string
      updateUnavailable: string
    }
    push: {
      heading: string
      intro: string
      previewLabel: string
      previewDevice: string
      previewNever: string
      saveButton: string
    }
    cache: {
      heading: string
      retentionLabel: string
      capNote: string
      clearButton: string
    }
    identity: {
      heading: string
      on: (issuer: string, accounts: number) => string
      off: string
      link: string
    }
    branding: {
      heading: string
      intro: string
      nameLabel: string
      accentLabel: string
      themeLabel: string
      note: string
      saveButton: string
    }
    features: {
      heading: string
      userChats: string
      messageCache: string
      selfUpdate: string
      saveButton: string
    }
    people: {
      heading: string
      intro: string
      empty: string
      who: string
      lastSeen: string
      bots: string
      readOnly: string
      push: string
      administrator: string
      allowedBotsLabel: string
      pushAllowed: string
      administratorBox: string
      /** The short pill beside a name whose administrator status came from `HERMIE_ADMINS`. */
      managedNote: string
      /** The fuller sentence in that same row's panel. */
      managedAdminNote: string
      addHeading: string
      addLabel: string
      addButton: string
      signedInAs: (viewer: string) => string
      signedInLocally: string
      /** What the second line of a row says this person is, and how they got here. */
      sourceIssuer: string
      sourceGateway: string
      /**
       * Two rows, one name, and no merge.
       *
       * A gateway with its own sign-in and an account on the built-in issuer are
       * two identities as far as the gateway is concerned, even when the person
       * is one person and the username is one username. Merging them would be
       * this service inventing a fact; saying so on both rows is the operator
       * being told why they are looking at two.
       */
      sameAsIssuer: string
      sameAsGateway: string
      /** The same thing in three words, for the line itself. */
      alsoIssuer: string
      alsoGateway: string
      /** The disclosure that holds everything the two-sentence intro dropped. */
      howHeading: string
      howReadOnly: string
      /** What that source means, and what the administrator switch does on such a row. */
      issuerNote: string
      /** The bots column: all of them, none of them, or how many of how many. */
      allBots: string
      noBots: string
      someBots: (allowed: number, total: number) => string
      botsHeading: string
      everyBot: string
      botsNote: string
      /** The per-person panel. */
      gatewayUserId: string
      source: string
      savesRow: string
      openAccount: string
    }
  }
  /**
   * `/admin/oidc`, the built-in identity provider's own page.
   *
   * A branch of its own rather than a corner of `admin`, because it is its own
   * page: `admin.identity` is the three-line summary and the link, and this is
   * everything behind that link.
   *
   * What is NOT here is as deliberate as what is. The two configuration
   * snippets are machine input — an operator pastes them into the gateway's
   * `config.yaml` — so they are built in `admin/identity.ts` and never pass
   * through a catalogue. The same goes for `dashboard.oauth.self_hosted.*`,
   * `offline_access`, `--allow-insecure-oidc` and `public_url`: those are typed
   * or pasted somewhere that does not speak Dutch.
   */
  identity: {
    /** The `<title>`; the `<h1>` is `heading`, which has the tab strip's context already. */
    title: string
    heading: string
    backToAdmin: string
    provider: {
      heading: string
      intro: string
      status: string
      on: string
      off: string
      issuer: string
      signingKeys: string
      /** `2 published (one current, the rest being retired)` — the parenthesis only above one. */
      keysPublished: (keys: number) => string
      accounts: string
      originBlocked: (origin: string) => string
      turnOff: string
      turnOffNote: string
      turnOn: string
      turnOnNote: (origin: string) => string
      /** The address this page was actually reached on, beside the stored issuer. */
      reachedOn: string
      /**
       * The stored issuer and this address disagree.
       *
       * The case this was written for is a reverse proxy that dropped the port:
       * the issuer was captured once, the address moved, and every token since
       * has carried an origin nothing answers on.
       */
      issuerElsewhere: (issuer: string, origin: string) => string
      recapture: string
      recaptureNote: string
    }
    guide: {
      heading: string
      intro: string
      orContainer: string
      issuer: string
      clientId: string
      clientIdValue: (clientId: string) => string
      redirectUri: string
      clientSecret: string
      clientSecretValue: string
      offlineAccess: string
      redirectIsTheGateways: string
      redirectsLabel: string
      redirectsNote: string
      saveRedirects: string
    }
    accounts: {
      heading: string
      intro: string
      who: string
      role: string
      twoFactor: string
      lastSignIn: string
      empty: string
      disabled: string
      totpOn: string
      totpInvited: string
      totpOff: string
      /** The two role names, which are also the values the form posts. */
      roleUser: string
      roleAdmin: string
      resetPassword: string
      reEnable: string
      disable: string
      clearTotp: string
      remove: string
      /** Ends in the colon the link follows; the link itself is not copy. */
      invitation: (username: string) => string
      username: string
      email: string
      displayName: string
      invite: string
      inviteHeading: string
      inviteNote: string
      /** The pills beside a username, all of them sentence case and quiet. */
      administrator: string
      invited: string
      twoFactorOn: string
      /** The panel: the subject id an operator sometimes has to copy, and the rest. */
      subject: string
      subjectNote: string
      actionsHeading: string
    }
    test: {
      heading: string
      intro: string
      username: string
      password: string
      code: string
      run: string
      note: string
      stepOk: string
      stepFailed: string
    }
    settings: {
      heading: string
      requireTotp: string
      idTokenTtl: string
      refreshTokenTtl: string
      note: string
    }
    keys: {
      heading: string
      intro: string
      rotate: string
    }
  }
  oidc: {
    signIn: {
      title: (issuerName: string) => string
      heading: string
      username: string
      password: string
      totp: string
      recovery: string
      verify: string
      notRight: string
      tooManyAttempts: string
    }
    error: {
      title: string
      inviteSpent: string
      enrolmentGone: string
      codeNotRight: string
    }
    /**
     * The two pages that are a SUCCESS, and used not to look like one.
     *
     * Setting a password and enrolling an authenticator both ended on the error
     * page: the sentence underneath said the password was set, and the heading
     * above it said "Sign-in failed". Somebody who had just done exactly what
     * they were asked read the heading, believed it, and went looking for what
     * they had got wrong. A page that reports a success needs its own heading,
     * and a way onward — which is the link back to the application, because the
     * provider has nowhere of its own to send anybody.
     */
    done: {
      passwordSetTitle: string
      passwordSetDetail: string
      twoFactorTitle: string
      twoFactorDetail: string
      /** The link onward: the application this issuer signs people in to. */
      back: (issuerName: string) => string
    }
    signedOut: {
      title: string
      detail: (issuerName: string) => string
      note: string
    }
    invite: {
      title: string
      password: string
      again: string
      submit: string
      note: string
      tooShort: string
      mismatch: string
    }
    enrol: {
      title: string
      heading: string
      addToAuthenticator: string
      orOpen: string
      typeTheCode: string
      totp: string
      confirm: string
      recoveryHeading: string
      recoveryNote: string
    }
  }
}

/**
 * Short month names, by zero-based index.
 *
 * A table rather than `Intl`: a small-ICU build of Node answers English for
 * every language and would do it silently, which is exactly the kind of
 * difference between two deployments nobody ever finds.
 */
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_NL = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']
const MONTHS_DE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']

/** The source. Every other language is a partial answer to this. */
const EN: WebStrings = {
  common: {
    signIn: 'Sign in',
    save: 'Save',
    administration: 'Administration',
    administrationTitle: 'Hermie Web administration',
    administratorSecret: 'Administrator secret',
    yes: 'yes',
    no: 'no',
    today: 'today',
    yesterday: 'yesterday',
    monthShort: month => MONTHS_EN[month] ?? '',
    details: 'Details',
    detailsFor: name => `Details for ${name}`,
    close: 'Close'
  },
  setup: {
    title: 'Set up Hermie Web',
    intro:
      'This page exists once. When the gateway is saved it answers 404, and everybody else only ever sees a sign-in.',
    gatewayHeading: '1. The gateway',
    gatewayIntro: 'The Hermes gateway this server proxies. It is fixed once it is saved.',
    addressLabel: 'Address',
    probeButton: 'Probe',
    loginHeading: '2. The service login',
    loginIntro:
      'One sign-in that belongs to this <em>server</em>, not to you. Hermie Web spends it on a gateway connection ' +
      'of its own, and uses that connection for two things: push notifications, and the message cache that makes a ' +
      'chat paint the moment it opens. It is not the sign-in the app will ask you for.',
    loginNote:
      'Optional here. Without it the app still works; push and the cache do not. You can also do it from a terminal ' +
      "with <code>hermie-web login</code>, which is the route to take if your provider will not accept this server's " +
      'own address as a redirect.',
    providerLabel: 'Provider',
    providerPlaceholder: "leave empty for the gateway's default",
    saveHeading: '3. Save',
    saveIntro: "Saving writes the gateway to this server's state directory and closes this page for good.",
    adminSecretLabel: 'Administrator secret (optional)',
    adminSecretNote:
      'Only needed on a gateway with no accounts. With accounts, whoever is signed in right now becomes this ' +
      "service's first administrator and this can stay empty. Stored as a scrypt hash; <code>/admin</code> never " +
      'shows it back.',
    saveButton: 'Save and finish',
    footer: version => `Hermie Web ${version}`,
    script: {
      probing: address => `Probing ${address} …`,
      probed: (version, flows) => `Hermes ${version} — ${flows}.`,
      noSignIn: 'no sign-in required',
      didNotWork: 'That did not work.',
      asking: 'Asking the gateway for a sign-in address …',
      saving: 'Saving …',
      savedNothingCanAdmin: 'Saved, but nothing can open /admin: this gateway named nobody and no secret was set.',
      savedOpening: 'Saved. Opening Hermie …',
      loginStored: 'The service login was stored.'
    },
    callback: {
      nothingWaitingTitle: 'Nothing was waiting',
      nothingWaitingDetail: 'Start the service sign-in from the setup page.',
      failedTitle: 'Sign-in failed',
      noCode: 'That redirect did not carry the code this server was waiting for.',
      signedInTitle: 'The service is signed in',
      signedInDetail: 'Hermie Web stored the sign-in it uses for push and for the message cache.',
      back: 'Back to setup'
    }
  },
  admin: {
    nav: {
      overview: 'Overview',
      people: 'People',
      push: 'Push',
      cache: 'Cache',
      branding: 'Branding',
      features: 'Features',
      identity: 'Identity',
      danger: 'Danger zone'
    },
    footer: {
      version: version => `Hermie Web ${version}`
    },
    overview: {
      title: 'Overview',
      intro: 'What this service is running, what it is connected to, and what it has been asked to do.',
      peopleSeen: count => `${count} ${count === 1 ? 'person' : 'people'} seen`,
      accountsHere: count => `${count} account${count === 1 ? '' : 's'} on this issuer`
    },
    danger: {
      title: 'Danger zone',
      intro: 'Two things that cannot be undone from this page afterwards. Both ask again before they do anything.'
    },
    reset: {
      heading: 'Run setup again',
      intro:
        'Clears what <code>/setup</code> wrote and reopens it, so this deployment can be pointed at another ' +
        'gateway or handed to somebody else. Nothing about this is recoverable from this page.',
      alsoCache: 'Also delete every cached message',
      alsoPush: 'Also delete the VAPID key and the push bookkeeping',
      button: 'Run setup again…',
      confirmTitle: 'Reset the setup?',
      confirmIntro: 'Read this list. There is no way back from the next button.',
      clearsHeading: 'This is cleared',
      clearsGateway: 'The gateway address and the public URL that <code>/setup</code> saved.',
      clearsAdministrators:
        'The administrator list and the local administrator secret — <strong>including your own way back into ' +
        'this page</strong>.',
      clearsBranding: 'The branding, the feature switches, the push policy and the cache retention.',
      clearsServiceLogin: 'The service login this server holds for push and for the message cache.',
      clearsPeople: 'The list of people this service has seen, with their per-person options.',
      keepsHeading: 'This is kept',
      keepsIdentity:
        'The built-in identity provider: its accounts, its signing key and its client id. <code>/setup</code> ' +
        'never wrote those, and throwing away an issuer’s key would sign out every account on the gateway.',
      keepsCache: 'The cached messages, unless you ticked the box.',
      keepsPush: 'The VAPID key and the push bookkeeping, unless you ticked the box.',
      thenSetup: 'Afterwards <code>/setup</code> is open again and this page is closed until somebody completes it.',
      thenStays: gatewayUrl =>
        `This service was started with a gateway on the command line (<code>${gatewayUrl}</code>), so that one is ` +
        'kept and <code>/setup</code> stays closed. Remove the flag and restart to open it.',
      pushKeepsRunning:
        'A push daemon that is already connected keeps its connection until this service restarts; the stored ' +
        'login is gone either way.',
      cancel: 'No, leave it alone',
      confirmButton: 'Yes, reset the setup'
    },
    signIn: {
      intro:
        'This service has no gateway accounts to recognise you by, so it asks for the administrator secret set ' +
        'during setup.',
      secretNote: 'Stored as a scrypt hash. This page never shows it back.',
      wrongSecret: 'That secret was not right.'
    },
    forbidden: {
      title: 'Not an administrator',
      knownAs: viewer =>
        `The gateway knows you as <code>${viewer}</code>, and that id is not on this service’s administrator list.`,
      unknown: 'This gateway did not say who you are, so this service has nobody to check against.',
      note:
        'An existing administrator can add an id on this page. On a service with no gateway accounts, the ' +
        'administrator secret set during setup is the way in.'
    },
    gateway: 'Gateway',
    service: {
      heading: 'Service',
      version: 'Version',
      upToDate: 'up to date',
      updateAvailable: version => `<strong>${version} available</strong>`,
      serviceLogin: 'Service login',
      pushDaemon: 'Push daemon',
      running: 'running',
      notRunning: 'not running',
      vapidKey: 'VAPID key',
      messageCache: 'Message cache',
      cacheOff: 'off',
      cacheFill: (entries, used, cap) => `${entries} entries · ${used} of ${cap}`,
      cacheHits: 'Cache hits',
      hitRate: (percent, total) => `${percent}% of ${total}`,
      nothingAsked: 'nothing asked yet',
      userList: 'User list',
      fromGateway: 'from the gateway',
      fromSeen: 'people this service has seen sign in',
      updateButton: 'Update and restart',
      updateUnavailable: 'not available here'
    },
    push: {
      heading: 'Push',
      intro:
        'A ceiling, not a second opt-in: a device still has to have asked. Turning one off silences it for everybody.',
      previewLabel: 'Preview policy',
      previewDevice: 'Each device decides',
      previewNever: 'Never include message text',
      saveButton: 'Save push settings'
    },
    cache: {
      heading: 'Message cache',
      retentionLabel: 'Drop entries unread for (hours, 0 = size cap only)',
      capNote: 'The size cap is <code>--cache-max-mb</code> and is set at start-up, not here.',
      clearButton: 'Clear the cache now'
    },
    identity: {
      heading: 'Identity',
      on: (issuer, accounts) =>
        `This service is signing people in itself, as <code>${issuer}</code>, for ${accounts} account` +
        `${accounts === 1 ? '' : 's'}. <strong>That makes it the identity root of your gateway.</strong>`,
      off:
        'This service can sign people in itself, for a deployment with no identity provider of its own. It is ' +
        '<strong>off</strong>.',
      link: 'Identity settings, accounts and the gateway snippet →'
    },
    branding: {
      heading: 'Branding',
      intro: 'Served in <code>/hermie/config.json</code> and read by the app before it draws anything.',
      nameLabel: 'Name',
      accentLabel: 'Accent',
      themeLabel: 'Default theme preset',
      note: 'A reader who has chosen their own keeps it; this is the starting point, not an override.',
      saveButton: 'Save branding'
    },
    features: {
      heading: 'Features',
      userChats: 'Private chats beside the shared Bot Chat',
      messageCache: 'Serve the message cache to the app',
      selfUpdate: 'Offer the update button in the app',
      saveButton: 'Save features'
    },
    people: {
      heading: 'People',
      intro:
        '<strong>These are service-level settings, not gateway permissions.</strong> Push, the message cache and ' +
        'the bot list are this service’s own, and every switch below takes effect when you save that person.',
      empty: 'Nobody has signed in through this service yet.',
      who: 'Who',
      lastSeen: 'Last seen',
      bots: 'Bots',
      readOnly: 'Read-only',
      push: 'Push',
      administrator: 'administrator',
      allowedBotsLabel: 'Allowed bots (blank = all)',
      pushAllowed: 'Push allowed',
      administratorBox: 'Administrator',
      managedNote: 'set by configuration',
      managedAdminNote:
        'This administrator is named by this container’s HERMIE_ADMINS and cannot be removed here. Drop it from ' +
        'that list and restart to let it go.',
      addHeading: 'Add somebody',
      addLabel: 'Gateway user id',
      addButton: 'Add',
      signedInAs: viewer => `You are signed in as <code>${viewer}</code>. The last administrator cannot be removed.`,
      signedInLocally: 'You are signed in with the local administrator secret.',
      sourceIssuer: 'account on this service',
      sourceGateway: 'gateway sign-in',
      sameAsIssuer: 'same username as the account on this service',
      sameAsGateway: 'same username as the gateway sign-in',
      alsoIssuer: 'also an account here',
      alsoGateway: 'also a gateway sign-in',
      howHeading: 'How this list works',
      howReadOnly:
        'Read-only refuses every mutating HTTP request; it cannot police the gateway WebSocket, which is a byte ' +
        'pipe by design — so it is a guard rail, not a boundary.',
      issuerNote:
        'A row whose source is <strong>account on this service</strong> is an account on this service’s own issuer, ' +
        'so its gateway user id is the account’s subject. Turning <strong>Administrator</strong> on or off there ' +
        'changes the account’s role, which is the same switch as the one on the identity page.',
      allBots: 'All bots',
      noBots: 'No bots',
      someBots: (allowed, total) => `${allowed} of ${total}`,
      botsHeading: 'Bots this person may reach',
      everyBot: 'Every bot',
      botsNote:
        'Every bot covers the ones added later too. Clearing every box allows none of them, which is not the ' +
        'same answer.',
      gatewayUserId: 'Gateway user id',
      source: 'Source',
      savesRow: 'Saves the switches on this person’s row as well.',
      openAccount: 'Open the account on the identity page'
    }
  },
  identity: {
    title: 'Identity — Hermie Web',
    heading: 'Identity',
    backToAdmin: '← Administration',
    provider: {
      heading: 'The built-in identity provider',
      intro:
        'An OpenID Provider inside this service, for a deployment with no identity provider of its own. It is ' +
        '<strong>off unless you turn it on</strong>, it federates with nothing, and turning it on makes ' +
        '<strong>this service the identity root of your gateway</strong>: whoever holds this state directory can ' +
        'mint any account on it.',
      status: 'Status',
      on: 'on',
      off: 'off',
      issuer: 'Issuer',
      signingKeys: 'Signing keys',
      keysPublished: keys => `${keys} published${keys > 1 ? ' (one current, the rest being retired)' : ''}`,
      accounts: 'Accounts',
      originBlocked: origin =>
        `<strong>This origin cannot be an issuer.</strong> You reached this page on <code>${origin}</code>, and ` +
        'the gateway refuses an issuer that is not <code>https</code> (or <code>http</code> on loopback) — so a ' +
        'provider enabled here would work in a browser and be rejected by the gateway. Put TLS in front of this ' +
        'service, or restart it with <code>--allow-insecure-oidc</code> if you are testing.',
      turnOff: 'Turn it off',
      turnOffNote: 'Accounts and keys are kept; every refresh token is dropped.',
      turnOn: 'Turn it on',
      turnOnNote: origin =>
        `The issuer becomes <code>${origin}/oidc</code>, taken from the address you reached this page on.`,
      reachedOn: 'Reached on',
      issuerElsewhere: (issuer, origin) =>
        `<strong>The stored issuer is not this address.</strong> Every token says <code>${issuer}</code> while you ` +
        `reached this page on <code>${origin}</code>. If nothing answers on the stored one — a reverse proxy that ` +
        'dropped the port is the usual cause — the gateway cannot fetch the key set and nobody can sign in.',
      recapture: 'Re-capture the issuer from this address',
      recaptureNote:
        'Keeps the accounts, the signing keys, the client id and every refresh token; only the issuer and the ' +
        'redirect URI are recomputed. The gateway’s own configuration then has to name the new issuer, so update ' +
        'the snippet below and restart it — until you do, sign-in is refused at the gateway.'
    },
    guide: {
      heading: 'What to put in the gateway’s configuration',
      intro:
        'Enabling this here changes <strong>nothing</strong> on the gateway. Hermie Web does not write the ' +
        'gateway’s configuration and would not know how; it tells you what to write. Put this in ' +
        '<code>config.yaml</code> and restart the gateway.',
      orContainer: 'Or, for a container:',
      issuer: 'Issuer',
      clientId: 'Client id',
      clientIdValue: clientId => `<code>${clientId}</code> — fixed for this install`,
      redirectUri: 'Redirect URI',
      clientSecret: 'Client secret',
      clientSecretValue: 'none — this is a public client, and PKCE is what authenticates the exchange',
      offlineAccess:
        '<strong><code>offline_access</code> is in that scope list on purpose.</strong> Without it the gateway is ' +
        'issued no refresh token, and this service’s own push sign-in cannot be made at all — the daemon would ' +
        'need somebody at a terminal every hour.',
      redirectIsTheGateways:
        '<strong>The redirect URI is the gateway’s, not the app’s.</strong> A phone signing in never talks to ' +
        'this issuer: the gateway brokers that flow and its loopback redirect is registered with the gateway, ' +
        'not here.',
      redirectsLabel: 'Redirect URIs, one per line',
      redirectsNote: 'Only change this if the gateway’s <code>public_url</code> is not what this page derived.',
      saveRedirects: 'Save redirect URIs'
    },
    accounts: {
      heading: 'Accounts',
      intro:
        '<strong>These are this issuer’s own accounts</strong> — the people it will sign in. They are not the ' +
        'same list as the one on <a href="/admin">the main page</a>, which is whoever the GATEWAY has seen; a ' +
        'person appears there only once they have signed in through it.',
      who: 'Who',
      role: 'Role',
      twoFactor: '2FA',
      lastSignIn: 'Last sign-in',
      empty: 'Nobody has an account on this issuer yet.',
      disabled: 'disabled',
      totpOn: 'on',
      totpInvited: 'invited',
      totpOff: 'off',
      roleUser: 'user',
      roleAdmin: 'admin',
      resetPassword: 'Reset password',
      reEnable: 'Re-enable',
      disable: 'Disable',
      clearTotp: 'Clear two-factor',
      remove: 'Remove',
      invitation: username =>
        `<strong>Invitation for ${username}</strong> — send them this link. It works once, lapses in a day, and ` +
        'is <em>not shown again</em>:',
      username: 'Username',
      email: 'Email',
      displayName: 'Display name',
      invite: 'Invite',
      inviteHeading: 'Invite somebody',
      inviteNote:
        'Creating somebody mints a one-time link they use to choose their own password. Nobody else, including ' +
        'you, ever sees it — which is the only way to add an account that does not end with a password in a chat ' +
        'window.',
      administrator: 'administrator',
      invited: 'invited',
      twoFactorOn: '2FA on',
      subject: 'Subject id',
      subjectNote: 'This is the gateway user id the people list is keyed by. Copy it from here when you need it.',
      actionsHeading: 'Role and actions'
    },
    test: {
      heading: 'Test sign-in',
      intro:
        'Runs the whole round trip from this server against its own issuer — discovery, the JWKS, the sign-in ' +
        "form, the code exchange, the ID token's signature and the refresh grant — and reports each step. It uses " +
        'a real account, because a test that skipped the sign-in form would be testing a path nobody takes. The ' +
        'redirect is read and never followed, so nothing is sent to the gateway.',
      username: 'Username',
      password: 'Password',
      code: 'Code, if enrolled',
      run: 'Run it',
      note: 'Nothing typed here is stored or logged. The tokens it produces are discarded.',
      stepOk: 'ok',
      stepFailed: 'failed'
    },
    settings: {
      heading: 'Settings',
      requireTotp: 'Require a second factor, enrolling anybody who has not got one',
      idTokenTtl: 'ID token lifetime (seconds)',
      refreshTokenTtl: 'Refresh token lifetime (seconds)',
      note:
        'The ID token’s lifetime is the gateway’s session length: it holds the ID token and re-verifies it on ' +
        'every request, refreshing only once it has expired.'
    },
    keys: {
      heading: 'Signing keys',
      intro:
        'Rotating mints a new key and signs with it immediately. The old key stays in the published JWKS until ' +
        'everything it signed has expired, plus the window a relying party caches the JWKS for — so a rotation ' +
        'signs nobody out.',
      rotate: 'Rotate the signing key'
    }
  },
  oidc: {
    signIn: {
      title: issuerName => `Sign in to ${issuerName}`,
      heading: 'Sign in',
      username: 'Username',
      password: 'Password',
      totp: 'Six-digit code',
      recovery: '…or one recovery code',
      verify: 'Verify',
      notRight: 'That sign-in was not right.',
      tooManyAttempts: 'Too many attempts. Wait a few minutes and try again.'
    },
    error: {
      title: 'Sign-in failed',
      inviteSpent: 'That invitation has been used or has expired.',
      enrolmentGone: 'That enrolment is no longer in progress.',
      codeNotRight: 'That code was not right. Go back and try the next one the app shows.'
    },
    done: {
      passwordSetTitle: 'Your password is set',
      passwordSetDetail: 'That invitation has been used up. Sign in with the password you just chose.',
      twoFactorTitle: 'Two-factor is on',
      twoFactorDetail: 'This account will ask for a code from your authenticator at every sign-in.',
      back: issuerName => `Back to ${issuerName}`
    },
    signedOut: {
      title: 'Signed out',
      detail: issuerName => `Your sign-in to ${issuerName} has been forgotten on this server.`,
      note: 'The application you came from may keep its own session until it expires.'
    },
    invite: {
      title: 'Choose a password',
      password: 'Password',
      again: 'Again',
      submit: 'Set the password',
      note:
        'This link works once and then stops. Nobody else, including whoever invited you, ever sees what you type ' +
        'here.',
      tooShort: 'Use at least twelve characters. Length is what makes a password hard to guess.',
      mismatch: 'Those two did not match.'
    },
    enrol: {
      title: 'Set up two-factor',
      heading: 'Two-factor',
      addToAuthenticator: 'Add this to your authenticator:',
      orOpen: 'Or open',
      typeTheCode: 'Type the code it shows, to prove it works.',
      totp: 'Six-digit code',
      confirm: 'Confirm',
      recoveryHeading: 'Recovery codes',
      recoveryNote: 'Each works once, in place of a code from the app. This is the only time they are shown.'
    }
  }
}

/**
 * A catalogue: the same shape as `WebStrings`, optional all the way down.
 *
 * Every key is optional, so a partial catalogue is a working catalogue from its
 * first line — which is the point, and why a round may add English copy today
 * and translate it next week. What is NOT optional is the KIND: a key that
 * interpolates stays a function here, because the type refusing a bare string
 * is cheaper than a sentence rendered with a hole in it.
 */
export type WebCatalogue<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => string ? T[K] : T[K] extends object ? WebCatalogue<T[K]> : T[K]
}

/**
 * Dutch. Informal throughout: `je`, never `u` — this is somebody's own bots on
 * somebody's own machine, not a bank (`docs/i18n.md`).
 *
 * The keys that are absent are absent deliberately: `Hermie Web 1.2.3` and
 * `Hermes 1.2.3 — cookie.` read the same in Dutch, so the fallback says them.
 */
const NL: WebCatalogue<WebStrings> = {
  common: {
    signIn: 'Inloggen',
    save: 'Opslaan',
    administration: 'Beheer',
    administrationTitle: 'Hermie Web-beheer',
    administratorSecret: 'Beheerderswachtwoord',
    yes: 'ja',
    no: 'nee',
    today: 'vandaag',
    yesterday: 'gisteren',
    monthShort: month => MONTHS_NL[month] ?? '',
    details: 'Details',
    detailsFor: name => `Details van ${name}`,
    close: 'Sluiten'
  },
  setup: {
    title: 'Hermie Web instellen',
    intro:
      'Deze pagina bestaat één keer. Zodra de gateway is opgeslagen antwoordt hij 404, en ziet iedereen verder ' +
      'alleen nog een inlogscherm.',
    gatewayHeading: '1. De gateway',
    gatewayIntro: 'De Hermes gateway waar deze server naartoe proxyt. Die ligt vast zodra hij is opgeslagen.',
    addressLabel: 'Adres',
    probeButton: 'Testen',
    loginHeading: '2. De service-login',
    loginIntro:
      'Eén login die van deze <em>server</em> is, niet van jou. Hermie Web gebruikt hem voor een eigen ' +
      'gateway-verbinding, en die verbinding voor twee dingen: push-notificaties, en de berichtencache die een chat ' +
      'meteen laat verschijnen als je hem opent. Dit is niet de login waar de app je om vraagt.',
    loginNote:
      'Hier optioneel. Zonder werkt de app gewoon; push en de cache niet. Je kunt het ook vanuit een terminal doen ' +
      'met <code>hermie-web login</code>, en dat is de route als je provider het eigen adres van deze server niet ' +
      'als redirect accepteert.',
    providerPlaceholder: 'leeg laten voor de standaard van de gateway',
    saveHeading: '3. Opslaan',
    saveIntro: 'Opslaan schrijft de gateway naar de state-map van deze server en sluit deze pagina voorgoed.',
    adminSecretLabel: 'Beheerderswachtwoord (optioneel)',
    adminSecretNote:
      'Alleen nodig op een gateway zonder accounts. Mét accounts wordt degene die nu is ingelogd de eerste ' +
      'beheerder van deze service en kan dit leeg blijven. Opgeslagen als scrypt-hash; <code>/admin</code> laat hem ' +
      'nooit meer zien.',
    saveButton: 'Opslaan en afronden',
    script: {
      probing: address => `${address} testen …`,
      noSignIn: 'geen login nodig',
      didNotWork: 'Dat werkte niet.',
      asking: 'De gateway om een inlogadres vragen …',
      saving: 'Opslaan …',
      savedNothingCanAdmin:
        'Opgeslagen, maar niets kan /admin openen: deze gateway noemde niemand en er is geen ' +
        'beheerderswachtwoord ingesteld.',
      savedOpening: 'Opgeslagen. Hermie openen …',
      loginStored: 'De service-login is opgeslagen.'
    },
    callback: {
      nothingWaitingTitle: 'Er stond niets te wachten',
      nothingWaitingDetail: 'Start de service-login vanaf de setup-pagina.',
      failedTitle: 'Inloggen mislukt',
      noCode: 'Die redirect droeg niet de code waar deze server op wachtte.',
      signedInTitle: 'De service is ingelogd',
      signedInDetail: 'Hermie Web heeft de login opgeslagen die het gebruikt voor push en voor de berichtencache.',
      back: 'Terug naar setup'
    }
  },
  admin: {
    nav: {
      overview: 'Overzicht',
      people: 'Mensen',
      push: 'Push',
      cache: 'Cache',
      branding: 'Branding',
      features: 'Functies',
      identity: 'Identiteit',
      danger: 'Gevarenzone'
    },
    footer: {
      version: version => `Hermie Web ${version}`
    },
    overview: {
      title: 'Overzicht',
      intro: 'Wat deze service draait, waar hij mee verbonden is, en wat hem gevraagd is te doen.',
      peopleSeen: count => `${count} ${count === 1 ? 'persoon' : 'mensen'} gezien`,
      accountsHere: count => `${count} account${count === 1 ? '' : 's'} op deze issuer`
    },
    danger: {
      title: 'Gevarenzone',
      intro:
        'Twee dingen die je hier daarna niet meer kunt terugdraaien. Beide vragen het eerst nog een keer voordat ' +
        'er iets gebeurt.'
    },
    reset: {
      heading: 'Setup opnieuw draaien',
      intro:
        'Wist wat <code>/setup</code> geschreven heeft en zet die pagina weer open, zodat deze deployment naar een ' +
        'andere gateway kan wijzen of aan iemand anders kan worden overgedragen. Niets hiervan is vanaf deze ' +
        'pagina terug te halen.',
      alsoCache: 'Ook elk gecachet bericht verwijderen',
      alsoPush: 'Ook de VAPID-sleutel en de push-administratie verwijderen',
      button: 'Setup opnieuw draaien…',
      confirmTitle: 'Setup resetten?',
      confirmIntro: 'Lees deze lijst. Na de volgende knop is er geen weg terug.',
      clearsHeading: 'Dit wordt gewist',
      clearsGateway: 'Het gateway-adres en de publieke URL die <code>/setup</code> heeft opgeslagen.',
      clearsAdministrators:
        'De beheerderslijst en het lokale beheerderswachtwoord — <strong>inclusief je eigen weg terug naar deze ' +
        'pagina</strong>.',
      clearsBranding: 'De branding, de functieschakelaars, het pushbeleid en de cache-bewaartijd.',
      clearsServiceLogin: 'De service-login die deze server heeft voor push en voor de berichtencache.',
      clearsPeople: 'De lijst met mensen die deze service gezien heeft, met hun persoonlijke instellingen.',
      keepsHeading: 'Dit blijft',
      keepsIdentity:
        'De ingebouwde identity provider: de accounts, de ondertekeningssleutel en het client id. Die heeft ' +
        '<code>/setup</code> nooit geschreven, en de sleutel van een issuer weggooien logt elk account op de ' +
        'gateway uit.',
      keepsCache: 'De gecachete berichten, tenzij je het vakje hebt aangevinkt.',
      keepsPush: 'De VAPID-sleutel en de push-administratie, tenzij je het vakje hebt aangevinkt.',
      thenSetup: 'Daarna staat <code>/setup</code> weer open en is deze pagina dicht tot iemand hem heeft afgerond.',
      thenStays: gatewayUrl =>
        `Deze service is gestart met een gateway op de commandoregel (<code>${gatewayUrl}</code>), dus die blijft ` +
        'staan en <code>/setup</code> blijft dicht. Haal de vlag weg en herstart om hem te openen.',
      pushKeepsRunning:
        'Een push-daemon die al verbonden is, houdt die verbinding tot deze service herstart; de opgeslagen login ' +
        'is hoe dan ook weg.',
      cancel: 'Nee, laat maar',
      confirmButton: 'Ja, reset de setup'
    },
    gateway: 'Gateway',
    signIn: {
      intro:
        'Deze service heeft geen gateway-accounts om je aan te herkennen, dus vraagt hij om het ' +
        'beheerderswachtwoord dat tijdens de setup is ingesteld.',
      secretNote: 'Opgeslagen als scrypt-hash. Deze pagina laat hem nooit meer zien.',
      wrongSecret: 'Dat wachtwoord klopte niet.'
    },
    forbidden: {
      title: 'Geen beheerder',
      knownAs: viewer =>
        `De gateway kent je als <code>${viewer}</code>, en dat id staat niet op de beheerderslijst van deze service.`,
      unknown: 'Deze gateway heeft niet gezegd wie je bent, dus deze service heeft niemand om tegen te controleren.',
      note:
        'Een bestaande beheerder kan hier een id toevoegen. Op een service zonder gateway-accounts is het ' +
        'beheerderswachtwoord uit de setup de weg naar binnen.'
    },
    service: {
      heading: 'Service',
      version: 'Versie',
      upToDate: 'up-to-date',
      updateAvailable: version => `<strong>${version} beschikbaar</strong>`,
      serviceLogin: 'Service-login',
      pushDaemon: 'Push-daemon',
      running: 'draait',
      notRunning: 'draait niet',
      vapidKey: 'VAPID-sleutel',
      messageCache: 'Berichtencache',
      cacheOff: 'uit',
      cacheFill: (entries, used, cap) => `${entries} items · ${used} van ${cap}`,
      cacheHits: 'Cache-hits',
      hitRate: (percent, total) => `${percent}% van ${total}`,
      nothingAsked: 'nog niets gevraagd',
      userList: 'Gebruikerslijst',
      fromGateway: 'van de gateway',
      fromSeen: 'mensen die deze service heeft zien inloggen',
      updateButton: 'Bijwerken en herstarten',
      updateUnavailable: 'hier niet beschikbaar'
    },
    push: {
      heading: 'Push',
      intro:
        'Een plafond, geen tweede opt-in: een apparaat moet er nog steeds zelf om gevraagd hebben. Eentje uitzetten ' +
        'legt hem voor iedereen stil.',
      previewLabel: 'Previewbeleid',
      previewDevice: 'Elk apparaat beslist zelf',
      previewNever: 'Nooit berichttekst meesturen',
      saveButton: 'Push-instellingen opslaan'
    },
    cache: {
      heading: 'Berichtencache',
      retentionLabel: 'Ongelezen items weggooien na (uren, 0 = alleen de maximale grootte)',
      capNote: 'De maximale grootte is <code>--cache-max-mb</code> en wordt bij het starten ingesteld, niet hier.',
      clearButton: 'Cache nu legen'
    },
    identity: {
      heading: 'Identiteit',
      on: (issuer, accounts) =>
        `Deze service logt mensen zelf in, als <code>${issuer}</code>, voor ${accounts} account` +
        `${accounts === 1 ? '' : 's'}. <strong>Daarmee is het de identiteitswortel van je gateway.</strong>`,
      off:
        'Deze service kan mensen zelf inloggen, voor een deployment zonder eigen identity provider. Hij staat ' +
        '<strong>uit</strong>.',
      link: 'Identiteitsinstellingen, accounts en het gateway-snippet →'
    },
    branding: {
      heading: 'Branding',
      intro: 'Wordt geserveerd in <code>/hermie/config.json</code> en door de app gelezen voordat hij iets tekent.',
      nameLabel: 'Naam',
      accentLabel: 'Accent',
      themeLabel: 'Standaard themapreset',
      note: 'Wie zelf iets gekozen heeft, houdt dat; dit is het startpunt, geen overschrijving.',
      saveButton: 'Branding opslaan'
    },
    features: {
      heading: 'Functies',
      userChats: 'Privé-chats naast de gedeelde Bot Chat',
      messageCache: 'De berichtencache aan de app serveren',
      selfUpdate: 'De update-knop in de app aanbieden',
      saveButton: 'Functies opslaan'
    },
    people: {
      heading: 'Mensen',
      intro:
        '<strong>Dit zijn instellingen van de service, geen gateway-permissies.</strong> Push, de berichtencache en ' +
        'de botlijst zijn van deze service zelf, en elke schakelaar hieronder gaat in zodra je die persoon opslaat.',
      empty: 'Er heeft nog niemand via deze service ingelogd.',
      who: 'Wie',
      lastSeen: 'Laatst gezien',
      readOnly: 'Alleen-lezen',
      administrator: 'beheerder',
      allowedBotsLabel: 'Toegestane bots (leeg = alle)',
      pushAllowed: 'Push toegestaan',
      administratorBox: 'Beheerder',
      managedNote: 'ingesteld via configuratie',
      managedAdminNote:
        'Deze beheerder komt uit de HERMIE_ADMINS van deze container en kan hier niet worden verwijderd. Haal het ' +
        'id van die lijst en herstart om dat wel te doen.',
      addHeading: 'Iemand toevoegen',
      addLabel: 'Gateway-gebruikers-id',
      addButton: 'Toevoegen',
      signedInAs: viewer =>
        `Je bent ingelogd als <code>${viewer}</code>. De laatste beheerder kan niet worden verwijderd.`,
      signedInLocally: 'Je bent ingelogd met het lokale beheerderswachtwoord.',
      sourceIssuer: 'account op deze service',
      sourceGateway: 'gateway-login',
      sameAsIssuer: 'zelfde gebruikersnaam als het account op deze service',
      sameAsGateway: 'zelfde gebruikersnaam als de gateway-login',
      alsoIssuer: 'ook een account hier',
      alsoGateway: 'ook een gateway-login',
      howHeading: 'Hoe deze lijst werkt',
      howReadOnly:
        'Alleen-lezen weigert elk wijzigend HTTP-verzoek; het kan de gateway-WebSocket niet bewaken, want dat is ' +
        'met opzet een bytepijp — het is dus een vangrail, geen grens.',
      issuerNote:
        'Een regel met bron <strong>account op deze service</strong> is een account op de eigen issuer van deze ' +
        'service, dus de gateway-gebruikers-id is het subject van het account. <strong>Beheerder</strong> daar aan- ' +
        'of uitzetten verandert de rol van het account — dezelfde schakelaar als die op de identiteitspagina.',
      allBots: 'Alle bots',
      noBots: 'Geen bots',
      someBots: (allowed, total) => `${allowed} van ${total}`,
      botsHeading: 'Bots die deze persoon mag bereiken',
      everyBot: 'Elke bot',
      botsNote:
        'Elke bot geldt ook voor bots die er later bij komen. Alle vakjes leeg betekent geen enkele bot, en dat ' +
        'is een ander antwoord.',
      gatewayUserId: 'Gateway-gebruikers-id',
      source: 'Bron',
      savesRow: 'Slaat ook de schakelaars op de regel van deze persoon op.',
      openAccount: 'Open het account op de identiteitspagina'
    }
  },
  identity: {
    title: 'Identiteit — Hermie Web',
    heading: 'Identiteit',
    backToAdmin: '← Beheer',
    provider: {
      heading: 'De ingebouwde identity provider',
      intro:
        'Een OpenID Provider binnen deze service, voor een deployment zonder eigen identity provider. Hij staat ' +
        '<strong>uit tenzij je hem aanzet</strong>, hij federeert met niets, en aanzetten maakt <strong>deze ' +
        'service de identiteitswortel van je gateway</strong>: wie deze state-map heeft, kan er elk account op ' +
        'aanmaken.',
      on: 'aan',
      off: 'uit',
      signingKeys: 'Ondertekeningssleutels',
      keysPublished: keys => `${keys} gepubliceerd${keys > 1 ? ' (één actief, de rest wordt uitgefaseerd)' : ''}`,
      originBlocked: origin =>
        `<strong>Deze origin kan geen issuer zijn.</strong> Je hebt deze pagina bereikt op <code>${origin}</code>, ` +
        'en de gateway weigert een issuer die geen <code>https</code> is (of <code>http</code> op loopback) — een ' +
        'provider die je hier aanzet zou dus in een browser werken en door de gateway geweigerd worden. Zet TLS ' +
        'voor deze service, of herstart hem met <code>--allow-insecure-oidc</code> als je aan het testen bent.',
      turnOff: 'Zet hem uit',
      turnOffNote: 'Accounts en sleutels blijven bewaard; elk refresh token vervalt.',
      turnOn: 'Zet hem aan',
      turnOnNote: origin =>
        `De issuer wordt <code>${origin}/oidc</code>, genomen uit het adres waarop je deze pagina bereikt hebt.`,
      reachedOn: 'Bereikt op',
      issuerElsewhere: (issuer, origin) =>
        `<strong>De opgeslagen issuer is niet dit adres.</strong> Elk token zegt <code>${issuer}</code>, terwijl je ` +
        `deze pagina bereikt hebt op <code>${origin}</code>. Als er op de opgeslagen issuer niets antwoordt — een ` +
        'reverse proxy die de poort weglaat is de gebruikelijke oorzaak — kan de gateway de sleutelset niet ophalen ' +
        'en kan er niemand inloggen.',
      recapture: 'Issuer opnieuw uit dit adres overnemen',
      recaptureNote:
        'De accounts, de ondertekeningssleutels, het client id en elk refresh token blijven; alleen de issuer en de ' +
        'redirect-URI worden opnieuw berekend. De configuratie van de gateway moet daarna de nieuwe issuer noemen, ' +
        'dus werk het snippet hieronder bij en herstart hem — tot dat gebeurd is weigert de gateway elke login.'
    },
    guide: {
      heading: 'Wat je in de configuratie van de gateway zet',
      intro:
        'Dit hier aanzetten verandert <strong>niets</strong> aan de gateway. Hermie Web schrijft de configuratie ' +
        'van de gateway niet en zou ook niet weten hoe; het vertelt je wat je moet schrijven. Zet dit in ' +
        '<code>config.yaml</code> en herstart de gateway.',
      orContainer: 'Of, voor een container:',
      clientIdValue: clientId => `<code>${clientId}</code> — vast voor deze installatie`,
      clientSecretValue: 'geen — dit is een public client, en PKCE is wat de uitwisseling authenticeert',
      offlineAccess:
        '<strong><code>offline_access</code> staat met opzet in die scope-lijst.</strong> Zonder dat krijgt de ' +
        'gateway geen refresh token, en kan de eigen push-login van deze service helemaal niet gemaakt worden — ' +
        'de daemon zou elk uur iemand achter een terminal nodig hebben.',
      redirectIsTheGateways:
        '<strong>De redirect URI is die van de gateway, niet die van de app.</strong> Een telefoon die inlogt ' +
        'praat nooit met deze issuer: de gateway bemiddelt die flow, en zijn loopback-redirect staat bij de ' +
        'gateway geregistreerd, niet hier.',
      redirectsLabel: 'Redirect URI’s, één per regel',
      redirectsNote:
        'Verander dit alleen als de <code>public_url</code> van de gateway niet is wat deze pagina heeft afgeleid.',
      saveRedirects: 'Redirect URI’s opslaan'
    },
    accounts: {
      intro:
        '<strong>Dit zijn de eigen accounts van deze issuer</strong> — de mensen die hij gaat inloggen. Het is ' +
        'niet dezelfde lijst als die op <a href="/admin">de hoofdpagina</a>, want dat is iedereen die de GATEWAY ' +
        'heeft gezien; iemand komt daar pas te staan zodra diegene via de gateway heeft ingelogd.',
      who: 'Wie',
      role: 'Rol',
      lastSignIn: 'Laatst ingelogd',
      empty: 'Niemand heeft nog een account op deze issuer.',
      disabled: 'uitgeschakeld',
      totpOn: 'aan',
      totpInvited: 'uitgenodigd',
      totpOff: 'uit',
      roleUser: 'gebruiker',
      roleAdmin: 'beheerder',
      resetPassword: 'Wachtwoord opnieuw instellen',
      reEnable: 'Weer inschakelen',
      disable: 'Uitschakelen',
      clearTotp: 'Tweefactor wissen',
      remove: 'Verwijderen',
      invitation: username =>
        `<strong>Uitnodiging voor ${username}</strong> — stuur diegene deze link. Hij werkt één keer, vervalt ` +
        'binnen een dag, en wordt <em>niet nog een keer getoond</em>:',
      username: 'Gebruikersnaam',
      email: 'E-mail',
      displayName: 'Weergavenaam',
      invite: 'Uitnodigen',
      inviteHeading: 'Iemand uitnodigen',
      inviteNote:
        'Iemand aanmaken maakt een eenmalige link waarmee diegene zelf een wachtwoord kiest. Niemand anders, jij ' +
        'ook niet, ziet die ooit — en dat is de enige manier om een account toe te voegen die niet eindigt met ' +
        'een wachtwoord in een chatvenster.',
      administrator: 'beheerder',
      invited: 'uitgenodigd',
      twoFactorOn: '2FA aan',
      subject: 'Subject-id',
      subjectNote: 'Dit is de gateway-gebruikers-id waarop de mensenlijst is gesleuteld. Kopieer hem hiervandaan.',
      actionsHeading: 'Rol en acties'
    },
    test: {
      heading: 'Test-login',
      intro:
        'Draait de hele rondgang vanaf deze server tegen zijn eigen issuer — discovery, de JWKS, het ' +
        'inlogformulier, de code-uitwisseling, de handtekening van het ID token en de refresh grant — en ' +
        'rapporteert elke stap. Hij gebruikt een echt account, want een test die het inlogformulier oversloeg zou ' +
        'een pad testen dat niemand neemt. De redirect wordt gelezen en nooit gevolgd, dus er gaat niets naar de ' +
        'gateway.',
      username: 'Gebruikersnaam',
      password: 'Wachtwoord',
      code: 'Code, als er een is ingesteld',
      run: 'Uitvoeren',
      note: 'Wat je hier typt wordt niet opgeslagen en niet gelogd. De tokens die het oplevert worden weggegooid.',
      stepFailed: 'mislukt'
    },
    settings: {
      heading: 'Instellingen',
      requireTotp: 'Een tweede factor verplichten, en iedereen die er geen heeft er een laten instellen',
      idTokenTtl: 'Levensduur van het ID token (seconden)',
      refreshTokenTtl: 'Levensduur van het refresh token (seconden)',
      note:
        'De levensduur van het ID token is de sessielengte van de gateway: die houdt het ID token vast en ' +
        'controleert het bij elk verzoek opnieuw, en ververst pas als het verlopen is.'
    },
    keys: {
      heading: 'Ondertekeningssleutels',
      intro:
        'Roteren maakt een nieuwe sleutel en ondertekent er meteen mee. De oude sleutel blijft in de ' +
        'gepubliceerde JWKS staan tot alles wat ermee ondertekend is verlopen is, plus de tijd dat een relying ' +
        'party de JWKS cachet — een rotatie logt dus niemand uit.',
      rotate: 'Ondertekeningssleutel roteren'
    }
  },
  oidc: {
    signIn: {
      title: issuerName => `Inloggen bij ${issuerName}`,
      heading: 'Inloggen',
      username: 'Gebruikersnaam',
      password: 'Wachtwoord',
      totp: 'Zescijferige code',
      recovery: '…of één herstelcode',
      verify: 'Controleren',
      notRight: 'Die login klopte niet.',
      tooManyAttempts: 'Te veel pogingen. Wacht een paar minuten en probeer het opnieuw.'
    },
    error: {
      title: 'Inloggen mislukt',
      inviteSpent: 'Die uitnodiging is al gebruikt of verlopen.',
      enrolmentGone: 'Die aanmelding loopt niet meer.',
      codeNotRight: 'Die code klopte niet. Ga terug en probeer de volgende die de app laat zien.'
    },
    done: {
      passwordSetTitle: 'Je wachtwoord staat ingesteld',
      passwordSetDetail: 'Die uitnodiging is nu opgebruikt. Log in met het wachtwoord dat je net gekozen hebt.',
      twoFactorTitle: 'Tweefactor staat aan',
      twoFactorDetail: 'Dit account vraagt bij elke login om een code uit je authenticator.',
      back: issuerName => `Terug naar ${issuerName}`
    },
    signedOut: {
      title: 'Uitgelogd',
      detail: issuerName => `Je login bij ${issuerName} is op deze server vergeten.`,
      note: 'De applicatie waar je vandaan kwam kan zijn eigen sessie nog houden tot die verloopt.'
    },
    invite: {
      title: 'Kies een wachtwoord',
      password: 'Wachtwoord',
      again: 'Nog een keer',
      submit: 'Wachtwoord instellen',
      note:
        'Deze link werkt één keer en stopt dan. Niemand anders, ook niet wie je uitnodigde, ziet ooit wat je hier ' +
        'typt.',
      tooShort: 'Gebruik minstens twaalf tekens. Lengte is wat een wachtwoord moeilijk te raden maakt.',
      mismatch: 'Die twee kwamen niet overeen.'
    },
    enrol: {
      title: 'Tweefactor instellen',
      heading: 'Tweefactor',
      addToAuthenticator: 'Zet dit in je authenticator:',
      orOpen: 'Of open',
      typeTheCode: 'Typ de code die hij laat zien, om te bewijzen dat het werkt.',
      totp: 'Zescijferige code',
      confirm: 'Bevestigen',
      recoveryHeading: 'Herstelcodes',
      recoveryNote: 'Elke code werkt één keer, in plaats van een code uit de app. Dit is de enige keer dat je ze ziet.'
    }
  }
}

/**
 * German. Informal throughout: `du`, never `Sie` — matching the Dutch `je`
 * rather than the formal register a German product would usually pick, for the
 * same reason (`docs/i18n.md`).
 */
const DE: WebCatalogue<WebStrings> = {
  common: {
    signIn: 'Anmelden',
    save: 'Speichern',
    administration: 'Verwaltung',
    administrationTitle: 'Hermie Web-Verwaltung',
    administratorSecret: 'Administrator-Passwort',
    yes: 'ja',
    no: 'nein',
    today: 'heute',
    yesterday: 'gestern',
    monthShort: month => MONTHS_DE[month] ?? '',
    details: 'Details',
    detailsFor: name => `Details zu ${name}`,
    close: 'Schließen'
  },
  setup: {
    title: 'Hermie Web einrichten',
    intro:
      'Diese Seite gibt es einmal. Sobald das gateway gespeichert ist, antwortet sie mit 404, und alle anderen ' +
      'sehen nur noch eine Anmeldung.',
    gatewayHeading: '1. Das gateway',
    gatewayIntro: 'Das Hermes gateway, zu dem dieser Server weiterleitet. Es liegt fest, sobald es gespeichert ist.',
    addressLabel: 'Adresse',
    probeButton: 'Prüfen',
    loginHeading: '2. Die Dienst-Anmeldung',
    loginIntro:
      'Eine Anmeldung, die diesem <em>Server</em> gehört, nicht dir. Hermie Web verwendet sie für eine eigene ' +
      'gateway-Verbindung und diese Verbindung für zwei Dinge: push-Benachrichtigungen und den Nachrichten-Cache, ' +
      'der einen Chat sofort beim Öffnen zeichnet. Es ist nicht die Anmeldung, nach der die App dich fragt.',
    loginNote:
      'Hier optional. Ohne sie funktioniert die App weiterhin; push und der Cache nicht. Du kannst es auch im ' +
      'Terminal mit <code>hermie-web login</code> machen — der Weg, wenn dein Provider die eigene Adresse dieses ' +
      'Servers nicht als Redirect akzeptiert.',
    providerPlaceholder: 'leer lassen für die Vorgabe des gateway',
    saveHeading: '3. Speichern',
    saveIntro:
      'Speichern schreibt das gateway in das Statusverzeichnis dieses Servers und schließt diese Seite endgültig.',
    adminSecretLabel: 'Administrator-Passwort (optional)',
    adminSecretNote:
      'Nur nötig auf einem gateway ohne Konten. Mit Konten wird die Person, die gerade angemeldet ist, der erste ' +
      'Administrator dieses Dienstes, und dies kann leer bleiben. Als scrypt-Hash gespeichert; <code>/admin</code> ' +
      'zeigt es nie wieder an.',
    saveButton: 'Speichern und fertig',
    script: {
      probing: address => `${address} wird geprüft …`,
      noSignIn: 'keine Anmeldung nötig',
      didNotWork: 'Das hat nicht geklappt.',
      asking: 'Das gateway wird nach einer Anmeldeadresse gefragt …',
      saving: 'Wird gespeichert …',
      savedNothingCanAdmin:
        'Gespeichert, aber nichts kann /admin öffnen: dieses gateway hat niemanden genannt und es wurde kein ' +
        'Passwort gesetzt.',
      savedOpening: 'Gespeichert. Hermie wird geöffnet …',
      loginStored: 'Die Dienst-Anmeldung wurde gespeichert.'
    },
    callback: {
      nothingWaitingTitle: 'Es wartete nichts',
      nothingWaitingDetail: 'Starte die Dienst-Anmeldung auf der Setup-Seite.',
      failedTitle: 'Anmeldung fehlgeschlagen',
      noCode: 'Dieser Redirect trug nicht den Code, auf den dieser Server gewartet hat.',
      signedInTitle: 'Der Dienst ist angemeldet',
      signedInDetail:
        'Hermie Web hat die Anmeldung gespeichert, die es für push und für den Nachrichten-Cache verwendet.',
      back: 'Zurück zum Setup'
    }
  },
  admin: {
    nav: {
      overview: 'Übersicht',
      people: 'Menschen',
      push: 'Push',
      cache: 'Cache',
      branding: 'Branding',
      features: 'Funktionen',
      identity: 'Identität',
      danger: 'Gefahrenzone'
    },
    footer: {
      version: version => `Hermie Web ${version}`
    },
    overview: {
      title: 'Übersicht',
      intro: 'Was dieser Dienst läuft, womit er verbunden ist, und was ihm aufgetragen wurde.',
      peopleSeen: count => `${count} ${count === 1 ? 'Person' : 'Menschen'} gesehen`,
      accountsHere: count => `${count} Kont${count === 1 ? 'o' : 'en'} auf diesem issuer`
    },
    danger: {
      title: 'Gefahrenzone',
      intro:
        'Zwei Dinge, die von dieser Seite aus danach nicht rückgängig zu machen sind. Beide fragen noch einmal, ' +
        'bevor etwas passiert.'
    },
    reset: {
      heading: 'Setup noch einmal ausführen',
      intro:
        'Löscht, was <code>/setup</code> geschrieben hat, und öffnet die Seite wieder — damit diese Installation ' +
        'auf ein anderes gateway zeigen oder an jemand anderen übergeben werden kann. Nichts davon ist von dieser ' +
        'Seite aus wiederherstellbar.',
      alsoCache: 'Auch jede zwischengespeicherte Nachricht löschen',
      alsoPush: 'Auch den VAPID-Schlüssel und die Push-Buchführung löschen',
      button: 'Setup noch einmal ausführen…',
      confirmTitle: 'Setup zurücksetzen?',
      confirmIntro: 'Lies diese Liste. Nach dem nächsten Knopf gibt es keinen Weg zurück.',
      clearsHeading: 'Das wird gelöscht',
      clearsGateway: 'Die gateway-Adresse und die öffentliche URL, die <code>/setup</code> gespeichert hat.',
      clearsAdministrators:
        'Die Administratorliste und das lokale Administrator-Passwort — <strong>einschließlich deines eigenen ' +
        'Wegs zurück auf diese Seite</strong>.',
      clearsBranding: 'Das Branding, die Funktionsschalter, die Push-Regeln und die Cache-Aufbewahrung.',
      clearsServiceLogin: 'Die Dienst-Anmeldung, die dieser Server für Push und den Nachrichten-Cache hält.',
      clearsPeople: 'Die Liste der Menschen, die dieser Dienst gesehen hat, mit ihren Einstellungen.',
      keepsHeading: 'Das bleibt',
      keepsIdentity:
        'Die eingebaute identity provider: ihre Konten, ihr Signierschlüssel und ihre client id. Die hat ' +
        '<code>/setup</code> nie geschrieben, und den Schlüssel eines issuer wegzuwerfen meldet jedes Konto am ' +
        'gateway ab.',
      keepsCache: 'Die zwischengespeicherten Nachrichten, außer du hast das Kästchen angehakt.',
      keepsPush: 'Der VAPID-Schlüssel und die Push-Buchführung, außer du hast das Kästchen angehakt.',
      thenSetup:
        'Danach ist <code>/setup</code> wieder offen und diese Seite geschlossen, bis jemand es abgeschlossen hat.',
      thenStays: gatewayUrl =>
        `Dieser Dienst wurde mit einem gateway auf der Kommandozeile gestartet (<code>${gatewayUrl}</code>), das ` +
        'bleibt also stehen und <code>/setup</code> bleibt zu. Nimm die Flag weg und starte neu, um sie zu öffnen.',
      pushKeepsRunning:
        'Ein bereits verbundener Push-Daemon behält seine Verbindung, bis dieser Dienst neu startet; die ' +
        'gespeicherte Anmeldung ist so oder so weg.',
      cancel: 'Nein, lass es',
      confirmButton: 'Ja, Setup zurücksetzen'
    },
    gateway: 'Gateway',
    signIn: {
      intro:
        'Dieser Dienst hat keine gateway-Konten, an denen er dich erkennen könnte, und fragt deshalb nach dem ' +
        'Administrator-Passwort aus dem Setup.',
      secretNote: 'Als scrypt-Hash gespeichert. Diese Seite zeigt es nie wieder an.',
      wrongSecret: 'Dieses Passwort war nicht richtig.'
    },
    forbidden: {
      title: 'Kein Administrator',
      knownAs: viewer =>
        `Das gateway kennt dich als <code>${viewer}</code>, und diese id steht nicht auf der Administratorenliste ` +
        'dieses Dienstes.',
      unknown: 'Dieses gateway hat nicht gesagt, wer du bist, also hat dieser Dienst niemanden zum Abgleichen.',
      note:
        'Ein vorhandener Administrator kann hier eine id hinzufügen. Auf einem Dienst ohne gateway-Konten ist das ' +
        'im Setup gesetzte Administrator-Passwort der Weg hinein.'
    },
    service: {
      heading: 'Dienst',
      version: 'Version',
      upToDate: 'aktuell',
      updateAvailable: version => `<strong>${version} verfügbar</strong>`,
      serviceLogin: 'Dienst-Anmeldung',
      pushDaemon: 'Push-Daemon',
      running: 'läuft',
      notRunning: 'läuft nicht',
      vapidKey: 'VAPID-Schlüssel',
      messageCache: 'Nachrichten-Cache',
      cacheOff: 'aus',
      cacheFill: (entries, used, cap) => `${entries} Einträge · ${used} von ${cap}`,
      cacheHits: 'Cache-Treffer',
      hitRate: (percent, total) => `${percent}% von ${total}`,
      nothingAsked: 'noch nichts abgefragt',
      userList: 'Benutzerliste',
      fromGateway: 'vom gateway',
      fromSeen: 'Menschen, die dieser Dienst sich hat anmelden sehen',
      updateButton: 'Aktualisieren und neu starten',
      updateUnavailable: 'hier nicht verfügbar'
    },
    push: {
      heading: 'Push',
      intro:
        'Eine Obergrenze, kein zweites Opt-in: ein Gerät muss trotzdem selbst gefragt haben. Eines abzuschalten ' +
        'legt es für alle still.',
      previewLabel: 'Vorschau-Regel',
      previewDevice: 'Jedes Gerät entscheidet selbst',
      previewNever: 'Nie Nachrichtentext mitschicken',
      saveButton: 'Push-Einstellungen speichern'
    },
    cache: {
      heading: 'Nachrichten-Cache',
      retentionLabel: 'Ungelesene Einträge verwerfen nach (Stunden, 0 = nur die Größengrenze)',
      capNote: 'Die Größengrenze ist <code>--cache-max-mb</code> und wird beim Start gesetzt, nicht hier.',
      clearButton: 'Cache jetzt leeren'
    },
    identity: {
      heading: 'Identität',
      on: (issuer, accounts) =>
        `Dieser Dienst meldet Menschen selbst an, als <code>${issuer}</code>, für ${accounts} ` +
        `Kont${accounts === 1 ? 'o' : 'en'}. <strong>Damit ist er die Identitätswurzel deines gateway.</strong>`,
      off:
        'Dieser Dienst kann Menschen selbst anmelden, für eine Installation ohne eigenen Identity Provider. Er ist ' +
        '<strong>aus</strong>.',
      link: 'Identitätseinstellungen, Konten und das gateway-Snippet →'
    },
    branding: {
      heading: 'Branding',
      intro: 'Wird in <code>/hermie/config.json</code> ausgeliefert und von der App gelesen, bevor sie etwas zeichnet.',
      nameLabel: 'Name',
      accentLabel: 'Akzent',
      themeLabel: 'Standard-Themenvorgabe',
      note: 'Wer selbst etwas gewählt hat, behält es; das hier ist der Anfang, keine Übersteuerung.',
      saveButton: 'Branding speichern'
    },
    features: {
      heading: 'Funktionen',
      userChats: 'Private Chats neben dem gemeinsamen Bot Chat',
      messageCache: 'Den Nachrichten-Cache an die App ausliefern',
      selfUpdate: 'Den Update-Knopf in der App anbieten',
      saveButton: 'Funktionen speichern'
    },
    people: {
      heading: 'Menschen',
      intro:
        '<strong>Das sind Einstellungen des Dienstes, keine gateway-Berechtigungen.</strong> Push, der ' +
        'Nachrichten-Cache und die Bot-Liste gehören diesem Dienst selbst, und jeder Schalter unten gilt, sobald du ' +
        'diese Person speicherst.',
      empty: 'Über diesen Dienst hat sich noch niemand angemeldet.',
      who: 'Wer',
      lastSeen: 'Zuletzt gesehen',
      readOnly: 'Nur-Lesen',
      administrator: 'Administrator',
      allowedBotsLabel: 'Erlaubte Bots (leer = alle)',
      pushAllowed: 'Push erlaubt',
      administratorBox: 'Administrator',
      managedNote: 'per Konfiguration festgelegt',
      managedAdminNote:
        'Dieser Administrator wird von HERMIE_ADMINS dieses Containers benannt und kann hier nicht entfernt ' +
        'werden. Entferne die id aus dieser Liste und starte neu, um das zu ändern.',
      addHeading: 'Jemanden hinzufügen',
      addLabel: 'Gateway-Benutzer-id',
      addButton: 'Hinzufügen',
      signedInAs: viewer =>
        `Du bist als <code>${viewer}</code> angemeldet. Der letzte Administrator kann nicht entfernt werden.`,
      signedInLocally: 'Du bist mit dem lokalen Administrator-Passwort angemeldet.',
      sourceIssuer: 'Konto auf diesem Dienst',
      sourceGateway: 'gateway-Anmeldung',
      sameAsIssuer: 'gleicher Benutzername wie das Konto auf diesem Dienst',
      sameAsGateway: 'gleicher Benutzername wie die gateway-Anmeldung',
      alsoIssuer: 'auch ein Konto hier',
      alsoGateway: 'auch eine gateway-Anmeldung',
      howHeading: 'Wie diese Liste funktioniert',
      howReadOnly:
        'Nur-Lesen weist jede verändernde HTTP-Anfrage ab; den gateway-WebSocket kann es nicht überwachen, denn der ' +
        'ist mit Absicht eine Byte-Leitung — es ist also eine Leitplanke, keine Grenze.',
      issuerNote:
        'Eine Zeile mit der Quelle <strong>Konto auf diesem Dienst</strong> ist ein Konto auf der eigenen issuer ' +
        'dieses Dienstes, ihre gateway-Benutzer-id ist also das subject des Kontos. <strong>Administrator</strong> ' +
        'dort ein- oder auszuschalten ändert die Rolle des Kontos — derselbe Schalter wie auf der Identitätsseite.',
      allBots: 'Alle Bots',
      noBots: 'Keine Bots',
      someBots: (allowed, total) => `${allowed} von ${total}`,
      botsHeading: 'Bots, die diese Person erreichen darf',
      everyBot: 'Jeder Bot',
      botsNote:
        'Jeder Bot gilt auch für später hinzugefügte. Alle Kästchen leer erlaubt keinen einzigen Bot, und das ist ' +
        'eine andere Antwort.',
      gatewayUserId: 'Gateway-Benutzer-id',
      source: 'Quelle',
      savesRow: 'Speichert auch die Schalter in der Zeile dieser Person.',
      openAccount: 'Das Konto auf der Identitätsseite öffnen'
    }
  },
  identity: {
    title: 'Identität — Hermie Web',
    heading: 'Identität',
    backToAdmin: '← Verwaltung',
    provider: {
      heading: 'Der eingebaute Identity Provider',
      intro:
        'Ein OpenID Provider in diesem Dienst, für eine Installation ohne eigenen Identity Provider. Er ist ' +
        '<strong>aus, bis du ihn einschaltest</strong>, er föderiert mit nichts, und ihn einzuschalten macht ' +
        '<strong>diesen Dienst zur Identitätswurzel deines gateway</strong>: wer dieses Statusverzeichnis hat, ' +
        'kann darauf jedes Konto anlegen.',
      on: 'an',
      off: 'aus',
      signingKeys: 'Signaturschlüssel',
      keysPublished: keys =>
        `${keys} veröffentlicht${keys > 1 ? ' (einer aktuell, die übrigen werden ausgemustert)' : ''}`,
      accounts: 'Konten',
      originBlocked: origin =>
        `<strong>Dieser origin kann kein issuer sein.</strong> Du hast diese Seite auf <code>${origin}</code> ` +
        'erreicht, und das gateway lehnt einen issuer ab, der nicht <code>https</code> ist (oder <code>http</code> ' +
        'auf loopback) — ein hier eingeschalteter Provider würde also im Browser funktionieren und vom gateway ' +
        'abgelehnt werden. Setz TLS vor diesen Dienst, oder starte ihn mit <code>--allow-insecure-oidc</code> ' +
        'neu, wenn du testest.',
      turnOff: 'Ausschalten',
      turnOffNote: 'Konten und Schlüssel bleiben erhalten; jeder refresh token wird verworfen.',
      turnOn: 'Einschalten',
      turnOnNote: origin =>
        `Der issuer wird <code>${origin}/oidc</code>, genommen aus der Adresse, über die du diese Seite erreicht ` +
        'hast.',
      reachedOn: 'Erreicht über',
      issuerElsewhere: (issuer, origin) =>
        `<strong>Der gespeicherte issuer ist nicht diese Adresse.</strong> Jedes token nennt <code>${issuer}</code>, ` +
        `während du diese Seite über <code>${origin}</code> erreicht hast. Wenn auf dem gespeicherten issuer nichts ` +
        'antwortet — ein reverse proxy, der den Port weglässt, ist die übliche Ursache — kann das gateway das ' +
        'Schlüsselset nicht laden und niemand kann sich anmelden.',
      recapture: 'Den issuer aus dieser Adresse neu übernehmen',
      recaptureNote:
        'Konten, Signierschlüssel, client id und jeder refresh token bleiben; nur issuer und redirect URI werden ' +
        'neu berechnet. Die Konfiguration des gateway muss danach den neuen issuer nennen, also aktualisiere das ' +
        'snippet unten und starte es neu — bis dahin lehnt das gateway jede Anmeldung ab.'
    },
    guide: {
      heading: 'Was in die Konfiguration des gateway gehört',
      intro:
        'Das hier einzuschalten ändert <strong>nichts</strong> am gateway. Hermie Web schreibt die Konfiguration ' +
        'des gateway nicht und wüsste auch nicht wie; es sagt dir, was du schreiben musst. Trag das in ' +
        '<code>config.yaml</code> ein und starte das gateway neu.',
      orContainer: 'Oder, für einen Container:',
      clientIdValue: clientId => `<code>${clientId}</code> — fest für diese Installation`,
      clientSecretValue: 'keins — dies ist ein public client, und PKCE authentifiziert den Austausch',
      offlineAccess:
        '<strong><code>offline_access</code> steht mit Absicht in dieser scope-Liste.</strong> Ohne es bekommt ' +
        'das gateway keinen refresh token, und die eigene push-Anmeldung dieses Dienstes lässt sich überhaupt ' +
        'nicht herstellen — der Daemon bräuchte jede Stunde jemanden am Terminal.',
      redirectIsTheGateways:
        '<strong>Die Redirect URI gehört dem gateway, nicht der App.</strong> Ein Telefon, das sich anmeldet, ' +
        'spricht nie mit diesem issuer: das gateway vermittelt diesen Ablauf, und sein loopback-Redirect ist beim ' +
        'gateway registriert, nicht hier.',
      redirectsLabel: 'Redirect URIs, eine pro Zeile',
      redirectsNote:
        'Ändere das nur, wenn die <code>public_url</code> des gateway nicht das ist, was diese Seite abgeleitet ' +
        'hat.',
      saveRedirects: 'Redirect URIs speichern'
    },
    accounts: {
      heading: 'Konten',
      intro:
        '<strong>Das sind die eigenen Konten dieses issuer</strong> — die Menschen, die er anmelden wird. Es ist ' +
        'nicht dieselbe Liste wie die auf <a href="/admin">der Hauptseite</a>, denn dort steht, wen das GATEWAY ' +
        'gesehen hat; jemand taucht dort erst auf, sobald er sich darüber angemeldet hat.',
      who: 'Wer',
      role: 'Rolle',
      lastSignIn: 'Letzte Anmeldung',
      empty: 'Auf diesem issuer hat noch niemand ein Konto.',
      disabled: 'deaktiviert',
      totpOn: 'an',
      totpInvited: 'eingeladen',
      totpOff: 'aus',
      roleUser: 'Benutzer',
      roleAdmin: 'Administrator',
      resetPassword: 'Passwort zurücksetzen',
      reEnable: 'Wieder aktivieren',
      disable: 'Deaktivieren',
      clearTotp: 'Zwei-Faktor löschen',
      remove: 'Entfernen',
      invitation: username =>
        `<strong>Einladung für ${username}</strong> — schick dieser Person den Link. Er funktioniert einmal, ` +
        'verfällt binnen eines Tages und wird <em>nicht noch einmal gezeigt</em>:',
      username: 'Benutzername',
      email: 'E-Mail',
      displayName: 'Anzeigename',
      invite: 'Einladen',
      inviteHeading: 'Jemanden einladen',
      inviteNote:
        'Jemanden anzulegen erzeugt einen einmaligen Link, mit dem die Person ihr eigenes Passwort wählt. ' +
        'Niemand sonst, auch du nicht, sieht ihn jemals — und das ist die einzige Art, ein Konto hinzuzufügen, ' +
        'die nicht mit einem Passwort in einem Chatfenster endet.',
      administrator: 'Administrator',
      invited: 'eingeladen',
      twoFactorOn: '2FA an',
      subject: 'Subject-id',
      subjectNote: 'Das ist die gateway-Benutzer-id, nach der die Menschen-Liste geschlüsselt ist. Kopiere sie hier.',
      actionsHeading: 'Rolle und Aktionen'
    },
    test: {
      heading: 'Test-Anmeldung',
      intro:
        'Führt den ganzen Durchlauf von diesem Server gegen seinen eigenen issuer aus — Discovery, das JWKS, das ' +
        'Anmeldeformular, den Code-Austausch, die Signatur des ID token und den refresh grant — und meldet jeden ' +
        'Schritt. Er benutzt ein echtes Konto, denn ein Test, der das Anmeldeformular überspringt, würde einen ' +
        'Weg testen, den niemand geht. Der Redirect wird gelesen und nie verfolgt, es geht also nichts an das ' +
        'gateway.',
      username: 'Benutzername',
      password: 'Passwort',
      code: 'Code, falls eingerichtet',
      run: 'Ausführen',
      note: 'Was du hier tippst, wird nicht gespeichert und nicht geloggt. Die Token daraus werden verworfen.',
      stepFailed: 'fehlgeschlagen'
    },
    settings: {
      heading: 'Einstellungen',
      requireTotp: 'Einen zweiten Faktor verlangen und alle, die keinen haben, einen einrichten lassen',
      idTokenTtl: 'Lebensdauer des ID token (Sekunden)',
      refreshTokenTtl: 'Lebensdauer des refresh token (Sekunden)',
      note:
        'Die Lebensdauer des ID token ist die Sitzungslänge des gateway: es hält das ID token und prüft es bei ' +
        'jeder Anfrage neu, und erneuert es erst, wenn es abgelaufen ist.'
    },
    keys: {
      heading: 'Signaturschlüssel',
      intro:
        'Rotieren erzeugt einen neuen Schlüssel und signiert sofort damit. Der alte Schlüssel bleibt im ' +
        'veröffentlichten JWKS, bis alles damit Signierte abgelaufen ist, plus die Zeit, die eine Relying Party ' +
        'das JWKS cacht — eine Rotation meldet also niemanden ab.',
      rotate: 'Signaturschlüssel rotieren'
    }
  },
  oidc: {
    signIn: {
      title: issuerName => `Bei ${issuerName} anmelden`,
      heading: 'Anmelden',
      username: 'Benutzername',
      password: 'Passwort',
      totp: 'Sechsstelliger Code',
      recovery: '…oder ein Wiederherstellungscode',
      verify: 'Prüfen',
      notRight: 'Diese Anmeldung war nicht richtig.',
      tooManyAttempts: 'Zu viele Versuche. Warte ein paar Minuten und versuch es noch einmal.'
    },
    error: {
      title: 'Anmeldung fehlgeschlagen',
      inviteSpent: 'Diese Einladung wurde bereits benutzt oder ist abgelaufen.',
      enrolmentGone: 'Diese Einrichtung läuft nicht mehr.',
      codeNotRight: 'Dieser Code war nicht richtig. Geh zurück und probier den nächsten, den die App zeigt.'
    },
    done: {
      passwordSetTitle: 'Dein Passwort ist gesetzt',
      passwordSetDetail:
        'Diese Einladung ist damit verbraucht. Melde dich mit dem Passwort an, das du gerade gewählt hast.',
      twoFactorTitle: 'Zwei-Faktor ist an',
      twoFactorDetail: 'Dieses Konto fragt bei jeder Anmeldung nach einem Code aus deiner Authenticator-App.',
      back: issuerName => `Zurück zu ${issuerName}`
    },
    signedOut: {
      title: 'Abgemeldet',
      detail: issuerName => `Deine Anmeldung bei ${issuerName} wurde auf diesem Server vergessen.`,
      note: 'Die Anwendung, aus der du kamst, behält ihre eigene Sitzung womöglich, bis sie abläuft.'
    },
    invite: {
      title: 'Wähle ein Passwort',
      password: 'Passwort',
      again: 'Noch einmal',
      submit: 'Passwort setzen',
      note:
        'Dieser Link funktioniert einmal und hört dann auf. Niemand sonst, auch nicht wer dich eingeladen hat, ' +
        'sieht jemals, was du hier tippst.',
      tooShort: 'Nimm mindestens zwölf Zeichen. Länge ist, was ein Passwort schwer zu raten macht.',
      mismatch: 'Die beiden stimmten nicht überein.'
    },
    enrol: {
      title: 'Zwei-Faktor einrichten',
      heading: 'Zwei-Faktor',
      addToAuthenticator: 'Trag das in deinen Authenticator ein:',
      orOpen: 'Oder öffne',
      typeTheCode: 'Tipp den Code, den er zeigt, um zu beweisen, dass es funktioniert.',
      totp: 'Sechsstelliger Code',
      confirm: 'Bestätigen',
      recoveryHeading: 'Wiederherstellungscodes',
      recoveryNote:
        'Jeder funktioniert einmal, anstelle eines Codes aus der App. Dies ist das einzige Mal, dass sie gezeigt ' +
        'werden.'
    }
  }
}

const CATALOGUES: Record<WebLocale, WebCatalogue<WebStrings> | null> = { en: null, nl: NL, de: DE }

/**
 * Lay a catalogue over the English source, branch by branch.
 *
 * English wins on three counts, and they are all the same count: the catalogue
 * is silent, the catalogue holds the wrong KIND (a string where a function
 * belongs, or the reverse), or it holds an object where a sentence belongs. A
 * half-written catalogue can therefore never render `undefined` or
 * `[object Object]` on a page somebody is trying to sign in through.
 */
function layOver(english: unknown, translation: unknown): unknown {
  if (typeof english === 'function') {
    return typeof translation === 'function' ? translation : english
  }

  if (typeof english === 'string') {
    return typeof translation === 'string' ? translation : english
  }

  if (!translation || typeof translation !== 'object') {
    return english
  }

  const over = translation as Record<string, unknown>

  return Object.fromEntries(
    Object.entries(english as Record<string, unknown>).map(([key, value]) => [key, layOver(value, over[key])])
  )
}

/**
 * Merged once per language and kept, because these tables are read on every
 * render of every page and nothing in them depends on the request.
 */
const MERGED = new Map<WebLocale, WebStrings>()

/** The copy for one language, with the English sentence wherever it is silent. */
export function webStrings(locale: WebLocale): WebStrings {
  if (locale === 'en') {
    return EN
  }

  const held = MERGED.get(locale)

  if (held) {
    return held
  }

  const merged = layOver(EN, CATALOGUES[locale]) as WebStrings

  MERGED.set(locale, merged)

  return merged
}

/** The copy one incoming request asked for, and the language it was chosen in. */
export function webCopy(request: IncomingMessage): { locale: WebLocale; strings: WebStrings } {
  const locale = localeOf(request)

  return { locale, strings: webStrings(locale) }
}
