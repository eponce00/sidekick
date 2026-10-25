---
id: schedules
name: Schedules
icon: CalendarClock
description: 'Load when the user wants something done on a schedule, such as every weekday at 9 or every hour, or asks to see, change, pause, resume, or delete their schedules.'
invocation: auto
activationScope: run
---

# Schedules

A schedule sends a saved prompt to a new agent run at the times it gives, in the project and with the model it names. Loading this skill adds `schedules_list`, `schedules_create`, `schedules_update`, and `schedules_delete` to this run.

## Look first

Call `schedules_list` before creating or changing anything. It shows the user's schedules with their state, next run and recent runs, and what a schedule can use: project ids, enabled model ids, this chat's project, model and permission mode, and how many active schedules the agent has made out of its limit. When the user asks about their schedules, answer from it in plain words.

## Turn the request into a schedule

For "every weekday at 9, check X", decide each field:

- **name**: a few words the user will recognise in the sidebar, such as "Weekday dependency check".
- **prompt**: what each run is asked to do, written to stand alone. A run starts in a new chat and cannot see this conversation, so spell out what to check, where, what to report, and what counts as a problem. Name files, URLs, and commands in full instead of saying "it" or "the thing we discussed". Keep instructions the user gave, such as "do not change anything". Do not include secrets.
- **cadence** and **time**: `hourly`, `daily`, `weekdays` (Monday to Friday), or `weekly` with a `weekday`; `time` is 24-hour local time, such as `09:00`. "Every morning" is daily; "on workdays" is weekdays. An hourly schedule uses only the minutes.
- **project_id**: the project the run works in. It defaults to this chat's project; use `"none"` for a standalone chat.
- **model_id**: defaults to this chat's model. Use another enabled model only when the user names one.
- **each_run**: `new` (the default) gives each run a fresh chat. Use `continue` when each run should build on the last, such as a running log or a weekly comparison with the week before.
- **permission_ceiling**: the most a run may do without asking. It defaults to this chat's permission mode and can never be looser. Choose `always-ask` or `sensitive-only` when the run only needs to read and report; say so to the user.
- **catch_up**: leave it on unless the user says a missed time should be skipped.

## Ask instead of guessing

Ask the user, with `ask_user` or in your reply, before creating a schedule when:

- the time is vague or missing ("in the mornings", "regularly", "every so often"), or a 12-hour time could be either half of the day;
- it is unclear which project the run should work in, for example when the chat has no project but the task is about a repository, or the user has several projects that fit;
- the frequency or the day of a weekly run is not stated.

Do not ask about fields that have a sensible default above.

## Approval

The user approves every create, change, pause, resume, and delete on a card that shows exactly what will be saved, including the whole prompt, whatever their permission mode. Nothing is saved until they approve. If they deny it, nothing was saved: say so, and do not try again unless they ask. Make one call per schedule and wait for its result.

Pause a schedule with `schedules_update` and `enabled: false` instead of deleting it when the user only wants it to stop for a while. Delete only when the user asks to.

## Limits

- A run that a schedule started, and the chats it starts, cannot create schedules, and may only pause or delete them.
- The agent may have at most the number of active schedules `schedules_list` reports as its limit. When it is reached, tell the user they can pause or delete one in Schedules, or create the new one there themselves.
- Schedules run only while SideKick is running, in the computer's time zone.

After saving, tell the user its name, when it runs next, and that they can pause or delete it from Schedules, where it is labelled with this chat.
