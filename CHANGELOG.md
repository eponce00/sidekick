# Changelog

## Unreleased

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
