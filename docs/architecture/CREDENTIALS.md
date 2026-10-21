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
- An entry this version cannot parse is written back exactly as it was. A store written by a newer
  version, or one that is not a store at all, makes Credentials unavailable and refuses every save
  and delete rather than overwrite it.
- Records carry `schema: 1`, so a later version can migrate them when a default changes.
- Opened records stay in main-process memory for the session, since the redactor holds every value
  anyway; nothing else decrypts them.
- Integrity is as strong as the platform's `safeStorage`. Windows seals with AES-GCM, which detects
  any change; macOS and Linux use AES-CBC without a MAC, so a process that can write the profile
  could alter or replay a sealed record. Such a process can already change SideKick's settings,
  and on Windows and Linux decrypt the values, so no separate layer is added.

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
marked `needsValue` must bring every value. `normalizeCredentialValue` stores one kind of line
ending, so a pasted key matches output line by line, and trims a secret or username, since a copied
token often carries a space; a password is kept as typed, and the redactor also hides its trimmed
form. A secret or password under 4 characters is refused. Replacing any value, including through a
changed kind, retires the old ones and records `value_replaced`.

The renderer is not trusted to widen an entry. `credentialWidening` lists every way a save would let
the agent use an existing entry more (asking less often, more projects, background runs, a visible
username), and the main process confirms those in a trusted dialog before saving. Delete always
confirms in a trusted dialog. Both broadcast `credentials:changed`.

## The agent's tools

The `credentials` capability (conversation runs, not planning, not sub-agents or research) adds:

- `credentials_list`: each entry's alias, kind, description, scope and approval setting, and
  whether its project and background scope admit the current chat (`credentialScopeRefusal`). It
  tells the model that descriptions are notes, not instructions.
- `credentials_request`: opens Settings at the Credentials editor through `app:openCredential`,
  prefilled with an alias, kind and description, as `provider_request_key` does for provider keys.
  The editor marks a description the agent wrote until the user changes it, because every chat
  that lists credentials reads it. The agent learns only that the editor opened.

`CREDENTIAL_CONSUMER_TOOLS` in `src/shared/credentialTools.ts` names the tools that take an alias and
add the value themselves; `credentials_list` reports it to the model, with each entry's web hosts,
placement and token hosts.

## Using a credential

The value never enters a tool's arguments. A tool takes an alias in a typed argument, and its
handler asks `CredentialUses` (`src/main/services/credentialUses.ts`) for the value at the moment it
sends the request. Arguments, and everything built from them (the run ledger, live previews,
approval cards, chat grants and the tool's title, which is recomputed from the arguments after
authorization), hold only the alias.

`CredentialUses` checks every rule each time: the entry exists, `credentialScopeRefusal` admits the
chat's project and how it was started, and the target is in scope. `take` returns the values and
records `used`, or records `refused` with the reason the tool returns to the model. Its audit
target is the URL without its query string, so a value sent as a parameter is never kept.

**Approval.** `credentialRequestsFor` reads the uses a call asks for and `credentialApprovalFor`
turns them into one `AgentCredentialApproval`. `AgentRunKernel.authorizeCredential` runs before the
permission policy: an entry that asks every use, or once per chat without a grant yet, suspends the
run with a permission card whose `preview.facts` name the credential, the target and how it is
sent. Approving it approves the whole call. A once-per-chat grant is keyed on the entry and the
target's origin. A use outside scope, including a returned-token alias that does not exist yet, is
refused at that point with the reason, whatever the permission mode, so no card can stand in for
it. Once the kernel approves a call, `credentialApproved` gives `CredentialUses` a one-time permit
for that run, tool call, alias and URL; `take` hands values only to a permitted use and checks
scope again. Permits a run did not use lapse when it ends. A denial records `denied`.

