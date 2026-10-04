# How the web client works

Hermie in a browser is the client in `native/web`: React, Vite and TypeScript, with no Expo and no React
Native Web. The `hermie` gateway plugin serves it on the gateway's own origin, at
`/dashboard-plugins/hermie/app/index.html`. The decision, the options that were rejected and the threat
model are [ADR-0030](adr/0030-web-client-served-by-the-plugin.md); the client's own code, commands and
screens are in [native/web/README.md](../native/web/README.md). This page is the short version of how
the pieces fit.

It replaces **Hermie Web**, the standalone Node server (0.1.x, `packages/hermie-web`) that used to serve
the Expo app's browser export and proxy one gateway onto its own origin. That server, its Docker image,
its release zip and its Kubernetes examples are removed, and nothing is migrated from it: the new client
is on another origin, so it starts with empty browser storage, a new installation id and a new push
subscription. [ADR-0015](adr/0015-web-variant-on-its-own-port.md) and
[ADR-0025](adr/0025-hermie-web-is-a-service-layer.md) record what the old server was.

## The problem: a cookie belongs to an origin

The gateway's browser session is an `HttpOnly` cookie, a cookie belongs to the origin that set it, and
the gateway refuses a WebSocket whose `Origin` is not its own. The refusal is a defence: without it, a
page on the internet could point a name at your loopback interface and drive an agent that runs shell
commands. So a browser client has to be on the gateway's origin to use that session honestly, rather
than ask the gateway to relax the guard.

The old server solved that by proxying the gateway onto its own origin. The plugin solves it by serving
the client from the gateway itself, through the dashboard's static route, so the page is same-origin by
construction and there is nothing in between: no proxy, no second process, no `Host` or cookie
rewriting, and no state outside the gateway and the browser.

## What the plugin does and what it does not

- **It contributes files.** The built client (`dist/` of `npm run client:build`, with a `build.json`
  that names every file and the commit it was built from) is committed to the plugin repository and
  imported there. The gateway decides who may fetch the files and authenticates every API call.
- **It publishes an advert** in the gateway's `ui_meta`, which the client reads to know what is
  installed next to it: the plugin version, its capabilities, the client's own version and the Web
  Push public key.
- **It sends push.** Web Push, Expo and the relay all go through the plugin, which owns the only VAPID
  key. The client subscribes with the key in the advert and writes its registration into `ui_meta`;
  see [ADR-0017](adr/0017-push-through-hermie-web.md) for the registration and payload rules, which
  stand.
- **It updates itself** with `hermes plugins update hermie`. Rolling a bad client back is a revert in
  the plugin repository.

## Signing in

On a gateway with sign-in, the client uses the dashboard's own session: its `/login`, its cookie, and a
single-use ticket for each WebSocket dial ([ADR-0005](adr/0005-ticket-per-websocket-dial.md)). The
client draws no password field of its own, so password managers, passkeys and SSO behave as they do for
the dashboard, and it stores no credential in browser storage. A rejection always means "sign in
again". On a gateway without sign-in the session token is read from the dashboard's own page and held in
memory only.

Which sign-in providers a gateway offers is the gateway's configuration. The old server's built-in OIDC
provider is gone; a gateway whose `dashboard.oauth.self_hosted.issuer` pointed at it needs another
provider.

## Passkeys

Settings › Passkeys lists the signed-in person's passkeys on the gateway (the contract is
`contract/confirm-passkey/`). A passkey is the person's proof for a confirmation an agent asks for; the page
runs the browser's own ceremony and the gateway keeps only the public key. The level is offered only on an
HTTPS page at the gateway's own address, without a path in front of it, for a host the gateway lists.

There are two ways to add a passkey from the page, and a third elsewhere:

- **Add a passkey, by signing in again.** Shown when the gateway's status says `self_enrol.available` and the
  page's host is accepted; the sentence under the button says "You will sign in again to prove it is you, then
  your browser creates the passkey". The click asks the gateway for a grant (`POST
