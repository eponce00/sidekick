# Changelog

## 0.7.8 — 2026-09-24

- Keep typing fast in long conversations. Each keystroke used to re-render every message, rebuild
  the syntax highlighter, and ask the main process to re-read the conversation's latest run, up to
  10,000 events per key. A key now reaches the screen as quickly as in a new chat, and links in
  earlier replies no longer flicker while typing.
- Mount a long run's latest 30 steps and load earlier ones on request, and refresh a very long live
  run less often, so the app stays responsive the longer the agent works.
- Let the model iterate on an artifact from its real code. Replayed history restores the current
  version of each artifact whole and marks it as current, instead of a cut preview that broke the
  next edit, and superseded versions point to it.
- Offer `create_artifact` in every run that allows artifacts, so a follow-up turn can change an
  artifact without reloading its skill and the tool list stays stable for the provider's cache.
- Show one version of each artifact per reply, and a failed artifact as a single line with its error
  instead of its full code.
- Keep a goal when its first message is retried, and drop an unfinished goal when the conversation is
  rewound past it.
- Announce a goal's completion once, so a retry or rewind no longer brings back an old
  "Goal complete" under an unrelated reply.
- Capture whole artifacts during inspection and report when one is taller than the chat's frame.

## 0.7.7 — 2026-09-23

- Let the model see the artifact it made. `create_artifact` now renders the artifact the way the
  chat shows it, in an offscreen window that is never shown, and reports whether it rendered, any
  runtime errors, and, for models that accept images, a screenshot taken after its data loads. A
  broken or unfinished render is a failed call, and the model's own code is no longer echoed back.
- Start a goal from the composer instead of a dialog. **Ongoing goal** arms the next message, which
  becomes the objective; a dismissible row says so. A running goal shows pause or resume and drop.
- Report a finished goal in the conversation as one quiet line with its verification folded
  beneath, and clear it from the composer, since the next message is not part of it.
- Close a goal cleanly. Changed project files are verified before completion is accepted rather than
  after it, tool calls after completion are refused without running, and a repeated completion is
  answered as already done instead of as an internal error.
- Require goal verification to describe only what was observed in the run, and say plainly what
  could not be checked.
- Read JSON, plain-text, CSV, and Markdown responses with `web_fetch` as the data itself, and report
  a page that cannot be read as a failed call rather than a success.
- Keep the prompt-sharpen button beside the text instead of over a mode banner, and show its result
  in the toolbar so the prompt keeps its full width.

## 0.7.6 — 2026-09-22

- Match the embedded browser to the application's own zoom instead of Chromium's per-origin scale,
  and re-apply it on every navigation so a followed link cannot reset it.
- Allow forking any earlier message while a run is active; only the message the run is currently
  writing stays locked.
- Recover from provider limits instead of failing the turn: learn a provider's image budget when it
  refuses even one image and retry without them, and adopt a provider's reported context window over
  a stale local setting that was triggering compaction a single token early.
- Show dot-prefixed files and folders in the file tree and to the agent, skipping only genuinely
  uninteresting paths, so projects no longer appear empty.
- Open the conversation that raised a completion notification when that notification is clicked.
- Put the renderer on its design tokens: type scale, spacing, focus rings, visible full-height
  scrollbars, and accent palettes that meet the contrast bar in both themes.
- Size markdown headings in messages from the application's scale rather than inheriting browser
  defaults, and reserve font weight for hierarchy instead of every sidebar row.
- Open a file the agent references in the workspace panel, with markdown rendered, code highlighted
  with line numbers, and images shown.
- Show a link with its own site's icon and domain. Icons are fetched only from the linked site
  itself, never a third-party favicon service, and never for local or private hosts.
- Answer an agent's question by choosing rather than by toggling and confirming. Several questions
  ride in one card and advance as each is answered, a written answer is sent from the field it is
  typed in, and the resolved card lists what was answered.
- Update vitest to 4.1.11, which closes two moderate advisories in vitest and @vitest/mocker.

## 0.7.5 — 2026-09-17

- Keep long visual and research runs responsive by batching renderer projections, compacting legacy
  browser receipts, omitting historical inline image payloads, and enforcing one global two-image
  provider budget across uploads, search results, and browser captures.
- Pass the top web-image result to vision-capable models without embedding base64 data in tool text,
  and prevent LiteLLM requests from exceeding common per-prompt image limits.
- Replace premature mutation-churn stops with progressive repeated-call and state-revisit guidance,
  while preserving hard limits for genuine repeated failures and failed turns.
