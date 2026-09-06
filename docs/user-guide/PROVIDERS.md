# LLM providers

SideKick models providers as named connection instances. A user can add several instances of the
same provider type, discover or enter their model inventory, choose which models appear in chat,
and select a separate fast/utility model per instance.

## Supported provider families

| Provider kind     | Protocol                | Credentials | Model inventory | Notes                                                                                     |
| ----------------- | ----------------------- | ----------- | --------------- | ----------------------------------------------------------------------------------------- |
| Ollama            | Ollama `/api/*`         | None        | Discovered      | Local or remote host; context comes from `/api/show`                                      |
| Ollama Cloud      | Ollama `/api/*`         | Required    | Discovered      | Hosted Ollama transport with bearer authentication                                        |
| LM Studio         | OpenAI-compatible       | Optional    | Discovered      | Uses standard `/v1/models` plus LM Studio context metadata                                |
| LiteLLM           | OpenAI Chat Completions | Optional    | Discovered      | Virtual keys, aliases/groups, context limits, and model capability metadata               |
| OpenAI-compatible | OpenAI Chat Completions | Optional    | Discovered      | vLLM, OpenCode gateways, and custom servers                                               |
| llama.cpp         | OpenAI-compatible       | None        | Manual          | Model is server-managed; context may come from `/props`                                   |
| OpenRouter        | OpenAI-compatible       | Required    | Discovered      | Catalog metadata, pricing, reasoning controls, and generation cost                        |
| Anthropic         | Native Messages API     | Required    | Discovered      | Claude streaming, vision, tools, adaptive/manual thinking, and signed thinking continuity |

The registry in `src/shared/providerRegistry.ts` is the source of truth for protocol, credential,
discovery, context, health, lifecycle, pricing, thinking, statistics, and vision capabilities.
Brand-specific behavior belongs in the registry or a native main-process adapter, not in React.

## Trusted runtime boundary

All discovery, health, context, completion, and streaming requests execute in the trusted Electron
main process through the single `providers:*` IPC API. The renderer sends only a provider instance
id, provider kind, model id, messages, tools, and generation options. It never receives the stored
credential or the resolved endpoint for a normal model request.

Provider-instance credentials are encrypted with Electron `safeStorage`. Settings exposed to the
renderer contain only `apiKeyConfigured`; a newly typed replacement key crosses the settings bridge
once and is removed from renderer state after the save completes. The main runtime resolves and
decrypts the matching secret immediately before a provider request.

Saving a new or replacement credential requires an available OS-protected
keychain/password manager. SideKick refuses to save it if that service is locked
or unavailable; on Linux, the `basic_text` fallback and an unknown backend are
also refused. Enable or unlock a supported desktop password manager and retry.
Settings without new credentials and no-key local providers remain usable.
Unrelated saves preserve existing encrypted credentials while storage is locked;
explicitly clearing a key or removing its provider still removes that credential.
Presence markers mean a saved credential exists, not that it can currently be
decrypted. Historical plaintext fallback values are not exposed while storage is
unavailable, and legacy migration is deferred until secure storage is available.
If an older installation already stored a plaintext key, unrelated saves are
blocked until it can be securely migrated; explicitly clear the key or remove
its provider to discard it. This prevents both plaintext rewrites and silent
credential loss during an unavailable-keychain session.

Streaming adapters normalize all providers to text, thinking, tool-call, usage, finish, retry, and
error chunks. Stream cancellation is isolated by renderer window and request id. OpenAI-compatible
SSE and Ollama NDJSON parsers tolerate arbitrary network fragmentation. Anthropic preserves signed
and redacted thinking blocks unchanged through tool-result continuations.

## Settings and model selection

Settings manages connections and model inventory. Chat only selects from enabled models projected
from enabled instances. Context length is provider/server metadata. When a gateway omits or
misreports metadata, an on-demand model editor can store explicit context, output, tool, vision,
and reasoning overrides. Overrides survive discovery refreshes and are visibly identified as
manual rather than provider-reported data. Ollama remains the exception for changing server
context because `num_ctx` is a supported request option.

