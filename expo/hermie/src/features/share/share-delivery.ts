/**
 * Turning what another app shared into one message in a chat.
 *
 * The share sheet wrote an entry and went away. This is the other half: read
 * the entries, work out which chat each belongs to, move the files by the roads
 * the composer already uses, send ONE message, and only then clear the entry.
 *
 * ## The entry is the queue, and that is deliberate
 *
 * Nothing is remembered in JavaScript that matters. An entry lives on disk in
 * the shared container until it has been sent, so the app being killed between
 * the share and the send costs nothing — the next launch finds it exactly where
 * the sheet left it. The in-memory list below is a VIEW of that directory, kept
 * so a badge can be drawn and a picker can be offered, and it is rebuilt from
 * disk on every pump rather than treated as the truth.
 *
 * That is also why delivery clears the entry last. A send that succeeded and an
 * entry that was cleared are two writes with a gap between them, and the gap
 * has to fail towards "sent twice, visibly" rather than "sent nowhere,
 * silently": a duplicate message is something the reader can see and delete,
 * and a share that evaporated is something they will never know happened.
 *
 * ## One message, whatever was shared
 *
 * Five screenshots and a note are ONE prompt with five attachments, not six
 * messages. The bot is being asked about a thing, and a thing that arrives in
 * six pieces has to be reassembled by the model before it can be read.
 *
 * The two roads are the composer's own, unchanged: an image is read into base64
 * and attached over the socket, a file is streamed to the gateway over HTTP and
 * named in the prompt by the `@file:` token. `ChatController.send` appends the
 * tokens itself, so the text handed over here is the words and nothing else.
 *
 * ## What happens when it cannot be sent yet
 *
 * Nothing, loudly. A share that arrives while the gateway is down stays in the
 * outbox, the bot's row gets a badge saying something is waiting, and the next
 * pump — a foreground, a reconnect — tries again. A failure during delivery is
 * the same state: the entry is left alone and retried, because the alternative
 * is discarding somebody's file on a 500.
 *
 * The one thing that is NOT retried is an entry that cannot be read at all. A
 * manifest from a version this build does not understand, or one whose files
 * the system has reclaimed, would be retried forever and is cleared instead.
 *
 * ## The one entry this will not touch
 *
 * Since ADR-0026 the iOS share extension may deliver an entry itself, and it
 * writes a CLAIM immediately before it submits. An entry that still has a claim
 * on it is one where the gateway was handed a message and the answer was never
 * seen — the sending process was torn down inside that window — so both of the
 * things this flow could do are wrong: sending produces a duplicate in somebody's
 * chat, and clearing loses what they shared.
 *
 * So a claimed entry is never delivered automatically, whatever bot it names. It
 * goes to the picker, which says it may already have gone and offers "Send
 * again" and a discard. That is the ONE place in this feature where a person is
 * asked, and it is asked because the alternative is a program guessing on
 * somebody's behalf about a message it cannot see.
 *
 * Note which way this reverses the gap above. Before delivery this flow still
 * fails towards "sent twice, visibly", because nothing else knows anything. The
 * extension's path cannot afford that — it has no badge, no screen and no next
 * launch — so it buys the same safety by writing down that it tried, and the
 * ambiguity becomes a question instead of a duplicate.
 */
import type { AttachmentInput } from '../chats/chat-controller'
import type { UploadableFile, UploadedFile } from '../chats/file-upload'
import type { ShareInbox } from '../../platform/share-inbox'
import { parseShareEntry, shareFiles, shareMessageText, sortShares, type PendingShare } from './outbox'

/**
 * Everything this needs from the rest of the app, as functions.
 *
 * Ports rather than the controller itself, for the reason every other
 * controller in this app takes ports: the delivery flow is the part worth
 * testing, the gateway is the part that cannot be, and a test that has to build
 * a `ChatController` to prove that a URL and a photo become one message is a
 * test about the wrong thing.
 */
