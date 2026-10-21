# Worktree isolation for parallel agents

Status: design note. Shipped behavior is described in [Projects](../user-guide/PROJECTS.md); this
file keeps only the reasoning and the work that is still open.

## Problem

Several agents can work in one folder at once: two chats in the same project, a scheduled run, or
a chat started by another agent. They read stale files, overwrite each
other's edits and mix unrelated changes into one diff. SideKick already had managed Git worktrees,
but only for "fork into a new worktree", with no way to see, sync or remove them, and nothing
stopped a second run from writing into a busy folder.

## How other harnesses do it

Checked October 2026 against official documentation, or source where noted. "Unverified" means the
documentation did not say.

| Harness                                                                                                                                                    | Unit and location                                                                                                                                                                                                         | Branch and base                                                                                                                                                       | Cleanup and safety                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code ([worktrees](https://code.claude.com/docs/en/worktrees), [desktop](https://code.claude.com/docs/en/desktop))                                   | One session per worktree in `.claude/worktrees/<name>`; desktop has a per-session toggle, a location setting and a branch prefix.                                                                                         | `worktree.baseRef`: remote default branch after a short fetch, or local HEAD.                                                                                         | A clean worktree is removed on exit; changed files or new commits ask keep or remove, and an unverifiable state asks too. A sweep removes only worktrees carrying Claude's marker, while running agents hold `git worktree lock`. On Windows removal deletes junction links, not their targets. Archiving a desktop session removes its worktree. |
| Codex app and cloud ([worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees))                                                               | Local or Worktree mode per thread; worktrees in `$CODEX_HOME/worktrees`.                                                                                                                                                  | Chosen start branch, uncommitted changes carried over; detached HEAD until "Create branch here" (`codex/` prefix). Handoff moves a thread between Local and Worktree. | Keeps the 15 newest; pinned, running and "permanent" ones are protected. A snapshot is saved before deletion and restored if the chat reopens. Setup scripts per OS run on creation. Cloud tasks run in their own environment and end as a commit or PR.                                                                                          |
| Cursor ([worktrees](https://cursor.com/docs/configuration/worktrees))                                                                                      | A worktree per agent; `/worktree`, `/apply-worktree`, best-of-N.                                                                                                                                                          | Unverified.                                                                                                                                                           | Interval cleanup keeping up to 25 per machine; `.cursor/worktrees.json` setup scripts. Up to 8 parallel agents.                                                                                                                                                                                                                                   |
| Conductor ([workspaces](https://www.conductor.build/docs/concepts/workspaces-and-branches), [scripts](https://www.conductor.build/docs/reference/scripts)) | A workspace is one worktree with a generated name; the agent renames the branch on first chat.                                                                                                                            | `origin/<base>` after a fetch.                                                                                                                                        | Setup, run and archive scripts with workspace path and a per-workspace port block; archived workspaces and their chats can be restored. States plainly that isolation is not a security boundary.                                                                                                                                                 |
| Cline Desktop (source, `cline/cline@23791b93`, `apps/examples/desktop-app`)                                                                                | "Work in" local or worktree, chosen for a new thread's first prompt (`webview/lib/work-in-selection.ts`); worktrees in `<cline dir>/worktrees/<id>/<repo>` and hidden from the workspace list (`lib/workspace-paths.ts`). | `cline/<id>` from HEAD.                                                                                                                                               | Deleting the session removes the worktree only when the path has the exact generated shape and no other session works in or under it; only the generated branch is deleted. The delete dialog warns that uncommitted changes go too (`sidecar/commands-git-worktree.test.ts`).                                                                    |
| OpenCode (source, `anomalyco/opencode@83c5abbb`, `packages/core/src/worktree.ts`)                                                                          | Project-owned worktrees recorded in SQLite under the global data folder.                                                                                                                                                  | Detached at HEAD or a given ref; project start commands run afterwards.                                                                                               | Only recorded worktrees can be removed; records whose folder vanished are dropped after `git worktree list --porcelain`.                                                                                                                                                                                                                          |

What SideKick takes from this:

- Keep worktrees outside the user's checkout and remove only what SideKick provably created: the
  exact folder shape, the recorded branch, and registration in `git worktree list` (Cline, OpenCode,
  Claude Code).
- Short generated names: a slug and six random hex characters (Claude Code desktop), or a short
  generated word (Conductor).
- Classify before removing and explain each refusal; forced removal keeps unmerged branches unless
  asked (Claude Code, Cline).
- Choose "Work in" for a new chat's first message, with a remembered default (Cline, Codex).
- Protect running work from cleanup and refuse a second writer in the same folder (Codex, Claude
  Code locks).
- Delete links found inside a worktree as links before removal, so a junction to a shared
  `node_modules` can never take its target with it (Claude Code on Windows).

## Design

One managed-worktree service in the trusted main process owns creation, inventory, setting aside,
restoring and removal. The renderer only asks for those operations by identity; it never passes paths.

- **Location and names.** A new worktree lives beside its repository, in
  `<repository>.worktrees/<slug>-<6 hex>`, where the slug is at most 20 characters of a worker's
  handle or the chat's title. Worktrees used to live in SideKick's private data folder,
  `worktrees/<source project id>/<slug up to 32>-<8 hex>`, which on Windows put about 110–130
  characters in front of every file in the checkout, so deep paths crossed the 260-character limit
  that some tools still have. Three places were weighed:
  - Inside the repository, as Claude Code's `.claude/worktrees/<name>`: short and easy to find, but
    the worktree is then inside the project folder. A manager writing there would count as
    occupying its workers' folders, its path containment would reach their files, and every tool
    that walks the project (search, file watchers, indexers, test and build globs) sees each worktree
    unless the user's ignore files say otherwise. It also needs an entry in `.git/info/exclude`.
    Claude Code users have asked for another location for these reasons.
  - Private storage (Codex, Cline, OpenCode): never seen by the project's tools, but the
    path is long and has nothing to do with the project.
  - Beside the repository (the layout Git's own documentation and Claude Code's manual-worktree
    examples use): outside the checkout, so containment, occupancy and `git status` are unchanged,
    and only about 38 characters longer than the repository's own path.

  SideKick uses the folder beside the repository. When it cannot (a repository at a drive root, a
  parent folder inside another repository, a link where the folder would go, or no write access) the
  worktree goes in private storage as before. Existing worktrees are not moved.

- **A worktree belongs to its chat** (Codex, Claude Code, Cursor, Cline). The chat keeps its
  project; `conversations.worktree_id` points at the worktree, and
  `ProjectStore.getConversationContext` resolves the chat's folder to the worktree's. Worktrees
  used to be projects of their own ("project · from main"), which cluttered the sidebar and let a
  new chat started there share another chat's worktree; migration
  `20261021_001_worktrees_belong_to_chats` moved their chats back to the source project and
  removed those projects. A fork in the current folder shares its source's worktree; a worker that
  works in its manager's folder shares the manager's.
- **Base.** A worktree records the base it was created from and starts detached at it (Codex,
  OpenCode), since the base branch is usually checked out in the project folder already; the agent
  creates a branch when the work needs one, then merges or opens a pull request from the worktree.
  Worktrees from before this keep the branch SideKick made for them.
- **Work in.** A new project chat chooses "This folder" or "New worktree" before its first message.
  The choice is remembered as the default. A fresh chat (no messages yet) gets its new worktree;
  a chat with history forks into one instead, so its history never points at the wrong folder.
- **Concurrency guard.** The agent runtime records which folder every writing run uses. A
  conversation run that would write into a folder (or a folder nested in it) where another run is
  writing is refused unless the caller explicitly accepts sharing. The renderer checks first and
  offers a new worktree, sharing, or cancel. Research runs do not write and are not guarded. The
  check is in `AgentRuntimeCoordinator.startConversation`, so every caller (chat, schedule,
  agent-started chat) is covered, not only the composer.
- **Inventory.** The management view lists each worktree by its chat, with its project, branch,
  last use, and whether it is working, set aside, or has changed files. Ahead/behind counts, merge
  state, disk use and syncing with the base were dropped as more control than the list needs; the
  agent does that Git work in the worktree.
- **Set aside, least recently used first** (Codex). At most 15 worktrees stay on disk. Beyond that,
  the least recently used one without a running or pinned chat is snapshotted (a commit of HEAD plus
  every unignored file, built in a private index and held by `refs/sidekick/worktrees/<id>`) and
  its folder removed. `AgentRuntimeCoordinator` asks the service to restore a chat's worktree
  before every run: the same path, commit and branch, with the snapshot's files written back
  unstaged. Housekeeping runs in the background after a worktree is created or used.
- **Removal.** One confirmation, then `git worktree remove --force`, and the snapshot ref goes too.
  Running chats and folders SideKick cannot prove it created are refused. Chats that used the
  worktree are detached, never deleted; branches stay in the repository. There is no
  recursive-delete fallback.
- **Automatic cleanup.** Deleting the last chat of a worktree removes it.

## Open work

Shipped: the service above, "Work in" for new project chats, the busy-folder prompt and runtime
refusal, the management view, setting aside and restoring, removal, and cleanup when a worktree's
last chat is deleted. Still open:

- **Archive.** Chats can be archived in the main process but not yet from the interface. Archiving
  should set its worktree aside at once, as deleting the chat removes it.
- **Setup on restore.** Restoring does not rerun the project's worktree setup hooks, which need
  per-command approval, so ignored files such as installed dependencies come back only when the
  agent reinstalls them.
- **Git worktree locks** (Claude Code): `git worktree lock` while an agent runs, so tools outside
  SideKick cannot prune a worktree in use.
- **Fresh base by default** (Claude Code, Conductor): optionally fetch the remote default branch,
  with a short timeout, before creating a worktree, and offer starting from a remote branch or pull
  request.
- **Handoff** (Codex): move a chat's uncommitted work from the project folder into a new worktree,
  and back, instead of forking without the uncommitted files.
- **Merge back.** Merging or opening a pull request from a worktree, and then removing it, is left
  to the user or the agent; a one-click flow would pair with the Git status bar.
- **Settings.** The number kept on disk (15) and the worktree location are fixed. Claude Code and
  Codex make them configurable.
- **Per-worktree environment** (Conductor): pass the worktree path, name and a free port range to
  setup hooks so parallel dev servers do not collide.
- **Concurrent writes inside one worktree.** "Work here anyway" relies on the transactional mutation
  service's per-workspace serialization and conflict checks; it does not merge two agents' intent.
