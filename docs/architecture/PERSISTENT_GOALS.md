# Persistent conversation goals

SideKick goals let a user attach one durable objective to a normal conversation and let the agent
continue working across model turns until the objective is genuinely complete, the user pauses or
clears it, or the same real blocker is confirmed repeatedly.

## Product contract

- One unfinished goal may be attached to a conversation. Parallel goals belong in parallel chats.
- The goal text is both the first user request and the completion criterion. Strong goals state the
  outcome, constraints, and concrete verification.
- A compact row above the composer exposes status, objective, plan progress, pause/resume, edit,
  and clear. Follow-up messages preempt a running continuation and steer the same conversation.
- Goals do not change the selected model's tools, project boundary, permission mode, or approval
  policy. A tool-incapable model cannot start a goal because it cannot report verified completion.
- Pausing or clearing cancels the current run safely. A restart converts an active goal to paused
  rather than silently resuming filesystem or shell work.
- Completion requires a non-empty summary, concrete verification, and no unfinished durable plan
  items. A low token budget, one finished response, or difficult work is not completion.
- `blocked` is terminal only after the same normalized blocker is reported on three consecutive
  goal turns. A different blocker resets the streak. A specific user decision uses `ask_user`
  instead of abusing blocked status.

## Architecture

Goals are a control plane over the existing agent runtime, not another provider loop.

- `conversation_goals` stores the current objective, revision, state, continuation count, cumulative
  token usage, plan, completion evidence, blocker streak, and active run identity.
- `conversation_goal_events` is the append-only control-plane audit.
- `ConversationGoalStore` owns lifecycle invariants and publishes serializable snapshots.
- `ConversationRunPreparer` loads an active goal, adds the app-authored completion contract, enables
  the goal-scoped `update_goal` tool, and connects run todos to the durable goal plan.
- `AgentRunKernel` remains the only model → tool → continuation loop. At an otherwise terminal text
  turn, a small goal controller either ends because the durable status is terminal or injects an
  app-authored continuation message into the same transcript.
- `AgentToolRuntime` exposes `update_goal` only for goal sessions. The tool is safe control-plane
  metadata and never bypasses ordinary tool authorization.
- The renderer uses the narrow `conversationGoals` preload API. It does not decide whether a goal
  is complete or execute the continuation loop.

The goal plan reuses `manage_todo_list`: writes remain per-run for audit while the latest goal plan
is also copied into durable goal state and displayed in the Tasks panel.

## Continuation and steering

The first goal run begins from the visible objective message. If a terminal model turn does not
call `update_goal`, the kernel appends a trusted continuation instruction and starts the next model
turn. Tool calls, compaction, permissions, questions, cancellation, provider retries, and streaming
therefore retain their normal semantics and one run/event identity.

A real user follow-up always wins. While the goal is running, SideKick pivots even when the normal
chat preference is queue, stops the current run, persists the user's message, resumes the same goal,
and starts a fresh canonical run. This makes steering visible in ordinary conversation history and
avoids racing old and new instructions.

## Acceptance coverage

- Store tests cover one-goal ownership, persistence, plan-gated completion, repeated blockers, and
  restart pausing.
- Kernel tests cover automatic continuation after a terminal text response.
- Catalog tests prove `update_goal` is absent from ordinary runs and present only when explicitly
  enabled by goal preparation.
- The full release check must continue to cover type safety, lint, all unit/integration suites, and
  the production renderer/main build.