/api/auth/passkeys/reauth/begin`, which also sets an HttpOnly binding cookie the page never sees), keeps the
  grant's **id and deadline, and whose it is (the author id), and nothing else,** in this tab's `sessionStorage`
  (`hermie:<ns>:passkey-enrol`, next to the stashed route; somebody else signed in when the page is back does not
  find it), and sends the whole window to the gateway's own `/auth/login?…&reauth=<id>&next=…`, a path the page
  rebuilds itself (exactly `<prefix>/auth/login` on its own origin, with only the grant and `next`)
  (top level: an identity provider cannot be framed). The gateway decides whether that sign-in was fresh. Back on
  the page, on the route it left, the same section reads **Finish adding your passkey**: a button, because the
  browser's passkey sheet wants a click. It runs `register/begin` with the grant, the browser's ceremony, and
  `register/finish` with the grant, and the stash goes. The page cannot know that the sign-in finished, so the
  section says "If you finished signing in again, add your passkey now" and the gateway decides; the deadline it
  shows is for display, and a clock that is a few minutes off does not drop a grant the gateway still takes. A
  closed sheet, a lost connection or a rate limit leave the grant for another try until it runs out (10 minutes);
  every answer that ends it (`reauth_invalid` and its reasons, switched off, a provider that cannot ask again)
  clears the stash and says in a sentence what happened. A sign-in that did not count or a grant that is gone
  (`reauth_invalid`) offers **Sign in again**, which starts a new grant; "switched off" and "provider cannot ask
  again" leave only the code path. Signing out clears the stash too.
- **Add with a code**, for the first passkey on a gateway where self-enrolment is off or unavailable, and for
  another device: an operator's one-time code, or one made with a passkey this person already has.
- **Make a code** (needs a passkey of this browser) mints a code for another device.

An older gateway (no `self_enrol` in the status, or no `reauth/begin` route) shows only the code path. A
passkey added by signing in again is listed with `usable_from` while the operator's cooling-off runs, and cannot
answer a confirmation before it. What this adds to the risk is one sentence: whoever can pass a fresh sign-in as
the person (their password and their identity provider's second factor) can add a passkey and then confirm,
which is what signing in as them already allows; a stolen session alone cannot, because the sign-in has to be
passed again and is bound to the browser that asked.

## Forms, files and drafts the agent asks for

Beside the approval and the clarify question, an agent can ask the person for three more things: **a form**
(`input.form`: one to twelve typed fields), **a file** (`input.file`: one or more files, uploaded) and **a draft to
review** (`review.draft`: a mail, a post or a message, to approve, change or reject). The wire is
[contract/requests](../contract/requests/README.md), which is normative; this section is how the page behaves. The
agent's side lives in the gateway: the tools `ask_form`, `ask_file` and `review_draft` are in the toolset
`interactive`, which is off by default (switch it on with `hermes tools`, for the platform `cli`).

### What the page advertises, and when

A gateway sends one of these requests only to a connection that said it can show it. So the page lists the methods in
the **second** `client.capabilities` call, and only after the first call's answer named them under `server_requests`
(a gateway that does not know them would refuse the unknown key and the whole call with it). It lists a method only
if this browser can do what it takes: `input.file` needs `File` and `FormData`, which every current browser has. A
request the gateway parked for a device that can show it is delivered as soon as the advert is accepted.

The page advertises what it can really show, because a gateway that knows a page can show a form sends it there
instead of telling the agent that no client is available. A single request the page cannot show (a version or a form
field kind it does not know, a frame that is not the contract's, too many waiting) is answered `4041 cannot_show` with
a reason, never with a made-up skip, and leaves one short notice on its chat.

### The three sheets

Each is a modal sheet over the page, in a frame that is the page's own: the heading, the gateway's host, who receives
the answer and the buttons are fixed words, and everything the agent wrote (its title, its summary, its detail) is
plain text in a quoted box under a label that says it is the agent's. It is never Markdown and never a link, and it
cannot style the frame around it.

- **The form** draws the agent's fields with the browser's own inputs: text, number, amount, date, time, datetime,
  date range, choice and toggle. The page checks a field the way the gateway does and says what is wrong next to the
  field, in the gateway's own terms, before anything is sent; a refusal from the gateway comes back next to the field
  it names and leaves everything typed in place. An amount goes out as a decimal string with at most the currency's
  minor unit, and a datetime with its offset and its zone.
- **The file sheet** offers the browser's picker, filtered by what the agent accepts, and a camera button where the
  device probably has one. It enforces the request's `max_files`, `max_bytes` and `max_total_bytes` as files are
  added and again on the prepared files, before the first byte moves. A picture gets a preview.
- **The draft sheet** shows the text verbatim: monospaced, never wrapped, never rendered. Every character the gateway
  refuses (zero-width characters, direction overrides, a tab) is shown by its code point, and the page names the rule
  and the line instead of rewriting anything, so **Approve** waits until the person has taken it out. When the draft
  is editable it can be changed before approving (**Approve with changes**), with the original kept on screen for
  comparison. **Reject** takes an optional comment for the agent. A draft has no Skip.

**Skip** is offered only when the request is `optional`. A countdown runs to the gateway's deadline; at that time the
sheet goes, nothing is sent, and the chat says so.

### Later, Open and Don't share

**Later** (or Escape) puts a sheet away without answering: the request stays open at the gateway, the page is usable,
and what was typed or picked stays in the sheet. The transcript's record of the request offers **Open** to bring it
back. Later is not an answer. It is also the one place Escape closes a question sheet: an approval or a clarify
question has no dismiss.

**Don't share**, on a form or a file request, tells the agent the person chose not to provide it (`4041` with reason
`declined`). The gateway passes that on as the person's choice, which is neither a skip nor a failure, and the agent is
told not to ask again at once. On a draft the refusal is Reject.

### Taps, order and several at once

For 400 ms after a sheet is shown its controls are off, so a click or a keystroke meant for what was under it never
answers. The guard starts when the sheet is **shown**, not when it is built: a sheet queued behind another, a form that
comes back after a question, or one opened again after Later, starts over, and so does the question that took the
screen from a form. A double click on a question's button therefore cannot answer the form that appears behind it.

One sheet is on screen at a time, from one queue, in the order the page first saw each request, with one rule on top
of that: **a question comes before a sheet** (the same rule as the native apps' `ChatSheetOrder`). An approval, a
clarify question, a passkey confirmation, a secret, sudo or vault prompt and a connector authorisation stop a bot, so
they are shown before a form, a file request or a draft, whatever the order they arrived in; among themselves, and among
the sheets, the order stays first seen, first shown. Requests that arrive in the same moment (a resume that restores
several) are ordered approvals and clarify questions first, then confirmations, secure prompts and these.

A form, file request or draft that is on screen when such a question arrives **steps aside**: it is not answered, not
put away with Later and not closed, so what was typed, picked or edited in it is kept (the page keeps its sheet alive
while it is out of sight), the dialog shows the question, and a polite announcement says that a question came first.
When the questions are done the sheet **comes back by itself**. This differs from the native apps only in that a sheet
there is gone with what was entered in it when it steps aside.

The one exception is a sheet that is in the middle of something: while it is **sending an answer**, or **preparing or
uploading files**, the question waits until that is over (an answer that did not get through leaves the sheet open, and
the question then goes first), so an upload is never cut off by a question. The same is true the other way round: a
sheet put away with **Later** is the person's own choice and stays away, through any number of questions, until they
press **Open**; Open while a question is waiting queues the sheet behind it. A sheet put away with Later no longer holds
the queue.

### Uploads

A file is uploaded to the request's `upload.dir` **before** the answer is sent, one after another, through the page's
own upload route and with the credentials it already uses for attachments. It goes **flat** into that directory as
`<16 hex>-<safe name>`: the gateway refuses a subdirectory. The answer carries the path, the name, the type, the size
and the SHA-256 of the bytes **as uploaded**, never the bytes themselves; the page hashes the prepared file, so the
figures are those of the file on the gateway. Each upload shows its progress and can be cancelled, and a file that is
already up is not sent again when the person tries once more. A failed upload is said in the sheet: **Try again**, or
**Give up**, which tells the agent `4041 upload_failed`, not an answer.

With `strip_metadata`, a JPEG or PNG is decoded and drawn again on a canvas, which writes none of its EXIF or location
data (the camera's rotation is applied to the pixels first). Any other picture the browser can read becomes a JPEG, and
one the browser cannot read is refused rather than sent with its metadata. Documents and audio go up untouched.

The page cannot take an upload back. One that is never answered stays on the gateway: the person cancelled mid-way,
gave up after a later file failed, put the sheet away and the request ran out, or the gateway withdrew the request.
Nothing deletes those files; they sit flat in the directory under their `<16 hex>-<name>` names, so they can be cleared
by age like any other upload. What is left behind carries no location data when `strip_metadata` was asked.

### What is never stored

What a person types, the files they pick and the text they edit a draft into live in the sheet's own state for as long
as the sheet exists and go into the one `request.answer` call. They never reach the transcript, the chat store, the
cache, a draft, a log or a diagnostics export. The transcript is told only that a question was asked and how it ended:
the heading, the agent's words and a summary such as `answered` with a count of files, or `approved` with whether the
text was edited, never a value. Nothing is kept across a reload either: which sheets were put away is in memory only,
and a request that is still open is delivered again.

### Reconnects

The page answers through `request.answer`, so the gateway's refusal comes back to the sheet. A request stays open
across a dropped socket and a reconnect. A gateway lists these requests only to a connection that advertised them, and
a reconnect's resume runs before the new socket's advert, so the page reads the gateway's list again once the advert
was accepted.

- A request that ended while the page was not listening (withdrawn, timed out, answered on another device) closes with
  a notice that says so, and nothing is sent.
- A re-delivered copy of a request the page already answered or let go is the proof that the answer never arrived: it
  opens again and says so. A copy of one the gateway withdrew, that expired, or that the page declined never opens.
- **An answer on its way is not overruled.** The gateway also sends `request.cancel` with reason `resolved` to the
  device that answered, and it can arrive before the reply to the answer. While an answer is in flight, a cancel and
  the local deadline wait for the call's result, which decides. A call that failed without the gateway's word leaves
  the request open for another try, and a later "no longer waiting" says the answer may not have arrived rather than
  that it expired.
- A request for a session no chat holds yet waits, at most sixteen at once, until a chat holds it or its deadline
  passes. The page does not decline for waiting: a chat the reader is about to open may still answer it.
- The deadline is the request's own `expires_at`, on the page's clock. A request that arrives already past it is not
  shown, and none is answered after it.

## What it cannot do

A browser genuinely cannot do some things, and the client does not pretend otherwise: there is no
keychain (the session stays in the cookie jar, and clearing site data signs you out), no background
socket, no device authentication, and a page cannot put extra request headers on a WebSocket, so a
gateway behind Cloudflare Access wants the access proxy in front of the gateway itself. The full list
is decision 12 and "What the person loses" in the ADR.

## When something is wrong

- The client refuses to run when the plugin's advert says the web module is `off`, and it refuses to
  run inside a frame.
- A sign-in loop or a rejected WebSocket is a gateway-side question first: open the gateway's own
  dashboard in the same browser and check that it signs in there.
- Everything the client says about a build is in Settings → About, and in `build.json` beside
  the files; the plugin's own update log says which commit it imported.
