# Plan mode

Plan mode is a phase of the canonical SideKick run, not a second chat implementation. It lets a
user and a planning model inspect a request, agree on an executable contract, and then hand the
same durable run to the execution model.

## User flow

There are two deliberate entry paths:

1. The user chooses **Plan first** from the composer `+` menu. A compact composer row shows the
   planning model and the currently selected execution model before the message is sent.
2. In an ordinary run, the model may call `enter_plan_mode` when architectural ambiguity, impact,
   or rework risk makes a plan useful. SideKick shows the reason and asks the user before changing
   modes. The model cannot switch silently.

The default planning model is configured under **Settings → Agent → Planning**. It defaults to the
current chat model and can be overridden for one message from the composer. Plan approval returns
to the selected chat model for implementation.

The planner presents one recommended contract in the chat. The user can:

- implement the exact revision;
- request changes and keep planning; or
- keep the plan without changing project files.

## Contract

`AgentPlanContract` is structured and revisioned. It contains:

- observable requirements with acceptance conditions;
- implementation steps linked to requirement IDs;
- proportionate verification checks linked to requirement IDs; and
- optional risks.

The revision is derived from the normalized contract. Approval binds that exact revision to the
run and seeds the existing durable todo list from its steps. The executor cannot complete the plan
until every seeded todo is complete and `complete_plan` supplies evidence for every requirement
against the current revision. This is intentionally strict for substantive work while allowing a
check to be marked not applicable with an explanation.

## Enforcement boundary

Planning is enforced by the main-process capability catalog even in Full access mode. The planner can
use bounded workspace reads, semantic diagnostics, embedded web research, questions, skills,
todos, waits, and retained-output reads. It cannot receive:

- workspace mutation tools;
- foreground or background shell execution;
- MCP tools;
- artifacts;
- collaboration writes; or
- child-agent launch tools.

Future tools are denied automatically unless their capability is explicitly in the Plan-mode
allowlist. The renderer only requests a mode and resolves durable review interactions; it does not
enforce the restriction.

`agent_run_plans` persists the phase, planner/executor identities, normalized contract, revision,
completion evidence, and update time. `plan.mode_changed` records model/capability handoffs in the
run ledger. A transition replaces the model, provider request, context manager, tool catalog, and
phase-specific system prompt together. The approved contract is embedded in the execution system
prompt so compaction cannot silently discard it.

If a planner ends without `present_plan`, or an executor ends without an accepted
`complete_plan`, the kernel issues at most two focused continuations and then fails honestly. The
ordinary workspace-verification guard still runs before plan completion, so a completion contract
cannot bypass fresh diagnostic or command evidence.

## Verification

Deterministic tests cover contract normalization, requirement traceability, revision conflicts,
todo seeding, completion evidence, bounded terminal guards, read-only capability filtering, durable
review interactions, and live model/tool/model transitions. The provider-neutral system benchmark
also includes a real Plan → approval → edit → diagnostics → command → completion scenario against
an isolated synthetic project.
