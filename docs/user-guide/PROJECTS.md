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

### Project hooks

Agent settings include one **Project hooks** card for commands SideKick runs at
set moments in an exact absolute project folder: when a run starts, before the
final answer, or after creating a worktree. Choose the moment, the folder and
the command, add the hook, switch it on in the list and save settings. New hooks
are added switched off.

#### When a run starts

Start hooks run setup commands before the agent begins. SideKick does not search repositories for
executable hook files, and hooks do not automatically apply to subprojects or
new worktree paths.

Each matching hook requires approval before every agent run, including follow-up
messages and full-access mode. Commands run in listed order through the normal
command service, with output visible in the conversation. Denial or failure stops
before model sampling; inspect any partial side effects before starting again.
Plan mode and profiles without shell access do not run hooks. Commands use the
selected host or Docker shell environment; only approve trusted commands.

#### Before the final answer

Completion hooks use the same exact-folder matching, switched-off default,
ordered execution, and per-command approval. They run once before the final answer
of an ordinary Act conversation, not Plan or goal-driven runs. The preliminary
answer remains provisional while hooks run. Afterwards the agent receives the
results and the workspace verification gate runs again before completion.
Denial or failure stops the run rather than publishing a successful final answer.
Interrupted commands are not automatically replayed; inspect their actual effects
before retrying.

#### After creating a worktree

Worktree hooks are also added switched off. They match the
original project's exact folder and run when a chat forks into a new worktree or
starts in one, after the chat is saved there and before its first run.
Commands execute inside the new worktree, in
order, with a separate native approval for each command in every permission mode.
Skipping is the default. No repository Git hooks are discovered or enabled.

Each command has a two-minute limit and uses the selected host or Docker shell;
Docker failure never falls back to the host. Closing the requesting window or
quitting the app cancels active setup. Completion or failure is reported with
private output-log paths. Failure, denial, or interrupted setup preserves the
fork and any files already changed. Inspect those files before manually retrying;
commands are never automatically replayed. There are no automatic removal hooks.

### Worktrees

Two agents writing in one folder overwrite each other's work. A worktree is a separate copy of the
project, so each chat can work without touching another chat's files. A worktree belongs to its
chat: the chat stays in its project in the sidebar, marked with a branch icon, and only works in a
different folder. SideKick keeps worktrees in its private data folder, under `worktrees`, never
inside your project.

#### Starting a chat in a worktree

Before the first message of a project chat, the bar above the composer offers **Work in: This
folder** or **New worktree**. A new worktree starts **from** the branch the project folder is on,
or another branch you choose, as a copy of that branch with no branch of its own: Git lets a branch
be checked out in only one folder, and the project folder already has it. Sending the first message
creates the chat's worktree and then starts the agent there. SideKick remembers your
last choice for the next new chat. Worktrees need a project inside a Git repository; for any other
folder the bar says so and the chat works in the folder. A new chat outside any project shows
**Work in: No project** instead; choosing a project there moves the chat into it and offers both
choices.

Every new chat in a project gets the same choice, so two chats never share a worktree by accident.
A chat that already has messages keeps its folder. To move its work aside, fork it into a new
worktree. Uncommitted files stay in the original folder and are not copied into a new worktree.

Once a chat works in a worktree, the bar shows its branch, or "detached from main" until it has
one.

#### Finishing the work

A worktree's work never has to come back through the project folder. In the worktree, the agent
creates a branch when the work needs one, commits, and then merges into the base or pushes the
branch and opens a pull request. Once the work is merged, remove the worktree or delete its chat.
Each chat can have its own worktree, so several agents can each finish their own change this way.

#### When another agent is already working in the folder

If you send a message in a folder where another chat's agent is writing, SideKick asks before
starting:

- **Start in a new worktree** (a chat with no messages yet) or **Fork into a new worktree** (a chat
  with history, which opens the fork with your message ready to send).
- **Work here anyway**, when the two changes cannot overlap.

Closing the prompt leaves the message unsent in the composer. The rule also covers folders inside or
around the busy one, and runs started without the composer: SideKick's
runtime refuses a second writer in a busy folder unless the run was started to share it. Research
reports only read, so they are never held back. A worker chat set to work in its manager's folder
shares it by design; see [Chats that work together](CHATS_THAT_WORK_TOGETHER.md).

#### Older worktrees are set aside

