---
id: web-artifacts
name: Web Artifacts
icon: Code2
description: Create a live interactive visualization or tool rendered inside the chat when the user wants that format; not for websites, apps, or HTML meant to live in project files
invocation: auto
activationScope: run
---

## SKILL: Web Artifacts Builder

An artifact is an interactive result rendered inside the SideKick chat. Use this capability only
when the user explicitly wants a live, inline, interactive, visual, or exploratory result in the
conversation, or when an in-chat chart, calculator, simulation, map, or diagram is clearly the
requested deliverable.

### Deliverable boundary

- A website, landing page, web app, component, HTML document, or CSS/JavaScript implementation
  intended to live in the active project belongs in workspace files. Use the workspace tools and do
  not call `create_artifact` for that work.
- When a project is active and the request could mean either a website file or an inline preview,
  default to the durable project-file deliverable.
- Do not create both an inline artifact and project HTML for the same request unless the user
  explicitly asks for both deliverables.
- Do not use an artifact merely to preview work that can be verified from the project itself.

When the requested deliverable is an inline HTML, SVG, or React artifact, follow these guidelines.

### Available Libraries (React artifacts)

**Pre-bundled (instant, always available):**
react, recharts, chart.js, framer-motion, lucide-react, lodash, mathjs, leaflet, react-leaflet, d3, date-fns

**Any other npm package:** Just import it normally — the sandbox will fetch it from esm.sh CDN automatically.
Examples: `import * as THREE from 'three'`, `import { v4 as uuidv4 } from 'uuid'`, `import { z } from 'zod'`
Packages that use Node.js APIs (fs, child_process, etc.) will not work in the browser sandbox.
Do NOT use Box, Material UI, styled-components, @emotion, or react-native-web — they conflict with the sandbox React instance.

### Styling in React artifacts

**Tailwind CSS is available globally — the best choice for layout and styling.**
Just use `className` with utility classes (e.g. `className="flex flex-col gap-4 p-6 rounded-xl"`).
No import is needed. Tailwind's Play CDN is already injected in the sandbox.

Use the Sidekick semantic Tailwind colors for the artifact shell and interactive controls so they
remain readable in both themes:

- Backgrounds: `bg-artifact-bg`, `bg-artifact-panel`, `bg-artifact-surface`, `hover:bg-artifact-hover`
- Text: `text-artifact-primary`, `text-artifact-secondary`, `text-artifact-muted`
- Accent: `bg-artifact-accent text-artifact-accent-foreground`
- Other: `border-artifact-border`, `text-artifact-success`, `text-artifact-error`, `text-artifact-warning`

Do not use fixed `text-black`, `text-gray-900`, or `text-white` on theme-aware surfaces. If a hover,
selected, or active state changes the background, explicitly give that state a compatible semantic
text color too. Use fixed content colors only when they communicate data and verify their contrast.

The sandbox also exposes a complete CSS-variable contract for inline styles and custom CSS:
`--app-bg`, `--panel-bg`, `--surface-0` through `--surface-4`, `--surface-hover`, `--input-bg`,
`--border`, `--border-subtle`, `--border-strong`, `--text-primary`, `--text-secondary`,
`--text-muted`, `--accent`, `--accent-strong`, `--accent-pressed`, `--accent-subtle`,
`--accent-muted`, `--on-accent`, `--color-success`, `--color-error`, and `--color-warning`.

React code can also read the live `theme` object. It contains the camelCase equivalents plus
`theme.themeMode` (`"dark"` or `"light"`) and updates when the Sidekick theme changes.

Lucide icons: import as **named exports** — e.g. `import { Flame, Star } from 'lucide-react'`.
Do NOT import the namespace as `import { lucideReact }` — that is not a valid export.

Use framer-motion for smooth transitions and animations when motion adds value.

### Styling in HTML artifacts

- Use embedded `<style>` blocks — no external CSS CDN is guaranteed to load.
- The HTML document receives the same live CSS variables and safe control defaults as React.
- Prefer those variables over hardcoded app-shell colors and define readable `:hover`, `:focus`,
  `:active`, and selected-state foreground/background pairs.
- Generated CSS is inserted after Sidekick's base layer, so intentional artifact styles still win.

### Design Quality

- NEVER use excessive centered layouts, purple gradients, uniform rounded corners everywhere, or Inter as the only font — these are hallmarks of generic AI output.
- Pick a purposeful color palette specific to the content/topic. One color should dominate (60–70% visual weight), with 1–2 supporting tones and one sharp accent.
- Choose an interesting font pairing when the artifact benefits from it.
- Every section needs a visual element — avoid walls of text.
- Check the result mentally in both light and dark themes, including hover and focused controls.
- A subtree may opt out of Sidekick's severe-contrast repair only when intentional (for example,
  text used as an image mask) by setting `data-sidekick-contrast="preserve"`.

### Component Patterns (React artifacts)

- For complex UI with multiple views, use a simple tab/nav state pattern with `useState`.
- Keep components focused and readable.
- Derive displayed values — don't hardcode data that should be calculated.
- Add accessibility attributes (`aria-label`, `role`) on interactive elements.

### Layout Guidance

- Use CSS Grid or Flexbox, not fixed pixel positions.
- Use `clamp()` or responsive units so the artifact looks good at different widths.
- Respect the compact chat panel context — don't design for a full 1920px viewport.