Discovered model inventories are searchable in real time. Providers without reliable discovery,
such as a fixed llama.cpp server, support manual model ids. A model can be enabled or hidden without
deleting its provider connection.

## Active capability checks and timing

In provider settings, save your connection first, then explicitly choose a model
under **Test actual model capabilities**. The check sends two synthetic requests;
the optional vision checkbox adds a third. Each allows up to 1,024 output tokens
and retains existing thinking defaults. Requests can incur charges or load a model.
Cancel stops the probe; the overall deadline is two minutes. Proposed tools never
execute. Observed/not-observed results are smoke checks, not quality benchmarks.

Server-reported model names may still be aliases. Missing identity and cache
telemetry are shown as unreported, not inferred. **Copy anonymous test summary**
copies only check statuses and metrics, excluding endpoint/model identities and
generated content.

Open a response's token statistics and **Model request timeline** to see each
request's total duration, wait to first output, streaming time and cache counts.
Wait includes network, queue and prefill; SideKick does not pretend to separate
these without backend telemetry. Streaming time includes reasoning. Old runs
without recorded timings cannot display this breakdown retroactively.

## LiteLLM

LiteLLM is a first-class provider even though conversation streaming uses the shared
OpenAI-compatible transport. Discovery starts with the virtual-key-safe `/v1/models` inventory,
parses common `context_length`, `max_model_len`, `max_input_tokens`, `max_output_tokens`, and
capability fields, then opportunistically enriches matching aliases from `model_group/info` and
`model/info`. A restricted virtual key may deny those richer routes; that does not fail discovery.
Models remain selectable and their metadata is shown as unknown until the proxy reports it or the
user adds a manual override.

LiteLLM aliases and routing groups are treated as chat model ids, so the proxy remains responsible
for choosing a deployment. Multiple LiteLLM instances can be configured independently, including
separate local, home, and hosted gateways with different virtual keys and visible model sets.

LiteLLM 1.90+ can surface `max_input_tokens` and `max_output_tokens` on the virtual-key-safe
`/v1/models` route. For a custom local or OpenAI-compatible backend, LiteLLM may not recognize the
model and its limits will remain null unless they are configured explicitly:

```yaml
model_list:
  - model_name: local-loaded-model
    litellm_params:
      model: openai/local-loaded-model
      api_base: os.environ/LOCAL_MODEL_API_BASE
      api_key: os.environ/LOCAL_MODEL_API_KEY
    model_info:
      max_input_tokens: 131072 # replace with the backend's actual limit
      max_output_tokens: 16384 # replace with the backend's actual limit
      supports_function_calling: true
      supports_reasoning: true
      supports_vision: false
```

An alias such as `local-loaded-model` cannot have authoritative fixed metadata if it can silently
point at different loaded models with different limits. Prefer one stable alias per actual model,
or update its `model_info` whenever the backing model changes.

For opt-in live verification without storing credentials in the repository:

```sh
SIDEKICK_LITELLM_SMOKE_URL=https://gateway.example/v1 \
SIDEKICK_LITELLM_SMOKE_API_KEY=your-virtual-key \
npm run test:litellm-smoke
```

## Adding a provider

1. Add its metadata and capabilities to `providerRegistry.ts`.
2. Reuse the OpenAI-compatible or Ollama adapter when the wire contract is genuinely compatible.
3. Add a native main-process adapter when semantics differ materially, as with Anthropic Messages.
4. Route it through `src/main/providers/providerRuntime.ts`; do not add branded preload APIs.
5. Add fragmented-stream, tools, errors, usage, discovery, and continuation fixtures.
6. Add its icon treatment through `ProviderIcon` and verify Settings/model-picker consistency.

Provider-specific renderer fetches, plaintext credential reads, and one-off IPC transports are
architecture violations.
