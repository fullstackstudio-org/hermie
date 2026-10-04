# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **An `@` in a gateway address's path no longer decides which host it names.** The check that
  tells a private network from the open internet read `http://public.example/@10.0.0.1` as the host
  `10.0.0.1`, so a public gateway over plain http got the calm private-network wording instead of
  the warning, and the onboarding probe could miss a redirect to a different host whose path ended
  in the original host's name. Only the part before the path now counts.
- **Gateway credentials no longer follow a redirect.** When a gateway, or something in front of it,
  answered a call with a redirect to another address, the app followed it and sent the Cloudflare
  Access headers and the session token along, on Android even from https to plain http. Calls that
  carry credentials now stop at a redirect and report it, and the Android app no longer follows a
  redirect to a different address at all. On iOS the platform already dropped the headers, and the
  answer from the other address is now refused as well.
- **A gateway address that redirects from https to http, or to another port, is caught during
  setup.** The address check only compared host names, so `https://gateway` redirecting to
  `http://gateway` was accepted and every later call was downgraded. Setup now refuses it and offers
  the address the redirect pointed to, port and IPv6 brackets included.
- **The sign-in page can no longer be sent to another address on the device.** The in-app sign-in
  only caught its own callback address spelled exactly one way, so `http://127.0.0.1:000038007/…`
  and other spellings of this device were really loaded, where another app could be listening for
  the sign-in code. Any address on the device other than the gateway itself now ends the sign-in.
- **A backslash or a tab in a gateway address no longer hides its host.** The private-network check
  read `http://public.example\@10.0.0.1` as `10.0.0.1`, while the request went to `public.example`.
  It now reads addresses the way the request does.
- **The Cloudflare Access token is no longer sent over plain http while setting up a gateway.** An
  address typed without `https://` is tried over https first and, when nothing answers there, over
  http. That second try reused the headers of the first, so on a network that blocks https a
  configured Access token went out unencrypted. Each try now gets its own headers and the Access
  pair is never on an http one. With a front door configured, setup no longer tries http at all and
  reports why https failed instead.

### Added

