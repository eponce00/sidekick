# Workspace verification

SideKick treats “the tool changed a file” and “the resulting project works” as different facts.
The first is established by the transactional mutation engine. The second needs evidence.

## Durable model

Each canonical workspace has a monotonically increasing revision in
`workspace_verification_state`. Successful direct edits and conservatively classified shell
mutations append `workspace_change_events`. Verification commands and language diagnostics append
`workspace_verification_events` with the run, workspace, revision, kind, scope, source, status,
exact command, cwd, exit code, changed paths, timestamps, diagnostics, and bounded fingerprint.

Evidence is fresh only when it covers the current revision and its path fingerprint still matches.
This catches both later agent changes and external changes to files the run touched. The model's
written claim is never evidence.

Recognized command families include:

- Node/Bun/Deno package scripts, Vitest/Jest/Mocha, TypeScript, ESLint, Biome, and common checks
- Python pytest, Ruff, Mypy, Pyright, and related tools
- Cargo test/check/build/clippy and Go test/vet/build
- Maven, Gradle, .NET, Ruby, PHP, and Swift test/build/lint commands

Unknown foreground commands are conservatively considered workspace-mutating when they are not a
known read. That may request one extra verification pass, but it cannot let a generated script or
shell rewrite silently preserve stale evidence.

## Lazy language servers

The server registry contains recipes, extensions, language IDs, and project-root markers. It does
not contain a compiler, runtime, downloaded binary, or ecosystem package. Resolution prefers
`node_modules/.bin` and then the app process `PATH`. Starting a server is classified as execution,
so the normal permission mode applies. PATH-installed servers may warm lazily on a relevant read;
project-local binaries start only through an approved `code_intelligence` call (agent-decides and
bypass modes can approve it automatically). Once trusted, the process is shared by that language
root, stops after ten idle minutes, and restarts on demand after a crash.

The protocol client implements standard LSP framing, initialize/shutdown, document synchronization,
published and pull diagnostics, definition, references, hover, symbols, implementation, workspace
configuration, and workspace-folder responses. Results and diagnostic arrays are bounded before
they enter the model transcript or renderer.

Because language intelligence is conditional, a laptop with no language servers pays only a
bounded workspace scan once per active workspace. Ordinary editing and command verification still
work. Installing a server in a project or on `PATH` makes its tool available on the next app/session
without changing SideKick.

## Completion policy

When a run changed the workspace and attempts to finish:

1. Fresh passing evidence allows completion.
2. Fresh failure, stale evidence, or no evidence injects one trusted verification request with the
   smallest manifest-derived checks.
3. The initial completion text is provisional and never appears as a duplicate answer.
4. A second terminal response is allowed. When verification is impossible, the UI retains an
   honest unverified state rather than looping forever.
5. Persistent goals are evaluated after this guard, so a model cannot complete a goal first and
   bypass workspace evidence.

The final message contains a quiet expandable verification segment reconstructed from the durable
run event. Direct chats, collaboration participants, and child agents all use the same
`AgentToolRuntime` session and `AgentRunKernel` controller.

## Limits

- A clean language diagnostic is targeted evidence, not proof of runtime behavior.
- Build output and dependency caches are not fingerprinted as source changes.
- Commands that finish in the background can only become evidence after their terminal result is
  explicitly observed; starting a process is not a passing check.
- Workspace-wide external changes outside the run's changed paths are not attributed to that run.
- Physical release testing should cover representative real servers on macOS, Windows, and Linux
  because each upstream server has its own startup and initialization quirks.
