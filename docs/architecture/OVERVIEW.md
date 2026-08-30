# SideKick architecture

SideKick is split into four process-aware layers. Dependencies point inward toward shared contracts:

```text
main ─────┐
preload ──┼──> shared
renderer ─┘
```

## Layer responsibilities

- `src/shared`: serializable contracts and pure policy. It must not import Electron, Node runtime modules, or process-specific code.
- `src/main`: trusted desktop runtime. `bootstrap` owns startup infrastructure, `ipc` adapts renderer requests, `services` owns durable capabilities, and `utils` contains main-only pure helpers.
- `src/preload`: the narrow context-isolated bridge. `api.d.ts` is the public renderer contract and `index.ts` must satisfy it at compile time.
- `src/renderer`: untrusted React UI and event projection. It submits run intents through `window.api`; it never executes an agent tool or provider stream.

ESLint enforces these dependency directions. New cross-process values should be defined in `src/shared` and exposed through the preload contract rather than imported from another process layer.

## Main-process startup

`src/main/index.ts` is intentionally a composition root. Focused bootstrap modules own artifact protocol registration, database schema/migrations, the hardened main window, and workspace initialization. IPC registration happens only after the store and database are ready.

Development Electron launches use a separate `sidekick-dev` user-data directory and application name.
This prevents an unsigned/dev Electron process from requesting access to the packaged app's macOS
Safe Storage key or mutating its production settings and database.

## Platform window chrome

Window controls follow the host platform instead of forcing one convention everywhere.
`mainWindowChrome` keeps SideKick's frameless right-aligned minimize/maximize/close controls on
Windows and Linux. On macOS, Electron owns a native hidden-inset title bar with the system traffic
lights on the leading edge. The green control therefore uses native Spaces full screen, zoom, and
the system tiling menu; red/yellow retain standard close and Dock-minimize behavior. The custom
SideKick toolbar remains draggable and reserves the title-bar safe area reported by Electron so it
cannot overlap the traffic lights.

The preload exposes only a serializable `DesktopPlatform` value. The renderer uses it for layout
and visibility, while the trusted main process owns frame/full-screen behavior. No renderer button
attempts to imitate macOS window management. Windows keeps SideKick's caption buttons, publishes
truthful maximize/restore state, and exposes the expected title-bar menu on right-click and
`Alt+Space`.

The application menu uses native roles instead of Electron's development defaults. macOS includes
About, Services, Hide, Quit, Edit, Full Screen, and Window behavior; Windows exposes a normally
hidden File/Edit/View/Window menu. Typed app-command events implement New Chat, Open Project, and
Settings shortcuts without giving the renderer menu authority. Window state is stored only after
validation and is restored only onto a connected display.

Text context menus, spellcheck language selection, native notifications, dialog focus behavior,
and the physical release matrix are specified in [Desktop integration](DESKTOP_INTEGRATION.md).

## Security boundary

The renderer is treated as potentially compromised. Commands, workspace mutations, MCP calls, checkpoint restoration, sensitive settings, navigation, shell integration, and external URLs are validated or authorized in the main process. Renderer-side confirmation is usability, not authority.

## Workspace mutation engine

Direct chats and project-agent chats share one trusted mutation contract from
`src/shared/workspaceMutations.ts` and one main-process executor in
`src/main/services/workspaceMutationService.ts`. The executor resolves every path against the
authorized project root, rejects symlink escapes and malformed requests, previews the complete
change set, serializes concurrent writes per workspace, snapshots every affected file, verifies the
post-write bytes, and rolls back the transaction if any operation fails. Missing or ambiguous
replacement text, stale context, no-op changes, and partial multi-file patches are failures; they are
never reported to a model as successful edits.

`src/shared/agentToolDefinitions.ts` is the single workspace-tool registry. A model receives one
editing dialect selected from provider/model identity: canonical `apply_patch` for Codex-style
models, `Edit`/`Write` for Claude-style models, search-and-replace for Grok-style models, or the
generic structured editing contract. Dialects are adapters over the same mutation request and do
not create separate execution paths. Read, list, and search tools are shared across every dialect.

