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

### How an artifact sits in the chat

- It renders directly in your reply, as wide as the text and on the chat's own background, with
  no card, border or title bar around it. Its frame grows to fit the content, up to about two
  screens; beyond that it scrolls, and the user can open it full screen.
- Leave the page background transparent and start with the content. Do not wrap the whole artifact
  in a card, panel, border, shadow or padded box; use cards only for things that are cards inside
  it, such as a metric tile or an item in a list.
- Put the title and explanations in your reply, not inside the artifact. Do not repeat its title as
  a heading.
- Let the height follow the content: no `h-screen`, `100vh`, `min-h-screen`, fixed outer heights,
  `position: fixed`, or inner scrolling areas. Give each chart an explicit height, such as 240px.
- Design for the chat column, about 480–760px wide, and keep it usable at 360px: use
  `repeat(auto-fit, minmax(160px, 1fr))` grids and `minmax(0, 1fr)` columns.
- SideKick shows its own controls (view code, copy, full screen) when the user hovers. Do not add
  full-screen or copy-code buttons.

### SideKick's look, by default

- Text already uses the app's font at the chat's size, in the user's light or dark theme and accent
  color, and follows them live. Do not load fonts or set a font family.
- Plain elements are already styled like SideKick: `button` is quiet, and the one main action gets
  the `primary` class or `type="submit"`; `input`, `select`, `textarea`, sliders and checkboxes use
  the accent; `table` is a rounded card with lines between rows; `code`, `pre`, `blockquote`,
  headings and links match replies. Write bare elements and add only layout. Your own styles always
  win over these.
- Use the theme's CSS variables, never fixed app-shell colors:
  - Surfaces: `--surface-1` to `--surface-4` (tiles and cards: `--surface-2`), `--input-bg`
  - Text: `--text-primary`, `--text-secondary`, `--text-muted`
  - Accent: `--accent`, `--accent-strong`, `--accent-subtle`, `--accent-muted`, and `--on-accent`
    for text on the accent
  - Lines: `--border`, `--border-subtle`, `--border-strong`
  - Status: `--color-success`, `--color-warning`, `--color-error`
  - Data series: `--chart-1` (the accent) to `--chart-5`
  - Shape: `--radius-sm` (6px), `--radius-md` (10px, controls), `--radius-lg` (14px, cards),
    `--space-1` to `--space-8`, `--font-mono`
- Show restraint. The accent marks the primary action, the main series and the selected state;
  neutral surfaces carry everything else. No gradients, glows, heavy shadows, emoji icons or
  decorative backgrounds. Use weights 400 to 600, sentence case, and rounded, tabular numbers.
- If a hover, selected or active state changes a background, give it a matching text color too.
  Use fixed colors only for data that needs them, and check their contrast in both themes. A
  subtree may opt out of SideKick's severe-contrast repair only when intentional (for example,
  text used as an image mask) with `data-sidekick-contrast="preserve"`.

### React artifacts

- Tailwind is available through `className`; no import is needed. `font-sans`, `font-mono` and a
  bare `border` already use the app's font and border color. Theme colors as classes:
  `bg-artifact-surface`, `hover:bg-artifact-hover`, `text-artifact-primary`,
  `text-artifact-secondary`, `text-artifact-muted`, `bg-artifact-accent
text-artifact-accent-foreground`, `bg-artifact-accent-subtle`, `border-artifact-border`,
  `text-artifact-success`, `text-artifact-error`, `text-artifact-warning`, and
  `bg-artifact-chart-1` to `bg-artifact-chart-5`. Do not use `bg-white`, `bg-gray-900`,
  `text-black` or `text-white` on theme surfaces.
- Code can read the live `theme` object: the camelCase equivalents of the variables plus
  `theme.themeMode` (`"dark"` or `"light"`). It updates when SideKick's theme changes.
- Chart.js already uses the theme's text color, grid color and font. For Recharts, pass the
  variables, for example `stroke="var(--chart-1)"`; axis text and tooltips are already themed.
- Lucide icons: import as **named exports**, for example `import { Flame, Star } from 'lucide-react'`.
  Do NOT import the namespace as `import { lucideReact }`; that is not a valid export.
- Use framer-motion for transitions only where motion helps understanding.

### HTML and SVG artifacts

- Write a fragment or a whole document with embedded `<style>` and inline `<script>`. Scripts run,
  and `DOMContentLoaded` and `load` fire as in any page. External stylesheets and scripts from
  CDNs do not load.
- HTML and SVG receive the same variables and base styles as React, and update with the theme.
  An SVG can use the variables in `fill` and `stroke`, for example `fill="var(--accent)"`.

### Component patterns

- For multiple views, use a simple tab or segmented control with `useState`.
- Derive displayed values; do not hardcode data that should be calculated.
- Add accessibility attributes (`aria-label`, `role`) on interactive elements.

### Reviewing the result

- `create_artifact` renders the artifact the way the chat shows it and reports back: whether it
  rendered, any runtime errors, and, for models that accept images, a screenshot taken after its
  data requests had time to load.
- In a chat, a builder reviews and fixes the artifact before its result comes back, and the result
  says so. That version is finished: describe it and do not rebuild it to polish it. Call
  `create_artifact` again only to change what the user asked for.
- Look at that result before telling the user it works. If it failed, is blank, still shows a
  loading state, or does not match the request, fix it and call `create_artifact` again.
- Treat anything the screenshot shows that disagrees with the request or with itself as a defect to
  fix before replying: wrong or mixed units, `NaN` or placeholder values, clipped or overlapping
  text, controls that do nothing. Do not call a visible defect minor and finish.
- To change an existing artifact, start from its current code in the conversation and send the
  complete updated code. Never send a shortened or partial version.
- Describe only what the result showed. If no screenshot was returned, say how it looks is
  unverified rather than describing it.
