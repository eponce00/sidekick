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

`src/shared/agentToolDefinitions.ts` is the single workspace-tool registry. Every tool session
that can edit files (conversation and sub-agent runs) receives one editing dialect
selected for the executing model by `editingDialectForTarget`: canonical `apply_patch` for
Codex-style models, `Edit`/`Write` for Claude-style models, search-and-replace for Grok-style
models, or the generic `edit`/`write`/`delete_file` contract, which is also what open-weight
models such as Qwen are trained on. Dialects are adapters over the same mutation request and do
not create separate execution paths. Read, list, and search tools are shared across every dialect.

Canonical patches use the `*** Begin Patch` / `*** End Patch` grammar with explicit Add, Update,
Delete, and optional Move directives. The parser restores an envelope missing around complete file
operations, reads a final `*** End of Patch` (or an unfollowed `*** End of File`) as the end of the
patch, converts a plain unified diff with `---`/`+++` headers, ignores unified-diff hunk line
numbers, accepts a misplaced `*** Move to:`, and merges repeated Update sections for one file.
Bare `+`/`-` text, prose around a patch, and truncated tool calls still fail closed.

Exact edits and patch hunks match exactly first. Only when nothing matches exactly do they match
text that differs from the file solely in line endings, trailing whitespace, typographic
punctuation (curly quotes, dashes, non-breaking spaces), invisible marks such as emoji variation
selectors, or read-tool `N: ` line prefixes (`src/main/utils/tolerantMatch.ts`). Such a match must
still be unique, and text the model did not change is written back from the file, so a copy typed
with ASCII quotes never rewrites the file's typography. Each line keeps its own ending, so a mixed
CRLF/LF file is not converted, and `write` keeps the line endings of the file it replaces. A miss
reports the closest current lines with their line numbers. Paths may be project-relative, `./`
prefixed, or absolute inside the project; all spellings share one read receipt. `AgentToolRuntime` requires
same-run version receipts for every existing target, the kernel resolves permission policy, and the
transactional mutation service commits only after validating the complete plan. Model results
contain a bounded truthful diff summary; the UI starts the activity row as soon as tool input
streams and only shows success after `ok` and `changed` are both true.

The same canonical path resolver protects reads, searches, shell-open actions, direct mutations,
and attachment imports between chats. It rejects lexical traversal and symlink escapes; mutation paths
also reject internal symlink aliases so snapshots and rollback always refer to one concrete file.
Recursive search and listing never follow symlink entries.

Each configured model exposes exactly one editing contract. Automatic selection uses the upstream
model identity when a gateway such as LiteLLM reports it. Opaque aliases can run active,
long-context localized-edit, multi-match replacement, and complete-write probes across every
dialect; successful results are persisted against the exact provider/model/upstream identity.
In exact-edit contracts `replace_all` defaults to false, the scope that can change only one
location. When `old_string` does not match exactly, the mutation service tries fallbacks from
strictest to loosest: typography, trailing whitespace, line endings, invisible marks and read-tool
line numbers; then blank lines and newlines at the edges of `old_string`; then whole lines retyped
with different indentation or inner whitespace, re-indented to the file. The first fallback with
any match decides, and it applies only a unique match (or every match with `replace_all`). A block
whose middle differs from the file is never applied; the error names the closest block's lines and
lists the lines that differ. Ambiguous matches fail closed with a typed failure, bounded
match-start lines with excerpts, and a concrete correction rather than a generic conflict. When
an edit fails and the target changed since it was read, the stale read is reported instead.

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

Models bring names from other agent harnesses. The registry renames an argument another harness
uses for the same thing, such as `file_path` or `filePath` for `read`'s `path`, `offset` and
`limit` for its line range, or Codex's `workdir` for `cwd`, when exactly one spelling is present,
and lists each repair in the invalid-argument recovery if the call still fails. A call to another
harness's tool, such as `apply_patch` in a run with exact-text editing or Claude Code's
`AskUserQuestion`, is still refused, but the refusal names the SideKick tool that does the job in
this run and its required arguments.

