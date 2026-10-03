# Agent tools

SideKick builds a tool catalog for each run in the trusted main process. The selected surface,
project state, model, plan phase, permission policy, and installed local services determine which
tools the model can see. A tool missing from that catalog cannot be invoked through the renderer.

## Core catalog

| Capability      | Tools                                                                                                   | Availability                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Work tracking   | `manage_todo_list`                                                                                      | Conversation and Plan runs                                               |
| Commands        | `shell`, `list_background_tasks`, `cancel_background_task`, `read_command_output`, `send_command_input` | Project-bound conversation, collaboration, and child-agent runs          |
| Coordination    | `wait`                                                                                                  | All agent profiles                                                       |
| Delegation      | `spawn_subagent`                                                                                        | Project-bound conversation runs                                          |
| Skills          | `use_skill`                                                                                             | Conversation runs, including read-only planning                          |
| Human input     | `ask_user`                                                                                              | All interactive agent profiles                                           |
| Retained output | `read_tool_output`                                                                                      | All agent profiles                                                       |
| Web             | `web_search`, `web_image_search`, `web_fetch`                                                           | Conversation, collaboration, child-agent, and research runs when enabled |
| Visual browser  | `browser_open`, `browser_observe`, `browser_screenshot`, actions, diagnostics, and verification         | Project-bound runs when browser work is enabled                          |

Project-bound runs can also receive the bounded `read` tool and the file editor the model was
trained on: `apply_patch` for OpenAI models, `Edit`/`Write` for Claude, search-and-replace for Grok,
and `edit`/`write`/`delete_file` for other models such as Qwen. Files must be read in the same run
before they are changed, and every edit uses the same transactional workspace mutation service.

The native browser catalog includes `browser_open`, `browser_observe`, `browser_screenshot`,
`browser_click`, `browser_type`, `browser_select`, `browser_fill_form`, `browser_scroll`, `browser_hover`,
`browser_wait`, `browser_navigate`, `browser_tabs`, `browser_console`, `browser_network`,
inspection-only `browser_evaluate`, `browser_verify`, and `browser_close`. Browser pages run in an
isolated Electron session, not in the app renderer, and screenshots can be supplied directly to a
vision-capable model. See [Visual browser](BROWSER.md).

The `code_intelligence` tool appears only when a matching language server is already installed on
the machine or in the project. SideKick does not download language servers or toolchains.

## Agent commands and the Terminal

Agent commands run in a terminal (a pseudo-terminal), so programs behave as they do for you:
colours, progress bars, and prompts. The model reads the output as a terminal shows it, without
control codes. **Agent settings → Run commands in a terminal** switches to plain pipes; Docker
isolation always uses pipes.

- **In the chat.** A running command shows its last lines under its row, with **Stop**,
  **Background**, and **Open in Terminal**. Stop ends that one command; the agent is told you
  stopped it and goes on. Background stops the agent waiting on it while it keeps running.
- **The Terminal tab.** The side panel lists the conversation's commands with their state and run
  time. Select one to see all of its output in a terminal view, copy it, stop it, or type into it.
- **Prompts.** A command that prints a question and then waits, such as `Ok to proceed? (y)`, is
  marked as waiting for input. You can answer it from the chat or the Terminal tab. If the agent
  was waiting on it, the agent gets it back as a background task, with the question, instead of
  waiting until it times out.
- **Background commands** belong to the conversation, so a later reply can still read, answer,
  or stop a dev server an earlier reply started. The agent reads a running command with
  `read_command_output`, which by default returns the output since its last look, and answers
  prompts with `send_command_input`. It is told not to type secrets or make choices that are yours.

Commands from earlier app sessions are not listed in the Terminal tab; their output stays in the
chat.

## Conditional tools

- Persistent goals add `update_goal`.
- Plan mode adds `enter_plan_mode`, `present_plan`, and `complete_plan` at the appropriate phase.
- Installed skills may add `create_artifact` and trusted bundled helpers. `create_artifact` renders
  the artifact the way the chat shows it and reports whether it rendered, any runtime errors, and,
  for models that accept images, a screenshot, so the model can check its own result.
  The tool is offered even before its skill loads, so the tool list stays the same across turns;
  an artifact made without the skill's guidance is rendered and the guidance comes back with it.
- In a chat, an artifact is checked before it appears. A builder reviews how the agent's version
  rendered and fixes what is wrong with it, up to three times, while the reply shows one
  **Building** row with the version it is on. The chat then shows only the finished artifact;
  open the row while it works to see each version. When there is nothing to review, because the
  artifact could not be rendered, or it rendered cleanly and the model cannot see images, it
  appears as the agent made it.
- User-configured MCP servers add their advertised tools after schema normalization.
- A group-agent run adds `collaboration_read`, `collaboration_send`,
  `collaboration_share_file`, `collaboration_list_artifacts`,
  `collaboration_import_artifact`, `collaboration_status`, and
  `collaboration_claim_complete`.

During Plan mode's planning phase, only bounded workspace reads, code intelligence, web tools,
questions, skills, todos, waits, plan tools, and retained output are eligible. Commands, workspace
mutations, MCP, artifacts, collaboration writes, and child agents remain unavailable even when the
global policy is Full access.

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
  commands return an ID that can be read, answered, or cancelled from any reply in the conversation.
- Tool output is bounded. Overflow is retained in trusted storage and can be read through an opaque
  handle; it is not silently inserted into the prompt.
- Web pages and MCP responses are untrusted content. They cannot promote their text into system
  instructions.
- Repeated successful calls receive quiet model guidance rather than visible warning banners or
  false failures. Repeated actual failures and global run-budget exhaustion still stop safely.

The [permission policy](PERMISSIONS.md) controls which eligible tools execute automatically, which
ask first, and which are denied. The [architecture guide](../architecture/OVERVIEW.md) describes the
mutation, recovery, and verification boundaries behind this catalog.