- **An agent can ask for a form, a file or a review of a draft, in the native Apple apps (0.2.9) and in the
  web client.** Beside an approval and a question, the gateway can now send `input.form` (one to twelve typed
  fields: text, number, amount, date, time, datetime, date range, choice, toggle), `input.file` (one or more
  files) and `review.draft` (a mail, post or message to approve, change or reject), from the tools `ask_form`,
  `ask_file` and `review_draft` in the gateway's `interactive` toolset (off by default). Each opens as a sheet
  that names the agent and the gateway, shows the agent's words as plain text, checks a form the way the gateway
  does, and shows a draft verbatim with every invisible character marked. A file request offers the photo
  library, Files, the camera and, on an iPhone or iPad, the document scanner. Pictures lose their location data
  when the agent asks for it, files go flat into the directory the gateway names with their SHA-256, and what
  is typed or picked is never kept: not in the transcript, a cache, a draft or a log. **Later** puts a sheet
  away without answering (the transcript's card opens it again), **Don't share** tells the agent the person
  chose not to provide it, and a request survives a reconnect or is closed with a notice saying why. In the
  native apps an approval or a passkey confirmation steps in front of a form that is open. A push notification
  says that an agent has a form, a file request or a draft for you, and carries none of its text (`docs/web.md`,
  `docs/native.md`, `contract/requests`).
- **The MCP page in Settings and the agent label.** Settings has an MCP page with the gateway's endpoint and the
  clients connected to it, and a client can be revoked. A turn an agent sent on the person's behalf is drawn as
  `<name> via <client>` under its bubble, in the native apps and the web client.
- **The native Apple apps keep your gateways in iCloud Keychain.** The gateway list and the
  credentials that are the same on every device (session tokens, Cloudflare Access service tokens,
  custom headers) reach your other Apple devices without typing; sign-ins through an identity
  provider or a password stay on each device. Sync is on by default and asks once per device before
  it first stores anything. Settings → Gateways → iCloud Sync has the switch, "Sync this gateway",
  "Sync Now" and "Delete Everything from iCloud Keychain", and removing a synced gateway asks whether
  to remove it from this device or from all of them (ADR-0032).
- **Hermie Web delivers to the native Apple apps through the push relay.** A registration with
  `transport: "relay"` is sent through `POST /v1/send` on the project's relay, with the bot's name and
  the event type only. The daemon posts only to relays on its own allow-list (`--push-relays`, env
  `HERMIE_PUSH_RELAYS`, default `https://push.hermie.dev`), and lists `push.relay` among the
  capabilities in its availability stamp.

### Changed

- **Hermie Web leaves to the gateway's plugin what the plugin delivers.** With the `hermie` plugin's
  push module on, `hermie-web --push` no longer sends the Expo notifications (and relay ones on the
  plugin's relays) that the plugin sends too, so a device is not told everything twice. Web Push and
  bot-to-bot DMs are still sent by Hermie Web. `--push-ignore-plugin` (`HERMIE_PUSH_IGNORE_PLUGIN`)
  sends everything regardless, for a gateway whose plugin is gone but whose advert was left behind.
- **Hermie Web's Expo notifications name an Android channel per type.** Expo app 0.1.9 has no such
  channels, so on Android it shows them on the system's fallback channel until it is updated.
- **The gateway client's native sign-out ends the sign-in at the gateway too.**
  `NativePkceCredentials.signOut` used to delete the tokens only, and the sign-in stayed valid at
  the identity provider until it expired. On a gateway that advertises `native_revoke`, it now
  first sends the refresh token to `POST /auth/native/revoke`. That call is best effort and waits
  at most three seconds; the tokens are deleted whatever it answers. The fake gateway serves the
  route (`--no-native-revoke` stages a gateway without it).

### Fixed

- **Swiping back out of a chat no longer crashes the native apps.** A queued layout pass kept the transcript
  list alive past its coordinator, and its hooks then read a coordinator that was already gone. The hooks now
  let go of it, on iOS, iPadOS and the Mac.
- **A reply no longer appears twice after a reconnect mid-turn.** When the socket dropped and came back while
  the agent was working, the history read settled the reply onto its row, the closing message then found
  nowhere to land and stood the same words up a second time, and the turn never settled. The reply is now found
  from the turn's receipt, and a completion that goes on past a row's text still gets a bubble of its own.
- **The chat title is centred, and a running tool is named like the transcript names it.** The title column sits
  between the back button and the buttons on the right and shortens a long status inside itself instead of
  pushing the name to the left; the status drops the `mcp__` prefix of a tool.
- **The Mac's chat title pill has more room**, and a wider default, and the newest message no longer touches the
  composer on the Mac (and sits clear of it on iPhone and iPad).
- **The Mac's Settings sidebar is evened out.** Every row and every gap between groups comes from the system, the
  toggle button that was drawn at the top of the column is gone, and the sidebar still collapses from
  View > Show/Hide Sidebar or by dragging its divider, with the collapsed state kept per window.
- **Malformed gateway addresses no longer get a gateway key or front-door credentials.** An address
  such as `example.com:9119` (no scheme) gave the same notification key as every other address of
  its kind; it now gives none, as an unparseable one already did. An address with a secure scheme
  and no host, such as `wss://`, no longer receives the Cloudflare Access headers, and the sign-in
  callback check accepts only port numbers up to 65535.
- **Allow and Deny on Hermie Web's approval notifications.** Hermie Web sent the category
  `hermie.approval`, which no app build registers, and the request id under `request`, which no app
  build reads. It now sends `hermie.request` and `requestId`, as the push contract says, and an
  Android channel per notification type.
- **The Expo app reads both spellings for one release.** It registers the contract's
  `hermie.request` category with `hermie.request.allow` and `hermie.request.deny`, keeps the older
  `request` and `hermie.approval` categories and `allow` / `deny` actions working, reads `requestId`
  and the older `request`, and declares one Android channel per notification type.

## [0.1.9] - 2026-09-24

### Added

- **Hermie Web configures itself from the environment.** Every command-line option now has an
  environment variable (`HERMIE_GATEWAY_URL`, `HERMIE_PUBLIC_URL`, `HERMIE_STATE_DIR`, …), so a
  container or a Kubernetes Deployment can set it up without overriding its arguments. `--help`
  names the variable next to each option, and a bad value stops the start with the variable's name.
  `deploy/k8s/` has sidecar and standalone examples with probes, a NetworkPolicy and a restricted
  security context.
- **A container image for Hermie Web.** Every release now publishes
  `ghcr.io/fullstackstudio-org/hermie-web` for amd64 and arm64, tagged with the version.
- **Switch off sign-in with SSO.** `HERMIE_OIDC=0` hides the SSO option in the web app and makes
  Hermie Web refuse the gateway's SSO routes, whatever the spelling of the path; password sign-in,
  also from the native app, keeps working.
- **Admins from the container.** `HERMIE_ADMINS` names gateway user ids that are always Hermie Web
  admins and cannot be removed from the admin pages; admins added by hand are kept as before.
  `HERMIE_LOCAL_ADMIN_PASSWORD_HASH` sets the local admin password as a hash, and
  `hermie-web hash-secret` makes one.
- **Hermie Web on a domain of its own.** With `--pass-host` and `--web-public-url`, Hermie Web sends
  its own address to a gateway that lists it in `dashboard.public_urls`, so sign-in, SSO included,
  comes back to Hermie Web's own domain. At start it checks that the gateway accepts the address
  and falls back to the old behaviour, with a line saying what to add, when it does not.

### Security

- **Hermie Web no longer disguises another site's requests as its own.** It rewrote every browser
  `Origin` to the gateway's own, which switched off the gateway's cross-origin checks for requests
  that came through Hermie Web. Only Hermie Web's own origin is rewritten now; any other origin
  reaches the gateway as sent and is refused there unless the gateway lists it.

### Fixed

- **The text-size choices fit on a phone.** "Standaard" and "Extra groot" were cut off in the chat
  options on a phone; each choice is now as wide as its label, so all four fit in English, Dutch
  and German. The export row reads "Export" instead of "EXPORT".
- **Hermie Web reports its own version again.** Its version number was left behind at 0.1.6 by the
  release script; it now moves with the app's, and a test fails when the versions disagree.
- **A sent message no longer stays behind in the composer.** On the Mac, and on an iPad with a
  keyboard, a key pressed straight after Return could reach the field before the clear did — and
  the field then reported the sent message with that key stuck to it, which became the draft. For
  half a second after a send, on iPhone, iPad and Mac only, the composer now recognises a report
  that is exactly the sent message plus one keystroke and takes the message back off it. A key
  typed on a field that did clear is always kept, even one that repeats the message before or, on
  a Korean or Japanese keyboard, rewrites the character before it; anything that adds more than
  one character, such as a paste, is left alone. A second Return that reaches the field before the
  clear does, or a tap on the send button right after Return, no longer sends the message, or its
  attachments, twice. Return sends the draft as it stands, where it could send it one keystroke
  behind. And a dictation still running, or still owing its final
  result, is ended by the send instead of writing the sent sentence back.
- **The chat list's status marks keep the one order they were given, and a test now says so.**
  The muted bell, pin and pending-share mark already draw as one run on the big name's line,
  immediately left of the time — a regression test now pins the exact order (name, then the
  marks, then the time) so a future change that puts a mark back between the name and the
  display name, which is the bug this row shipped with, fails the suite rather than reaching
  a reader.

### Changed

- **"Use the default view" says what it does.** The button that clears a conversation's own
  verbosity and visibility settings read like a switch to a view called "default", not like
  the reset it is. It is "Reset this conversation's view" now, in the chat's (…) menu and in
  Chat options, with one line under it saying what gets cleared and that the chat goes back
  to following Settings — in English, Dutch and German. Its behaviour is unchanged.

## [0.1.8] - 2026-09-24

### Added

- **A face on the people in Hermie, not just their name.** Signing in through a gateway that hands
  back an email and a picture now shows both: Settings → Account draws the signed-in person's picture
  where it drew an initial before, and their email underneath their name; a colleague's picture
  appears beside their name at the head of their run in the shared Bot Chat the moment it has been
  fetched — not on the next message — fetched by their identity and cached per gateway so two
  gateways never mix up whose picture is whose. A gateway that
  sends neither — an upstream Hermes, or a fork account with nothing held — keeps drawing the tinted
  initial exactly as before, and a picture that 404s or fails to load falls back to it too, without
  asking again for the rest of the session.
- **A name on every message in the shared Bot Chat.** Somebody else's message now draws as an
  incoming bubble — their name over its first line in their own colour, their avatar beside it — the
  way any messenger shows a group, instead of the reader's own silhouette it drew before regardless
  of who actually sent it. The name is inked from the sender's identity, never their display name, so
  a rename cannot recolour a conversation and two people who share a name cannot merge; it uses eight
  colours already in `ui/tokens.ts` — `red` and `green` are left out because they are `danger` and
  `ok`, not a name colour — and `scripts/check-contrast.ts` measures those eight sender inks against
  the panel, every elevation rung and the sunk tint, in every theme and both schemes — no new colour
  was added. A message the gateway did not attribute — sent before this shipped, or from
  the Hermes dashboard or the TUI — keeps drawing exactly as it always has: nobody is named on a guess.
  The reader's own messages are recognised by the identity the gateway stamps on them —
  `<provider>:<user id>`, built from `/api/auth/me` exactly the way the gateway builds it — so they
  stay on the right, unnamed, from the moment they are sent through every reload; and two people who
  both send "ok" stay two messages rather than one taking the other's place. A name is somebody
  else's text, so it is held to one line of at most 80 characters and stripped of control characters
  and of the invisible marks that can reverse the text around them. Shown only in the shared Bot
  Chat, decided by which conversation is actually open rather than by the reader's last choice: a
  personal conversation (one an older build remembered by its title alone included), a branch and a
  retired one are unchanged, and a switch that is refused never briefly names anybody.
- **The same name reaches the chat list, an exported transcript and a screen reader.** The shared Bot
  Chat's row in the chat list now leads its preview with the sender — `Robin: draft is ready` — the
  same way an inbound teammate DM already prefixed a handle; a `.md` or `.txt` export of the
  conversation puts every attributed message under the sender's own name instead of the reader's,
  with any Markdown in a speaker's name — a person's or a bot's — escaped in the `.md` file; and
  a bubble whose visible name is suppressed because it continues a run still carries the sender in its
  accessibility label, once, so a screen reader is never left to guess whose turn it is reading. All
  three read the identical gate the bubble itself does — the shared Bot Chat, an attributed row,
  somebody other than the reader — so a personal conversation, a branch, a retired one, the reader's
  own turns and an unattributed row are unchanged everywhere this shows up.

### Changed

- **Settings → Gateways is "Gateway", singular, in the browser.** Hermie Web is proxied to one
  gateway by the server in front of it, so there is no second one to list, add, switch to or forget —
  the category there is now purely informative: the address, the version, the connection's state and
  whether the plugin is running, and nothing else. The category's line of state drops the count too
  (the host alone, never "· 1 gateway"), and `GatewayDetail`/`GatewayAdd` are no longer part of the
  registry the browser build runs — the route walk that proves every page's back control works now
  covers that shape as well as the app's. Joins the conditional the address, host, scheme and port
  rows already hid there rather than adding a second one; nothing changes off the web.
- **Settings looks like something.** HERM-108 gave it the right structure — twelve categories, a page
  each, one back control per route — and the owner's verdict on the result was that it does not look
  like anything. The rows, the pages and the sidebar are redrawn against an iPadOS Settings reference
  he picked, in this app's own material: no new colour, no gradient, and every value out of
  `design/liquid-glass-tokens.md`.

  - **Every category carries a coloured mark** — its icon in white on a rounded square in one of the
    accent set's hues, 28pt in a row and 52pt on a page. The colours are chosen so no two categories
    next to each other share one in any build this app ships, and three accents are deliberately
    never used: `green` and `red` belong to `ok` and `danger`, and a mark that borrows a status hue is
    a mark that can be read as a state; `lime` is the studio's ring colour, which white cannot be seen
    on. The well is the accent's `bubble` value, which is the one colour in each swatch that
    `npm run contrast:check` already measures white against.
  - **Each category page opens with a header card**: the mark large, the category's name, and one new
    sentence saying what the category is for — written in English, Dutch and German. The card is the
    page's heading, so the bar above it no longer draws a second, centred copy of the same word.
  - **The sidebar on iPad and Mac follows the reference's shape.** A search field, then a row for
    whoever this device is signed in as, then the categories as free-standing rows with the open one
    filled and its label in the accent ink — the same selected-row surface the chat list's open bot
    gets. The phone keeps the grouped cards it had, with the new marks in them, and now leads with
    that same account row rather than only the sidebar getting one. Either way it is the single way
    into the Account category: the list underneath it no longer keeps a second row to the same place,
    and the row itself bolds whoever is signed in — falling back to the host, then to the plain
    signed-out wording, only where there is no name to bold.
  - **The search actually searches.** It reads a category's title, the line of state under it, and the
    title of every page underneath it, so "licence" finds About and "MCP" finds Bots & capabilities —
    and a row matched through a page it holds says which page instead of its summary. It is drawn in
    the sidebar only; the phone's list is one screen of twelve rows and does not need one.
  - **Bots & capabilities is two groups rather than one.** "New bot…" makes a bot; Skills, MCP,
    Connectors and Boards are places a bot can reach, and one card could not carry a header true of
    all five rows.

  Nothing moved. The route registry, the back-button behaviour and its 28-route walk, the tab bar, the
  split layout's mechanics and every setting's location are untouched.

- **`npm run contrast:check` measures three more surfaces**: the `e2s` rung, a hovered row and a
  selected one. A selected row carries a name and a line of state and was in no row of that table, so
  a reader could have lost the label of the row they were standing on with every ratio still green.
  All three clear AA in all three themes, both schemes.
- **The sign-in family (sign in, set a password, the invitation, two-factor enrolment, and every
  refusal or done page in between) is redesigned as one centred glass card instead of a form pinned
  to the upper-left corner of an empty page.** The Hermie mark and the deployment's name now sit
  above the card at a size that carries the page, the card itself uses the same flat "glassSheet"
  material and edge highlight the rest of the app's Liquid Glass surfaces use (no gradients, no new
  colours), and the submit button runs the full width of the card the way the app's own primary
  actions do. A refusal (a wrong password, a locked account, a stale invitation) now reads as a
  designed state — a tinted banner with a small danger mark ahead of it — rather than a bare
  paragraph. Presentation only: nothing about what a form posts, how it is validated, or how a
  session or a provider works has changed.
- Fixed a browser-only bug in the same style sheet: every `font` shorthand that ended in `inherit`
  (`font: 700 26px/30px inherit`) is invalid CSS whenever it also sets a size or a weight, so
  browsers silently dropped the whole declaration and these pages were rendering with the browser's
  own default type sizes throughout, not the ones the style sheet specified. The font stack itself
  now lives in one `--ui-font` custom property on `:root`, used by `body` and every one of those
  shorthands, rather than the literal stack repeated in each.

### Removed

- **Settings → Context, and everything it sent.** A bot is no longer told your name, what you wrote
  about yourself, your device, your app's language, or a per-conversation note — none of it is
  collected or sent any more, on the app side or the plugin side. Most of it was already duplicated:
  the gateway itself now confirms who is sending a message, and the timezone comes from the gateway's
  own session rather than from this app. What is genuinely lost is the **device** (phone or Mac) and
  the app's own **language** — a bot no longer knows either, so answers that used to lean on "you're
  on an iPhone" or "the app is in Dutch" will not any more. If you had written something under "About
  me / this device" or a per-conversation note, it stops being sent from this version onward; nothing
  further is required, and the version's own local copy of it is cleared automatically.

### Fixed

- **`Regenerate` and `Edit and resend` in the shared Bot Chat no longer touch a colleague's message
  under the reader's own name.** `Regenerate` was offered on every reply regardless of who asked the
  question it would repeat, and its no-`/retry` fallback pulled the newest `user` row from anybody at
  all despite its own comment claiming otherwise — so pressing it after a colleague's question could
  resend their words as a fresh message from the reader. `Regenerate` is now hidden, not disabled,
  whenever the turn it would repeat is a colleague's, and if a colleague has spoken since the
  reader's own last turn it refuses outright rather than answering their older question instead of
  the one just asked. `Edit and resend` is now offered only on the reader's own messages. Both keep
  working exactly as before outside the shared chat and on a message no gateway attributed to
  anybody.
- **Pasting a file into the composer on the Mac no longer attaches it twice or drops its path into
  the draft as text.** Both were one cause each, not one shared bug: a Finder copy of an image FILE
  puts both a file reference and a rendered image on the general pasteboard, and reading both handed
  JavaScript two attachments with identical thumbnails for what was, to the person who copied it,
  one file — `HermiePasteboard` now reads a file URL and only falls back to the image when there is
  no file behind it at all. Separately, `UIPasteboard` treats a file's URL as string-representable,
  so the field's own Edit ▸ Paste inserts its path as ordinary text through the responder chain
  before the composer even learns a file was there — nothing on that seam can stop it, so the
  composer now undoes that insertion once it knows the paste was a file. The pasteboard's answer and
  the field's own update arrive independently of one another, so the composer watches for the
  insertion over a few frames rather than looking once and possibly looking too early, and it takes
  back out only a span that reads as a single file reference: anything typed in the meantime, a
  slash command included, stays exactly where it was put, as does whatever was already on either
  side of the caret. A pasted image and a plain-text paste are unaffected, on the Mac and in the
  browser alike.
- **The BOTS header in Settings → Bots & capabilities no longer carries its own capitals.** It was
  stored as `'BOTS'` and `InsetGroup` uppercases at render, which is the shape HERM-106 took out of
  every other header in the app.
- **A day divider in a Bot Chat no longer strands a slash command's answer, or a reclaimed-session
  notice, on the wrong side of it.** Both are built locally rather than replayed from history — a
  command's result card is never persisted at all, and a reclaimed-session notice is a broadcast —
  so a re-hydration that folded yesterday's cached chat together with this morning's new rows had
  nothing to match either one against and simply appended it after everything the re-hydration
  brought back, however old it really was. `YESTERDAY` then rendered below `TODAY`'s messages
  instead of above them. Both now keep the place their own timestamp says they belong, the same way
  an answered approval card already did.
- **A cold open no longer draws a colleague's messages as the reader's own for a moment before
  moving them to the left.** The id that decides whose bubble is whose used to be wiped back to
  "unknown" the instant a connection was rebuilt — a launch, a reconnect, a gateway switch — and
  "unknown" reads as "everything is mine", so a cached transcript painted every colleague's bubble
  on the right, receipt included, until `/api/auth/me` answered a moment later and they jumped left.
  The last confirmed id is now kept on disk per gateway and shown while the real answer is on its
  way, corrected the instant it lands, and forgotten only by an actual sign-out, by forgetting the
  gateway, or when the gateway answers that it has nobody to name — never by a reconnect on its own.
- **A colleague's name in the shared Bot Chat can no longer draw as blank, run tall over the bubble
  above it, or read backwards on the chat-list preview.** A name built only from invisible
  characters Unicode itself calls "format" — the word joiner, the invisible tag alphabet a
  flag-sequence emoji is built from — used to slip through the cleaning pass untouched; one built
  only from a Hangul filler blank survived it as text that still shows nothing; and an unbounded run
  of combining accent marks stacked as tall as the sender put them. All three now fall back or are
  capped the way a stray control character already was, and a right-to-left name leading the
  chat-list preview — "שרה: 12 new files" — no longer lets its direction reorder the digits after it.

## [0.1.7] - 2026-09-23

### Added

- **The desktop shell scaffold (`apps/desktop`, Tauri 2).** A window opens on a Hermie Web address
  passed through `HERMIE_WEB_URL` in dev, or on a placeholder page otherwise — the same browser
  build a Hermie Web already serves, unmodified, with the Edit menu's native roles present so
  drag-select and ⌘C/⌘V reach the webview. `npm run desktop` / `npm run desktop:build`. See
  [ADR-0027](docs/adr/0027-desktop-is-a-webview-over-hermie-web.md) and `docs/desktop.md`. The
  gateway list, sign-in, notifications, the full menu, files and platform packaging are not built
  yet.
- **The desktop bridge: the marker, six commands, and a grant per gateway.** The shell tells the
  page it is there (`window.__HERMIE_DESKTOP__`) and offers exactly six commands —
  `hermie_shell_info`, `hermie_set_menu`, `hermie_notify`, `hermie_set_badge`,
  `hermie_open_gateways`, `hermie_close_handled` — of which the first is implemented and the rest
  answer `{ ok: true }` until the tasks that fill them. The app detects all of it at run time
  through `platform/desktop-shell.ts` and imports nothing Tauri, so a browser tab's bundle is
  unchanged and every call is optional in both directions.

  **Only the Hermie Web addresses you configured can use any of it.** The shell registers one
  Tauri capability per configured gateway, matching that address and nothing else, carrying those
  six commands plus event listening and nothing else — no file, shell, dialog, opener, window or
  notification permission. A page on any other address, including an identity provider's page the
  shell passed through mid-sign-in and including a third-party frame inside the app page, cannot
  call a command, cannot register an event listener, and therefore receives no event. Tauri
  refuses the call before any of the shell's code runs, and it reads the address of the frame that
  asked, so a page cannot borrow a configured one by navigating there mid-call. Each command then
  makes a second check of its own that can only ever refuse. `docs/desktop.md` has the contract and
  the verification; forgetting a gateway will relaunch the shell, because a grant cannot be taken
  back.

  `HERMIE_WEB_URL` is read by development builds only — a released build ignores it — and every
  address, however it arrives, passes one validator before it is stored, granted or opened.
- **The desktop shell never drops its connection when its window is hidden**, exactly as the Mac
  build does not. This is the browser build, which reports "background" whenever the document is
  hidden, so without it a ⌘Tab or a minimise would tear the socket down and stop the approval polls.
  A browser tab is unaffected and still pauses.
- **See, open, start, rename and delete a bot's conversations from a list.** A round "conversations"
  button in the chat header — left of `(…)`, shown only on a gateway that knows who you are — opens a
  sheet with the shared group chat first, then your own chats (most recently used first, with a
  preview and an unread mark), a "New chat" row, and a link to the full archive. Renaming commits on
  Return and a delete asks first; a switch that would drop a running reply or a queued message is
  refused with the same notice the switch already used. The `(…)` menu gained its own "New chat" row
  under "Branch from here…". The old switch between the shared chat and "My chat" keeps working
  exactly as it did; this list is a second way in, not a replacement yet.

### Changed

- **Settings is a real settings app, not one long scrolling page.** It opens on a list of twelve
  categories — Account, Gateways, Chats & messages, Notifications, Context about you, Memory,
  Appearance, Privacy & security, Voice, Bots & capabilities, Advanced, About — each with a line
  saying where it stands (the gateway you are on and how many you have, the default verbosity,
  Dark · English), and each opening a page of its own. Every one of those pages — and, sharing the
  same glass header, Activity, Crons and a bot's conversations too — now carries exactly one back
  button, labelled with the page it returns to, and Escape or Android's back does what that button
  does, one level per press. On an iPad or a Mac wide enough, Settings shows the category list
  beside the open page in the main window instead of hiding both behind a panel, the same way
  Boards already did; Activity and Crons still open as a panel over the chat. On the phone, Chats,
  Activity, Crons and Settings are four tabs along the bottom instead of pages pushed over the chat
  list, so none of them is more than a tap away and none of them carries a back button of its own —
  the stray "‹ Bots" is gone, and a cron card opened from a chat still returns to that chat when you
  go back. The bot-name order moved from Appearance to Chats & messages, the theme editor is a page
  under Appearance → Theme now rather than a row of preset cards on the Appearance page itself, and
  the global voice settings — speaking rate, dictation language, confirm before sending, stop when
  the app closes — are reachable outside a chat's options sheet for the first time. Development
  builds keep the connection test and the component gallery, under Advanced.

- **Require unlock is a picker, not a row of five segments.** Privacy & security shows a single
  disclosure row naming the current option; opening it pushes a page listing Off, Now, 1 min, 5 min
  and 15 min with a tick on the one in force, the same list style the model picker uses. Choosing a
  value — Off included — asks Face ID, Touch ID or the device passcode first: the pick only takes
  once that succeeds, and a refused, failed or cancelled prompt leaves the stored value, the lock
  itself and the row exactly as they were, with the reason underneath the list. Choosing the value
  already in force costs no prompt at all. Web keeps its own notice, since there is nothing there to
  ask.

- **A bot with a display name can hide its profile name everywhere it used to show beside it.**
  Chats & messages has a new "Hide profile name" switch, on by default: a bot that has a real
  display name leads with it alone — in the chat list, the chat header, the profile sheet's header,
  memory's bot list and picker, the share sheet and a widget — whichever way the Bot names order
  below is set. That order row is only in effect while the switch is off, and says so while it is on.
  A bot with no display name has one name either way, and the rename field and the profile's own
  "Profile name" fact keep showing and editing the handle regardless — the switch only ever hides a
  SECOND name, never the only one a bot has.

### Removed

- **The gateway's logs page.** Settings no longer has a "gateway's logs" row, and the client no
  longer calls `GET /api/logs`. See `docs/platform-notes.md` for the surface it used to read.

### Fixed

- **The Add gateway wizard is no longer drawn under the glass header.** Its first step sat behind
  the header, which took the taps meant for the address field.

- **An MCP server's test result no longer follows you to another gateway or another bot.** Results
  were remembered by the server's name alone, so a `files` or a `github` configured on two gateways
  shared one answer and a row could show the other machine's "needs authorisation" mark. They are
  now remembered per gateway and per bot, and forgotten when you switch or sign out.

- **A paused cron no longer reads "NEXT 14h ago".** The list row's NEXT/LAST label is now a single
  helper: a paused cron always shows when it last ran (or nothing at all if it never has), and an
  active cron whose next run has slipped into the past says "Overdue" instead of a confusing
  negative relative time.

## [0.1.6] - 2026-09-22

### Added

- **Paste an image or a file straight into the composer.** In a browser tab, pasting takes any
  file on the clipboard the same way a drop already does, resizing an image through the existing
  photo pipeline and uploading anything else through the existing file pipeline — plain text still
  lands in the field untouched. On the Mac, and on an iPad or iPhone with a hardware keyboard, ⌘V
  reads the general pasteboard for an image or a file the same way, without touching the ordinary
  text paste a software or on-screen keyboard already does. Several files in one paste become
  several attachments, and the existing size and type limits apply exactly as they do for a picked
  or dropped file.

- **The app tells the plugin which bot is sending, right before its turn starts.** A plugin
  watching a shared gateway's transcript from the outside never sees `prompt.submit`'s own
  profile field, so it had no way to say who was actually speaking. Where the plugin offers a
  route for it, a normal message and a queued message drained behind a finished turn each name
  the runtime session first; a slash command and a message steered into a turn already running
  never do, since neither one opens a turn of its own. A claim that does not land — an older
  plugin, a slow one, anything short of success — never delays or blocks the send: the turn goes
  out either way.

- **A bot's display name reaches the gateway, where the plugin offers a route for it.** Core's own
  `PATCH /api/profiles/{name}` renames the profile instead of writing a display name, so the name
  used to stay on this device alone and every other client on the gateway kept seeing the old one.
  Where a newer plugin advertises a route for it, Save now writes the name there too, and the app's
  own copy updates immediately so the list does not wait for the next roster read. An older plugin
  gets a quiet line under the field saying the name is kept in the app only, and a refusal — the
  account may not edit profiles, or the name itself is refused — shows its reason beside the field
  and changes nothing on this device.

### Fixed

- **A bot's display name can be saved.** Typing a new name on a bot's profile sheet left **Save**
  greyed out: the field wrote itself into the arrangement on every keystroke, so the button — which
  only ever looked at the description and the picture — had nothing to notice, and a reader who had
  come to rename a bot was left looking at a dead control with nothing on the screen saying the name
  had been kept anyway. The field holds a draft now and Save commits it, which is also what the
  button says. A name-only Save no longer needs a live connection, because that name is the app's
  own; the description and the picture are writes to the profile on the gateway's disk and still do.

- **`Show more` on a long reply now always answers a click, on the Mac.** Every transcript row —
  the fold's toggle included — sits inside the row's own right-click menu, which on the Mac build
  is a native interaction spanning the whole row. A mouse click there arrives as a touch, the same
  kind that interaction has to evaluate for a possible press-and-hold, so it and the toggle's own
  control were racing the same click with nothing deciding which one won — which is why the miss
  was occasional rather than constant. The row's menu now leaves a nested button alone entirely
  instead of racing it, so a click on `Show more`, a tool card's own disclosure or a reasoning
  toggle reaches its control every time; a chat row's own menu is unaffected; the row is still the
  button there.

## [0.1.5] - 2026-09-22

### Changed

- **The People table on `/admin` is a list of people now, not a spreadsheet.** One line each: an
  initials disc tinted from the id, the name in bold with a quiet sentence-case pill for
  administrator, then `username · source` on a second line — no raw subject id in the row, only in
  its title attribute and its own detail section. Columns line up in a fixed grid, "Last seen" is
  one relative stamp ("today 11:58", "22 Sep") with the full timestamp on the pointer, the tiny
  checkboxes are real switches drawn as a track, and the bots multi-select is a one-line summary
  ("All bots", "3 of 7") with the allow-list moved into a per-person panel that also holds the one
  Save button for that row. A gateway sign-in and an account on this service that share a username
  say so, on both rows, without merging them. The explanation is two sentences, with the rest behind
  a "How this list works" disclosure. Below 40rem each row becomes a card.
- **The Accounts table on `/admin/oidc` got the same redesign.** The same row shape — avatar,
  name, inline status pills (administrator, invited, 2FA on, disabled), `Last signed in` as one
  relative stamp — with the subject id, the role select, and Reset password / Clear two-factor /
  Disable / Remove moved into a per-account panel. Role and Save sit on one line; the destructive
  actions are grouped to the right and drawn as quiet outline buttons. The invite form is its own
  card, a 2×2 field grid with Role and one Invite button below it.

### Fixed

- **A roster row no longer overlaps itself.** The second line under a name — `username · source`,
  and the "also an account here" / "also a gateway sign-in" note — is a plain `<span>` with no
  width of its own, so `overflow: hidden` had nothing to clip against and a long one painted
  straight across "Last seen" and "Bots". It is a block now, sized to its column and clipped with
  an ellipsis there; the shared-username note moved to its own third line for the same reason. Every
  cell in a row aligns to the top, against the name, instead of to the centre of a name block that
  is one, two or three lines deep. The three switch headers ("Read-only", "Push", "Administrator")
  are the same size and weight as the rest of the header row now, not a second, smaller table glued
  under it.

## [0.1.4] - 2026-09-22

### Added

- **A bot's memory can be read as it is actually stored, and the graph opens full screen.** The
  memory page has a third tab, **Raw**, with a card per memory backend: the built-in one shows
  `MEMORY.md` and `USER.md` as the gateway holds them — delimiters, blank lines, the real order —
  rather than as the parsed list of entries the Browse tab shows, because a heading or a stray
  delimiter is invisible in a list of rows and is exactly what somebody looking at raw memory wants
  to see. An external provider such as mem0 gets a card too, saying in the gateway's own words that
  it is configured and cannot list what it holds; a backend the gateway does not have says that
  instead, and the two are not the same answer. It is read-only, and says so once. The tab needs a
  route the gateway plugin does not have yet (`GET /api/plugins/hermie/memory/raw`); a gateway
  whose plugin predates it gets that stated with the command that updates it, not a blank tab.
- **The memory graph opens full screen**, from a button on the card. On a phone it takes the window;
  on an iPad or a Mac it is a large panel with the page still visible behind it. Pinch, pan, the
  worded zoom controls and tap-to-select all come with it, the selected node's detail sits under the
  picture with room to read it, and Escape, the hardware back gesture, the backdrop and a close
  control all leave.

- **Sequence diagrams and pie charts are drawn.** A ` ```mermaid ` fence holding a
  `sequenceDiagram` or a `pie` used to be a listing of its own source; both are now pictures, drawn
  in the app the way the flowchart already was — no web view, no download, the same height the
  moment they appear. A sequence diagram has its participants and actors, its lifelines, the seven
  arrow spellings, activation bars, notes over and beside a lifeline, and `loop` / `alt` / `else` /
  `opt` / `par` frames. A pie is a ring with a legend carrying every label, its value and its share.
  Anything still outside the subset — a `gantt`, a `classDiagram`, a `subgraph` — shows the source
  exactly as before, because a picture that quietly leaves out what was asked for is worse than the
  text it was made from.

### Added

- **A deployment can be set up again.** `/admin/danger` has **Run setup again**: it clears the
  gateway `/setup` saved, the administrator list and the local administrator secret, the
  branding, the feature switches, the push policy and cache retention, the per-person options,
  and the service login this server holds for push and the cache — then reopens `/setup`. Two
  boxes let the cached messages and the VAPID key go with it. It asks a second time first, on a
  page that lists every one of those consequences and names the one thing it will not touch:
  the built-in identity provider, whose accounts and signing key `/setup` never wrote and whose
  loss would sign out every account on the gateway.

  On a deployment started with `--gateway` the flag still names one after a restart, so that
  gateway is kept and `/setup` stays closed — and the confirmation page says so before the
  button rather than afterwards.

### Fixed

- **The gateway logs page no longer reports a reply it threw away as an empty file.** It could read
  one spelling of the answer — an object carrying a list of lines — and quietly turned everything
  else into zero lines, drawn as **This log is empty** with Follow still polling. That is a claim
  about the gateway's disk, made by a client that had simply failed to understand what came back.
  The page now also reads a bare list of lines (which is how the neighbouring routine route really
  answers), the two other spellings of the same envelope, one block of text, and lines that arrive
  as objects; and an answer it still cannot read is said out loud, with what came back in it and
  the one command that settles the question, instead of being dressed up as an empty file. A
  refusal now keeps the gateway's own sentence too — "Unknown log file: desktop" used to arrive as
  "failed with HTTP 400" with the useful half dropped in between. The lines themselves sit in a
  horizontal scroller that was missing the guard the app's other two carry, so it could take the
  whole height and leave nothing to see.

### Changed

- **Choosing a model for a new bot is a list, not a strip of slivers.** The New-bot sheet put the
  gateway's whole model inventory into one horizontal segmented bar, and a bar divides a single
  width between its options — so a gateway offering a dozen models gave each label a twelfth of the
  sheet and every one of them was cut to two or three characters. Both choices in that sheet, the
  model and **Clone settings from**, are now a row saying what is picked, opening the same full
  page the chat's own model picker uses: one option per row with its pretty name, the wire id
  underneath, a tick on the current one, a section per provider, and a search field once the list
  is long enough to need one. Picking now stores the `provider/model` pair rather than the label,
  so two providers offering a model of the same name are two different rows instead of one
  ambiguous segment. The chat's own picker gained the provider sections too.

- **Hold a chat and move it.** The chat list's Edit button is gone, and with it the mode that
  revealed a grab handle on every row: a press and hold now lifts the row itself and it follows your
  finger, the way an icon does on the Home Screen. Drop it between two chats to reorder, onto a
  folder to put it in one, at the bottom of the list to take it back out; folders move the same way.
  Holding a row without moving it still opens that row's menu — where the system draws one it is the
  system's, and where it does not the app waits until you let go before opening its own, so a hold
  that becomes a drag never leaves a menu over the row it just lifted. Nothing the mode held is
  lost: **Move up** and **Move down** are on every row for VoiceOver and for a keyboard, a folder is
  renamed where it is drawn from its own menu, and **New folder** is in the header's `…` — which is
  now the same round glass button the chat header carries.

- **Everything a chat row says about itself is in one place now.** The muted bell, the pin and the
  waiting-share mark used to be in two: the bell against the name, the other two in a column beside
  the unread badge — two thirds of a row lower, and nowhere near the time. They are one run on the
  big name line, immediately left of the time, in one size and one ink, four points apart, so a
  muted and pinned chat reads as one row with two marks on it rather than as two separate claims.
  The name gives way before the marks do, nothing sits between the two name lines, and the trailing
  column carries what ARRIVED — the unread count — and nothing else. The same on a phone, on a
  tablet, on the Mac, and for a chat inside a folder.

- **A share now reaches the bot without opening Hermie.** Sharing a link or a document into
  Hermie from another app wrote the share down and waited for the next launch to send it — so
  nothing happened until you opened the app, which is not what tapping Send in a share sheet
  promises. The share sheet now delivers it itself: it reads the address, the credential and the
  bot's own conversation from what the app wrote down beforehand, uploads any files, sends the
  message, and tells you which of the two happened — **Sent to <bot>**, or **Will send when
  Hermie opens**. Everything it cannot do is unchanged rather than lost: with no credential, an
  expired one, no network or a gateway that refuses, the share stays where it was and the app
  sends it exactly as before. Two things are always left for the app — a photograph, which has to
  be resized to go in a transcript, and a gateway signed in through a provider whose access token
  has expired, because an extension that could refresh a token could sign you out of the app. A
  share that was handed over at the moment the sheet was killed is not guessed about: it comes
  back in Hermie as a question, with Send again and a way to discard it.
  [ADR-0026](docs/adr/0026-the-share-sheet-may-deliver.md) records the decision and what it costs;
  Android is unchanged, because its share already opens the app.

- **A bot leads with the name you gave it.** The chat list, the chat header, the bot's own
  sheet and the home-screen widget all put the display name on the big line now and the
  profile name on the small one under it. The handle led before, on the argument that it is
  what `@`-mentions, crons and the gateway's logs use — which is true, and is why it is still
  drawn, one line down. It is not what somebody who has named their bots is reading the list
  for. **Appearance → Bot names** still swaps the two, and a reader who had already chosen the
  profile name keeps it: the setting is stored, so only somebody who never touched it moves.

- **The name you give a bot follows you between devices.** That name is Hermie's own — no call a
  gateway offers writes a profile's display name, and the one route that touches it renames the
  profile instead — so a bot you had named stayed named only on the device you typed it on. It now
  travels with your folders, pins and mutes: given on the desktop, it is on the phone; emptied
  anywhere, it is emptied everywhere and the row falls back to the gateway's own display name and
  then to the handle. A name given while there is no gateway to reach is kept and sent on the next
  connection, and it counts as a choice you made, so the newest one wins wherever it was given. The
  gateway's own copy of the name is untouched, as it has to be.

- **No focus ring around the composer, or around anything else you type into.** On the browser
  build every input was ringed on focus — the composer most of all, because it is the focused
  element for most of the time anybody spends in the app. A text box is the one control that
  says what it is without a ring: it has a box, a caret blinking in it, and a keyboard aimed at
  it, so the ring was a second and louder announcement of something the caret had already made.
  The one the browser draws was in the wrong place besides: it goes around the input, which is
  the text line inside the pill rather than the pill.

  **Buttons, rows, tabs and links still ring**, at the theme's accent, on `:focus-visible` —
  they have no caret and no other way to say where the keyboard is, and taking that away would
  make the app undrivable without a mouse. The exemption names the four form selectors and
  nothing else, and a test reads the document template to keep it that way.

- **An account on the built-in issuer is a person on `/admin`'s people list.** The two pages
  kept two lists of the same people and neither knew about the other: an account created as an
  administrator on `/admin/oidc` left `/admin` showing nobody, so an operator had to add them a
  second time by copying an opaque 22-character subject between two pages. They are one list
  now, because they were always one thing — upstream maps an ID token's `sub` onto
  `Session.user_id`, which is exactly what this service keys its people and its administrators
  by.

  An account appears on the people list the moment it is created, before it has ever signed in,
  marked **account here** and linked to the page that owns it. Its role decides whether it is on
  the administrator list, in both directions and from either page: ticking **Administrator** on
  a marked row changes the account's role rather than writing a second answer that the next
  reconcile would undo. Deleting an account takes its administrator entry with it, and takes the
  row too unless this service has actually seen that person sign in.

  Ids that belong to no account are never touched, and a provider that is switched off changes
  nothing at all — so turning it off to test something cannot cost you your own way into
  `/admin`. A state directory written before this reconciles once, on its next start.


- **The built-in provider's own pages look like the deployment they belong to.** The sign-in,
  the invitation, the two-factor enrolment, the signed-out page and every refusal were bare
  HTML — which is what a page looks like when its style sheet has failed to load, and these
  are the pages a reader is sent to from somewhere else with no way to tell a real one from a
  page that fetched them. They now carry the same chrome the administration does: the mark, the
  operator's own branding name, the cards, and light and dark from `prefers-color-scheme`. Still
  no script, still no external request, still no font to load.

- **`/admin` is a set of pages rather than one long one.** It was a single document with the
  Service, Push, Message cache, Branding, Features and People panels stacked down it — six forms
  sharing one notice and one scroll position, so an operator who pressed Save had to work out
  which of the six the line at the top was about, and anybody looking for one switch read the
  whole thing. Each subject now has its own page behind a left nav — Overview, People, Push,
  Cache, Branding, Features, Identity, Danger zone — and a saved form sends you back to the page
  it was on, so the notice lands beside the control it is about.

  **It looks like Hermie.** A header with the app's own mark, inlined so a page an operator opens
  when something is already wrong needs no second request, and the deployment's branding name
  beside it. Cards, one spacing scale, tables whose columns line up with their headers, and a
  footer with the version and **Update and restart**. The colours are the app's own Blue preset in
  light and dark, from `prefers-color-scheme`. There is still no script anywhere, every control is
  still a form that posts, and every POST route is unchanged.

  **The people table is a table.** Each person's allowed bots, read-only, push and administrator
  boxes used to be stacked into one cell under headers that described something else; they are
  columns now, one row per person, still one form per row.

  At phone width the nav becomes a row across the top and everything below it is a single column.
  An `/admin/…` path nobody serves now answers 404 instead of quietly drawing the overview.

- **Bot-to-bot messages are asides, not chat bubbles.** Both directions — the message this
  bot sent a teammate and the teammate's answer — now read as a muted line on the left with
  a chevron, the same shape a reply's thoughts have: no bubble, no tail, no card. An inbound
  message used to arrive as a tinted bubble with a tail and an outgoing one opened onto a
  glass panel the width of a bubble, and both said a conversation was happening in your chat
  that was not yours. They stay closed at every verbosity level, including Verbose; tapping
  one opens it, and it is still open when you scroll back to it. Consecutive messages between
  the same pair of bots sit tight, and a message to somebody else starts a new run.

  **The sending side is the same row as the receiving side.** On Quiet — the level the app
  starts on — a message to a teammate was not an aside at all: it was a centred chip reading
  `Message to Writer`, with the answer to it drawn as an aside directly underneath. One
  direction was a verbosity setting and the other was not, so the shape you saw depended on
  which way the message had gone. Both are now the same line at every level, and the
  bot-to-bot switch in the chat's options is the only thing that folds either of them to a
  chip.

  **A run of them is one run, whichever way each message went.** Four or more consecutive
  bot-to-bot lines still collapse into one summary that opens the exchange — but an answer
  standing in the middle of a stretch of errands no longer breaks it in two, and an exchange
  of eight rows is one summary rather than two with a loose line between them. The summary
  reads `6 messages with @writer · 4 replies`; it used to say `to`, which was only ever true
  of half the run.

- **The muted marker is a bell you can read.** The crossed-out bell on a chat row was a small
  box under a diagonal, in the faintest ink, tucked beside the time. It is now a drawn bell —
  flared skirt, clapper — at the size the row's other marks use, and it sits directly after
  the chat's name, because being muted is a state of the chat rather than something about the
  timestamp.

### Fixed

- **Setting a password from an invitation no longer reports "Sign-in failed".** The two things
  that can succeed on the built-in provider's own pages — choosing a first password from an
  invitation link, and enrolling an authenticator — both ended on the error page. The sentence
  under the heading said the password was set; the heading over it said the sign-in had failed.
  Somebody who had just done exactly what they were asked read the heading, believed it, and had
  no reason to try the password. Both now have a page of their own, headed with what happened,
  and a link back to the application on this origin.

- **Hermie Web behind a reverse proxy keeps its port.** nginx's `$host` is the name with the
  port stripped off it, so the block every deployment guide prints told the service it was on
  `example.com` while the browser was on `example.com:9443`. Hermie Web builds three addresses
  out of that origin — the OIDC issuer, the invitation link somebody is sent, and the redirect
  the service login comes back to — and all three pointed at a port nothing was listening on:
  a link that 404s, and a gateway that cannot fetch the key set, with nothing in any log about
  a port. `X-Forwarded-Port` is now read and appended when the forwarded host carried no port
  of its own and the port is not the scheme's default, and the standard `Forwarded` header
  (RFC 7239) fills in whichever of proto and host the `X-` headers did not say. The nginx
  examples in `deploy/web/README.md` use `$http_host` and pass `X-Forwarded-Port`.

  **`/admin/oidc` says when the issuer it stored is not the address you are on**, names both,
  and offers **Re-capture the issuer from this address**. Correcting it used to mean turning
  the provider off and on again, and turning it off drops every refresh token — so fixing a
  dropped port signed out every device in the deployment. Re-capturing keeps the accounts, the
  signing keys, the client id and every session, and says that the gateway's own configuration
  now has to name the new issuer.

- **The app looks the same whether its window is in front or behind.** Clicking another app on the
  Mac used to change Hermie's chrome: every glass panel swapped for a flat fill for as long as the
  window was not the front one. That was the app trying to get ahead of macOS, which dims a window's
  materials when it loses focus — and the cure was the complaint, because the drawing still changed
  the moment you looked away. Nothing in the app reads its window's focus any more, on any platform.

- **A message to another bot stops appearing twice and wandering between the other
  messages.** A dispatch is a tool call, and the only thing tying the row you saw go out
  to the row the gateway stored was the call's own id. When the gateway hands back a
  different id for it — or no id at all, which its history can do — the two had nothing in
  common, so the same errand stood in the chat twice. The copies then drifted apart as the
  turn went on: only one of them has a place in the stored conversation, so the other was
  positioned relative to whatever row happened to be above it, and moved whenever that
  changed. The two are now matched on the message and the teammate it went to, so they
  collapse into one row that stays where it was sent — while one message sent to two
  teammates, and the same message sent twice, still count as two.

- **A teammate's answer no longer arrives as a message you appear to have typed.** The reply
  to a message one bot sends another does not come back as a message; it comes back as a
  report from the background job that delivered it, on the same channel your own messages
  use. When the gateway labelled that report, the reply was folded onto the line that asked
  for it, which is where it belongs. When it did not — an older gateway, or a reconnection
  that describes the running turn as plain text — the whole report was drawn as a blue bubble
  signed by you: the delivery command, the process id and the teammate's words, in your
  colour, in the middle of your conversation. That was the "sometimes the reply bubbles come
  up" in the report, and "sometimes" was exactly it: it needed the label to be missing, or
  the app to reconnect while that turn was still running.

  Both halves are fixed in the one place a row is classified, rather than in the two that had
  drifted apart: the reply now lands on the line it answers whether the gateway labelled the
  report or not, and a reconnection during that turn adds nothing rather than adding a bubble.
  A reply with no dispatch left on screen to attach to is still shown — as the background
  report it is, not as speech. Every entry path is now held to one rule by a test that walks
  all of them: no row of traffic between two bots is ever drawn as a message.

- **Your folders and your chat order reach your other devices.** Group four chats under Finance
  on the desktop, open the phone, and the phone showed a flat list — and then made the gateway
  flat too, so the desktop lost the folders as well the next time it connected.

  The arrangement is part of the same block of per-person settings as the theme, and the newest
  choice now wins wherever it was made. What was left after that was the list's own housekeeping:
  whenever the roster arrives, a chat that is new goes at the end and one that is gone is taken
  out, and on a second device that runs against the list that device is holding — nothing at all,
  on a first sign-in — before the arrangement has come down from the gateway. It counted as six
  chats you had just dragged into place, and being the newest thing anybody had "chosen" it won.
  That housekeeping still happens and is still sent, because a new chat does belong in the list,
  but it no longer claims that you arranged anything. The same goes for the tidy-up that forgets
  mutes which have already run out, which happens every time you bring the app back to the front.

- **Your theme, your text size and your chat defaults follow you between devices again.** Pick
  Graphite on the Mac, open the phone, and the phone went back to whatever colour it had been
  on — and then wrote that back, so the Mac lost the choice too the next time it connected. The
  same went for the text size, the name order, the verbosity defaults and the themes you have
  made yourself: everything that is yours rather than a particular machine's.

  These settings live in one block on the gateway that all your devices share, and the rule for
  two devices disagreeing was "the last one to write wins". That is not the same as "the last
  choice you made wins", because a device writes that block for reasons that are nothing to do
  with choosing anything — it registers itself for notifications on every connect, and it reads
  its own copy off the disk a moment after the gateway's has arrived. The block now records
  **when you last chose** something in it, and the newest choice wins wherever it was made, with
  a tie going to the gateway so that two devices cannot argue forever. A change made with no
  connection keeps its date and still lands when there is one, even if the app was closed and
  reopened in between. And the copy that arrives is written to the device, so the next launch
  opens on the theme you chose rather than on the one you replaced.

- **Signing in from a browser no longer ends on "Maximum call stack size exceeded".** The
  browser build's sign-in step failed on every visit — the first one, and the one straight
  after **Forget gateway**, which is where it was reported from. The step could not read
  what the server had told it about the gateway, so it also offered the wrong door: the
  in-app password form, the one a password manager fills, never appeared at all, and the
  card above it claimed the gateway authenticates with a session token.

  The cause was one line of module resolution. A bundler picks `x.web.ts` over `x.ts` for
  the browser — and it picks the same way for a relative import written *inside*
  `x.web.ts`, so `./x` read from there is that file itself. The web half re-exported a
  value from what it believed was its native twin and was in fact re-exporting it from
  itself, which compiles to a getter whose body reads the same getter: the name overflowed
  the stack before it could be called. TypeScript, ESLint and every native build resolve
  `./x` to the other file and saw nothing wrong. What both halves share now lives in a
  third module with no platform twin, and a test refuses the spelling everywhere in the
  app rather than in the two places it had reached — the second being the file-drop seam,
  where the first file dropped on a browser window would have gone the same way.

- **A bot is told which device you are actually on.** Answer on your laptop in the morning
  and pick the same chat up on a tablet, and the bot went on reasoning about the laptop —
  its make, its clock, its language — for as long as you kept typing. What the bot is told
  is one row per PERSON, shared by every device you use, and the app decides what to send
  by watching for changes on the device it is running on. The tablet had changed nothing,
  so it had nothing to say, and the row stayed the laptop's. On connecting and on coming
  back to the front, the app now compares the five device facts in that row against its
  own and re-sends only when they differ — so the device you are holding is the one in the
  next message's context, and the one that wrote the row says nothing at all.

  **And the second device no longer deletes what the first one shared.** The notice that
  explains who on a gateway can read your context was answered per device rather than per
  gateway, so a second device never had an answer and had no row of its own to write —
  while the write replaces the whole section. Your row went out of it entirely, and a chat
  started in that window got a system prompt with nothing about you in it at all; the
  laptop put the row back, unchanged and still dated that morning, the next time it wrote
  anything. Your own row already sitting on the gateway now counts as the answer it is,
  and a device with nothing of its own to say carries your row through exactly as it
  carries a colleague's.

- **LaTeX written with `\(…\)` or `\[…\]` renders as mathematics.** Only the dollar spellings
  were read as mathematics, so the other pair — which is what most replies use — reached the page as
  prose with its backslashes eaten by the Markdown parser, and `\(E = mc^2\)` printed as
  `(E = mc2)`. Both pairs are mathematics now, inline and as a block.

- **A formula with `\left(…\right)` in it draws instead of falling back to its source.** The
  renderer had the code for delimiters that grow with their contents and could never reach it: the
  expression reader ran past the `\right` and refused the whole formula, so every fraction inside
  grown brackets — which is most of the ones worth displaying — came out as LaTeX. Matrices,
  `cases`, `aligned` and the rest of the environment family draw as well, as a grid with the
  brackets the environment names; a minus is set as a minus rather than a hyphen, and `\cos\theta`
  gets the thin space it is supposed to have. An expression the renderer still cannot draw shows its
  source, as it always did — and a matrix inside a sentence does too, because a matrix flattened
  onto one line is not a notation anybody agreed to.

- **“Ask <bot>” in Shortcuts and Siri waits for the new reply instead of returning the last
  one.** A Shortcut cold-starts the app, and the watch that decides which message is the answer
  was started before the chat had been opened — so it took its bearings on an empty transcript,
  and the hydration that follows (the cache painting the thread, the resume binding it, the
  history read filling it in) looked like the bot had just said something. It had: the time
  before. The watch now starts once the chat is open, nothing counts as an answer until the
  gateway has accepted the prompt, and a reply has to stand after that prompt in the transcript
  rather than merely carry a different id — which is also what a reconnect breaks, because a
  resume re-lays the tail under fresh ids without anything having been said. The forty-five
  second cap and the “still working — use Send to” sentence are unchanged, except that the wait
  now gets what is LEFT of those forty-five seconds, so the app stops a moment before Shortcuts
  does rather than writing an answer nobody is still reading.

- **A folder is drawn as a folder.** It gained an inside in the last round — it collapses, it
  counts what it is hiding, a drop can land in it — and went on being drawn as a line with a
  word on it, so only the name had changed. It is one sunk plate now: a header with a folder
  mark in the folder's own colour and a chevron that turns a quarter of a circle rather than
  being swapped for a different glyph, and the chats inside stepped in and drawn on the same
  plate, which closes under the last of them. Opening and closing moves the rows rather than
  cutting to the new list, and dragging a chat over a folder tints the whole plate in that
  folder's colour — onto its header, into an empty one, or between two chats already inside,
  because all three mean the same thing. Everything it already did is untouched: the order,
  the drag, the menus, the mute and unread rules, the widget's folder pin and the scroll a
  widget tap asks for.

- **A second gateway is now reachable from the chat list.** Adding one worked and getting to
  it did not: the only way across was Settings → Gateways, and the chat header that might have
  carried the switch already holds a name, a subtitle, a presence bead, a context ring and an
  options button. Once there is more than one gateway the list's title becomes that gateway's
  name with a chevron — the screen's own name moves to the small line under it — and pressing
  it opens the list of gateways with the live one ticked. With one gateway nothing changes.
  Settings → Gateways stays the place to add, rename, sign out of and remove one, and every
  row that is not the live one now carries **Use this gateway** in words rather than relying
  on a reader guessing that the row is a button.

- **Renaming a bot renames the bot, not the profile.** The name field on a bot's sheet used to
  send `PATCH /api/profiles/{name}`, which on every profile but the default one renames the
  profile itself — its directory, its wrapper script, its service and the active-profile
  pointer — so somebody changing what they took for a label moved the handle that their crons,
  their `@`-mentions and the gateway's own logs address. The field is the **display name** now,
  on every profile, and it is Hermie's own: no call a client has writes a profile's
  `display_name`, so the name is kept beside your folders and your colours and read by every
  surface that draws a bot — the chat list, the chat header, the sheet itself, the memory list
  and the home-screen widget. Emptying it falls back to the name the gateway reports, and then
  to the handle. Renaming the **profile** is still there, as its own clearly-labelled action
  further down the same group, with its own field and the warning out loud; it is not offered
  for the default profile, whose name cannot move at all.

- **The line that says which model a chat is on prints the model's name.** The picker under
  it listed **Claude Opus 4.1** and **GPT-5**, and the row above said
  `anthropic/claude-opus-4-1-20250805`. The reason was one option: a chat's own model is
  always added to the list so the picker can show what you are on, and that one option was
  added with the wire id as its label — so the row found it and printed it, and the fallback
  that exists for exactly this never ran. The id is still there, under the name, where every
  other row keeps it and where the picker's search can still match it. The **New bot** form's
  model list reads the same way now.

- **The chat list no longer shows a raw `[IMPORTANT: …` or `[System: …` line.** The gateway's
  preview for a chat is its newest user or assistant row squashed onto one line and cut at eighty
  characters, so an injected wrapper reached the list without its newlines and, often, without its
  closing bracket — a shape the scaffolding parser could not read, so the row was drawn as somebody's
  words. A preview that opens like scaffolding is now read as scaffolding: the list shows its first
  sentence as a system line ("Background process … completed normally (exit code 0)", "The active
  model for this chat has changed to …").

- **Bot-to-bot traffic no longer bumps an unread count.** A message from another bot counted
  as unread mail, so a bot that talks to its teammates produced a chat list, a folder total
  and a home-screen widget permanently announcing work nobody had to look at — and opening
  the chat showed nothing to do. The chat row's badge, the folder aggregate, the widget count
  and the transcript's own "jump to latest" pill all skip bot-to-bot rows now. A question
  waiting on **you** is untouched: somebody asked you, so the row still says so. Push needed
  no change — the app has not registered for that notification type for some time — and there
  is now a test that says so.

- **The chat list's header has room to breathe.** It held four controls beside the title —
  Boards, New bot…, a `+` and Edit — pressed into one line above the search field, and in
  Dutch and German those words are longer still. It is now the title, one `…` holding
  **New bot…** and **Boards**, and **Edit**, with the spacing the search field below it
  already has. The same two controls at every width: the old arrangement folded only below
  a measured width, which left the Mac sidebar — wide enough to fit four controls, not wide
  enough to tell them apart — exactly as cramped as it was.

  The `+` is gone rather than moved. It was labelled New cron and it made a cron; a cron is
  made on the **Crons** tab, with that tab's own button, and a second door into one screen's
  primary action parked in another screen's header is a door that has to be kept in step
  with the room behind it.

### Fixed

- **A chat opened the next morning no longer shows yesterday twice.** An approval you
  answered yesterday is kept in the offline cache, and the transcript is painted from that
  cache before the history comes back. Folding the history in put the answered card
  *behind* every row it brought — including this morning's — so the thread read `Today`,
  two messages, `Yesterday`, the old "Allowed once" card, and `Today` again above the next
  message. A settled question is now put back into the moment it was answered in. A question
  still waiting on you is not: it stays at the bottom, where it is being asked.
- **The chat header's pill no longer clips a name that fits.** The pill grew a second
  line — the bot's other name beside what it is doing — and was still being sized to the
  first one alone, so `Juno Marsh` over `techsupport · Online` was drawn as `Juno Mar…`
  over `techsupport · …` with most of the header empty beside it. It now takes the width of
  whichever line is longer, up to the room actually left between the header's buttons, and
  still does not move while the bot cycles through Thinking, Working and Online. When there
  genuinely is not enough room it is the state that gives way, not the name.

- **The microphone purpose string ships.** The image-picker plugin was told
  `microphonePermission: false`, which deletes `NSMicrophoneUsageDescription` from the plist
  after the app's own sentence was written — so a build that dictates carried no explanation
  for the microphone, and App Store Connect dropped two uploads after the fact without a word
  from `altool`. The plugin now carries the same sentence as the app.

- **Slash completion works against a gateway from before `session_id`.** Hermes 0.21.3's
  own contract for `complete.slash` takes `text` alone and validates its parameters
  strictly, so the session the app started naming for project-local skills made the older
  gateway refuse the whole call — every keystroke after `/` drew the popover's failure row on
  a phone while the same build completed fine against a newer gateway. The first refusal of
  that exact shape now turns the field off for the rest of the connection and the call is
  repeated without it; the only thing the older gateway loses is a list of project-local
  skills it never had.

## [0.1.3] - 2026-09-22

### Added

- **Hermie can speak Dutch and German.** Settings → Appearance → **Language** offers *Follow device*,
  English, Nederlands and Deutsch, and switching repaints the app where you stand — no restart, no
  losing the sheet you had open. A device set to Dutch or German gets that language on first launch;
  anything else gets English.

  English is not one of three options, it is the language Hermie is **written** in, and the other two
  are translations of it. That is a deliberate design and it is visible: a sentence nobody has
  translated yet appears in English rather than as a blank row or a key. Numbers, dates, relative
  times and plurals follow the chosen language too, through the platform's own `Intl` — so a Dutch
  reader gets `1.234` and `22-09-2026` rather than the American forms. The choice belongs to the
  device, like light-and-dark: switching to your work gateway does not switch your language.

  The pages Hermie Web serves itself — `/setup`, `/admin` and the sign-in — speak the same three
  languages, negotiated from your browser's `Accept-Language` rather than from a setting, because
  the first of them is reached before there is anywhere to keep one. English is the default there
  too, and the same sentence in the same glossary: a gateway is a gateway in all three.

- **Drag a card across a board, where the columns are side by side.** On an iPad, a Mac window or a
  wide browser, hold a card until it lifts and drop it on another column. The board scrolls sideways
  under the card when you carry it to an edge, and the column you are over lights up — while the
  three columns the dispatcher owns, **Running**, **Review** and **Scheduled**, dim the moment a card
  leaves the ground, so you are told they will not take it before you aim rather than after. Let go
  on one anyway and the board says why and sends nothing. Dropping a card back where it came from,
  or anywhere off the columns, does nothing and says nothing. **Move to…** has not gone anywhere: it
  is still on every card, it is still the only way on a phone, and it is still what VoiceOver and a
  keyboard use. There is deliberately no dragging a card up or down within a column — a board has no
  order to save, only a priority.

- **Hermie Web can sign people in itself.** A gateway normally needs an identity provider — Authentik,
  Keycloak, something of that shape — and for one gateway shared by a handful of people that is a
  second service with its own database in front of a single process. So Hermie Web can now be that
  provider. `/admin` → **Identity** turns it on, and the page then prints the exact three lines to
  put in the gateway's configuration, with your own issuer and client id already filled in; turning
  it on changes nothing on the gateway by itself. Accounts are added by sending somebody a one-time
  link they choose their own password with, so nobody ever has to send a password to anybody. There
  is optional two-factor with an authenticator app and recovery codes for the day a phone is lost,
  and a **Test sign-in** button that runs the whole sign-in from the server and tells you which step
  failed rather than leaving you to read a log.

  It is **off unless you turn it on**, and a deployment that already has an identity provider should
  leave it that way and keep using it. Turning it on is a real decision: it makes Hermie Web the
  thing your gateway trusts to say who people are, so whoever can read its state directory can be
  anybody on that gateway. The page says so, it refuses to switch on without TLS — because the
  gateway would refuse it too — and the reasoning and the whole threat model are written down in
  ADR-0025.

- **Two more things to be told about: a scheduled run that finished, and one that failed.**
  Settings → Notifications now has a switch for each, on by default like the rest, and so does a
  chat's own notifications page — which is the point of splitting them out of **Routines**. A bot
  whose nightly digest is chatter is exactly the bot whose digest *not running* is worth a buzz, and
  until now switching off the one switched off the other. A device that upgrades adopts both as on
  without anybody touching a switch; a type somebody had already turned off stays off, because that
  was a decision. The coarse **Routines** switch keeps meaning what it always meant, so a device
  that only ever asked for that one goes on being told about scheduled runs.

- **A notification opens the conversation it was about.** A bot has branches now, and a conversation
  `/new` put away, so a turn can happen in a session nobody is looking at — and a tap that always
  opened the bot's chat landed on a transcript with nothing in it about the thing that just buzzed.
  The notifier says which session and what kind it was, and a branch or a retired conversation opens
  there instead. A notification that says nothing about a session behaves exactly as it always did.
  A tap into one of those other conversations opens it and answers nothing: an **Allow** belongs to
  the session that asked, so the reader lands on the request and answers it there. In a browser, two
  conversations of one bot no longer replace each other on the lock screen.

- **A notification only claims a scheduled run when it knows there was one.** A notifier recognises
  a cron run by whatever signal it has, and not all of them are facts — the last resort is the
  session's platform string, which is free text. Where the notifier says its answer was a guess, the
  line reads as an ordinary message from the bot instead of naming a routine that may not have run,
  because a lock screen gives the reader no way to tell a guessed sentence from a certain one. A job
  id is carried but never printed: `a cron run failed` says more than the id would.

- **A chat of your own with every bot, beside the one everybody shares.** On a gateway that knows
  who you are, each bot's (…) menu and its Conversations page carry one switch: **Shared Bot Chat**
  or **My chat**. The shared one is what it has always been — the same conversation Hermes Desktop,
  the CLI and your colleagues are in. Yours is a second conversation on the same bot, named after
  you, that only you open; the bot still has its own memory and its own settings, and it starts from
  the shared chat rather than from nothing. The choice is remembered per account and follows you to
  your other devices, so a phone and a laptop signed in as you open the same conversation. The chat
  list opens whichever you chose, and the badge and the "needs you" dot count that one. On a gateway
  with no accounts the switch is not there at all and nothing changes.

- **Hermie Web has an administration page.** `/admin` on a configured service: what it is running
  (push, the message cache and how much of it is used, whether an update is waiting), which
  notification types it will send at all and whether a notification may carry message text, how long
  a cached chat is kept, and an update button. It also carries a list of the people who have signed
  in through it, with what this service will do for each of them — which bots they may reach,
  whether their notifications go out, and whether it will pass their changes on to the gateway.
  Those are **this service's settings, not the gateway's**: notifications and the cached chats are
  its own and are enforced completely, while "read-only" stops everything it can see and cannot stop
  somebody typing into a chat, because the gateway connection is a pipe this service deliberately
  does not read. The page says so where you set it.

  Whoever finishes `/setup` becomes the first administrator; others are added by their gateway
  account id. On a gateway with no accounts there is nobody to recognise, so setup can take an
  administrator secret instead — stored as a hash, and never shown back. The page is plain HTML with
  no scripts, so it works on the day something is wrong.

- **A team can make the app look like theirs.** A name, an accent and a starting theme, set on
  `/admin` and read by the app before it draws anything. It is a starting point and never an
  override: if you have chosen a theme it stays, and a chat you have given a colour keeps it. There
  are also switches to turn service features off for everybody — private chats, the message cache,
  the update button — and an app talking to a service too old to mention them keeps everything it
  has.

- **Boards.** The Kanban boards the gateway keeps, from Settings → **Boards** or **Boards** in the
  chat list's header: every board, its columns, its cards, and a card's own page with its notes and
  its comments. A card can be made, edited, moved and archived. It is the same data the Hermes
  desktop app shows — the same per-board store, addressed the same way — so a card moved on a phone
  is the card the desktop redraws. The columns are the gateway's own eight and cannot be added to or
  reordered, because there is nowhere to save that; **Running**, **Review** and **Scheduled** belong
  to the dispatcher and are never offered as somewhere to put a card, with the reason said once
  under the board rather than left as three targets that refuse. There is no dragging a card up and
  down inside a column either: cards are ordered by priority and age and there is no rank to save,
  which the page says instead of pretending. When the board refuses a move it is shown in the
  board's own words — "blocked by parent(s) not done", naming the cards that are in the way — and
  when the board puts a card somewhere other than where it was sent, that is said too. Archiving
  keeps the card and its history; nothing here deletes one. A gateway with no Kanban plugin gets the
  install command rather than an empty page.

- **The gateway's logs.** Settings → Gateway → **Logs**: the six files `hermes logs` knows — the
  agent, the gateway, errors, the dashboard, the desktop and MCP output — with a minimum level, a
  component filter, a search that runs on the gateway rather than over what is on screen, and a copy.
  **Follow** re-reads the file every few seconds and says so: the gateway offers no live stream, and
  calling a poll a tail would be a claim about the gateway rather than about the page. Errors and
  warnings are coloured by the level the line itself declares, so a traceback's body is left alone
  and a message that merely contains the word "error" is not painted red. A file the gateway has
  never written says it is empty; a filter that matched nothing says that instead. A gateway that
  does not serve its logs over the API is told apart from one that is simply unreachable, and gets
  the command to read them on the host.

- **Connectors.** Settings → **Connectors**: the apps a bot signs in to on your behalf, whether each
  one is connected, and a **Connect** that opens the provider's page in your browser and waits for
  the account to come good — coming back to Hermie tells the gateway to look now rather than on its
  next sweep. The page is about one chat, and says so, because that is what the gateway offers:
  a connector list exists for a conversation that is open and for nothing else. A bot whose
  Connections toolset is switched off is told that, rather than being shown an empty account.
  Signing a connector OUT is deliberately not here — the gateway offers no such call and no command
  behind it, because it is a decision the provider leaves to you — so the page says where it is done
  instead of offering a button that could only fail.

- **Hermie Web sets its gateway up once, and everybody else just signs in.** Start `hermie-web` with
  no `--gateway` and it serves an operator setup page at `/setup`: the gateway address, a probe of
  it, and the service login that push and the message cache are spent on — the same sign-in
  `hermie-web login` does from a terminal, run in a browser for the machine that has no shell open.
  Saving writes it to the service's state directory and closes the page for good, so the next person
  to open the address sees a sign-in and nothing else. The browser build reads the rest from the
  server rather than asking: which gateway is behind the proxy, and what signing in to it takes. The
  wizard there has no address step, no probe to wait for and no welcome cover — it opens on the
  sign-in — and "Change gateway" stays hidden, because on the web the gateway is not the reader's to
  change. A Hermie Web that is too old to answer, or one that could not read its gateway, costs
  nothing: the app probes for itself exactly as it did before. Everything this page can do, it can
  only do while no gateway is set; afterwards those addresses do not exist.

- **The chat list says who you are signed in as.** At the bottom of the list, above the tabs: the
  name the gateway has for you, with a **Sign out** beside it. Which name that is follows the same
  ladder the rest of the app uses — the display name the gateway gives, else the first part of the
  address you signed in with, else your account id with the provider's prefix taken off, never a
  guess. There is no picture, because the gateway does not have one; the mark is the same
  initial-drawn avatar a bot gets. On a gateway with no accounts there is nobody to name and the row
  stays away. In a browser it is also where "Hermie Web 0.1.2 · your-gateway" lives, so what you are
  connected to and who you are connected as are one block instead of two.

- **In a browser, a chat opens with the conversation already in it.** Hermie Web now keeps a copy of
  each Bot Chat's tail, filled from the gateway connection it already holds for notifications and
  from the transcript reads it already passes along. The app asks for that copy before it dials, so
  a chat opened on a laptop, a borrowed machine or a phone that has never seen it draws immediately
  and stays still while the rest loads, instead of showing a spinner and then jumping. Nothing is
  lost when the copy is not there — the chat opens the way it always did. It lives on the server's
  own disk, it is capped (`--cache-max-mb`, 64 MB by default, `0` to turn it off), the least
  recently opened chat is the first to go, and reading it needs the same gateway sign-in the rest of
  the app does. It is a copy per gateway rather than per person, for the plain reason that the
  gateway does not say who owns a session and the Bot Chat is shared anyway — which the
  documentation says out loud rather than implying a privacy it does not have.

- **Attachments open in Quick Look.** Tapping a file in a conversation previews it — the system's
  own previewer, the one Space opens in the Finder — instead of putting up a share sheet and asking
  which app you would like to read it in. On the Mac, the iPhone and the iPad alike: `QLPreviewController`
  is iOS API, and the Mac only made the old behaviour obvious. Anything Quick Look has no previewer
  for still goes to the share sheet, and a browser still downloads.

- **⌘N starts a new conversation in the chat you are looking at.** It runs the same `/new` the
  composer does — the session is retired, the chat and its colour stay, and the transcript says so
  — so there is one set of rules about what happens to the old conversation rather than two. It is
  in the Mac's menu bar as **Chats ▸ New Conversation**, which is also where the other shortcuts are
  discoverable. Not offered while a sheet or a panel is open, because the conversation it would
  replace is the one underneath.

- **A conversation can be branched from any message.** "Branch from here…" on a turn or a reply
  forks the conversation at that point into an ordinary, visible session of its own, named
  `Branch · <first words>` of the row it was taken from. The chat it came out of is untouched —
  `session.branch` copies the history so far into a new stored child rather than moving anything —
  so what happens on screen is a line saying the branch exists and offering to open it. One caveat
  belongs in the changelog rather than only in the code: **`session.branch` takes no row id.** Its
  parameters are `{session_id, name, count}`, and the app reads `count` as "how many of the parent's
  messages the child starts with", counted from the start over the gateway's own `row_id`s. That
  reading is not verified against a running gateway and `docs/platform-notes.md` says so.

- **Conversations: every conversation one bot has, on one page.** Reached from the bot's profile
  sheet or the chat's (…) menu. Three groups — the current Bot Chat, the branches, and the
  conversations `/new` has put away — each row with its preview, its message count and when it was
  last active. A non-canonical row can be opened (read-only, under a banner saying which
  conversation it is and how to get back), renamed, deleted after a confirm, or made the Bot Chat.
  That last one is a swap and not a promotion: the title is the gateway's registry key, so the
  current chat is retired through the very machinery `/new` retires with before the incoming one
  takes the name, and every step rolls back towards "nothing happened" — because a bot left with no
  canonical chat mints a third one on its next open. **The current Bot Chat carries no actions at
  all**, and that is a type rather than a check: `conversationActions` answers an empty list for it,
  so no surface can offer to delete the one chat a bot is reached by (ADR-0007).

- **Pin a chat.** From the row's context menu or the chat's own menu. A pinned chat sorts to the top
  of whatever container holds it — its folder, or the top level above the folders — and wears a
  small pin. It is a display SORT and never a move: the arrangement underneath is untouched, so
  unpinning drops the row straight back into the gap it left rather than wherever the top of the
  list has drifted to. The drag reads the displayed order and a dragged row is held inside its own
  band: a pinned row lands among the pinned ones, an unpinned row below them, and a row dragged past
  the boundary rests at the boundary rather than snapping across it. **The `ui_meta` section version
  is deliberately not bumped for this**, for the second time and for the reason round four declined
  it for `push.perBot`: a reader that meets a `v` it does not know treats the whole app-wide section
  as unreadable and re-seeds it from its own copy, so bumping would not protect the pins — it would
  hand every older build the power to delete the folders, the order and the mutes. The field is
  additive, exactly as `folders`, `botNameOrder` and `textSize` already are. ADR-0016 and ADR-0019
  carry the amendment.

- **A map of a bot's memory.** A **Graph** tab beside the entries draws what the plugin's `graph`
  answer holds: the bot at the centre, an entry per memory, and the topics they share — a
  capitalised phrase, an `@handle`, a `#hashtag`, a date — with a line wherever two entries mention
  the same one. It is laid out in the app rather than fetched as a picture, with a spring-and-repel
  pass that always starts from the same seed, so the same memory draws the same map every time it
  is opened and after every edit. Drag to pan, zoom with the buttons or, in a browser, the wheel,
  and tap a node for a card with the entry's full text, the topics it mentions and a way into the
  list at that entry. It is drawn with the app's own SVG — no web view, nothing to sandbox — and
  under Reduce Motion it arrives with no animation at all. A page that hit one of the plugin's caps
  says so rather than showing a partial map in silence.

- **A memory browser.** Bot profile → **Memory**, and Settings → **Memory** for any bot: both of a
  profile's memory files — `MEMORY.md`, what the bot learned about its work, and `USER.md`, what it
  learned about you — as two lists with the char usage each one is actually spending. Search runs on
  the gateway rather than filtering what is on screen, so it means the same thing here as it does to
  the bot's own `/memory` command: every word of the query has to appear in the entry, in any order,
  as plain text. Entries can be added, edited in place and removed, and a removal asks first because
  Hermes keeps no history of a memory file. A write is addressed by the entry's TEXT and never by
  its position, so an entry that moved between the read and the tap cannot be overwritten by
  mistake. Whatever the store refuses — a char limit, an entry that is no longer there — is shown in
  Hermes' own words rather than paraphrased. A gateway whose plugin allows reading and not writing
  gets the list with the composers gone and a line saying so; a gateway with no memory routes at all
  gets the install command and a link to the guide instead of an empty page. External memory
  providers are listed by name as **not browsable**, because they offer no call that returns what
  they hold.

- **Rename a bot from the app.** The bot profile sheet's name is a field now rather than a fact with
  the sentence "Set on the gateway, in this profile." beside it. Which name it edits depends on the
  profile, and the sheet says so instead of hiding it: the **default** profile takes a display name
  and keeps its own id, and every other profile is genuinely RENAMED — so there the field is
  labelled *Profile name* and carries the line "Renaming changes the profile name other tools use",
  because that handle is what `@`-mentions, crons, DM lines and the gateway's own logs address. A
  real rename also moves the name everywhere this app holds a bot under it: the open chat and its
  queue, the roster, the unread watermark, the arrangement, the folder, the colour, the archive
  flag, the mute, the per-bot context note and the cached transcript. If part of that cannot be
  moved, the sheet says which part rather than leaving the reader to find out at the next cold
  start. A refusal from the gateway — a name over 64 characters, a name already taken, a profile
  that does not exist — is shown beside the field and nothing local moves.

### Fixed

- **A board drawn in a panel now fits the panel.** On an iPad, opening **Boards** from Settings puts
  the board in an overlay about half the window wide — and the board was choosing its layout from
  the window, so it laid eight columns out side by side in half the room. The second column was cut
  off at the panel's edge, with its cards and its **New card** button out of reach, and the three
  lines under the board ran off the right-hand side mid-sentence. The board now measures itself
  rather than the window, so in a narrow panel it stacks the way it does on a phone, and its
  explanatory lines wrap instead of scrolling sideways with the columns.

- **Opening a chat's (…) menu puts the keyboard away.** With a half-typed message the menu opened
  behind the composer and the keyboard, and its lower rows — Model, Colour — were on screen and
  impossible to reach or scroll to. Your draft is kept.

- **The chat header's Back and (…) buttons no longer have a message printed through them.** The
  same thing the pill did, on the two circles beside it: a reply scrolling under the chrome came
  through the glass with the chevron drawn on top of it. All three now hide what passes behind
  them, which is also what makes the header read as one piece of chrome rather than three.

- **The bot's name in the chat header no longer has a message printed through it.** The transcript
  scrolls underneath the header, so whatever bubble happens to be passing behind the pill was its
  backdrop — and at the glass control's own transparency that bubble's words came through the name
  and the status under it, two strings of text at the same weight in the same place. The pill now
  takes the solid layer under its glass, the way the attach menu and every other floating menu in
  the app already do, so what it says is legible over any transcript.

- **Signing in works again.** Since gateways got ids, every credential the app tried to store was
  rejected before it reached the device's secret store at all: the id is appended with an `@`, and
  `expo-secure-store` accepts only letters, digits, `.`, `-` and `_` in a key. It was not a
  permissions problem and not particular to developer builds — onboarding could not finish on any
  phone, and the one-time move that carries a pre-existing sign-in into the new layout silently
  carried nothing, which is what was behind being asked to sign in again after an app update.
  Credential keys now use a separator the secret store accepts, and a test runs the library's own
  check over every key the app can produce, so a key it would refuse cannot ship again. Anyone
  affected signs in once more; nothing else is lost.

- **The chat list's header fits the iPad's narrow sidebar.** In portrait the sidebar is 300pt, and
  four controls that cannot shrink — Boards, New bot, `+`, Edit — left the title nothing: "Chats"
  wrapped to one character per line and "New bot…" truncated mid-word. The title now takes one line
  whatever happens, and below a threshold the three word actions fold into a single `…` beside a `+`
  that stays where it is. A wider sidebar, and every phone, keeps the full row exactly as it was.

- **Setting a gateway up now either happens completely or leaves nothing behind — and never fails
  silently.** The credentials go to the secret store first and the address and the list entry only
  once they have landed; before, the address was written first, and a device whose keychain refused
  — an unsigned developer build, a locked device — was left with a gateway it could not sign in to,
  under an id nothing had recorded. Every launch minted another one: fifty of them had collected on
  one simulator and thirty-nine on another, while the app returned to the Welcome screen saying
  nothing about why. A refusal now rolls back what it wrote, writes no address, and reaches the
  wizard as its own sentence with the platform's reason on the end — "Hermie could not store the
  credentials securely on this device: …" — under a button that says **Try again**. A launch read
  that throws is recorded on the auth timeline, which Settings → Connection prints, instead of
  quietly becoming a fresh-install wizard. The configurations already stranded are reclaimed once,
  on the first launch after this, and only those: a stored address that no entry in the list claims
  and that nothing can ever open again.

- **A private chat cached by Hermie Web is no longer readable by everybody else signed in.** The
  service keeps a copy of each chat's tail so a chat paints instantly, and until now that copy was
  shared by everyone on the gateway — which was fine while the only conversation a bot had was the
  one everybody was already in. Now that you can have a chat of your own, the copy carries whose it
  is: yours comes back to you, and to anybody else it simply is not there. Shared Bot Chats are
  unchanged. On a service started without `--push` there is no gateway connection to tell the two
  apart, so every cached copy belongs to whoever fetched it — another person's first open of a
  shared chat is a little slower there, exactly as it was before the cache existed.

- **Reduce Motion, checked over every surface that moves.** Eighteen of them, against three rules:
  the duration collapses to zero rather than the animation being skipped — a skipped animation is a
  skipped completion callback, which is how a reader ends up with a panel that never goes away —
  nothing on its way out keeps eating taps, and nothing animates in for content that was already on
  screen. No surface was found breaking any of them. Two pieces of code that happened to be right
  were made to say why: one duration that read as "never reduce", and the rule that a LOOP must
  never be collapsed to zero, because a loop of zero-length animations restarts on every frame for
  ever. `docs/platform-notes.md` has the table, and the account of how the test that checks all this
  very nearly proved nothing at all.

- **A widget tap says which gateway it came from.** The home-screen widgets build
  `hermie://chat/<bot>?gateway=<key>` now, on iOS and on Android. On a device with one gateway
  nothing changes; on a device with two it is the difference between opening the chat you were
  looking at and opening a chat with the same name on whichever gateway happened to be current — and
  two rosters routinely share names. The key is `gatewayKeyOf` the gateway's origin, the same
  sixteen hex digits a push payload carries, and a link without one still opens the bot exactly as
  it always did. **Not yet tapped on a device against two real gateways.**

- **The memory map takes a pinch.** Two fingers zoom it, one finger still pans it, and the buttons
  and the mouse wheel still do what they did. The buttons are not a fallback for the pinch: a pinch
  is unavailable to anybody on a pointer, on a keyboard or using a switch control, so both exist
  because each is somebody's only way in. Lifting one finger of a pinch re-anchors the pan, so the
  drawing does not leap when a zoom turns back into a drag.

- **A big memory map stops blocking the tab for as long.** The layout is force-directed and every
  pass compares every pair of nodes, so a fixed pass count cost sixteen times as much at the
  400-node cap as at a hundred. Past 150 nodes the pass count now comes down with the node count,
  which makes the total work grow with the number of nodes rather than with its square: at the cap,
  174 ms became 62 ms under Node on the development Mac. It is still deterministic — the count is a
  pure function of how many nodes there are, so the same memory still draws the same picture every
  time, which is what stops a cluster somebody has learned the position of from moving on them.
  **Not measured on a device**, and `docs/platform-notes.md` says so.

- **The profile sheet offers Memory wherever it is opened from.** The row was there when the sheet
  came from the chat list's menu and absent when the same sheet came from the chat header's pill,
  because the browser is a full page rather than a modal — it needs the screen underneath it to
  stand aside, so the sheet renders the row only where a screen has said it can. The conversation
  had never said so. It does now, and it stands aside the same way the roster does: the sheet
  closes first, the page replaces the conversation, and Back or Escape returns to the chat rather
  than to the form the reader left. The page is opened on the bot's **profile** name, not on the
  name the reader has chosen to see — routinely the same word in a different case, which is the
  difference that would otherwise surface as a route answering 400.

- **An attachment the gateway serves can actually be previewed.** Opening a remote attachment used
  to fetch it from the native side with no credentials at all — no bearer, no Cloudflare Access
  header, no cookie — so on any gateway that is not wide open it was a request that could never have
  succeeded, and the failure arrived as a share sheet that looked like "Quick Look has no previewer
  for this". The download goes through the same authenticated client as everything else now, into
  the caches directory, and Quick Look is handed the local copy. So does the share sheet, for a type
  with no previewer: the receiving app is given a file rather than an address it would have to
  authenticate to on its own. **The gateway has no route that serves an attachment back yet**, so
  none of this has met a real server; `docs/platform-notes.md` says what that first meeting is most
  likely to break.

- **The way out of a failed probe goes when the address changes.** The onboarding address step
  offers a button under a failure — "use the host that answered", "open the front door" — and the
  button is built from the address that failed. Editing the address cleared the MESSAGE and left the
  button, so a stale offer sat under a "checking…" line: pressing it would have configured a
  Cloudflare Access credential for a host the reader had already stopped typing. The offer now goes
  the moment a new probe starts, which is also when its message goes.

- **Escape goes back one level in two more places.** Cancelling a theme deletion in Settings ▸
  Appearance ▸ Advanced, and closing the detail card on a bot's memory map, are levels of their own
  now. Both used to be skipped: the question and the card are drawn in place rather than presented,
  so nothing registered for the key and the first Escape closed the whole screen — with a
  destructive question still on it, in the first case. Android's back button does the same one
  level in both.

- **Controls say what they are under a pointer.** The drag grip on a chat row and on a folder row,
  the rows of the chat's (…) popover, and every button in the app — which is what the memory rows
  and an inline approval's answers are made of — now take a pointer cursor and a tint while the
  mouse is over them. A disabled button takes neither, which is what the cursor already did. The
  conversation itself is deliberately untouched: nothing in a transcript lights up because a mouse
  went past it.

- **The Mac window no longer restyles itself when you click another app.** Every glass surface in
  the app is a `UIVisualEffectView` underneath, and macOS draws those dimmed in a window that is not
  the front one — so Hermie's chrome visibly changed the moment you went somewhere else. UIKit
  offers no way to opt a visual effect view out of that, so the app stops having one on screen while
  its window is behind another: each surface falls back to its own rung of the elevation ladder,
  which is the same recipe Android and Reduce Transparency already get. Only on a Mac — the phones
  and the iPad go `inactive` every time the notification shade comes down, and nothing there
  changes. The window's title bar is still the system's and still dims with every other Mac title
  bar.

- **The header pill keeps its width while the bot thinks.** The owner reported it still changing
  size after the status line had already been taken out of the pill's intrinsic width — and
  "an absolutely positioned child cannot widen its parent" is an argument about one layout engine's
  box model, which this component has to win on four targets, one compositing the pill as a native
  glass surface and one drawing the name as a line-clamped `-webkit-box`. So the width stopped
  being derived. A ruler measures the name once, with nothing around it and nothing to shrink
  against, and the pill's text column is given that number as an explicit width. From then on the
  only thing in the world that can move the pill is the bot being renamed.

### Changed

- **Boards gets the whole column on an iPad, a Mac and a wide browser window.** Opening it from
  Settings, or from the chat list's **Boards**, used to leave it inside whichever panel the door
  was in — the 520pt settings overlay, or the sidebar, which is 300 to 340. The board needs 700 to
  put its columns side by side, so nobody with a big screen had ever seen the side-by-side layout
  or the card drag that goes with it: they were there, and no window could reach them. The board
  now opens where a chat opens, beside the list and edge to edge, which is past 700 on every device
  wide enough to have two columns at all. The way back is one step and it is the step you came by —
  from Settings it puts Settings back, from the chat list it hands the column to the chat. A phone
  is unchanged: there is no second column to move into, so the board still replaces the page it was
  opened from, stacked, with Back where it always was.

- **Hermie Web's tests are type-checked.** That package is the one workspace that emits JavaScript
  rather than only declarations — the release zip and the Docker image both run `dist/server` — so
  its `tsconfig.json` excludes `*.test.ts`, or the tests would be published with it. The side effect
  was that nothing type-checked the tests at all: a suite could build a push registration without
  its owner, or read an argument a mock never declared, and only a runtime failure on that exact
  line would ever have said so. A second project (`tsconfig.test.json`, emitting nothing) now covers
  them and runs as part of `npm run typecheck`. Switching it on found eleven errors, all in tests,
  all now fixed.

- **The release notes describe all three signed binaries, not two.** The iOS app ships as an app, a
  widget extension and a share extension, and each needs the App Group to reach the others — a
  widget cannot dial a gateway and a share extension is killed the moment its sheet closes, so the
  shared container is the only way anything gets across. `docs/release.md` listed two App IDs where
  there are three, so anybody setting up a developer portal by hand would have provisioned
  `dev.hermie.app` and `dev.hermie.app.widgets` and met the failure on `dev.hermie.app.share`. It
  now has the full table, what `-allowProvisioningUpdates` creates by itself, and the three things
  it does not.

- **A permission request can be answered from the transcript, without the sheet.** ADR-0010's sheet
  stays — a question that holds the agent's turn has to arrive in front of the reader rather than
  wait in a transcript they may have scrolled away from — but it is no longer the only way through.
  The request card in the transcript draws the choices itself, and a tool card can draw them too.
  The buttons are exactly the gateway's own `choices` in the gateway's own order on every surface,
  both read the same request store, and an inline answer takes the sheet down with it rather than
  leaving it up to report what the reader just did. Clarifying questions keep the sheet and only the
  sheet: a stepper over several questions, some of them free text, does not belong on a transcript
  row. ADR-0010 is amended.

- **Folders can be dragged.** The drag hook was keyed by bot name from end to end and rebuilt the
  lifted row's key as `bot:<name>`, so the one row it could never pick up was a folder — the lookup
  for its anchor could only miss, which put the lift's origin at the top of the list and moved every
  neighbour the wrong way. It now speaks row keys (`bot:<name>` / `folder:<id>`) and nothing else,
  and hands the key back on commit for the screen to make sense of. A folder row gets the same grip
  in edit mode, the same long-press arming, and the identical lift, shadow, neighbour shift and
  settle as a chat row rather than a second copy of the gesture. One rule is a folder's own: it can
  only land at the top level, because folders do not nest, so a drop aimed inside another folder
  means "next to that one". Dropping a chat ONTO a folder still puts it inside. ADR-0019 is amended.

- **The chat's (…) menu is a popover in the chat, not a sheet that moves the chat.** The owner's
  report was one sentence — *"menu in een chat moet popover in een chat zijn. nu schuift alles"* —
  and the sheet was the reason: it dimmed the window, took the keyboard and on a phone pushed the
  transcript up to make room for itself. The first level is now a floating glass surface anchored
  under the header, drawn the way the composer's `+` menu already is, and laid out absolutely: the
  transcript's own content inset is the same number open as closed, which is asserted rather than
  asserted-by-eye. It carries the two mode switches, the four rows that lead somewhere, and the
  view group — verbosity, bot-to-bot, thinking, text size — as compact rows. Anything that is a
  PAGE still opens the sheet, and opens it already on that page rather than at the root: a model
  picker is as long as the gateway's catalogue and a popover is not where a hundred models go. A
  tap anywhere else closes it, Escape closes it one level, and ↑ / ↓ / Return walk it on a
  keyboard. On a column too narrow for it the sheet is still the honest answer — decided by
  MEASURING the chat column, never by asking which platform this is, because a Mac window dragged
  narrow and a phone are the same problem.

### Added

- **Make a bot from the app.** The chat list's header gains **New bot…**, and so does Settings.
  Name it, describe it, pick a model from the gateway's own catalogue, optionally clone another
  bot's settings, and the new conversation opens. The handle is checked while it is typed, against
  a transcription of the gateway's own validator — `^[a-z0-9][a-z0-9_-]{0,63}$`, the six reserved
  names, and `default`, which is the one name that is simultaneously legal everywhere else and
  refused here because it IS the built-in bot. `Scout` is accepted and stored as `scout`; a name
  that collides with a `hermes` subcommand is accepted with a note that the shell shortcut will not
  be made, because that is what the gateway does rather than what looks tidy. Creating a bot does
  not mint its chat: the gateway writes a profile directory and nothing else, so the roster is
  re-read and the canonical Bot Chat is resolved the ordinary way (ADR-0007), which is the only
  thing standing between a new bot and a forked conversation. **There is no delete**, and its
  absence is deliberate: the gateway has no profile-delete method at all — `methods_profiles.py`
  registers list, create, describe, configure and the two asset calls, and that is the whole
  surface — so a danger zone here could only ever have failed. `hermes profile delete <name>` on
  the host is where it lives.

- **What a bot can do, per bot.** The bot profile sheet gains **Capabilities**: toolsets, skills
  and MCP servers as three groups of switches, each writing immediately. The three are stored with
  three different polarities in one gateway call and the sheet is only correct because it keeps
  them apart — skills go over the wire as the DISABLED list, MCP servers as the ENABLED one, and
  toolsets as a pin whose EMPTY value means "follow the gateway's defaults" rather than "nothing is
  on". That last one is said out loud in the sheet: a bot with no pin is following the gateway, and
  the first switch anybody moves pins the whole list. Changing an MCP server offers a reload,
  because a config change does not reach a chat that is already running — and `reload.mcp` is the
  one call in this family that can refuse by SUCCEEDING, answering `confirm_required` with a 200
  and the gateway's own warning about the prompt cache. Hermie shows that warning and its two
  answers; **Reload, and stop asking** is the gateway's `always`, which silences the CLI and the
  desktop app too, and says so.

- **MCP servers, in Settings.** The gateway's servers with what each one is, whether it is
  connected, and what it offers. Nothing is probed on arrival — `mcp.servers.test` connects, and a
  cold `npx` server takes seconds — so the list paints from the configuration and the gateway's own
  cached runtime view, and testing a connection is a button on the server's page. A server behind
  OAuth can be authorised from here: the gateway's URL opens in the browser and the flow is polled
  until it settles. The needs-auth state is a PROBE result rather than a list badge, because the
  cheap status view never connects and cannot tell an unauthorised server from a healthy one — and
  a server that declares OAuth is reported that way whether or not it is signed in, so "needs
  authorising" is the pair: wanted, and no token.

- **Skills, in Settings.** What is installed, with a switch per skill for a chosen bot, and a
  search of the hub with an **Install** on anything not already there. The two halves come from two
  methods that each answer half the question: `skills.manage` says what a bot has and never whether
  it is on, and only `profiles.describe` says that. Without a bot chosen there are no switches
  rather than switches at a guessed position. Installing over the socket works and is used; the
  `hermes skills install` command is printed only when a gateway answers that it has no such
  action at all.

- **Read a reply aloud.** A reply's menu gains **Read aloud**, and **Stop reading** while it is
  speaking. The voice is the one built into the device — `AVSpeechSynthesizer`, Android's
  `TextToSpeech`, the browser's `speechSynthesis` — so **nothing is sent anywhere to be
  synthesised**, which is the whole reason it is the default rather than a fallback
  (ADR-0021). What is spoken is not what is drawn: a fenced listing is read as `Code block, 12
  lines` unless it is short enough to be the answer itself, a table is read a row at a time, a link
  reads its label rather than its target, and mathematics is read **as its source** — an emphasis
  stripper turns `a_1 + b_2` into `a1 + b2`, and wrong is worse than plain. A chat can be set to
  **read each finished reply automatically**; it never speaks while a reply is still being written,
  it queues a reply that lands while another is being read, and switching it on does not start
  reading the back catalogue. Speaking stops when you leave the chat, and when the app goes to the
  background unless you say otherwise. The speaking rate is one setting for the whole app; whether a
  reply is read on its own is per chat, because a phone in a car and a Mac in an office want
  different answers for the same bot.

- **Dictate a message.** A microphone appears in the composer, left of send, wherever the platform
  has a recognizer. **Hold it to talk** and let go, or **tap it** and tap again — one button, and
  the rule is how long your finger stayed down, which is how the platform keyboards' own dictation
  keys behave. What is heard streams into the field **at the caret** as you speak, so a sentence
  dictated into the middle of a half-typed message lands where you put it; a revision replaces the
  last guess rather than being appended to it. Nothing is sent: what you get is a draft like any
  other, to edit and send yourself.

  On iOS and Android the recognizer is asked for the **on-device** model, and a device that has no
  offline model is refused rather than quietly falling back to the network — the words are a message
  you are about to send to your own gateway. That guarantee does not hold in a browser, where the
  Web Speech API transcribes on the vendor's servers and offers no switch; Firefox has no such API
  and gets no microphone at all rather than a button that cannot work. A refused microphone says so
  in one line under the composer, with **Open Settings** where there is a settings screen to open.
  The dictation language follows the device by default, and the picker offers the languages the
  device reports it has installed offline.

- **Voice mode.** A full-screen overlay that runs the conversation hands-free: listen, send, read the
  reply aloud, listen again. It is reached from the chat's options sheet, and from the composer's
  microphone as an accessibility action — deliberately **not** from a long press on that button,
  because a long press is how you hold the mic to talk and a menu there would take the gesture away
  from the feature the button exists for. One ring shows what is happening: it grows with your voice
  while the microphone is open and breathes slowly while a reply is being written or read. Under
  Reduce Motion it does not move at all.

  Four rules make it usable rather than alarming. **It never sends an empty transcript** — a pause
  that produced nothing goes round again instead of asking the bot to answer silence. **It shows
  what it heard for a second before sending**, with a cancel under it, and that is on by default:
  voice mode speaks for you, and a recognizer that mishears should not be able to put words on a
  conversation with no moment to stop it. **A silence ends the utterance** — the recognizer's own
  final result where it gives one, and 1.5 s after the last thing heard where it does not, with the
  timer armed only once something HAS been heard so a slow start is not cut off. And **leaving stops
  everything**: swipe down or press Escape, from any phase. A tap does not leave — it interrupts the
  reply being read, which is the commonest thing you want in a conversation. While voice mode is
  running, "Read replies aloud" stands down, so one device with one speaker never reads the same
  reply twice.

- **Refresh a chat.** The chat's options carry **Refresh**: it re-reads the roster — which is where
  a chat's canonical session id comes from — and re-opens the chat against whatever that answers,
  which resumes and replays it. The case it is for is the one a pull gesture cannot express: the
  gateway restarted, the runtime session this chat was bound to no longer exists, and the transcript
  on screen belongs to a conversation nothing is listening to any more. A reader who suspects that
  needs something to press, and on an inverted transcript a pull already means "older messages".

- **Per-chat notification types.** Beyond mute, which is "say nothing at all": the chat's options
  now carry **Notifications** — finished a turn, a turn failed, needs your answer, scheduled runs —
  per bot and per account, so a bot whose cron deliveries are noise can stay quiet about those and
  still wake you when it fails. An override is PARTIAL: a type a chat says nothing about follows the
  global switch in Settings as that switch moves, and putting the last one back leaves nothing
  behind. It rides beside the device registrations in the same `push` section the notifier already
  reads, at `hermie-app.push.perBot.<bot>.<type>`, because it is a decision about the reader rather
  than about a device — the same argument the mutes make. The section version is deliberately NOT
  bumped: `v` is checked per row and an unreadable row is dropped, so a bump would unregister the
  device instead of protecting the key, and a notifier that has not learned the field yet simply
  keeps honouring the global types.

- **Chat text size.** Settings → Appearance and the chat's own options both carry **Small /
  Default / Large / Extra large**, and it changes the size of the words in a conversation — the
  bubbles, the markdown and the code blocks — and of nothing else. It is a factor ON TOP of the
  device's own text size rather than a replacement for it, which is the case Dynamic Type cannot
  express: the chrome the size the system asked for, the conversation bigger, because the
  conversation is the part that gets read for minutes at a time. The scale reaches the transcript
  through a provider around it rather than through a prop on every bubble, so a component added
  tomorrow follows it without being told to. One setting per account, carried between devices by
  the settings sync, and a gateway section written by a build that has never heard of it leaves
  this reader on their own size rather than resetting them to Default.

- **More than one gateway.** Settings → **Gateways** lists every gateway this device knows about,
  with its name, its address, how it signs in and who is signed in on it, and marks the one Hermie
  is connected to. Tapping a row connects to it: Hermie talks to one gateway at a time, so it
  disconnects, dials the other and paints that gateway's chats from its own cache while the dial is
  in flight. **Add gateway** runs setup for another machine and comes straight back — the gateway
  you are on stays connected, because describing a second machine is not asking to be moved onto it.
  Each gateway has a page of its own for the things a mis-tap must not reach: renaming it (a name on
  this device, sent nowhere), signing out of it, and removing it, which asks first and then takes its
  address, its credentials, its conversations, its arrangement and its settings with it. The chat
  list names the gateway once there is more than one to tell apart.

  Everything stored is now keyed by which gateway it belongs to, so the two do not mix: their
  sign-ins, their cached conversations, their read marks, their chat arrangements and their
  notification registrations are separate even when both gateways have a bot with the same name.
  Your existing gateway becomes the first entry on the first launch, with nothing to do and nothing
  lost. Light or dark stays a setting on the device; the theme follows the account, as it already
  did. [ADR-0024](docs/adr/0024-a-list-of-gateways.md)

- **A notification, a link or a widget tap lands on the right gateway.** Notifications now say which
  gateway sent them, so tapping one from a gateway you are not on switches to it first and then
  opens the chat — and stops there rather than answering a request, because an approval has to be
  re-read on the gateway that asked. `hermie://chat/<bot>` takes an optional `?gateway=` for the
  same reason. A key that names a gateway this device has not been set up against does nothing at
  all: it can only ever select one you already configured.

### Changed

- **Change gateway now edits the gateway you are on, rather than replacing it.** Correcting an
  address or a port keeps that gateway's chat arrangement instead of starting from an empty list,
  which is what the arrangement being keyed by address used to cost. Moving to a different machine
  is **Add gateway**.

- **The card that appears when a gateway cannot be used names it, and offers the others.** On a
  device with more than one gateway configured, a refused connection, an address that answers like
  something else, a rejected certificate or an expired session all list your other gateways by name
  under the explanation — after the ways of fixing the one that is broken. The developer connection
  screen names the gateway whose sign-in history it is printing, since there is now one per gateway.

## [0.1.2] - 2026-09-22

### Added

- **A lock on the app itself.** Settings → Privacy & security → **Require unlock**: off, immediately,
  or after 1, 5 or 15 minutes in the background. It asks with Face ID, Touch ID, Optic ID or
  Android's BiometricPrompt, and falls back to the device passcode the way the platform does; a
  device with nothing enrolled is told to set something up first rather than being locked out of its
  own chats. A locked Hermie does not draw the app under a plate — it does not render it at all, so
  there is no transcript, no chat list and no connection behind the lock screen, and nothing for the
  app switcher's snapshot to photograph. The plate is also the first thing on screen after a cold
  start, before anything is read from the gateway. The setting stays on the device it was made on:
  it is not carried to a second device by the settings sync, because a phone in a pocket and a Mac
  in a locked room are not the same question. In a browser there is no lock and the screen says so —
  a plate drawn over this app's own page is removed by the page's own devtools.

- **Cloudflare Access, as a preset rather than as two headers you have to know the names of.**
  Setup → Advanced now asks which proxy is in front of the gateway: **Custom headers**, which is the
  name/value rows it has always had, or **Behind Cloudflare Access**, which is a Client ID and a
  Client Secret. The service token rides on every REST call, the WebSocket dial, the ticket mint
  before it and both of the probe's requests — and on the sign-in page, where a document-start
  script also puts it on the page's own `fetch` so the gateway's `/login` form reaches the gateway
  instead of the Access login screen. It is stored in the keystore bound to the gateway origin it
  was entered for, so it cannot follow the app to another address, and it is withheld from an
  `http://` gateway with the reason on screen rather than in silence. Nothing prints it: the
  developer screen says `cf-access: present` and header values are redacted wholesale rather than by
  a list of names. One limit is stated up front in the field's own hint rather than discovered as a
  403 halfway through a sign-in — a service token cannot carry a redirect-based sign-in through the
  edge, so `/auth/*` and `/login` have to be exempt from the Access policy. Setup also restores the
  headers and the preset after a sign-out now, which it never did: a gateway behind a proxy could
  not get past its own probe to reach the sign-in it had reopened for.
  [ADR-0021](docs/adr/0021-header-based-front-doors.md)

### Changed

- **Setup says which of your problems you have.** An address that answers with a web page, on a
  host only one network can reach — an RFC 1918 or Tailscale address, a `.ts.net`, `.internal` or
  `.local` name — now says so: *this address only answers on a private network, is this device on
  the VPN/tailnet?* So does an address that will not resolve at all while the device is on mobile
  data. It stays quiet everywhere the same evidence would be a guess: a public name that answered
  with somebody's front page says nothing about a tunnel, an unreachable address on Wi-Fi is as
  likely to be a gateway that is switched off, and `localhost` is a network nobody can join. A
  failure that has a next move in it now offers one as a button rather than describing it — **Use
  &lt;host&gt;** when a redirect landed somewhere else, and a way straight to the proxy credentials
  when something refused before the gateway was reached.

- **Edit and resend, and Regenerate.** A message's own menu gains two lines that start a turn: on one
  of your own turns, **Edit and resend** puts the text back in the composer with the attachment
  references it carried — the turn already in the conversation stays exactly where it is, which is
  why the line says "and resend" rather than "Edit"; and on the newest reply, **Regenerate** asks for
  it again. Regenerate takes the gateway's own `/retry` down the ordinary slash path where the
  catalogue has it, so the conversation gains a reply rather than a second copy of the prompt, and
  falls back to sending the previous prompt again where it does not — which is what a reader would do
  by hand, and honest about there now being two turns. Both are **drawn disabled while a turn is
  running** rather than disappearing, because a line that vanishes for the length of every turn is a
  line nobody believes in, and both refuse at the tap as well. Regenerate is offered on the last
  reply only: appending an answer to a question three turns back would be worse than no line at all.

- **Export a conversation.** The chat's options sheet offers the transcript as a Markdown file or as
  plain text, handed to the share sheet on the phones and the Mac and downloaded in a browser. Both
  formats are offered because neither is a default: a `.md` is for somewhere that renders it and a
  `.txt` is for somewhere that does not. **What is exported is what is on screen** — the verbosity
  filter, the bot-to-bot toggle and the thinking toggle have already been applied, so a chat set to
  Quiet exports the quiet conversation rather than handing somebody rows they have not read. Tool
  calls, notices, permission requests and bot-to-bot lines are written as asides rather than
  attributed to a speaker; the transient one-liners are left out, because a file of things that are
  no longer true is not a record. A reply's own Markdown survives into the plain-text file untouched:
  those are the author's characters, and an export must not quietly edit what it is preserving.

- **How full the context window is, in the chat.** The options sheet gains a read-only row with a
  ring, the percentage and both counts — `82% · 164k / 200k` — and the bot profile's read-only block
  says the same thing in words. It follows the live `session.usage` ticks and the usage on
  `message.complete`, so it is current after every turn without anything polling, and opening either
  sheet asks the gateway once for the chat that resumed and has not been spoken to yet.
  **A gateway that does not report a window size gets one fewer row and nothing else** — no error, no
  ring at zero, and one refused call per connection rather than one per conversation. There is
  deliberately no table of model context sizes behind the figure: a table like that is a promise
  about somebody else's product, and when it goes stale it tells a reader they have room they do not
  have.

- **Diagrams and mathematics are drawn, not printed.** A ```` ```mermaid ```` fence is a picture in
  the bubble and `$…$` / `$$…$$` is set as mathematics, on every platform, with no web view and no
  downloaded fonts — which is the whole of the decision rather than an implementation note. A
  renderer that learns its own size a frame late moves the reader on an inverted list by exactly the
  correction, so the geometry is computed from the label text and the font size before the row
  mounts, and `$$…$$` joins tables and fenced code as a block the reading fold will not cut through.
  The supported subset is `flowchart` / `graph` in all four directions with the common node shapes
  and edge kinds, and the LaTeX a chat agent actually writes: symbols, scripts, fractions, roots and
  the big operators with their limits. **Anything outside it falls back to the source in a code
  block** — a `sequenceDiagram`, a `subgraph`, `\begin{matrix}`, or a fence that has only half
  arrived — because a picture that quietly leaves out what the author asked for is worse than the
  text it was made from. Mathematics also selects and copies as its source, delimiters included, so
  an equation dragged out of a reply on a Mac pastes back into something that understands it.
  [ADR-0020](docs/adr/0020-diagrams-and-math-without-a-webview.md).

### Fixed

- **A slash list that cannot load says so instead of showing nothing.** Typing `/` against a gateway
  that refused `commands.catalog` or `complete.slash` drew an empty composer — the same build showed
  the list on the web and on a simulator, and the only record of the refusal was the developer
  screen's ring. The popover now opens on a refusal too, with one non-selectable row naming the
  method and repeating the gateway's own words, and it clears on the next answer that works. A first
  catalogue fetch still in the air after 400 ms draws a `Loading…` row, so a slow gateway is
  distinguishable from a silent one. The catalogue refusing while `complete.slash` answers is shown
  as well, because that is the state where the list looks right and Return sends the pick as prose.

- **Arrow keys keep the highlighted command on screen.** ↑ and ↓ moved the selection in the slash
  popover and nothing else, so against a gateway that answers a bare `/` with thirty-four commands
  the highlight walked out of the bottom of the list on the fourth press and every press after that
  did nothing visible. The rows report their own boxes and the list scrolls the highlighted one
  fully into view — its top when moving up, its bottom when moving down — leaving a row that is
  already visible exactly where it is, and asking for the destination rather than the journey under
  Reduce Motion.

- **A collapsed folder counts a muted chat's unread messages.** It did not, and closing a folder
  therefore deleted information: four messages visible on a muted row while the folder was open, and
  no badge at all once it was shut. Mute stops the buzzing, not the counting — the same rule a single
  row already followed by drawing the bell and the unread pill side by side. The needs-input dot
  still excludes muted chats, because that one is a summons rather than a tally. ADR-0019 said the
  wrong rule for both numbers and now states the split.

### Changed

- **One grip to hold, instead of two arrows to aim at.** A chat row in edit mode carried a pair of
  ↑/↓ buttons inside its 26pt drag column, which put three tap targets in the space of one and made
  the outer one — the thing a reader is meant to grab — the hardest of the three to hit. The column
  is now a single six-dot grip labelled "Hold to drag", and nothing in the row is an arrow. Stepping
  one position at a time did not go with them: it is on the row's own accessibility actions, where
  VoiceOver's rotor and a keyboard both already look, and in the row's context menu as before. A
  folder gains the same pair in its menu and its accessibility actions.

- **A bot's profile name is visible, and it leads.** `profiles.list` gives two names — the handle
  (`lance-vance`), which is what `@`-addressing, crons, DM lines and the gateway's own logs use, and
  the display name ("Netwerkbeheerder"), which is a label somebody typed — and the app showed only
  the second. A reader looking at a chat list could not tell which bot an `@mention` elsewhere in the
  app referred to. Both are drawn now: the chat list row, the chat header pill and the bot profile
  sheet carry a large line and a small one, and **Settings → Appearance → Bot names** swaps which is
  which, app-wide, stored per account in `ui_meta`. The widget's single line follows the same choice.
  A bot whose display name was never set, or is its handle in different case, still shows one line.
  The profile sheet's About group separates "Profile name" from "Display name" instead of labelling
  one of them with the other's name.

## [0.1.1] - 2026-09-22


### Added

- **Share to Hermie, from any app.** An image, a file, a link or some text goes straight into a
  chat. On iPhone, iPad and Mac a small sheet inside the other application lists your bots — read
  out of the same snapshot the widgets draw from, so it opens instantly and without launching
  anything — takes an optional note, and hands over. On Android the system's own chooser starts
  Hermie and it asks which chat once it is up, which is the same question one screen later. Neither
  can send anything: a share sheet has no gateway, no socket and no credentials, so what they write
  is a durable entry in a directory the app reads. A share made with no route to the gateway waits
  there, its chat's row says so, and it goes out on the next reconnect. Five screenshots and a note
  are one message with five attachments, by the same two roads the composer already uses.

- **Shortcuts, Siri and Spotlight.** Four actions. _Ask a bot_ sends a message and waits for the
  reply, so it can flow into the next step of a Shortcut or be spoken back by Siri; _Send to a bot_
  returns as soon as the gateway has the prompt, which is the honest answer for anything that takes
  real work; _Open a chat_ is a Home Screen button; and _Bots needing input_ reads the widgets'
  snapshot and answers without opening Hermie at all, so it runs from an automation with the phone
  locked. The three that send bring the app forward, because the gateway session lives inside it.
  Forty-five seconds is what _Ask_ waits; a turn still running when that runs out says so and points
  at _Send to_. Bots are indexed in Spotlight as the roster changes, and a result opens that chat.

- **A widget for one folder.** The medium widget can be pinned to a folder of your chat list instead
  of the whole of it: that folder's three most recent chats, with the folder's name, its unread
  badge and a dot when something inside is waiting on you. Tapping the header opens the list with
  that folder expanded and scrolled to. The two numbers follow the chat list's folder rules — unread
  counts muted chats, the needs-input dot does not — which means a folder can show a count that no
  row inside it shows; see `docs/platform-notes.md`.

- **A gateway that cannot be used says which gateway it is.** A fresh install inherited a stored
  address from an earlier one, and all the app had to say was that the endpoint was not what it
  expected: no address on screen, nothing to press, and reinstalling as the only way out. The
  signed-out card is now the card for every stop — a gateway that does not trust the address, a
  takeover, chat switched off, a rejected certificate, an address that is not a gateway or leads
  somewhere else, a version too old — and it names the stored address in the parts a reader checks
  it by (scheme, host, port), says who the gateway last reported they were, explains the failure in
  one sentence with the connection's own hint under it where there is one, and offers **Re-check**,
  **Change gateway** and **Sign out**. A reconnect that is still climbing keeps the chat's quiet
  notice instead: the card is for the loop that has stopped, not for the one that is working.
  **Change gateway** is no longer destructive — it reopens setup on the address step with the
  address filled in, leaves everything on disk, can be cancelled, and drops the stored sign-in only
  at the moment a different address is saved. Settings gains the same address parts and a separate,
  confirmed **Forget this gateway**. In a browser there is nothing to change, so the card says the
  server decides the gateway rather than offering a step the web wizard does not have.

- **Push notifications, from the server you already run.** `hermie-web --push` holds one connection
  to its gateway, resumes every Bot Chat, and notifies registered devices about four things: a new
  bot message in a chat nobody is reading, an approval or clarify request opening, a bot-to-bot DM,
  and a cron delivery or cron error. There is no hosted service, no account and **no inbound
  endpoint** — a device registers by writing into the gateway's own `ui_meta`, so the only way into
  the path is an authenticated write to the gateway, and the app never talks to the daemon at all.
  An open approval is found in the snapshot a resume answers with and in a 30-second
  `approval.pending` poll — the daemon deliberately does **not** ask the gateway to route questions to
  it, because it would never answer one and a gateway that routes to a single peer would then have
  taken the question away from the owner; `--push-server-requests` opts into the live route for
  operators who know their gateway fans them out.
  A notification carries a bot name and an event type; the message text travels only to a device
  whose owner turned preview on, because a lock screen is not private. An approval's Allow and Deny
  answer nothing by themselves: the app opens, re-reads the gateway's open requests, and responds
  only if that request is still open and still says what the notification said.
  [ADR-0017](docs/adr/0017-push-through-hermie-web.md) is the design and the threat model;
  [docs/web.md](docs/web.md#push-notifications) and
  [deploy/web/README.md](deploy/web/README.md#push-notifications) are what a self-hoster needs,
  including the two costs said out loud — a watched chat is a chat the gateway will not evict, and a
  daemon that is not running sends nothing.
- **Both push transports, with no dependencies added.** Expo for phones, with receipts read back
  afterwards rather than tickets trusted at send time — a sender that stops at the ticket pushes to
  uninstalled apps for ever. Web Push for browsers, implemented from RFC 8291 and RFC 8292 out of
  Node's own `crypto`: the payload is encrypted end to end to the key pair the browser generated, so
  the push service forwards ciphertext it cannot read. The application-server key is generated on
  first run into the state directory and served at `GET /push/vapid-public-key`; it must stay stable,
  because a browser's subscription is bound to it.
- **`hermie-web login`, for a gateway behind OIDC.** The native PKCE flow run from a terminal: it
  prints the authorisation URL rather than opening one, listens on the loopback redirect for a single
  callback, and stores the refresh token at `0600`. A provider that issues no refresh token is
  refused with the `offline_access` scope named, rather than a credential that lapses in an hour
  being quietly stored.
- **Home-screen widgets, on every platform.** One chat as a small square — avatar, name, presence
  bead and the last line — the three most recent as a medium one, and on iOS a lock-screen line that
  says how many conversations are waiting on a person. Tapping one opens that chat through
  `hermie://chat/<bot>`, which the app now reads: the scheme was always registered and nothing had
  ever listened. A widget process has no gateway and no store, so everything it shows is derived
  once, in the app, by the same `presenceOf`, `unreadCountSince` and `formatPreview` the chat list
  uses, and written into a shared container as one versioned file. The consequence is worth stating
  plainly: **a widget shows what Hermie last saw.** There is no push and nothing polls a gateway in
  the background, so a phone whose Hermie has not run for a week shows a week-old widget.
  `apps/hermie/modules/hermie-widgets/README.md` is the design; the widgets section of
  `docs/platform-notes.md` has what was measured, including the two grey beads that came from
  backgrounding the app and the two attempts it took to stop writing them down.

- **Your arrangement follows you to a second device.** The chat list's order, its dividers, which
  bots are archived, each chat's colour, the theme and the view defaults are stored in the gateway's
  `ui_meta` — under two keys Hermie owns, per profile, guarded by the per-key compare-and-swap
  upstream already had. The device's own copy is still what the app paints from, so it opens before
  the socket has answered and works with no gateway at all; a write the gateway refuses or never
  receives stays local and goes out on the next reconcile. A key another tool owns is never touched:
  the `hermes-bots` marker is what makes a profile a bot, and a client that wrote its settings by
  replacing the bag would un-bot every profile it coloured. [ADR-0016](docs/adr/0016-ui-meta-sync.md)
  has the design and the probe against a real gateway that settled it — including the one thing the
  fake gateway had wrong, which is that a key written as `null` is removed rather than stored.

- **Themes, and a theme is now a thing rather than a wallpaper.** Six of them — Blue, Graphite and
  Lime, each with a light and a dark face — and a preset is exactly three pieces of data: a
  background, an elevation ladder and the accent that **Default** resolves to. Everything else falls
  out of those. Every glass surface is the scheme's wash over a rung, a native Liquid Glass tint is
  that rung at an alpha (`withAlpha(solid, α)`, which the hand-written dark tints already satisfied
  to the byte), and a bubble's tail is the bubble's own composite — exact now that there are no
  gradients left, where the old tail colours were tuned by eye against stops that no longer exist.
  Adding a theme is therefore adding eleven values, with no second place to half-add it.
  Settings → Appearance shows them as **cards** rather than as a row of names, each painting its own
  floor, its own panel and a bubble pair in its own accent, resolved through the same function the
  live window is built with. `--hermieWallpaper` is `--hermiePreset`.
- **Lime is the studio's `#C7FF4A`, and the swatch splits it three ways.** That value is a RING
  colour: white on it measures about 1.3 : 1, so a bubble painted in it is a message nobody can
  read. `fill` is the studio lime for rings, swatches and links' company; `bubble` is the same hue
  taken down to `#4A7F15`, where white clears AA; `text` is the ink form. It is the pattern Slate
  already used, and it is also why two places that used to put white on a `fill` no longer do — the
  composer's send button takes the bubble, and a swatch's check mark picks whichever of black and
  white reads on the colour under it.
- **Themes of your own, under Settings → Appearance → Advanced.** Start one from a preset, edit its
  background, its accent and its bubble per face, rename it, delete it. A colour is refused by
  `judgeThemeColour` — the same function `npm run contrast:check` measures with, not a second copy
  of the rule — and the refusal quotes the ratio it measured. They are stored app-wide, so they
  travel with the reader (see ADR-0016).

- **Hermie runs in a browser, served by a small process of its own.** `npx @hermie/web --gateway
  http://127.0.0.1:9119` puts the app on `http://127.0.0.1:9120` and proxies the gateway onto that
  same origin, which is the whole design rather than a deployment detail: the gateway's session is
  an `HttpOnly` cookie, and it refuses a WebSocket whose `Origin` is not its own — the defence that
  stops a page on the internet from pointing a name at your loopback interface and driving an agent
  that runs shell commands. Same-origin is what lets the browser build use that session instead of
  asking the gateway to relax the guard. It therefore signs in the way the gateway's own dashboard
  does — `/auth/login`, or a password form straight into `/auth/password-login` — and mints a
  single-use ticket per dial, because `new WebSocket(url, protocols)` is the entire API a page has.
  The wizard has one step fewer: there is no address to type when the server in front of you has
  already fixed it, so it shows the gateway host and moves on. `deploy/web/README.md` has the
  systemd unit, the Docker image and the Caddy, nginx and Tailscale Serve configurations;
  [ADR-0015](docs/adr/0015-web-variant-on-its-own-port.md) has the reasoning, including what a
  browser cannot be given: no keychain, no extra headers on an upgrade, and a file picker whose
  cancel is a heuristic rather than an event.
- **Hermie Web can update itself, where the install shape allows it.** Settings shows the running
  version next to the newest release and, for a directory install, an Update button: it downloads
  `hermie-web.zip`, checks it against the release's `SHA256SUMS`, unpacks it beside the running one,
  flips a `current` symlink and exits so the supervisor starts the new code — then the page polls
  `/healthz` until the NEW version answers and reloads. Docker and `npm -g` installs say
  `canSelfUpdate: false` and name the command that does work, because the image (or npm) is the
  version there. The POST is gated on the caller's own gateway session, checked by putting their
  cookies to `/api/auth/me`: Hermie Web has no user database and is not going to grow one. The
  digest is not a signature, and the ADR says so out loud.
- **Settings ends with the build it is.** `Hermie 0.1.0 (68) · 79ad86d` — the version, the build
  number and the commit, because "which version" is the first question on every bug report and a
  version string alone cannot tell two builds of 0.1.0 apart. The build number is the git commit
  count, which is also where `ios.buildNumber` and `android.versionCode` now come from, so the three
  can never disagree; a checkout with no git history says `dev` rather than failing the build. A
  long press copies the line where there is a pasteboard to copy it to.

- **The Warm and Slate wallpapers are gone, and the entry below is what they were.** The set is
  three themes now. Graphite absorbs what Slate was FOR — a matte floor whose panels sit a step
  above it rather than a chasm above it — at a neutral grey rather than a grey-blue, which is what
  makes it Blue's counterpart instead of a second Blue; a stored `slate` reads back as Graphite and
  a stored `warm` as Blue, so nobody's device comes back with no theme. The `slate` and `graphite`
  ACCENT swatches are untouched: a conversation's colour was never a function of the wallpaper.

- **A fourth wallpaper, Slate, and it brings its own bubble colour.** Graphite was compared first and
  measured rather than eyeballed: its dark ramp is near-black (`#171B22 → #0D0F14`), where Slate's is
  about three times that luminance (`#3B4552 → #2E3640`), so on Graphite the panels are pale shapes
  floating in the dark and on Slate they sit one step above their background and the whole window
  reads as one desaturated grey-blue object. That is a different composition, not a tuning of the
  same one. A wallpaper may now name the accent that **Default** resolves to, and Slate names its own
  (`#4F6B96`): the outgoing bubble is the largest saturated area in a window, and a desaturated
  wallpaper under the stock blue bubble is a grey window with a blue stripe down one side. A chat
  whose colour the reader picked keeps it. Slate's blooms are hue shifts at the base's luminance
  rather than highlights, because `npm run contrast:check` measures every ink against the brightest
  point of every dark wallpaper — all 186 pairs still clear their floor, with the dark panel's worst
  ink at 5.43 : 1.
- **The `+` menu is a popover anchored on the `+`.** Two round glass buttons with drawn icons —
  _Photo library_, _Choose file_ — their labels underneath, and a pointer whose tip lands on the
  button's centre, which is the thing the two full-width rows of text never said. It dismisses on
  Escape, on the `+` again, and on a tap anywhere else in the composer. A composer narrower than
  260pt keeps the stacked list: a squeezed popover is worse than the list it replaced.
- **Android release builds are signed with the Play upload key.** The React Native template gives
  `buildTypes.release` the debug signing config, which produces a release APK that installs by hand
  and is refused by Play — the one failure that looks like success until the upload. A config plugin
  (`apps/hermie/plugins/with-android-release-signing.js`) now replaces that line with a choice made
  at configuration time: the upload key when all four `HERMIE_UPLOAD_*` values are there, the
  template's debug key when they are not, so a fork and a CI run with no key still build a release.
  The key itself stays with the owner — the four values are read by Gradle from
  `~/.gradle/gradle.properties` or from the environment, nothing is written into the repository, and
  the generated `build.gradle` carries the property names and no value. Every build says which key
  it used on one line, because a missing property otherwise produces a debug-signed release APK
  silently. `npm run android:release` builds the app bundle and the APK together and prints where
  they landed; `release.yml` produces both, signed, when the four secrets are set, and the debug APK
  alone when they are not. Verified against a real keystore: the APK's and the bundle's certificates
  both match `keytool -list` on the keystore, the fallback build is signed `CN=Android Debug`, and
  the signed APK installs and launches on an emulator.

- **The wide layout's sidebar can be hidden.** A round button in the chat header, ⌘⇧S / ⌃⇧S on a
  hardware keyboard, and **Hide Sidebar** / **Show Sidebar** in the Mac's Chats menu all reach the
  same toggle. Hiding it leaves a 56pt glass rail carrying the way back and the three tab-strip
  destinations, so Activity, Crons and Settings stay one tap away, and the chat column takes every
  point the list gave up. Below 900pt the layout starts hidden, because that is where the chat
  column measurably has nothing left to give — at 834pt portrait a bubble caps around 335pt, about
  38 characters — and asking for the list back there lays it **over** the chat behind a scrim rather
  than squeezing the chat again, closing as soon as a chat is picked. Above 900pt it starts open and
  Show simply shows. An explicit Hide or Show wins at either width and is remembered per gateway with
  the rest of the arrangement (ADR-0012); nothing flips itself while the window stays the size it
  was. Exactly one sidebar control is ever on screen: the header's, which always hides, or the
  rail's, which always shows and carries the unread total the hidden rows would otherwise have said.
- **The icons are drawn instead of typed.** The tab strip's four marks were the characters `◉ ⇄ ◷ ⚙`,
  and the owner reported the consequence: chats and crons drew visibly smaller than activity and
  settings. No `fontSize` fixes that — the four come from four different fonts that disagree about
  how much of the em box a mark should fill. They are now paths in one 24×24 viewBox at one size, in
  one 24pt slot so the labels sit on a line (`src/ui/Icon.tsx`), and the same component replaced the
  glyphs on the search field, the new-cron button, the back and options buttons, every disclosure
  caret and the bot-to-bot arrows. Two smaller faults went with them: iOS was giving the gear its
  emoji presentation without a trailing `U+FE0E`, and a character missing from every font on Android
  draws the empty box.

- **A secondary click opens the platform's own context menu.** A right click on a chat row, on a
  message, on a section heading or on a cron — and a press and hold on a touch screen — now opens a
  real `UIMenu` through `UIContextMenuInteraction`, not a sheet the app drew. The system's glass and
  placement, the row lifting into a preview, arrow-key navigation, Return to choose and Escape to
  dismiss all come with it and are not our code. React Native has no secondary-click event at all,
  so this is a host view in the local `hermie-mac` module (`HermieContextMenuView`) that the call
  site wraps its existing tree in. The chat list's bottom sheet stays exactly as it was and is the
  Android path.
- **Hold a chat row and drag it where you want it.** Long press for 300ms, then move: the row lifts
  with a shadow, a line shows where it will land, the list scrolls itself when you reach an edge, and
  dividers are drop targets so dragging across one changes a chat's section. Long press and hold
  STILL, without moving, and you get the context menu instead — the two separate by themselves, the
  way they do in the Files app. In edit mode the grab handle drags immediately, and Move up / Move
  down stay for anyone who would rather not drag. No gesture library: `PanResponder` and `Animated`,
  both already in React Native.
- **Desktop keyboard shortcuts, and Hermie's own menu in the Mac's menu bar.** ⌘K focuses the search
  field, ⌘, opens Settings, ⌘1…9 opens the nth visible chat, ⌘↑/⌘↓ and ⌃Tab step between chats, and
  ⌘W closes one level exactly as Escape does. The Mac menu bar gains a **Chats** menu carrying the
  same commands and the first nine chats by name, built with `UIMenuBuilder`; the keyboard and the
  menu bar emit the same event, so they cannot drift. Nothing is emitted for an unmodified key, so
  ordinary typing never leaves the native side.
- **`Copy text` and `Copy as Markdown` on a message**, plus a link submenu listing each link the
  message contains, `Open @handle's chat` on a bot-to-bot line and `Show details` where a card has a
  disclosure. A reply IS markdown, and the two destinations want different things.
- **`Mark as read` and `Add divider above`** on a chat row, and `Rename` / `Remove` on a section
  heading without going into edit mode first.
- **The fake gateway streams reasoning.** A scripted reply can now carry `reasoning` deltas, one
  `reasoningAvailable` frame and `tool.generating`, and the default scenario uses all three — so a
  turn arriving as thinking-then-words is reproducible locally. It was not before, which is why the
  transcript bug below survived two rounds.
- **Android is built and run for the first time.** Debug and release APKs both assemble with no
  change to the project, and the release build was driven end to end on an emulator: onboarding
  over plain `http://` to `10.0.2.2`, a chat with every item kind, the approval sheet, the options
  sheet and its pages, Activity, Crons, Settings and Licences, the attach menu, and the two-panel
  layout in landscape. That closes two things that had only ever been read rather than watched —
  that `usesCleartextTraffic` reaches the main manifest and not just the template's debug one, and
  that a pinned theme drives the native night mode and the status bar ink. The release APK is
  debug-signed, as the React Native template leaves it; it is not a shippable artefact.
  [docs/platform-notes.md](docs/platform-notes.md) has what was measured and what was not.
- **The fake gateway reports the session's working directory.** `SessionLiveInfo.cwd` is in the
  contract and this server answered without it, which made its own file-upload route unreachable:
  the client uploads into the session's cwd because `@file:` is expanded with `allowed_root` set to
  that directory, and it refuses rather than guesses when a resume carries no `cwd`. Every attach
  stopped at "No workspace to upload into" before a request was made, so the upload endpoint, the
  absolute-path rule and the 100 MB cap had never been exercised by a run.

### Changed

- **The connection test runs itself.** It was a button, and the button was a question with one
  answer: the wizard cannot be finished without a passing test, so "Test connection" asked the
  reader to confirm the only thing that step does — and charged them a wait for it, because the dial
  could have been running while they read the page. Arriving at the step now starts it, the three
  rows tick over as REST, the WebSocket and the profile list answer, and Continue opens the moment
  it passes. A failure is where a button still earns its place, and it says **Try again**. The
  invalidation rule is untouched and is what makes this safe: the test result carries the payload it
  was produced for, so changing the address, a header, the provider or the credential produces a new
  one and the next arrival dials again — while the same payload never dials twice, which is what
  keeps a failure from retrying itself in a loop.

- **A bubble's clock sits on the end of its last line, and every bubble carries one.** It was a line
  of its own under the body, which made a one-word message twice as tall as its text, and it appeared
  only on the bubble that ended a run, which cost a reader the time of every message but the last.
  Both of those existed because the clock occupied a row; it no longer does. Outgoing bubbles still
  show the delivery ticks only where the gateway has a receipt to report — one per conversation —
  because painting a tick on an older bubble would be inventing a delivery nobody confirmed.
- **Bubbles hug their content, and the proportions are WhatsApp's.** Radius 16 rather than 22 (a 22pt
  arc around a 10pt-tall content box turns a one-word message into a lozenge), a 4pt corner down the
  sender's side, 10pt vertical and 14pt horizontal padding, and — the part a reader actually sees —
  6pt between two bubbles of one run against 24pt on a change of author. At 3 against 12 the two were
  the same order of magnitude and the grouping could not be seen at a glance on a large window. The
  tail-side bottom corner is now tucked on EVERY bubble rather than only on the one carrying the
  tail, which is what makes a run read as one block instead of as a stack of separate lozenges. The
  width cap is unchanged and is still a ceiling, never a size.
- **The date stamp takes the same rhythm as a reply's eyebrow** — the author-change gap above it, 4pt
  below — and the row under it drops its own margin, so a day boundary is a boundary rather than
  48pt of nothing.
- **A destination panel is exactly the chat panel's frame, and the dim covers the sidebar.** The
  panel was positioned from the window — a gap plus whatever the insets said — which on the Mac put
  it past the chat panel's rounded bottom corner and against the window's own edge, square. It is now
  that panel's measured frame: same top, same bottom, same right edge, same radius. The dim moved
  inside each panel it covers, including the sidebar, which is also no longer clickable while a panel
  is open. One scrim over the window was wrong twice — it darkened the 14pt wallpaper gap around and
  between the panels, and left the list bright and usable beside a dimmed chat, which makes the dim
  mean nothing. Tapping either dim closes one level, exactly as Escape does.
- **The search field's magnifier and its placeholder share one centre line.** The icon now sits in a
  slot the height of the text LINE rather than the size of the mark, the field states its own leading
  instead of taking whatever the platform's font metrics produce, and it adds no vertical padding of
  its own — iOS adds an asymmetric inset of its own on top of whatever the style asks for. The 44pt
  tap target moved to the row, where it belongs.
- **One line in the composer is vertically centred in its pill.** The padding is computed from the
  field height and an explicit leading, with the platform's own top inset taken off the top so the
  two VISIBLE gaps match, and the field has no minimum height any more: a box taller than its content
  is a box an iOS multiline field fills from the top, which is why the placeholder sat high in it.
  Multi-line growth is unchanged and the buttons still ride the bottom edge.

### Fixed

- **Hermie Web's fields and round buttons behave like the app's, not like a browser's.** Four browser
  defaults were contradicting decisions the design had already made. A user agent drew the focus ring
  around the `<input>` — the text line, a square-cornered rectangle floating inside a 44pt pill — so
  the app suppresses it and draws its own on the control, as an outline that takes part in no layout.
  The composer's `<textarea>` was two rows tall because that is a browser's default for one with no
  `rows`, and it did not grow with its content; it is one line now and grows to the same six-line cap
  the phone has. Enter sends and Shift+Enter breaks the line, through the send-key table the native
  builds already share — a browser answers "is there a keyboard" from the primary pointer, so a phone
  browser keeps Return as the newline. And the composer's `+` and send were the last two marks in the
  app still typed as CHARACTERS: a glyph is centred by its line box while its ink sits wherever the
  font's metrics put it, which is why both read low in their circles. They are drawn paths now, in
  one shared `RoundIconButton` that the header's three buttons use as well.
- **Settings says whether this device is actually registered for notifications.** On the owner's
  gateway `hermie-app.push` held a live heartbeat and `registrations: {}` — a device that is on from
  the inside and absent from the outside — because `obtainAddress` answered a bare `null` for five
  unrelated reasons and nothing above it could tell them apart. It now answers WHICH, Settings →
  Notifications carries a Registration row that names it (`Registered · …token tail`, `Token request
  failed: …`, a build with no EAS project id, permission denied), the refusal is written to the same
  failure ring the debug screen reads, and a Retry button re-runs the flow where re-running it could
  change the answer.
- **Steering a queued message no longer makes it disappear.** Pressing Steer took the message out of
  the queue strip and painted nothing anywhere, so the words left the only place they were visible
  and arrived nowhere. The correction is now painted as the user turn it is, marked `Steered`,
  before the round trip — and taken back off, with the message returned to the strip, when
  `session.steer` answers `rejected` or the call fails. Whether a gateway persists a row for a steer
  is not something a client can know, so the bubble is optimistic and the tail reconcile pairs it
  with a persisted row on its text if one arrives; both gateways are exercised against the fake,
  which now implements `session.steer` and `session.redirect`.
- **A chat dragged in the list lands where the finger is, and the rows move aside to say so.** The
  drag could only ever drop a row at the very top or the very bottom, and the other rows never
  budged. Neither was a bug in the drop arithmetic: every row was measuring itself INSIDE the
  `FlatList` cell that holds it, so all of them reported the same position — the top of their own
  cell — and a comparison against the finger had nothing to tell the rows apart with. The cell is
  now the thing that measures and the thing that is raised, which also fixes the second half of the
  report: a lifted row was drawn under its neighbours, because a `zIndex` set inside a cell cannot
  lift the cell it is drawn in. The list's own top edge is measured in the window rather than
  derived from the touch, so a floating header, a sidebar rail or a Mac title bar no longer shifts
  the drop by a row; and an auto-scroll at the edges now keeps the lifted row under the finger
  instead of letting the content slide it away.
- **The header pill stops resizing while a bot works.** The pill hugged its contents and the
  widest of them was whichever status line was current, so `Online` → `Thinking…` →
  `Running mcp__terminal__run_in_terminal…` → `Typing…` moved the avatar and the name sideways
  several times a second. The bot's name is the only thing in there that does not change while a
  reader is looking at it, so the name (plus a floor) is now the width, and the status is drawn in
  a row of its own that is exactly one line tall with the text absolutely positioned inside it —
  outside the pill's intrinsic width, elided at whatever the name set. An MCP tool is named by its
  server before it gets there (`mcp__terminal__run_in_terminal` → `Running terminal…`), because
  eliding a namespace tells a reader nothing. The words cross-fade over 120 ms, instantly under
  Reduce Motion.
- **The badge beside an open chat goes out when the message is in front of you.** The chat list kept
  showing 1 unread for the chat that was open, with the message plainly on screen. The watermark was
  only ever written twice — when a chat was opened and when it was left — which is a rule from a
  phone, where an open chat has covered the list. On the iPad and in a Mac window the list and the
  chat are side by side. A chat that is open with the transcript at the bottom now counts every
  message as read as it arrives; one that arrives while the reader is scrolled up stays unread, and
  is read when they come back down — the same message, and the same moment, that the jump-to-latest
  pill counts.
- **A model is named the way its maker names it.** `claude-haiku-4-5-20251001` under a reply,
  `example-provider/example-model` in the options sheet, `qwen3-235b` in the picker — the wire id was
  shown raw wherever a model appeared. `prettyModelName` reads one as a name: `Claude Haiku 4.5`,
  `GPT-5.5`, `Gemini 2.5 Pro`, `Llama 3.1 70B`, `DeepSeek V3`, `Qwen3 235B`, `o3 Mini`. It is a set
  of patterns and not a catalogue — a family word gets its maker's spelling, a run of version numbers
  joins with dots, a parameter count gets a capital B, a snapshot's date suffix is dropped, a routing
  prefix (`openai/`, `openrouter/anthropic/`, `duo-chat-`) becomes a separate provider value, and an
  id it has never seen is Title-Cased with its numbers intact. The wire id is never changed and never
  lost: the model picker prints it under the name, which is also what its search matches on.
- **The typing bubble's tail is part of its silhouette again.** In Graphite dark the dots' bubble had
  a step in its left edge: one edge for the top of the bubble and another, further out, below it. The
  tail's box was 25pt tall of which the top 11 was a plain rectangle behind the bubble, covering
  nothing — and the typing indicator is the shortest bubble in the app at 34pt, with an 18pt corner
  arc at its top. The rectangle stood behind that arc and painted the notch the corner rounds away.
  The box is now exactly the shape it holds, 14pt, which is the droplet's own arc plus the bubble's
  tail-side bottom corner; the tail can only ever be where the bubble's edge is straight, and a test
  holds that against the shortest bubble so a taller tail or a tighter padding cannot bring it back.
- **`npm run android:release` notices when `android/` has gone stale.** It prebuilt only when there
  was no native project at all or when `--clean` was given, and `android.versionCode` is the commit
  count — so a tree that prebuilt at 133 and released at 192 built a bundle carrying 133, which
  installs perfectly and which Play refuses because it has seen it. The three values prebuild writes
  are now read back out of `android/app/build.gradle` before every build and compared with what
  `expo config` resolves now; a mismatch regenerates and names the value that moved.
- **A tap beside a bottom sheet closes it again.** The scrim was a flex sibling ABOVE the panel in a
  column, so it covered only the space over the sheet; on the wide layout, where the panel is capped
  and parked over the content column, most of what reads as backdrop is BESIDE it — and that area
  was a transparent container, which absorbs a tap as readily as an opaque one. The scrim is now an
  absolute fill under the whole modal and the column that centres the panel takes no touch of its
  own. Escape and a drag down were never affected.
- **The Settings rows an accent colour names are readable in every theme.** `Sign out`, `Advanced`
  and `Licences` were painted in the accent SWATCH rather than in the floored accent INK — 1.33 : 1
  on the Graphite dark card, and 1.14 : 1 on Lime light. Every fill role (`accent`, `danger`, `ok`)
  is now unreachable from a `Text`: the prop's type is the inks only, which turned up seven more
  places drawing a status word or a chip in a colour with no contrast floor. `npm run contrast`
  additionally measures the opaque rungs — the inset card every Settings row sits on, the navigator's
  own background, a pressed row — which nothing in the table reached before.
- **Typing no longer fires a shortcut.** A `k` typed into the theme editor moved the caret to the
  chat list's search field. The keyboard path polls the HID state for modifiers, and a Command
  released while another window had focus stays down for ever there — so every bare `k` was a ⌘K.
  A modifier is now believed only when this process watched it go down (the mechanism the Shift latch
  already used, generalised). Behind that, two gates: an app-wide shortcut is not delivered while a
  text input holds the caret, and a shortcut that switches SURFACE is not delivered while a sheet or
  an overlay is open over that surface.
- **The row menu offers the same things wherever it is drawn.** The fallback sheet — the menu on
  Android, and on any build without the platform's own — was still building its own list, so it had
  a colour, Archive and one line per section, and the only thing it could do to the ORDER of the
  list was move a chat to the top group. It is rendered from `rowMenuItems` now, the same list the
  platform menu draws: Open, Mark as read, Colour, Move to section, Move up, Move down, Add divider
  above, Archive.
- **A slash suggestion can be taken without a hardware keyboard.** Return inserted a line break
  instead of accepting the highlighted command, and the round send button re-accepted the suggestion
  instead of sending — so on a phone a fully typed `/model` could not be sent at all. Return takes
  the suggestion while the list is open; the send button sends, which is the one thing it means.

- **An attachment sent with nothing typed no longer paints two outgoing bubbles.** Reconciliation
  pairs a locally sent turn with the row the gateway persists for it on what the turn SAYS, because
  `prompt.submit` answers with a status and never a row id. A send carrying only a file says nothing:
  the `@file:` directive is plumbing, and both sides lift it out of the text — so there was nothing
  to pair on, and the row landed beside the bubble a moment later, one naming `ui.xml` and the other
  `8setj4h3-ui.xml`. Pairing now uses the text AND the attachments, and `UserItem.attachments` is one
  contract on both sides of the wire: the reference strings, as the row carries them. A bubble's chip
  is derived from the reference at render time, and so is the key the two sides are compared on — the
  reference's own file name, which is all a client is ever told about an image, since
  `image.attach_bytes` sends the bytes out of band and the gateway alone decides where they land. Two
  sends carrying different files stay two bubbles. An image-only send gets the same treatment, and so
  does a prompt that was only a file when the chat is reopened in the middle of it — that used to
  resume as an empty bubble.
- **Android's back button reaches the surfaces that are not modals.** A `Modal` consumes the press
  itself, so every sheet was already right — including the blocking approval sheet, which correctly
  swallows it. Nothing else heard it: back on Activity, Crons or Settings in the wide layout left
  the app for the launcher with the panel still open, and back from a page Settings opens over
  itself (Licences, the connection test, the gallery) or from a cron's detail popped the whole
  screen instead of returning one level. `useHardwareBack` is a second stack beside `useEscapeKey`
  with the same last-wins rule, so "one level" falls out of mount order as it already did for
  Escape. Back inside the chat options sheet arrives as `onRequestClose` and now pops the page
  rather than closing the sheet.
- **A dimmed button no longer shows its own shadow through itself.** Android paints an elevation
  shadow behind a view and clips nothing, so at `opacity: 0.35` the disabled send button stopped
  hiding its shadow and the platform's polygon approximation of a circle read through the fill as a
  lighter octagon. iOS clips a shadow to outside the view's path and never showed it.

- **The setup wizard is one glass card on the wallpaper.** Every step used to be a flat full-screen
  form: an eyebrow, a title, a paragraph, a tall empty middle, a hairline, and a pinned footer
  holding Continue and Back. It is now a single centred card, at most 520pt wide, whose height
  follows its content, with the step's actions inside it under the content they act on and the
  divider gone. A slim four-segment rail carries the progress, static like every other status
  indicator in the app. On a phone the card takes the window's width; on a Mac or an iPad it is
  centred in both directions. The keyboard behaviour the pinned footer existed for is kept — the
  card scrolls rather than being covered.
- **The address step says what it actually does.** The hint under the field now states the
  behaviour that has been there since ADR-0014 and that nobody could see: leave the scheme out and
  the address is tried over `https://` first and `http://` second, and typing a scheme pins it.
  While the probe is in flight the line names the scheme it is trying; when it answers, it names the
  scheme it found — `Found over https://` as well as `Found over http://`, but only when the reader
  left the scheme out, because that is the only time it was an open question.
- **The connection test is a checklist, not a verdict.** REST, WebSocket and Profiles each get a
  static dot that fills in as the run reaches them, so a failure says WHICH half failed. That
  distinction is the whole value of the step: REST refused is a credential, the socket refused is a
  reverse proxy that does not pass upgrades through.
- **`Open in browser instead` is offered before you need it.** The system-browser sign-in path used
  to exist only inside the in-app web view, behind a caption under a page that may never load. It is
  now a quiet action on the sign-in step itself, and it opens straight onto the same paste-the-
  redirect form Android already gets.
- **Every onboarding step state is addressable** through `--hermieOpen gallery:onboarding-*`,
  including the error states — a probe that found nothing, a gateway that requires a sign-in but
  lists no providers, a gateway too old for native sign-in, and both ways the connection test fails.
  The wizard is the one screen nobody can reach twice, and the states worth looking at need a
  gateway broken in a particular way.

- **A gateway can be reached over plain `http://`, and the app says so.** On a tailnet — Tailscale,
  or Headscale — WireGuard has already encrypted the path, so `http://100.x.y.z:9119` or
  `http://host.tailnet.ts.net` is a complete and correct setup, and until now the operating system
  refused it — on iOS in every configuration, on Android in release builds only, because the
  template grants cleartext in the debug manifest alone. iOS now ships an App Transport
  Security exception and Android `usesCleartextTraffic`, both set from `app.config.ts`; the address
  is only known at runtime, so there is no domain to name in a narrower rule, and
  `NSAllowsLocalNetworking` does not reach a MagicDNS name because it is fully qualified — measured
  on an iOS 27 simulator as `NSURLErrorDomain -1022` against a cleartext FQDN that resolves to a
  private address the same build reached happily by its IP. The exception is exactly ONE key:
  adding `NSAllowsArbitraryLoadsInWebContent` or keeping the template's `NSAllowsLocalNetworking`
  beside it makes iOS ignore `NSAllowsArbitraryLoads` altogether, which is how the first version of
  this fix fixed nothing. [ADR-0014](docs/adr/0014-plain-http-on-private-networks.md) records the
  decision, `docs/platform-notes.md` the measurements, and `docs/release.md` the note App Review
  will ask for.
- **The address step tries both schemes, in the right order, and never silently.** Typed without a
  scheme, an address is probed over `https://` first and over `http://` only when https does not
  answer at all — not when a certificate was rejected, and not when something answered with a
  status. When http is what answered, the probe line says `Found over http://`. An address typed
  with `https://` is probed over https and nothing else.
- **One line about a cleartext connection, in the tone the host deserves.** Loopback, RFC 1918,
  link-local, CGNAT (Tailscale's range), `.ts.net`, `.local` and unqualified names are stated as
  fact; anything else is a warning with a `Use https instead` action beside it that re-probes with
  the scheme spelled out, port and path prefix intact. The classifier is pure and tested — IPv4,
  IPv6 ULA `fc00::/7`, Tailscale's `fd7a:115c:a1e0::/48`, IPv4-mapped addresses, brackets, ports,
  trailing dots and case. Settings shows the same line under the gateway address, and only for the
  case worth acting on.

- **The four sheet interiors, against the mockup.** The approval sheet reads in §6.9's order — who
  is asking and where, then the command well in monospace on the sunk tint, then the consequence —
  rather than the description-above-the-command it had; the buttons are still exactly the server's
  `choices` in the server's order (ADR-0010 is untouched) and `Deny` is the mockup's soft
  destructive tint rather than a saturated red block competing with the primary. The clarify sheet
  puts its step count beside the eyebrow, shows a locked answer as a tinted chip instead of only
  dimming the controls, and leads its actions with the one that answers the question. The agents
  sheet draws its tree on a hairline rail and gives a child's transcript a real PAGE with the shared
  back control — and Escape there now pops the page before the sheet. The cron editor is three named
  groups. The chat options root is four named groups, with verbosity and the two visibility switches
  in one card under the override footer that applies to all three.
- **The agents bar is §5's slim glass pill** — three static pips, the count, a monospace clock and
  `Show` — inset from the panel edge instead of a full-width strip with a bottom rule that read as a
  second header. The clock is `0:42` rather than `1m 12s` because the number ticks once a second in
  a fixed slot and a label that changes width moves the control beside it.
- **The crons list is §6.11's row**: a static status dot, the name over `Every 2 hours · @local`, a
  profile chip where the list spans more than one profile, and a right-hand `NEXT / in 2h` pair. The
  `Paused` divider is a label plus a rule. Four stacked lines per job became one row.
- **Activity is a ledger.** Rows carry the transcript's glyph well, the sentence in `meta`, the clock
  at the right edge and the body indented past the glyph, and the three counters are small static
  glass chips instead of 22pt numerals that led a timeline with a dashboard.
- **A cron card in a chat can open its cron.** `ChatScreen` resolves the card's job NAME against the
  loaded crons, narrowed by this chat's bot — a bot is a Hermes profile — and passes the action only
  where that leaves exactly one job; anything else renders no action rather than a link to the wrong
  cron. Both shells route it: the wide layout opens the crons panel on that cron, the phone pushes
  the route with its id. `Run now` deliberately stays on the cron's own detail behind its confirm.
- **`gallery:chat` renders in the real wide shell** on a wide window — the same gaps, sidebar width
  and two panels `RegularShell` draws — over a seeded fixture roster, so a screenshot of the chat
  screen is a screenshot of a shape the app actually shows.

### Fixed

- **The transcript no longer jumps up and scrolls itself back while a bot is thinking.** The cause
  was one comparison in React Native's own scroll view: `maintainVisibleContentPosition` picks its
  anchor with `origin.y + height > contentOffset.y`, and at the bottom of an inverted list
  `contentOffset.y` is 0 — so a ZERO-height list header fails that test and the anchor falls through
  to the first cell instead. Every change at the bottom then moved that cell's origin, the scroll
  view corrected the offset by the difference, and `autoscrollToTopThreshold` animated back: the jump,
  and the scroll back. It happened on every message sent as well as on every appearance of the typing
  bubble. The header is now a one-point spacer whose height never changes, so it always wins that
  test and the delta is always zero, and the typing bubble is a pinned sibling below the list rather
  than content inside it. `__tests__/chat-ui/transcript-anchor.test.tsx` holds the invariant.
- **A secondary click on a bubble no longer starts a selection as well.** Where the native context
  menu exists the markdown renderer stops passing `selectable`, because `Text selectable` is not a
  selection — it is a long-press edit menu whose only action copies the whole paragraph. Two
  interactions were racing for one gesture, and the menu does the same copy better.
- **A collapsed run of bot-to-bot messages is one line again.** Every transcript row carried the gap
  above it, including the rows a roll-up swallows — so five dispatches collapsed into
  `5 messages to @writer` still left five turn gaps behind them, about 55pt of nothing between that
  one line and the next bubble. A row that draws nothing now takes no space at all.
- **Consecutive bot-to-bot lines sit nine points apart**, the rhythm §6.6 gives them, rather than the
  ten that separates two turns of speech. A dispatch is a ledger line, not a bubble.
- **The typing bubble gets the gap that any new turn gets.** It was the list's header rather than one
  of its rows, so the grouping never saw it and nothing gave it a margin: it sat against the message
  above with its tail reaching into the bubble's bottom corner. Nothing was added below it — the
  space there was always the list's own padding plus the composer's.
- **The Answer button on a question in the transcript is as wide as its label.** On a wide window it
  ran the whole card.
- **A day that changes on a hidden row now stamps the first row the reader can see.** A hidden
  placeholder was advancing the date stamp while drawing nothing, so a day boundary that happened to
  land on one went unmarked entirely.
- **Error cards in the transcript take the column rule instead of spanning it.** "Something went
  wrong" ran the full width of the chat column while every bubble beside it stopped at the bubble
  cap, and its Retry button stretched edge to edge with it. On an iPad Pro 13" in portrait the card
  went from 620pt to 469pt, in line with the bubbles, and Retry is now sized by its label — with the
  44pt minimum touch height intact.
- **The sidebar is 300pt on a window narrower than 1100, and 340 above it.** It was 344 everywhere,
  which is a landscape number: in portrait that is a third of an iPad Pro 13" and two fifths of an
  11". On an 11" in portrait the chat column goes from 448pt to 492pt and the bubble cap from about
  305pt to about 335 — the old number made a tablet read NARROWER than an iPhone 17 Pro, whose
  bubbles cap at 314. It is still tighter than a comfortable measure at that size; a collapsible
  sidebar is the remaining lever and the design board has no control for one yet.
- **The filter pills scroll.** At 300pt of sidebar "Needs input" no longer fits beside the other
  three, and it was already one text-size step from clipping at 344 — so the row scrolls
  horizontally, which also covers a longer translation and a larger Dynamic Type setting.
- **Avatar tints are deep enough to see.** The circle behind a bot's initial sat 1.02–1.20 : 1 from
  the panel behind it, so at iPad width a row read as a letter floating on the glass; the initial
  itself was always fine, which is why measuring only the ink missed it. The circle now separates at
  1.38–1.51 : 1 in light and 1.45–1.67 in dark, with the initial still above 5.7 : 1. A Default chat
  still gets no accent ring — §1.3 gives the ring to the eight curated colours, and that is correct.
- **A keychain that refuses to answer no longer strands the launch on the splash screen.** The
  startup read of the stored credentials had no `try`/`catch` and its caller was invoked without
  `await`, so a rejection — a missing entitlement, a locked keychain — escaped into nothing and the
  app waited for a phase that would never arrive. It now falls through to the wizard, which is a
  worse answer than connecting and a far better one than a spinner with no end.
- **A launch that finds the gateway address but no credential now says which of the two happened.**
  `expo-secure-store` resolves a missing item and an item in an unreadable keychain access group to
  the same `null`, so the ring recorded nothing that could tell them apart after the fact. The auth
  timeline gains `token.absent` for a clean miss, beside the existing `token.read_failed` for a
  refusal. This is what the "signed out after replacing the .app bundle" report needed and did not
  have; `docs/platform-notes.md` records what that investigation could and could not establish.

- **The transport's TLS classification was built on a message that does not exist.**
  `looksLikeTlsFailure` matched `ssl`, `certificate` and the literal `-1200`, with a comment saying
  iOS puts the NSURLError code in the message. Measured on iOS 27: CFNetwork logs
  `-1200 "A TLS error caused the secure connection to fail."` for a request the app reports as
  "Could not reach …", because React Native's `fetch` is `whatwg-fetch` over its own
  `XMLHttpRequest` and the polyfill rejects every transport failure with a flat
  `TypeError('Network request failed')` — the `NSError` never reaches JavaScript, and OkHttp's
  exception does not either. So `GatewayError('tls')` cannot arise from a `fetch` in the app at all,
  and `docs/platform-notes.md` says so rather than leaving a string everyone assumes is in use. The
  predicate now also matches `tls` as a word, and a second one separates a rejected CERTIFICATE from
  a handshake that died because nothing there spoke TLS — the line the scheme fallback is drawn on,
  correct wherever a real message does arrive.

### Changed

- **The application identifier is `dev.hermie.app`.** `ios.bundleIdentifier`, `android.package` and
  the keychain access group derived from it all move together, and the deep-link scheme stays
  `hermie`. The previous identifier belonged to an App ID registered in a personal Apple team, which
  Apple does not let you move to another team; nothing had ever been uploaded under it, so the
  cheapest fix was to stop using it before the first upload rather than after. `docs/release.md`
  says so in one place. The identifier is what the system uses to tell apps apart, so a copy
  installed from an earlier build is a different app to it: it keeps its own container and keychain
  items, and the new one asks for the gateway and a sign-in once.

- **The iOS build names its keychain access group instead of inheriting one.**
  `keychain-access-groups` is now `$(AppIdentifierPrefix)dev.hermie.app`, the same string the
  implicit default already resolved to and first in the list, so writes go where they always went and every existing item stays readable — there is no migration, and nothing a user has to do.
  What changes is that the group is declared by this repository and auditable in `codesign` rather
  than inferred from whatever signing metadata a build happened to produce. It is a precaution
  against the "signed out after replacing the .app bundle" report, not a proven fix for it: see
  `docs/platform-notes.md` for exactly what was and was not established.

- **The wording that made https sound compulsory.** The address hint read "Without a scheme, Hermie
  assumes https://.", which reads as a requirement. It then said https is assumed and http works on
  a private network, and it now goes one step further and states the resolution itself — see the
  address-step entry under Added, which supersedes this wording. The README's "Keep the gateway off the public
  internet" told you to run `tailscale serve` in front of the gateway as though TLS were needed on a
  tailnet: it is optional there, and useful mainly when an identity provider insists on an https
  redirect URI or you want a browser-trusted certificate. "Reach it over HTTPS if it is not on the
  same machine" is now "if it is exposed to the open internet". `SECURITY.md` has a Transport
  section stating the stance, and `dashboard.public_url` must still match the address in use,
  scheme included.

### Fixed

- **Every bot showed "Working" when one bot was working.** Asking a single bot something painted the
  blue working bead on every row in the chat list. `session.active_list` is not profile-scoped,
  however much its parameters suggest otherwise: upstream it is a plain method over every live
  session in the gateway PROCESS and it never reads the `profile` it accepts. The roster called it
  once per bot with that profile and marked the bot running if any row came back busy — which could
  only ever answer the same thing for every bot at once, at a cost of one identical round trip per
  bot per poll. It is now ONE call per poll, and each busy row is attributed to a bot by session id:
  the roster's stored id and lineage tip, the open chat's copies of both, and the runtime id the chat
  is bound to. A busy session this app cannot place — another client's session, a cron run — lights up
  nobody, and `title` is never matched on, because `Bot Chat` is the same title on every profile. A
  bot the user is talking to also shows as working off its own streaming `turn.active`, which is true
  the moment the turn is sent instead of up to one poll later. The fake gateway used to filter on
  `profile` and so agreed with the bug; it now reproduces upstream, with the behaviour pinned in its
  upstream-shapes suite.
- **On a Mac, dragging with the mouse scrolled a list instead of leaving the text alone.** A
  "Designed for iPad" app gets full pointer support and UIKit delivers an indirect-pointer drag to a
  `UIScrollView` as a touch, which its pan recognizer accepts by default. Every list and reading
  surface now restricts that one recognizer to direct touches on a Mac, through a new function in the
  local module: a finger still pans, and a wheel or trackpad scroll is not a touch at all — it is
  gated by `allowedScrollTypesMask`, which is untouched — so scrolling keeps working and only the drag
  stops. No-op on iPhone and iPad, and it cannot throw. Selecting text with that drag is a separate
  request and is NOT delivered: React Native's `Text selectable` is a long-press edit menu whose Copy
  takes the whole block, with no selection range in the component at all, so bubbles are already at
  that ceiling. `docs/platform-notes.md` has what is verified, what is only reasoned — the pointer
  behaviour cannot be exercised on the simulators here — and the three-step manual test for a Mac
  window.
- **The app did not launch on iOS 27.** UIKit refuses to start an app built against the iOS 27 SDK
  that has not adopted the scene life cycle, and it refuses before any of our code runs: an
  `EXC_BREAKPOINT` on the main thread in
  `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`. Expo SDK 54's template is an
  application-life-cycle app and the SDK line ships no opt-in — scene support arrives in SDK 58, with
  a back-port to 57.0.23 — so the app adopts scenes itself:
  `plugins/with-ios-scene-lifecycle.js` writes the `UIApplicationSceneManifest` and
  `modules/hermie-scene` ships the `HermieSceneDelegate` it names. The scene delegate adopts the
  window the app delegate already created rather than making its own, because expo-dev-launcher
  looks for that window during `didFinishLaunching` and calls `fatalError` when there is none, and
  it hands the app delegate back the URL, user-activity and life-cycle events UIKit stops delivering
  there. `AppState`, the splash hand-over and the dev client are unchanged; the iOS 26.5 simulator,
  the iPad and the Mac build are unchanged. `docs/platform-notes.md` has the crash signature, why
  three rounds of simulator work never saw it, and what is verified where.
- **A pinned theme only coloured half the app.** Pinned to Light while the system was in Dark, every
  glass panel rendered as murky dark glass under light ink — a `UIVisualEffectView` takes its
  appearance from the window's trait collection, and the token set never reaches it. `ThemeProvider`
  now calls `Appearance.setColorScheme` with the scheme that won, which sets
  `overrideUserInterfaceStyle` on every window of every connected scene, and `null` when the choice
  goes back to System so the override is released rather than frozen. The pin is read from the
  settings store rather than from `useColorScheme()`, which reports the override back once it is in
  place. `GlassSurface` passes the same scheme to `expo-glass-effect`'s `colorScheme` prop as well.
  Measured in all four system × pinned combinations: a pinned scheme now draws the identical surface
  whichever way the system is set.
- **The dev menu stopped appearing in Debug builds** once the app adopted the scene life cycle:
  expo-dev-menu builds its own window with no window scene, which UIKit never draws. The scene
  delegate now adopts any window that shows itself without one.
- **Settings said its name twice** in the overlay panel — the panel's bar and a large title directly
  under it. Activity and Crons had already dropped theirs; this was the last one.
- **Activity showed an empty timeline against a working gateway.** A
  `GatewayConnection` — and so the whole chat runtime — exists from the moment a gateway is
  CONFIGURED, long before its socket is up, and Activity's background load ran the instant the screen
  mounted. The roster read under it failed with _"gateway not connected"_, a failed roster is
  swallowed as "no bots", and the screen settled on _"your bots have not talked to each other yet"_ —
  permanently, because nothing asked again. It now waits for the connection to be ready and reads
  again after every reconnect, which is the rule the chat roster already had. Opening the panel
  straight after launch lost that race every time.
- **A cron's run history said `Success` for every run, including the ones that died.** A `/runs` row
  is an ordinary session row, and the sessions table has no status column: the outcome is
  `end_reason`. Reading `status` alone meant the screen always fell through to its "ok" default. A
  missed FIRE was invisible for a related reason — `last_fire_error` is `{at, detail}` rather than a
  string, so it was dropped on the way in; its detail is now shown like any other cron error.
- **Tool cards and the rest of the ledger ran edge to edge on a wide window** while every bubble
  beside them stopped at the §4 cap, so the column read as two layouts stacked on each other. Tool
  rows, thinking, cron cards, DM lines and roll-ups, and the request cards now take the same measured
  column rule a bubble takes. Outside a transcript — the Activity timeline draws the same rows —
  there is no column and no cap, which is what it should be.
- **The fold cuts on a line boundary, and the fade is a fade.** It clipped at a fixed height, so it
  landed wherever that height fell — half a line of x-height under a gradient, which reads as a
  sliced row. The clip is now `lines × leading`, the leading comes from the renderer
  (`markdownLeading`) so the two cannot drift, and a table or fenced code block is never cut through
  at all: the Markdown renderer reports where its blocks are and the fold moves the cut up to such a
  block's top and fades the whole block instead. The mask is two and a half lines tall with an even
  ramp, where the old one reached 85 % opacity at 65 % of a fixed 64pt and read as an edge.
- **A REST route may answer with a JSON array.** `GatewayHttp` parsed every body with
  `parseJsonObject`, which rejects an array — so `GET /api/cron/jobs`, which `hermes serve` answers
  with a bare array and which the cron controller is explicitly written to read in either shape,
  failed with _"answered with JSON that is not an object"_ and the crons list was empty against a
  real gateway. The transport now only asks whether the body is JSON; which shape is acceptable is
  the caller's question. The handshakes that genuinely require an object — the status probe, the
  credential exchange, the token endpoints — still use `parseJsonObject`.
- **Crons and Activity no longer say their own name twice.** Both shells already title the screen —
  the overlay panel's header on the wide layout, the stack's title bar on the phone — and each screen
  printed the same word again underneath it. The cron editor's `NEW CRON` eyebrow over `New cron` is
  gone for the same reason; an eyebrow earns its line where it says something the title does not.
- **The switch and the segmented control are §3's.** The switch's off track was a mid-grey fill that
  read as a third state and was the brightest thing in a dark row; it is the sunk tint with a
  hairline. The selected segment is raised onto the control rung with its own hairline and shadow,
  and its label is `text` rather than the accent.

- **Ink contrast is a check, not a paragraph.** `npm run contrast:check` composites every ink role
  onto every surface the way the surface is actually painted — the thinnest gradient stop over its
  rung or over the worst point of each wallpaper — and fails under 4.5 : 1 for anything read as text
  and 3 : 1 for a mark. It reads `apps/hermie/src/ui/tokens.ts` rather than a copy of the palette,
  which is the whole point, and CI runs it beside `icons:check`. 153 pairs, all clear.
- **`okText`.** `ok` had one value doing two jobs and measured 3.47–4.54 : 1 as ink on almost every
  surface, so a `Success` line was below AA wherever anybody would read one. `ok` is now the status
  dot's fill and `okText` is the ink beside it, the way `danger` and `dangerText` have always been
  split.

- **Every surface can be opened directly from the command line, in development.** The simulators on
  this machine can be launched and photographed and nothing else, so three rounds in a row shipped
  sheets and option pages nobody had ever seen. A Debug build now reads launch arguments —
  `--hermieOpen gallery:sheet-options-model-page --hermieTheme dark` — and `GalleryScreen` is a
  registry of addressable sections rather than a fixed scroll, so one launch is one screenshot. A
  section that names a sheet opens it as it mounts, which is what makes a blocking modal
  photographable at all. Three gates keep it out of a release build: the native constant is inside
  `#if DEBUG`, the JavaScript is behind `__DEV__`, and nothing is registered with the system — no URL
  scheme, no entitlement. CONTRIBUTING.md has the grammar; `__tests__/dev-launch-intent.test.ts`
  pins the gate.
- **The gallery reaches surfaces it never carried**: the cron detail, its paused-and-failing state,
  the run transcript, the schedule builder, the status dots, the cron editor sheet, the connection
  line in all four of its states, and the signed-out panel.
- **A chat-list preview is plain text.** The owner read `## Retry semantics: what actu…` off a row on
  a real device — two characters and a space spent on syntax, and the sentence cut anyway. One pure
  function (`src/markdown/plain-text.ts`) takes headings, emphasis, fences and inline ticks, list and
  task markers, blockquotes, thematic breaks, table pipes and link syntax off a reply and collapses
  what is left to one line. It is used by the chat-list row, the bot-to-bot line and its quoted
  reply, and by `formatPreview`.

- **The wide layout, run and looked at.** Part 1 and Part 2 both shipped without anyone seeing the
  sidebar-plus-detail shell on a real device. It has now been built, installed and driven on an iPad
  Pro 13" simulator against the fake gateway, in both themes, and the notes in
  `docs/platform-notes.md` record what was measured rather than what was intended.
- **One connection line, on every layout** (`src/features/bots/ConnectionLine.tsx`). It sits under
  the `Chats` title, draws nothing at all while the connection is healthy, and reads
  `Connecting…` / `Reconnecting…` / `Offline` when it is not. For `needs_signin` it reads
  `Signed out` in amber and is itself the button that starts the sign-in.
- **The signed-out state is shown inside a chat too**, not only beside one. A reader who was already
  in a conversation when the token expired used to get a transcript that had simply stopped, under
  an error about credentials — neither of which says "sign in". `ChatScreen` now takes the whole
  screen for it on both layouts, which also removes the shell's separate copy of the same rule.
- **Bottom sheets are glass**, with the mockup's grabber, and on the wide layout they are capped at
  560 pt and parked over the content column instead of spanning the window.
- **Pages inside the chat options sheet**, with a back control and a per-chat **colour picker**
  whose nine swatches are the same component the row menu uses. Escape goes back exactly one level:
  the first pops the page, the second closes the sheet.
- **An empty named section keeps its heading and gets a row of its own.** It used to be dropped
  unless the list was in edit mode, so a section whose last chat moved out vanished — and in edit
  mode two headings then met with nothing between them.
- **The fake gateway leaves one bot without an avatar.** Every profile used to answer
  `has_avatar: true` and be served the same 1×1 red PNG, so the generated-initial fallback — what a
  real gateway shows for most bots — was unreachable from a run against it.

### Fixed

- **Bold around an inline code span printed its asterisks, on a device only.** Hermes resolves the
  backreference in marked's `blockSkip` rule as the empty string, so the mask marked lays over inline
  code before it looks for a closing emphasis delimiter covered the wrong span — and because that
  mask has to stay character-aligned with the source, emphasis was not found at all. Every Node test
  passed throughout, which is how it survived two rounds. `src/markdown/marked-compat.ts` rewrites
  the rule without a backreference, and is the only place `marked` is imported from now.
- **A bubble on a wide window was capped at 435pt however wide the column was.** The percentage half
  of the §4 rule lived in the style as `maxWidth: '68%'` on a bubble whose parent was sized by its
  own `maxWidth`, so Yoga had no base to resolve it against and dropped it — leaving the point cap as
  the only rule that ever applied, on every layout. The transcript now measures the chat COLUMN and
  the cap is one number: `min(68 % of the column, 640)` wide, the phone rule compact. On a 1376pt
  iPad window a long reply grew from 435pt to the 640pt ceiling; on an iPhone from 250pt to 313pt.
- **A table cell wrapped mid-word.** `docs.example.org` broke after the `r` and left one letter under
  the row, because every column was 150pt flat. A column is now as wide as its longest value, between
  110 and 280pt; the table already scrolled horizontally, which is what pays for it.
- **A text field on a sheet had no chrome.** `TextField` drew nothing of its own, so the cron
  editor's Name, Instructions and Every fields were placeholder text floating on the glass. It now
  draws the sunk well with its hairline everywhere, and nothing inside an `InsetRow`, where the row
  is already the chrome — read from the row rather than passed, so neither side can forget. The
  connection-test screen's two hand-rolled inputs are the same primitive now.
- **The Default swatch was an unlabelled hollow ring** that read as a hole in the row on a dark
  sheet. It carries its name, and every swatch says whether it is the chosen one with a check mark
  rather than only with a thicker ring.
- **Raw gateway enums reached the screen.** The cron detail printed `ok` two rows under a humanised
  `Success`; the run history and Activity printed whatever the gateway sent. One humaniser gives the
  known statuses the design board's words and makes an unknown one readable rather than dropping it.

- **A resume during a turn this client did not author no longer paints it twice.** `message.start`
  carries no author, so the reducer stands a blank placeholder up and waits for a tail fetch to name
  one. `shownTurn` read that blank text AS the newest prompt — so a cron delivery already in history,
  with the scheduler's turn running over it, failed to match `inflight.user` and the resume stood a
  SECOND card beside the first. That was pinned as a KNOWN GAP in
  `packages/transcript/src/duplicate-cron-turns.test.ts` and is now a passing test. A placeholder is
  a promise of a prompt, not a prompt: it is walked past, so it neither counts as the shown prompt
  nor hides the item that is one, and the resume fills it in place (never appends, which would put
  the prompt below the reply it started) or drops it when the prompt is already on screen.
- **The same hole for a teammate's turn, which had no test at all.** An inbound bot message opens a
  turn here and is drawn as a tinted bubble holding only the BODY under its `Message from 🤖 …`
  signature, while `inflight.user` is the raw row. The comparison now runs through the same parsers
  `rows-to-items` uses, and a resume mid-teammate-turn projects a DM bubble rather than the signature
  line in a user bubble. The plain-user key goes through `stripUserText` for the same reason, so a
  prompt carrying `@file:` directives matches the bubble standing for it.
- **A sheet's title is `sheetTitle` (21/26), not the 28 pt sidebar title.** Every sheet had the
  larger one; it is obvious on a device and invisible in a component test.
- **Naming a page on the chat options sheet now opens it.** The sheet is mounted for the life of the
  screen, so `useState`'s initial value ran long before anyone asked for a page. It re-reads as the
  sheet becomes visible, which also stops an ordinary open landing on the page the last reader left.
- **Every wide-layout panel was painting the wallpaper's own colour over its glass.** `Screen` fills
  with `colors.bg` and adds the safe-area inset, which is right on a phone and wrong inside a
  floating panel that has already done both. Measured on the iPad simulator in the dark theme, the
  chat column sampled `#0A1830` — `elevation.e0`, the wallpaper rung — while the sidebar beside it
  sampled `#1B2744`, the panel rung it should have; after the fix both sit on the panel rung. This
  is why dark mode read as one flat field rather than as an elevation ladder.

### Changed

- **The Part-1 token aliases are gone**, and their users migrated: `bg` → `elevation.e0`,
  `surface` → `elevation.e3c`, `success` and `switchGreen` → `ok`, `border` → `hairline`,
  `bubbleBlue` → `accent`, and `incoming` / `incomingText`, which nothing used. `surfaceRaised` was
  not one rung — light `#E6EEFB` sits between `e2` and `e2s` while dark `#3E5480` IS `e3` — so each
  of its seventeen users took the rung its ROLE names: `e2` for a pressed or hovered row, `e3c` for a
  machine card, `tintSunk` for a code well, a command well and a segmented track. The type aliases
  `display`, `heading`, `callout`, `caption` and `mono` are gone too, onto `title`, `name`,
  `preview`, `meta` and `code`. `title` stays: §3 of the tokens document names it, so it was never an
  alias.
- **`danger` is the fill and `dangerText` is the ink.** `danger` held the ink's value, so the two
  were interchangeable and a `Text` could ask for either. It now carries §1.1's fill (`#C0293A` /
  `#D8465A`), every `Text` that asked for it asks for `dangerText`, and a Delete or Deny button is
  the colour the mockup draws.
- **Adding a divider opens an empty field, focused, whose placeholder is `Section name`.** An older
  build seeded the field with `New section`, so the first thing typed landed after it and the owner's
  device still carries a section called `New sectionFinance`. There is no migration for a build that
  was never released; instead the field is now visibly a field (a hairline, 15 pt, a 34 pt minimum),
  Remove is a bordered chip rather than a bare word beside it, and an unnamed section reads
  `Untitled section` rather than borrowing the old seed as its heading.
- **The sheet eyebrow is the `micro` token** rather than three numbers written out beside it, which
  is how it had drifted to a heavier weight and nearly twice the tracking the scale asks for.

### Removed

- **The gateway card** at the foot of the wide sidebar. It spent a permanent row on the state it is
  in every second of every day, said it in different words from the phone's own line, and carried a
  latency figure the app cannot measure. The footer is the four-tab strip on every layout.

- **The Liquid Glass direction, part 2: the conversation itself.** The transcript, the composer and
  everything the machine says in a chat now follow `design/liquid-glass.html`.
- **A bubble tail that is one shape.** `src/chat-ui/primitives/Bubble.tsx` draws the tail as a single
  SVG path belonging to the bubble (`react-native-svg`), positioned behind it so only the part that
  escapes the bubble's rounded corner is visible, and only on the LAST bubble of a run. The previous
  build built it from positioned `View`s and drew one on every bubble: on the Mac that showed as a
  square of bubble colour protruding past the bottom-right corner with a dark sliver beside it.
- **Grouping and date stamps** (`src/chat-ui/grouping.ts`), computed once per list rather than
  guessed at per row — which bubbles continue a run, which one carries the tail, and where `Today` /
  `Yesterday` / a date goes. A tool row between two replies ends a run: the reader can see it, so the
  replies are not adjacent.
- **Outgoing bubbles take the chat's accent gradient**, incoming ones the frosted glass recipe, and a
  LONG reply the near-opaque reading wash — not a stylistic variant but the only way body-text
  contrast stops depending on the wallpaper behind it. Past about fourteen lines the body folds with
  a gradient mask and `Show more`. The message that is currently streaming is never folded.
- **Per-item disclosure state lives above the list** (`src/chat-ui/expanded.tsx`). Every fold, card
  and roll-up keys its open/closed flag by item id in one set, so scrolling an opened card out of the
  window and back no longer re-collapses it. Nothing scrolls because a disclosure opened.
- **One bubble from start to finish.** The typing dots are now inside the assistant's own bubble as
  soon as it exists. The build drew a bubble of dots AND an empty assistant bubble with a timestamp
  in it — the grey rectangle reported from real use.
- **Cron deliveries are their own card**, not the owner's blue bubble. A clock glyph, the job's name
  and `ran 04:22 · delivered to this chat`, expanding to the report as rendered markdown. The wire
  carries no marker for this, so the projection is a documented heuristic — see
  [ADR-0013](docs/adr/0013-cron-deliveries-in-the-transcript.md).
- **Outgoing bot-to-bot messages are quiet LINES**, not bubbles: an arrow, `Message to @writer`, a
  preview, the time, and a reply marker that is always present — replied, waiting (a static hollow
  dot), or failed. Tapping one expands the exchange IN PLACE; it no longer navigates to the other
  bot's chat and scrolls it. Navigation lives behind one explicit `Open @writer's chat` link, which
  still lands on the matching row. More than three in a row roll up into
  `5 messages to @writer · 4 replies`.
- **Tool rows, thinking, status rows and notices are a quiet ledger** with one silhouette
  (`src/chat-ui/primitives/LedgerRow.tsx`), expanding onto glass cards so the expensive content is
  not mounted until asked for.
- **User bubbles render markdown too**, so a person who typed `**done**` or a path in backticks sees
  what the reply beside them would.
- **The composer is three separate controls** — a round glass `+`, the pill field, a round accent
  send that becomes a red stop square. A button that is not inside the field cannot overflow it.
- **`+` opens an instant in-app glass menu** (_Photo library_, _Choose file_; file first on a Mac).
  It is local state with no `await` in it, so it paints in the same frame as the tap, and the chosen
  entry shows a busy mark for as long as the system picker takes. Measured on the simulator: the
  menu is up in the frame of the tap, the picker follows 0.8–1.6 s later. The long-press placeholder
  for attaching a file is gone.
- **An attachment tray with file chips**: type glyph, the name middle-truncated so the extension
  survives, the size, a remove `×`, a progress ring while uploading, and the reason it was refused
  (`Too large · 100 MB max`). A sent file is a chip under the owner's bubble, never a raw `@file:`
  token.
- **A glass Jump-to-latest pill** with the unread count as an accent badge.
- **Licences, both halves.** `THIRD_PARTY_NOTICES.md` now also lists the upstream Desktop code this
  project ported, and `scripts/generate-third-party-licenses.mjs` walks the production dependency
  tree and writes `THIRD_PARTY_LICENSES.md` plus a bundle the app reads lazily for Settings → About →
  Licences. `npm run licences:check` runs in CI next to the icons check.

### Fixed

- **Bold was lost when a model opened the span with a stray space** — `** \`example.nl\` staat op
  autorenew=off**` rendered its asterisks. That shape is not valid CommonMark, so marked never
  emitted a `strong` token at all; `preprocess.ts` now repairs a run with exactly one broken end,
  which is what tells the two model habits apart from arithmetic.
- **An inline code span that wrapped painted an empty chip** across the rest of the line. A nested
  `Text` with a background paints every line fragment of its range, and the chip's padding was an
  ordinary space, so a wrap left a whitespace-only fragment filling the line. The chip's padding and
  its internal gaps are now non-breaking, and the chip takes its own tint rather than borrowing the
  code-block surface, which on the incoming bubble read as a redaction bar.
- **The fold's gradient mask faded through black.** `transparent` is transparent BLACK in React
  Native, so a mask interpolating to the surface colour travelled through dark grey and left a dirty
  band across the last lines. It now fades a colour to itself, and bleeds out to the bubble's edges
  so it is a fade rather than a visible rectangle.


- **The Liquid Glass direction, part 1: tokens, shells and the chat list.** The flat Messenger look is
  gone. `src/ui/tokens.ts` is now the token set from `design/liquid-glass-tokens.md` — a dark
  elevation ladder whose rungs are a measurable step apart, glass recipes per surface, three gradient
  wallpapers, the presence colours, and the eight per-chat swatches with their gradient stops. Dark
  mode is a blue-slate ramp rather than one flat black field.
- **`src/ui/glass/`**, one `GlassSurface` for every glass surface in the app. It draws the real
  material on iOS 26 through `expo-glass-effect`, falls back to `expo-blur` on older iOS, and
  collapses to a rung of the elevation ladder on Android and under Reduce Transparency — the same
  tokens in all three cases, which is what that ladder is for. The tokens document's rule about never
  nesting glass more than one level is enforced by the component rather than documented and hoped
  for: a surface past level 3 drops to a tint on its own. `Wallpaper` draws the three backgrounds as
  gradients, with no image assets.
- **A wallpaper setting** under Settings → Appearance: Blue (the default), Warm, Graphite, each with
  a light and a dark variant.
- **A wide layout that floats.** Two glass panels over the wallpaper with the mockup's gaps and
  radii. Activity, Crons and Settings now slide in over the chat column from the right behind a
  dimmed scrim, and the sidebar stays put and stays usable — they are things you consult, not places
  you go, and replacing the chat with them costs the reader their place. The panel closes on its
  round button, on a tap outside it, and on Escape.
- **Escape goes back one level.** A sub page inside the overlay — a cron's detail, a run transcript,
  the connection test — registers above the panel on the existing Escape stack, so the first press
  returns to the page underneath and only the second closes the panel.
- **Presence as one pure function** (`src/features/bots/presence.ts`), shared by the list and, in
  part 2, the chat header, so the two cannot disagree. Four states, and a precedence order that is
  the point of it: offline outranks everything, because a "needs input" bead on a chat that cannot be
  answered is a promise the app cannot keep; then needs input, then working, then online. The bead
  never carries the state on colour alone — the shape differs per state and the row says it in words.
  **"Needs input" is the only thing in the app that animates**, and it goes static under Reduce
  Motion.
- **Filter chips** over the chat list: All, Unread, Working, Needs input.
- **The list is the owner's, not the gateway's** ([ADR-0012](docs/adr/0012-local-chat-list-layout.md)).
  Rows can be reordered and grouped under named dividers, bots can be archived into a collapsed
  `Archived (n)` row at the bottom, and each chat can take one of eight colours. All of it is stored
  on the device and keyed by gateway address, which is what makes "Change gateway" start clean and
  "Sign out" keep the arrangement, with no clean-up code on either path. An archived bot is excluded
  from the filters, the unread totals and Activity's background loading.
- A round **New cron** control where a compose button would be, because there is one canonical chat
  per bot and you never create a conversation (ADR-0007).
- **The Mac, as the iPad build.** `npm run mac` builds the iOS app for
  `platform=macOS,variant=Designed for iPad`, signs it with the team in `HERMIE_APPLE_TEAM_ID`, and
  wraps the product so macOS will launch it — a bare iOS `.app` refuses to open with "incorrect
  executable format", and the shape it wants is `Hermie.app/Wrapper/Hermie.app` with a relative
  `WrappedBundle` symlink. `--no-open` builds without launching, `--debug` builds against Metro.
- One seam that answers "is this the iOS app running on a Mac?": a local Expo module,
  `apps/hermie/modules/hermie-mac`, exposing `ProcessInfo.processInfo.isiOSAppOnMac` as a constant
  behind `src/platform/runs-on-mac.ts`. React Native exposes nothing equivalent —
  `Platform.isMacCatalyst` reads a compile-time flag that is false for a "Designed for iPad" binary.
  The module is Apple-only, so Android and the test environment read `false` with no second
  implementation.
- **Shift+Enter inserts a newline** on a Mac, and a bare Enter still sends. The same module reads
  GameController's HID state, which is the only place the modifier exists: a text field's key event
  carries no modifier flags on iOS, so Shift+Return and Return arrive identically. The composer asks
  while it is handling the Return and, for Shift, writes the newline into the draft at the caret —
  replacing a selected range the way typing a character would, and leaving the caret after the
  newline rather than at the end of the draft. `Enter to send · Shift+Enter for a new line` now sits
  under the field wherever a bare Enter sends.
- **Escape closes things** on any build with a hardware keyboard attached. It comes from the same
  module and for the mirrored reason: Escape inserts no text, so it never reaches a text field at all,
  and a `UIKeyCommand` would sit in a responder chain that a presented `Modal` leaves — which is the
  case that matters, because a sheet is the main thing Escape should close. `useEscapeKey` routes it:
  a stack, last registered wins, one native subscription. It dismisses a sheet, closes the slash
  popover, backs out of the sign-in page, and stops a running turn when nothing else is open. A
  **blocking** sheet swallows Escape instead of being dismissed by it — ADR-0010 says an agent's
  question is answered by an explicit tap, and letting the key fall through would stop the very turn
  waiting for the answer.
- [ADR-0011](docs/adr/0011-mac-via-the-ipad-build.md), which supersedes ADR-0002 and lists what a day
  of building on react-native-macos actually cost.
- Project skeleton: npm workspaces, TypeScript project references, ESLint, Prettier, commit-message
  rules and a CI check job.
- `apps/hermie`, an Expo SDK 54 app targeting iOS, iPadOS, Android and the Mac, with the compact and
  regular shells, design tokens, theming and the platform storage abstractions.
- `@hermes/shared`: the Hermes protocol sources, vendored from a pinned upstream commit by
  `scripts/sync-hermes-shared.mjs`. The rewrites are asserted, `--check` fails on drift, and the
  upstream tests are vendored with the sources and run unchanged.
- `@hermie/gateway-client`: a React-free client for a Hermes gateway — URL and header handling, the
  unauthenticated probe, native PKCE with a token coordinator that keeps refreshes single-flight,
  session-token and PKCE credential providers, an HTTP layer that retries once after a 401, a dial
  plan socket factory, and the connection state machine over one long-lived JSON-RPC client.
- `@hermie/fake-gateway`: a gateway stand-in for tests and offline development, with a CLI behind
  `npm run fake-gateway`.
- A hidden developer screen at Settings → Connection test that probes an address and opens a real
  connection to it, reachable through a Settings link in the compact shell's header.
- Architecture decision records 0001 to 0005, a glossary, platform notes and a gateway runbook.
- An onboarding wizard: Welcome, gateway address, sign in, test connection, done. The address step
  probes the gateway while you type — debounced, and with a sequence guard so a slow answer cannot
  overwrite a newer one — and turns every failure into one sentence with the server-side fix where
  one exists. An "Advanced" disclosure takes extra request headers for a gateway behind an access
  proxy.
- Native PKCE sign-in through `NativeSignInWebView`: a full-screen, forgetful web view that renders
  the gateway's own sign-in page and intercepts the loopback redirect before it is loaded, verifies
  the `state`, and exchanges the code. If the web view cannot be used, the same flow completes
  through the system browser and a pasted redirect, parsed by the same function.
- A mandatory connection test that exercises REST and the WebSocket, tied to a payload key so that
  editing any field invalidates the result rather than leaving a stale success on screen. Only once
  it passes are credentials written to the secret store and the gateway configuration to the app's
  preferences.
- `GatewayProvider`: one `GatewayConnection` for the app's lifetime, built from the stored
  configuration at startup, following the app lifecycle and connectivity, with connection state in a
  store any screen can subscribe to. An expired session raises a banner that signs in where you are
  and resumes the dial loop.
- A Settings screen with the gateway, the live connection status, sign-out, change-gateway, and the
  developer connection test.
- English UI strings collected in `src/i18n/strings.ts`, and design tokens updated to the Messenger
  direction from `design/tokens.md`.
- A connectivity seam (`src/platform/net-info.ts`) so that macOS, where NetInfo has no native module,
  no longer fails at startup.
- Sending files, not only images. Upstream has no file-attach RPC, so a file is streamed to
  `POST /api/files/upload-stream` — multipart from the picker's URI, so nothing larger than a chunk
  is ever in JavaScript memory — and the prompt then carries the `@file:` reference the gateway
  expands. It has to land inside the session's own working directory, which is the only place that
  satisfies both the managed-files policy and the `allowed_root` the gateway pins `@file:` to;
  docs/platform-notes.md records why, with the upstream lines. The 100 MB cap is checked before any
  bytes move, every failure carries a reason rather than a raw message, and the file path sits behind
  a long press of the existing "+" so the composer's design is left to whoever owns it.
- `@hermie/transcript`: the chat engine — one item model that both history rows and live events
  project onto, a reducer that never filters and never invents an author, stable-id reconciliation,
  and verbosity as read-time selectors.
- The chat data layer. `src/store/chats.ts` holds one transcript per bot plus the runtime-session-id
  map that routes events and server requests to the right chat; `src/store/bots.ts` holds the roster,
  avatars, running state and the read watermark behind the unread marker; `src/store/settings.ts`
  holds the verbosity, bot-to-bot and thinking preferences, with one global default and an optional
  override per chat.
- A chat controller that owns every round trip a conversation needs: cache paint, `session.resume` on
  the durable id, history over RPC or — past four hundred rows — over the REST transcript,
  reconciliation, the in-flight snapshot, and the missed-event replay, in that order. It keeps every
  opened chat attached so bot-to-bot traffic keeps arriving, debounces `sessions.changed` into one
  tail reconcile per burst, re-resumes every live chat after a reconnect and refetches only the
  histories whose message counts moved, and drops the runtime id on `session.reclaimed`.
- Sending, with the message painted before the round trip and settled against `prompt.submit`'s
  status; images attached before the prompt that uses them; stop; approvals and clarifications;
  subagent steer, interrupt and tail; slash completion and execution; and the chat options (YOLO,
  fast, reasoning effort, model) scoped to the session so the gateway's global configuration is never
  rewritten behind the user's back.
- A bots screen and a chat screen wired into both shells, with the bot list as the sidebar on a wide
  window.
- `ChatCache`, a SQLite store for the roster and the last two hundred items per chat, so a chat
  paints before the gateway answers. It downgrades to memory if the database cannot be opened.
- The fake gateway grew the surface a chat needs: profile assets, the active list, the command
  catalogue and completion, session configuration, pending approvals, subagent methods and image
  attachment. Prompts steer it — "approve" raises an approval and parks the turn on it, "delegate"
  fans out subagent events — and `POST /__fake/inject` injects a turn somebody else ran.
- Routines: the cron surface, as a self-contained feature. The list comes from WS `cron.manage` with
  `include_disabled`, split into Active and Paused, each row carrying its schedule in words, the next
  run as a relative time, a status dot and — when the scheduler wrote one — the first plain sentence
  of its last error rather than the Python exception around it. A banner says so when
  `gateway_running` is false, because a routine on a gateway whose scheduler is down looks perfectly
  healthy and fires nothing.
- A routine detail screen with the full prompt, Pause/Resume, Run now, Edit and a Delete that asks
  first, over the run history; a run opens as a read-only transcript rendered by the same engine as a
  conversation, with no composer.
- A routine editor as a bottom sheet, with a schedule builder that writes only the forms
  `parse_schedule` documents — `every 30m`, `every day at 9am`, `every monday at 9am`,
  `weekdays at 9am`, a validated five-field cron expression, `in 2h` or an ISO timestamp — and shows
  the exact string before it is sent. It never predicts a next run: the schedule is parsed in the
  gateway's timezone, so the server's `next_run_at` is the only truth the screens show.
- The fake gateway's cron surface now matches `hermes serve`'s: three routines including a paused one
  and one carrying a scheduler exception, run sessions whose transcripts come back through
  `session.history`, delivery targets, a merging `PUT`, a `trigger` that appends a run, and a
  `cron.changed` broadcast after every mutation.
- The chat list, in the Messenger direction: a large title, a search field that filters on name and
  description, and one row per bot carrying its avatar, the last thing said, a relative stamp and the
  badges that decide whether you tap it now or later. A preview that starts `Message from 🤖 Writer
  (@writer):` is folded to `🤖 @writer: …`, because spelling it out in full on a forty-character row
  buries the message itself. "Working" comes from `session.active_list`, polled only while the list
  is on screen; "needs your input" comes from the open requests the chat store already holds, so it
  is true for a question that arrived while the list was not on top. Footer tabs reach Activity,
  Routines and Settings.
- The conversation, drawn with the chat UI kit: the header with its avatar and live subtitle, the
  transcript with bubbles, markdown, tool cards, DM cards and subagent groups, the agents bar pinned
  under the header while children run, the composer with its attachment tray and slash popover, and
  the jump-to-latest pill. The compact stack hides its own header for that route rather than
  configuring it, because a native title bar cannot carry an avatar and a status line.
- Approvals and clarifications as bottom sheets driven by the open requests in the transcript: one at
  a time, oldest first, acknowledged to the queue on first show so the countdown stops, and answered
  only by an explicit tap. A question resolved elsewhere or timed out says which.
- The chat options sheet, bound to `session.info` for YOLO, fast mode, reasoning effort and the model
  inventory from `model.options`, and to the per-chat view settings for verbosity, bot-to-bot and
  thinking. A chat that pins its own view says so and offers to follow the default again. A model the
  gateway flags as expensive is confirmed before it is set.
- Attachments: the photo library, resized to 1568 px on
  the longest edge before they are encoded — a camera-roll photo is several megabytes and
  `image.attach_bytes` shares the socket the transcript streams on.
- A Chat section in Settings for the default verbosity, bot-to-bot and thinking, and an Appearance
  section that pins the app to light or dark instead of following the system.
- An app icon: a speech bubble carrying an H whose crossbar lifts like a wing, drawn by hand as
  `design/icon.svg`. `scripts/generate-app-icons.mjs` rasterises it into every size the app ships —
  the iOS and Android icons, the Android adaptive foreground, the splash image and the favicon — with
  a scan-converter written for the purpose, so the icons need no image
  tooling installed and come out byte-identical on every machine. CI fails if any of them has drifted
  from the SVG.
- A release process. `.github/workflows/release.yml` builds an Android APK on a `v*` tag and publishes
  a GitHub release with the CHANGELOG section for that version. `docs/release.md` is the runbook,
  including the halves a machine cannot do: TestFlight and Play internal testing through EAS.
- `scripts/set-version.mjs` sets the version in every place that carries it — both package.json files
  and `app.config.ts` — and fails loudly rather than skipping a file whose shape has changed. `scripts/changelog-section.mjs` reads one version's notes out of this
  file, which is what the release workflow publishes.
- Repository furniture for a public project: a Contributor Covenant code of conduct, issue forms for
  bugs and feature requests, and grouped weekly Dependabot updates for npm and the actions.
- Activity: one timeline of everything the bots said to each other — `researcher → writer: …`, the
  reply that came back, and every `delegate_task` fan-out — grouped by day, newest first, with a tap
  that opens the conversation a row came from scrolled to that exact message. It is a view over the
  transcripts the app already holds rather than a second copy, and bots nobody has opened are filled
  in by a background load of their newest rows through the same projection, so opening one afterwards
  reconciles onto those items instead of duplicating them. A delivery is written into both chats, so
  the sender-side dispatch wins the dedupe: it is the row that knows whether the message was queued,
  delivered or failed. Three counters sit above it, each from a different call — bots working from
  `session.active_list`, live sub-agents from `delegation.status`, deliveries still in flight from
  `agents.list` filtered to the `bot_mode_dm.py --run-delivery` runner — polled only while the screen
  is on top.
- Bot-to-bot traffic is now walkable in both directions. A dispatch card opens the recipient's chat on
  the inbound message it produced, and an inbound message's header opens the sender's chat on the
  dispatch that sent it; the two rows share a sender, a recipient and a body but no identifier, so the
  match is handle plus nearest stamp and it refuses rather than guesses. While a dispatch is out and
  the recipient's chat is mid-turn, the card says `@writer is writing…`.
- `subagent.list`, folded in when a chat opens and every five seconds while anything is delegating.
  `subagent.*` events have no replay, so a conversation opened halfway through a delegation never saw
  its children start; the roster is the only way to learn about them. It adds and refreshes and never
  resurrects a child the stream already saw finish.
- The agents sheet gained a read-only transcript per child: the live `subagent.tail`, polled every
  three seconds while the child runs, and — once it has a `child_session_id` — the child's own stored
  session, which outlives the tail. Steer and Stop now report what the gateway answered, including a
  steer that arrived after the child's last batch.
- The unread badge counts. A chat the app has loaded shows how many replies and inbound teammate
  messages arrived since it was last looked at, capped at `99+`; a chat it has never read keeps the
  dot, because `last_active` is all the gateway reports and a number there would be invented.
- The transcript can be asked to scroll to one item, with the `onScrollToIndexFailed` recovery a
  virtualised list needs, and it reports honestly when the item is not in the visible set — a chat on
  Quiet genuinely does not contain every row.
- Hardware-keyboard handling in the composer: `Cmd`/`Ctrl+Enter` sends and `Escape` stops a running
  turn wherever a platform reports them, and a bare `Return` sends where a physical keyboard is
  certain. See the Changed entry below for what that turned out to mean on iOS.
- The fake gateway's delegation is now three children over several seconds with one of them failing,
  wrapped in a real `delegate_task` call, plus `subagent.list`, `delegation.status`, `agents.list` and
  a live `message_agent` hand-off whose reply comes back as a `process_complete` row. A fan-out that
  finished inside one frame could not be looked at, let alone steered.

### Changed

- **The signed-out state is no longer a one-line banner.** A real Mac session reported the obvious:
  what a reader saw was a chat error in the content area and a small "Sign in" in a corner, and it
  was not clear at all that the thing to do was sign in. It is now a card that takes the whole content
  column — it names the gateway, offers the same in-place sign-in the banner used, and offers Change
  gateway — the sidebar's gateway card turns amber and is the same action, and the chat list stays
  visible from cache with its rows reading Offline. `ReauthBanner` is gone; `SignedOutPanel` and
  `useReauth` replace it.
- **The empty strip under the macOS title bar is gone above the sidebar too.** It had been fixed for
  the chat column only: the sidebar pane carried a top padding of its own that the Mac-aware inset
  never reached. Both panels are siblings in one row now and the row carries the safe area once, so
  the two columns cannot disagree about a number neither of them owns.
- The four-tab strip (Chats · Activity · Crons · Settings) and the gateway card sit at the bottom of
  the chat list on both layouts, as the mockup's two frames show.
- `design/liquid-glass.html` and `design/liquid-glass-tokens.md` are the current reference;
  `messenger.html` and `tokens.md` are superseded and say so.
- **The Mac version is the iOS app** running as "Designed for iPad" on Apple Silicon, instead of a
  native react-native-macos target. Eight platform seams collapsed back into one implementation each —
  bottom sheets, safe area, haptics, the status bar, the secret store, attachments, connectivity and
  the shell — and the Mac now has a real keychain, a real `Modal`, a real navigator and every Expo
  module. Apple Silicon only, and distribution moves to TestFlight and the App Store, which offer an
  iPhone/iPad app on a Mac from the same listing.
- A bare `Return` sends on a Mac through `submitBehavior="submit"` and `onSubmitEditing`, not through
  `onKeyPress`. On iOS a text field's key event carries no modifier state and cannot suppress the
  insertion, so `submitBehavior` is the only thing that can stop a Return becoming a newline. Which
  Return it was comes from the keyboard itself — see the Shift+Enter entry above.
- The composer no longer looks for Escape in `onKeyPress`. It never arrived there on iOS, and there is
  one mechanism for the key now rather than two that could both fire.
- A Mac window no longer pauses the gateway connection when it leaves the front. `pause()` closes the
  socket, which is right on a phone and wrong for a window that is merely hidden or behind another app.
  The owner's report of "gateway not connected" on the Mac build is consistent with that, though
  neither the banner's cause nor the AppState values a Mac window reports have been measured. The
  approval and subagent polls keep running there for the same reason.
- `expo-secure-store` is the secret store on the Mac too, so the AsyncStorage fallback and the warning
  that a Mac build must not be pointed at a production gateway are both gone. Linked and entitled;
  **not yet exercised in a running Mac window**.
- The version script writes three places, not four, and has no `--build` flag: the hand-maintained
  macOS `Info.plist` was the only file that carried a build number by hand, and EAS owns that number.
- `.easignore` names the parent directory of the two generated native projects. A bare `ios/` pattern
  matches at any depth and also swallowed the local Expo module's `ios/`, which would have produced an
  EAS build with no native module in it. `npx expo-doctor` fails on exactly that.
- The `overrides` entry pinning `react-native` and `react` in the root `package.json` is gone. It
  existed so react-native-macos resolved against Expo's runtime, and removing it changed no
  resolution in the lockfile.
- The flat-colour placeholder artwork and the script that wrote it are gone, replaced by the icon set
  above.
- The native CI jobs run on release tags as well as on demand, build with signing switched off, and
  keep the Android APK.
- Android asks for the network and the photo library and nothing else; `VIBRATE` and
  `WRITE_EXTERNAL_STORAGE`, both pulled in by dependencies rather than wanted, are blocked. iOS
  answers the export-compliance question in advance, the splash screen now hands over to the app's own
  background colours, and the Android adaptive icon sits on the blue from the middle of the icon's
  gradient.
- An answered approval leaves a receipt that says what was decided and about what — `Allowed once ·
  rm -rf ./build`, with the command truncated — instead of `Answered: once`, which said neither.
- A finished reply only shows its duration next to something that explains it. A bare `0.1s` under a
  bubble read as a stray artifact rather than as part of the message.
- The typing dots follow the turn rather than the chat being busy. A chat whose turn has ended while a
  sub-agent keeps working is not about to say anything, and three dots there promise a sentence that
  is not coming.
- A reply addressed at another bot is drawn slightly quieter than one addressed at you.
- Dragging the transcript down now lowers the keyboard with the finger.
- The scheduled-prompts feature is called **Crons**, not Routines. The gateway, its CLI
  (`hermes cronjob list`) and its dashboard all say cron, and a second name for the same thing only
  cost the reader a translation step. Where the list spans more than one profile, each row now says
  which one it belongs to, and creating a cron picks the profile it is created for.

### Fixed

- **A message you sent no longer comes back as a second bubble.** Reported against a real gateway:
  one long multi-paragraph message, shown twice a minute apart, with the turn still running. Nothing
  links a locally sent turn to the row the gateway writes for it — `prompt.submit` answers with a
  status, never a row id — so the two are paired on their text, and four separate things broke that
  pairing. Each is now covered by its own case in `packages/transcript/src/duplicate-turns.test.ts`
  and `apps/hermie/__tests__/chat-duplicates.test.ts`; `docs/platform-notes.md` has the diagnosis.
  - **A resume projected its whole in-flight turn regardless of what was already on screen.** The
    gateway writes the user row at submit time rather than when the turn ends, so the prompt is in
    the rows AND in `session.resume`'s `inflight` — and a reconnect, or the chat reopened mid-turn,
    painted it beside the bubble already standing for it. The second copy carries the time the resume
    landed, which is the minute in the report; the reply got the same treatment. Both halves now
    settle onto what the transcript holds. A prompt repeated on purpose still gets its own bubble:
    what tells a repeat from a re-description is whether a durable reply sits between them.
  - **A send carrying a file paired with nothing.** The bubble held the body as submitted, `@file:`
    directive and all, while the row comes back with those directives lifted out into `attachments`.
    The optimistic bubble now goes through the same projection a persisted row does.
  - **Match text is normalised to NFC.** Two spellings of the same accented word are one message to
    a reader. Nothing but the comparison sees it.
  - **A parked burst lost its author after the first prompt.** The reducer remembered one queued
    prompt, so the second of a burst started as a foreign turn and stood an empty placeholder in
    front of the user's own message.
- **Rows are shown in the gateway's order, not in the order they reached us.** A tail fetch spliced
  every row it had not seen in front of the live tail, which is wrong for a row written BEFORE the
  message on screen — a teammate's delivery or a cron turn that landed while the user was still
  typing carries a lower row id, and the ids that say so only arrive with the tail. The reader saw
  their own message above one written before it.
- **`expo-secure-store` on a Mac is exercised rather than assumed.** A Mac window stayed signed in
  across a quit and a relaunch. `SECURITY.md` and `docs/platform-notes.md` no longer carry it as
  unverified. One thing seen once and not explained is recorded as such: the first launch of that
  build did ask for a sign-in again.
- **Return, Shift+Return and Escape on a Mac are verified by hand**, which also settles that
  `GCKeyboard` is populated for an iOS app on a Mac — none of the three is reachable otherwise.
- `GameController.framework` is linked into the Mac and iOS builds, which is all GameController asks
  for — no entitlement and no Info.plist key. Whether `GCKeyboard.coalesced` is populated for an iOS
  app on a Mac is reasoned from the SDK and **not yet watched**; if it is nil, Shift+Enter and Escape
  degrade to doing nothing rather than failing.
- The empty band under the title bar on a Mac. An iOS app on a Mac is told it has an iPad's status
  bar, and `Screen` turned that ~25pt top safe-area inset into padding nothing occupied, because the
  macOS title bar is outside the app's window. The top inset is dropped on a Mac and only there;
  iPhone and iPad are untouched. Fixed in code, **unverified in a window**.
- A chat opened while the socket was still dialling failed outright and nothing retried it. The
  screen called `openChat` on mount regardless of the connection, and `session.resume` on a
  connection that is not up rejects immediately — it does not queue — so a cold start or a tap during
  a reconnect put "This conversation could not be opened: gateway not connected" over the
  conversation, with a Try again nobody should have had to press. The open now waits for the
  connection to report ready and runs on the transition to it, which is the same fix the bot roster
  got for the same race and which covers every reconnect; a failed attempt is retried on the next
  ready connection. While it waits the screen keeps whatever the cache painted and says so quietly.
  The red banner is now reserved for failures that happen while there is a connection, and a
  connection that will never become ready on its own — signed out, too old, or refused by the
  gateway's own configuration — says which of those it is instead of "gateway not connected".
- A resumed chat dropped the gateway's own view of the session on the floor. `session.resume`
  answers with `info` — the model, the flags, the working directory — and it was read once for the
  compatibility check and then discarded, so `chat.info` stayed empty until the gateway happened to
  send a `session.info` event. `refreshOptions` already assumed otherwise, merging its patch onto
  "what the resume reported".
- The chat header said "Connecting…" over a conversation that was loaded and streaming. Resuming
  from the background walks the whole pre-dial ladder again while the session keeps working, and the
  subtitle was reading the socket's bookkeeping rather than this chat's state.
- The cron list showed nothing for a cron that lives in a bot's profile, while the gateway dashboard
  listed it. The list was read over the socket, and `cron.manage` is profile-scoped: it binds
  HERMES_HOME to its `profile` parameter and answers from that one store, so an unscoped call
  reported the launch profile's jobs and silently omitted every other profile's. The list is now
  `GET /api/cron/jobs?profile=all`, the only surface that walks every profile and the only one that
  says which store a job came out of; one socket call rides along for `gateway_running`, which no
  HTTP route reports, and its failure no longer costs you the list. Every detail read, run history,
  pause, resume, trigger, edit and delete now names the owning profile.
- A cron read over HTTP showed no schedule and always claimed to repeat until removed. The stored job
  keeps the parsed schedule as an object with the readable form beside it under `schedule_display`,
  and `repeat` as `{times, completed}` rather than a count — both were read as if they were the
  socket's already-flattened strings, so both came out empty.

- A reply that arrived after a tool call was painted twice — once as the partially streamed copy and
  once as the clean final — while the gateway had stored a single row. The tool boundary seals the
  streaming bubble, so the completion had nowhere to land; it now settles onto that sealed bubble
  whenever the two texts are prefix-compatible, which only the same message can be. Upstream carries
  the same fix.
- The approval sheet labelled its buttons from a vocabulary the gateway never sends. Hermes answers
  with `once`, `session`, `always` and `deny`, so every approval showed raw protocol words instead of
  "Allow once" and "Always allow".
- Every secret field offers to show its value, so a pasted token can be checked before it is saved.
- `expo-image-picker` needs an explicit photo-library usage string; without one iOS terminates the
  app the moment the permission is requested, with no dialog and no crash report.
- Every message you sent appeared twice a moment later. `prompt.submit` answers with a status and no
  row id, so the optimistic bubble and the streamed reply had nothing linking them to the rows the
  gateway persisted; the next `sessions.changed` sweep read the tail, found two rows it had never
  seen, and appended them. The tail reconcile now pairs a fresh row against a live item of the same
  kind and text, the way a full re-hydration already did.
- The transcript told the screen it had scrolled away from the bottom from inside a state updater,
  which React runs during another component's render. That is a "cannot update a component while
  rendering a different component" error and an update that can be dropped; it is an effect now.
- The Activity timeline's `↩` rendered as an emoji on iOS, which is what U+21A9 means without an
  explicit text variation selector.


### Removed

- **The native macOS target.** `apps/hermie/macos/` and its hand-maintained Xcode project, Podfile and
  application delegate; the `react-native-macos` dependency; the `macos` Metro platform and the
  `react-native` → `react-native-macos` import rewrite; `react-native.config.js`; every
  `*.macos.ts(x)` variant in `src/`; `docs/macos-smoke.md`; the macOS asset catalogue; the macOS CI
  job; and the macOS build, Developer ID signing and notarisation steps in the release workflow, with
  the four secrets that fed them. Git history keeps all of it, and
  [ADR-0002](docs/adr/0002-macos-via-react-native-macos.md) keeps the reasoning.
- `expo-document-picker`, which existed only for the macOS attachment picker.

### Internal

- `src/ui/tokens.ts` keeps the older colour roles (`bg`, `surface`, `surfaceRaised`, `bubbleBlue`,
  `success`, `switchGreen`, `border`, `incoming`, `incomingText`, `danger` as a text colour) and the
  older type names (`display`, `title`, `heading`, `callout`, `caption`, `mono`) as **aliases** onto
  their Liquid Glass equivalents, so that the transcript, the bubbles, the composer and the sheets
  keep rendering untouched while part 2 restyles them. They are meant to go with that pass.
- `expo-glass-effect`, `expo-blur` and `expo-linear-gradient` are new dependencies. `npx expo-doctor`
  stays at 18/18.

[Unreleased]: https://github.com/fullstackstudio-org/hermie/compare/v0.1.9...HEAD
[0.1.9]: https://github.com/fullstackstudio-org/hermie/compare/v0.1.8...v0.1.9