A refusal says what it is, so the model can act on it and diagnostics do not count expected
refusals as faults. A path outside the project, whether written with `..`, as an absolute or UNC
path, or reached through a link, is `workspace_scope` whichever tool named it. Its recovery says
the folder is not granted to the chat and how the user can grant it: a chat in that folder's
project, which a manager can start with `start_session` and the user approves on the start card,
or copying the files in. It never suggests another route to the folder. A chat with no project
folder refuses file and command tools the same way. A browser page that fails to load is labelled
like a failed model request: a refused or dropped connection is `transient` and one that gave up
is `timeout`, while a host name that does not resolve is `not_found`, because the model chose the
address. `internal` is left for failures nothing explains. A command that failed on a Unix command
or flag in Windows PowerShell, such as `grep` or `cat -n`, gets the PowerShell equivalent, or `rg`
when it is installed, in its output.

Errors separate retry permission from the required recovery action: `correct_input`,
`refresh_state`, `retry_later`, `change_strategy`, or `stop`. The run-scoped
`AgentToolRecoveryController` independently fingerprints canonical tool arguments and results.
Consecutive byte-equivalent calls receive sparse, model-only advisory reminders; successful file
state revisits receive the same non-blocking treatment. A raw number of successful edits or rewrites
is never considered proof of a loop, and post-execution guidance cannot replace success with an
error. Identical failures, same-tool failure streaks, and consecutive all-failed tool turns remain
hard recovery boundaries. This applies in the shared kernel, so direct, worker, child-agent, and
research runs cannot diverge. Terminal failure messages summarize the concrete failing tools,
missing fields, and call counts.

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
the result as one status in the reply's footer, reconstructed from `verification.updated`; it does
not infer success from assistant prose. A goal consults the same one-time request before its completion is
accepted, so the evidence is gathered before the goal closes rather than questioned after it. See
[Workspace verification](VERIFICATION.md).

## Canonical agent runtime

Every normal conversation, worker chat, research run, and child agent executes in the trusted main process through one runtime:

- `AgentRunKernel` owns provider streaming, transcript repair, the model → tool → continuation loop, cancellation, permission/question suspension, tool-limit continuation, and context-compaction boundaries.
- Before the first model turn, the kernel reads up to four project files the user attached through the ordinary `read` tool and records them as calls the model made. The model starts from their contents, the reads register the receipts its edits need, and the renderer shows them as normal tool rows.
- `AgentRunStore` persists the append-only run/event ledger, typed phases, parent/child identity, pending interactions, and run todos.
- `AgentToolRuntime` builds capability-filtered sessions from the shared catalog and dispatches bounded workspace reads, transactional mutations, foreground/background commands, wait, web, MCP, skills, artifacts, todos, subagents, chat tools, and retained tool output.
- `AgentRuntimeCoordinator` prepares profiles, composes prompts, resolves credentials/context in the main process, captures private History lazily before the first mutation, persists final messages, and emits `run.finalized` only after durable finalization.
- `AgentContextManager` performs budget-aware model compaction with a deterministic fallback and records the actual strategy and lineage.

The kernel treats a reply the output limit cut off while it wrote tool calls as a failed tool
batch: it is known by the provider's finish reason (`length`, `max_tokens` and other spellings) or
by a reply that used its whole allowance whatever the reason says. None of that turn's calls
execute, even when their JSON happens to parse; every call receives a model-visible
`output_truncated` result asking for fewer, smaller calls. The turn records the stop reason,
completion tokens, reply limit and the model's own limit on `assistant.completed`, the refused
`tool.completed` events and a `run.retrying` event.

