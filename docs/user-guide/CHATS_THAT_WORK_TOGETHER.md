# Chats that work together

A chat can start other chats and hand each one part of a task. The chat that starts them is
their **manager**; the chats it starts are its **workers**. Each worker is an ordinary chat with
its own transcript and model, usually working in its own Git worktree. When a worker finishes,
its last message goes back to the manager as a report. You can open any of them, read along and
type into it.

Use this when work splits into parts that can run at the same time and touch different files,
or that belong to different projects. For a short side question whose answer the agent needs
right away, it uses a sub-agent instead, which runs inside its reply and has no chat of its own.
Several chats cost several times the model use of one, so a single chat stays the right choice for
work that is sequential or touches the same few files.

## Starting chats

Ask for it in plain words, such as "split this into parallel chats for the card, the toggle and
the settings window". The agent writes each worker a brief: the task, the files or area it owns,
and what done looks like. A worker does not see the manager's conversation unless the agent
chooses to copy it, which it can only do when the conversation fits comfortably in the worker's
model.

What happens next depends on the [permission mode](PERMISSIONS.md):

- In **Full access**, the chats start at once and the manager shows a **Started N chats** row.
- In the other modes, the reply pauses on a **Start N chats?** card listing each chat with its
  project, where it works, and its model. You can change the project and where each one works,
  then press **Start** or **Not now**.
- A project the manager has not used for workers before always asks first, in every mode.
  Starting from the card allows the manager to start chats there from then on.

Where a worker works:

| Choice                     | Meaning                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New worktree** (default) | Its own managed worktree, starting from the base without a branch of its own, so its edits never mix with other chats' edits. It creates a branch when its work needs one. |
| **This folder, shared**    | The manager's folder. Choosing it is the decision to share the folder with the other writers.                                                                              |
| **This folder, read-only** | The manager's folder, without tools that edit files, run commands, or use the browser.                                                                                     |

Worktrees are managed as described in [Projects](PROJECTS.md). For work you did not ask for, the
agent suggests a chat instead of starting it: a dashed card with **Start** and **Dismiss**.
Suggestions expire after a week.

## Following the work

- **Sidebar.** Workers sit under their manager on a thin guide line, with their own status dot. A
  worker that needs you marks its manager too, and the manager shows a short summary such as
  "1 needs you · 2 working". A worker in another project stays with its manager and shows that
  project as a tag.
- **Manager chat.** Reports and requests fold into **Received N messages** rows between the
  manager's replies. Its task list stays under the latest reply, with each step's chat and state.
  A strip above the composer counts the workers by state and offers **Stop all**.
- **Chats tab.** The inspector lists every worker with its state, branch, commits ahead and changed
  files, and buttons to open, message or stop it.
- **Worker chat.** A breadcrumb leads back to the manager, a banner says who started it and where
  its reports go, and the brief shows as a card. The **Details** tab shows the whole family, so you
  can move between its chats.

## Messages and reports

When a worker's reply ends, its final message goes to the manager as a report, together with the
facts SideKick knows, such as its branch. A worker that fails or is stopped reports that too.

The manager wakes to read reports only once none of its workers is still working, so it sees the
results together. A worker blocked on the manager can send a request, which wakes the manager at
once. Other messages between chats wait until the receiving chat's next step. A message sent to
the whole family never wakes anyone.

Chats in a family can attach text files of up to 1 MB to a message. The receiving chat can import
an attachment into its own project as a new file; it never overwrites an existing one.

If chats keep waking each other, a chat that has been started 20 times in a row by other chats,
with no message from you in between, pauses with a notice. Send it a message to continue.

## Stepping in

- Type into any worker. Your message goes to that chat only, and its next report says you stepped
  in, so the manager does not undo your direction.
- Approvals and questions from a worker appear in that worker's chat, naming the worker, its
  manager and its worktree. Only you can answer them; a message from another chat cannot approve
  anything.
- **Stop** a worker from its chat, its row in the Chats tab, or **Stop all** in the manager.
- **Detach** a worker from its Details tab or the manager's Chats tab to turn it into an ordinary
  chat that no longer reports. Deleting a manager detaches its workers; it never deletes them.

## Limits

- Four chats, scheduled runs and sub-agents work at once by default; more wait in a queue and show
  as queued. Change the limit, from 1 to 8, with `sidekick config set maxConcurrentRuns <n>` (see
  [Command line](COMMAND_LINE.md)). A model server on this computer also takes one request at a
  time by default, and a hosted one four.
- A manager can have eight workers that are not archived.
- Workers cannot start chats of their own.

## After a restart

Replies that were running when SideKick closed are marked interrupted, as in any chat, and an
interrupted worker shows as failed. Open it to continue its reply as you would any interrupted
reply; nothing resumes on its own. Its manager receives one note listing what was interrupted and
is not woken by it. Messages and reports that
had not been delivered are kept and delivered on the chat's next reply.

## Safety

- A worker gets no tool its manager could not have, and a read-only worker loses every tool that
  edits or executes. Every worker follows your permission mode. An **Allow for this chat** answer
  in the manager does not carry over to its workers.
- Each worker works in exactly one folder: its own worktree, or its project folder. It cannot read
  the manager's folder or another worker's worktree unless that is its own folder; information
  moves between them only through messages and attachments.
- Messages from other chats reach the model marked as untrusted information. They cannot change a
  chat's instructions or permissions.

## Group chats from earlier versions

SideKick used to coordinate two project agents in a group chat. On upgrade, each group becomes a
manager chat in the Chats section, titled after the group, with one worker per project agent.
The manager keeps the group's shared messages: yours as your messages, and each agent's posts as
messages from that agent's worker. Each worker keeps the agent's own replies. Tool traces and group
missions are not carried over. The database is backed up before the upgrade runs.
