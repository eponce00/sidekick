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
- **Each run**: **Start a new chat**, so every run begins fresh, or **Continue the last chat**, so
  each run adds the prompt to the previous run's chat and can build on what earlier runs found and
  did. See [Continuing one chat](#continuing-one-chat).
- **Without asking, runs may**: the most a run may do before it asks you. It starts at your
  [permission mode](PERMISSIONS.md) and can only be stricter, such as **Ask before every change
  or command** for a schedule you want to review step by step.

Times are in the computer's time zone. A daily run stays at its time when the clocks change for
daylight saving.

Each schedule shows its next run, its last run, and what it is doing now. From its row you can
**Run now**, **Pause** and **Resume**, **Edit**, and **Delete**. **Runs** lists every run with its
outcome; each run that started has a chat you can open, and the chats it started are listed
under it with their state. Deleting a schedule keeps the chats it created.

## Asking the agent

You can also ask SideKick in a chat, for example "every weekday at 9, check the build and tell me
what failed". The agent loads its Schedules skill, which lets it list your schedules with their
recent runs and create, change, pause, resume, or delete them. It writes a prompt that stands on its
own, since each run starts without this chat, and it asks you when the time or the project is not
clear. Unless you say otherwise, a new schedule uses this chat's project, model, and permission mode,
and starts a new chat for each run.

Every create, change, pause, resume, and delete asks you first, whatever your
[permission mode](PERMISSIONS.md), even Full access. The card shows exactly what will be saved:
the name, the whole prompt as the agent wrote it, the project, the model, how often it repeats and
when it runs next, whether each run starts a new chat or continues the last one, and what runs may
do without asking. A change also shows what it changes from. Nothing is saved until you choose
**Allow once**; if you deny it, the agent is told nothing was saved. **Allow for this chat** is not
offered.

The agent is held to a few limits:

- A schedule it saves may never do more without asking than the chat that asked for it. In a chat
  that asks for sensitive actions, its schedules ask at least as often.
- A scheduled run, and the chats it starts, cannot create schedules, and can only pause or delete
  them.
- At most ten schedules the agent made can be active at once. It asks you to pause or delete one,
  or to create the new one here yourself, when the limit is reached.

A schedule the agent made says so in **Schedules**, with a link to the chat it was asked in. Pause
or delete it from its row like any other.

## Chats in the sidebar

A schedule's chats are grouped into one sidebar row with the schedule's name and how many runs
it has. Open the row to see **Run 1**, **Run 2**, and so on, newest first. The row shows the same
marks as a chat: working, unread, or waiting for you. Pinning a run's chat takes it out of the
group.

## Continuing one chat

A schedule set to **Continue the last chat** keeps one chat, named after the schedule. Each run
adds the prompt as the next message and works in the same folder or worktree as before, so the
model sees the earlier runs' answers and tool results. As the chat grows, SideKick condenses older
turns to fit the model, the same way it does for any long chat.

A run starts a new chat instead, and its history says why, when the last run's chat was deleted or
archived, its worktree was removed, or the schedule now works in another project. A run is skipped
while the previous one is still working or waiting for you, or while another chat's agent is
writing in the folder the schedule's chat works in.

## Approvals

A scheduled run never gets permissions you have not granted. It follows the
[permission mode](PERMISSIONS.md) from Settings, made stricter by the schedule's own limit when it
has one. If you later make Settings stricter, runs follow Settings; making Settings looser never
loosens a schedule. A run in a new chat does not inherit an earlier **Allow for this chat**. A run
that continues the last chat keeps what you allowed in that chat while SideKick stays open; after
a restart, it asks again.

When a run needs your approval or an answer while you are away, it waits. Nothing is approved or
refused for you. The chat is marked as needing attention in the sidebar and on the taskbar badge,
and you get a desktop notification if notifications are on. Answer in the chat and the run
carries on.

A schedule runs one chat at a time. When its next time comes while the previous run, or a chat it
started, is still working or waiting for you, that time is skipped, and its runs list says why.

## Chats a scheduled run starts

A scheduled run can start other chats to split up its work, as any chat can. They nest under the
run's chat in the sidebar, follow the same limit as the run, and send their results back to it.
Starting them follows the schedule's limit: unless it allows full access, the run asks you first
and waits. A run starts at most eight chats, and those chats cannot start chats of their own.

No chat is watching a scheduled run, so it reports to you. When the run's chat finishes and none of
the chats it started is still working, the chat is marked unread, and you get a desktop
notification with its answer if notifications are on and SideKick is not in front. Clicking the notification opens the chat. A
run that fails or waits for you is announced the same way any chat's is.

## When another agent is working in the project folder

A scheduled run never writes into a folder where another chat's agent is writing. If the project is
a Git repository, the run starts in a new worktree instead, and its history says so with the branch
name. Otherwise the run is skipped, and its history says it was skipped because the folder was busy.

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
