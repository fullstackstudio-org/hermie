/**
 * `chat-ui/strings.ts` in Dutch.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { chatStrings } from '../../chat-ui/strings'
import type { Translation } from '../catalogue'

export const chat: Translation<typeof chatStrings> = {
  replying: 'Antwoordt',
  // Bonnetjes onder een bubbel: de kortste Nederlandse woorden die er zijn.
  // `Verzonden` en `Gelezen` zijn langer dan hun Engelse tegenhangers, maar een
  // kortere Nederlandse status bestaat niet zonder onzin te worden.
  receipt: {
    sending: 'Versturen…',
    sent: 'Verzonden',
    delivered: 'Bezorgd',
    read: 'Gelezen'
  },
  // `Meer` / `Minder` in plaats van `Meer tonen` / `Minder tonen`: het paar staat
  // inline in een bubbel en moet onder de Engelse breedte blijven.
  fold: {
    more: 'Meer',
    less: 'Minder'
  },
  assistant: {
    thoughtFor: (seconds: number) => `Dacht ${seconds}s na`,
    thinking: 'Denkt na',
    replyTo: (handle: string) => `Antwoord aan @${handle}`,
    interim: 'Tussenbericht',
    retry: 'Opnieuw',
    reconnecting: 'Opnieuw verbinden…',
    errorTitle: 'Er ging iets mis',
    tokens: (input: string, output: string) => `${input} in · ${output} uit`
  },
  tool: {
    running: 'Bezig…',
    generating: 'Opstellen…',
    arguments: 'Argumenten',
    result: 'Resultaat',
    rawArguments: 'Argumenten (ruw)',
    rawResult: 'Resultaat (ruw)',
    showMore: 'Meer',
    showLess: 'Minder',
    noResult: 'Geen resultaat vastgelegd',
    failed: 'Mislukt',
    riskTitle: 'Niet-vertrouwde uitvoer',
    // `Weggelakt`, niet `geredigeerd`: dat laatste is in het Nederlands
    // redigeren in de zin van bewerken, en dat is precies niet wat er gebeurde.
    redacted: 'Weggelakt voordat het bij het model kwam',
    expand: 'Tool-aanroep uitklappen',
    collapse: 'Tool-aanroep inklappen'
  },
  botDm: {
    asideTo: (handle: string) => `Aan @${handle}`,
    asideFrom: (handle: string) => `Van @${handle}`,
    replied: (name: string) => `${name} antwoordde`,
    sending: 'Versturen…',
    queued: 'In de wachtrij · wacht op de huidige taak',
    delivered: 'Bezorgd ✓',
    failed: 'Mislukt',
    ambiguous: 'Onduidelijke ontvanger',
    unknown: 'Verzonden',
    showMore: 'Meer',
    showLess: 'Minder',
    marker: {
      // De U+FE0E achter de pijl blijft staan; zonder die selector geeft iOS
      // U+21A9 zijn emoji-vorm en landt er een blauwe glyph in een metaregel.
      replied: '↩︎ antwoordde',
      waiting: 'Bezorgd · wacht op antwoord',
      failed: 'Mislukt'
    },
    // `met`, niet `aan`: een reeks bevat beide richtingen.
    rollup: (count: number, handle: string, replies: number) =>
      `${count} berichten met @${handle} · ${replies} ${replies === 1 ? 'antwoord' : 'antwoorden'}`,
    rollupMixed: (count: number, replies: number) =>
      `${count} berichten · ${replies} ${replies === 1 ? 'antwoord' : 'antwoorden'}`,
    openChat: (handle: string) => `Open de chat van @${handle}`,
    reply: 'Antwoord',
    answered: '↩︎ beantwoord',
    chip: (target: string) => `Bericht aan ${target}`,
    inChip: (name: string) => `Bericht van ${name}`,
    targetTyping: (handle: string) => `@${handle} schrijft…`,
    openTarget: (target: string) => `Opent de chat met ${target}`,
    openSender: (name: string) => `Opent de chat met ${name}`
  },
  subagents: {
    working: (count: number, elapsed: string) => `${count} ${count === 1 ? 'agent' : 'agents'} bezig · ${elapsed}`,
    barCount: (count: number) => `${count} ${count === 1 ? 'agent' : 'agents'} bezig`,
    barOpen: 'Tonen',
    idle: 'Geen agents actief',
    goals: (count: number) => `${count} ${count === 1 ? 'doel' : 'doelen'}`,
    steer: 'Bijsturen',
    steerPlaceholder: 'Stuur een correctie…',
    openTranscript: 'Transcript openen',
    transcriptLive: 'Live · ververst elke paar seconden',
    transcriptStored: 'Het eigen transcript van de subagent, alleen-lezen.',
    transcriptEmpty: 'Deze agent heeft nog niets leesbaars geschreven.',
    transcriptBack: 'Terug naar de agents',
    steerQueued: 'Bijsturing in de wachtrij',
    steerRejected: 'Te laat om bij te sturen — de agent was al klaar met zijn laatste batch.',
    stopped: 'Stoppen…',
    status: {
      queued: 'In wachtrij',
      running: 'Bezig',
      completed: 'Klaar',
      failed: 'Mislukt',
      interrupted: 'Gestopt'
    },
    groupStatus: {
      dispatched: 'Verstuurd',
      running: 'Bezig',
      done: 'Klaar',
      failed: 'Mislukt'
    }
  },
  cron: {
    unnamed: 'Geplande taak',
    ranAt: (time: string) => `uitgevoerd ${time} · bezorgd in deze chat`,
    delivered: 'bezorgd in deze chat',
    emptyBody: 'De taak leverde niets op om te tonen.',
    open: 'Cron openen',
    runNow: 'Nu uitvoeren'
  },
  transcript: {
    jumpToLatest: 'Naar nieuwste',
    newMessages: (count: number) => `${count} nieuw`,
    empty: 'Nog geen berichten',
    loadingEarlier: 'Eerdere berichten laden…',
    answer: 'Beantwoorden',
    answered: 'beantwoord'
  },

  queue: {
    label: 'In wachtrij',
    steer: 'Bijsturen',
    edit: 'Bewerken',
    delete: 'Verwijderen',
    steered: 'Doorgegeven aan de lopende beurt',
    steeredMarker: 'Bijgestuurd',
    more: (count: number) => `+${count} meer`,
    steerRejected: 'Te laat om bij te sturen — de beurt was al aan het afronden. Het staat weer in de wachtrij.'
  },

  menu: {
    copyText: 'Tekst kopiëren',
    copyMarkdown: 'Kopiëren als Markdown',
    copyLink: 'Link kopiëren',
    showDetails: 'Details tonen',
    hideDetails: 'Details verbergen',
    openBotChat: (handle: string) => `Open de chat van @${handle}`,
    selectText: 'Tekst selecteren',
    // `Bewerken en opnieuw sturen`, want er wordt niets ter plekke aangepast:
    // de beurt die er staat blijft staan en er begint een nieuwe met dezelfde
    // woorden.
    editResend: 'Bewerken en opnieuw sturen',
    regenerate: 'Opnieuw genereren',
    readAloud: 'Voorlezen',
    stopReading: 'Stoppen met voorlezen',
    turnRunning: 'Wacht tot de huidige beurt klaar is.',
    nothingToRegenerate: 'Er is hier geen bericht om opnieuw te sturen.',
    message: 'Berichtacties'
  },

  selectText: {
    title: 'Tekst selecteren',
    done: 'Klaar',
    copyAll: 'Alles kopiëren',
    panel: 'Bericht als selecteerbare tekst',
    hint: 'Sleep om te selecteren · ⌘A alles · ⌘C kopiëren · Esc om te sluiten'
  },
  drop: {
    invitation: 'Loslaten om bij te voegen',
    region: 'Laat bestanden hier los om ze bij te voegen'
  },

  viewer: {
    close: 'Afbeelding sluiten',
    share: 'Afbeelding delen',
    download: 'Afbeelding downloaden',
    openHint: 'Opent de schermvullende weergave'
  },

  composer: {
    placeholder: 'Bericht',
    messageTo: (bot: string) => `Bericht aan ${bot}`,
    send: 'Bericht versturen',
    stop: 'Antwoord stoppen',
    attach: 'Bijlage toevoegen',
    dismissAttach: 'Bijlagemenu sluiten',
    photoLibrary: 'Fotobibliotheek',
    chooseFile: 'Bestand kiezen',
    keyHint: 'Enter om te versturen · Shift+Enter voor een nieuwe regel',
    removeAttachment: 'Bijlage verwijderen',
    queued: (text: string) => `↳ 1 bericht in de wachtrij · “${text}”`,
    slashHint: 'Commando’s',
    slashUnavailable: (method: string) => `Commando’s niet beschikbaar — ${method}`,
    slashLoading: 'Laden…',
    notSentYet: 'Nog niet verstuurd',
    pendingCount: (count: number) => (count === 1 ? '1 bestand' : `${count} bestanden`),
    sendWithAttachments: (count: number) =>
      count === 1 ? 'Bericht met 1 bijlage versturen' : `Bericht met ${count} bijlagen versturen`
  },
  header: {
    back: 'Terug naar chats',
    options: 'Chatopties',
    hideSidebar: 'Zijbalk verbergen',
    running: 'Bezig',
    needsInput: 'Wacht op jou',
    offlineAt: (time: string) => `Offline · laatst gezien ${time}`,
    profile: (name: string) => `${name} — profiel`
  },
  approval: {
    eyebrow: (handle: string) => `TOESTEMMING GEVRAAGD · @${handle.toUpperCase()}`,
    title: 'Dit commando toestaan?',
    lead: (handle: string, directory?: string) =>
      directory
        ? `@${handle} wil één commando op je gateway-host uitvoeren, in ${directory}.`
        : `@${handle} wil één commando op je gateway-host uitvoeren.`,
    runsOn: 'Draait op je gateway',
    fine: 'Altijd toestaan geldt voor precies dit commando op deze gateway. Je past het later aan in Instellingen.',
    answeredElsewhere: 'Elders beantwoord',
    timedOut: 'Verlopen',
    answered: (choice: string) => `Beantwoord: ${choice}`,
    outcomes: {
      once: 'Eenmalig toegestaan',
      session: 'Toegestaan voor deze sessie',
      always: 'Altijd toegestaan',
      deny: 'Geweigerd'
    },
    choices: {
      once: 'Eenmalig toestaan',
      session: 'Voor deze sessie toestaan',
      always: 'Altijd toestaan',
      deny: 'Weigeren'
    }
  },
  clarify: {
    eyebrow: 'EEN VRAAG VOOR JOU',
    title: 'Voordat ik verderga',
    step: (current: number, total: number) => `Vraag ${current} van ${total}`,
    freeText: 'Of antwoord in je eigen woorden',
    freeTextPlaceholder: 'Typ een antwoord…',
    lock: 'Antwoord vastzetten',
    locked: 'Vastgezet',
    submit: 'Versturen',
    outcome: (answered: number, total: number) => {
      if (answered < total) {
        return `${answered} van ${total} beantwoord`
      }

      return total === 1 ? 'Beantwoord' : `Alle ${total} beantwoord`
    },
    next: 'Volgende',
    previous: 'Terug',
    multiSelectHint: 'Kies alles wat van toepassing is'
  },
  context: {
    label: 'Gebruikte context',
    hint: 'Hoeveel van het contextvenster van deze sessie het gesprek vult.',
    estimated: '(geschat)'
  },

  export: {
    header: 'Exporteren',
    shareMarkdown: 'Delen als Markdown',
    downloadMarkdown: 'Downloaden als Markdown',
    shareText: 'Delen als platte tekst',
    downloadText: 'Downloaden als platte tekst',
    hint: 'Het gesprek zoals het op het scherm staat, zonder wat de weergave-instellingen van deze chat verbergen.',
    self: 'Jij',
    failed: 'Het gesprek kon niet geëxporteerd worden.'
  },

  options: {
    eyebrow: 'Deze chat',
    colourHint: 'Kleurt de avatarring van deze chat, de rij in de lijst en de berichten die je verstuurt.',
    title: 'Chatopties',
    done: 'Klaar',
    subtitle: (bot: string) => `Voor dit gesprek met ${bot}`,
    yolo: 'YOLO-modus',
    yoloHint: 'Sla toestemmingsverzoeken over',
    fast: 'Snelle modus',
    fastHint: 'Geef voorrang aan snelheid',
    reasoning: 'Redeneerniveau',
    modelSearch: 'Modellen zoeken',
    verbosity: 'Detailniveau',
    // Kort / Normaal / Lang in plaats van een letterlijke `Uitgebreid`: drie
    // opties delen één rij, en dit trio blijft binnen de Engelse breedte.
    verbosityOptions: { quiet: 'Kort', normal: 'Normaal', verbose: 'Lang' },
    showBotToBot: 'Bot-to-bot tonen',
    showThinking: 'Denkwerk tonen',
    howHeader: 'Hoe het antwoordt',
    thisChatHeader: 'Dit gesprek',
    viewHeader: 'Wat dit gesprek laat zien',
    useDefault: 'Weergave van dit gesprek resetten',
    useDefaultHint:
      'Wist het eigen detailniveau en de zichtbaarheidsinstellingen van dit gesprek en volgt weer de standaard uit Instellingen.',
    usingDefault: 'Volgt de standaard uit Instellingen.',
    usingOverride: 'Dit gesprek heeft een eigen weergave.',
    expensiveTitle: 'Dit model kost meer',
    expensiveConfirm: 'Toch gebruiken',
    cancel: 'Annuleren',

    notMuted: 'Uit',

    textSize: 'Tekstgrootte in chat',
    textSizes: {
      small: 'Klein',
      default: 'Standaard',
      large: 'Groot',
      xlarge: 'Extra groot'
    }
  },

  notifications: {
    label: 'Meldingen',
    title: 'Meldingen',
    subtitle: (bot: string) => `Waarover ${bot} je een melding mag sturen`,
    hint: 'Deze vervangen de algemene typen uit Instellingen, alleen voor deze chat.',
    following: 'Volgt de typen uit Instellingen.',
    overridden: 'Deze chat heeft eigen typen.',
    useDefault: 'Gebruik de algemene typen',
    types: {
      turnDone: 'Beurt afgerond',
      turnFailed: 'Beurt mislukt',
      needsInput: 'Heeft je antwoord nodig',
      cron: 'Geplande uitvoeringen',
      cronDone: 'Geplande uitvoering afgerond',
      cronFailed: 'Geplande uitvoering mislukt'
    }
  },

  sessions: {
    branch: 'Vertak vanaf hier…',
    branchTitle: 'Vertakking',
    branchFailed: 'Dit gesprek kon niet vertakt worden.',
    branches: 'Vertakkingen',
    conversations: 'Gesprekken',
    branchOf: (title: string) => `Vertakking van ${title}`,
    backToMain: 'terug naar de hoofdchat',
    openNow: 'Nu openen',
    branchMade: (title: string) => `Vertakt naar ${title}.`,
    adopt: 'Maak dit de Bot Chat',
    adoptFailed: 'De gateway wilde dit niet de Bot Chat maken.',
    renameFailed: 'Dit gesprek kon niet hernoemd worden.',
    loading: 'Gesprekken van deze bot lezen…',
    loadFailed: 'De gesprekken van deze bot konden niet gelezen worden.',
    pin: 'Vastzetten',
    unpin: 'Losmaken',
    refresh: 'Verversen',
    refreshFailed: 'Deze chat kon niet ververst worden.',
    past: 'Eerdere gesprekken',
    pastEmpty: 'Alleen het huidige gesprek.',
    open: 'Openen',
    rename: 'Hernoemen',
    renameTitle: 'Gesprek hernoemen',
    delete: 'Verwijderen',
    deleteTitle: 'Dit gesprek verwijderen?',
    deleteBody: (title: string) => `${title} wordt van de gateway verwijderd. Dit kan niet ongedaan worden gemaakt.`,
    deleteConfirm: 'Verwijderen',
    deleteFailed: 'Dit gesprek kon niet verwijderd worden.',
    cancel: 'Annuleren',
    canonical: 'Huidige gesprek',
    whose: 'Dit gesprek',
    shared: 'Gedeelde Bot Chat',
    mine: 'Mijn chat',
    mineGroup: 'Mijn chat',
    sharedNote: 'Iedereen op deze gateway deelt dit gesprek.',
    mineNote: 'Alleen jij ziet dit gesprek. De bot houdt zijn eigen geheugen bij.',
    switchFailed: 'Er kon niet naar de andere chat geschakeld worden.',
    busy: 'Wacht tot het antwoord klaar is of maak eerst de wachtrij leeg.',
    retired: 'Afgesloten',
    messages: (count: number) => (count === 1 ? '1 bericht' : `${count} berichten`)
  },

  conversations: {
    groupChat: 'Groepschat',
    yourChats: 'Jouw chats',
    yoursEmpty: 'Begin een eigen chat om hem hier te zien.',
    newChat: 'Nieuwe chat',
    newChatFailed: 'De gateway wilde geen nieuwe chat starten.',
    firstChat: 'Mijn chat',
    allConversations: 'Alle gesprekken',
    renameLabel: 'Naam van de chat',
    columnTitle: 'Gesprekken',
    showColumn: 'Gesprekken tonen',
    hideColumn: 'Gesprekken verbergen',
    openFailed: 'Dit gesprek kon niet geopend worden.'
  },

  voice: {
    header: 'STEM',
    codeBlock: (lines: number) => (lines === 1 ? 'Codeblok, 1 regel' : `Codeblok, ${lines} regels`),
    autoRead: 'Antwoorden voorlezen',
    autoReadHint: 'Elk afgerond antwoord in deze chat, zonder dat je erom vraagt.',
    rate: 'Spreeksnelheid',
    // Traag / Traagst in plaats van langzaam / langzaamst: vijf opties delen
    // één rij, en `Langzaamst` past daar niet in.
    rateOptions: {
      slowest: 'Traagst',
      slow: 'Traag',
      normal: 'Normaal',
      fast: 'Snel',
      fastest: 'Snelst'
    },
    dictationLanguage: 'Dicteertaal',
    dictationAuto: 'Taal van apparaat',
    confirmBeforeSending: 'Bevestig voor versturen',
    confirmBeforeSendingHint: 'Stemmodus laat eerst even zien wat er verstaan is.',
    stopOnBackground: 'Stoppen als de app sluit',
    dictate: 'Dicteren',
    dictateStop: 'Stoppen met dicteren',
    listening: 'Luisteren…',
    permissionDenied: 'Hermie heeft de microfoon nodig om te dicteren.',
    openSettings: 'Instellingen openen',
    unavailable: 'Dicteren is niet beschikbaar op dit apparaat.',
    noSpeech: 'Er is niets gehoord.',
    failed: 'Dicteren stopte onverwacht.',
    mode: 'Stemmodus',
    modeStart: 'Stemmodus starten',
    modeLeave: 'Stemmodus verlaten',
    modeListening: 'Luisteren',
    modeSending: 'Versturen',
    modeThinking: 'Wacht op antwoord',
    modeSpeaking: 'Spreken',
    modeInterrupt: 'Tik om te onderbreken',
    modeDismiss: 'Veeg omlaag om te verlaten',
    modeCancel: 'Annuleren'
  },
  sheet: {
    close: 'Sluiten'
  }
}
