# Schedules

A schedule sends a saved prompt to an agent at the times you choose: every hour, every day, on
weekdays, or once a week. Each run is an ordinary chat in the project folder you picked, with the
same tools and the same approvals as a chat you start yourself.

## Creating a schedule

Open **Schedules** from the calendar button at the top of the sidebar, or from the command
palette. Choose **New schedule**, or start from one of the suggestions, and fill in:

- **Name**, which also names the schedule's chats.
- **Prompt**, the message each run starts with.
- **Project folder**, or no project for a standalone chat.
- **Model**, from the models enabled in Provider settings.
- **Repeat**: Hourly at a minute past the hour, Daily, Weekdays (Monday to Friday), or Weekly on
  one day, each at a time you choose.

Times are in the computer's time zone. A daily run stays at its time when the clocks change for
daylight saving.

Each schedule shows its next run, its last run, and what it is doing now. From its row you can
**Run now**, **Pause** and **Resume**, **Edit**, and **Delete**. **Runs** lists every run with its
outcome; each run that started has a chat you can open. Deleting a schedule keeps the chats it
created.

## Chats in the sidebar

A schedule's chats are grouped into one sidebar row with the schedule's name and how many runs
it has. Open the row to see **Run 1**, **Run 2**, and so on, newest first. The row shows the same
marks as a chat: working, unread, or waiting for you. Pinning a run's chat takes it out of the
group.

## Approvals

A scheduled run never gets permissions you have not granted. It follows the
[permission mode](PERMISSIONS.md) from Settings, exactly as a chat would. Each run starts in a new
chat, so an earlier **Allow for this chat** does not carry over.

When a run needs your approval or an answer while you are away, it waits. Nothing is approved or
refused for you. The chat is marked as needing attention in the sidebar and on the taskbar badge,
and you get a desktop notification if notifications are on. Answer in the chat and the run
carries on.

A schedule runs one chat at a time. When its next time comes while the previous run is still
working or waiting for you, that time is skipped, and its runs list says why.

## When another agent is working in the project folder

A scheduled run never writes into a folder where another chat's agent is writing. If the project is
a Git repository, the run starts in a new worktree instead, and its history says so with the branch
name. Otherwise the run is skipped, and its history says it was skipped because the folder was busy.
Worktree setup hooks need your approval, so they do not run for a scheduled run's worktree.

When every run slot is in use, a scheduled run waits its turn and shows as queued. The next
occurrence is skipped while the previous run still waits for a slot.

## When SideKick is closed or the computer sleeps

Schedules run only while SideKick is running. A time that passes while SideKick is closed or the
computer is asleep is a missed run.

- With **Run once when SideKick starts or wakes** on, the default, missed times turn into one run
  that starts soon after SideKick opens or the computer wakes. It is marked as started late. Any
  earlier missed times are skipped, so a long absence never starts a burst of runs.
- With it off, missed times are recorded as skipped and the schedule waits for its next time.

## When a schedule pauses itself

If the schedule's model is no longer enabled, or its project folder was removed from SideKick,
the schedule pauses instead of running with something you did not choose. Its row says why. Edit
the schedule, then resume it. A run that cannot reach its provider is recorded as failed, its
chat explains why, and the schedule keeps its next time.