Canonical patches use the `*** Begin Patch` / `*** End Patch` grammar with explicit Add, Update,
Delete, and optional Move directives. Unified diffs, bare `+`/`-` text, legacy marker formats,
truncated patches, and patches with non-unique context fail closed. `AgentToolRuntime` requires
same-run version receipts for every existing target, the kernel resolves permission policy, and the
transactional mutation service commits only after validating the complete plan. Model results
contain a bounded truthful diff summary; the UI starts the activity row as soon as tool input
streams and only shows success after `ok` and `changed` are both true.

The same canonical path resolver protects reads, searches, shell-open actions, direct mutations,
and collaboration project access. It rejects lexical traversal and symlink escapes; mutation paths
also reject internal symlink aliases so snapshots and rollback always refer to one concrete file.
Recursive search and listing never follow symlink entries.

Each configured model exposes exactly one editing contract. Automatic selection uses the upstream
model identity when a gateway such as LiteLLM reports it. Opaque aliases can run active,
long-context localized-edit, multi-match replacement, and complete-write probes across every
dialect; successful results are persisted against the exact provider/model/upstream identity.
Exact-edit contracts require an explicit `replace_all` boolean so replacement scope is never an
implicit default. Ambiguous matches fail closed with a typed failure, bounded match-start lines,
and a concrete correction rather than a generic conflict.

After two production mutation-schema failures—or two identical ambiguous exact edits—the kernel
can switch at a safe provider boundary to a probe-verified fallback, promote it for future runs,
and continue the same transcript. This lets a model that cannot reliably express exact-edit scope
move to canonical `apply_patch` instead of exhausting the generic loop guard. A manually pinned
contract is never overridden. Shell commands remain an escape hatch for generated output,
formatters, and broad mechanical transformations, not the ordinary code-editing path.

## Tool validation and recovery

`AgentToolRegistry` normalizes only unambiguous syntax differences, validates the complete recursive
schema before permission prompts or side effects, and returns every missing or invalid field in one
model-visible result. MCP schemas pass through the same portable schema normalizer, including local
reference resolution. Malformed provider JSON becomes an ordinary failed tool result with the
original call identity; it never aborts the provider loop by itself.

Errors separate retry permission from the required recovery action: `correct_input`,
`refresh_state`, `retry_later`, `change_strategy`, or `stop`. The run-scoped
`AgentToolRecoveryController` independently fingerprints canonical tool arguments and results. It
warns and ultimately stops identical failures, same-tool argument churn, identical read-only output,
and consecutive all-failed tool turns. A successful call clears the relevant failure state. This
applies in the shared kernel, so direct, group, child-agent, and research runs cannot diverge.
Terminal guard messages summarize the concrete failing tools, missing fields, and call counts so
the user sees the cause instead of only a generic loop-limit notice.

Workspace search accepts either a file or directory scope. Invalid regular expressions, nonexistent
paths, and schema mistakes return actionable `invalid_arguments` results instead of leaking raw
filesystem errors such as `ENOTDIR`.

## Verification and language intelligence

Workspace verification is language-neutral and revision-based. `WorkspaceVerificationService`
assigns a durable revision to every successful transactional mutation and to conservatively
classified shell mutations. Real foreground test, build, typecheck, lint, and check commands store
structured evidence against the exact revision, changed paths, result, exit code, command, cwd,
timestamps, and a bounded content fingerprint. A later SideKick edit advances the revision; an
external edit to a covered path changes the fingerprint. Either condition makes older evidence
stale, so a completion claim cannot reuse a check that predates the current files.

`LanguageIntelligenceService` is an optional accelerator over that ledger, not a prerequisite for
editing. Its JSON-RPC client and server recipe registry are separate: one protocol implementation
supports TypeScript/JavaScript, Python, Go, Rust, C/C++, C#, Java, Kotlin, Ruby, PHP, Swift, Dart,
Elixir, Lua, shell, YAML, JSON, web languages, Terraform, Dockerfiles, and Prisma when a matching
project-local or PATH-installed server already exists. SideKick does not bundle or download
toolchains. Discovery is bounded, server startup follows execution permission policy, project-local
binaries never auto-start merely because a file was read, monorepo roots follow language markers,
idle/crashed servers stop or restart on demand, and all clients close with the app.

