# Scheduled runs

A schedule starts an ordinary conversation run on its own. The main process owns the schedule,
its timer, and the run; the renderer only edits schedules and shows them. User behavior is in
[Schedules](../user-guide/SCHEDULES.md).

## Ownership

- `src/shared/schedules.ts` holds the contract: the schedule and run types, input validation, and
  `nextScheduleOccurrence`, a pure function from a schedule and an instant to the next matching
  local minute.
- `ScheduleStore` persists schedules and their run history in SQLite (`schedules`,
  `schedule_runs`) and marks each chat a schedule created with `conversations.schedule_id` and
  `schedule_run_number`. Deleting a schedule clears those columns and keeps the chats.
- `ScheduleService` decides when each schedule is due and what to do about it.
- The scheduled-conversation launcher creates the run's chat, with the prompt as its first user
  message, and calls `startConversationRun`, the same engine request the renderer's chat sends.
  `AgentRuntimeCoordinator` and `AgentRunKernel` then run it like any other conversation.
- `src/main/ipc/schedules.ts` validates renderer input, exposes `window.api.schedules`, and
  publishes `schedules:changed`. The renderer's `SchedulesDialog` and the sidebar's
  `ScheduledRunGroupRow` are projections of that state.

## Timing

Times are wall-clock times in the computer's time zone, built from local date parts, so a daily
run keeps its time across daylight-saving changes. A time skipped by a spring-forward change runs
at the time JavaScript shifts it to; a time repeated by a fall-back change runs once. An hourly
run is found minute by minute in real time, so it also runs in the hour a fall-back repeats.

The service keeps one timer, set for the earliest due schedule and never longer than a minute,
and also checks on `powerMonitor` resume and unlock. Each pass compares stored due times with the
clock instead of trusting a long timer, so sleep and clock changes cannot double or lose a run.
A due schedule is advanced, with a compare-and-set on its old due time, before its run starts;
an occurrence is handled once even if the run fails or the app crashes. Startup waits until the
runtime has recovered runs interrupted by the previous exit, so a run left over from a crash does
not look active.

## Missed runs

A due time more than two minutes in the past was missed: SideKick was closed or the computer
slept. With catch-up on, all missed occurrences of a schedule collapse into one late run that
starts on the first pass, and its history row counts the skipped ones. With catch-up off, one
skipped row records them. Either way, the next due time is computed from the current time. This
follows Cline's policy of one overdue catch-up, then advance.

## Overlap

A schedule holds at most one active run. When an occurrence comes due while the previous run is
queued, working, or waiting for the user, the occurrence is recorded as skipped with the reason.
Cline queues overlapping runs and keeps the newest; skipping is used here because a queue behind
an unanswered approval would only add more waiting chats. Different schedules run concurrently.

## Authorization

A scheduled run has no permission input of its own. A schedule stores a permission ceiling when it
is saved, which may not be looser than the setting at that moment. Its chats are created with
`started_by_kind = 'schedule'` and that ceiling in `conversations.permission_ceiling`, and the
chats they start copy it. `ConversationRunPreparer` and the `start_session` tool use
`effectivePermissionMode`: the setting, made stricter by the chat's ceiling, so a ceiling can only
take permissions away. Each run is a new conversation, so no chat-scoped grant carries over from an
earlier run. Where the mode requires
approval, the kernel suspends on its durable interaction. The chat status service then marks the
chat as waiting, sets the taskbar badge, and lets the renderer notify. Nothing answers
the interaction for the user, and a run that waits holds off the schedule's next occurrence.

A scheduled chat is a manager like any other: the family limits apply (eight live workers, workers
cannot start chats, twenty automatic turns), and starting workers asks the user unless the
effective mode is full access. The schedule treats a run and the chats it started as one run for
the overlap rule. No manager chat receives the scheduled chat's own report, so when its run
finalizes as completed with no family member still active, `ScheduleService` announces it once
with a desktop notification that opens the chat; the run's unread mark stays as for any reply.
Failures and waits reach the user through the status service as for any chat. The schedule's
history lists each run's workers with their latest phase.

Cline instead auto-approves every tool in scheduled runs and disables questions. SideKick keeps
its approvals because the user, not the schedule, decides what an agent may do.

A schedule whose model is no longer enabled, or whose project was removed, pauses itself with a
reason rather than running with a fallback. A run whose start fails for another reason, such as an
unreachable provider, is recorded as failed, leaves an error notice in its chat, and keeps the
schedule's next time. One that fails before its chat exists, such as a worktree that could not be
created, is recorded as failed with the reason and logged.

## Agent tools

The agent manages schedules through the same `ScheduleService` the dialog uses, from the main
process only; the renderer has no path to it. The tools are defined in `src/shared/scheduleTools.ts`
and implemented in `agentScheduleToolHandlers.ts`, which `ipc/schedules.ts` connects to the
`AgentToolRuntime` with read-only views of enabled models, projects, and the calling chat.

- **Progressive disclosure.** `schedules_list`, `schedules_create`, `schedules_update`, and
  `schedules_delete` belong to the bundled `schedules` skill. The catalog adds them only once
  `use_skill` has loaded it in the run (`SKILLS_WITH_GATED_TOOLS`); a later run that calls one is
  told to load the skill first. They need the `schedules` capability, which conversation runs
  have outside planning and read-only workers do not.
- **One decision per call.** The kernel asks the tool router how much each change needs.
  `requestedAccess` validates the call there, once, against the calling chat: arguments, an enabled
  model, an existing project, the prompt length, the ceiling, the scheduled-run rule, and the
  agent's limit. It records the decision by tool call. A valid decision returns `always`, so the
  kernel suspends on an approval in every mode with no chat-wide grant; the card's preview, with
  the prompt as a quote, is built from that same decision. An invalid one returns `auto` and is
  excluded from policy, so its handler refuses it without a card.
- **Save only what was shown.** The handler saves only a decision recorded as valid, and only if
  deciding the call again gives the same result, so nothing changes between the card and the
  write. A call that reaches the handler without a recorded decision saves nothing. A denial never
  reaches the handler.
- **Ceilings.** The ceiling defaults to the calling chat's effective permission mode and may not be
  looser; a change or resume is held to the same rule for the schedule's resulting ceiling, while a
  pause, which only takes permissions away, is not. `ScheduleService` still enforces the setting.
- **No self-propagation.** A chat a schedule created, or one such a chat started, cannot create,
  change, or resume schedules; it may pause or delete them. At most
  `AGENT_ACTIVE_SCHEDULE_LIMIT` (ten) enabled schedules may have been created by the agent.
- **Provenance.** A schedule the agent created stores `created_by_kind = 'agent'` and
  `created_by_conversation_id`, which becomes null if that chat is deleted. The dialog labels it
  with that chat.

## Renderer

`useSchedules` loads the list and follows `schedules:changed`. Each schedule reports its active
run, so the sidebar can mark a scheduled chat as working even when no panel has it open; the list
refreshes when that run's `run.completed` event arrives. `groupScheduledConversations` collapses a
schedule's chats into one sidebar row at the position of its newest run, with "Run N" rows inside,
the way Cline groups scheduled sessions. Pinned chats stay where the user put them.

## Dependencies

Schedules run only while SideKick is running. On Windows and Linux, closing the main window quits
the app unless SideKick keeps running in the background; later occurrences are then missed runs.

## Reference

Cline (`cline/cline` at `23791b9`, Apache-2.0) informed the sidebar grouping, run numbering,
starter suggestions, and the missed-run policy. SideKick's implementation, data model, and
authorization behavior are independent; no Cline code was copied.
