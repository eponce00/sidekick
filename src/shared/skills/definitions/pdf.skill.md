---
id: pdf
name: PDF Files
icon: FileText
description: 'Use this skill any time a .pdf file is involved as input or output. This includes: reading or extracting text from PDFs; filling in PDF forms; creating PDFs; converting PDFs to images; analyzing PDF structure or metadata; splitting or combining PDF pages. Trigger whenever the user mentions PDF or .pdf file.'
invocation: auto
requiresPythonPackages: ['pypdf', 'pdfplumber', 'reportlab']
---

## SKILL: PDF Files

### ⚠️ Critical Rule: Never Overwrite an Existing PDF From Scratch

**If the user asks to modify or add to an existing PDF, always use the appropriate library to open and modify it.** For content edits (annotations, merging, splitting, form-filling), operate on the original file and save to the same or a new path. Only use reportlab to create a brand-new PDF that doesn't yet exist.

## Quick Reference

| Task                    | Approach                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Read/extract text       | pdfplumber (structured) or markitdown (quick summary)                                                 |
| Check if form-fillable  | `python "$env:SIDEKICK_SKILLS\pdf\check_fillable_fields.py" file.pdf`                                 |
| Fill a PDF form         | `python "$env:SIDEKICK_SKILLS\pdf\fill_fillable_fields.py" file.pdf fields.json filled.pdf`           |
| Fill with annotations   | `python "$env:SIDEKICK_SKILLS\pdf\fill_pdf_form_with_annotations.py" file.pdf fields.json filled.pdf` |
| Extract form field info | `python "$env:SIDEKICK_SKILLS\pdf\extract_form_field_info.py" file.pdf fields.json`                   |
| Convert pages to images | `python "$env:SIDEKICK_SKILLS\pdf\convert_pdf_to_images.py" file.pdf pages`                           |
| Create PDF              | Use reportlab via temp script                                                                         |
| Merge/split             | Use pypdf via temp script                                                                             |

> Skills are instructions, not package installers. Never run `pip install` as an implicit side
> effect. If a required library is unavailable, report it clearly and ask before changing the
> user's system.

### Browser PDF Workflows

When the user explicitly asks to open or fill a local PDF or a direct remote PDF URL in SideKick's
browser, use `browser_open` and the semantic PDF form controls. Use `browser_fill_form` for
compatible fields and click **Save filled copy** after the fields verify. A remote filled copy is
saved to the user's Downloads folder. Do not substitute a Python or shell form-fill unless the user
requests a programmatic file workflow or the browser reports a concrete unsupported-PDF error.

---

## Reading Content

For accurate, structured extraction use pdfplumber (preserves layout, tables, positions). Use markitdown only for a quick plain-text summary.

Write to `$env:TEMP\sk_pdf_read.py`, run, delete:

```python
import pdfplumber, sys

with pdfplumber.open(sys.argv[1]) as pdf:
    print(f'Pages: {len(pdf.pages)}')
    for i, page in enumerate(pdf.pages):
        print(f'\n--- Page {i+1} ({page.width:.0f}x{page.height:.0f}) ---')
        text = page.extract_text()
        if text:
            print(text[:2000])
        tables = page.extract_tables()
        for t_idx, table in enumerate(tables):
            print(f'  [TABLE {t_idx+1}]')
            for row in table:
                print('  ' + ' | '.join(str(c or '') for c in row))
```

```powershell
python "$env:TEMP\sk_pdf_read.py" "path\to\file.pdf"
Remove-Item "$env:TEMP\sk_pdf_read.py" -ErrorAction SilentlyContinue
```

> Note: PDFs have no lossless XML edit workflow. For edits, operate directly on the original file using pypdf/pdfplumber — never rewrite from scratch.

---

## Working with PDF Forms

### Step 1: Check if the PDF has fillable fields

```powershell
python "$env:SIDEKICK_SKILLS\pdf\check_fillable_fields.py" "form.pdf"
```

### Step 2: See all field names and types

```powershell
python "$env:SIDEKICK_SKILLS\pdf\extract_form_field_info.py" "form.pdf" "form-fields.json"
Get-Content "form-fields.json"
```

### Step 3: Fill the form

**Option A — Fill AcroForm fields (standard fillable PDF):** Add a `value` property to each
field that should be filled in the extracted `form-fields.json`, then run:

```powershell
python "$env:SIDEKICK_SKILLS\pdf\fill_fillable_fields.py" "form.pdf" "form-fields.json" "filled.pdf"
```

**Option B — Fill by adding annotation overlays (scanned forms, flat PDFs):** Build the
annotation JSON described by the helper's schema, then run:

```powershell
python "$env:SIDEKICK_SKILLS\pdf\fill_pdf_form_with_annotations.py" "form.pdf" "annotation-fields.json" "filled.pdf"
```

---

## Creating a PDF from Scratch

Write a temp script to `$env:TEMP\sk_pdf.py`:

```python
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer
from reportlab.lib import colors
import os

output = os.path.join(os.environ.get('WORKSPACE_FOLDER', os.getcwd()), 'output.pdf')
doc = SimpleDocTemplate(output, pagesize=letter)
styles = getSampleStyleSheet()
story = []

story.append(Paragraph('Document Title', styles['Title']))
story.append(Spacer(1, 12))
story.append(Paragraph('This is body text in the PDF.', styles['BodyText']))

doc.build(story)
print('Done:', output)
```

**Run it (then clean up):**

```powershell
python "$env:TEMP\sk_pdf.py"
Remove-Item "$env:TEMP\sk_pdf.py" -ErrorAction SilentlyContinue
```

---

## Merging / Splitting

```python
# Write to $env:TEMP\sk_pdf.py, run, delete
from pypdf import PdfWriter, PdfReader

# Merge multiple PDFs
writer = PdfWriter()
for fname in ['a.pdf', 'b.pdf']:
    reader = PdfReader(fname)
    for page in reader.pages:
        writer.add_page(page)
with open('merged.pdf', 'wb') as f:
    writer.write(f)

# Extract pages 2-4 (0-based index 1-3)
reader = PdfReader('input.pdf')
writer = PdfWriter()
for i in range(1, 4):
    writer.add_page(reader.pages[i])
with open('extract.pdf', 'wb') as f:
    writer.write(f)
```

---

## After Creating

Always offer to open: `Start-Process "output.pdf"`