The conditional `code_intelligence` tool exposes diagnostics, definition, references, hover,
document/workspace symbols, and implementation only when a relevant server is available. After a
direct edit, supported files receive bounded diagnostic deltas marked new, existing, or resolved;
the result and evidence enter the same canonical tool/run event path used by every agent surface.
Unsupported languages continue through ordinary reads, edits, commands, and manifest-derived
verification suggestions without an error or extra dependency.

At an otherwise terminal model turn, `AgentRunKernel` consults the session verification controller
before persistent-goal continuation. Changed work with failed, stale, or absent evidence receives
one app-authored continuation requesting the smallest relevant check. The premature answer is
provisional and is not projected into chat. The second terminal turn is allowed even when no safe
check exists, but its durable verification state remains honestly unverified. The renderer shows
one flat, expandable verification line reconstructed from `verification.updated`; it does not infer
success from assistant prose. Goal completion can be requested by a tool earlier in the loop, but
the containing run still passes through this terminal verification boundary. See
[Workspace verification](VERIFICATION.md).

## Canonical agent runtime

Every normal conversation, research run, collaboration participant, and child agent executes in the trusted main process through one runtime:

- `AgentRunKernel` owns provider streaming, transcript repair, the model → tool → continuation loop, cancellation, permission/question suspension, tool-limit continuation, and context-compaction boundaries.
- `AgentRunStore` persists the append-only run/event ledger, typed phases, parent/child identity, pending interactions, and run todos.
- `AgentToolRuntime` builds capability-filtered sessions from the shared catalog and dispatches bounded workspace reads, transactional mutations, foreground/background commands, wait, web, MCP, skills, artifacts, todos, subagents, collaboration tools, and retained tool output.
- `AgentRuntimeCoordinator` prepares profiles, composes prompts, resolves credentials/context in the main process, captures private History lazily before the first mutation, persists final messages, and emits `run.finalized` only after durable finalization.
- `AgentContextManager` performs budget-aware model compaction with a deterministic fallback and records the actual strategy and lineage.

The kernel treats a provider output-limit finish reason as a failed tool batch: none of that turn's
calls execute, even when an argument prefix happens to be valid JSON. Every call receives a
model-visible `output_truncated` result so the model can retry with a smaller request. Within a
non-truncated batch, only catalog entries explicitly classified as parallel reads may overlap;
mutations, commands, questions, approvals, and control tools remain ordered behind those reads.

The renderer bridge exposes run start, stop, event reads, recovery, and durable interaction resolution. It does not expose raw provider streaming, model-initiated command execution, workspace mutation, MCP execution, or web search. Shared `projectAgentRunEvents` is the only event-to-message projection for streamed text, thinking, tools, artifacts, permissions, questions, tool limits, compaction, usage, and terminal state.

`useConversationRun` owns optimistic user-message insertion plus mode-aware queue/pivot UI behavior,
but no provider or tool execution. Research report is a run profile on the same kernel, not a
separate renderer agent. `useConversationMessages` and `useConversationActions` retain loading,
edit/retry/rewind, cost, and checkpoint UI concerns.

The renderer subscribes before reading a run snapshot, buffers events that arrive before attachment,
and merges an in-flight durable snapshot into any newer live events by sequence. Sequence gaps use
the paged journal endpoint for repair. A delayed snapshot therefore cannot erase a newer tool,
thinking, completion, or finalization event and leave the interface waiting for another action.

`src/shared/prompts` owns typed, capability-aware prompt and auxiliary trust boundaries for all surfaces. Skills live in `src/shared/skills`; the base prompt exposes discovery metadata and `use_skill` injects full trusted instructions on demand. Skills are declarative instructions, not packages to install. Optional bundled helper assets are resolved only inside the trusted runtime, and SideKick never runs a global Python/npm “skills setup.” Durable messages remain immutable; `conversation_compactions` stores anchored summaries while request preparation retains a recent verbatim tail. See [PROMPT_AND_CONTEXT.md](PROMPT_AND_CONTEXT.md).