- Select model-compatible edit, write, delete, search/replace, or patch contracts and improve stale
  read, no-op mutation, malformed tool-call, transport, and provider error recovery.
- Add multi-turn comprehensive and SVG agent evals covering scoped file reads, localized edits, new
  files, deletion, commands, web/image search, browser inspection, visual feedback, and cleanup.
- Simplify provider settings to one responsive **Test connection** action, remove synthetic
  capability probes from the UI, and fix the narrow-panel CSS collision that compressed controls.
- Refresh the public application screenshots and expand architecture, search, tools, testing, and
  prompt/context documentation for the current runtime behavior.

## 0.7.1 — 2026-09-07

- Download stable updates in the background from the canonical GitHub release and verify their
  SHA-256 checksums before offering installation. Show progress, retry, and manual release fallback.
- Add **Restart and update** on Windows and Apple Silicon macOS, with confirmation and graceful
  session shutdown. Only the app restarts, never the computer. System security prompts remain.
- Keep the previous Mac app bundle for filesystem recovery; validate the new bundle identity,
  version and signature structure before replacement. Unwritable/translocated installs use the
  manual fallback. Linux downloads a verified AppImage for manual replacement.
- Restrict install requests to the app main frame and recover the current app if installer launch
  fails after shutdown. Never change Gatekeeper, quarantine or system-wide security settings.
- Existing 0.7.0 installations need one manual upgrade to obtain the updater. Real installed
  upgrade and macOS permission-prompt qualification remain separate from automated package tests.

## 0.7.0 — 2026-09-06

- Replace the screenshot-only browser panel with the actual embedded Chromium page shared by user
  and agent, preserving tab identity, cookies, form state, and PDF support.
- Add an address bar, back/forward/reload, tab creation/switching/closing, direct native input,
  and text-edit context menus. Users can open pages without first running an agent.
- Let the agent resume ordinary browsing automatically after manual interaction, without a
  persistent takeover button; invalidate old semantic targets after manual changes.
- Keep human takeover inside the visible Browser panel, hide the rendering host while embedded,
  and detach native pages when the panel is hidden or an application dialog is shown.
- Add cross-platform Electron checks for embedded page ownership, one visible application window,
  shared manual edits, handoff, and continued screenshot/PDF behavior.
- Preserve browser resource ownership across cancellation and late tab creation, and recheck
  context-menu authorization before actions execute.
- Verify PDF saved field values and appearances before publication, preserve source forms,
  and strengthen safe file publication and interrupted-run recovery.
- Add opt-in configured Office helper tools, bundled helper validation and safer process cleanup.
- Improve tool error feedback, queued argument stability, provider diagnostics and release tests.
- Explicitly request ad-hoc signing for community macOS builds; notarization remains unavailable.
- Keep new browser tabs open when compositor screenshots are temporarily unavailable.
- Respect Full access for external image reads, and improve exact patch format recovery.
- Use a compact two-row browser toolbar and clip embedded views safely during resize and zoom.

## 0.6.3 — 2026-09-04

- Route direct HTTPS PDF URLs through SideKick's accessible PDF viewer instead of Chromium's
  opaque, blank embedded plugin surface.
- Fetch remote PDFs through the browser tab's isolated network session, retain the original URL in
  agent-visible history, validate PDF signatures, bound downloads to 64 MiB, and remove temporary
  source files when the browser tab closes.
- Save filled copies of remote forms to the user's Downloads folder with safe collision-resistant
  names; local PDFs continue to save beside their source without overwriting it.
- Add an exact real-Electron USCIS G-28 regression that verifies four rendered pages, 101 semantic
  form controls, browser-native field entry, and a valid saved PDF copy.

## 0.6.2 — 2026-09-04

- Added bounded press-and-hold support for ordinary browser controls with guaranteed mouse release.
- Added durable same-session human takeover for CAPTCHA and anti-bot checkpoints, including exact
  session reservation, trusted-origin window chrome, popup containment, cancellation cleanup, and
  fresh post-takeover verification.
- Prevented automated click, hold, typing, selection, form filling, keyboard, hover, and evaluation
  paths from acting on a detected anti-bot challenge while recognizing completed provider widgets.
- Replaced Chromium's opaque local-PDF plugin surface with a token-scoped PDF.js viewer whose
  rendered pages, document text, and AcroForm controls are visible to the browser agent.
- Added verified browser-native PDF form filling and safe sibling-copy saving without overwriting
  the source document.
