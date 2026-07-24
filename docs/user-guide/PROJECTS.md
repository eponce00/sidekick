# Projects and conversations

SideKick treats a project as a durable, folder-backed context boundary and a conversation as one
focused thread within that boundary. This follows the current Codex desktop model while preserving
standalone chats for work that does not belong to a folder.

## Product model

- A project has a stable identity, display name, local folder, pin state, and its own conversation
  collection.
- A project conversation inherits the project folder, file tools, command working directory,
  checkpoints, project memory, and instruction files.
- A standalone conversation has no project folder and therefore does not silently inherit file or
  command context from the last project that happened to be open.
- The global New Chat action creates a standalone chat. The plus action beside a project creates a
  chat inside that project.
- A never-attached standalone conversation may enter one project. That canonical folder becomes its
  durable affinity. It may later detach to Chats and reattach only to that same folder; direct or
  indirect moves between different projects are rejected.
- Removing a project never deletes or changes its folder. Its conversations are retained as
  detached chats with project History visible but read-only until the original folder is reopened
  and the chat is reattached.

## Persistence and activation

`projects` stores the project identity and canonical folder path. `conversations.project_id` is the
source of truth for membership; `NULL` means standalone.

When a conversation is activated, the renderer resolves its project and updates the trusted
main-process workspace before rendering the conversation as active. File tools, shell commands,
memory, checkpoints, and the file explorer continue to use the main-process workspace boundary, but
that boundary is now derived from the active conversation instead of being an unrelated global UI
preference.

Workspace History is private application data and remains separate from a folder's own Git
repository. See [Private workspace History](WORKSPACE_HISTORY.md) for ownership, conflict, restore,
and lifecycle rules.

## Project instructions

Instructions are read again before every agent run so edits take effect without restarting SideKick.
Discovery follows the Codex/OpenCode directory-scope model within the project boundary:

1. Load the first user-wide file found at `~/.sidekick/AGENTS.override.md`,
   `~/.sidekick/AGENTS.md`, or `~/.agents/AGENTS.md`.
2. Load the SideKick-specific project-root additions, `SIDEKICK.md` and `.sidekick/rules.md`.
3. Walk from the project root toward the current file or command working directory. In each
   directory, use `AGENTS.override.md` when present; otherwise use `AGENTS.md`.
4. Concatenate instructions from broadest to most specific, so later nested instructions take
   precedence only inside their directory tree.
5. Bound individual and combined instruction sizes, cache unchanged files by metadata, and show
   source/truncation diagnostics in the composer.

The initial block contains global and project-root rules. During an agent run, file reads, recursive
search matches, commands with a deeper `cwd`, and file mutations resolve newly applicable nested
rules once per scope. A mutation is never performed in the same tool call that first discovers a
nested rule; the model receives the rule and retries after reviewing it. Direct chats, independent
group agents, and sub-agents use this same resolver and preserve the current user's request as the
higher-priority task.

## Interface

The sidebar has two explicit sections:

- **Projects:** compact folder rows with collapsible nested conversations, new-chat, pin, rename, and
  remove actions.
- **Chats:** standalone conversations only.

Search spans both sections and labels project-backed results. The title bar and composer project pill
show the active project so folder context is never implicit.