`services/providers/utilityCompletion.ts` is the narrow renderer-side non-streaming completion boundary for background UI utilities such as titles. Agent streaming never crosses that bridge; the kernel calls the trusted provider runtime directly.

### Native visual browser

Vision-capable conversation runs can use SideKick's first-party browser operator without installing a
browser, extension, connector, or MCP server. `NativeBrowserSessionService` owns isolated Chromium
surfaces backed by the Electron runtime already shipped in the desktop package. It uses Electron's
internal CDP bridge for accessibility snapshots, semantic node references, full-page capture,
network accounting, and coordinate fallback; no debugging port is exposed and no personal browser
profile is attached. Local files are limited to explicitly granted project roots, plain HTTP is
limited to loopback development servers, credential-bearing URLs and unsupported schemes fail
closed, popups inherit the same navigation guard, and the ephemeral partition rejects file
subresources whose real path escapes that session's project grant. Conversation sessions persist
across follow-up runs, are replaced when a chat changes projects, and evict the least-recently-used
inactive session at the bounded global limit.

The model-facing loop is semantic-first: `browser_observe` returns a fresh accessibility snapshot,
screenshot, viewport, tab state, console delta, failed-request delta, screenshot hash, and visual
change streak. Click, type, select, key, scroll, hover, navigation, tab, and wait actions use real
browser input, settle the page, and return one post-action observation. `browser_evaluate` is a
separate inspection-only primitive: common synthetic-input and DOM-mutation APIs are rejected, and
the tool returns only a compact expression value rather than attaching a second, later screenshot
or semantic tree. Element refs are tied to one observation epoch, so stale refs fail rather than
acting on a different element. Repeated identical actions with no visual change are detected and
stopped. `browser_verify` records an explicit criterion alongside a fresh visual observation; the
model must inspect that evidence rather than infer success from a command or load event.
`browser_resize` changes the owned viewport and Chromium device metrics so responsive desktop,
tablet, and mobile criteria can be checked explicitly. `view_image` applies the same native
multimodal result path to raster files inside the active project.

Screenshots are durable, bounded files under the SideKick user-data directory. Tool results keep a
typed file reference in the append-only run ledger; provider adapters materialize it only at the
request boundary. OpenAI-compatible and Ollama requests preserve the required contiguous tool
results before adding a linked multimodal observation, while Anthropic uses image blocks inside the
native tool result. This avoids base64 in chat/event text and keeps screenshots available across
continuation turns. The durable ledger retains every bounded screenshot, while inference requests
carry only the two newest tool images so a long local-model browser loop cannot accumulate an
unbounded visual prompt. Expired historical artifacts degrade to text instead of breaking a later
follow-up. A locked-down `sidekick-browser:` protocol exposes only retained image artifacts to the
renderer. The resizable workspace inspector docks Browser beside Files and Recovery. Its flexible
preview stage consumes the available height while the page label, latest action, and verification
state stay anchored at the bottom. Portrait and full-page captures scale inside that stage instead
of expanding the inspector. Viewport screenshots overlay the last runtime-resolved interaction
point with a high-contrast cursor and glow so the user can see where SideKick clicked, typed,
hovered, or scrolled. The renderer never receives a raw `WebContents` handle or browser execution
authority, and typed field values are redacted before tool arguments enter the durable event ledger.

### Persistent goals

A persistent goal is durable conversation control-plane state above ordinary runs. It does not own
a provider client or tool loop. `ConversationGoalStore` persists the objective, revision, status,
continuation count, todo projection, blocker streak, current run, and completion evidence in
`conversation_goals`, with lifecycle changes in `conversation_goal_events`.

`ConversationRunPreparer` attaches the trusted goal contract and the goal-only `update_goal` tool.
`AgentRunKernel` consults a goal controller at otherwise terminal model turns and injects the next
app-authored continuation only while the store remains active. All ordinary compaction, tool,
permission, question, cancellation, provider, and checkpoint behavior therefore remains canonical.
The renderer can create, edit, pause, resume, and clear goals through a narrow preload API, but it
cannot complete one. See [Persistent conversation goals](PERSISTENT_GOALS.md).

### Plan mode

