# 0010. Questions from the agent are bottom sheets

- Status: Accepted
- Date: 2026-09-19

## Context

While a bot works it can block on the user: a permission request before running a command
(`approval`), a clarifying question with choices or free text (`clarify`, optionally a batch), and a
few desktop-only prompts Hermie declines. Each request is a JSON-RPC server-to-client request that
holds the agent's turn until it is answered, withdrawn (`request.cancel`) or times out. Requests are
replayed after a reconnect so a client that was in the background can still answer them.

## Decision

Approval and clarify requests are presented as **bottom sheets** that slide up over the chat. The
sheet shows the command or question and its answer options as explicit buttons; there are no swipe
or long-press gestures that could answer a request by accident, and a short guard after the sheet
appears ignores taps that were meant for the chat underneath. A request answered on another device
collapses into an "answered elsewhere" state.

The same sheet component hosts the chat options panel (YOLO, fast mode, reasoning effort, model,
verbosity, bot-to-bot and thinking visibility), whose toggles are commands to the gateway.

## Consequences

- The sheet component is implemented on `Modal` and `Animated` rather than on a gesture library, so
  that a sheet cannot be answered by a swipe and there is one implementation to keep in step with the
  tokens.
- On return to the foreground Hermie re-reads pending approvals and open requests and rebuilds the
  sheets before rendering the chat.
- Unsupported request kinds are answered with a "method not found" error immediately so the agent
  does not wait for a prompt the app cannot show.

## Amendment (R4): the sheet is how a question ARRIVES, not the only way to answer it

The sheet stands. Its whole argument is about arrival: a question that holds the agent's turn has to
reach the reader wherever they are, and a card in a transcript they may have scrolled a thousand
rows away from does not. Nothing about that has changed, and neither has anything about the guard,
the explicit buttons, or the rule that only a tap answers.

What the sheet cannot do is serve the reader who is **already looking at the call**. They have
scrolled to the card, read the arguments, and decided — and for them the sheet is a second surface
asking something they have finished thinking about, with a tap guard in front of it.

So the request card in the transcript now draws the choices itself, and `ToolCard` can draw them
too. Three rules keep the surfaces honest:

- **The buttons are exactly the server's `choices`, in the server's order**, everywhere. That was
  already the first rule of the sheet's own file and it is now enforced in three places by one set
  of tests.
- **Both surfaces read the same request store**, so an answer given on either resolves the same
  request. There is no second copy of "which question is open" to fall out of step.
- **An inline answer takes the sheet down**, rather than leaving it up to report what the reader
  has just done — the same argument the sheet already made when it stopped waiting for the RPC.

A **clarify** keeps the sheet and only the sheet. It can be several questions, some of them free
text, and a stepper does not belong on a transcript row.

One limitation is the gateway's and is worked around rather than fixed: an approval names a **tool**
and carries no tool-call id, so nothing in the transcript can say with certainty which card a
question belongs to. The host decides, on the tool's name and on the card not having finished, and
two concurrent calls to the same tool would draw the question twice — the same question, not the
wrong one, and answering either answers it. `ToolCard` therefore takes the question as a PROP and
never looks one up.

### What is verified

`expo/hermie/__tests__/inline-approvals.test.tsx`: the choices drawn are the server's and in its
order on both surfaces, a tap reports the choice verbatim, a card with no question draws nothing, a
collapsed card still shows the question rather than folding it away, an answer given on the
transcript card reaches the controller, and the sheet goes down with it.

**Not verified by a test:** the two-cards-one-name case above, which needs a gateway running two
calls to the same tool at once.