- Fixed packaged skill-helper discovery, injected a stable `SIDEKICK_SKILLS` command environment,
  and corrected the PDF, DOCX, PPTX, and XLSX helper examples to use the shipped executable files.

## 0.6.1 — 2026-09-03

SideKick 0.6.1 hardens and accelerates the native browser workflow introduced in 0.6.0.

- Added verified batched form filling for standard controls with redacted values, safe continuation
  across independent field failures, explicit partial-completion recovery, and page-change stops.
- Reduced repeated model input with compact routine browser observations, prioritized actionable
  controls, collapsed select-option inventories, bounded accessibility lines, and compact legacy
  browser history reconstruction.
- Strengthened semantic target uniqueness, role-aware targeting, select retention checks, text-focus
  ownership, screenshot-coordinate scaling, and stale-image rejection.
- Made recovery accounting progress-aware, kept internal tool-guard hints out of the chat timeline,
  reduced repetitive browser narration, and recorded canonical tool execution timing.
- Refreshed vulnerable transitive dependencies and restored a zero-finding production dependency
  audit.

## 0.6.0 — 2026-08-30

SideKick 0.6.0 is a broad agent-runtime and desktop-experience release focused on reliable long
runs, visual UI work, and a calmer interface.

- Rebuilt tool execution around a typed handler registry and canonical pipeline with safe parallel
  reads, ordered mutations, retained output handles, bounded loop recovery, and no execution from
  provider responses whose tool-call batch was truncated.
- Added durable prompt admission and steering, reconnectable run snapshots, ordered live-event
  merging, and history-positioned context-compaction records so text, thinking, and tools render in
  the same order in which the model produced them.
- Added a native isolated Chromium browser with accessible observation, screenshots, clicking,
  typing, selection, scrolling, hover, tabs, responsive viewport control, console/network review,
  verification, and a docked live Browser panel with a visible cursor.
- Redesigned tool, approval, command, diff, file-change, thinking, and verification presentation.
  Collapsed cards stay compact; expanded cards expose detail; approval cards settle immediately;
  and additions/deletions use readable semantic color.
- Added clipboard image paste, image lightboxes, file and folder context attachments, open-with
  actions, clickable file references, and a compact composer menu organized by attachment, project
  context, and agent behavior.
- Added per-message conversation forking, managed worktree lifecycle, pinned projects and chats,
  clearer recovery titles, automatic conversation titles, formatted token counts, and queued-message
  send/steer behavior.
- Replaced the settings dialog with a searchable full-window settings workspace, added reliable app
  zoom controls, and made Full access the default permission mode while preserving audited safety
  classification and stricter opt-in modes.
- Removed the redundant trajectory/tasks navigation surface, simplified user-facing browser status,
  and improved narrow viewport, image containment, scrolling, and responsive panel behavior.
- Expanded deterministic coverage for the agent protocol, browser tools, permission classification,
  event projection, streaming UI, attachments, worktrees, title generation, packaged runtime, and
  release contracts.

## 0.5.1 — 2026-07-24

- Keep the Linux package filename aligned with the exact public `linux-x64` artifact contract.

## 0.5.0 — 2026-07-24

- Keep generated artifacts visible as durable chat output instead of hiding them inside the
  collapsed work disclosure.
- Bound React and HTML artifact previews to a scrollable viewport and remove the iframe sizing
  feedback loop that could make a conversation grow indefinitely.
- Add a Linux x64 AppImage with a static runtime, canonical desktop/icon identity, packaged-content
  audit, extracted-image validation, real AppImage launch smoke, checksums, and provenance.
- Run the real-Electron journey and unpacked package smoke on Linux CI alongside macOS and Windows,
  and enable the stable GitHub release checker for packaged Linux builds.
- Restore or recreate the main window when an already-running macOS app is activated after its last
  window was closed.

## 0.4.2 — 2026-07-24

- Normalized text assets to LF across operating systems and made the vector-master hash insensitive
  to checkout line endings while keeping every binary icon derivative byte-exact.
- Promoted release-contract tests into ordinary macOS and Windows CI so a tag cannot be the first
  place cross-platform release invariants run.

## 0.4.1 — 2026-07-24

- Replaced every inherited Electron application icon with the canonical SideKick robot artwork
  across macOS, Windows, notifications, windows, the Dock, and repository branding.
- Consolidated branding on one vector icon master with deterministic checked-in ICNS, ICO, and
  runtime PNG derivatives, avoiding release-time icon-tool downloads while tests reject retired
  Electron artwork and asset drift.