Plan mode is an orthogonal phase inside the same conversation run. `AgentPlanService` persists the
planner/executor identities, normalized contract, content-derived revision, review state, and
completion evidence in `agent_run_plans`. `AgentToolRuntime` projects the current plan phase into
the canonical catalog. During planning, the policy allowlist admits bounded reads, diagnostics,
web research, questions, skills, todos, waits, and retained output while removing mutations,
commands, MCP, artifacts, collaboration writes, and child agents even under Bypass.

Manual Plan selection begins in that restricted profile. An ordinary agent may instead request
`enter_plan_mode`, but the kernel suspends on a durable human interaction before switching. The
planner must call `present_plan` with traceable requirements, steps, and verification. Approval is
bound to the exact normalized revision, seeds the existing durable todo list, and atomically swaps
the model/provider request, context manager, capability catalog, and phase-specific system prompt
to Act. The approved contract remains in the execution system prompt across compaction. The
executor must finish all todos and call `complete_plan` with evidence for every requirement; the
ordinary revision-based verification guard still runs before that contract can complete. See
[Plan mode](../user-guide/PLAN_MODE.md).

## Provider instances and model selection

`ProviderSettings.providerInstances` is the source of truth for configured connections. Each
instance has a stable id, provider protocol/type, display name, endpoint, encrypted credential,
discovery strategy, enabled model inventory, optional utility model, and its latest durable health
outcome. Multiple instances of the same provider type are valid. `src/shared/providerInstances.ts`
owns normalization and projection into chat-selectable models.

`src/shared/providerRegistry.ts` is the provider metadata boundary. It distinguishes provider kind from UI transport and wire protocol, including LM Studio versus a generic OpenAI-compatible instance. Registry capabilities describe credentials, model discovery, health checks, context metadata, model lifecycle, pricing, generation statistics, thinking controls, and vision payloads. `services/providers/providerDiscovery.ts` is the renderer facade for the trusted discovery runtime.

`src/main/providers/providerRuntime.ts` resolves the selected persisted instance and dispatches to the OpenAI-compatible, Ollama, or native Anthropic adapter. It owns discovery, context lookup, completion, streaming, signal-based cancellation, and OpenRouter generation statistics. Fragmented protocol fixtures exercise each adapter, and the opt-in real-provider fixture exercises catalog, completion, and streaming clients against a configured endpoint; regular CI skips the network case when no smoke endpoint is supplied.

Settings owns connection and model-inventory management. Chat only selects among enabled models projected from enabled provider instances. Model context is treated as provider/server metadata and displayed when known; it is not a general client-side setting. Generic OpenAI-compatible servers use standard model metadata when available and never call LM Studio's private model-info endpoint.

Successful discovery or connection tests persist `online`; failures persist `offline` with a bounded, credential-redacted diagnostic and check timestamp. `checking` is deliberately renderer-only, so an interrupted test cannot survive restart as a false result. `src/shared/providerHealth.ts` derives `stale` after ten minutes rather than persisting it, and provider health is projected with each chat-selectable model for consistent status in Settings and the model picker. Editing an endpoint or credential invalidates the previous result to `unknown`.

Per-instance API keys are encrypted by the main process before persistence. Renderer settings receive only `apiKeyConfigured`; the main process resolves the instance by stable id and decrypts its credential immediately before a provider request. Normal provider IPC never accepts a raw endpoint or credential from the renderer.

SideKick's permanent zero-cost distribution policy rules out paid Apple Developer ID/notarization
and paid Windows Authenticode certificates. Tagged GitHub releases therefore contain an ad-hoc
signed macOS DMG/ZIP, an unsigned Windows NSIS installer, and a Linux x64 AppImage. CI verifies
those exact conditions, validates a closed artifact set, generates SHA-256 checksums, and publishes
a GitHub/Sigstore provenance attestation. Releases are drafted, compared byte-for-size, and only
then published without overwrite support. The publisher alone receives a short-lived,
repository-scoped token; build jobs remain read-only and receive no signing secrets.

