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
| Optional integrations            | External browser profiles, WebMCP, page assets, file chooser/export APIs | Not full parity; these remain separate additions, not implemented by embedding the page                                           |

## Implementation

Owned isolated pages now live in WebContentsViews. A main-process registry reparents the exact
view into the trusted application window using bounded panel coordinates. No reload, cookie copy,
renderer preload, or replacement page is involved. Hidden panels and closed application windows
detach views back to their rendering host. The rendering host is hidden while embedded; background
rendering retains a non-focusable host because Chromium screenshots require a live compositor.
The macOS background host uses near-zero opacity to avoid a visibly relocated window. An explicit
human takeover without a mounted panel can still use the existing fallback window.

The renderer polls small tab/control metadata, not screenshots or AX trees. Live page painting
happens directly in Chromium. Main-process-owned IDs select the view; renderer-supplied arbitrary
WebContents IDs are never accepted. Browser content has no SideKick preload or Node integration.

Manual input claims a conversation-scoped user-control flag when an agent action is not executing.
The active action completes atomically; new agent browser actions wait while the user edits.
Programmatic tool gestures are marked separately so they do not trigger user takeover. Resuming
invalidates semantic refs. Existing CAPTCHA reservations remain independent and must still be
completed through their existing interaction card. Useful pages remain available across turns.

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

- Windows: 803 tests passed, 22 skipped; coverage thresholds passed.
- TypeScript, ESLint, production build, documentation check and all 23 release-contract tests passed.
  Release-contract tests require Node 24.18.0 (the system terminal's 24.13.0 does not qualify).
- Both Electron desktop E2E tests passed. Native Windows window capture visually confirmed the
  embedded page and editable field. `BrowserWindow.capturePage()` alone omits the child view and
  must not be used as proof that the embedded webpage is blank.
- Native browser smoke passed for both the local fixture and the remote USCIS G-28 PDF:
  four pages, 101 fields, form fill and save, semantic actions, screenshots, tabs and handoff.
- macOS placement uses the same view-parenting path but still needs an actual macOS test;
  Windows success is not evidence of macOS window-manager behavior.
