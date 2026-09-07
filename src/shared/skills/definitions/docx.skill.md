---
id: docx
name: Word Documents
icon: FileType2
description: 'Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of Word doc, word document, .docx, or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx files, inserting or replacing images, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a report, memo, letter, template, or similar deliverable as a Word file, use this skill.'
invocation: auto
requiresNodePackages: ["docx"]
requiresPythonPackages: ["defusedxml", "lxml", "python-docx"]
---

## SKILL: DOCX Creation & Editing

### Bundled capability limits

Classic anchored DOCX comments and non-mutating OPC/OOXML structural validation are supported.
Threaded replies and full XSD conformance validation are not supported. Existing thread-extension
parts are preserved, but the helper creates classic comments, not modern thread metadata.
Tracked-change acceptance and rendering require local LibreOffice. They passed synthetic Linux
LibreOffice qualification; do not generalize that to all documents or untested native platforms.

### ⚠️ Critical Rule: Never Regenerate an Existing File

**If the file already exists, ALWAYS edit it via the unpack → edit XML → repack workflow.** Never run a new script that overwrites it from scratch. Generating a brand-new document and saving it over the old file is forbidden when the file already exists — it destroys all styles, metadata, and tracked history that were in the original.

## Quick Reference

| Task                   | Approach                                                          |
| ---------------------- | ----------------------------------------------------------------- |
| Read/analyze content   | `python "$env:SIDEKICK_SKILLS\office\unpack.py"` then inspect XML |
| Create new document    | Available `python-docx` or Node `docx` engine, checked explicitly |
| Edit existing document | Unpack → edit XML → repack                                        |
| Accept tracked changes | `python "$env:SIDEKICK_SKILLS\docx\accept_changes.py"`            |
| Add comments           | `python "$env:SIDEKICK_SKILLS\docx\comment.py" DIR auto "Text" --paragraph 0` |
| Validate structure     | `python "$env:SIDEKICK_SKILLS\office\validate.py" document.docx` |
| Render PDF/page images | `python "$env:SIDEKICK_SKILLS\office\render.py" document.docx NEW_DIR --images` |

> `SIDEKICK_SKILLS` is the read-only bundled scripts directory supplied to shell commands.
> Skills are instructions, not package installers. Never install packages as an implicit side effect.
> If a required local runtime is unavailable, report the missing dependency clearly and ask before
> changing the user's system.

---

## Creating New Documents

### Choose an available creation engine

Check `docx-create-python` for Python `python-docx`, or `docx-create` for Node `docx`.
These are separate supported engines: discovering one does not imply the other is installed.
If the user explicitly requests an engine, honor it and report missing dependencies instead of
switching. Otherwise use an available engine with the required features; never install implicitly.

For straightforward new documents, the qualified Python creation route is:

```python
from docx import Document
from docx.shared import Inches
doc = Document()
section = doc.sections[0]
section.page_width, section.page_height = Inches(8.5), Inches(11)
doc.add_heading('Document title', 0)
doc.add_paragraph('Document content.')
# Choose a NEW workspace output path. Never regenerate an existing document.
doc.save('NEW_document.docx')
```

Reopen with `Document('NEW_document.docx')`, verify paragraphs/tables, run structural validation,
then render and inspect pages when the required tools are available. High-level libraries may
not preserve every Office feature; use targeted XML for existing documents.

### Node docx creation route

Use `docx` only after dependency discovery succeeds. Create a uniquely named temporary script with the file-editing tool in a writable project-relative location (or managed scratch if supported); run it and explicitly clean up that script.

```javascript
// Use a uniquely named temporary script created through the file-editing tool.
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
} = require(require.resolve('docx', { paths: [process.env.WORKSPACE_FOLDER || process.cwd()] }))
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

**Run the script created with the file-editing tool; output goes to the workspace:**

```powershell
node './UNIQUE_docx.cjs'
# Delete only the temporary script after verifying the output.
```

> The output `.docx` belongs in the workspace. Never overwrite an existing output unintentionally.

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
python "$env:SIDEKICK_SKILLS\office\unpack.py" "document.docx" "doc_unpacked"
```

Extracts into a new directory and pretty-prints XML. Run merging and tracked-change simplification
are disabled by default so unrelated document history is not rewritten. Unsafe archive paths and
oversized packages are rejected before output creation.

### Step 2: Edit XML

Edit files in `doc_unpacked\word\`.

Use targeted XML-aware edits and preserve unrelated elements, relationships, styles, metadata,
and namespace declarations. Avoid whole-document regeneration. Use the user's requested author,
or "SideKick" when none is specified, for tracked changes and comments.

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

Check `docx-comment`, inventory body paragraphs, and select the exact zero-based paragraph index
to annotate (including body-table paragraphs in document order). Pass plain text, not pre-escaped
XML. The helper creates the comment part, relationship, content type, and matching range/reference
markers together; do not add a second set manually. `auto` chooses an unused ID. Existing IDs and
unrelated document parts are preserved. Duplicate IDs, invalid paragraph indices, and `--parent`
(threaded replies) fail before mutation.

```powershell
python "$env:SIDEKICK_SKILLS\docx\comment.py" "doc_unpacked" auto "Review this paragraph" --paragraph 2 --author "SideKick"
```

### Step 3: Repack

```powershell
python "$env:SIDEKICK_SKILLS\office\pack.py" "doc_unpacked" "NEW_output.docx"
```

Packing runs structural checks by default: XML safety, content types, relationships, and selected
Office invariants including comment IDs/anchors. This is not complete XSD or semantic validation.
If a helper reports incomplete rollback or transaction residue, stop and preserve the unpacked
directory and retained backups for recovery; never delete them merely to bypass the check.
Packing uses atomic no-overwrite publication and may reject filesystems without hard-link support.
Reopen and inspect changed content, then use `office-render` / `office-render-images` preflight
and the render helper to inspect layout. If the user requires full XSD validation, explain the
unsupported scope; `--xsd` fails explicitly rather than pretending structural checks are equivalent.

---

## After Creating/Editing

Always offer to open: `Start-Process "output.docx"`