The macOS `afterSign` hook applies an ad-hoc signature on public CI builds. Repeated local packages
may instead use a laptop-local self-signed identity from a dedicated keychain so Chromium Safe
Storage does not treat every development rebuild as an unrelated application. That identity never
leaves the contributor's machine and is not a public trust claim. Both use the same entitlements;
library validation is disabled because Electron's separately signed nested frameworks cannot share
a paid team identity with the zero-cost outer bundle. Windows Store MSIX is the planned primary
Windows channel because Store registration and Store-managed signing/updates are currently free;
the GitHub NSIS installer remains the no-account fallback. Linux uses a static-runtime AppImage
with one verified desktop, executable, icon, and `StartupWMClass` identity; it needs neither root
installation nor a paid signing service.

The main-process `AppUpdateService` is a release checker, not a binary updater. It requests only the
canonical repository's public `releases/latest` API, accepts stable semantic-version tags and
canonical GitHub release URLs, and exposes a **View release** action through typed preload IPC. It
does not receive a feed credential, download path, installer command, or execute permission.
Background checks begin after startup and repeat every six hours; transient failures and
no-update results stay quiet, while a manual menu/settings check reports its result. This keeps
update discovery useful without turning unsigned distribution into automatic remote code
execution.

## Durable agent runs

`agent_runs`, `agent_run_events`, `agent_pending_interactions`, and `agent_run_todos` are the only run
state. Sequence-numbered events include deltas, completed assistant turns, tool lifecycle, usage,
permissions, questions, compaction, retry, phase, terminal, and post-persistence finalization.

Run request context is recorded at the start and at explicit runtime mode/model transitions. Tool
results carry canonical status, structured recovery, bounded presentation metadata, timing, and
optional retained-output handles; renderer cards are projections of that ledger rather than a
second inferred execution state.

On startup, nonterminal runs become `interrupted`; conversation/research partial output is projected into the linked assistant message, unfinished tools become visible interrupted failures, pending interactions are cancelled, and a recovered `run.finalized` event closes the ledger. A renderer reload reconstructs an active message from events without replaying a tool.

## Project-agent group chats

Cross-project collaboration uses durable Slack-like groups with project-agent memberships and a
user-visible append-only event timeline. The public timeline contains only human and agent messages;
tool traces and local execution stay in each participant's durable private agent session. Each
substantial user request creates a separate mission inside the persistent group, so completing one
task does not close the conversation. V1 uses two project-bound participant agents. It does not
reuse ephemeral sub-agents as peers or mount hidden normal chat panels. A small main-process
scheduler serializes work per project while allowing separate projects to run concurrently. The
scheduler does not own a provider or tool loop: each participant is a collaboration profile on
`AgentRunKernel`. Each participant
has a durable session transcript, shared-channel cursor, addressed wake inbox, explicit run state,
and an independent safety budget sourced from the normal Agent setting.

Every public message is visible to both participant sessions in canonical sequence. Addressing only
controls which idle agent wakes immediately; it is not a privacy boundary. Before each provider
step, unseen public messages enter the participant's durable transcript with
SideKick-authenticated sender, project, kind, and sequence metadata. Assistant tool requests,
results, recovery errors, and checkpoint links are also persisted, so an app restart resumes from
the private session rather than reconstructing execution from the public channel. No global turn
counter blocks another agent. Cancellation and mission completion remain explicit user-visible
controls.

Because participant projects are intentionally isolated, concrete text-file handoffs use immutable,
size-bounded `collaboration_artifacts` snapshots. Sharing emits a public artifact reference and
addressed wake; importing is a separate permission-checked write into the recipient's own project.
Long-running servers use the canonical per-run background command service and list/cancel tools.
Foreground commands
cannot detach themselves with shell `&`, and Unix command cancellation targets the whole detached
process group so a child cannot keep the agent loop stuck by inheriting output pipes. Collaboration
prompts and provider-boundary reminders require kickoff, actionable-request responses, and periodic
public updates without serializing the two independent loops. Peer messages carry an explicit
`request`, `response`, `update`, or `completion` intent. Only requests create a required reply;
responses may wake a waiting peer, while updates/completions remain visible without creating an
acknowledgment loop. Mission settlement queries the complete mission event stream rather than the
bounded timeline page used by the UI.