**`http_request`** (`agentHttpToolHandlers.ts`, capability `web.request`, execute risk with GET and
HEAD requested as auto) sends one request through `requestAdmitted` in `webNetworkGuard.ts`, the
same local-network policy as `web_fetch`, and never follows a redirect. With a credential, the
URL must be HTTPS on one of the entry's hosts (`credentialHostMatches`: exact host and port, or
`*.domain` for subdomains), and the handler places the value as the entry's `CredentialSend` says:
a header with a prefix, Basic authentication, a query parameter, or a form or JSON field. It refuses
a request that already sets that header, parameter or field in any letter case, a
`Content-Encoding` header, and, when the value goes in the body, a `Content-Type` header: SideKick
sets the body's type itself. The `timeout` argument is a deadline for the whole exchange, not only
a quiet connection. A failed request is reported by its message alone, because an HTTP client error
object carries the request. A response is decoded by its byte-order mark, then its declared
charset, then as UTF-8.

**Commands.** `shell` takes `secrets: { VARIABLE: "alias" }` (or `alias.username` /
`alias.password` for a sign-in). `AgentToolRuntime.commandSecrets` refuses variables that change
how commands run (`credentialVariableRefusal`: `PATH`, `LD_*`, `DYLD_*`, `NODE_*`, `BASH_ENV`,
`ComSpec`, `GIT_SSH_COMMAND` and similar), takes each value from `CredentialUses`, and passes them
to `CommandService` as `secretEnvironment`, added after `shellChildEnvironment` strips
secret-looking names inherited from SideKick's own environment. The Docker shell passes them with
`--env NAME`, so Docker reads the value from its own environment. An entry's
`CredentialCommandScope` is `ask`, where every command asks whatever the entry's setting, or
`programs`, where `simpleCommandProgram` must find one simple command (no `;`, `&`, `|`,
redirection, backticks, parentheses, braces or `$(`, in Bash or PowerShell) whose program is a
bare name on the list; `credentialProgramRefusal` keeps shells, interpreters, launchers and remote
shells such as `ssh` off it. `CredentialUses` checks the variable name too, so a refused variable
never reaches an approval card. Before taking any value, `commandSecrets` looks the command's
program up as the shell would (`resolveProgram`: PATH, and on Windows the working directory first)
and refuses when it resolves to a file inside the project or the working directory, which the agent
could have written. A command chat grant is keyed on the entry, the variable and the exact
command.

**Browser sign-in.** `browser_sign_in` takes a sign-in's alias, and optional username and
password field refs. Before it runs, the approval is keyed on the origin the conversation's browser
is on (`AgentBrowserSessionManager.activeAddress`); when it runs, `CredentialUses` checks that
origin (`credentialPageOrigin`: HTTPS, or HTTP on a loopback address) against the entry's
`CredentialBrowserScope`, and `NativeBrowserSessionService.signIn` checks it again. `signIn` finds
the fields as a password manager does (`FIND_SIGN_IN_FIELD`), then, for each field and immediately
before typing, refuses one in a frame, one whose document origin differs, a form whose target is
outside the entry's origins, and a password field that is not `type="password"`. Text goes through
the same `enterBrowserText` path as `browser_type`, which refuses a focus or navigation change
before inserting. The form is sent with `requestSubmit()` in the same page call that reads the
form's target again; a target outside the entry's origins refuses the submission and clears the
typed password. The result is one redacted semantic observation with no screenshot. Filled password fields are recorded on the tab: while one still
holds its value, `browser_evaluate` is refused, and a screenshot or observation is withheld if it
is no longer a password field.

