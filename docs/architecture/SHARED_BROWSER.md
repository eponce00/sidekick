# Shared browser workspace

Date: 2026-09-05

## What was wrong

The Browser panel displayed an image captured after agent actions. It could not receive native
mouse, keyboard, selection, or scroll input. The actual page belonged to a separate BrowserWindow
parked at negative screen coordinates, an approach that can expose a second window on macOS.

## Comparison with Codex

The comparison uses the Codex in-app browser's publicly exposed tool documentation, read through
the active `cua` browser interface on 2026-09-05. It does not assume access to Codex's private
implementation. The official [features documentation](https://learn.chatgpt.com/docs/features)
is product context; the actual runtime capability descriptions are the more detailed source.

| Capability                       | Codex exposed interface                                                  | SideKick                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Shared visible page              | In-app tabs, visibility, user handoff                                    | Actual WebContentsView embedded in the workspace; same page for the user and agent                                                |
| Navigation and tabs              | Open, back, forward, reload, list, select, close                         | Agent tools plus user address bar and tab strip; user can open a session without an agent run                                     |
| Semantics                        | AX state/diffs and Playwright locators                                   | AX refs, selectors and accessible-name targets; compact bounded observations                                                      |
| Vision                           | Screenshots and coordinate actions                                       | Existing viewport/full-page/element images, real vision attachments and stale-image checks                                        |
| Form workflows                   | Fill, select, check, keyboard, batched REPL calls                        | Existing verified form batches and individual actions, including PDF form controls                                                |
| User handoff                     | Browser-control interruption and handoff                                 | Direct native input claims control; browser tool calls wait for Resume agent, remain cancellable, then stale refs are invalidated |
| Diagnostics                      | Console, optional CDP                                                    | Existing console and failed-network tools, read-only page evaluation                                                              |
| General programmable browser API | Persistent REPL and locator composition                                  | Typed tool calls; no equivalent general browser REPL in this release                                                              |
| Optional integrations            | External browser profiles, WebMCP, page assets, file chooser/export APIs | WebMCP tools are listed and called through Chromium ([WebMCP](WEBMCP.md)); the others remain separate additions                   |

## Implementation

Owned isolated pages now live in WebContentsViews. A main-process registry reparents the exact
view into the trusted application window using bounded panel coordinates. No reload, cookie copy,
renderer preload, or replacement page is involved. Hidden panels and closed application windows
detach views back to their rendering host. The rendering host is hidden while embedded; background
rendering retains a non-focusable host because Chromium screenshots require a live compositor.
The macOS background host uses near-zero opacity to avoid a visibly relocated window.

The renderer polls small tab/control metadata, not screenshots or AX trees. Live page painting
happens directly in Chromium. Main-process-owned IDs select the view; renderer-supplied arbitrary
WebContents IDs are never accepted. Browser content has no SideKick preload or Node integration.

Manual input claims a conversation-scoped user-control flag when an agent action is not executing.
The active action completes atomically; new agent browser actions wait while the user edits.
Programmatic tool gestures are marked separately so they do not count as the user's input.
Resuming invalidates semantic refs. A human check is cleared the same way: `browser_request_human`
holds the session, marks the run `awaiting_user`, opens the panel on the page, and polls until the
check is gone, with no card. Useful pages remain available across turns.

## Annotations

The user marks places on a page for the agent, as in the Codex in-app browser's annotation mode,
Cursor's element picker and Claude Code's preview element selection: a toolbar toggle, click an
element or drag an area, a note per mark, numbered marks that go with the next message.
[The user guide](../user-guide/BROWSER.md#pointing-at-the-page) describes the behavior.

The page is untrusted, so nothing about a mark involves the page's own JavaScript:

- **Input and drawing.** While annotating, `browserAnnotationOverlay.ts` raises a transparent
  WebContentsView of SideKick's own over the page view, at its exact bounds, like the agent's
  cursor view. It loads `annotation-overlay.html`, a React page of the app's
  (`src/renderer/src/annotationOverlay`), in its own partition, sandboxed, with a preload of two
  calls: the state to draw, and what the user did. Every message is checked by
  `parseAnnotationOverlayMessage` (`src/shared/annotationOverlay.ts`) before the controller sees
  it, and positions are converted between the overlay's pixels, at the app's zoom, and the
  window's. The overlay draws the marks, the hover outline, the floating comment field and the
  bar. The page receives no events while it is covered; the wheel is replayed to the page through
  CDP `Input.dispatchMouseEvent` as the user's own input, subject to the same user-control check as
  a click.
- **Style editor.** The only change a mark makes to the page. `CSS.getComputedStyleForNode` reads
  the element's styles for the editor; each change rewrites its `style` attribute with
  `DOM.setAttributeValue` over the attribute it had, which **Reset** puts back. Only the listed
  properties are offered, and a value with anything beyond CSS words, numbers and colors (a `;`,
  a brace, `url(`) is refused.
- **Dictation.** The overlay never has the microphone. Its mic button asks the controller, which
  tells the app window (`dictate` on `agentRuns:browserAnnotationsChanged`); the window runs its
  usual on-device dictation and returns each piece of text with `annotationDictation`, which the
  controller hands to the overlay for the open note.
- **Facts.** `browserAnnotationCapture.ts` uses CDP only. `DOM.getNodeForLocation` finds what a
  click would reach, so a layer with `pointer-events: none` cannot take the mark;
  `DOM.getDocument` with `pierce` gives the tree through shadow roots and same-process frames for
  the selector (`>>` enters a shadow root or frame) and the text; `Accessibility.getPartialAXTree`
  gives the role and name. No `value` is read, from the accessibility tree or the DOM. Text skips
  fields, lists, editable areas, hidden elements and scripts, and a name built from content that
  holds a field falls back to the element's `aria-label`.
- **Picture.** `Page.captureScreenshot` with a clip around the mark, in CSS pixels at twice their
  size (the clip's scale is divided by the device pixel ratio Chromium multiplies it by). Before it
  leaves the function, every text field, list, editable area, and frame or plugin whose document
  is in another process is covered, and the mark is outlined, in greys only so the bitmap's channel
  order does not matter. No picture is taken while a stored sign-in's password shows as text.

`BrowserAnnotationController` keeps marks per conversation in the main process only, numbered in
order and renumbered when one is removed, at most `MAX_BROWSER_ANNOTATIONS`. Element marks follow
their node's box as the page changes; area marks are kept in document coordinates. A mark whose
tab changed while it was read is dropped. The panel gets them without pictures in its workspace
state; `agentRuns:browserAnnotations` lists them for the composer and hands them over (`take`)
when a message is sent, and `agentRuns:browserAnnotationsChanged` tells the window to refresh, to
send when the user chose **Send** on the page, or to listen for a note. A screenshot is an area mark
of the whole view.

A sent mark is a `browser` message context attachment (`src/shared/messageContextAttachments.ts`),
validated with the rest, its picture checked to be the PNG or JPEG it claims. `providerMessage`
appends the pictures after the message's own images, so every provider receives them as image
input under its usual image budget, and adds a `<sidekick_browser_annotations>` block that marks
the note as the user's and everything else as page data, with page strings quoted on one line and
closing tags broken up. A model without vision gets the block without pictures. The phone receives
the marks without their pictures, which come with the message's reduced images.

## Find in page

Electron's `findInPage` reports nothing for a page in a WebContentsView, so `browserPageFind.ts`
searches through CDP in an isolated world (`Page.createIsolatedWorld`) that shares only the document
with page scripts. It walks visible text, marks matches with the CSS Custom Highlight API, the
selected one under its own name, and scrolls it into view; an empty search removes the highlights
and their style element. The world is remade after a navigation.

## Verification

- Real Electron: mount the original page into an app window, agent types, native input edits,
  agent reads the manual edit, embedded takeover, detach and background screenshot, clean close.
- Desktop E2E: user creates a chat and opens a URL via the address bar; verifies a child page in
  the main window, only one visible window, shared control, resume, and access to Settings.
- Manager regressions: user control waits without a replacement session, active action exclusion,
  and cancellation while waiting.
- Existing semantic, form, PDF fill/save, screenshot, tab, popup and session-isolation smoke checks.

These checks do not measure model TTFT or prove complete Codex feature parity. The live panel
removes screenshot refresh as the user's display mechanism; inference latency remains separate.

### Local verification results (2026-09-05)

- Windows: 804 tests passed, 22 skipped; coverage thresholds passed.
- TypeScript, ESLint, production build, documentation check and all 23 release-contract tests passed.
  Release-contract tests require Node 24.18.0 (the system terminal's 24.13.0 does not qualify).
- Both Electron desktop E2E tests passed. Native Windows window capture visually confirmed the
  embedded page and editable field. `BrowserWindow.capturePage()` alone omits the child view and
  must not be used as proof that the embedded webpage is blank.
- Native browser smoke passed for both the local fixture and the remote USCIS G-28 PDF:
  four pages, 101 fields, form fill and save, semantic actions, screenshots, tabs and handoff.
- macOS placement uses the same view-parenting path but still needs an actual macOS test;
  Windows success is not evidence of macOS window-manager behavior.
- Windows 0.7.0 installer built locally (not published or installed). Packaged resource validation
  and startup smoke passed. The installer is unsigned; SHA-256:
  `D8115A5AD722F7A0BCB000DF229AF44737F3A98FE8F7DD8B2EA496A2B08694B2`.
