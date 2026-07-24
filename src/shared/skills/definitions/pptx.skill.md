---
id: pptx
name: Presentations
icon: GalleryHorizontal
description: 'Use this skill any time a .pptx file is involved as input or output. This includes: creating slide decks, pitch decks, or presentations; reading or extracting text from .pptx files; editing or updating existing presentations; combining or splitting slide files; working with templates, layouts, speaker notes, or comments. Trigger whenever the user mentions deck, slides, presentation, or references a .pptx filename.'
invocation: auto
requiresNodePackages: ['pptxgenjs']
---

## SKILL: PPTX Presentations

### ⚠️ Critical Rule: Never Regenerate an Existing File

**If the file already exists, ALWAYS edit it via the unpack → edit XML → repack workflow.** Never run a new script that overwrites the existing file from scratch. Generating a new presentation and saving it over the old file is forbidden when the file already exists — it destroys all content, design, and history that were in the original.

## Quick Reference

| Task                   | Approach                                         |
| ---------------------- | ------------------------------------------------ |
| Read/inventory content | python-pptx structured read (see below)          |
| Create from scratch    | Use `pptxgenjs` npm package (globally installed) |
| Edit existing .pptx    | Unpack → edit XML → repack                       |

> Skills are instructions, not package installers. Never install packages as an implicit side
> effect. If a required local runtime is unavailable, report it clearly and ask before changing
> the user's system.
> **If a tool call fails twice for the same reason, stop and report the blocker to the user — do not retry indefinitely.**

---

## Reading Content

Always use python-pptx for a structured, lossless inventory — never markitdown (lossy).

Write to `$env:TEMP\sk_pptx_read.py`, run, delete:

```python
from pptx import Presentation
import sys

prs = Presentation(sys.argv[1])
print(f'Slides: {len(prs.slides)}  Layout: {prs.slide_width.inches:.2f}" x {prs.slide_height.inches:.2f}"')
for i, slide in enumerate(prs.slides):
    layout = slide.slide_layout.name if slide.slide_layout else 'unknown'
    print(f'\n=== Slide {i+1} (layout: {layout}) ===')
    for shape in slide.shapes:
        if shape.has_text_frame:
            text = shape.text_frame.text.strip()
            if text:
                print(f'  [TEXT] {shape.name} @ ({shape.left/914400:.2f}", {shape.top/914400:.2f}"): {text[:300]}')
        if shape.has_table:
            t = shape.table
            print(f'  [TABLE] {shape.name}: {len(t.rows)}r x {len(t.columns)}c')
            for row in t.rows:
                print('    ' + ' | '.join(c.text_frame.text for c in row.cells))
        if shape.shape_type == 13:  # MSO_SHAPE_TYPE.PICTURE
            print(f'  [IMAGE] {shape.name}')
    if slide.has_notes_slide:
        notes = slide.notes_slide.notes_text_frame.text.strip()
        if notes:
            print(f'  [NOTES] {notes[:300]}')
```

```powershell
python "$env:TEMP\sk_pptx_read.py" "path\to\presentation.pptx"
Remove-Item "$env:TEMP\sk_pptx_read.py" -ErrorAction SilentlyContinue
```

## Editing Existing Presentations

A .pptx file is a ZIP archive. Use the bundled office scripts (same as DOCX):

```powershell
# Unpack
python "SKILLS\office\unpack.py" "presentation.pptx" "pptx_unpacked"
# Edit XML in pptx_unpacked\ppt\slides\
# Repack (always use --validate false to avoid Windows encoding crashes)
python "SKILLS\office\pack.py" "pptx_unpacked" "output.pptx" --validate false
```

---

## Creating Presentations with pptxgenjs

Write the temp script to `$env:TEMP` (never to the workspace), run it, it auto-deletes.

```javascript
// Script goes in $env:TEMP — keeps the workspace clean
const pptx = require('pptxgenjs')
const path = require('path')
const pres = new pptx()
pres.layout = 'LAYOUT_WIDE' // 16:9 — full width is 13.33 inches

// Title slide
let slide = pres.addSlide()
slide.background = { color: '1E2761' }
slide.addText('Presentation Title', {
  x: 0.5,
  y: 2,
  w: 12,
  h: 1.5,
  fontSize: 44,
  bold: true,
  color: 'FFFFFF',
  align: 'center'
})

// Content slide
slide = pres.addSlide()
slide.addText('Section Title', {
  x: 0.5,
  y: 0.3,
  w: 12,
  h: 0.8,
  fontSize: 28,
  bold: true,
  color: '1E2761'
})
slide.addText(
  [
    { text: 'Key point one', options: { bullet: true } },
    { text: 'Key point two', options: { bullet: true } }
  ],
  { x: 0.5, y: 1.5, w: 7, h: 4, fontSize: 16, color: '333333' }
)

const outputPath = path.join(process.env.WORKSPACE_FOLDER || process.cwd(), 'output.pptx')
pres.writeFile({ fileName: outputPath }).then(() => console.log('Done: ' + outputPath))
```