export interface ShareDeliveryPorts {
  inbox: ShareInbox
  /** Whether the gateway socket is usable. Nothing is attempted while it is not. */
  ready: () => boolean
  /**
   * Resume this bot's chat and bring it on screen.
   *
   * BOTH halves, and the order matters: the upload needs the session's working
   * directory, which only arrives with `session.resume`, so a share delivered
   * into a chat that was never opened would have nowhere to put its files.
   * Rejects for a bot the roster does not have, which is what sends the entry
   * back to the picker.
   */
  open: (bot: string) => Promise<void>
  upload: (bot: string, file: UploadableFile) => Promise<UploadedFile>
  /** One image file as the bytes `image.attach_bytes` takes, already resized. */
  readImage: (uri: string, filename: string) => Promise<{ filename: string; base64: string }>
  send: (bot: string, text: string, attachments: AttachmentInput[]) => Promise<void>
  /** Told whenever the waiting set changes, so a badge and a picker can follow. */
  onChange: (waiting: readonly PendingShare[]) => void
}

export class ShareDelivery {
  private readonly ports: ShareDeliveryPorts

  /** Everything read off disk and not yet sent, oldest first. */
  private waiting: PendingShare[] = []

  /**
   * Bots chosen in the picker, by entry id.
   *
   * Held here rather than written back into the manifest, and the trade is
   * worth stating: an app killed between the pick and the send asks again. That
   * is a second tap in a case that needs the app to die inside two seconds,
   * against a write into another process's directory that would have to be made
   * atomic to be safe. The pick is cheap to repeat; the write is not cheap to
   * get right.
   */
  private readonly chosen = new Map<string, string>()

  /**
   * Notes typed in the in-app picker, by entry id.
   *
   * Held beside `chosen` and lost in the same circumstances, for the same
   * reason. An entry that already carried a note keeps it when nothing was
   * typed, which is what makes the picker's pre-filled field safe: showing
   * somebody a note and then sending a different one would be worse than not
   * showing it.
   */
  private readonly notes = new Map<string, string>()

  /**
   * Ids that failed during THIS pump, so one is attempted at most once per pump.
   *
   * Cleared at the start of every pump that is not a re-entrant one, which is
   * what makes the retry in the module comment real: a foreground, a reconnect
   * or a share link each start a new pump and each tries again. What it stops
   * is the `again` loop below going round on an entry that has just failed —
   * a gateway refusing an upload would otherwise be retried as fast as the
   * event loop allows.
   */
  private readonly failed = new Set<string>()

  private pumping = false
  /** A pump asked for while one was running. Runs once, not once per request. */
  private again = false

  constructor(ports: ShareDeliveryPorts) {
    this.ports = ports
  }

  /** Everything still waiting, for a screen that wants to read it synchronously. */
  get pending(): readonly PendingShare[] {
    return this.waiting
  }

  /**
   * Read the outbox and send whatever can be sent.
   *
   * Called on launch, on every foreground, and whenever the gateway becomes
   * ready — the three moments at which the answer can have changed. It never
   * rejects: a share that could not be delivered is a badge, not an exception
   * thrown inside an `AppState` listener.
   */
  async pump(): Promise<void> {
    if (this.pumping) {
      this.again = true

      return
    }

    this.pumping = true
    // A new pump is a new chance. See `failed`.
    this.failed.clear()

    try {
      do {
        this.again = false
        await this.pumpOnce()
      } while (this.again)
    } finally {
      this.pumping = false
    }
  }

  /**
   * Answer the picker: this entry goes to this bot.
   *
   * It pumps rather than delivering directly, which clears `failed` on the way
   * — a pick is a person saying "try again", and the commonest reason an entry
   * failed is that it named a bot the roster no longer has.
   *
   * It is also the only thing that overrides a claim. A person who has been told
   * "this may already have been sent" and tapped "Send again" has answered the
   * one question this flow cannot answer itself, and their answer stands for as
   * long as the entry does.
   */
  async assign(id: string, bot: string, note?: string): Promise<void> {
    this.chosen.set(id, bot)

    if (note !== undefined) {
      this.notes.set(id, note)
    }

    await this.pump()
  }

