# Agent tools

SideKick builds a tool catalog for each run in the trusted main process. The selected surface,
project state, model, plan phase, permission policy, and installed local services determine which
tools the model can see. A tool missing from that catalog cannot be invoked through the renderer.

## Core catalog

| Capability      | Tools                                                                | Availability                                                             |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Work tracking   | `manage_todo_list`                                                   | Conversation and Plan runs                                               |
| Commands        | `execute_command`, `list_background_tasks`, `cancel_background_task` | Project-bound conversation, collaboration, and child-agent runs          |
| Coordination    | `wait`                                                               | All agent profiles                                                       |
| Delegation      | `spawn_subagent`                                                     | Project-bound conversation runs                                          |
| Skills          | `use_skill`                                                          | Conversation runs, including read-only planning                          |
| Human input     | `ask_user`                                                           | All interactive agent profiles                                           |
| Retained output | `read_tool_output`                                                   | All agent profiles                                                       |
| Web             | `web_search`, `web_image_search`, `web_fetch`                        | Conversation, collaboration, child-agent, and research runs when enabled |

Project-bound runs can also receive `list_workspace_files`, `read_workspace_file`, and
`search_workspace_files`. A configured model receives exactly one editing dialect—canonical
`apply_patch`, exact edit/write tools, or the generic structured contract—but every dialect uses the
same transactional workspace mutation service. `delete_file` uses that service as well.

The `code_intelligence` tool appears only when a matching language server is already installed on
the machine or in the project. SideKick does not download language servers or toolchains.

## Conditional tools

- Persistent goals add `update_goal`.
- Plan mode adds `enter_plan_mode`, `present_plan`, and `complete_plan` at the appropriate phase.
- Installed skills may add `create_artifact` and trusted bundled helpers.
- User-configured MCP servers add their advertised tools after schema normalization.
- A group-agent run adds `collaboration_read`, `collaboration_send`,
  `collaboration_share_file`, `collaboration_list_artifacts`,
  `collaboration_import_artifact`, `collaboration_status`, and
  `collaboration_claim_complete`.

During Plan mode's planning phase, only bounded workspace reads, code intelligence, web tools,
questions, skills, todos, waits, plan tools, and retained output are eligible. Commands, workspace
mutations, MCP, artifacts, collaboration writes, and child agents remain unavailable even when the
global policy is Bypass.

## Execution guarantees

- Tool arguments are normalized only when the meaning is unambiguous, then recursively validated
  before permission prompts or side effects.
- Reads, searches, commands, and mutations resolve paths inside the active project and reject
  traversal and symlink escapes.
- Existing files require a same-run read receipt before an edit. Stale, ambiguous, and no-op edits
  fail rather than being reported as successful.
- A multi-file patch is validated as one transaction. Any failure prevents the full change set or
  rolls it back.
- Foreground and background commands use an explicit project-relative working directory. Background
  commands return an ID that can be inspected or cancelled.
- Tool output is bounded. Overflow is retained in trusted storage and can be read through an opaque
  handle; it is not silently inserted into the prompt.
- Web pages and MCP responses are untrusted content. They cannot promote their text into system
  instructions.
- Repeated identical failures and unproductive tool loops are stopped by the shared runtime rather
  than retried indefinitely.

The [permission policy](PERMISSIONS.md) controls which eligible tools execute automatically, which
ask first, and which are denied. The [architecture guide](../architecture/OVERVIEW.md) describes the
mutation, recovery, and verification boundaries behind this catalog.