- Made macOS release filenames explicitly platform-qualified and added a platform/architecture
  download table to every generated GitHub Release.
- Documented Linux as the next zero-cost desktop target while keeping it outside the release
  contract until it has dedicated packaging, CI, smoke tests, and installation guidance.

## 0.4.0 — 2026-07-24

SideKick 0.4.0 establishes the permanent free/open-source distribution model, updates the entire
desktop runtime to Node.js 24 and Electron 43, and ships the latest agent, verification, Plan mode,
collaboration, UI, privacy, and release-hardening work as one community release.

### Development toolchain

- Standardized local development, CI, evaluation, and release builds on Node.js 24 LTS and npm 11,
  with one checked-in runtime version and fail-closed package-manager enforcement.
- Updated the Node.js type definitions to the supported runtime generation and removed the former
  Node.js 22 workflow pins.
- Upgraded the application runtime from end-of-life Electron 39 to supported Electron 43.2.0, so
  packaged builds embed the same Node.js 24.18.0 runtime used by development and CI.
- Materialized Electron 43's on-demand binary during the project postinstall step, keeping clean
  development and CI installs deterministic after Electron removed its dependency postinstall.
- Updated the packaging and native-addon rebuild toolchain for Electron 43's supported ABI.
- Upgraded the SQLite native driver to its Node-API-based release for current Electron and V8
  compatibility.
- Added a release invariant that fails when the checked-in, executing, and Electron-embedded Node.js
  versions diverge.
- Added a version-pinned allowlist for reviewed native and packaging dependency install scripts.

### Documentation and repository hardening

- Licensed SideKick under GPL-3.0-or-later and documented the upstream project's permanent
  no-subscription, no-advertising, and no-revenue commitment.
- Reorganized public documentation into canonical user, architecture, development, and roadmap
  sections; removed stale planning logs, duplicated test guides, and copied vendor references.
- Added private vulnerability reporting, a public security policy, documentation governance, and an
  automated quality gate for links, anchors, image labels, version drift, and machine-specific
  paths.
- Added a public privacy disclosure covering local retention, direct provider/search/connector data
  flows, deletion, and a metadata-only support export boundary.
- Added contribution guidance, structured bug and feature forms, a pull-request trust checklist, and
  repository enforcement for checked squash-only changes to `main`.

### Release hardening

- Locked the production application identity to `io.github.eponce00.sidekick` and made packaging,
  development, OAuth metadata, and runtime clients consume one canonical product identity.
- Replaced the paid-certificate release architecture with a permanent zero-cost community contract:
  ad-hoc signed macOS packages, an unsigned Windows installer, exact SHA-256 checksums, and public
  GitHub/Sigstore provenance attestations.
- Replaced automatic installer download/execution with a pinned GitHub release checker and explicit
  **View release** handoff, keeping unavoidable unsigned packages outside the application's
  execution authority.
- Added a free Microsoft Store MSIX direction for Windows, an F-Droid/direct-APK Android direction,
  and an installable-web-app iPhone/iPad direction without paid developer programs.
- Consolidated macOS packaging onto one zero-cost entitlement/signature path and exercised both the
  final ZIP and DMG applications through strict signature validation and real Electron launch
  smokes.
- Added a metadata-only in-app diagnostic export with adversarial tests proving that prompts,
  credentials, endpoints, paths, model names, tool data, and logs are excluded.
- Added a fail-closed temporary profile contract and a real-Electron release journey covering
  context isolation, chat persistence, settings, connector discovery, support UI, restart, and
  deletion on macOS and Windows CI.

### Verified Plan mode

- Added a kernel-enforced read-only Plan phase with manual composer selection and an agent-requested
  entry flow that always requires user approval.
- Added independently selectable planning and execution models with an atomic provider, prompt,
  tool-catalog, and context-budget handoff inside the same durable run.
- Added revisioned plan contracts with observable acceptance criteria, requirement-linked steps and
  checks, review/revision/keep controls, durable todos, and evidence-gated completion.
- Prevented workspace writes, commands, MCP calls, artifacts, collaboration writes, and child
  agents during planning even in Bypass mode.
- Extended the provider-neutral live model benchmark with a complete Plan → approval → edit →
  diagnostics/test → completion scenario.

### Verification-driven workspace intelligence

- Added lazy, project-aware language intelligence for common language ecosystems without bundling
  or downloading their toolchains.