A reply that runs away is stopped while it streams. The streaming clients report each call once it
is whole (`closed_tool_calls`), and the kernel stops the request when a reply has begun more than 64
calls, or written the same call, same tool and same arguments, a fourth time. None of its calls
run, the calls the chat showed are closed as refused, and the next request tells the model why and
asks for one call at a time, as Gemini CLI does; a second runaway in the run ends it as
`loop_detected`. A reply that arrives whole is checked the same way. The support diagnostics export
and `npm run audit:runs` count cut-off and runaway replies per reply, not per refused call, without
content: one runaway reply of 784 calls once read as 767 refusals across a profile. A turn the
limit cut off while the model was still thinking, before any answer or tool call, ends the run
with that reason, as Codex treats an incomplete response, instead of completing it empty; the
model is never told to cut its thinking short. A reply's limit is a quarter of the context window
up to 32,768 tokens, or the model's configured maximum output, honored up to half the window. A
public catalog's maximum output, as OpenRouter and Anthropic report it, only lowers the default. Within a non-truncated batch, only catalog entries explicitly classified as parallel reads may overlap;
mutations, commands, questions, approvals, and control tools remain ordered behind those reads.

A provider failure ends a run with a code that names the cause; `internal` is left for failures
nothing explains. An unreachable server, a dropped connection, a rate limit, and a 5xx answer are
`transient`; a server that sent nothing for five minutes (Node's fetch limit) or answered 408 is
`timeout`; a refused key (401 or 403) is `permission_denied`; an unknown model or address (404) is
`not_found`; a chat whose provider or model is missing, turned off, or without its key in Settings
is `not_configured`; other refusals are `invalid_arguments`. The message puts SideKick's
explanation before the provider's own words, with echoed credentials masked. Before failing, the
kernel retries once: after compacting when the provider reports a context overflow, after dropping
older images when it names an image limit, and at the provider's stated maximum when it refuses
the reply limit. Image and reply limits are remembered per provider and model for the session. A
turn whose stream broke off (the connection closed, or the stream ended before the provider
finished the reply) is asked again once per turn, three seconds later, with the same request: tools
run only after their whole turn has arrived, so the broken turn ran none of its calls. Its
`run.retrying` event (`stream_dropped`, `discardsPartialTurn`) makes the shared projection drop the
partial text, thinking and tool previews it streamed.

The renderer bridge exposes run start, stop, event reads, recovery, and durable interaction resolution. For agent commands it exposes only the user's own terminal controls: list and read a conversation's commands, stop one, move one to the background, and type into one. It does not expose raw provider streaming, model-initiated command execution, workspace mutation, MCP execution, or web search. Shared `projectAgentRunEvents` is the only event-to-message projection for streamed text, thinking, tools, artifacts, permissions, questions, tool limits, compaction, usage, and terminal state.

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
limited to loopback servers and local-network origins the user approved in a trusted dialog
(stored apart from settings, revocable in Settings, and shared with `web_fetch`, see
[Built-in SideKick Search](#built-in-sidekick-search)), credential-bearing URLs and unsupported schemes fail
closed, popups inherit the same navigation guard, and the ephemeral partition rejects file
subresources whose real path escapes that session's project grant. Conversation sessions persist
across follow-up runs, are replaced when a chat changes projects, and evict the least-recently-used
inactive session at the bounded global limit. Bookmarks and history the user imports from other
browsers serve only the panel's bookmark list and address suggestions; see
[Browser data import](BROWSER_IMPORT.md).

The model-facing loop is semantic-first: `browser_observe` returns a fresh accessibility snapshot,
screenshot, viewport, tab state, console delta, failed-request delta, screenshot hash, and visual
change streak. Click, type, select, key, scroll, hover, navigation, tab, and wait actions use real
browser input, settle the page, and return one post-action observation. `browser_evaluate` is a
separate inspection-only primitive: common synthetic-input and DOM-mutation APIs are rejected, and
the tool returns only a compact expression value rather than attaching a second, later screenshot
or semantic tree. `browser_fill_form` runs an ordered standard-control batch under the existing
session lock, verifies each real post-action value without returning it, aborts remaining fields on
the first failure or observation-epoch/URL change, settles once, and captures one final redacted
semantic observation. It deliberately omits the result screenshot so entered values cannot leak
back through visual tool media. Element refs are tied to one observation epoch, so stale refs fail
rather than acting on a different element. Repeated identical actions with no visual change are
detected and stopped. `browser_verify` records an explicit criterion alongside a fresh visual
observation; the model must inspect that evidence rather than infer success from a command or load
event.
`browser_resize` changes the owned viewport and Chromium device metrics so responsive desktop,
tablet, and mobile criteria can be checked explicitly. `view_image` applies the same native
multimodal result path to raster files inside the active project.

An artifact made with `create_artifact` is observed the same way before its result returns.
`ArtifactInspector` loads `artifact-inspect.html` from the artifact protocol in an offscreen window
that is never shown, cannot open windows, and cannot navigate. That page renders the artifact with
the chat's own components in the user's theme, waits for it to report success and then for its data
requests to settle, and reports runtime errors. The inspector captures the artifact at the chat's
width as the chat shows it, and says when it is taller than the height an artifact grows to in the
chat, where the user first sees its top and scrolls inside it or opens it full screen for the rest.
The model receives the render status, errors, and, when it accepts images, the capture as a
small inline JPEG; it no longer receives its own code back. A failed or unfinished render is a
failed tool call, and when inspection itself is unavailable the result says the artifact is
unverified. The run ledger keeps tool arguments as a bounded preview, so replayed history restores
the current version of each artifact whole from its result, marks that result as the current
version, and points the versions it replaced to it instead of showing them cut. `create_artifact`
is offered whenever the run allows artifacts, whether or not the web-artifacts skill has loaded,
so the tool list does not change mid-conversation and invalidate the provider's prompt cache. An
artifact made before the skill loaded is still rendered, and its result carries the skill's
guidance unless the previous reply made an artifact and the guidance is already in history. The
chat shows only the latest version of an artifact within a reply, and a failed one as a single
line that expands to its error and code.

Artifacts run on the isolated `sidekick-artifact://app` origin, never in the renderer's own
document. React artifacts run in `sandbox.html`, which bundles the libraries and Tailwind; HTML
and SVG artifacts run in `html-sandbox.html`, which writes the artifact as its whole document so
its inline scripts run under that page's policy and its load events fire. The two pages share one
Content-Security-Policy, except that the HTML page also allows inline scripts, which an HTML
artifact is made of; the React page already evaluates the model's code. The renderer embeds either
page in an iframe sandboxed to scripts and its own origin. The chat and a frame talk only through
the messages in `src/shared/artifactFrame.ts`, and each side reads the other's through that file's
readers, which accept exactly those shapes. The chat sends `render`, with the code and theme, once
the frame says it is ready, addressed to the artifact origin, and `theme` when the app's theme or
accent changes. The frame sends `ready`, its content's `resize`, `success`, `error`, and `pointer`
when the pointer enters or leaves it, which the chat cannot see inside a frame from another origin.
The chat accepts a message only from its own frame's window and the artifact origin; the frame only
from the window that embeds it. Theme values become CSS only after `readArtifactTheme` has refused
anything that could end a declaration, rule or element, or fetch a resource.

In the chat an artifact has no card. Its frame's page is transparent, so the conversation shows
through, and its width is the reply's. The frame measures its content's own height rather than the
document's scroll height, which never drops below the frame's, so it can shrink as well as grow;
the chat follows that height with a short transition, up to 1,600 pixels, beyond which the frame
scrolls. The frame hides its scrollbar while the chat is catching up, so scrolling over an
artifact that fits reaches the chat. Before an artifact first shows, one quiet line holds its place,
or the height it last rendered at when it is shown again. Each sandbox loads SideKick's fonts and
a base stylesheet in a cascade layer, so any style the artifact writes wins; with Tailwind the same
rules are also given as Tailwind's base layer, after its reset and before its utilities, and no
selector in them is more specific than one element. The design follows the published guidance for
inline generated interfaces in conversations, from Claude's inline widgets and MCP Apps' host
theming to OpenAI's Apps SDK inline cards: a transparent frame on host variables, height that fits
the content without nested scrolling, and an expand control rather than chrome around the content.

Screenshots are durable, bounded files under the SideKick user-data directory. Tool results keep a
typed file reference in the append-only run ledger; provider adapters materialize it only at the
request boundary. OpenAI-compatible and Ollama requests preserve the required contiguous tool
results before adding a linked multimodal observation, while Anthropic uses image blocks inside the
native tool result. This avoids base64 in chat/event text and keeps screenshots available across
continuation turns. The durable ledger retains every bounded screenshot, while inference requests
carry only the provider's image budget so a long local-model browser loop cannot accumulate an
unbounded visual prompt. Expired historical artifacts degrade to text instead of breaking a later
follow-up.

Images are fitted to the provider in the same boundary step, `materializeProviderRequestMedia`,
from the profile `providerImageProfile` gives each provider kind
(`src/shared/imagePreparation.ts`): Anthropic and OpenRouter take four images of up to 2000 px;
LiteLLM and other OpenAI-compatible gateways two of up to 2048 px; local servers (LM Studio,
llama.cpp, Ollama) two of up to 1568 px and about 1.3 megapixels, as PNG or JPEG only, since
llama.cpp cannot decode WebP. Every profile keeps an image within 5 MB once base64-encoded, the
smallest per-image limit among Anthropic's platforms. An image that already fits is sent byte for
byte. Others are decoded with `@napi-rs/canvas` (which applies EXIF rotation), drawn at the
planned size from mipmaps, and encoded as PNG first unless the source was a JPEG, then as JPEG at
falling quality, shrinking further only when none fits. The model is told in the message when an
image was resized; an image that cannot be read or declares more than 100 megapixels is left out
with a note instead of failing the request. Viewport screenshots carry `keepDimensions`, because
coordinate actions map the model's pixels back through the captured size, so they are only
re-encoded. Results are cached by content hash, so a turn that resends the conversation's images
does not prepare them again. The stored message and the run ledger keep the original; the
composer accepts up to 100 MB per image and validates the type and declared size in the renderer
and again at the IPC boundary. A locked-down `sidekick-browser:` protocol exposes only retained image artifacts to the
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
The renderer can create, pause, resume, and clear goals through a narrow preload API, but it
cannot complete one. It reports a completion in the conversation as an app-authored notice. See [Persistent conversation goals](PERSISTENT_GOALS.md).

### Scheduled runs

`ScheduleService` starts saved prompts on a schedule. Each run is a new conversation started
through the same engine request as a chat the user sends, so the kernel, permission mode, and
chat status are unchanged; a run that needs approval waits for the user. Missed runs
collapse into one late run, and a schedule holds one active run at a time. See
[Scheduled runs](SCHEDULES.md).

### Chat status

`SessionStatusService` in the main process computes each chat's state: `working` while a chat or
research run prepares or runs, `waiting` while it is paused on an approval or question, `done`
until a finished reply is read, `failed` or `stopped` after its last run ended that way, and
`idle` otherwise. A chat that started others also carries their most urgent state. It follows run
events (skipping streamed output) and the runtime's preparation hook, and reads stored runs at
startup, so states are right before any window opens and for runs no chat panel started. The
sidebar, the taskbar and Dock badge, the tray, and attention notifications all read it through
`sessions:statuses` and `sessions:changed`; the renderer's panel registry only decides which
panels stay mounted.

### Plan mode

Plan mode is an orthogonal phase inside the same conversation run. `AgentPlanService` persists the
planner/executor identities, normalized contract, content-derived revision, review state, and
completion evidence in `agent_run_plans`. `AgentToolRuntime` projects the current plan phase into
the canonical catalog. During planning, the policy allowlist admits bounded reads, diagnostics,
web research, questions, skills, todos, waits, and retained output while removing mutations,
commands, MCP, artifacts, chat tools, and child agents even under Bypass.

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

`src/shared/providerRegistry.ts` is the provider metadata boundary. It distinguishes provider kind from UI transport and wire protocol, including LM Studio versus a generic OpenAI-compatible instance. `src/shared/reasoning.ts` owns
which reasoning levels each model offers and resolves the one a request carries. Discovery records
the levels and default each server reports per model (`src/main/providers/reasoningCapabilities.ts`),
and a model with fewer than two levels offers no control; each adapter
translates that level into its protocol's own field (`reasoning.effort`, `reasoning_effort`,
`chat_template_kwargs.enable_thinking` or `thinking`, Ollama `think`, or Anthropic adaptive thinking with an
effort or a thinking budget) and retries once with the model's default when a server rejects it. Registry capabilities describe credentials, model discovery, health checks, context metadata, model lifecycle, pricing, generation statistics, thinking controls, and vision payloads. `services/providers/providerDiscovery.ts` is the renderer facade for the trusted discovery runtime.

`src/main/providers/providerRuntime.ts` resolves the selected persisted instance and dispatches to the OpenAI-compatible, Ollama, or native Anthropic adapter. It owns discovery, context lookup, completion, streaming, signal-based cancellation, and OpenRouter generation statistics. Fragmented protocol fixtures exercise each adapter, and the opt-in real-provider fixture exercises catalog, completion, and streaming clients against a configured endpoint; regular CI skips the network case when no smoke endpoint is supplied.

Settings owns connection and model-inventory management. Chat only selects among enabled models projected from enabled provider instances. Model context is treated as provider/server metadata and displayed when known; it is not a general client-side setting. Generic OpenAI-compatible servers use standard model metadata when available and never call LM Studio's private model-info endpoint.

Successful discovery or connection tests persist `online`; failures persist `offline` with a bounded, credential-redacted diagnostic and check timestamp. `checking` is deliberately renderer-only, so an interrupted test cannot survive restart as a false result. `src/shared/providerHealth.ts` derives `stale` after ten minutes rather than persisting it, and provider health is projected with each chat-selectable model for consistent status in Settings and the model picker. Editing an endpoint or credential invalidates the previous result to `unknown`.

Per-instance API keys are encrypted by the main process before persistence. Renderer settings receive only `apiKeyConfigured`; the main process resolves the instance by stable id and decrypts its credential immediately before a provider request. Normal provider IPC never accepts a raw endpoint or credential from the renderer.

A chat pinned to an instance id that is not stored, because it was removed or is not saved yet,
fails with a setup error that names it. `src/main/providers/providerResolver.ts` never substitutes
another instance or the legacy endpoint settings, which would send the prompt to a server the user
did not choose for that chat. Settings from before provider instances are read through the same
legacy migration the renderer shows while the keychain is too locked to store it.

Every settings write is a read-modify-write of the stored record in one synchronous step in the
main process. `settings:save` replaces only the keys it names, applied to what is stored after any
approval dialog closes, and the renderer sends only the keys a change touched. Migrations (retired
keys, tool-call limit and accent palette policies, legacy provider instances) run in the main
process as settings load; the renderer never saves back a copy it read, which would undo a save
made in between.

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

## Chats that start other chats

A chat can start worker chats and message them; together they form a family. `SessionService` in
the main process owns families: it creates workers, routes messages, sends reports, and wakes
chats. The links live on `conversations` (`started_by_conversation_id`,
`report_to_conversation_id`, `session_handle`, `work_in`, `archived_at`), and messages, attachments,
suggestions and project grants in `session_*` tables. Workers cannot start chats, so a family is
one level deep. The user-facing behavior is in
[Chats that work together](../user-guide/CHATS_THAT_WORK_TOGETHER.md).

- **Runs.** A worker is an ordinary conversation. Its brief is its first user message, stored with
  the same id as the `brief` session message so the chat can show it as a brief. Every run it makes
  goes through the same engine request as a chat the user sends, so the kernel, permissions, folder
  guard, verification and History are unchanged. Writing workers get a managed worktree from
  `ManagedWorktreeService.createForConversation` before their first run.
- **Tools.** `ConversationRunPreparer` asks the sessions tool factory for each conversation run's
  role and capabilities. A manager receives `start_session`, `send_message`, `list_sessions`,
  `stop_session` and `import_attachment`; a worker only the last three. A worker's capabilities never
  exceed a conversation's ordinary set, and a read-only worker loses every capability that edits or
  executes. Planning removes the chat tools with every other side effect.
- **Start card.** `start_session` computes the rows first. In full access, and when every project
  is already allowed, it starts at once; otherwise it pauses the run on a durable `question`
  interaction (`intent: 'start_sessions'`) through `AgentRunKernel.requestUserDecision`, and applies
  the user's changes before starting. Starting from the card grants any new project to the manager.
- **Delivery.** Messages are durable rows. A running chat receives waiting messages as kernel
  steers, so they are recorded as `run.steered` and replayed in later histories; a run that starts
  takes its waiting messages as initial steers. Each message is framed as untrusted content with
  SideKick-authenticated sender, role and intent, and a message steered into a running chat also
  ends a `wait` in it. Messages carry no authority: interactions resolve only through the renderer's
  `agentRuns:resolveInteraction`.
- **Wakes and reports.** When a worker's run ends, its final message goes to the manager as a
  `report`, with its branch and whether the user stepped in. A `request` wakes an idle recipient, a
  `response` wakes the chat that asked, and reports wake the manager only once none of its workers
  has a run queued, being prepared or running, or has ended a run whose report is not written yet
  (it is still being finalized, or waits behind another report). A chat whose run is being
  prepared is not woken again: that run takes the waiting messages when it starts. Updates, status
  notes and broadcasts never wake. A request left unanswered when its recipient's run ends is
  reported back to the sender. A chat woken 20 times in a row without the user starting or
  steering a run pauses until the user does.
- **Slots and restarts.** `RunSlots` admits chats, workers, scheduled runs and sub-agents against
  one global limit (`maxConcurrentRuns`, 4 by default) and a per-provider limit; a run waiting for
  the user, a `wait`, or its sub-agents gives its slots back. After a restart, interrupted workers
  are listed and resumed only by the user, and each manager receives one status note that does not
  wake it.

Group chats from earlier versions are converted by migration `20261016_004_group_chats_to_chats`:
each group becomes a standalone manager with one `folder` worker per project agent and a grant for
each agent's project. People's messages become the manager's messages, agents' posts become
delivered session messages from their workers, and each agent's own replies stay in its worker. The
group tables and group-agent runs are then dropped.

## Background commands

Long-running servers use the canonical background command service, owned by the conversation, and
its list, read, input and cancel tools. Commands run in a pseudo-terminal (node-pty, ConPTY on
Windows) unless isolation or the user's setting asks for pipes; a headless terminal renders their
output to the text the model reads. `TerminalSessionStore` keeps one record per command for the
chat, the Terminal panel and those tools. A foreground command that waits at a prompt, that the user
moves to the background, or that is still running when its call's time is up becomes a background
task instead of holding the agent loop. Ended background tasks are reported to the agent before its
next model step, and `wait` ends on a named task ending, a pattern in its output, a user message, or
a message from another chat. Foreground commands cannot detach themselves with shell `&`. Unix
cancellation targets the command's whole process group; on Windows the tree is ended with
`taskkill`, and children orphaned by a shell that died first are found by their parent ID, so no
child keeps the loop stuck by inheriting output.

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

The composer's pull request line asks `pullRequests:getStatus` with a folder only. The main process
checks it with the known-workspace resolver, then `src/main/services/pullRequestStatus.ts` runs
fixed read-only `git` and `gh` argument lists, refusing any other shape. GitHub CLI availability and
rate limits are cached there, so a missing CLI is not spawned on every poll. Links in the line open
through the main window's external-navigation policy.

### Worktrees and parallel agents

A worktree belongs to its chat, not to a project of its own: `conversations.worktree_id` points
at it, the chat keeps its `project_id`, and `ProjectStore.getConversationContext` returns the
worktree's folder as the chat's `workspaceRoot`, which every run, tool and checkpoint uses.

`src/main/services/managedWorktreeService.ts` owns SideKick's Git worktrees: creation for a fork or
a chat that has not started (`createForConversation`, also the entry point for main-process callers
such as agent-started chats), inventory with Git state and owners, setting the least recently used
worktrees aside beyond 15 on disk, restoring one before its chat's next run (the coordinator's
`prepareWorkspace` hook), and removal. Setting aside snapshots HEAD and every unignored file into a
commit held by `refs/sidekick/worktrees/<id>`, built in a private index so the worktree's own index
is untouched. New worktrees go in `<repository>.worktrees/<slug>-<6 hex>` beside the repository
(`siblingWorktreesFolder`): outside the checkout, so the source folder's path containment, occupancy
and `git status` never include them, and short on Windows. The folder is reserved with an exclusive
`mkdir` before `git worktree add` fills it, so names never collide. When that place is unusable (a
drive root, a parent inside another repository, a link, or no write access) the worktree goes in
private storage, `worktrees/<source project id>/<name>`, where every older worktree also stays. It
acts only on folders it can prove it created: a direct child of one of those two folders, which
must not itself be a link, and registration in `git worktree list`. Removal deletes links inside the
worktree as links before `git worktree remove --force`, so a junction to a shared install never
loses its target.

`src/main/services/workspaceOccupancy.ts` records the folder every writing run uses.
`AgentRuntimeCoordinator.startConversation` checks and claims it in one step and refuses a run in a
folder that is the same as, inside, or contains a busy one, unless the start input says
`workspaceSharing: 'allow'`. Research runs read only and are not guarded. A worker that works in
its manager's folder starts with sharing allowed, because choosing that folder is the decision to
share it. The renderer asks first through
`agentRuns.workspaceOccupants`, but the refusal in the runtime is the enforcement. See the
[worktree design note](../roadmap/WORKTREES.md) for the comparison with other harnesses and the
open work.

## Built-in SideKick Search

`src/main/services/sidekickSearch` is a main-process capability with no configured endpoint or separately managed runtime. Source adapters query DuckDuckGo, Brave Search, and Bing concurrently through their public browser surfaces. The coordinator records source diagnostics, canonicalizes and deduplicates destinations, applies reciprocal-rank fusion and domain diversity, and caches successful results locally. Image discovery, optional local image-byte optimization, and page reading (Markdown conversion, Readability for the main article, and a digest bounded by what the agent asked for) use the same internal capability.

Page reading and image downloads go through `webNetworkGuard`, which applies the browser's
local-network policy to SideKick's own requests. `admitWebUrl` decides each hop before anything is
sent: loopback is refused, a plain-HTTP local-network origin asks `browserNetworkApprovals`, the
same store and trusted dialog the browser uses, an HTTPS local-network origin opens as in the
browser, a public name may never resolve into the local network, and a redirect never asks and
never leads from a public response into the local network. Names are checked where the connection
resolves them: each
request gets its own agent whose `lookup` classifies every address with `networkAddressKind`, which
reads IPv4 inside IPv6 (mapped, compatible, translated, NAT64, 6to4), and refuses the lookup when
any address is out of bounds, so DNS rebinding cannot swap in an address after a check. Proxies are
disabled for the same reason. A refusal is final; it never falls back to the rendered read. That
render runs in its own partition with direct connections and every permission denied, checks each
request before Chromium sends it, and discards the page if `onCompleted` or `onBeforeRedirect`
reports a remote address its request could not reach.

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
