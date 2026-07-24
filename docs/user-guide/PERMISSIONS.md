# Permission policy

SideKick has one authorization policy for privileged operations. Model-originated operations stay
inside the main-process kernel, which either proceeds or creates a durable in-chat permission
interaction. User-initiated destructive UI actions use an exact main-process broker grant.

## Modes

| Mode          | Requested `auto`                  | Requested `confirm`               |
| ------------- | --------------------------------- | --------------------------------- |
| Always ask    | Durable user approval interaction | Durable user approval interaction |
| Agent decides | Automatic                         | Durable user approval interaction |
| Bypass        | Automatic                         | Automatic                         |

Agent decides is the default. Bypass removes prompts but does not erase the agent's
original safety classification: audit records retain both requested and effective access.

## Operation matrix

| Operation                       | Default request          | Trusted enforcement                                                    |
| ------------------------------- | ------------------------ | ---------------------------------------------------------------------- |
| Agent shell command             | Agent-selected           | Kernel policy before canonical command service                         |
| Agent workspace mutation        | Agent-selected           | Kernel policy plus same-run file receipt before transactional mutation |
| Agent MCP tool call             | Confirm                  | Kernel policy before internal MCP dispatch                             |
| Agent/child/collaboration tools | Shared catalog policy    | Same kernel suspension and result envelope                             |
| Checkpoint restore/rewind/reset | Confirm                  | Exact broker grant consumed before private-History mutation            |
| User file deletion              | Auto after in-app intent | Exact broker grant consumed before system Trash / Recycle Bin          |
| External browser navigation     | Auto                     | Main-window policy before opening                                      |

Agent approvals are bound to a durable run/interaction/tool call and resume only that suspended
kernel operation. Broker approvals are bound to a SHA-256 fingerprint of the normalized UI
operation, expire after one minute, and are single-use. Replays, missing tokens, expired tokens, and
mismatched operations are rejected.

## Audit records

Kernel decisions live in `agent_run_events`; broker authorization/consumption records live in the
settings store. Settings projects the latest 500 entries from both authoritative sources into one
chronological audit. Each row includes operation kind/title, requested/effective access, active
mode, a safe operation fingerprint, outcome, timestamp, and failure reason when applicable. The
latest records are visible under Settings → Agent → Permissions.
