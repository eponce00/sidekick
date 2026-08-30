# SideKick UI guidelines

SideKick uses a quiet, workspace-first visual system. The chat is the primary surface; files,
recovery, browser feedback, and settings should support it without competing for attention.

## Design principles

- Preserve the workspace. At compact widths, secondary panels overlay or collapse instead of reducing the chat to an unusable column.
- Use elevation sparingly. Surfaces, borders, and shadows should explain hierarchy rather than decorate every element.
- Keep accent color meaningful. Accent is reserved for active state, focus, progress, and primary action.
- Make empty states useful. Explain what appears in the surface and offer a concrete next action when one exists.
- Keep controls accessible. Interactive rows must be keyboard reachable, icon-only buttons need accessible names, and focus must remain visible.

## Tokens

Global tokens live in `src/renderer/src/styles/App.css`. Component styles should use the shared aliases instead of introducing hard-coded neutral colors:

- Surfaces: `--app-bg`, `--surface-0` through `--surface-4`
- Borders: `--border-subtle`, `--border-color`, `--border-strong`, `--panel-border`
- Text: `--text-primary`, `--text-secondary`, `--text-muted`
- Accent: `--accent`, `--accent-strong`, `--accent-subtle`, `--accent-muted`
- Interaction: `--focus-ring`, `--shadow-panel`, motion duration and radius tokens

Both dark and light themes must define every shared alias. New motion must also behave correctly under `prefers-reduced-motion`.

## Layout behavior

- The left history rail is expanded by default and can collapse to a 48px shortcut rail.
- The right workspace panel contains equal-width Files, Recovery, and Browser tabs. It starts
  expanded on viewports at least 1100px wide and collapsed below that threshold unless the user
  has saved a preference.
- Browser-only size controls belong inside the Browser panel. The live page takes the available
  height while concise session activity stays anchored below it.
- Below 1050px, an expanded workspace panel overlays the chat.
- Below 760px, an expanded history sidebar overlays the chat and suggested prompts become a single column.
- Conversation content and the composer have independent maximum widths so long lines remain readable on large displays.

## Composer and icons

- Keep the composer as one surface: writing area above, context/mode controls at bottom left, and model/run controls at bottom right.
- The `+` menu opens directly above the composer at the same width. Keep rows compact, organize them
  by purpose, and explain unfamiliar behavior with short secondary text or hover help.
- Images, files, and folders are first-class message context. Clipboard images and attached images
  use the same preview path and open in a focused lightbox from both composer and history.
- When a run is active, Enter queues a follow-up. Pressing Enter again with an empty composer sends
  the oldest queued message immediately as steering.
- Do not render permanent pills for capabilities the agent manages automatically. Built-in web search and auto-discovered skills remain invisible unless their execution appears in the conversation.
- Use Lucide for interactive and semantic UI icons. Default to a 1.75–1.8 stroke, use 13–16px inside dense controls, and reserve 18px or larger for primary actions and empty states.
- Use `ProviderIcon` everywhere a provider or provider-owned model is identified. Resolve from `providerKind` before transport so OpenAI-compatible connections, LM Studio, and llama.cpp remain visually distinct.
- Custom SVG is reserved for official provider marks and genuine data visualizations such as the context ring or research progress—not ordinary buttons.

## Welcome state

- Keep the empty chat visually quiet: one short heading, no decorative product initial, and no explanatory paragraph that repeats the composer’s purpose.
- Show exactly two compact, single-line suggestions. Prefer recent non-placeholder conversation titles and the active project name; use two neutral local fallbacks for a new profile.
- Derive welcome suggestions locally from already-visible history. Rendering the welcome screen must not spend model tokens or send conversation metadata to a provider.
- Clicking a suggestion should populate the composer for review rather than immediately sending a message.

## UI preview and visual QA

Development builds expose a deterministic renderer preview when Electron's preload API is unavailable:

1. Run `npm run dev`.
2. Open `http://localhost:5173/?ui-preview=1`.
3. Review the welcome state, the populated `Refine the desktop experience` conversation, the
   full-window Settings workspace, Browser/Files/Recovery panels, both themes, and compact widths.

The preview mock is development-only and is never installed when `window.api` already exists. It must stay aligned with the preload contract closely enough for representative renderer testing.

Before merging a broad UI change, verify at minimum:

- dark and light themes;
- welcome, populated chat, settings, and secondary-panel states;
- default desktop width (900px) plus a wide viewport;
- keyboard focus and accessible names for new controls;
- no horizontal overflow or clipped primary actions.
