# Prompt and context architecture

SideKick treats the prompt, conversation projection, and durable transcript as separate concerns. The SQLite transcript is the source of truth; provider requests are disposable projections built for one run.

## Agent prompt

`src/shared/prompts/PromptComposer.ts` builds agent prompt version `sidekick-agent-v6` from typed inputs:

- host platform and shell;
- tools actually present in the request;
- permission mode;
- selected model family and provider identity;
- project root, project instructions, and project memory;
- current date/location, active skills, and the configured tool-round pause.

The composer does not describe disabled capabilities. Windows receives PowerShell guidance; macOS and Linux receive Bash/POSIX guidance. Model-family profiles are provider-independent and may adjust presentation without changing safety or permission semantics.

Bundled skills use progressive disclosure. The base prompt contains only the short metadata for
discoverable skills. The model calls `use_skill` when the current request matches, and the trusted
full instructions arrive in that run's tool result. Conversation-scoped skills may remain active for
later turns; run-scoped skills do not persist or become part of later system prompts.

A skill's tools reach the model in one of two ways. The `web-artifacts` skill's `create_artifact`
is offered from the start, so the tool list stays the same across turns and the prompt cache
holds; an artifact made before the skill loads is rendered, and the skill's guidance comes back
with it. Tools needed rarely enough that carrying their schemas in every run costs more than a lost
cache are gated instead: the `schedules` skill's tools are absent from the initial tool list and
join the run's catalog once `use_skill` loads that skill. A later run that calls one before
loading the skill is told to load it. See [Scheduled runs](SCHEDULES.md#agent-tools).

Live web artifacts are deliberately run-scoped. An artifact is an interactive result inside the
chat. Websites, landing pages, web apps, components,
and HTML/CSS/JavaScript deliverables for an active project are workspace-file work; SideKick does
not create both forms unless the user explicitly requests both.

Instruction priority is explicit: system/permission policy, the current user request, applicable project instructions, then earlier context. Project memory, summaries, ordinary workspace content, web/MCP/tool/command output, and research records are untrusted data. Two app-framed exceptions can carry instructions: a `trusted-skill-instructions` block selected from SideKick's bundled registry and an `app-loaded-project-instructions` block read by the main process from known project instruction files. Repository text is escaped so it cannot forge either app-owned frame.

Project instructions are deliberately separate from the system prompt. SideKick inserts the initial
global/root instruction block as a user-role message immediately after the system message, while the
human's actual current request remains later in the provider projection. File reads, recursive search
matches, command working directories, and file mutations resolve newly applicable nested
`AGENTS.override.md`/`AGENTS.md` files during the run. A mutation that first discovers a nested rule is
deferred, returns that rule to the model, and must be retried. Compaction resets nested delivery claims
so the relevant instructions can be introduced again without changing the immutable transcript.

Utility prompts for titles, web extraction, research, and sub-agents use the same data boundary. Source text is never interpolated as a system instruction. Research output is proportional to the question rather than forced into a fixed “exhaustive” length.

## Immutable transcript and provider projection

Compaction never deletes or rewrites messages. `conversation_compactions` stores a derived, anchored projection with:

- the compacted-through message id and timestamp;
- the previous compaction id;
- original/summary token counts and cumulative message count;
- strategy (`model` or `deterministic`), prompt version, provider, and model.

The preparer saves each compaction the moment it completes, so a run stopped, failed or retried
after it keeps it. The anchor is the last message row every one of whose provider messages the
summary replaced; a row the split falls inside stays in the next run's history whole, and the
recent tail kept word for word stays with it. A summary that reaches into the run's own work is
anchored at the run's request with the time it was made, so retrying or rewinding that reply
discards it, and records how many of that reply's provider messages it replaced
(`reply_message_id`, `reply_messages_covered`), found in order in the run's ledger. The next run
is sent only the rest of the reply; sent the whole reply again, it compacted as soon as it
started. A summary the run was stopped in the middle of is not recorded at all.

At request time, the main-process `ConversationRunPreparer` emits:

1. the composed system prompt;
2. the app-framed initial project-instruction message, when a project is active;
3. the latest anchored summary as an explicitly untrusted user-context block;
4. only transcript messages after the durable anchor.

Editing or rewinding history invalidates affected summaries. Forking a conversation copies only a valid summary and remaps its anchor to the forked message id.

## Incremental compaction

Prompt version `sidekick-compaction-v5` merges the prior anchored handoff with newly compactable events. Structured message serialization preserves tool input/status/approval/output/error, artifacts, decisions, file results, checkpoints, and bounded text instead of flattening everything into visible prose.

The planner retains a verbatim recent tail of 20% of context, bounded to 2,000–32,000 estimated tokens, and will not split an assistant tool request from its provider tool-result run. The user's latest request, their last message that is not a SideKick block (`<sidekick_… trust="app-policy">` or a compaction summary), always stays word for word right after the summary, even when a long run has pushed it out of the tail: left to the summary, a local model wrote an earlier question in as the objective, and the agent answered that one instead. The summary prompt names that request as the objective and puts requests already answered under Completed, and the system prompt tells the model that SideKick's blocks and summaries are not the user speaking. The initial project-instruction message is never summarized: it stays word for word ahead of the new summary, so a compaction in the middle of a run keeps the rules it started with, while the previous summary is folded into the new one. The summarized history is excerpted fairly across events to at most 120,000 characters, and to what fits the window, measured by the token estimate, beside the instructions, the previous summary and the summary's own room.

The summary request is streamed. Something in front of a slow local model gave up on requests that sent nothing until the whole reply was written, while streamed replies of the same length passed, so SideKick gives up only when the model makes no progress for five minutes. If the summary cannot be used, SideKick creates a bounded deterministic handoff with exact references and a warning to verify against the immutable transcript, and `compaction.completed` records why as `fallbackReason`: `timeout`, `connection_lost`, `server_unreachable`, `context_overflow`, `provider_error` (with `fallbackStatus` when there was one), `output_limit`, `reasoning_only` or `empty_output`.

## Complete request budget

The shared context-budget projection accounts for message text, tool calls, multimodal payload estimates, all tool schemas (including MCP), provider framing, in-flight response text, output reserve, and a safety margin. Compaction is evaluated against the lower of the configured threshold, as a share of the whole window, and the effective provider input limit. The output reserve is the model's reply limit up to 32,768 tokens: a larger limit is a ceiling a long reply may reach, and each request's reply limit is cut to the room the window has left, so prompt and reply never exceed it. A preflight check runs before every provider boundary, not only after a provider reports a context error. Compaction keeps up to 32,000 tokens of recent work verbatim, and gives the summary up to 16,384 output tokens so a reasoning model can finish it.

The estimate is deliberately conservative: it counts punctuation one by one, which real tokenizers merge, and ran 19–58% over local models' own counts. Each provider-reported prompt count calibrates it, in either direction: the next request is budgeted as the provider's count for what was already sent plus the estimate of what was added since, never under half the plain estimate. `usage.updated` records `estimatedPromptTokens` beside the provider's count, so a run starts from the latest pair an earlier run on the same model recorded, passing over runs stopped before any request finished, and as a share of the estimate when its request has shrunk since. Compaction therefore fires where the context card's marker says, measured the way the provider measures it.

Workspace mutations keep two projections: complete bounded diffs for expandable human review and a
compact model-facing acknowledgement. The model receives file paths, hashes, change counts, and only
a short diff preview, preventing repeated edits from turning the context into a copy of every prior
file version.

Long runs are bounded by capacity rather than a raw count of successful edits. The normal tool-round
pause is 500 rounds, adjustable from 10 to 2,000, and a continuous run stops after 45 minutes. Consecutive calls with identical
canonical arguments receive model-only advisory reminders at selected thresholds, while exact file
state revisits receive separate convergence guidance. Neither condition rewrites or blocks a
successful tool result: hard loop stops are reserved for repeated failures and the explicit global
run budgets.

The renderer stores every durable run event but coalesces live projection at the UI frame boundary.
It does not re-sort and rebuild the whole run transcript for every streamed token, and offscreen tool
rows use Chromium content visibility to avoid unnecessary layout and paint work.

`agent_runs` stores the trusted profile and prompt context, while sequence-numbered compaction events and `conversation_compactions` record actual model/deterministic strategy and why a fallback was used, prompt version, provider/model, anchors, token counts, and lineage. This makes unexpected compaction decisions diagnosable without logging prompt contents or secrets.

## Verification

Vitest covers platform/permission/model-family prompt matrices, capability omission, prompt-injection boundaries, immutable summary persistence/invalidation/forking, incremental chunking, deterministic fallback, recent-tail selection, tool-result boundaries, complete request budgeting, crash recovery, and provider → permission → tool → continuation → checkpoint composition.

When adding a prompt or provider projection:

1. state whether each input is instruction or data;
2. keep external/generated content out of system-role interpolation;
3. include fixed prompt/tool overhead in the request budget;
4. preserve transcript immutability and anchor derived context;
5. version material prompt changes and add an eval case.
