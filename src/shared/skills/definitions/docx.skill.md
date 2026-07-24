---
id: docx
name: Word Documents
icon: FileType2
description: 'Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of Word doc, word document, .docx, or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx files, inserting or replacing images, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a report, memo, letter, template, or similar deliverable as a Word file, use this skill.'
invocation: auto
requiresNodePackages: ['docx']
---

## SKILL: DOCX Creation & Editing

### ⚠️ Critical Rule: Never Regenerate an Existing File

**If the file already exists, ALWAYS edit it via the unpack → edit XML → repack workflow.** Never run a new script that overwrites it from scratch. Generating a brand-new document and saving it over the old file is forbidden when the file already exists — it destroys all styles, metadata, and tracked history that were in the original.

## Quick Reference

| Task                   | Approach                                          |
| ---------------------- | ------------------------------------------------- |
| Read/analyze content   | `python SKILLS\office\unpack.py` then inspect XML |
| Create new document    | Use the `docx` npm package when it is available   |
| Edit existing document | Unpack → edit XML → repack                        |
| Accept tracked changes | `python SKILLS\docx\accept_changes.py`            |
| Add comments           | `python SKILLS\docx\comment.py`                   |

> **SKILLS** refers to the bundled scripts path shown in the "Skill Scripts" section above.
> Skills are instructions, not package installers. Never install packages as an implicit side effect.
> If a required local runtime is unavailable, report the missing dependency clearly and ask before
> changing the user's system.

---

## Creating New Documents

Use the available `docx` npm package. Write the temp script to `$env:TEMP` (never to the workspace), run it, then it auto-deletes.

```javascript
// Script goes in $env:TEMP — keeps the workspace clean
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  ImageRun,
  Header,
  Footer,
  AlignmentType,
  PageOrientation,
  LevelFormat,
  ExternalHyperlink,
  TableOfContents,
  HeadingLevel,
  BorderStyle,
  WidthType,
  ShadingType,
  VerticalAlign,
  PageNumber,
  PageBreak
} = require('docx')
const fs = require('fs')
const path = require('path')

const outputPath = path.join(process.env.WORKSPACE_FOLDER || process.cwd(), 'output.docx')

const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Arial', size: 24 } } },
    paragraphStyles: [
      {
        id: 'Heading1',
        name: 'Heading 1',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { size: 32, bold: true, font: 'Arial' },
        paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 }
      },
      {
        id: 'Heading2',
        name: 'Heading 2',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { size: 28, bold: true, font: 'Arial' },
        paragraph: { spacing: { before: 180, after: 180 }, outlineLevel: 1 }
      }
    ]
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
        }
      },
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Title')] }),
        new Paragraph({ children: [new TextRun('Body text here.')] })
      ]
    }
  ]
})

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(outputPath, buf)
  console.log('Done: ' + outputPath)
})
```

**Run it (script lives in TEMP, output goes to workspace):**

```powershell
# Set NODE_PATH so Node can find globally installed packages
$env:NODE_PATH = (npm root -g 2>$null)
$scriptPath = Join-Path $env:TEMP 'sk_docx.js'
# ... (do not put generated script source into a shell command; create it with the file-writing tool)
# Better pattern: write script inline with Set-Content, then run it
$script = @'
<paste full script here>
'@
Set-Content -Path (Join-Path $env:TEMP 'sk_docx.js') -Value $script -Encoding UTF8
$env:NODE_PATH = (npm root -g 2>$null)
node (Join-Path $env:TEMP 'sk_docx.js')
Remove-Item (Join-Path $env:TEMP 'sk_docx.js') -ErrorAction SilentlyContinue
```

> **Important:** Always write the script to `$env:TEMP`, not to the workspace. The output `.docx` file should go to `$env:WORKSPACE_FOLDER`.

### Critical Rules for docx-js

- Page size: docx-js defaults to A4 — always set explicitly. US Letter: `width: 12240, height: 15840`
- Landscape: pass portrait dimensions + `orientation: PageOrientation.LANDSCAPE` (docx-js swaps internally)
- Never use `\n` inside paragraphs — use separate `new Paragraph()` elements
- Never use unicode bullets — use `LevelFormat.BULLET` with numbering config
- `PageBreak` must be inside a `Paragraph`
- `ImageRun` requires `type` field: `{ type: 'png', data: fs.readFileSync('img.png'), ... }`
- Tables: set `columnWidths` on table AND `width` on each cell; always use `WidthType.DXA` (not PERCENTAGE — breaks Google Docs)
- Use `ShadingType.CLEAR` (not SOLID) for table cell backgrounds
- TOC: `new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-3' })` — headings must use HeadingLevel only
- Override built-in heading styles with exact IDs: `'Heading1'`, `'Heading2'` — include `outlineLevel` for TOC
- Never use tables as horizontal dividers — use a paragraph border instead

---

## Editing Existing Documents

Follow all 3 steps in order.

### Step 1: Unpack

```powershell
python "SKILLS\office\unpack.py" "document.docx" "doc_unpacked"
```

Extracts XML, pretty-prints, merges adjacent runs, converts smart quotes to XML entities.

### Step 2: Edit XML

Edit files in `doc_unpacked\word\`.

**IMPORTANT — prefer full file rewrites over partial edits:**

- `document.xml` uses CRLF line endings and compact formatting — partial string replacements are unreliable and often fail with "Target string not found"
- For any structural change (adding paragraphs, sections, tables), **rewrite the entire `document.xml`** using the file-writing capability provided for the active model
- Only use targeted edits for trivial single-word/phrase changes where the exact XML is known

**Use "Claude" as author** for tracked changes and comments.

**Smart quotes in XML — use entities:**
| Entity | Character |
|--------|-----------|
| `&#x2018;` | ' (left single) |
| `&#x2019;` | ' (right single / apostrophe) |
| `&#x201C;` | " (left double) |
| `&#x201D;` | " (right double) |

**Tracked changes:**

```xml
<!-- Insertion -->
<w:ins w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:t>inserted text</w:t></w:r>
</w:ins>

<!-- Deletion -->
<w:del w:id="2" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
```

**Add comments:**

```powershell
python "SKILLS\docx\comment.py" "doc_unpacked" 0 "Comment text"
python "SKILLS\docx\comment.py" "doc_unpacked" 1 "Reply" --parent 0
```

### Step 3: Repack

```powershell
python "SKILLS\office\pack.py" "doc_unpacked" "output.docx" --original "document.docx" --validate false
```

Always use `--validate false` — the validator can crash on Windows due to encoding issues with non-ASCII output characters.

---

## After Creating/Editing

Always offer to open: `Start-Process "output.docx"`