  /** The picker's other answer. The entry goes, and nothing is sent. */
  async discard(id: string): Promise<void> {
    this.chosen.delete(id)
    this.notes.delete(id)
    this.failed.delete(id)
    await this.ports.inbox.clear(id)
    this.waiting = this.waiting.filter(share => share.id !== id)
    this.ports.onChange(this.waiting)
  }

  private async pumpOnce(): Promise<void> {
    if (!this.ports.inbox.available) {
      return
    }

    await this.refresh()

    if (!this.ports.ready()) {
      return
    }

    // A copy, because delivery mutates `waiting` as each entry leaves.
    for (const share of [...this.waiting]) {
      const bot = this.chosen.get(share.id) ?? share.bot

      if (!bot || this.failed.has(share.id)) {
        continue
      }

      /*
        A claim without a pick is a question, not work. See the module comment:
        the entry was handed to a gateway by a process that did not survive to
        hear the answer, so sending it here might duplicate it.

        `chosen` is what clears it, and only a person puts anything in `chosen` —
        so this reads as "nobody has answered the question yet" rather than as a
        second flag to keep in step.
      */
      if (share.claim && !this.chosen.has(share.id)) {
        continue
      }

      await this.deliver(share, bot)
    }
  }

  /**
   * Rebuild the waiting list from the directory.
   *
   * An entry that cannot be read is cleared here rather than kept as a
   * permanently failing item. The two ways that happens — a manifest from a
   * newer build, and files the system has reclaimed — are both states in which
   * nothing can ever be sent, and an outbox that only grows is a shared
   * container slowly filling with somebody's photographs.
   */
  private async refresh(): Promise<void> {
    const entries = await this.ports.inbox.list()
    const next: PendingShare[] = []

    for (const entry of entries) {
      const share = parseShareEntry(entry)

      if (share) {
        next.push(share)
      } else {
        await this.ports.inbox.clear(entry.id)
      }
    }

    const sorted = sortShares(next)
    const changed =
      sorted.length !== this.waiting.length || sorted.some((share, index) => share.id !== this.waiting[index]?.id)

    this.waiting = sorted

    // The ids that are gone cannot come back: an id is a directory name and is
    // minted once, so keeping their bookkeeping is a slow leak.
    for (const id of [...this.chosen.keys()]) {
      if (!sorted.some(share => share.id === id)) {
        this.chosen.delete(id)
      }
    }

    for (const id of [...this.notes.keys()]) {
      if (!sorted.some(share => share.id === id)) {
        this.notes.delete(id)
      }
    }

    if (changed) {
      this.ports.onChange(this.waiting)
    }
  }

  /**
   * One entry, into one chat, as one message.
   *
   * The chat is opened first because the upload needs the working directory the
   * resume reports, and it is opened even when there is nothing to upload: a
   * share that lands in a chat the reader cannot see is a message they will
   * find tomorrow, which is not what tapping "Send" in a share sheet promised.
   */
  private async deliver(share: PendingShare, bot: string): Promise<void> {
    try {
      await this.ports.open(bot)

      const attachments: AttachmentInput[] = []

      for (const file of shareFiles(share)) {
        if (file.kind === 'image') {
          const image = await this.ports.readImage(file.uri, file.filename)

          attachments.push({ kind: 'image', filename: image.filename, base64: image.base64 })

          continue
        }

        const uploaded = await this.ports.upload(bot, {
          name: file.filename,
          size: file.size,
          mimeType: file.mimeType,
          uri: file.uri
        })

        attachments.push({ kind: 'file', filename: uploaded.filename, path: uploaded.path })
      }

      const note = this.notes.get(share.id)

      await this.ports.send(bot, shareMessageText(note === undefined ? share : { ...share, note }), attachments)
    } catch {
      // Left in the outbox on purpose. The badge stays, the next pump tries
      // again, and the one thing that must not happen — somebody's file quietly
      // discarded because a gateway answered 500 — cannot.
      this.failed.add(share.id)

      return
    }

    // LAST. See the module comment on which way this gap has to fail.
    await this.ports.inbox.clear(share.id)
    this.chosen.delete(share.id)
    this.notes.delete(share.id)
    this.waiting = this.waiting.filter(entry => entry.id !== share.id)
    this.ports.onChange(this.waiting)
  }
}
