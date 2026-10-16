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
at the time JavaScript shifts it to; a time repeated by a fall-back change runs once.

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

A scheduled run has no permission input of its own. `ConversationRunPreparer` applies the
permission mode from Settings, exactly as for a chat the user started, and each run is a new
conversation, so no chat-scoped grant carries over from an earlier run. Where the mode requires
approval, the kernel suspends on its durable interaction. The existing attention tracker then
marks the chat as waiting, sets the taskbar badge, and lets the renderer notify. Nothing answers
the interaction for the user, and a run that waits holds off the schedule's next occurrence.

Cline instead auto-approves every tool in scheduled runs and disables questions. SideKick keeps
its approvals because the user, not the schedule, decides what an agent may do.

A schedule whose model is no longer enabled, or whose project was removed, pauses itself with a
reason rather than running with a fallback. A run whose start fails for another reason, such as an
unreachable provider, is recorded as failed, leaves an error notice in its chat, and keeps the
schedule's next time.

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