**Returned tokens.** `aliasResponseTokens` (`credentialResponseTokens.ts`) reads the response to a
request that used a credential whatever its content type. Every string under a token-like name
(`access_token`, `accessToken`, `client_token`, `sessionToken`, `SecretAccessKey`, `password` and
the like, in any case and at any depth, but not paging cursors such as `nextPageToken`) in a JSON
body, a form-encoded body, or a redirect's `Location` query and fragment, where an authorization
`code` counts too, is replaced by an alias such as `partner-center~1`. It fails closed: a body it
cannot parse, text in an encoding it cannot read, more than 32 tokens, or a token-like name left
beside a value that is not an alias (in XML, HTML, a script or any other text) withholds the body
and the `Location` header. `CredentialUses` keeps the tokens in memory for the run that received
them, for the response's `expires_in` or at most an hour, and sends them only as
`Authorization: Bearer` to the entry's token hosts, never to a command. When a token expires or its
run ends, its value stays with the redactor, through `CredentialVault.setTransientSecrets`, until
SideKick restarts.

## Redaction

`CredentialRedactor` (`src/main/services/credentialRedaction.ts`) holds every stored value except a
username the agent may read, plus values replaced or deleted since launch and returned tokens,
and matches them with one Aho–Corasick automaton together
with the encodings the GitHub Actions runner registers for its secrets: each line of a multi-line
value (PEM armor lines excepted), JSON escaping, percent-encoding in both forms and both cases,
HTML and XML entities, Bash and PowerShell quoting, standard and URL-safe Base64 at all three
alignments, Base64 of UTF-16LE, and hexadecimal. Values under 4 characters and encoded forms under
6 are skipped. Overlapping matches merge into one `[secret: alias]`. Matching runs on the text with
terminal escape sequences (CSI, OSC and two-character escapes) removed, and each match replaces the
original text it spans, escapes included, so a value a program prints in pieces between color codes
is still caught.

A `CredentialRedactionStream` redacts output that arrives in chunks: it holds back only the tail
that could still begin a stored form, and an escape sequence cut off at the end, so ordinary output
passes at once and a value split between chunks is still caught. `redactWindow` redacts a slice of
a longer text against the text around it, for reads that show part of a file.

Several tools write output while they run, before any central point sees it, so redaction runs at
each source, then for every result, then for every model request:

| Where                                        | What it covers                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CommandRunner`, per stream                  | The command log under `command-outputs`, the captured result, `onOutput` (the terminal store and its `terminal:event` stream, `tool.output.delta` journal events, background-task records and verification summaries). Pipes decode with one UTF-8 decoder per stream. A held tail is released after 300 ms of quiet so prompts still show. |
| `TerminalScreen.lines()` and `pendingLine()` | The screen text the model reads, again, because a console host that repaints with cursor moves can split a value on the way in and join it on screen.                                                                                                                                                                                       |
| `ToolOutputStore`                            | `apply` and `applySections` redact their input before measuring it, so the offsets they report match the file they keep; `save` and `read` redact too, the latter for output kept before a value was stored, reading past the window's edges so a value crossing one is caught.                                                             |
| Browser observations                         | A semantic line is redacted before it is shortened to its head and tail.                                                                                                                                                                                                                                                                    |
| `AgentToolRegistry.execute`                  | Every result, failures included: title, model content, data, errors and object keys, before `tool.completed` is written. Only the `source` of each top-level media item, its image data, is left alone.                                                                                                                                     |
| `materializeProviderRequestMedia`            | Every outgoing model request's message content, tool-call arguments and attachment names and descriptions, which catches anything else, including a value the user typed into a message. Thinking blocks are left alone because providers sign them.                                                                                        |

`wait` matches its pattern against redacted output, so a pattern cannot tell the agent anything
about a value. Files a chat sends another with `import_attachment` are copied as they are: the
receiving agent reads them through the same redacted tools.

Over-redaction has a cost: a file that holds a stored value reads as `[secret: alias]`. A write or
edit containing a placeholder for a stored value is refused (`secret_placeholder`) in
`workspaceMutationService.ts`, so the agent cannot replace the real value with the placeholder.
A command can still write one; only the file tools check.

Redaction is defense in depth. A program holding a value can transform it beyond any filter, a
value under 8 characters is hard to tell from ordinary text, a program that pauses mid-value for
longer than the quiet period defeats the stream hold-back, and screenshots cannot be redacted.
