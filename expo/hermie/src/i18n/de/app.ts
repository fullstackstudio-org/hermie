/**
 * `i18n/strings.ts` in German.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { Translation } from '../catalogue'
import type { strings } from '../strings'

/**
 * The sentence join the English table builds with its own `list` helper.
 * Rebuilt here rather than imported because the conjunction is the part that
 * changes: `or` is `oder`.
 */
const orList = (items: string[]): string => {
  if (items.length <= 1) {
    return items[0] ?? ''
  }

  return `${items.slice(0, -1).join(', ')} oder ${items[items.length - 1]}`
}

export const app: Translation<typeof strings> = {
  app: {
    loading: 'Startet…'
  },

  common: {
    back: 'Zurück',
    cancel: 'Abbrechen',
    continue: 'Weiter',
    retry: 'Erneut versuchen',
    signIn: 'Anmelden',
    done: 'Fertig',
    add: 'Hinzufügen',
    remove: 'Entfernen',
    openInBrowser: 'Stattdessen im Browser öffnen',
    search: 'Suchen',
    noMatches: 'Dazu passt nichts.',
    nothingToPick: 'Es gibt nichts zur Auswahl.',
    dismiss: 'Schließen'
  },

  lock: {
    prompt: 'Hermie entsperren',
    plateBody: 'Hermie ist gesperrt.',
    unlock: 'Entsperren',
    stranded:
      'Hermie ist gesperrt, und auf diesem Gerät ist weder ein Code noch eine biometrische Entsperrung eingerichtet. Richte eines davon in den Geräteeinstellungen ein.'
  },

  onboarding: {
    stepCounter: (current: number, total: number) => `Schritt ${current} von ${total}`,

    welcome: {
      title: 'Willkommen bei Hermie',
      body: 'Hermie ist ein Client für Hermes Agent. Es spricht immer nur mit einem Gateway — der Maschine, auf der `hermes serve` läuft — und chattet mit den Bots, die dort leben.',
      note: 'Es wird nichts gespeichert, bevor die Verbindung getestet wurde.',
      action: 'Ein Gateway einrichten'
    },

    address: {
      title: 'Gateway-Adresse',
      subtitle: 'Die Adresse, die du im Browser öffnen würdest, um das Gateway-Dashboard zu erreichen.',
      label: 'ADRESSE',
      hint: 'Lässt du das Schema weg, versucht Hermie erst https://, dann http://. Tippe selbst ein Schema, um es festzulegen.',
      advanced: 'Erweitert',
      advancedHint:
        'Zusätzliche Request-Header werden mit jedem Aufruf und mit der Anmeldeseite gesendet. Ein Reverse-Proxy, der ein gemeinsames Geheimnis erwartet, braucht es hier.',

      frontDoor: {
        label: 'VOR DEM GATEWAY',
        custom: 'Eigene Header',
        hint: 'Wähle, wie der Proxy vor deinem Gateway Hermie durchlässt. Nichts davon wird irgendwohin gesendet außer an die Adresse des Gateways selbst.',
        cloudflareHint:
          'Ein Service-Token aus deiner Access-Anwendung. Hermie sendet es mit jedem Request, mit dem WebSocket und mit der Anmeldeseite. Nimm /auth/* und /login von der Access-Policy aus: Ein Service-Token kann eine weiterleitungsbasierte Anmeldung nicht durch die Edge tragen.',
        insecure:
          'Dieses Gateway wird über http:// erreicht, deshalb wird das Service-Token nicht gesendet — es ist ein langlebiges Credential für deinen gesamten Access-Tenant. Nutze https:// für die Adresse, die die Access-Anwendung abdeckt.'
      },

      headerValue: 'Wert',
      addHeader: 'Header hinzufügen',
      showValue: 'Wert anzeigen',
      hideValue: 'Wert verbergen',
      removeHeader: (name: string) => (name ? `Header ${name} entfernen` : 'Leeren Header entfernen'),
      probing: 'Prüfe…',
      probingScheme: (scheme: string) => `Prüfe ${scheme}…`,
      probingBoth: 'Prüfe https://, dann http://…',
      signInRequired: (version: string, providers: string[]) =>
        `Hermes ${version || 'Gateway'} · Anmeldung erforderlich über ${orList(providers)}`,
      signInRequiredNoProviders: (version: string) =>
        `Hermes ${version || 'Gateway'} · Anmeldung erforderlich, aber dieses Gateway listet keine Identity Provider auf. Richte einen auf dem Gateway ein.`,
      sessionTokenRequired: (version: string) => `Hermes ${version || 'Gateway'} · Session-Token erforderlich`
    },

    signIn: {
      title: 'Anmelden',
      subtitleNative:
        'Das Gateway hostet die Anmeldeseite. Hermie öffnet sie, liest das Ergebnis und behält die Token auf diesem Gerät.',
      subtitleToken:
        'Dieses Gateway steht nicht hinter einem Identity Provider; es authentifiziert sich mit dem Session-Token, das es beim Start ausgibt.',
      subtitleCookie:
        'Das Gateway hostet die Anmeldeseite. Dein Browser behält die Session, die sie zurückgibt; Hermie bekommt sie nie zu sehen.',
      signInWith: (provider: string) => `Mit ${provider} anmelden`,
      signedInAs: (user: string) => `Angemeldet als ${user}`,
      signedIn: 'Angemeldet',
      signOutAndRetry: 'Erneut anmelden',
      blockedTitle: 'Dieses Gateway ist zu alt für die native Anmeldung',
      blockedBody:
        'Es verlangt eine Anmeldung, kündigt aber den native_pkce-Flow nicht an, und nur den kann eine mobile App abschließen. Aktualisiere Hermes auf dem Gateway.',
      tokenLabel: 'SESSION-TOKEN',
      tokenHelp: 'Füge das Session-Token ein, das `hermes serve` ausgibt.',
      tokenPlaceholder: 'Session-Token',
      showToken: 'Token anzeigen',
      hideToken: 'Token verbergen',

      servedFrom: (host: string) => `Ausgeliefert von Hermie Web, verbunden mit ${host}.`,
      servedFromUnknown: 'Ausgeliefert von Hermie Web.',
      probingGateway: 'Lese das Gateway…',
      checkingSession: 'Prüfe, ob du schon angemeldet bist…',
      leavingForProvider: 'Bringe dich zur Anmeldeseite…',
      passwordUser: 'BENUTZERNAME',
      passwordSecret: 'PASSWORT',
      passwordUserLabel: 'Benutzername',
      passwordSecretLabel: 'Passwort',
      passwordSubmit: 'Anmelden',
      showPassword: 'Passwort anzeigen',
      hidePassword: 'Passwort verbergen',
      cookieBlockedTitle: 'Dieses Gateway ist zu alt für die Anmeldung im Browser',
      cookieBlockedBody:
        'Es verlangt eine Anmeldung, kündigt aber den Cookie-Flow nicht an, und nur den kann ein Browser-Tab abschließen. Aktualisiere Hermes auf dem Gateway.',
      tokenBlockedTitle: 'Dieses Gateway lässt sich aus einem Browser nicht nutzen',
      tokenBlockedBody:
        'Es authentifiziert sich mit einem Session-Token, und ein Browser-Tab hat keinen sicheren Ort dafür — alles, was auf der Seite läuft, könnte es lesen. Nutze die Hermie-App, oder stelle das Gateway hinter einen Identity Provider, damit es eine Browser-Session ausstellen kann.',
      ssoOff:
        'Die Anmeldung per SSO ist auf diesem Hermie Web ausgeschaltet. Bitte denjenigen, der es betreibt, dich auf einem anderen Weg anzumelden.',
      signOutOfSession: 'Abmelden',

      webview: {
        title: 'Anmelden',
        loading: 'Öffne die Anmeldeseite…',
        exchanging: 'Schließe die Anmeldung ab…',
        timeout: 'Die Anmeldeseite war zehn Minuten offen, ohne fertig zu werden. Fang neu an, wenn du so weit bist.',
        cancelled: 'Die Anmeldung wurde abgebrochen.',
        unavailable:
          'Der In-App-Browser steht auf dieser Plattform nicht zur Verfügung. Öffne die Anmeldeseite in deinem Browser und füge dann die Adresse, an der er scheitert, hier wieder ein.',
        chosen:
          'Öffne die Anmeldeseite in deinem Browser und füge dann die Adresse, an der er scheitert, hier wieder ein. Du kannst zurückgehen und stattdessen die In-App-Seite nutzen.',
        headersWithheld:
          'Dieses Gateway braucht zusätzliche Header, und Androids In-App-Browser würde sie an deinen Identity Provider weiterreichen. Melde dich stattdessen in deinem Browser an und füge dann die Adresse, an der er scheitert, hier wieder ein.',
        fallbackLabel: 'Gescheiterte Adresse',
        fallbackHelp:
          'Der Browser wird eine 127.0.0.1-Adresse nicht laden können — das ist so gewollt. Kopiere sie aus der Adressleiste und füge sie hier ein.',
        fallbackSubmit: 'Diese Adresse verwenden',
        stateMismatch:
          'Die Antwort der Anmeldung gehörte nicht zu diesem Versuch und wurde verworfen. Starte die Anmeldung neu.',
        noCode: 'Die Anmeldung endete ohne Authorization Code. Starte die Anmeldung neu.',
        providerError: (error: string, description: string) =>
          description
            ? `Das Gateway hat die Anmeldung abgelehnt: ${description} (${error})`
            : `Das Gateway hat die Anmeldung abgelehnt: ${error}`,
        httpError: (status: number) =>
          `Die Anmeldeseite hat mit HTTP ${status} geantwortet. Prüfe die öffentliche Adresse des Gateways.`,
        loadError: (message: string) => `Die Anmeldeseite konnte nicht geladen werden: ${message}`
      }
    },

    test: {
      title: 'Verbindung testen',
      subtitle: 'Hermie prüft die REST-Schnittstelle und öffnet dann den WebSocket, genau wie später im Betrieb.',
      running: 'Teste…',
      retry: 'Erneut versuchen',
      required: 'Die Verbindung wurde noch nicht getestet.',
      invalidated: 'Seit dem letzten Test hat sich etwas geändert, deshalb läuft er noch einmal.',
      connectedAs: (user: string, bots: number) => `Verbunden als ${user} · ${bots === 1 ? '1 Bot' : `${bots} Bots`}`,
      connected: (bots: number) => `Verbunden · ${bots === 1 ? '1 Bot' : `${bots} Bots`}`,
      noBots: 'Die Verbindung funktioniert, aber dieses Gateway hat noch keine Bot-Profile.',

      checklist: {
        profiles: 'Profile'
      }
    },

    notifications: {
      title: 'Benachrichtigungen',
      subtitle:
        'Dein Gateway kann diesem Gerät melden, wenn ein Bot antwortet, um etwas bittet oder eine lange Aufgabe beendet.',
      enable: 'Benachrichtigungen einschalten',
      enabling: 'Frage nach…',
      enabled: 'Benachrichtigungen sind für dieses Gerät eingeschaltet.',
      denied: 'Die Berechtigung wurde verweigert. Du kannst sie später in den Geräteeinstellungen einschalten.',
      skip: 'Du kannst das später in den Einstellungen einschalten.',

      missingTitle: 'Push-Benachrichtigungen bekommen',
      missingSubtitle:
        'Auf diesem Gateway gibt es kein Hermie-Plugin, also kann dort nichts eine Benachrichtigung senden. Es lässt sich mit zwei Befehlen auf der Maschine installieren, auf der `hermes serve` läuft.',
      missingHint:
        'Hermie spricht nie mit dem Plugin. Es liest, was dein Gateway ohnehin weiß, also gibt es keine zweite Adresse und nichts Neues, das nach außen muss.',
      install: 'AUF DEM GATEWAY',
      copy: 'Kopieren',
      copied: 'Kopiert',
      guide: 'Anleitung öffnen',
      fallback:
        'Läuft Hermie Web bei dir schon mit --push? Das funktioniert weiter, und du kannst Benachrichtigungen jetzt einschalten. Betreibe nicht beides — dieses Gerät bekäme sonst alles doppelt gemeldet.'
    },

    done: {
      title: 'Fertig',
      subtitle:
        'Hermie speichert die Gateway-Adresse auf diesem Gerät und die Zugangsdaten im Schlüsselspeicher des Systems.',
      subtitleCookie:
        'Hermie merkt sich dieses Gateway in diesem Browser. Die Session selbst bleibt, wo das Gateway sie abgelegt hat — in einem Cookie, den Hermie nicht lesen kann.',
      finish: 'Jetzt chatten',
      retry: 'Erneut versuchen',
      saving: 'Speichere…',
      saveFailed: (message: string) => `Die Einstellungen konnten nicht gespeichert werden: ${message}`,
      credentialsNotStored: (reason: string) =>
        `Hermie konnte die Zugangsdaten auf diesem Gerät nicht sicher speichern: ${reason}`
    }
  },

  bots: {
    empty: 'Dieses Gateway hat noch keine Bot-Profile. Lege eines mit `hermes profile create` an.',
    loading: 'Lese die Liste…',
    failed: (message: string) => `Die Bot-Liste konnte nicht geladen werden: ${message}`,
    noPreview: 'Noch keine Nachrichten',
    running: 'arbeitet',
    unread: 'Neu',
    needsInput: 'Braucht deine Eingabe',
    defaultBot: 'Standard',
    search: 'Chats durchsuchen',
    section: 'NACHRICHTEN',
    conversations: (count: number) => (count === 1 ? '1 Unterhaltung' : `${count} Unterhaltungen`),
    noMatches: (query: string) => `Keine Unterhaltung passt zu „${query}“.`,

    messagesHeader: 'IN NACHRICHTEN',
    messagesSearching: 'Durchsuche Nachrichten…',
    messagesNone: 'Keine Nachricht passt.',
    messagesHint: 'Nur der beste Treffer pro Chat wird gezeigt.',
    messageOpen: (bot: string) => `${bot}s Chat bei dieser Nachricht öffnen`,

    unreadLabel: (count: number) => (count === 1 ? '1 ungelesene Nachricht' : `${count} ungelesene Nachrichten`),
    offline: 'Offline — zeigt die zuletzt gespeicherte Liste.',
    footnote: 'Deine Unterhaltungen bleiben bei deinem Gateway.',
    moreActions: 'Mehr',
    switchGatewayHint: 'Wähle, zu welchem Gateway diese Liste gehört',

    sharePending: (count: number) =>
      count === 1 ? '1 geteilter Inhalt wartet auf den Versand' : `${count} geteilte Inhalte warten auf den Versand`
  },

  share: {
    sheetTitle: 'An einen Chat senden',
    noBots: 'Dieses Gateway hat noch keine Bots, an die sich etwas senden ließe.',
    noteLabel: 'Notiz',
    notePlaceholder: 'Notiz hinzufügen (optional)',
    send: 'Senden',
    sending: 'Wird gesendet…',
    sentTo: (bot: string) => `An ${bot} gesendet`,
    willSendLater: 'Wird gesendet, sobald Hermie geöffnet wird',
    maybeSent: (bot: string) =>
      bot
        ? `Das wurde möglicherweise schon an ${bot} gesendet. Noch einmal senden oder verwerfen?`
        : 'Das wurde möglicherweise schon gesendet. Noch einmal senden oder verwerfen?',
    sendAgain: 'Noch einmal senden'
  },

  presence: {
    working: 'Arbeitet…',
    needsInput: 'Braucht Eingabe',
    offlineSince: (time: string) => `Offline · zuletzt gesehen ${time}`
  },

  layout: {
    unnamedFolder: 'Ordner ohne Namen',
    rename: 'Umbenennen',
    remove: 'Entfernen',
    removeFolder: (name: string) => (name ? `Ordner ${name} löschen` : 'Ordner ohne Namen löschen'),
    folderName: 'Ordnername',
    nameFolderHint: 'Tippe, um diesen Ordner umzubenennen.',
    folderEmpty: 'Keine Chats in diesem Ordner',
    moveUp: 'Nach oben',
    moveDown: 'Nach unten',
    topGroup: 'Kein Ordner',
    moveToFolder: (folder: string) => `Nach ${folder} verschieben`,
    moveToFolderMenu: 'In Ordner verschieben',
    openChat: 'Öffnen',
    markRead: 'Als gelesen markieren',
    dragging: (name: string) => `Verschiebe ${name}`,
    pin: 'Anheften',
    unpin: 'Lösen',
    pinnedRow: 'Angeheftet',
    archive: 'Archivieren',
    unarchive: 'Aus dem Archiv holen',
    archived: (count: number) => `Archiviert (${count})`,
    archivedPreview: 'Archiviert · aus Filtern und Zählungen ausgenommen',
    colour: 'Farbe',
    colourOf: (name: string) => `Farbe für ${name}`,
    accents: {
      default: 'Standard',
      violet: 'Violett',
      red: 'Rot',
      teal: 'Türkis',
      green: 'Grün',
      graphite: 'Graphit',
      slate: 'Schiefer',
      lime: 'Limette'
    },
    rowActions: (name: string) => `Aktionen für ${name}`,
    close: 'Schließen',

    showSidebar: 'Seitenleiste zeigen',
    sidebarRail: 'Seitenleiste, ausgeblendet',

    newFolder: 'Neuer Ordner',
    deleteFolder: 'Ordner löschen',
    folderActions: (name: string) => (name ? `Aktionen für den Ordner ${name}` : 'Aktionen für den Ordner ohne Namen'),
    folderColour: 'Ordnerfarbe',
    expandFolder: (name: string) => `Die Chats in ${name || 'diesem Ordner'} zeigen`,
    collapseFolder: (name: string) => `Die Chats in ${name || 'diesem Ordner'} ausblenden`,
    folderUnread: (count: number) => `${count} ungelesen`,
    folderNeedsInput: 'Wartet auf dich',
    muteFolder: 'Ordner stummschalten',
    unmuteFolder: 'Stummschaltung des Ordners aufheben',

    mute: 'Stummschalten',
    muteFor: {
      '1h': 'Für 1 Stunde',
      '8h': 'Für 8 Stunden',
      '1w': 'Für 1 Woche',
      forever: 'Bis ich sie wieder einschalte'
    },
    unmute: 'Stummschaltung aufheben',
    muted: 'Stummgeschaltet',
    mutedUntil: (when: string) => `Stumm bis ${when}`,
    muteWeekdays: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
    mutedRow: 'Stummgeschaltet'
  },

  menuBar: {
    search: 'Suchen…',
    settings: 'Einstellungen…',
    close: 'Schließen',
    newConversation: 'Neue Unterhaltung',
    hideSidebar: 'Seitenleiste ausblenden',
    showSidebar: 'Seitenleiste einblenden'
  },

  signedOut: {
    title: 'Abgemeldet',
    body: (host: string) =>
      `Deine Session auf ${host} ist abgelaufen, deshalb kann Hermie deine Bots nicht erreichen, bis du dich anmeldest.`,
    bodyNoHost: 'Deine Session ist abgelaufen, deshalb kann Hermie deine Bots nicht erreichen, bis du dich anmeldest.',
    signIn: 'Anmelden',
    changeGateway: 'Gateway wechseln',
    listNote: 'Zeigt die zuletzt gespeicherte Liste.',

    reason: {
      refreshRejected:
        'Das Gateway hat die gespeicherte Anmeldung abgelehnt, deshalb konnte die Session nicht erneuert werden.',
      refreshFailed:
        'Das Erneuern der Session wurde nicht abgeschlossen, deshalb konnte Hermie nicht angemeldet bleiben.',
      noRefreshToken: 'Es war nichts gespeichert, womit sich die Session hätte erneuern lassen.',
      rejectedAfterRefresh: 'Das Gateway hat die Anmeldung abgelehnt, die Hermie gerade erneuert hatte.',
      tokenUnreadable: 'Hermie konnte die gespeicherte Anmeldung nicht aus dem Schlüsselbund lesen.'
    },

    stopped: {
      others: 'ANDERE GATEWAYS',
      othersHint: 'Hermie spricht immer nur mit einem Gateway. Dieses behält seine Unterhaltungen.',
      switchTo: (name: string) => `Mit ${name} verbinden`,

      titles: {
        auth: 'Abgemeldet',
        config: 'Dieses Gateway hat die Verbindung abgelehnt',
        takenOver: 'Ein anderer Client hat diese Verbindung übernommen',
        chatOff: 'Chat ist auf diesem Gateway abgeschaltet',
        tls: 'Das Zertifikat dieses Gateways wurde abgelehnt',
        incompatible: 'Dieses Gateway ist zu alt',
        protocol: 'Dieses Gateway hat so geantwortet, dass Hermie es nicht lesen kann',
        not_hermes: 'Diese Adresse ist kein Hermes-Gateway',
        redirect: 'Diese Adresse führt woandershin'
      },
      hints: {
        config:
          'Wenn das Gateway umgezogen ist, ändere die hier gespeicherte Adresse auf die, die es als seine öffentliche URL angibt.',
        takenOver: 'Erneut prüfen holt die Verbindung zurück, sobald der andere Client losgelassen hat.'
      },
      notSignedIn: 'Nicht angemeldet',
      recheck: 'Erneut prüfen',
      rechecking: 'Prüfe…',
      changeGatewayHint:
        'Öffnet die Einrichtung mit dieser Adresse ausgefüllt. Deine Anmeldung bleibt erhalten, bis ein anderes Gateway übernommen wird.',
      signOut: 'Abmelden',
      fixedByServer:
        'Diese Seite wird von Hermie Web ausgeliefert, und das bestimmt das Gateway. Ändere es dort, wo dieser Server konfiguriert ist.'
    }
  },

  transport: {
    foundOverHttp: 'Über http:// gefunden',
    foundOverHttps: 'Über https:// gefunden',
    httpLoopback: 'Einfaches http://, und diese Verbindung verlässt diese Maschine nie.',
    httpLocalNetwork:
      'Einfaches http://, an eine Adresse im lokalen Netz. Von außerhalb dieses Netzes ist sie nicht erreichbar.',
    httpTailnet:
      'Einfaches http://, über eine Tailnet-Adresse. WireGuard hat den Weg zwischen diesem Gerät und dem Gateway bereits verschlüsselt.',
    httpExposed:
      'Einfaches http:// an eine öffentliche Adresse. Jeder auf dem Weg kann deine Nachrichten und deine Anmeldung mitlesen. Nutze https://, oder erreiche das Gateway über ein privates Netz wie Tailscale.',
    useHttps: 'Stattdessen https verwenden'
  },

  gateway: {
    connectionSettings: 'Verbindungseinstellungen',
    noHost: 'Kein Gateway'
  },

  activity: {
    title: 'Aktivität',
    subtitle: 'Nachrichten zwischen deinen Bots und den Agents, die sie an die Arbeit setzen.',
    empty:
      'Deine Bots haben noch nicht miteinander gesprochen. Sobald einer einem anderen schreibt oder eine Aufgabe abgibt, taucht das hier auf.',
    emptyOffline: 'Nichts zu zeigen, solange das Gateway nicht erreichbar ist.',
    loading: 'Lese alle Unterhaltungen…',
    failed: (message: string) => `Die Timeline konnte nicht geladen werden: ${message}`,
    today: 'Heute',
    yesterday: 'Gestern',
    counters: {
      // Counter tiles are a word wide. `Arbeitende Bots` and `Ausgehende
      // Zustellungen` are the literal renderings and both wrap; these say the
      // same thing in the space the tile has.
      working: 'Aktive Bots',
      subagents: 'Sub-Agents',
      deliveries: 'Zustellungen'
    },
    spawned: (bot: string, count: number) => `${bot} hat ${count} ${count === 1 ? 'Agent' : 'Agents'} gestartet`,
    groupStatus: {
      dispatched: 'abgeschickt',
      running: 'läuft',
      done: 'fertig',
      failed: 'fehlgeschlagen'
    },
    openChat: (bot: string) => `Den Chat mit ${bot} öffnen`
  },

  tabs: {
    activity: 'Aktivität',
    // One character over `Settings`, and the word every German-language phone
    // already labels this tab with. Anything shorter would be an abbreviation
    // no other app uses.
    settings: 'Einstellungen'
  },

  chat: {
    send: 'Senden',
    stop: 'Stopp',
    hydrating: 'Lade die Unterhaltung…',

    connection: {
      connecting: 'Verbinde mit deinem Gateway…',
      reconnecting: 'Verbinde neu…',
      retry: 'Jetzt versuchen'
    },
    offlineCopy: 'Zeigt die zuletzt gespeicherte Kopie dieser Unterhaltung.',
    stale: 'Diese Unterhaltung hat die Verbindung zum Gateway verloren. Sie hängt sich beim nächsten Öffnen wieder an.',
    failed: (message: string) => `Diese Unterhaltung konnte nicht geöffnet werden: ${message}`,
    settingRefused: (message: string) => `Einstellung nicht geändert: ${message}`,
    empty: 'In diesem Chat wurde noch nichts gesagt.',
    findMissed: (query: string) => `„${query}“ steht in diesem Chat, weiter zurück als bisher geladen ist.`,
    findExhausted: (query: string) =>
      `„${query}“ wurde vom Gateway gefunden, steht aber nicht im sichtbaren Text dieses Chats.`,
    unknownAuthor: 'Jemand anderes hat einen Zug begonnen…',
    thinking: 'Denkt nach',
    toolRunning: 'läuft',
    approvalTitle: 'Freigabe angefragt',
    clarifyTitle: 'Der Bot hat eine Frage',
    answered: (answer: string) => `Beantwortet: ${answer}`,
    cancelled: 'Zurückgezogen',
    subagents: (count: number) => (count === 1 ? '1 Subagent läuft' : `${count} Subagents laufen`),
    retry: 'Erneut versuchen',
    pickBot: 'Wähle eine Unterhaltung, um zu lesen.',

    subtitle: {
      working: 'Arbeitet…',
      thinking: 'Denkt nach…',
      typing: 'Schreibt…',
      running: (tool: string) => `Führt ${tool} aus…`,
      waiting: 'Wartet auf dich',
      delegating: 'Delegiert…',
      queued: 'In der Warteschlange',
      reconnecting: 'Verbinde neu…',
      connecting: 'Verbinde…',
      signedOut: 'Abgemeldet'
    },
    attach: {
      photo: 'Fotomediathek',
      file: 'Datei',
      cancel: 'Abbrechen',
      title: 'Anhang hinzufügen',
      failed: (message: string) => `Der Anhang konnte nicht hinzugefügt werden: ${message}`,
      uploadFailed: (message: string) => `Die Datei wurde nicht gesendet. ${message}`,
      permission:
        'Hermie braucht Zugriff auf deine Fotomediathek, um ein Bild anzuhängen. Erlaube es in den Einstellungen.',
      openSettings: 'Einstellungen öffnen',
      chipTooLarge: (megabytes: number) => `Zu groß · max. ${megabytes} MB`,
      chipNoWorkspace: 'Kein Workspace zum Hochladen',
      chipRefused: 'Das Gateway hat abgelehnt',
      chipFailed: 'Upload fehlgeschlagen'
    },
    expensiveModel: (message: string) => message || 'Dieses Modell kostet mehr als das aktuelle.'
  },

  auth: {
    noRefreshToken:
      'Diese Anmeldung lässt sich nicht erneuern — sie endet, wenn ihr Access Token abläuft. Der Provider des Gateways braucht den Scope offline_access.',
    noRefreshTokenLink: 'Wie sich das beheben lässt'
  },

  settings: {
    title: 'Einstellungen',

    categories: {
      account: 'Konto',
      gateways: 'Gateways',
      gateway: 'Gateway',
      chats: 'Chats und Nachrichten',
      notifications: 'Mitteilungen',
      memory: 'Gedächtnis',
      appearance: 'Darstellung',
      privacy: 'Datenschutz und Sicherheit',
      voice: 'Sprache und Stimme',
      capabilities: 'Bots und Fähigkeiten',
      advanced: 'Erweitert',
      about: 'Über',
      blurb: {
        account: 'Mit welchem Konto dieses Gerät angemeldet ist, und wie du es verlässt.',
        gateways: 'Das Gateway, mit dem dieses Gerät spricht, und die anderen, die es kennt.',
        gateway: 'Welches Gateway das ist, und wie es darum steht.',
        chats: 'Was ein neues Gespräch zeigt, und wie ein Bot angesprochen wird.',
        notifications: 'Wann ein Bot dich erreichen darf, und wie viel eine Mitteilung sagt.',
        memory: 'Was sich jeder Bot zwischen Gesprächen merkt.',
        appearance: 'Hell oder dunkel, die Sprache, die Textgröße und das Thema.',
        privacy: 'Die Sperre auf diesem Gerät, und was nötig ist, um sie zu öffnen.',
        voice: 'Wie Hermie eine Antwort vorliest, und wie es dich hört.',
        capabilities: 'Die Skills, Server und Boards, die deine Bots erreichen können.',
        advanced: 'Die Updates von Hermie Web selbst, und das Werkzeug zum Bauen der App.',
        about: 'Welches Hermie das ist, und unter welchen Lizenzen es ausgeliefert wird.'
      },
      summary: {
        signedOut: 'Nicht angemeldet',
        gateways: (host: string, count: number) =>
          count === 1 ? `${host} · 1 Gateway` : `${host} · ${count} Gateways`,
        gateway: (host: string) => host,
        on: 'An',
        off: 'Aus',
        notificationKinds: (count: number) => (count === 1 ? 'An · 1 Art' : `An · ${count} Arten`),
        bots: (count: number) => (count === 1 ? '1 Bot' : `${count} Bots`),
        capabilities: 'Skills · MCP · Connectors',
        lockBrowser: 'Nicht im Browser',
        developer: 'Entwickler',
        version: (version: string) => `Version ${version}`
      }
    },
    capabilityReach: 'Was deine Bots erreichen können',

    search: {
      label: 'Einstellungen durchsuchen',
      noMatches: 'Keine Einstellung passt dazu.'
    },
    address: 'Adresse',
    viaHermieWeb: 'über Hermie Web',
    user: 'Angemeldet als',
    email: 'E-Mail',
    authModeToken: 'Session-Token',

    webUpdate: {
      running: 'Läuft',
      checking: 'Prüfe…',
      upToDate: 'Aktuell',
      available: (version: string) => `${version} verfügbar`,
      updating: 'Lade herunter und installiere…',
      restarting: 'Starte neu…',
      failed: (reason: string) => `Das Update ist fehlgeschlagen: ${reason}`,
      needsSignIn: 'Melde dich am Gateway an, bevor du Hermie Web aktualisierst.',
      restartTimedOut: 'Hermie Web ist innerhalb einer Minute nicht zurückgekommen. Sieh in seine Logs.'
    },
    pluginInstalled: (version: string) => (version ? `Hermie-Plugin ${version}` : 'Hermie-Plugin'),
    pluginAbsent: 'Nicht installiert',
    pluginUnknown: 'Prüfe…',

    notifications: {
      header: 'Benachrichtigungen',
      enabled: 'Benachrichtigungen',
      enabledHint:
        'Das Hermie-Plugin läuft in deinem Gateway und sendet eine Benachrichtigung, wenn ein Bot Neues hat. Hermie Web mit --push erledigt dieselbe Aufgabe von außen, falls sich kein Plugin installieren lässt.',
      denied:
        'Benachrichtigungen sind für Hermie in deinen Geräteeinstellungen ausgeschaltet. Schalte sie zuerst dort ein.',
      unavailable: 'Dieses Gerät kann sich nicht für Benachrichtigungen registrieren. Es wurde nichts gesendet.',
      webInsecure: 'Der Browser bietet Benachrichtigungen nur an, wenn Hermie Web über https ausgeliefert wird.',
      types: 'Sag mir Bescheid bei',
      typeMessage: 'Neue Nachricht',
      typeRequest: 'Braucht Eingabe',
      typeCron: 'Routinen',
      typeCronDone: 'Eine Routine ist fertig',
      typeCronFailed: 'Eine Routine ist fehlgeschlagen',
      typeTurnDone: 'Arbeit beendet',
      typeTurnFailed: 'Etwas ist schiefgelaufen',
      typesHint:
        'Ein Bot antwortet, ein Bot fragt um Erlaubnis, die Zustellung einer Routine, wie ein geplanter Lauf geendet ist, und eine lange Aufgabe, die so oder so ihr Ende erreicht. Ein Zug, den du selbst gestoppt hast, ist nie darunter.',
      preview: 'Vorschau zeigen',
      previewHint:
        'Aus sagt eine Benachrichtigung, welcher Bot und was passiert ist. An trägt sie auch die Nachricht mit — und gelesen wird sie auf dem Sperrbildschirm.',

      status: 'Registrierung',
      statusOff: 'Aus. Dieses Gerät ist nicht registriert.',
      statusPending: 'Frage die Plattform nach einer Adresse…',
      statusRegistered: (tail: string) => `Registriert · …${tail}`,
      statusDenied: 'Berechtigung verweigert. Schalte Benachrichtigungen für Hermie in deinen Geräteeinstellungen ein.',
      statusSystemSettings: 'Schalte Benachrichtigungen für Hermie in den Systemeinstellungen → Mitteilungen ein',
      openSystemSettings: 'Mitteilungseinstellungen öffnen',
      openSystemSettingsHint: 'Hermie bleibt hier eingeschaltet und registriert sich, sobald macOS es zulässt.',
      statusNoProject:
        'Dieser Build hat keine EAS-Projekt-ID, deshalb kann ihm kein Push-Token gegeben werden. Er muss neu gebaut werden.',
      statusFailed: (message: string) => `Token-Anfrage fehlgeschlagen: ${message}`,
      statusUnsupported: (detail: string) => `Dieses Gerät kann sich nicht registrieren: ${detail}`,
      retry: 'Wiederholen',
      retryHint: 'Fragt erneut nach der Berechtigung und fordert ein neues Push-Token an.'
    },

    gateways: {
      rowHint: (count: number) => (count === 1 ? 'Ein Gateway' : `${count} Gateways`),
      hint: 'Tippe auf ein Gateway, um dich damit zu verbinden. Hermie spricht immer nur mit einem; die anderen behalten ihre Unterhaltungen und ihre Benachrichtigungen.',
      active: 'Verbunden',
      signedInAs: (user: string) => `Angemeldet als ${user}`,
      signedOut: 'Abgemeldet',
      authModeToken: 'Session-Token',
      use: 'Dieses Gateway verwenden',
      manage: 'Verwalten',
      add: 'Gateway hinzufügen',
      addHint:
        'Startet die Einrichtung für eine weitere Maschine. Das Gateway, auf dem du gerade bist, bleibt verbunden, bis du wechselst.',

      nameHint: 'Wie dieses Gateway auf diesem Gerät heißt. Es wird nirgendwohin gesendet.',
      save: 'Speichern',
      connect: 'Mit diesem Gateway verbinden',
      connectHint: 'Hermie trennt sich vom Gateway, auf dem es gerade ist, und wählt dieses.',
      signOut: 'Von diesem Gateway abmelden',
      signOutHint: 'Löscht die gespeicherten Zugangsdaten und behält die Adresse.',
      remove: 'Dieses Gateway entfernen',
      removeHint:
        'Vergisst seine Adresse, seine Zugangsdaten, seine Unterhaltungen und seine Einstellungen auf diesem Gerät.',
      removeConfirm: 'Dieses Gateway und alles, was dafür auf diesem Gerät gespeichert ist, entfernen?',
      removeConfirmAction: 'Entfernen',
      keepIt: 'Behalten',
      removeNotifyNote:
        'Wenn dieses Gateway nicht das ist, mit dem Hermie verbunden ist, hören seine Benachrichtigungen erst auf, wenn es das nächste Mal versucht, dieses Gerät zu erreichen — und nicht sofort.'
    },

    account: 'Konto',
    signOut: 'Abmelden',
    signOutHint: 'Löscht die gespeicherten Zugangsdaten und behält die Gateway-Adresse.',
    changeGateway: 'Gateway wechseln',
    changeGatewayHint:
      'Öffnet die Einrichtung erneut mit dieser Adresse ausgefüllt. Nichts Gespeichertes geht verloren, bis ein anderes Gateway übernommen wird.',
    changeGatewayConfirm: 'Dieses Gateway und alles, was dafür gespeichert ist, vergessen?',
    confirm: 'Vergessen',
    keepIt: 'Behalten',
    developer: 'Entwickler',
    connectionTest: 'Verbindungstest',
    unknown: 'Unbekannt',
    defaultVerbosity: 'Standard-Detailgrad',
    defaultVerbosityHint:
      'Wie viel von der Denkarbeit eines Bots eine neue Unterhaltung zeigt. Eine Unterhaltung mit eigener Einstellung behält sie.',
    showBotToBot: 'Bot-zu-Bot zeigen',
    showThinking: 'Denken zeigen',
    appearance: 'Darstellung',

    language: 'Sprache',
    languageFollowDevice: 'Gerät folgen',
    languageHint:
      'Hermie ist auf Englisch geschrieben. Niederländisch und Deutsch sind Übersetzungen davon; was noch nicht übersetzt ist, bleibt Englisch.',

    theme: 'Thema',
    themeOptions: { light: 'Hell', dark: 'Dunkel' },
    themeHint: 'System folgt dem Gerät; Hell und Dunkel legen die App so oder so fest.',
    botNames: 'Bot-Namen',
    botNameOptions: { profile: 'Profilname', display: 'Anzeigename' },
    botNamesHint:
      'Welcher Name der große ist. Der Profilname ist der, mit dem der Rest der App einen Bot anspricht; der Anzeigename ist das Label, das auf dem Gateway gesetzt ist. Ein Bot mit nur einem von beiden zeigt eine Zeile. Wird nur verwendet, solange Profilname ausblenden, unten, aus ist.',
    hideHandle: 'Profilname ausblenden',
    hideHandleHint:
      'Zeigt bei einem Bot mit Anzeigename nur diesen — der Profilname, mit dem er sonst gezeigt wird, entfällt in der zweiten Zeile. Ein Bot ohne Anzeigename behält so oder so seinen einen Namen.',
    chatTextSize: 'Chat-Textgröße',
    chatTextSizeHint:
      'Gilt für die Wörter in einer Unterhaltung, zusätzlich zur Textgröße des Geräts. Der Rest der App folgt dem Gerät.',
    preset: 'THEMA',
    presetOptions: { blue: 'Blau', graphite: 'Graphit', lime: 'Limette' },
    presetHint: 'Jedes Thema hat eine helle und eine dunkle Seite; die Einstellung oben wählt, welche zu sehen ist.',

    themes: {
      title: 'Themen',
      editPageTitle: 'Thema bearbeiten',
      header: 'DEINE THEMEN',
      back: 'Zurück zu den Einstellungen',
      create: 'Neues Thema',
      createFrom: (preset: string) => `Aus ${preset}`,
      untitled: 'Thema ohne Namen',
      namePlaceholder: 'Themenname',
      rename: 'Umbenennen',
      delete: 'Löschen',
      deleteConfirm: (name: string) => `„${name || 'Thema ohne Namen'}“ löschen?`,
      deleteHint: 'Das Thema wird überall entfernt, wo dieses Gateway angemeldet ist.',
      keepIt: 'Behalten',
      empty: 'Noch keine eigenen Themen. Fang eines von einer Vorlage aus an und ändere seine Farben.',
      // `face` is the light/dark side of one theme. German says `Seite` where
      // English says face; `Gesicht` would be the word for a head.
      editing: (scheme: string) => `Bearbeitet wird die Seite ${scheme}`,
      editingHint: 'Wechsle die Einstellung oben, um die andere Seite zu bearbeiten.',
      background: 'Hintergrund',
      accentFill: 'Akzent',
      accentBubble: 'Deine Sprechblasen',
      followPreset: 'Der Vorlage folgen',
      rejected: (reason: string) => `Diese Farbe wird nicht verwendet: ${reason}`,
      reasonMalformed: 'eine Farbe sind sechs Hex-Ziffern nach einem #.',
      reasonBubble: (ratio: string) => `weißer Text darauf misst ${ratio} : 1 und braucht 4.5 : 1.`,
      reasonBackground: (ratio: string) => `der Text der App darauf misst ${ratio} : 1 und braucht 4.5 : 1.`,
      reasonAccentFill: (ratio: string) =>
        `sie misst ${ratio} : 1 gegen die Fläche dahinter, und eine Markierung braucht 3 : 1.`
    },
    about: 'Über',
    licences: 'Lizenzen',
    licencesHint: 'Die Open-Source-Pakete, aus denen Hermie gebaut ist, und was jedes davon verlangt.',
    licencesSummary: (count: number) =>
      count === 1
        ? '1 Paket steckt in Hermie.'
        : `${count} Pakete stecken in Hermie. Tippe auf eines, um seine Lizenz zu lesen.`,
    licencesBack: 'Zurück zu den Einstellungen',
    licencesLoading: 'Lade die Lizenzen…',
    licencesFailed: (message: string) => `Die Lizenzliste konnte nicht geladen werden: ${message}`,
    licencesRetry: 'Erneut versuchen',
    licencesUndeclared: 'keine Lizenz angegeben',
    licencesNoText: 'Dieses Paket liefert keine Lizenzdatei mit. Der Bezeichner oben ist alles, was es angibt.',
    licencesScope: (excluded: number) =>
      `Nur Produktionsabhängigkeiten; Entwicklungswerkzeuge und Hermies eigene ${excluded} Workspace-Pakete stehen nicht in der Liste.`,
    licencesGeneratedBy: (script: string) => `Erzeugt von ${script}, zusammen mit THIRD_PARTY_LICENSES.md.`,

    scheme: 'Schema',

    forgetGateway: 'Dieses Gateway vergessen',
    forgetGatewayHint:
      'Löscht die Adresse und die Zugangsdaten von diesem Gerät und startet die Einrichtung mit leeren Feldern.',

    privacy: 'PRIVATSPHÄRE & SICHERHEIT',

    lock: {
      label: 'Entsperren verlangen',
      options: {
        off: 'Aus',
        // One character over `Now`, and still the shortest word that says
        // immediately rather than at some point today.
        immediately: 'Sofort',
        '1m': '1 Min',
        '5m': '5 Min',
        '15m': '15 Min'
      },
      hint: 'Verlangt Face ID, Touch ID oder den Code dieses Geräts, bevor Hermie gelesen werden kann. Diese Einstellung bleibt auf diesem Gerät.',
      hintOn:
        'Hermie fragt wieder, wenn es so lange weg war, und immer nach einem frischen Start. Diese Einstellung bleibt auf diesem Gerät.',
      noEnrolment:
        'Richte zuerst einen Code, Face ID oder einen Fingerabdruck in deinen Geräteeinstellungen ein — sonst würde Hermie sich sperren, ohne dass es noch zu öffnen wäre.',
      unavailable: 'Dieses Gerät hat keine Entsperrmethode, nach der Hermie fragen könnte.',
      passcodeOnly: 'Es ist keine Biometrie eingerichtet, deshalb fragt Hermie nach dem Code dieses Geräts.',
      web: 'Hermie kann sich in einem Browser nicht selbst sperren: die Seite und alles, was eine Sperre durchsetzt, sind derselbe Code. Sperre den Bildschirm oder schließe den Tab.',
      refused:
        'Hermie konnte nicht bestätigen, dass du es warst, also wurde nichts geändert. Wähle die Option erneut, um es noch einmal zu versuchen.'
    }
  },

  connection: {
    status: {
      disconnected: 'Getrennt',
      probing: 'Prüfe das Gateway…',
      authenticating: 'Authentifiziere…',
      connecting: 'Verbinde…',
      ready: 'Verbunden',
      reconnecting: 'Verbinde neu…',
      paused: 'Pausiert',
      needs_signin: 'Abgemeldet',
      incompatible: 'Nicht unterstützt'
    },
    reauth: {
      message: 'Deine Session auf diesem Gateway ist abgelaufen.',
      action: 'Anmelden',
      tokenAction: 'Token aktualisieren',
      saving: 'Melde an…'
    }
  },

  errors: {
    network: (host: string) =>
      `${host} war nicht erreichbar. Prüfe die Adresse und ob das Gateway läuft und von diesem Gerät aus erreichbar ist.`,
    networkOverHttps: (host: string) =>
      `${host} war über https:// nicht erreichbar. Entweder antwortet es dort nicht, oder es liefert ein Zertifikat, dem dieses Gerät nicht traut. Lass das https:// weg, dann versucht Hermie auch http://.`,
    tls: (host: string) =>
      `Die sichere Verbindung zu ${host} ist fehlgeschlagen. Einem selbstsignierten Zertifikat muss dieses Gerät erst vertrauen — oder, wenn das Gateway dort einfaches http ausliefert, lass das https:// weg und lass Hermie es finden.`,
    timeout: (host: string) =>
      `${host} hat nicht rechtzeitig geantwortet. Vielleicht startet es gerade oder hängt an einer langsamen Leitung.`,
    notHermes: (host: string) =>
      `${host} hat geantwortet, aber nicht wie ein Hermes-Gateway. Prüfe die Adresse und ein mögliches Pfad-Präfix.`,
    landingPage: 'Das sieht nach einer Webseite aus, nicht nach einem Gateway.',
    privateNetworkOnly: 'Diese Adresse antwortet nur in einem privaten Netz — ist dieses Gerät im VPN/Tailnet?',
    redirected: (from: string, to: string) =>
      `${from} hat auf ${to} weitergeleitet, und das ist ein anderer Host. Es wurde nichts davon gelesen.`,
    useRedirectTarget: (host: string) => `Stattdessen ${host} verwenden`,
    openFrontDoor: 'Zugangsdaten des Proxys hinzufügen',
    authProxy: (status: number) =>
      `Ein Access-Proxy hat mit HTTP ${status} geantwortet, bevor das Gateway dran war. Füge seine Header unter Erweitert hinzu, oder nimm /api/status, /auth/* und /login davon aus.`,
    server: (status: number) =>
      `Das Gateway hat mit HTTP ${status} geantwortet. Es läuft, ist aber nicht gesund; sieh in seine Logs.`,
    providersUnavailable:
      'Das Gateway verlangt eine Anmeldung, meldet aber keine Identity Provider. Richte einen auf dem Gateway ein und versuche es erneut.',
    signedOut: 'Das Gateway hat die Zugangsdaten abgelehnt. Melde dich erneut an.',
    closeAuth: 'Das Gateway hat die Zugangsdaten abgelehnt, als der WebSocket geöffnet wurde. Melde dich erneut an.',
    closeHost:
      'Das Gateway traut dieser Adresse nicht. Setze sein `dashboard.public_url` auf die Adresse, die du eingegeben hast, und starte es neu.',
    closeTakenOver: 'Ein anderer Client hat diese Verbindung übernommen. Schließe den anderen Client und teste erneut.',
    closeChatOff: 'Chat ist auf diesem Gateway abgeschaltet.',
    closeAbnormal:
      'Der WebSocket wurde ohne Grund geschlossen. Ein Proxy vor dem Gateway muss meistens erst so konfiguriert werden, dass er WebSocket-Upgrades durchlässt.',
    incompatible: 'Dieses Gateway ist zu alt für Hermie. Aktualisiere Hermes auf dem Gateway.',
    unknown: 'Etwas ist schiefgelaufen.'
  },

  botProfile: {
    menuItem: 'Profil bearbeiten',
    open: (name: string) => `${name}s Profil bearbeiten`,
    title: 'Profil',

    photo: 'FOTO',
    photoHint: 'Zu sehen in der Chatliste, im Header und bei jeder Nachricht, die dieser Bot sendet.',
    photoChange: 'Foto auswählen',
    photoReplace: 'Foto ändern',
    photoRemove: 'Foto entfernen',

    description: 'BESCHREIBUNG',
    descriptionPlaceholder: 'Wofür dieser Bot da ist',
    colour: 'FARBE',
    colourHint: 'Nur dieser Chat. Sie tönt die Sprechblasen, den Ring um den Avatar und die Zeile in der Liste.',

    about: 'ÜBER DIESEN BOT',
    model: 'Modell',

    save: 'Speichern',
    saving: 'Speichere…',
    saveFailed: 'Das Gateway wollte das nicht speichern.',
    photoFailed: 'Dieses Foto konnte nicht hochgeladen werden.'
  }
}