- Added revision-bound diagnostic, command, build, test, and lint evidence with stale-result
  detection and a bounded completion guard for unverified workspace changes.
- Added a compact durable verification summary to agent messages and full deterministic coverage
  for lazy language servers, external changes, unsupported projects, and renderer recovery.

### Reliable workspace editing

- Replaced the legacy independent write/edit/delete implementations with one transactional,
  fail-closed workspace mutation engine shared by direct chats and project-agent chats.
- Added model-aware editing dialects for Codex-style canonical patches, Claude-style Edit/Write,
  Grok-style replacement, and a generic structured contract, all backed by the same trusted
  executor.
- Added strict path and symlink confinement, exact-context matching, no-op rejection, serialized
  concurrent writes, multi-file rollback, post-write verification, and bounded truthful tool
  results.
- Made file mutation activity visible while arguments are still streaming and report completion
  only after the main process verifies that the workspace actually changed.
- Added regression coverage for malformed patches, ambiguous replacements, stale concurrent edits,
  symlink escapes, no-op writes, dialect routing, and direct/group execution parity.

### Demand-loaded live artifacts

- Removed the full web-artifact builder manual and rendering tool from ordinary conversation
  requests. Models now discover the capability from lightweight skill metadata and load it only
  for the current run.
- Defined live artifacts as in-chat deliverables and routed websites, landing pages, apps,
  components, and HTML/CSS/JavaScript project work to workspace files without creating a duplicate
  artifact unless the user asks for both.

### Project-agent group chats

- Added persistent Slack-like group chats with two agents anchored to separate, non-overlapping
  SideKick projects.
- Added bounded missions with concurrent project-agent runs, shared messages, individual targeting,
  participant inspection, pause/resume/stop controls, restart recovery, and a flat shared timeline.
- Made addressing a wake-up policy rather than a visibility boundary: both agents receive every
  public channel message in canonical order at safe provider boundaries.
- Added a durable private session and transcript for each project agent, including assistant tool
  requests, tool results, recovery state, and checkpoint links across app restarts.
- Kept the public group timeline message-only and added two stacked Work/Files/History inspectors
  with a narrow-window drawer.
- Project each private agent session into its owning project as a normal chat row. Opening it now
  reuses the ordinary message, composer, tool, hover-action, Tasks, Files, and History UI instead
  of exposing a separate full-screen inspector; the Groups section stays focused on the shared room.
- Render peer updates as ordinary left-aligned chat messages with a quiet `From <agent>` label,
  preserving Markdown lists and emphasis instead of inheriting centered system-notice typography.
- Group every provider iteration in a project-agent run into one normal assistant loop, so its text,
  tool calls, continuations, copy action, and timestamp no longer appear as separate chat messages.
- Reuse the ordinary chat message renderer in the public group channel too, including matching
  Markdown, spacing, hover/focus actions, copy feedback, edit-and-resend, retry, timestamps, token
  hints, keyboard access, and touch-screen action visibility.
- Aligned private agent-chat scrolling, focus, edit sizing, activity navigation, and compact tool
  hints with normal chats, and kept human-only or differently targeted messages out of unrelated
  private agent histories.
- Keep automatic checkpoint-save notices out of chat transcripts; the checkpoint and change count
  remain available in the dedicated SideKick History view.
- Added a native, approval-free `wait` tool for direct agents, sub-agents, and project agents. Waits
  are capped at 200 seconds, render as one compact activity row, and cancel immediately with the run.
- Added prompt-based immediate titles, background model refinement, double-click rename, and
  explicit shared-group/remove actions for linked project-agent chats.
- Added a trusted main-process supervisor that loads each project's instructions independently and
  scopes file tools, commands, permission grants, and private SideKick History to that project.
- Made group tools honor the same three permission modes as direct chats: routine project-local work
  can proceed in agent-decides mode, sensitive/destructive work still requests approval, and bypass
  remains audited. Permission dialogs no longer expose internal execution UUIDs.
- Added one-run-per-project contention queues, atomic shared round limits, durable event delivery,
  safe archival, and project-removal guards.
- Added schema, store, supervisor, concurrency, lifecycle, and renderer-preview coverage.

## 0.3.0 — 2026-07-18

SideKick 0.3.0 replaces its remaining branded provider transports with one trusted,
provider-neutral runtime and makes production desktop releases fail closed on signing.

### Provider runtime

- Added a first-class LiteLLM provider with multiple named gateway instances, virtual-key
  authentication, alias/group discovery, optional rich metadata enrichment, and the shared
  OpenAI-compatible streaming transport.
