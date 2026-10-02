/**
 * `chat-ui/strings.ts` in German.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { chatStrings } from '../../chat-ui/strings'
import type { Translation } from '../catalogue'

export const chat: Translation<typeof chatStrings> = {
  replying: 'Antwortet',
  receipt: {
    sending: 'Sendet…',
    // The three settled states have no shorter honest German: `Gesendet`,
    // `Zugestellt` and `Gelesen` are what every German messenger writes, and a
    // clipped word here would read as a different state rather than a shorter
    // one.
    sent: 'Gesendet',
    delivered: 'Zugestellt',
    read: 'Gelesen'
  },
  // `Mehr anzeigen` / `Weniger anzeigen` are half again as wide as the English
  // pair, and this fold sits inline under a bubble. The bare comparatives say
  // the same thing and stay under `Show more`.
  fold: {
    more: 'Mehr',
    less: 'Weniger'
  },
  assistant: {
    thoughtFor: (seconds: number) => `${seconds}s nachgedacht`,
    thinking: 'Denkt nach',
    replyTo: (handle: string) => `Antwort an @${handle}`,
    interim: 'Zwischennotiz',
    tokens: (input: string, output: string) => `${input} rein · ${output} raus`,
    retry: 'Erneut versuchen',
    reconnecting: 'Verbindet neu…',
    errorTitle: 'Etwas ist schiefgelaufen'
  },
  tool: {
    running: 'Läuft…',
    // `Bereitet vor…` overflows the card label. `Startet…` is shorter than the
    // English and says the same thing about a call that has not begun to run.
    generating: 'Startet…',
    arguments: 'Argumente',
    result: 'Ergebnis',
    rawArguments: 'Argumente (roh)',
    rawResult: 'Ergebnis (roh)',
    showMore: 'Mehr',
    showLess: 'Weniger',
    noResult: 'Kein Ergebnis erfasst',
    failed: 'Fehlgeschlagen',
    // Literally `nicht vertrauenswürdig`, which is twice the English width.
    // `Ungeprüft` carries the warning a reader has to act on.
    riskTitle: 'Ungeprüfte Ausgabe',
    redacted: 'Geschwärzt, bevor es das Modell erreichte',
    expand: 'Tool-Aufruf ausklappen',
    collapse: 'Tool-Aufruf einklappen'
  },
  botDm: {
    asideTo: (handle: string) => `An @${handle}`,
    asideFrom: (handle: string) => `Von @${handle}`,
    replied: (name: string) => `${name} hat geantwortet`,
    sending: 'Sendet…',
    queued: 'Wartet · auf die laufende Aufgabe',
    delivered: 'Zugestellt ✓',
    failed: 'Fehlgeschlagen',
    ambiguous: 'Mehrdeutiges Ziel',
    unknown: 'Gesendet',
    showMore: 'Mehr',
    showLess: 'Weniger',
    marker: {
      // U+FE0E after the arrow, exactly as in the English table.
      replied: '↩︎ geantwortet',
      waiting: 'Zugestellt · wartet auf Antwort',
      failed: 'Fehlgeschlagen'
    },
    // `mit`, nicht `an`: eine Folge enthält beide Richtungen.
    rollup: (count: number, handle: string, replies: number) =>
      `${count} Nachrichten mit @${handle} · ${replies} ${replies === 1 ? 'Antwort' : 'Antworten'}`,
    rollupMixed: (count: number, replies: number) =>
      `${count} Nachrichten · ${replies} ${replies === 1 ? 'Antwort' : 'Antworten'}`,
    openChat: (handle: string) => `Chat von @${handle} öffnen`,
    reply: 'Antworten',
    answered: '↩︎ beantwortet',
    chip: (target: string) => `Nachricht an ${target}`,
    inChip: (name: string) => `Nachricht von ${name}`,
    targetTyping: (handle: string) => `@${handle} schreibt…`,
    openTarget: (target: string) => `Öffnet den Chat mit ${target}`,
    openSender: (name: string) => `Öffnet den Chat mit ${name}`
  },
  subagents: {
    title: 'Agenten',
    // German conjugates the verb, so the singular and the plural each carry
    // their own rather than sharing one form the way the English does.
    working: (count: number, elapsed: string) =>
      `${count} ${count === 1 ? 'Agent arbeitet' : 'Agenten arbeiten'} · ${elapsed}`,
    barCount: (count: number) => `${count} ${count === 1 ? 'Agent arbeitet' : 'Agenten arbeiten'}`,
    barOpen: 'Zeigen',
    idle: 'Keine Agenten aktiv',
    goals: (count: number) => `${count} ${count === 1 ? 'Ziel' : 'Ziele'}`,
    steer: 'Lenken',
    steerPlaceholder: 'Korrektur senden…',
    stop: 'Stopp',
    openTranscript: 'Transkript öffnen',
    transcriptTitle: (goal: string) => `Transkript · ${goal}`,
    transcriptLive: 'Live · aktualisiert sich alle paar Sekunden',
    transcriptStored: 'Das eigene Transkript des Unteragenten, nur lesbar.',
    transcriptEmpty: 'Dieser Agent hat noch nichts Lesbares geschrieben.',
    transcriptBack: 'Zurück zu den Agenten',
    steerQueued: 'Korrektur wartet',
    steerRejected: 'Zu spät zum Lenken — der Agent hatte seinen letzten Durchlauf schon beendet.',
    stopped: 'Stoppt…',
    status: {
      queued: 'Wartet',
      running: 'Läuft',
      completed: 'Fertig',
      failed: 'Fehlgeschlagen',
      interrupted: 'Gestoppt'
    },
    groupStatus: {
      // `Losgeschickt` is the natural word and two characters too wide for the
      // chip; `Verschickt` is exactly as wide as `Dispatched`.
      dispatched: 'Verschickt',
      running: 'Läuft',
      done: 'Fertig',
      failed: 'Fehlgeschlagen'
    }
  },
  cron: {
    unnamed: 'Geplanter Job',
    ranAt: (time: string) => `lief ${time} · in diesen Chat zugestellt`,
    delivered: 'in diesen Chat zugestellt',
    emptyBody: 'Der Job hat nichts zum Anzeigen geliefert.',
    open: 'Cron öffnen',
    runNow: 'Jetzt ausführen'
  },
  transcript: {
    // `Zum Neuesten springen` is half again as wide as the English pill.
    jumpToLatest: 'Zum Neuesten',
    newMessages: (count: number) => `${count} neu`,
    empty: 'Noch keine Nachrichten',
    loadingEarlier: 'Lädt Älteres…',
    answer: 'Antwort',
    answered: 'beantwortet'
  },

  queue: {
    // `In der Warteschlange` is four times the width of this chip. `Wartet` is
    // what the message is doing and fits where the English fits.
    label: 'Wartet',
    steer: 'Lenken',
    edit: 'Ändern',
    delete: 'Löschen',
    // `turn` is `Durchlauf` throughout: the one pass the bot is making, which
    // is neither a reply nor a session.
    steered: 'An den laufenden Durchlauf übergeben',
    steeredMarker: 'Gelenkt',
    more: (count: number) => `+${count} weitere`,
    steerRejected: 'Zu spät zum Lenken — der Durchlauf war schon fast fertig. Die Nachricht wartet wieder.'
  },

  menu: {
    copyText: 'Text kopieren',
    copyMarkdown: 'Als Markdown kopieren',
    copyLink: 'Link kopieren',
    showDetails: 'Details zeigen',
    hideDetails: 'Details verbergen',
    openBotChat: (handle: string) => `Chat von @${handle} öffnen`,
    selectText: 'Text auswählen',
    editResend: 'Ändern und neu senden',
    regenerate: 'Neu generieren',
    readAloud: 'Vorlesen',
    stopReading: 'Vorlesen stoppen',
    turnRunning: 'Warte, bis der laufende Durchlauf fertig ist.',
    nothingToRegenerate: 'Hier gibt es keine Nachricht zum erneuten Senden.',
    message: 'Nachrichtenaktionen'
  },

  selectText: {
    title: 'Text auswählen',
    done: 'Fertig',
    copyAll: 'Alles kopieren',
    panel: 'Nachricht als auswählbarer Text',
    hint: 'Ziehen zum Auswählen · ⌘A alles · ⌘C kopieren · Esc zum Schließen'
  },
  drop: {
    invitation: 'Datei loslassen zum Anhängen',
    region: 'Dateien hier loslassen, um sie anzuhängen'
  },

  viewer: {
    close: 'Bild schließen',
    share: 'Bild teilen',
    download: 'Bild herunterladen',
    openHint: 'Öffnet die Vollbildansicht'
  },

  composer: {
    placeholder: 'Nachricht',
    messageTo: (bot: string) => `Nachricht an ${bot}`,
    send: 'Nachricht senden',
    stop: 'Antwort stoppen',
    attach: 'Anhang hinzufügen',
    dismissAttach: 'Anhang-Menü schließen',
    photoLibrary: 'Fotomediathek',
    chooseFile: 'Datei wählen',
    keyHint: 'Enter zum Senden · Shift+Enter für eine neue Zeile',
    removeAttachment: 'Anhang entfernen',
    // German quotation marks for a German sentence; the English table's curly
    // pair would read as a stray glyph here.
    queued: (text: string) => `↳ 1 Nachricht wartet · „${text}“`,
    slashHint: 'Befehle',
    slashUnavailable: (method: string) => `Befehle nicht verfügbar — ${method}`,
    slashLoading: 'Lädt…',
    notSentYet: 'Noch nicht gesendet',
    pendingCount: (count: number) => (count === 1 ? '1 Datei' : `${count} Dateien`),
    sendWithAttachments: (count: number) =>
      count === 1 ? 'Nachricht mit 1 Anhang senden' : `Nachricht mit ${count} Anhängen senden`
  },
  header: {
    back: 'Zurück zu den Chats',
    options: 'Chat-Optionen',
    hideSidebar: 'Seitenleiste ausblenden',
    running: 'Läuft',
    needsInput: 'Wartet auf dich',
    // `zuletzt gesehen` would push the pill past the English width, and the
    // time behind it already says what was last seen.
    offlineAt: (time: string) => `Offline · zuletzt ${time}`,
    profile: (name: string) => `${name} — Profil`
  },
  approval: {
    // `BERECHTIGUNGSANFRAGE` is wider than the English eyebrow in caps.
    eyebrow: (handle: string) => `ZUGRIFFSANFRAGE · @${handle.toUpperCase()}`,
    title: 'Diesen Befehl erlauben?',
    lead: (handle: string, directory?: string) =>
      directory
        ? `@${handle} möchte einen Befehl auf deinem Gateway-Host ausführen, in ${directory}.`
        : `@${handle} möchte einen Befehl auf deinem Gateway-Host ausführen.`,
    runsOn: 'Läuft auf deinem Gateway',
    fine: 'Immer erlauben gilt für genau diesen Befehl auf diesem Gateway. Später in den Einstellungen änderbar.',
    answeredElsewhere: 'Anderswo beantwortet',
    timedOut: 'Zeit abgelaufen',
    answered: (choice: string) => `Beantwortet: ${choice}`,
    outcomes: {
      once: 'Einmal erlaubt',
      session: 'Für die Sitzung erlaubt',
      always: 'Immer erlaubt',
      deny: 'Abgelehnt'
    },
    choices: {
      once: 'Einmal erlauben',
      session: 'Für diese Sitzung erlauben',
      always: 'Immer erlauben',
      deny: 'Ablehnen'
    }
  },
  clarify: {
    eyebrow: 'EINE FRAGE AN DICH',
    title: 'Bevor ich weitermache',
    step: (current: number, total: number) => `Frage ${current} von ${total}`,
    freeText: 'Oder antworte in eigenen Worten',
    freeTextPlaceholder: 'Antwort eingeben…',
    lock: 'Antwort festlegen',
    locked: 'Festgelegt',
    submit: 'Senden',
    later: 'Später',
    outcome: (answered: number, total: number) =>
      answered >= total
        ? total === 1
          ? 'Beantwortet'
          : `Alle ${total} beantwortet`
        : `${answered} von ${total} beantwortet`,
    next: 'Weiter',
    previous: 'Zurück',
    multiSelectHint: 'Wähle alles, was zutrifft'
  },
  context: {
    // One compound instead of `Genutzter Kontext`, which is wider than the row
    // label it replaces.
    label: 'Kontextnutzung',
    hint: 'Wie viel vom Kontextfenster dieser Sitzung die Unterhaltung füllt.',
    estimated: '(geschätzt)'
  },

  export: {
    header: 'Exportieren',
    shareMarkdown: 'Als Markdown teilen',
    downloadMarkdown: 'Als Markdown herunterladen',
    shareText: 'Als reinen Text teilen',
    downloadText: 'Als reinen Text herunterladen',
    hint: 'Die Unterhaltung so, wie sie auf dem Bildschirm steht — ohne das, was diese Ansicht ausblendet.',
    self: 'Du',
    failed: 'Die Unterhaltung konnte nicht exportiert werden.'
  },

  options: {
    eyebrow: 'Dieser Chat',
    colourHint: 'Färbt den Avatar-Ring dieses Chats, seine Zeile in der Liste und deine gesendeten Nachrichten.',
    title: 'Chat-Optionen',
    done: 'Fertig',
    subtitle: (bot: string) => `Für diese Unterhaltung mit ${bot}`,
    yolo: 'YOLO-Modus',
    yoloHint: 'Zugriffsanfragen überspringen',
    fast: 'Schnellmodus',
    fastHint: 'Antwortgeschwindigkeit bevorzugen',
    reasoning: 'Denkaufwand',
    model: 'Modell',
    modelSearch: 'Modelle suchen',
    verbosity: 'Detailgrad',
    // `Knapp` / `Ausführlich` is the natural pair, and `Ausführlich` is four
    // characters past `Verbose` in a row split three ways. Under the label
    // `Detailgrad`, `Wenig` and `Viel` read as the amount of detail and fit.
    verbosityOptions: { quiet: 'Wenig', verbose: 'Viel' },
    showBotToBot: 'Bot-zu-Bot zeigen',
    showThinking: 'Denken zeigen',
    howHeader: 'Wie es antwortet',
    thisChatHeader: 'Diese Unterhaltung',
    viewHeader: 'Was diese Unterhaltung zeigt',
    useDefault: 'Ansicht dieser Unterhaltung zurücksetzen',
    useDefaultHint:
      'Löscht den eigenen Detailgrad und die Sichtbarkeitseinstellungen dieser Unterhaltung und folgt wieder dem Standard aus den Einstellungen.',
    usingDefault: 'Folgt dem Standard aus den Einstellungen.',
    usingOverride: 'Diese Unterhaltung hat eine eigene Ansicht.',
    expensiveTitle: 'Dieses Modell kostet mehr',
    expensiveConfirm: 'Trotzdem verwenden',
    cancel: 'Abbrechen',

    notMuted: 'Aus',

    textSize: 'Chat-Textgröße',
    textSizes: {
      small: 'Klein',
      // `Standard` is a character past `Default` in a row split four ways, and
      // `Normal` is what the other segmented row here already says.
      default: 'Normal',
      large: 'Groß',
      xlarge: 'Sehr groß'
    }
  },

  notifications: {
    // `Benachrichtigungen` is half again as wide as the English; `Mitteilungen`
    // is the word the platform itself uses and stays inside the row.
    label: 'Mitteilungen',
    title: 'Mitteilungen',
    subtitle: (bot: string) => `Worüber ${bot} dich informieren darf`,
    hint: 'Diese ersetzen die globalen Typen aus den Einstellungen — nur für diesen Chat.',
    following: 'Folgt den Typen aus den Einstellungen.',
    overridden: 'Dieser Chat hat eigene Typen.',
    useDefault: 'Globale Typen verwenden',
    types: {
      turnDone: 'Durchlauf beendet',
      turnFailed: 'Ein Durchlauf ist fehlgeschlagen',
      needsInput: 'Braucht deine Antwort',
      cron: 'Geplante Läufe',
      cronDone: 'Ein geplanter Lauf ist fertig',
      cronFailed: 'Ein geplanter Lauf ist fehlgeschlagen'
    }
  },

  sessions: {
    branch: 'Ab hier verzweigen…',
    branchTitle: 'Verzweigen',
    branchFailed: 'Diese Unterhaltung konnte nicht verzweigt werden.',
    branches: 'Zweige',
    conversations: 'Unterhaltungen',
    branchOf: (title: string) => `Zweig von ${title}`,
    backToMain: 'zurück zum Haupt-Chat',
    openNow: 'Jetzt öffnen',
    branchMade: (title: string) => `In ${title} verzweigt.`,
    adopt: 'Das hier zum Bot Chat machen',
    adoptFailed: 'Das Gateway wollte das nicht zum Bot Chat machen.',
    renameFailed: 'Diese Unterhaltung konnte nicht umbenannt werden.',
    loading: 'Unterhaltungen dieses Bots werden gelesen…',
    loadFailed: 'Die Unterhaltungen dieses Bots konnten nicht gelesen werden.',
    pin: 'Anheften',
    // `Nicht mehr anheften` is four times the width of `Unpin`, in the same row
    // as `Anheften`, where the pair is read together anyway.
    unpin: 'Lösen',
    refresh: 'Neu laden',
    refreshFailed: 'Dieser Chat konnte nicht neu geladen werden.',
    past: 'Frühere Unterhaltungen',
    pastEmpty: 'Nur die aktuelle Unterhaltung.',
    open: 'Öffnen',
    rename: 'Umbenennen',
    renameTitle: 'Unterhaltung umbenennen',
    delete: 'Löschen',
    deleteTitle: 'Diese Unterhaltung löschen?',
    deleteBody: (title: string) => `${title} wird vom Gateway entfernt. Das lässt sich nicht rückgängig machen.`,
    deleteConfirm: 'Löschen',
    deleteFailed: 'Diese Unterhaltung konnte nicht gelöscht werden.',
    cancel: 'Abbrechen',
    canonical: 'Aktuelle Unterhaltung',
    whose: 'Diese Unterhaltung',
    shared: 'Geteilter Bot Chat',
    mine: 'Mein Chat',
    mineGroup: 'Mein Chat',
    sharedNote: 'Alle auf diesem Gateway teilen sich diese Unterhaltung.',
    mineNote: 'Nur du siehst diese Unterhaltung. Der Bot behält sein eigenes Gedächtnis.',
    switchFailed: 'Dieser Chat konnte nicht gewechselt werden.',
    busy: 'Warte, bis die Antwort fertig ist, oder leere zuerst die Warteschlange.',
    retired: 'Stillgelegt',
    messages: (count: number) => (count === 1 ? '1 Nachricht' : `${count} Nachrichten`)
  },

  conversations: {
    groupChat: 'Gruppenchat',
    yourChats: 'Deine Chats',
    yoursEmpty: 'Starte einen eigenen Chat, um ihn hier zu sehen.',
    newChat: 'Neuer Chat',
    newChatFailed: 'Das Gateway wollte keinen neuen Chat starten.',
    firstChat: 'Mein Chat',
    allConversations: 'Alle Unterhaltungen',
    renameLabel: 'Chatname',
    columnTitle: 'Unterhaltungen',
    showColumn: 'Unterhaltungen anzeigen',
    hideColumn: 'Unterhaltungen ausblenden',
    openFailed: 'Diese Unterhaltung konnte nicht geöffnet werden.'
  },

  voice: {
    header: 'STIMME',
    codeBlock: (lines: number) => (lines === 1 ? 'Codeblock, 1 Zeile' : `Codeblock, ${lines} Zeilen`),
    autoRead: 'Antworten vorlesen',
    autoReadHint: 'Jede fertige Antwort in diesem Chat, ohne Nachfrage.',
    rate: 'Sprechtempo',
    // Five options share one row, so the widest stop decides it. `Sehr langsam`
    // and `Sehr schnell` would set that width; `Träge` and `Rasant` name the
    // same two ends and keep the widest German stop at the English width.
    rateOptions: {
      slowest: 'Träge',
      slow: 'Langsam',
      fast: 'Schnell',
      fastest: 'Rasant'
    },
    dictationLanguage: 'Diktatsprache',
    dictationAuto: 'Gerätesprache',
    confirmBeforeSending: 'Vor dem Senden bestätigen',
    confirmBeforeSendingHint: 'Der Sprachmodus zeigt kurz, was er verstanden hat.',
    stopOnBackground: 'Stoppen, wenn die App schließt',
    dictate: 'Diktieren',
    dictateStop: 'Diktat stoppen',
    listening: 'Hört zu…',
    permissionDenied: 'Hermie braucht das Mikrofon fürs Diktat.',
    openSettings: 'Einstellungen öffnen',
    unavailable: 'Diktat ist auf diesem Gerät nicht verfügbar.',
    noSpeech: 'Es war nichts zu hören.',
    failed: 'Das Diktat hat unerwartet aufgehört.',
    mode: 'Sprachmodus',
    modeStart: 'Sprachmodus starten',
    modeLeave: 'Sprachmodus verlassen',
    modeListening: 'Hört zu',
    modeSending: 'Sendet',
    modeThinking: 'Wartet auf Antwort',
    modeSpeaking: 'Spricht',
    modeInterrupt: 'Tippen zum Unterbrechen',
    modeDismiss: 'Nach unten wischen zum Verlassen',
    modeCancel: 'Abbrechen'
  },
  sheet: {
    close: 'Schließen'
  }
}
