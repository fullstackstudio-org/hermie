/**
 * `i18n/strings.ts` in Dutch.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { Translation } from '../catalogue'
import type { strings } from '../strings'

/** `a, b of c` — de Nederlandse vorm van de `list` die de Engelse tabel zelf gebruikt. */
const orList = (items: string[]): string => {
  if (items.length <= 1) {
    return items[0] ?? ''
  }

  return `${items.slice(0, -1).join(', ')} of ${items[items.length - 1]}`
}

export const app: Translation<typeof strings> = {
  app: {
    loading: 'Starten…'
  },

  common: {
    back: 'Terug',
    cancel: 'Annuleren',
    continue: 'Doorgaan',
    retry: 'Opnieuw proberen',
    signIn: 'Inloggen',
    done: 'Klaar',
    add: 'Toevoegen',
    remove: 'Verwijderen',
    openInBrowser: 'Toch in de browser openen',
    search: 'Zoeken',
    noMatches: 'Daar past niets bij.',
    nothingToPick: 'Er is niets om uit te kiezen.',
    dismiss: 'Sluiten'
  },

  lock: {
    prompt: 'Hermie ontgrendelen',
    plateBody: 'Hermie is vergrendeld.',
    unlock: 'Ontgrendelen',
    stranded:
      'Hermie is vergrendeld en op dit apparaat is geen toegangscode of biometrie ingesteld om het te ontgrendelen. Stel er een in bij je apparaatinstellingen.'
  },

  onboarding: {
    stepCounter: (current: number, total: number) => `Stap ${current} van ${total}`,

    welcome: {
      title: 'Welkom bij Hermie',
      body: 'Hermie is een client voor Hermes Agent. Het praat met één gateway tegelijk — de machine waarop `hermes serve` draait — en chat met de bots die daar staan.',
      note: 'Er wordt niets opgeslagen voordat de verbinding is getest.',
      action: 'Een gateway instellen'
    },

    address: {
      title: 'Gateway-adres',
      subtitle: 'Het adres dat je in een browser zou openen om het dashboard van de gateway te bereiken.',
      label: 'ADRES',
      hint: 'Laat het schema weg en Hermie probeert eerst https://, daarna http://. Typ zelf een schema om het vast te zetten.',
      advanced: 'Geavanceerd',
      advancedHint:
        'Extra request headers gaan mee met elke aanroep en met de inlogpagina. Een reverse proxy die een gedeeld geheim wil, heeft dat hier nodig.',

      frontDoor: {
        label: 'VOOR DE GATEWAY',
        custom: 'Eigen headers',
        hint: 'Kies hoe de proxy vóór je gateway Hermie doorlaat. Niets hiervan gaat ergens anders heen dan naar het adres van de gateway zelf.',
        cloudflareHint:
          'Een service token uit je Access-applicatie. Hermie stuurt hem mee met elke request, met de WebSocket en met de inlogpagina. Sluit /auth/* en /login uit van het Access-beleid: een service token kan een inlog met redirects niet door de edge heen dragen.',
        insecure:
          'Deze gateway wordt via http:// bereikt, dus het service token wordt niet meegestuurd — het is een langlevende credential voor je hele Access-tenant. Gebruik https:// voor het adres dat de Access-applicatie dekt.'
      },

      headerValue: 'Waarde',
      addHeader: 'Een header toevoegen',
      showValue: 'Waarde tonen',
      hideValue: 'Waarde verbergen',
      removeHeader: (name: string) => `De ${name || 'lege'} header verwijderen`,
      probing: 'Controleren…',
      probingScheme: (scheme: string) => `${scheme} controleren…`,
      probingBoth: 'https:// controleren, daarna http://…',
      signInRequired: (version: string, providers: string[]) =>
        `Hermes ${version || 'gateway'} · inloggen vereist via ${orList(providers)}`,
      signInRequiredNoProviders: (version: string) =>
        `Hermes ${version || 'gateway'} · inloggen vereist, maar deze gateway noemt geen identity providers. Stel er een in op de gateway.`,
      sessionTokenRequired: (version: string) => `Hermes ${version || 'gateway'} · session token vereist`
    },

    signIn: {
      title: 'Inloggen',
      subtitleNative:
        'De gateway host de inlogpagina. Hermie opent die, leest het resultaat en bewaart de tokens op dit apparaat.',
      subtitleToken:
        'Deze gateway zit niet achter een identity provider; hij authenticeert met het session token dat hij bij het starten afdrukt.',
      subtitleCookie:
        'De gateway host de inlogpagina. Je browser bewaart de sessie die hij teruggeeft; Hermie ziet die nooit.',
      signInWith: (provider: string) => `Inloggen met ${provider}`,
      signedInAs: (user: string) => `Ingelogd als ${user}`,
      signedIn: 'Ingelogd',
      signOutAndRetry: 'Opnieuw inloggen',
      blockedTitle: 'Deze gateway is te oud om native in te loggen',
      blockedBody:
        'Hij vereist een inlog maar meldt de native_pkce-flow niet, en dat is de enige die een mobiele app kan afronden. Werk Hermes op de gateway bij.',
      tokenHelp: 'Plak het session token dat `hermes serve` afdrukt.',
      showToken: 'Token tonen',
      hideToken: 'Token verbergen',

      servedFrom: (host: string) => `Geleverd door Hermie Web, verbonden met ${host}.`,
      servedFromUnknown: 'Geleverd door Hermie Web.',
      probingGateway: 'De gateway lezen…',
      checkingSession: 'Controleren of je al ingelogd bent…',
      leavingForProvider: 'Je gaat naar de inlogpagina…',
      passwordUser: 'GEBRUIKERSNAAM',
      passwordSecret: 'WACHTWOORD',
      passwordUserLabel: 'Gebruikersnaam',
      passwordSecretLabel: 'Wachtwoord',
      passwordSubmit: 'Inloggen',
      showPassword: 'Wachtwoord tonen',
      hidePassword: 'Wachtwoord verbergen',
      cookieBlockedTitle: 'Deze gateway is te oud om in een browser in te loggen',
      cookieBlockedBody:
        'Hij vereist een inlog maar meldt de cookie-flow niet, en dat is de enige die een browsertab kan afronden. Werk Hermes op de gateway bij.',
      tokenBlockedTitle: 'Deze gateway is niet vanuit een browser te gebruiken',
      tokenBlockedBody:
        'Hij authenticeert met een session token, en een browsertab heeft geen veilige plek om er een te bewaren — alles wat in de pagina draait zou het kunnen lezen. Gebruik de Hermie-app, of zet de gateway achter een identity provider zodat hij een browsersessie kan uitgeven.',
      ssoOff:
        'Inloggen via SSO staat uit op deze Hermie Web. Vraag degene die hem beheert om je op een andere manier in te loggen.',
      signOutOfSession: 'Uitloggen',

      webview: {
        title: 'Inloggen',
        loading: 'De inlogpagina openen…',
        exchanging: 'Inloggen afronden…',
        timeout: 'De inlogpagina stond tien minuten open zonder af te ronden. Begin opnieuw wanneer je zover bent.',
        cancelled: 'Het inloggen is geannuleerd.',
        unavailable:
          'De in-app browser is niet beschikbaar op dit platform. Open de inlogpagina in je browser en plak het adres dat hij niet kan openen hier terug.',
        chosen:
          'Open de inlogpagina in je browser en plak het adres dat hij niet kan openen hier terug. Je kunt ook terug en alsnog de in-app pagina gebruiken.',
        headersWithheld:
          'Deze gateway heeft extra headers nodig, en de in-app browser van Android zou die doorsturen naar je identity provider. Log in je browser in en plak het adres dat hij niet kan openen hier terug.',
        fallbackLabel: 'Mislukt adres',
        fallbackHelp:
          'De browser zal een 127.0.0.1-adres niet kunnen laden — dat hoort zo. Kopieer het uit de adresbalk en plak het hier.',
        fallbackSubmit: 'Dit adres gebruiken',
        stateMismatch:
          'Het antwoord op de inlog hoorde niet bij deze poging en is weggegooid. Begin opnieuw met inloggen.',
        noCode: 'Het inloggen eindigde zonder authorization code. Begin opnieuw met inloggen.',
        providerError: (error: string, description: string) =>
          description
            ? `De gateway weigerde de inlog: ${description} (${error})`
            : `De gateway weigerde de inlog: ${error}`,
        httpError: (status: number) =>
          `De inlogpagina antwoordde met HTTP ${status}. Controleer het publieke adres van de gateway.`,
        loadError: (message: string) => `De inlogpagina kon niet worden geladen: ${message}`
      }
    },

    test: {
      title: 'Verbinding testen',
      subtitle:
        'Hermie controleert het REST-oppervlak en opent daarna de WebSocket, precies zoals tijdens het gebruik.',
      running: 'Testen…',
      retry: 'Opnieuw proberen',
      required: 'De verbinding is nog niet getest.',
      invalidated: 'Er is iets veranderd sinds de vorige test, dus hij draait opnieuw.',
      connectedAs: (user: string, bots: number) => `Verbonden als ${user} · ${bots === 1 ? '1 bot' : `${bots} bots`}`,
      connected: (bots: number) => `Verbonden · ${bots === 1 ? '1 bot' : `${bots} bots`}`,
      noBots: 'De verbinding werkt, maar deze gateway heeft nog geen bot-profielen.',

      checklist: {
        profiles: 'Profielen'
      }
    },

    notifications: {
      title: 'Meldingen',
      subtitle:
        'Je gateway kan dit apparaat laten weten wanneer een bot antwoordt, iets vraagt of een lange taak afrondt.',
      enable: 'Meldingen aanzetten',
      enabling: 'Vragen…',
      enabled: 'Meldingen staan aan voor dit apparaat.',
      denied: 'De toestemming is geweigerd. Je kunt het later aanzetten bij je apparaatinstellingen.',
      skip: 'Je kunt dit later aanzetten bij Instellingen.',

      missingTitle: 'Push-meldingen krijgen',
      missingSubtitle:
        'Deze gateway heeft geen Hermie-plugin, dus daar kan niets een melding sturen. Hij installeert met twee commando’s op de machine waarop `hermes serve` draait.',
      missingHint:
        'Hermie praat nooit met de plugin. Het leest wat je gateway al weet, dus er is geen tweede adres en niets nieuws om bloot te stellen.',
      install: 'OP DE GATEWAY',
      copy: 'Kopiëren',
      copied: 'Gekopieerd',
      guide: 'Handleiding openen',
      fallback:
        'Draait Hermie Web al met --push? Dat blijft werken en je kunt meldingen nu aanzetten. Draai ze niet allebei — dan krijgt dit apparaat elke melding twee keer.'
    },

    done: {
      title: 'Klaar',
      subtitle:
        'Hermie bewaart het gateway-adres op dit apparaat en de credentials in de secret store van het systeem.',
      subtitleCookie:
        'Hermie onthoudt deze gateway in deze browser. De sessie zelf blijft waar de gateway hem neerzette — in een cookie die Hermie niet kan lezen.',
      finish: 'Beginnen met chatten',
      retry: 'Opnieuw proberen',
      saving: 'Opslaan…',
      saveFailed: (message: string) => `De instellingen konden niet worden opgeslagen: ${message}`,
      credentialsNotStored: (reason: string) =>
        `Hermie kon de credentials niet veilig op dit apparaat bewaren: ${reason}`
    }
  },

  bots: {
    empty: 'Deze gateway heeft nog geen bot-profielen. Maak er een met `hermes profile create`.',
    loading: 'De lijst met bots lezen…',
    failed: (message: string) => `De lijst met bots kon niet worden geladen: ${message}`,
    noPreview: 'Nog geen berichten',
    running: 'werkt',
    unread: 'Nieuw',
    needsInput: 'Wacht op jou',
    defaultBot: 'Standaard',
    search: 'Chats zoeken',
    section: 'BERICHTEN',
    conversations: (count: number) => (count === 1 ? '1 gesprek' : `${count} gesprekken`),
    noMatches: (query: string) => `Geen gesprek komt overeen met “${query}”.`,

    messagesHeader: 'IN BERICHTEN',
    messagesSearching: 'Berichten doorzoeken…',
    messagesNone: 'Geen bericht komt overeen.',
    messagesHint: 'Alleen de beste treffer per chat wordt getoond.',
    messageOpen: (bot: string) => `Open de chat van ${bot} bij dit bericht`,

    unreadLabel: (count: number) => (count === 1 ? '1 ongelezen bericht' : `${count} ongelezen berichten`),
    offline: 'Offline — de laatst bewaarde lijst wordt getoond.',
    footnote: 'Je gesprekken blijven bij je gateway.',
    moreActions: 'Meer',
    switchGatewayHint: 'Kies bij welke gateway deze lijst hoort',

    sharePending: (count: number) =>
      count === 1 ? '1 gedeeld item wacht op verzending' : `${count} gedeelde items wachten op verzending`
  },

  share: {
    sheetTitle: 'Naar een chat sturen',
    noBots: 'Deze gateway heeft nog geen bots om naartoe te sturen.',
    noteLabel: 'Notitie',
    notePlaceholder: 'Voeg een notitie toe (optioneel)',
    send: 'Sturen',
    sending: 'Versturen…',
    sentTo: (bot: string) => `Verstuurd naar ${bot}`,
    willSendLater: 'Wordt verstuurd zodra Hermie opengaat',
    maybeSent: (bot: string) =>
      bot
        ? `Dit is misschien al naar ${bot} verstuurd. Stuur het opnieuw, of gooi het weg.`
        : 'Dit is misschien al verstuurd. Stuur het opnieuw, of gooi het weg.',
    sendAgain: 'Opnieuw sturen'
  },

  presence: {
    working: 'Werkt…',
    needsInput: 'Wacht op jou',
    offlineSince: (time: string) => `Offline · laatst gezien ${time}`
  },

  layout: {
    unnamedFolder: 'Naamloze map',
    rename: 'Hernoemen',
    remove: 'Verwijderen',
    removeFolder: (name: string) => `De map ${name || 'zonder naam'} verwijderen`,
    folderName: 'Mapnaam',
    nameFolderHint: 'Typ om deze map te hernoemen.',
    folderEmpty: 'Geen chats in deze map',
    moveUp: 'Omhoog',
    moveDown: 'Omlaag',
    topGroup: 'Geen map',
    moveToFolder: (folder: string) => `Verplaats naar ${folder}`,
    moveToFolderMenu: 'Verplaats naar map',
    openChat: 'Openen',
    markRead: 'Markeren als gelezen',
    dragging: (name: string) => `${name} verplaatsen`,
    pin: 'Vastzetten',
    unpin: 'Losmaken',
    pinnedRow: 'Vastgezet',
    archive: 'Archiveren',
    unarchive: 'Uit archief halen',
    archived: (count: number) => `Gearchiveerd (${count})`,
    archivedPreview: 'Gearchiveerd · telt niet mee in filters en aantallen',
    colour: 'Kleur',
    colourOf: (name: string) => `Kleur voor ${name}`,
    // Indigo, violet, magenta en teal heten in het Nederlands hetzelfde en staan daarom
    // niet in deze lijst; alleen wat wél een eigen woord heeft, is vertaald.
    accents: {
      default: 'Standaard',
      red: 'Rood',
      orange: 'Oranje',
      green: 'Groen',
      graphite: 'Grafiet',
      slate: 'Leigrijs',
      lime: 'Limoen'
    },
    rowActions: (name: string) => `Acties voor ${name}`,
    close: 'Sluiten',

    showSidebar: 'Zijbalk tonen',
    sidebarRail: 'Zijbalk, verborgen',

    newFolder: 'Nieuwe map',
    deleteFolder: 'Map verwijderen',
    folderActions: (name: string) => `Acties voor de map ${name || 'zonder naam'}`,
    folderColour: 'Mapkleur',
    expandFolder: (name: string) => `Toon de chats in ${name || 'deze map'}`,
    collapseFolder: (name: string) => `Verberg de chats in ${name || 'deze map'}`,
    folderUnread: (count: number) => `${count} ongelezen`,
    folderNeedsInput: 'Wacht op jou',
    muteFolder: 'Map dempen',
    unmuteFolder: 'Map niet meer dempen',

    mute: 'Dempen',
    muteFor: {
      '1h': 'Voor 1 uur',
      '8h': 'Voor 8 uur',
      '1w': 'Voor 1 week',
      forever: 'Tot ik het weer aanzet'
    },
    unmute: 'Niet meer dempen',
    muted: 'Gedempt',
    mutedUntil: (when: string) => `Gedempt tot ${when}`,
    muteWeekdays: ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'],
    mutedRow: 'Gedempt'
  },

  // Nederlandse Mac-menu's zetten het werkwoord voorop en schrijven alleen het eerste
  // woord met een hoofdletter — "Verberg zijbalk", niet "Zijbalk Verbergen".
  menuBar: {
    search: 'Zoeken…',
    settings: 'Instellingen…',
    close: 'Sluiten',
    newConversation: 'Nieuw gesprek',
    hideSidebar: 'Verberg zijbalk',
    showSidebar: 'Toon zijbalk'
  },

  signedOut: {
    title: 'Uitgelogd',
    body: (host: string) =>
      `Je sessie op ${host} is verlopen, dus Hermie kan je bots niet bereiken tot je weer inlogt.`,
    bodyNoHost: 'Je sessie is verlopen, dus Hermie kan je bots niet bereiken tot je weer inlogt.',
    signIn: 'Inloggen',
    changeGateway: 'Gateway wijzigen',
    listNote: 'De laatst bewaarde lijst wordt getoond.',
    reason: {
      refreshRejected: 'De gateway wees de bewaarde inlog af, dus de sessie kon niet worden vernieuwd.',
      refreshFailed: 'Het vernieuwen van de sessie is niet afgerond, dus Hermie kon niet ingelogd blijven.',
      noRefreshToken: 'Er was niets bewaard om de sessie mee te vernieuwen.',
      rejectedAfterRefresh: 'De gateway wees de inlog af die Hermie net had vernieuwd.',
      tokenUnreadable: 'Hermie kon de bewaarde inlog niet uit de keychain lezen.'
    },

    stopped: {
      others: 'ANDERE GATEWAYS',
      othersHint: 'Hermie praat met één gateway tegelijk. Deze houdt zijn gesprekken.',
      switchTo: (name: string) => `Verbinden met ${name}`,

      titles: {
        auth: 'Uitgelogd',
        config: 'Deze gateway weigerde de verbinding',
        takenOver: 'Een andere client heeft deze verbinding overgenomen',
        chatOff: 'Chat staat uit op deze gateway',
        tls: 'Het certificaat van deze gateway is afgewezen',
        incompatible: 'Deze gateway is te oud',
        protocol: 'Deze gateway antwoordde op een manier die Hermie niet kan lezen',
        not_hermes: 'Dit adres is geen Hermes-gateway',
        redirect: 'Dit adres leidt ergens anders heen'
      },
      hints: {
        config:
          'Is de gateway verhuisd, verander dan het adres dat hier bewaard is in het adres dat hij als publieke URL publiceert.',
        takenOver: 'Opnieuw controleren pakt de verbinding terug zodra de andere client heeft losgelaten.'
      },
      notSignedIn: 'Niet ingelogd',
      recheck: 'Opnieuw controleren',
      rechecking: 'Controleren…',
      changeGatewayHint:
        'Opent de instelwizard met dit adres ingevuld. Je inlog blijft bewaard tot er een andere gateway wordt toegepast.',
      signOut: 'Uitloggen',
      fixedByServer:
        'Deze pagina wordt geleverd door Hermie Web, en die bepaalt de gateway. Wijzig hem daar waar die server is geconfigureerd.'
    }
  },

  transport: {
    foundOverHttp: 'Gevonden via http://',
    foundOverHttps: 'Gevonden via https://',
    httpLoopback: 'Gewoon http://, en deze verbinding verlaat deze machine nooit.',
    httpLocalNetwork:
      'Gewoon http://, naar een adres op een lokaal netwerk. Het is van buiten dat netwerk niet bereikbaar.',
    httpTailnet:
      'Gewoon http://, over een tailnet-adres. WireGuard heeft het pad tussen dit apparaat en de gateway al versleuteld.',
    httpExposed:
      'Gewoon http:// naar een publiek adres. Iedereen op het pad kan je berichten en je inlog lezen. Gebruik https://, of bereik de gateway via een privénetwerk zoals Tailscale.',
    useHttps: 'Toch https gebruiken'
  },

  gateway: {
    connectionSettings: 'Verbindingsinstellingen',
    noHost: 'Geen gateway'
  },

  activity: {
    title: 'Activiteit',
    subtitle: 'Berichten tussen je bots, en de agents die ze aan het werk zetten.',
    empty:
      'Je bots hebben nog niet met elkaar gepraat. Zodra de een de ander een bericht stuurt of een taak uitbesteedt, verschijnt het hier.',
    emptyOffline: 'Niets te tonen zolang de gateway onbereikbaar is.',
    loading: 'Alle gesprekken lezen…',
    failed: (message: string) => `De tijdlijn kon niet worden geladen: ${message}`,
    today: 'Vandaag',
    yesterday: 'Gisteren',
    counters: {
      working: 'Bots aan het werk',
      deliveries: 'Leveringen'
    },
    spawned: (bot: string, count: number) => `${bot} startte ${count} ${count === 1 ? 'agent' : 'agents'}`,
    groupStatus: {
      dispatched: 'verstuurd',
      running: 'bezig',
      done: 'klaar',
      failed: 'mislukt'
    },
    openChat: (bot: string) => `Open de chat met ${bot}`
  },

  // Chats en Crons staan er niet bij: het eerste woord is in het Nederlands hetzelfde,
  // het tweede is de naam die de gateway er zelf aan geeft.
  tabs: {
    activity: 'Activiteit',
    settings: 'Instellingen'
  },

  chat: {
    send: 'Sturen',
    hydrating: 'Het gesprek laden…',
    connection: {
      connecting: 'Verbinden met je gateway…',
      reconnecting: 'Opnieuw verbinden…',
      retry: 'Nu proberen'
    },
    offlineCopy: 'De laatst bewaarde kopie van dit gesprek wordt getoond.',
    stale: 'Dit gesprek is zijn verbinding met de gateway kwijtgeraakt. Het koppelt weer aan bij het volgende openen.',
    failed: (message: string) => `Dit gesprek kon niet worden geopend: ${message}`,
    settingRefused: (message: string) => `Instelling niet gewijzigd: ${message}`,
    empty: 'Er is nog niets gezegd in deze chat.',
    findMissed: (query: string) => `“${query}” staat in deze chat, verder terug dan wat er geladen is.`,
    findExhausted: (query: string) =>
      `“${query}” is door de gateway gevonden, maar staat niet in de zichtbare tekst van deze chat.`,
    unknownAuthor: 'Iemand anders begon een beurt…',
    thinking: 'Denkt na',
    toolRunning: 'bezig',
    approvalTitle: 'Toestemming gevraagd',
    clarifyTitle: 'De bot heeft een vraag',
    answered: (answer: string) => `Beantwoord: ${answer}`,
    cancelled: 'Ingetrokken',
    subagents: (count: number) => (count === 1 ? '1 subagent bezig' : `${count} subagents bezig`),
    retry: 'Opnieuw proberen',
    pickBot: 'Kies een gesprek om te gaan lezen.',
    subtitle: {
      working: 'Werkt…',
      thinking: 'Denkt na…',
      typing: 'Typt…',
      running: (tool: string) => `Voert ${tool} uit…`,
      waiting: 'Wacht op jou',
      delegating: 'Delegeren…',
      queued: 'In de wachtrij',
      reconnecting: 'Opnieuw verbinden…',
      connecting: 'Verbinden…',
      signedOut: 'Uitgelogd'
    },
    attach: {
      photo: 'Fotobibliotheek',
      file: 'Bestand',
      cancel: 'Annuleren',
      title: 'Een bijlage toevoegen',
      failed: (message: string) => `De bijlage kon niet worden toegevoegd: ${message}`,
      uploadFailed: (message: string) => `Het bestand is niet verstuurd. ${message}`,
      permission:
        'Hermie heeft toegang tot je fotobibliotheek nodig om een afbeelding mee te sturen. Sta dat toe bij Instellingen.',
      openSettings: 'Instellingen openen',
      chipTooLarge: (megabytes: number) => `Te groot · max. ${megabytes} MB`,
      chipNoWorkspace: 'Geen workspace om naartoe te uploaden',
      chipRefused: 'De gateway weigerde het',
      chipFailed: 'Upload mislukt'
    },
    expensiveModel: (message: string) => message || 'Dit model kost meer dan het huidige.'
  },

  auth: {
    noRefreshToken:
      'Deze inlog kan niet worden vernieuwd — hij eindigt zodra zijn access token verloopt. De provider van de gateway heeft de offline_access-scope nodig.',
    noRefreshTokenLink: 'Hoe je dit oplost'
  },

  settings: {
    title: 'Instellingen',

    categories: {
      account: 'Account',
      gateways: 'Gateways',
      gateway: 'Gateway',
      chats: 'Chats en berichten',
      notifications: 'Meldingen',
      memory: 'Geheugen',
      appearance: 'Weergave',
      privacy: 'Privacy en beveiliging',
      voice: 'Spraak',
      capabilities: 'Bots en mogelijkheden',
      advanced: 'Geavanceerd',
      about: 'Over',
      blurb: {
        account: 'Met welk account dit apparaat is ingelogd, en hoe je eruit stapt.',
        gateways: 'De gateway waarmee dit apparaat praat, en de andere die het kent.',
        gateway: 'Welke gateway dit is, en hoe het daarmee gaat.',
        chats: 'Wat een nieuw gesprek laat zien, en hoe een bot wordt aangesproken.',
        notifications: 'Wanneer een bot je mag bereiken, en hoeveel een melding zegt.',
        memory: 'Wat elke bot tussen gesprekken onthoudt.',
        appearance: 'Licht of donker, de taal, de tekstgrootte en het thema.',
        privacy: 'De vergrendeling op dit apparaat, en wat nodig is om hem te openen.',
        voice: 'Hoe Hermie een antwoord voorleest, en hoe hij jou hoort.',
        capabilities: 'De skills, servers en borden waar je bots bij kunnen.',
        advanced: 'De updates van Hermie Web zelf, en het gereedschap om de app te bouwen.',
        about: 'Welke Hermie dit is, en onder welke licenties hij wordt geleverd.'
      },
      summary: {
        signedOut: 'Niet ingelogd',
        gateways: (host: string, count: number) =>
          count === 1 ? `${host} · 1 gateway` : `${host} · ${count} gateways`,
        gateway: (host: string) => host,
        on: 'Aan',
        off: 'Uit',
        notificationKinds: (count: number) => (count === 1 ? 'Aan · 1 soort' : `Aan · ${count} soorten`),
        bots: (count: number) => (count === 1 ? '1 bot' : `${count} bots`),
        capabilities: 'Skills · MCP · Connectors',
        lockBrowser: 'Niet in een browser',
        developer: 'Ontwikkelaar',
        version: (version: string) => `Versie ${version}`
      }
    },
    capabilityReach: 'Waar je bots bij kunnen',

    search: {
      label: 'Zoek in instellingen',
      noMatches: 'Geen instelling komt daarmee overeen.'
    },
    address: 'Adres',
    version: 'Versie',
    user: 'Ingelogd als',
    email: 'E-mail',

    webUpdate: {
      running: 'Draait',
      checking: 'Controleren…',
      upToDate: 'Bijgewerkt',
      available: (version: string) => `${version} beschikbaar`,
      apply: 'Bijwerken',
      updating: 'Downloaden en installeren…',
      restarting: 'Opnieuw starten…',
      failed: (reason: string) => `De update is mislukt: ${reason}`,
      needsSignIn: 'Log in op de gateway voordat je Hermie Web bijwerkt.',
      restartTimedOut: 'Hermie Web kwam niet binnen een minuut terug. Bekijk de logs.'
    },
    pluginInstalled: (version: string) => (version ? `Hermie-plugin ${version}` : 'Hermie-plugin'),
    pluginAbsent: 'Niet geïnstalleerd',
    pluginUnknown: 'Controleren…',

    notifications: {
      header: 'Meldingen',
      enabled: 'Meldingen',
      enabledHint:
        'De Hermie-plugin draait in je gateway en stuurt een melding zodra een bot nieuws heeft. Hermie Web met --push doet hetzelfde van buitenaf, als er geen plugin geïnstalleerd kan worden.',
      denied: 'Meldingen staan uit voor Hermie bij je apparaatinstellingen. Zet ze daar eerst aan.',
      unavailable: 'Dit apparaat kan zich niet registreren voor meldingen. Er is niets verstuurd.',
      webInsecure: 'De browser biedt alleen meldingen aan als Hermie Web via https wordt geleverd.',
      types: 'Vertel me over',
      typeMessage: 'Nieuw bericht',
      typeRequest: 'Wacht op jou',
      typeCronDone: 'Een routine is klaar',
      typeCronFailed: 'Een routine is mislukt',
      typeTurnDone: 'Klaar met werken',
      typeTurnFailed: 'Er ging iets mis',
      typesHint:
        'Een bot die antwoordt, een bot die toestemming vraagt, de levering van een routine, hoe een geplande run afliep, en een lange taak die hoe dan ook aan zijn eind komt. Een beurt die je zelf hebt gestopt hoort daar nooit bij.',
      preview: 'Voorbeeld tonen',
      previewHint:
        'Uit zegt een melding welke bot het is en wat er gebeurde. Aan draagt hij het bericht ook mee — en een vergrendelscherm is waar dat gelezen wordt.',

      status: 'Registratie',
      statusOff: 'Uit. Dit apparaat is niet geregistreerd.',
      statusPending: 'Het platform om een adres vragen…',
      statusRegistered: (tail: string) => `Geregistreerd · …${tail}`,
      statusDenied: 'Toestemming geweigerd. Zet meldingen voor Hermie aan bij je apparaatinstellingen.',
      // "Berichtgeving" is hoe macOS dat paneel zelf in het Nederlands noemt.
      statusSystemSettings: 'Zet meldingen voor Hermie aan bij Systeeminstellingen → Berichtgeving',
      openSystemSettings: 'Berichtgeving-instellingen openen',
      openSystemSettingsHint: 'Hermie blijft hier aan staan en registreert zich zodra macOS het toestaat.',
      statusNoProject:
        'Deze build heeft geen EAS project id, dus er kan geen push token aan worden gegeven. Hij moet opnieuw gebouwd worden.',
      statusFailed: (message: string) => `Tokenaanvraag mislukt: ${message}`,
      statusUnsupported: (detail: string) => `Dit apparaat kan zich niet registreren: ${detail}`,
      retry: 'Opnieuw',
      retryHint: 'Vraagt opnieuw om toestemming en vraagt opnieuw een push token aan.'
    },

    gateways: {
      rowHint: (count: number) => (count === 1 ? 'Eén gateway' : `${count} gateways`),
      hint: 'Tik op een gateway om ermee te verbinden. Hermie praat met één tegelijk; de andere houden hun gesprekken en hun meldingen.',
      active: 'Verbonden',
      signedInAs: (user: string) => `Ingelogd als ${user}`,
      signedOut: 'Uitgelogd',
      use: 'Gebruik deze gateway',
      manage: 'Beheren',
      add: 'Gateway toevoegen',
      addHint:
        'Start de instelwizard voor een andere machine. De gateway waar je nu op zit blijft verbonden tot je overstapt.',

      name: 'Naam',
      nameHint: 'Hoe deze gateway op dit apparaat heet. Het wordt nergens heen gestuurd.',
      save: 'Opslaan',
      connect: 'Verbinden met deze gateway',
      connectHint: 'Hermie verbreekt de verbinding met de gateway waar hij op zit en verbindt met deze.',
      signOut: 'Uitloggen bij deze gateway',
      signOutHint: 'Wist de bewaarde credentials en houdt het adres.',
      remove: 'Deze gateway verwijderen',
      removeHint: 'Vergeet het adres, de credentials, de gesprekken en de instellingen op dit apparaat.',
      removeConfirm: 'Deze gateway en alles wat er op dit apparaat voor bewaard is verwijderen?',
      removeConfirmAction: 'Verwijderen',
      keepIt: 'Behouden',
      removeNotifyNote:
        'Is dit niet de gateway waar Hermie mee verbonden is, dan stoppen zijn meldingen pas de volgende keer dat hij dit apparaat probeert te bereiken, en niet meteen.'
    },

    signOut: 'Uitloggen',
    signOutHint: 'Wist de bewaarde credentials en houdt het gateway-adres.',
    changeGateway: 'Gateway wijzigen',
    changeGatewayHint:
      'Heropent de instelwizard met dit adres ingevuld. Er wordt niets weggegooid tot er een andere gateway wordt toegepast.',
    changeGatewayConfirm: 'Deze gateway en alles wat ervoor bewaard is vergeten?',
    confirm: 'Vergeten',
    keepIt: 'Behouden',
    developer: 'Ontwikkelaar',
    connectionTest: 'Verbindingstest',
    unknown: 'Onbekend',
    defaultVerbosity: 'Standaard detailniveau',
    defaultVerbosityHint:
      'Hoeveel van het denkwerk van een bot een nieuw gesprek toont. Een gesprek met een eigen instelling houdt die.',
    showBotToBot: 'Toon bot-naar-bot',
    showThinking: 'Toon denkwerk',
    appearance: 'Weergave',

    language: 'Taal',
    languageFollowDevice: 'Volg apparaat',
    languageHint:
      'Hermie is in het Engels geschreven. Nederlands en Duits zijn vertalingen daarvan; wat nog niet vertaald is blijft Engels.',

    theme: 'Thema',
    themeOptions: { system: 'Systeem', light: 'Licht', dark: 'Donker' },
    themeHint: 'Systeem volgt het apparaat; Licht en Donker zetten de app hoe dan ook vast.',
    botNames: 'Botnamen',
    botNameOptions: { profile: 'Profielnaam', display: 'Weergavenaam' },
    botNamesHint:
      'Welke naam de grote is. De profielnaam is waarmee de rest van de app een bot aanspreekt; de weergavenaam is het label dat op de gateway is ingesteld. Een bot met maar één daarvan toont één regel. Wordt alleen gebruikt terwijl Profielnaam verbergen, hieronder, uit staat.',
    hideHandle: 'Profielnaam verbergen',
    hideHandleHint:
      'Toon voor een bot met een weergavenaam alleen die naam — de profielnaam waar hij anders mee wordt getoond vervalt op de tweede regel. Een bot zonder weergavenaam behoudt hoe dan ook zijn ene naam.',
    chatTextSize: 'Tekstgrootte chat',
    chatTextSizeHint:
      'Geldt voor de woorden in een gesprek, bovenop de eigen tekstgrootte van het apparaat. De rest van de app volgt het apparaat.',
    preset: 'THEMA',
    presetOptions: { blue: 'Blauw', graphite: 'Grafiet', lime: 'Limoen' },
    presetHint: 'Elk thema heeft een licht en een donker gezicht; de instelling hierboven kiest welke te zien is.',

    themes: {
      title: 'Thema’s',
      editPageTitle: 'Thema bewerken',
      header: 'JOUW THEMA’S',
      back: 'Terug naar instellingen',
      create: 'Nieuw thema',
      createFrom: (preset: string) => `Vanaf ${preset}`,
      untitled: 'Naamloos thema',
      name: 'Naam',
      namePlaceholder: 'Themanaam',
      rename: 'Hernoemen',
      delete: 'Verwijderen',
      deleteConfirm: (name: string) => `“${name || 'Naamloos thema'}” verwijderen?`,
      deleteHint: 'Het thema verdwijnt overal waar op deze gateway is ingelogd.',
      keepIt: 'Behouden',
      empty: 'Nog geen eigen thema’s. Begin er een vanaf een voorinstelling en pas de kleuren aan.',
      editing: (scheme: string) => `Het ${scheme}-gezicht bewerken`,
      editingHint: 'Zet de instelling hierboven om om het andere gezicht te bewerken.',
      background: 'Achtergrond',
      accentBubble: 'Jouw bubbels',
      followPreset: 'Volg de voorinstelling',
      rejected: (reason: string) => `Die kleur wordt niet gebruikt: ${reason}`,
      reasonMalformed: 'een kleur is zes hex-tekens na een #.',
      // De gemeten verhouding komt uit `toFixed(2)` en houdt dus een punt; de drempel
      // ernaast schrijft die punt mee, zodat één zin niet twee decimaaltekens gebruikt.
      reasonBubble: (ratio: string) => `witte tekst erop meet ${ratio} : 1, en heeft 4.5 : 1 nodig.`,
      reasonBackground: (ratio: string) => `de tekst van de app erop meet ${ratio} : 1, en heeft 4.5 : 1 nodig.`,
      reasonAccentFill: (ratio: string) =>
        `hij meet ${ratio} : 1 tegen het oppervlak erachter, en een markering heeft 3 : 1 nodig.`
    },
    about: 'Over',
    licences: 'Licenties',
    licencesHint: 'De open source-pakketten waaruit Hermie is opgebouwd, en wat elk daarvan vraagt.',
    licencesSummary: (count: number) =>
      count === 1
        ? 'Er zit 1 pakket in Hermie.'
        : `Er zitten ${count} pakketten in Hermie. Tik er een aan om de licentie te lezen.`,
    licencesBack: 'Terug naar instellingen',
    licencesLoading: 'De licenties laden…',
    licencesFailed: (message: string) => `De licentielijst kon niet worden geladen: ${message}`,
    licencesRetry: 'Opnieuw proberen',
    licencesUndeclared: 'geen licentie opgegeven',
    licencesNoText: 'Dit pakket levert geen licentiebestand mee. De identifier hierboven is alles wat het opgeeft.',
    licencesScope: (excluded: number) =>
      `Alleen productie-dependencies; ontwikkeltooling en Hermie’s eigen ${excluded} workspace-pakketten staan niet in de lijst.`,
    licencesGeneratedBy: (script: string) => `Gegenereerd door ${script}, samen met THIRD_PARTY_LICENSES.md.`,

    scheme: 'Schema',
    port: 'Poort',

    forgetGateway: 'Deze gateway vergeten',
    forgetGatewayHint: 'Verwijdert het adres en de credentials van dit apparaat en start de instelwizard leeg.',

    privacy: 'PRIVACY & BEVEILIGING',

    lock: {
      label: 'Ontgrendelen vereist',
      options: {
        off: 'Uit',
        immediately: 'Nu'
      },
      hint: 'Vraag om Face ID, Touch ID of de toegangscode van dit apparaat voordat Hermie gelezen kan worden. Deze instelling blijft op dit apparaat.',
      hintOn:
        'Hermie vraagt het opnieuw als hij zo lang weg is geweest, en altijd na een verse start. Deze instelling blijft op dit apparaat.',
      noEnrolment:
        'Stel eerst een toegangscode, Face ID of een vingerafdruk in bij je apparaatinstellingen — anders vergrendelt Hermie zonder dat er een manier is om hem te openen.',
      unavailable: 'Dit apparaat heeft geen ontgrendelmethode die Hermie kan vragen.',
      passcodeOnly: 'Er is geen biometrie ingesteld, dus Hermie vraagt om de toegangscode van dit apparaat.',
      web: 'Hermie kan zichzelf niet vergrendelen in een browser: de pagina en alles wat een vergrendeling afdwingt zijn dezelfde code. Vergrendel het scherm of sluit de tab.',
      refused:
        'Hermie kon niet bevestigen dat jij het was, dus is er niets gewijzigd. Kies de optie opnieuw om het nog eens te proberen.'
    }
  },

  connection: {
    status: {
      disconnected: 'Niet verbonden',
      probing: 'De gateway controleren…',
      authenticating: 'Authenticeren…',
      connecting: 'Verbinden…',
      ready: 'Verbonden',
      reconnecting: 'Opnieuw verbinden…',
      paused: 'Gepauzeerd',
      needs_signin: 'Uitgelogd',
      incompatible: 'Niet ondersteund'
    },
    reauth: {
      message: 'Je sessie op deze gateway is verlopen.',
      action: 'Inloggen',
      tokenAction: 'Token bijwerken',
      saving: 'Inloggen…'
    }
  },

  errors: {
    network: (host: string) =>
      `${host} kon niet worden bereikt. Controleer het adres, en of de gateway draait en vanaf dit apparaat bereikbaar is.`,
    networkOverHttps: (host: string) =>
      `${host} kon niet via https:// worden bereikt. Hij antwoordt daar niet, of hij levert een certificaat dat dit apparaat niet vertrouwt. Laat de https:// weg en Hermie probeert ook http://.`,
    tls: (host: string) =>
      `De beveiligde verbinding met ${host} is mislukt. Een zelfondertekend certificaat moet eerst door dit apparaat vertrouwd worden — of, als de gateway daar gewoon http levert, laat de https:// weg en laat Hermie hem vinden.`,
    timeout: (host: string) =>
      `${host} antwoordde niet op tijd. Hij start misschien nog op of zit achter een trage lijn.`,
    notHermes: (host: string) =>
      `${host} antwoordde, maar niet als een Hermes-gateway. Controleer het adres en een eventueel pad-voorvoegsel.`,
    landingPage: 'Dit lijkt een webpagina, geen gateway.',
    privateNetworkOnly: 'Dit adres antwoordt alleen op een privénetwerk — zit dit apparaat op de VPN of het tailnet?',
    redirected: (from: string, to: string) =>
      `${from} verwees door naar ${to}, en dat is een andere host. Er is niets van gelezen.`,
    useRedirectTarget: (host: string) => `Gebruik ${host} in plaats daarvan`,
    openFrontDoor: 'Voeg de credentials van de proxy toe',
    authProxy: (status: number) =>
      `Een access proxy antwoordde met HTTP ${status} vóór de gateway. Voeg zijn headers toe onder Geavanceerd, of sluit /api/status, /auth/* en /login ervan uit.`,
    server: (status: number) =>
      `De gateway antwoordde met HTTP ${status}. Hij draait maar is niet gezond; bekijk zijn logs.`,
    providersUnavailable:
      'De gateway vereist een inlog maar meldt geen identity providers. Stel er een in op de gateway en probeer het opnieuw.',
    signedOut: 'De gateway wees de credentials af. Log opnieuw in.',
    closeAuth: 'De gateway wees de credentials af toen de WebSocket openging. Log opnieuw in.',
    closeHost:
      'De gateway vertrouwt dit adres niet. Zet zijn `dashboard.public_url` op het adres dat je hebt ingevuld en start hem opnieuw.',
    closeTakenOver: 'Een andere client heeft deze verbinding overgenomen. Sluit die client en test opnieuw.',
    closeChatOff: 'Chat staat uit op deze gateway.',
    closeAbnormal:
      'De WebSocket ging dicht zonder reden. Een proxy vóór de gateway moet meestal worden ingesteld om WebSocket-upgrades door te laten.',
    incompatible: 'Deze gateway is te oud voor Hermie. Werk Hermes op de gateway bij.',
    unknown: 'Er ging iets mis.'
  },

  botProfile: {
    menuItem: 'Profiel bewerken',
    open: (name: string) => `Het profiel van ${name} bewerken`,
    title: 'Profiel',

    photo: 'FOTO',
    photoHint: 'Te zien in de chatlijst, in de koptekst en bij elk bericht dat deze bot stuurt.',
    photoChange: 'Kies een foto',
    photoReplace: 'Foto wijzigen',
    photoRemove: 'Foto verwijderen',

    description: 'BESCHRIJVING',
    descriptionPlaceholder: 'Waar deze bot voor is',
    colour: 'KLEUR',
    colourHint: 'Alleen deze chat. Het kleurt de bubbels, de ring om de avatar en de rij in de lijst.',

    about: 'OVER DEZE BOT',
    session: 'Sessie',

    save: 'Opslaan',
    saving: 'Opslaan…',
    saveFailed: 'De gateway wilde dat niet opslaan.',
    photoFailed: 'Die foto kon niet worden geüpload.'
  }
}
