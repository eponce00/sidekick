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

Live web artifacts are deliberately run-scoped. Their rendering tool is absent from the provider's
initial tool list and becomes available only after the model loads the `web-artifacts` skill. An
artifact is an interactive result inside the chat. Websites, landing pages, web apps, components,
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

Utility prompts for titles, checkpoint labels, web extraction, research, and sub-agents use the same data boundary. Source text is never interpolated as a system instruction. Research output is proportional to the question rather than forced into a fixed “exhaustive” length.

## Immutable transcript and provider projection

Compaction never deletes or rewrites messages. `conversation_compactions` stores a derived, anchored projection with:

- the compacted-through message id and timestamp;
- the previous compaction id;
- original/summary token counts and cumulative message count;
- strategy (`model` or `deterministic`), prompt version, provider, and model.

At request time, the main-process `ConversationRunPreparer` emits:

1. the composed system prompt;
2. the app-framed initial project-instruction message, when a project is active;
3. the latest anchored summary as an explicitly untrusted user-context block;
4. only transcript messages after the durable anchor.

Editing or rewinding history invalidates affected summaries. Forking a conversation copies only a valid summary and remaps its anchor to the forked message id.

## Incremental compaction

Prompt version `sidekick-compaction-v2` merges the prior anchored handoff with newly compactable events. Structured message serialization preserves tool input/status/approval/output/error, artifacts, decisions, file results, checkpoints, and bounded text instead of flattening everything into visible prose.

The planner retains a verbatim recent tail of 20% of context, bounded to 2,000–8,000 estimated tokens, always keeps the latest user turn/current assistant work, and will not split an assistant tool request from its provider tool-result run. Large histories are summarized in budgeted chunks. If the utility provider fails, SideKick creates a bounded deterministic handoff with exact references and a warning to verify against the immutable transcript.

## Complete request budget

The shared context-budget projection accounts for message text, tool calls, multimodal payload estimates, all tool schemas (including MCP), provider framing, in-flight response text, output reserve, and a safety margin. Compaction is evaluated against the lower of the configured threshold and the effective provider input limit. A preflight check runs before every provider boundary, not only after a provider reports a context error.

`agent_runs` stores the trusted profile and prompt context, while sequence-numbered compaction events and `conversation_compactions` record actual model/deterministic strategy, prompt version, provider/model, anchors, token counts, and lineage. This makes unexpected compaction decisions diagnosable without logging prompt contents or secrets.

## Verification

Vitest covers platform/permission/model-family prompt matrices, capability omission, prompt-injection boundaries, immutable summary persistence/invalidation/forking, incremental chunking, deterministic fallback, recent-tail selection, tool-result boundaries, complete request budgeting, crash recovery, and provider → permission → tool → continuation → checkpoint composition.

When adding a prompt or provider projection:

1. state whether each input is instruction or data;
2. keep external/generated content out of system-role interpolation;
3. include fixed prompt/tool overhead in the request budget;
4. preserve transcript immutability and anchor derived context;
5. version material prompt changes and add an eval case.
