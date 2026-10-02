/**
 * `features/profiles/strings.ts` in German.
 *
 * Type-only import of the English table, so this file can be read by
 * `catalogue.ts` without a runtime cycle back into the strings it translates.
 */
import type { profileStrings } from '../../features/profiles/strings'
import type { Translation } from '../catalogue'

export const profiles: Translation<typeof profileStrings> = {
  settings: {
    newBot: 'Neuer Bot…',
    newBotHint: 'Leg einen weiteren Bot auf diesem Gateway an'
  },

  new: {
    title: 'Neuer Bot',
    eyebrow: 'Ein eigener Bot',
    handleHint:
      'Kleinbuchstaben, keine Leerzeichen. Unter diesem Namen kennt das Gateway ihn, und er lässt sich später nicht mehr ändern.',
    displayName: 'Anzeigename',
    displayNameHint: 'Was Hermie in der Liste zeigt. Leer lassen, um den Handle zu verwenden.',
    description: 'Beschreibung',
    descriptionPlaceholder: 'Schlägt Dinge nach, bevor jemand fragt.',
    model: 'Modell',
    modelInherit: 'Vom Start-Bot erben',
    modelHint: 'Ein neuer Bot erbt das Modell des Gateways, solange du hier keines festlegst.',
    cloneFrom: 'Einstellungen klonen von',
    cloneNone: 'Neu anfangen',
    cloneHint:
      'Ein Klon übernimmt die Skills, Tools und MCP-Schalter des Quell-Bots. Seine Messaging-Konten werden nie kopiert — zwei Bots können nicht ein Telegram-Token halten.',
    create: 'Bot anlegen',
    cancel: 'Abbrechen',
    creating: 'Bot wird angelegt…',
    failed: (reason: string) => `Der Bot konnte nicht angelegt werden: ${reason}`,
    withoutModel: 'Dieser Bot hat noch kein Modell. Wähl eines in seinem Profil, bevor du ihm schreibst.'
  },

  capabilities: {
    row: 'Fähigkeiten',
    rowDetail: 'Skills, Tools und MCP-Server für diesen Bot',
    title: 'Fähigkeiten',
    loading: 'Konfiguration dieses Bots wird gelesen…',
    failed: (reason: string) => `Die Konfiguration konnte nicht gelesen werden: ${reason}`,
    saveFailed: (reason: string) => `Das Gateway hat die Änderung abgelehnt: ${reason}`,
    toolsetsUnpinned:
      'Dieser Bot folgt den Vorgaben des Gateways. Ein Schalter, den du umlegst, fixiert die ganze Liste.',
    toolsetsPinned: 'Für diesen Bot fixiert.',
    toolCount: (count: number) => `${count} ${count === 1 ? 'Tool' : 'Tools'}`,
    skillsEmpty: 'Für diesen Bot sind keine Skills installiert.',
    skillsFooter: 'Skills sind Ordner mit Anweisungen, die der Bot öffnen kann, wenn er sie braucht.',
    mcpEmpty: 'Auf diesem Gateway sind keine MCP-Server konfiguriert.',
    mcpFooter: 'Einen Server hier einzuschalten macht seine Tools für diesen Bot verfügbar.',
    manageMcp: 'Server verwalten…',

    reload: {
      title: 'Auf laufende Chats anwenden?',
      eyebrow: 'MCP neu laden',
      body: 'MCP-Server werden für jeden laufenden Chat neu geladen. Die nächste Nachricht in jedem Chat sendet ihre gesamte Eingabe erneut.',
      // „Jetzt neu laden“ overflows the button; the sheet's title says when.
      now: 'Neu laden',
      always: 'Neu laden, nicht fragen',
      alwaysHint: 'Das Gateway fragt dann nicht mehr — auch nicht in der CLI und der Desktop-App.',
      // „Jetzt nicht“ overflows; „Später“ is the same refusal, shorter.
      later: 'Später',
      done: 'MCP-Server neu geladen.',
      failed: (reason: string) => `Neu laden fehlgeschlagen: ${reason}`
    }
  }
}
