# Agent tools

SideKick builds a tool catalog for each run in the trusted main process. The selected surface,
project state, model, plan phase, permission policy, and installed local services determine which
tools the model can see. A tool missing from that catalog cannot be invoked through the renderer.

## Core catalog

| Capability      | Tools                                                                                                   | Availability                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Work tracking   | `manage_todo_list`                                                                                      | Conversation and Plan runs                                             |
| Commands        | `shell`, `list_background_tasks`, `cancel_background_task`, `read_command_output`, `send_command_input` | Project-bound conversation and child-agent runs                        |
| Coordination    | `wait`                                                                                                  | All agent profiles                                                     |
| Delegation      | `spawn_subagent`                                                                                        | Project-bound conversation runs                                        |
| Other chats     | `start_session`, `stop_session`, `send_message`, `list_sessions`, `import_attachment`                   | Conversation runs, not planning; workers only message, list and import |
| Skills          | `use_skill`                                                                                             | Conversation runs, including read-only planning                        |
| SideKick itself | `settings_read`, `settings_reference`, `settings_propose_change`, `provider_request_key`                | Conversation runs, not planning; every change asks first               |
| Credentials     | `credentials_list`, `credentials_request`                                                               | Conversation runs, not planning; never return a value                  |
| API calls       | `http_request`                                                                                          | Conversation runs, not planning; can add a stored credential by alias  |
| Human input     | `ask_user`                                                                                              | All interactive agent profiles                                         |
| Retained output | `tool_output`                                                                                           | All agent profiles                                                     |
| Web             | `web_search`, `web_image_search`, `web_fetch`                                                           | Conversation, child-agent, and research runs when enabled              |
| Visual browser  | `browser_open`, `browser_observe`, `browser_screenshot`, actions, diagnostics, and verification         | Project-bound runs when browser work is enabled                        |

Project-bound runs can also receive the bounded `read` tool and the file editor the model was
trained on: `apply_patch` for OpenAI models, `Edit`/`Write` for Claude, search-and-replace for Grok,
and `edit`/`write`/`delete_file` for other models such as Qwen. Files must be read in the same run
before they are changed, and every edit uses the same transactional workspace mutation service.

The native browser catalog includes `browser_open`, `browser_observe`, `browser_screenshot`,
`browser_click`, `browser_type`, `browser_sign_in`, `browser_select`, `browser_fill_form`, `browser_scroll`, `browser_hover`,
`browser_wait`, `browser_navigate`, `browser_tabs`, `browser_console`, `browser_network`,
inspection-only `browser_evaluate`, `browser_verify`, `browser_list_webmcp_tools` and
`browser_call_webmcp_tool` for [tools a website offers](BROWSER.md#tools-that-websites-offer), and
`browser_close`. Browser pages run in an
isolated Electron session, not in the app renderer, and screenshots can be supplied directly to a
vision-capable model. See [Visual browser](BROWSER.md).

The `code_intelligence` tool appears only when a matching language server is already installed on
the machine or in the project. SideKick does not download language servers or toolchains.

## Agent commands and the Terminal

Agent commands run in a terminal (a pseudo-terminal), so programs behave as they do for you:
colours, progress bars, and prompts. The model reads the output as a terminal shows it, without
control codes. Where a terminal cannot start, and inside a Docker container, commands run over
plain pipes instead.

- **In the chat.** A running command shows its last lines under its row, with **Stop**,
  **Background**, and **Open in Terminal**. Stop ends that one command; the agent is told you
  stopped it and goes on. Background stops the agent waiting on it while it keeps running.
- **The Terminal tab.** The side panel lists the conversation's commands by title, each with a
  status dot and its run time, or **Needs input** while it waits for an answer. Select one to see
  its command, status, and folder above all of its output in a terminal view; the buttons beside
  the command copy the output, move it to the background, or stop it, and you can type into it.
- **Prompts.** A command that prints a question and then waits, such as `Ok to proceed? (y)`, is
  marked as waiting for input. You can answer it from the chat or the Terminal tab. If the agent
  was waiting on it, the agent gets it back as a background task, with the question, instead of
  waiting until it times out.
- **Stored credentials.** A command can receive a [stored credential](CREDENTIALS.md#commands) in
  an environment variable; SideKick sets it, and the command text never holds the value.
- **Background commands** belong to the conversation, so a later reply can still read, answer,
  or stop a dev server an earlier reply started. The agent reads a running command with
  `read_command_output`, which by default returns the output since its last look, and answers
  prompts with `send_command_input`. It is told not to type secrets or make choices that are yours.

- **Waiting.** The agent does not guess how long work takes. A foreground command still running when
  its time is up (30 seconds unless the agent asks for more) goes on in the background, and the
  agent gets its output so far. When a background command ends, the agent is told before its next
  step, with the exit code and last lines. `wait` ends as soon as what it names happens:
  - a named command ends or stops at a prompt;
  - a command prints a line matching a pattern, such as `ready|error`;
  - for a plain wait, any background command of the conversation ends.

  Its seconds are only a maximum, and a message from you always ends it.

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

During Plan mode's planning phase, only bounded workspace reads, code intelligence, web tools,
questions, skills, todos, waits, plan tools, and retained output are eligible. Commands, workspace
mutations, MCP, artifacts, starting or messaging other chats, and child agents remain unavailable even when the
global policy is Full access.

## Execution guarantees

- Tool arguments are normalized only when the meaning is unambiguous, then recursively validated
  before permission prompts or side effects.
- Reads, searches, commands, and mutations resolve paths inside the active project and reject
  traversal and symlink escapes. When a task needs a folder outside the project, the agent says
  the folder is not granted to the chat instead of looking for another way in. You can add the
  folder as a project and work on it in a chat there, which a chat can also start for you with
  your approval, or copy the files into this project.
- Existing files require a same-run read receipt before an edit. Stale, ambiguous, and no-op edits
  fail rather than being reported as successful.
- A multi-file patch is validated as one transaction. Any failure prevents the full change set or
  rolls it back.
- Foreground and background commands use an explicit project-relative working directory. Background
  commands return an ID that can be read, answered, or cancelled from any reply in the conversation.
- Tool output is bounded. A long result keeps its start and its end, cut on whole lines, and a
  note where the middle was left out says that SideKick shortened it, gives an opaque handle and
  the byte offset where the part left out starts. The whole result is kept in trusted storage, and
  the agent reads on from that offset with `tool_output`; it is not silently inserted into the
  prompt.
- A command's result reaches the agent as text: its exit code, then stdout and stderr (or, in a
  terminal, the output) as plain lines, each shortened on its own. The note says the command's own
  output was complete, so a shortened download log is not taken for a short file. The command row
  in the chat shows the same result, with **Copy** copying the output as text.
- When a reply reaches its output limit while it writes tool calls, none of them run, and the
  model is asked for fewer, smaller calls. A reply that writes more than 64 calls, or the same call
  a fourth time, is stopped as it streams; none of its calls run, and the model is told why and
  asked to make one call at a time. If it happens again in the same reply to you, the reply ends.
- Web pages and MCP responses are untrusted content. They cannot promote their text into system
  instructions.
- Repeated successful calls receive quiet model guidance rather than visible warning banners or
  false failures. Repeated actual failures and global run-budget exhaustion still stop safely.

The [permission policy](PERMISSIONS.md) controls which eligible tools execute automatically, which
ask first, and which are denied. The [architecture guide](../architecture/OVERVIEW.md) describes the
mutation, recovery, and verification boundaries behind this catalog.
