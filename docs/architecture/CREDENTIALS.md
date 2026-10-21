# Credentials

Credentials are values the user stores for the agent to use by alias. The trusted main process is
the only place a value exists in plaintext; the renderer can set and replace one but never read it,
and the agent and the model provider never receive one. User behavior is in
[Credentials](../user-guide/CREDENTIALS.md); the reasoning, the comparison with other tools, and the
work still open are in the [roadmap design](../roadmap/CREDENTIALS.md).

## Storage

`CredentialVault` (`src/main/services/credentialVault.ts`) owns entries. Each entry's values, scope
and settings together are one JSON record sealed with Electron `safeStorage`, kept under the
top-level store key `credentialVault` beside a plaintext alias, kind and description:

- The sealed record carries its own id, so swapping sealed records between entries, or editing the
  store file to widen a scope, yields a record that does not open as that entry.
- The plaintext copy exists only so an entry this computer cannot open, as after copying the profile
  to another one, is still listed, marked `needsValue`, until the user enters its values again.
- It lives outside `settings` because a Settings save rebuilds `settings` from the renderer's copy
  and the public settings projection would pass an unknown key to the renderer.
- Saving fails closed where `isSecureCredentialStorageAvailable()` is false, which includes Linux's
  `basic_text` fallback; there is no plaintext path.

`credentialVaultInstance.ts` binds the vault to `safeStorage` and the store. `src/main/index.ts`
opens it before registering IPC handlers, so its values are redacted from the first tool output on.

The audit is the store key `credentialEvents`, the newest 1,000 events: created, value replaced,
changed (naming which settings), deleted, and, for tools that use a credential, used, denied, and
refused. An event names the entry, alias, tool, target, conversation and run; never a value, its
length or a hash.

## Renderer and IPC

`src/main/ipc/credentials.ts` exposes status, list, save, delete and events through the
`credentials` preload namespace (`CredentialsAPI` in `src/shared/credentials.ts`). Summaries carry
no values; a sign-in's username is included only when the entry lets the agent read it. Save takes
optional values: an absent field keeps the stored one, and a new entry, a changed kind, or an entry
marked `needsValue` must bring every value.

The renderer is not trusted to widen an entry. `credentialWidening` lists every way a save would let
the agent use an existing entry more (asking less often, more projects, background runs, a visible
username), and the main process confirms those in a trusted dialog before saving. Delete always
confirms in a trusted dialog. Both broadcast `credentials:changed`.

## The agent's tools

The `credentials` capability (conversation runs, not planning, not sub-agents or research) adds:

- `credentials_list`: each entry's alias, kind, description, scope and approval setting, and
  whether its project and background scope admit the current chat (`credentialScopeRefusal`).
- `credentials_request`: opens Settings at the Credentials editor through `app:openCredential`,
  prefilled with an alias, kind and description, as `provider_request_key` does for provider keys.
  The agent learns only that the editor opened.

`CREDENTIAL_CONSUMER_TOOLS` in `src/shared/credentialTools.ts` names the tools that take an alias and
add the value themselves; `credentials_list` reports it to the model.

## Redaction

`CredentialRedactor` (`src/main/services/credentialRedaction.ts`) holds every stored value, plus
values replaced or deleted since launch, and matches them with one Aho–Corasick automaton together
with the encodings the GitHub Actions runner registers for its secrets: each line of a multi-line
value (PEM armor lines excepted), JSON escaping, percent-encoding in both forms and both cases,
HTML and XML entities, Bash and PowerShell quoting, standard and URL-safe Base64 at all three
alignments, Base64 of UTF-16LE, and hexadecimal. Values under 4 characters and encoded forms under
6 are skipped. Overlapping matches merge into one `[secret: alias]`.

A `CredentialRedactionStream` redacts output that arrives in chunks: it holds back only the tail
that could still begin a stored form, so ordinary output passes at once and a value split between
chunks is still caught.

Several tools write output while they run, before any central point sees it, so redaction runs at
each source, then for every result, then for every model request:

| Where                                        | What it covers                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CommandRunner`, per stream                  | The command log under `command-outputs`, the captured result, `onOutput` (the terminal store and its `terminal:event` stream, `tool.output.delta` journal events, background-task records and verification summaries). A held tail is released after 300 ms of quiet so prompts still show. |
| `TerminalScreen.lines()` and `pendingLine()` | The screen text the model reads, again, because a console host that repaints with cursor moves can split a value on the way in and join it on screen.                                                                                                                                       |
| `ToolOutputStore`                            | `apply` and `applySections` redact their input before measuring it, so the offsets they report match the file they keep; `save` and `read` redact too, the latter for output kept before a value was stored.                                                                                |
| `AgentToolRegistry.execute`                  | Every result, failures included: title, model content, data and errors, before `tool.completed` is written. Media and timing are left alone.                                                                                                                                                |
| `materializeProviderRequestMedia`            | Every outgoing model request's message content and tool-call arguments, which catches anything else, including a value the user typed into a message. Thinking blocks are left alone because providers sign them.                                                                           |

Files a chat sends another with `import_attachment` are copied as they are: the receiving agent
reads them through the same redacted tools.

Redaction is defense in depth. A program holding a value can transform it beyond any filter, a
value under 8 characters is hard to tell from ordinary text, a program that pauses mid-value for
longer than the quiet period defeats the stream hold-back, and screenshots cannot be redacted.
