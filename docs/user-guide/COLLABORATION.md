# Project agent collaboration

A group chat coordinates exactly two independent, project-bound agents. It is useful when a task
crosses two projects or can be split into non-overlapping missions that still need one shared public
channel.

## Model

- The group has one user-visible conversation and two named participants, each attached to its own
  SideKick project.
- Each participant has its own model, private run transcript, context budget, todo state, and
  permission suspensions.
- Public messages form the coordination record. Private provider prompts and intermediate reasoning
  are not copied between participants.
- Each participant receives an explicit mission inside its own project before mutating files.
- A participant can be idle, running, waiting, blocked, complete, failed, or cancelled. Addressing
  an idle participant in the public channel wakes it with the new context.

Both agents run through the same trusted kernel and project boundary as an individual chat. They do
not receive a second provider runtime or unrestricted cross-session access.

## Coordination tools

`collaboration_read` reads bounded public messages. `collaboration_send` posts a durable message to
the group. `collaboration_status` reports participant state, and
`collaboration_claim_complete` records a participant's result and evidence.

File exchange uses immutable UTF-8 artifact snapshots:

- `collaboration_share_file` publishes a bounded snapshot from the active project.
- `collaboration_list_artifacts` lists available snapshots and provenance.
- `collaboration_import_artifact` imports a selected snapshot through the normal transactional
  mutation service and permission policy.

An artifact is not a live shared filesystem handle. It cannot read outside the project, silently
track later changes, or bypass conflict checks at import time.

## Recommended workflow

1. Give the group a result-oriented objective and assign two scopes with no overlapping files.
2. Ask each participant to post its interpretation, dependencies, and intended verification before
   editing.
3. Let the agents work independently, using the public channel for interface changes and blockers.
4. Import shared artifacts only when a snapshot is clearer than coordinating ordinary project
   files.
5. Require each participant to post changed paths, verification evidence, and remaining risks
   before claiming completion.
6. Run an integration check over the combined project state.

Use an individual chat when work is sequential, touches the same small set of files, or does not
benefit from independent context. Collaboration increases provider use and coordination overhead;
it is not a faster default for every task.

## Safety and recovery

Permissions are resolved per participant through the same policy as normal runs. A suspended
permission or question survives reload, cancellation is durable, and the event ledger reconstructs
participant state after restart. Workspace writes still require current read receipts and pass
through transactional validation, snapshots, and revision-based verification.

The group remains project-bound. Neither participant can access another SideKick project, another
group's private transcript, or arbitrary application data through collaboration tools. See
[Tools](TOOLS.md), [Permissions](PERMISSIONS.md), and the
[architecture](../architecture/OVERVIEW.md) for the underlying enforcement boundaries.