### Adding Images

`addImage` is called on the **slide** object (not the presentation):

```javascript
// From a local file path
slide.addImage({ path: 'C:\\path\\to\\logo.png', x: 0.5, y: 0.5, w: 2, h: 1 })

// From a URL (downloaded at render time)
slide.addImage({ path: 'https://example.com/logo.png', x: 0.5, y: 0.5, w: 2, h: 1 })

// From base64 data
slide.addImage({ data: 'image/png;base64,iVBORw0...', x: 0.5, y: 0.5, w: 2, h: 1 })
```

**If external URLs are blocked (VPN/firewall):** Download images first with PowerShell, then reference by local path:

```powershell
Invoke-WebRequest -Uri 'https://example.com/logo.png' -OutFile "$env:TEMP\logo.png" -UseBasicParsing
```

If `Invoke-WebRequest` is also blocked, use `curl.exe`:

```powershell
curl.exe -L -o "$env:TEMP\logo.png" 'https://example.com/logo.png'
```

### ⚠️ addShape API — Critical: Shape Type is the FIRST Argument

**WRONG** (will silently produce broken/empty shapes and corrupt the file):

```javascript
// ❌ DO NOT DO THIS
slide.addShape({ shapeType: 'rect', x: 0, y: 0, w: 13.33, h: 0.5, fill: { color: 'FF0000' } })
```

**CORRECT** — shape type is the first argument, options object is second:

```javascript
// ✅ Correct addShape usage
slide.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.5, fill: { color: 'FF0000' } })
slide.addShape(pres.ShapeType.roundRect, {
  x: 1,
  y: 1,
  w: 4,
  h: 1,
  fill: { color: '00B4D8' },
  rectRadius: 0.2
})
```

**Common shape types:** `pres.ShapeType.rect`, `pres.ShapeType.roundRect`, `pres.ShapeType.ellipse`, `pres.ShapeType.line`

**Width reference:** LAYOUT_WIDE is 13.33" wide × 7.5" tall. Never use `'100%'` for shapes — use numeric inch values.

**To layer text over a shape**, call `addShape` first, then `addText` at the same coordinates.

**Run it (script lives in TEMP, output goes to workspace):**

```powershell
$script = @'
<paste full script here>
'@
Set-Content -Path (Join-Path $env:TEMP 'sk_pptx.js') -Value $script -Encoding UTF8
$env:NODE_PATH = (npm root -g 2>$null)
node (Join-Path $env:TEMP 'sk_pptx.js')
Remove-Item (Join-Path $env:TEMP 'sk_pptx.js') -ErrorAction SilentlyContinue
```

> **Important:** Always write the script to `$env:TEMP`, not to the workspace. The output `.pptx` file should go to `$env:WORKSPACE_FOLDER`.

### Design Principles — DO NOT make boring slides

- Pick a bold, **topic-specific** color palette. If the same colors work for any other topic, you haven't made specific enough choices.
- **Dominance rule**: one color at 60–70% visual weight, 1–2 supporting tones, one sharp accent.
- Dark backgrounds on title + conclusion slides, light for content ("sandwich") — or commit to dark throughout.
- Every slide must have a visual element (image, chart, icon, or shape). Text-only slides are forgettable.
- **NEVER use accent lines under titles** — hallmark of AI-generated slides. Use whitespace or background color instead.
- Vary layouts across slides.

**Typography:** title 36–44pt bold, section header 20–24pt bold, body 14–16pt, captions 10–12pt.

**Color palette ideas:**

- Midnight Executive: navy `#1E2761`, ice blue `#CADCFC`, white
- Coral Energy: coral `#F96167`, gold `#F9E795`, navy `#2F3C7E`
- Forest & Moss: forest `#2C5F2D`, moss `#97BC62`, cream
- Charcoal Minimal: charcoal `#36454F`, off-white `#F2F2F2`, black

---

## After Creating

Always offer to open: `Start-Process "output.pptx"`