The desktop group view is a three-way communication surface: shared chat and composer on the left,
with two independently scrolling agent-session inspectors stacked on the right. Each inspector has
Work, Files, and read-only SideKick History tabs and can open as a full inspector from the group or
its nested sidebar entry. On narrow windows the inspectors become a drawer. History restore remains
disabled there so one project rollback cannot silently invalidate the shared conversation.

The current main-process `workspacePath` remains UI state for direct chats and is not collaboration
authority. The scheduler resolves each participant's project id and canonical root from trusted
SQLite records. File tools, instructions, and private History use that root directly. Commands use
it as cwd but are not an OS sandbox, so group commands require approval unless the user explicitly
enabled bypass mode. Saved workspace memory is loaded from the same project path and explicitly
framed as untrusted context rather than instructions or authority. The detailed product model,
trust boundary, persistence, phases, and acceptance matrix are in
[Project agent collaboration](../user-guide/COLLABORATION.md).

## Private workspace History

The checkpoint service uses Git only as a content-addressed storage engine in Electron app data,
keyed by canonical workspace path. It never writes to a project's real `.git`. A lazy baseline is
captured before the first potentially mutating tool in an agent response, and the final History entry
owns only that run delta. Restore traverses owned deltas, preflights all affected paths, protects the
real Git staged set, and refuses the whole operation on a later same-file change. An independent
applied ref supports reversible soft restore without rewriting message or label identity. The full
contract is in [Private workspace History](../user-guide/WORKSPACE_HISTORY.md).

## Projects and conversation context

`projects` stores durable folder-backed context boundaries and `conversations.project_id` stores
membership. A null project id is an intentional standalone chat, not an implicit reference to the
last opened folder. Selecting or creating a conversation activates its project folder in the trusted
main process before workspace-dependent capabilities are used.

Project conversations share folder tools, command working directory, project memory, checkpoints,
and a freshly loaded `AGENTS.override.md`/`AGENTS.md` instruction chain. The sidebar renders projects
with nested conversations and keeps standalone chats in a separate section. See
[Projects](../user-guide/PROJECTS.md) for persistence, movement, and instruction-discovery behavior.

## Built-in SideKick Search

`src/main/services/sidekickSearch` is a main-process capability with no configured endpoint or separately managed runtime. Source adapters query DuckDuckGo, Brave Search, and Bing concurrently through their public browser surfaces. The coordinator records source diagnostics, canonicalizes and deduplicates destinations, applies reciprocal-rank fusion and domain diversity, and caches successful results locally. Image discovery, optional local image-byte optimization, and Readability-based page extraction use the same internal capability.

Only `AgentToolRuntime` can invoke search, image discovery, or page extraction; there is no raw
renderer search bridge. See [Search](../user-guide/SEARCH.md) for behavior, privacy boundaries,
maintenance, and smoke testing.

## Authorization

`src/shared/permissions.ts` defines the common policy and operation contracts. Agent tools suspend
inside the kernel and persist requested/resolved events; user-initiated file and History actions use
exact, expiring `PermissionBroker` grants. Settings projects both sources into one chronological
authorization audit without creating a second agent-policy store. See
[Permissions](../user-guide/PERMISSIONS.md) for the mode and tool matrix.

## Research mode

Research is a one-shot, capability-restricted `research` profile on the canonical kernel. It uses
the same provider transcript, event ledger, cancellation, compaction, output limits, recovery, and
renderer projection as normal chat, while adding an evidence workflow for breadth-then-depth
discovery, primary-source preference, claim verification, conflict handling, and inline citations.
Its read-only catalog contains embedded web discovery/retrieval, focused user questions, bounded
wait, and retained-output access. Models without tool support cannot select the profile.

The kernel permits one guarded continuation when a research model tries to finish before attempting search or fetch. The provisional answer is excluded from durable projection; a model that ignores the retrieval reminder twice produces an honest incompatibility result rather than an unverified report or an unbounded retry.

The profile is stored with both the user request and assistant response. Queue, pivot, retry, rewind,
reload, and recovery therefore use durable message/run intent rather than the composer's current
state. Normal tool rows are the honest progress UI; there is no parallel `ResearchAgent`, synthetic
percentage, or renderer scratchpad. See [Research reports](../user-guide/RESEARCH.md).