SideKick keeps the 15 most recently used worktrees on disk. When there are more, it sets the least
recently used ones aside: it saves each one's commits and uncommitted files in a snapshot that Git
keeps under `refs/sidekick/worktrees/`, then deletes the folder. A worktree whose chat is running
or pinned is never set aside. Sending a message in the chat brings the worktree back as it was:
the same folder, commit, branch and files, with its changes unstaged. Files Git ignores, such as
installed dependencies, are not kept, so the agent may need to reinstall them.

#### Managing worktrees

**Manage** in the worktree bar, the settings icon beside **Work in**, or **Manage worktrees** in the
command palette opens the list. Each row shows the chat, the project and branch, and when it was
last used, marked **Working**, **Set aside**, or with its number of changed files.

- **Open its chat** switches to the chat, or starts one in the worktree.
- **Show the folder** opens it in your file manager. A set-aside worktree has no folder until its
  chat continues.
- **Remove** asks once, then deletes the folder with any uncommitted changes. Branches made in it
  stay in the repository with their commits. Its chats keep their history as chats outside any
  project.

Deleting a worktree's chat removes the worktree too. SideKick never removes a worktree while an agent works in it, or one it
cannot prove it created: the folder must have the exact shape SideKick uses inside its storage and
be registered with Git. Removal goes through `git worktree remove`; there is no recursive-delete
fallback. Links inside a worktree, such as a `node_modules` junction to a shared install, are
deleted as links first, so their targets are never emptied.

SideKick's worktree commands disable implicit Git hooks for that invocation without changing your
Git configuration. This is not a sandbox for arbitrary Git filters or manually executed commands.

### Pull request status

A line under the composer shows the GitHub pull request for the branch checked out in the chat's
folder, whether that is the project folder or a managed worktree:

- the pull request number, which opens it in your browser
- its state: draft, open, in a merge queue, merged, or closed
- merge status: ready to merge, conflicts, blocked, behind the base branch, or checks failing
- lines added and removed
- CI checks; click the summary to list each check, and click a check to open its log
- the branch name

When the branch has no pull request, **Create PR** opens GitHub's compare form for it. Push your
commits before you submit that form. SideKick never pushes, creates, or merges anything here; it
only reads.

Status refreshes every 30 seconds while the window is visible, when the window regains focus, and
from the refresh button. A failed refresh keeps the last status and shows a message you can dismiss.

The line needs the [GitHub CLI](https://cli.github.com/) installed and signed in with
`gh auth login`, and an `origin` remote on github.com over HTTPS or SSH. It is hidden for the
default branch, a detached HEAD, a folder that is not a Git repository, and other Git hosts. A
missing or signed-out GitHub CLI also hides it; SideKick checks again about every five minutes, so
the line appears shortly after you install or sign in to `gh`.

### Sidebar

The sidebar has two sections. Each heading folds its section away with its arrow, showing how many
items it holds while closed, and offers its own create action when you point at it:

- **Projects:** compact folder rows with collapsible nested conversations, new-chat, pin, rename, and
  remove actions; **+** opens a folder as a project.
- **Chats:** standalone conversations only; the pen starts one.

The layout button beside the SideKick name switches between two layouts. It shows a folder while
chats are grouped by folder and a clock while they are listed by recent activity, and SideKick
remembers your choice:

- **By folder:** the two sections above.
- **By recent activity:** every chat in one list, newest first, under Pinned, Today, Yesterday,
  Previous 7 days, and Older. Each row names its project, and rows keep their time order, so they
  cannot be dragged; use **Move to** instead.

The filter button narrows either layout to chats that **Need attention** (waiting on an approval or
an answer), are **Working**, or have an **Unread** reply. Its
menu counts each kind, and the button itself shows how many chats are waiting on you, even inside a
folded project. A filter opens every section and project so nothing it matches is hidden; clear it
with the **×** on the chip under the search box. Filters reset when SideKick restarts.

The **⋯** menu holds the rest: a new chat, the command palette, collapsing or expanding every
project at once, and clearing all chats. When the sidebar is collapsed, it also opens a project, as
it does in the recent-activity layout.

Chats that another chat started sit under it in both layouts; see
[Chats that work together](CHATS_THAT_WORK_TOGETHER.md).

Search spans the sections and labels project-backed results. The title bar and composer project pill
show the active project so folder context is never implicit.
