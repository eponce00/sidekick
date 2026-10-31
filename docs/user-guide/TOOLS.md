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
and `edit`/`write`/`delete_file` for other models such as Qwen. A file must be read earlier in the
same chat before it is changed, though not before it is deleted, and every edit uses the same
transactional workspace mutation service.

`read` also opens PDFs, without Python or any other program installed. It returns each page's
text, up to 20 pages at a time. A model that can see images also gets a picture of the pages whose
text misses something: scanned pages first, then pages with charts, diagrams or photos, as many as
its provider takes in one request (four for cloud providers, two for local ones). Reading one or
two pages by number shows them as pictures. The chat shows the pages the model was given as
thumbnails under its work; click one to enlarge it and move between them. Newer pictures take the
place of older ones, and the model is told when one has left. A scanned page's words come from the computer's own text
recognition, so they stay in the conversation: the recognizer built into Windows or macOS, or
Tesseract on Linux when it is installed. It runs on your computer, and the pages never leave it for
that.

## Computer use

On Windows, the agent can operate other apps on this computer when you turn this on in
**Settings › Computer use**. It is off by default and needs
[cua-driver](https://github.com/trycua/cua) 0.38.0 for Windows x64, which you download yourself and
point Settings at. SideKick checks the file and refuses any other build.

- **You approve each app, per chat.** The agent asks, and SideKick shows you the app and its path.
  A denial is final for that request. The app must already be open; the agent cannot start apps.
- **Some apps are never available:** terminals and code editors, system tools and File Explorer,
  password managers, and browsers, which SideKick's own browser replaces.
- **Software that may control real equipment,** such as TwinCAT, gets an extra warning. A wrong click
  or value could move a machine.
- **Press Esc to stop it.** Everything the chat was allowed ends, and it has to ask you again. Esc is
  held for about a minute after each action, so other apps don't receive it during that time.
- **One chat at a time,** and never in a scheduled chat.
- **What the app shows goes to your selected model,** including any personal details on screen. A
  model that can't see images works from the app's list of controls alone.

The agent normally works in the background without moving your mouse or taking focus. Some apps
ignore background input; it then tells you it can't do that step.

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
- **The Terminal tab.** It works like an editor's terminal panel: the selected terminal fills the
  tab, and a list on its right holds your own terminals and, under **Agent**, the chat's commands.
  Each command shows its title, an icon coloured by its state, and its run time, its exit code if
  it failed, or **Needs input** while it waits for an answer; hover a running one to stop it.
  Select one to see its command, status, and folder above all of its output; the buttons beside
  the command copy the output, move it to the background, or stop it, and you can type into it.
  In a narrow panel the list shows only icons; hover one for its name.
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
  step, with the exit code and last lines. A background command whose shell exits while a program
  it started, for example with `Start-Process` or `nohup`, is still running counts as running until
  that program ends, and stopping the command stops the program too. Its terminal closes with the
  shell, so what the program prints after that is lost, and the command's last line says so.
  `wait` ends as soon as what it names happens:
  - a named command ends or stops at a prompt;
  - a command prints a line matching a pattern, such as `ready|error`;
  - for a plain wait, any background command of the conversation ends.

  Its seconds are only a maximum, and a message from you always ends it.

Commands from earlier app sessions are not listed in the Terminal tab; their output stays in the
chat.

### Your own terminals

**+** in the Terminal tab's list (or **New terminal** in an empty tab) opens a terminal of your own:
your default shell (PowerShell 7 when installed, else Windows PowerShell; your login shell on macOS
and Linux) in the chat's project folder, or your home folder for a chat outside a project. Type
into it as into any terminal; with text selected, Ctrl+C copies on Windows and Linux, and Ctrl+V
pastes. It is not an agent command: nothing you type asks for permission, and the agent cannot
see, read, or type into your terminals. They belong to the app, not to one chat, so every chat's
Terminal tab lists the same ones, and they keep running while you switch chats. A terminal whose
shell has exited stays listed with its exit code until you remove it. The trash button ends the
shell and everything it started; quitting SideKick ends them all.

## Conditional tools

- Persistent goals add `update_goal`.
- Plan mode adds `enter_plan_mode`, `present_plan`, and `complete_plan` at the appropriate phase.
- Installed skills may add `create_artifact` and trusted bundled helpers. `create_artifact` renders
  the artifact the way the chat shows it and reports whether it rendered, any runtime errors, layout
  problems found in the rendered page (content wider than the chat, sideways scrolling, cut-off or
  squeezed text, chart labels past the chart's edge, values such as `NaN`), and, for models that
  accept images, a screenshot, so the model can check its own result.
  The tool is offered even before its skill loads, so the tool list stays the same across turns;
  an artifact made without the skill's guidance is rendered and the guidance comes back with it.
- `edit_artifact` changes an existing artifact, this reply's or an earlier one's, by replacing exact
  snippets of its code, then renders and checks it the same way; the chat shows the new version.
- In a chat, the artifact shows while the agent writes it. A builder then reviews how it rendered
  and fixes what is wrong, up to three times, with `edit_artifact`; each fix replaces the artifact
  in place. The builder works without extended reasoning. When there is nothing to review, because
  the artifact could not be rendered, or it rendered cleanly with no layout problems and the model
  cannot see images, it stays as the agent made it.
- An artifact cut off by the reply's output limit is not run; the agent is told to write it again
  more compactly.
- The Schedules skill adds `schedules_list`, `schedules_create`, `schedules_update`, and
  `schedules_delete` to the run that loads it, and only then, so other runs carry none of them. A
  later run that calls one first is told to load the skill. Listing changes nothing; every create,
  change, pause, resume, and delete asks you first, even in Full access. See
  [Asking the agent](SCHEDULES.md#asking-the-agent).
- User-configured MCP servers add their advertised tools after schema normalization. A call has
  two minutes to answer, and stopping the run cancels it on the server. A result the server marks
  as an error is a failed call. A local server that exited starts again for the next run.

During Plan mode's planning phase, only bounded workspace reads, code intelligence, web tools,
questions, skills, todos, waits, plan tools, and retained output are eligible. Commands, workspace
mutations, MCP, artifacts, schedules, starting or messaging other chats, and child agents remain
unavailable even when the global policy is Full access.

## Execution guarantees

- Tool arguments are normalized only when the meaning is unambiguous, then recursively validated
  before permission prompts or side effects.
- Reads, searches, commands, and mutations resolve paths inside the active project and reject
  traversal and symlink escapes. In a project of
  [several folders](PROJECTS.md#several-folders-in-one-project), a relative path means the primary
  folder and `<name>/path` another folder; each folder is its own boundary, so a path or link that
  leads from one folder into another or outside the project is refused. When a task needs a folder
  outside the project, the agent says
  the folder is not granted to the chat instead of looking for another way in. You can add the
  folder as a project and work on it in a chat there, which a chat can also start for you with
  your approval, or copy the files into this project.
- An existing file can be edited only after the agent read or wrote it earlier in the same chat,
  and only if it has not changed since. A stale, ambiguous or no-op edit fails rather than being
  reported as successful.
- A multi-file patch is validated as one transaction. Any failure prevents the full change set or
  rolls it back. A patch across folders holds each folder's lock, taken in one fixed order, so two
  such patches never wait on each other.
- Foreground and background commands use an explicit project-relative working directory: the
  primary folder by default, or another folder named as `cwd`. `WORKSPACE_FOLDER` is the primary
  folder, and `SIDEKICK_PROJECT_FOLDERS` maps each other folder's name to its path as JSON. In a
  Docker shell, a project of one folder is mounted at `/workspace`; with several, each folder is
  mounted at `/workspace/<name>`, the primary under its own folder name. Background
  commands return an ID that can be read, answered, or cancelled from any reply in the conversation.
- A command can be given stored credentials only when the program it runs is installed, not a file
  in any of the project's folders.
- Tool output is bounded. A long result keeps its start and its end, cut on whole lines, and a
  note where the middle was left out says that SideKick shortened it, gives an opaque handle and
  the byte offset where the part left out starts. A line too long to show whole, such as JSON on
  one line, shows as much of its start and end as fits. The whole result is kept in trusted
  storage, and the agent reads on from that offset with `tool_output`, or finds text in it with
  `tool_output`'s `find`, which returns each match's offset and the text around it. None of it is
  silently inserted into the prompt.
- A command's result reaches the agent as text: its exit code, then stdout and stderr (or, in a
  terminal, the output) as plain lines, each shortened on its own. The note says the command's own
  output was complete, so a shortened download log is not taken for a short file. When SideKick
  itself kept only part of it, the first 256 KB over pipes or the last lines a terminal keeps, the
  note says so and names the log file that holds all of it. The command row in the chat shows the
  same result, with **Copy** copying the output as text.
- On Windows, a program's exit code decides whether a command failed even when its stderr was
  redirected with `2>&1`, which Windows PowerShell otherwise counts as an error; a cmdlet's error
  still fails it. Errors point at the command's own lines.
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