- Added provider-reported context, output, tools, vision, reasoning, audio, and PDF capability
  metadata; unknown values stay explicit and safe manual overrides survive catalog refreshes.
- Made conversation tool availability and output-token ceilings honor explicit model metadata.
- Stopped presenting the internal 32K safety budget as a provider-reported maximum; unknown context
  now stays visibly unknown and percentage-based compaction claims remain disabled.
- Added native Anthropic Messages support with model discovery, SSE streaming, vision, tool use,
  adaptive/manual thinking, retry metadata, usage, and signed/redacted thinking continuity.
- Moved provider endpoint resolution and decrypted credentials entirely into the Electron main
  process; the renderer now receives only credential-presence markers.
- Replaced Ollama, OpenRouter, and LM Studio preload surfaces with one typed `providers:*` contract
  for discovery, context, completion, streaming, cancellation, and generation statistics.
- Normalized fragmented OpenAI SSE, Ollama NDJSON, Anthropic events, reasoning output, tool JSON,
  usage, errors, retries, and local-server empty-stream recovery.
- Made file/artifact activity visible from the start of tool-input streaming and safely recover from
  malformed or truncated tool JSON without executing partial writes.
- Routed message and artifact copying through the trusted Electron clipboard bridge so copying works
  with renderer permissions locked down.
- Added OpenAI-compatible multimodal message conversion and capability-driven vision behavior.
- Preserved native tool-call/thinking state through conversation, research, and sub-agent loops.
- Validated discovery, non-streaming completion, and real streaming against LM Studio at
  `127.0.0.1:1234` with `qwen/qwen3.5-9b`.

### Security and delivery

- Kept encrypted provider secrets out of renderer settings and normal provider requests.
- Isolated concurrent streams by renderer window and request id, including replacement/abort races.
- Enabled Windows Authenticode signing and strict signature verification for tagged builds.
- Enabled hardened-runtime Developer ID signing, app and DMG notarization/stapling, Gatekeeper
  assessment, and strict verification for tagged macOS builds.
- Kept manual release-workflow runs usable for unsigned inspection while preventing a production
  tag from publishing when any signing/notarization secret is absent.

### Tests

- Added deterministic integration fixtures for fragmented OpenAI, Anthropic, and Ollama streams;
  thinking signatures; partial tool JSON; multimodal conversion; usage; retries; embedded stream
  errors; fallback failures; and IPC cancellation ownership.
- Added direct create/edit handler coverage plus incomplete-tool recovery and failed-stream UI
  finalization tests.
- Expanded the opt-in real-provider fixture to exercise the production streaming parser.

## 0.2.0 — 2026-07-18

SideKick 0.2.0 is the first complete local-first desktop release for macOS arm64 and Windows x64.

### Highlights

- Added folder-backed projects, standalone conversations, project instructions, memory, checkpoints, conversation recovery, and a flatter Codex-style navigation model.
- Rebuilt provider settings around multiple named instances with searchable model inventories for Ollama, Ollama Cloud, LM Studio, llama.cpp, OpenRouter, and generic OpenAI-compatible servers.
- Replaced the external SearXNG dependency with embedded, keyless SideKick Search and in-app
  page/image extraction.
- Unified command, workspace, browser, MCP, checkpoint, and sub-agent authorization behind three audited permission modes.
- Redesigned prompt composition, trust boundaries, immutable context projection, durable incremental compaction, and complete request budgeting.
- Decomposed the conversation run loop and research coordinator into typed, dependency-injected services with recovery and composition tests.
- Unified every non-streaming model task behind a provider-neutral utility completion layer with normalized errors, retries, token usage, tool calls, and reasoning output.
- Added Windows portable/installer and macOS DMG/ZIP release pipelines with packaged launch smoke tests.

### Compatibility and reliability

- Normalized OpenAI-compatible `reasoning`, `reasoning_content`, and `<think>` output.
- Disabled reasoning for bounded utility tasks where supported so small title/extraction budgets produce usable content on modern reasoning models.
- Validated the production OpenAI-compatible client against a live LM Studio server at `127.0.0.1:1234`.
- Expanded automated coverage for permissions, providers, prompt/context safety, compaction, run recovery, research phases, embedded search, and packaged delivery.

### Distribution note

The automated artifacts are suitable for testing and personal installation. Public distribution without operating-system warnings still requires production Windows signing and Apple Developer ID signing/notarization credentials.
