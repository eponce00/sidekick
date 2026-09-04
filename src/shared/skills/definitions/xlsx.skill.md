---
id: xlsx
name: Spreadsheets
icon: Table
description: 'Use this skill any time a .xlsx/.xls/.csv file is involved as input or output. This includes: creating spreadsheets, financial models, or trackers; reading or extracting data from spreadsheets; editing cells, formulas, or formatting in existing files; pivot tables, charts, or conditional formatting; data analysis with pandas. Trigger whenever the user mentions spreadsheet, Excel, .xlsx, .xls, .csv, or financial model.'
invocation: auto
requiresPythonPackages: ['openpyxl', 'pandas', 'xlrd']
---

## SKILL: XLSX Spreadsheets

### ⚠️ Critical Rule: Never Regenerate an Existing File

**If the file already exists, ALWAYS open it with openpyxl, make targeted edits, and save.** Never recreate the workbook from scratch and overwrite the old file — that destroys all tabs, formulas, formatting, and data that were in the original. Use `load_workbook('path/to/file.xlsx')` and only change what was requested.

## Quick Reference

| Task                    | Approach                                                 |
| ----------------------- | -------------------------------------------------------- |
| Read/inventory content  | openpyxl structured read (see below)                     |
| Create from scratch     | openpyxl (write to file directly)                        |
| Edit data/formulas      | openpyxl (load workbook, edit, save)                     |
| Edit complex formatting | Unpack → edit XML → repack                               |
| Recalculate formulas    | `python "$env:SIDEKICK_SKILLS\xlsx\recalc.py" file.xlsx` |

> Skills are instructions, not package installers. Never run `pip install` as an implicit side
> effect. If a required library is unavailable, report it clearly and ask before changing the
> user's system.

---

## Reading Content

Always use openpyxl for a structured, lossless inventory — never markitdown (lossy).

Write to `$env:TEMP\sk_xlsx_read.py`, run, delete:

```python
import openpyxl, sys

wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
print(f'Sheets: {wb.sheetnames}')
for sheet_name in wb.sheetnames:
    ws = wb[sheet_name]
    print(f'\n=== Sheet: {sheet_name} ({ws.max_row} rows x {ws.max_column} cols) ===')
    # Print first 50 non-empty rows
    printed = 0
    for row in ws.iter_rows(values_only=True):
        if any(v is not None for v in row):
            print(row)
            printed += 1
            if printed >= 50:
                print('  ... (truncated)')
                break
```

```powershell
python "$env:TEMP\sk_xlsx_read.py" "path\to\file.xlsx"
Remove-Item "$env:TEMP\sk_xlsx_read.py" -ErrorAction SilentlyContinue
```

For larger analysis, use pandas after the inventory:

```python
import pandas as pd
df = pd.read_excel('file.xlsx', sheet_name=0)
print(df.describe())
```

---

## Creating or Editing with openpyxl

Write a temp script to `$env:TEMP\sk_xlsx.py`:

```python
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# Create new
wb = openpyxl.Workbook()
ws = wb.active
ws.title = 'Sheet1'

# Add headers
headers = ['Date', 'Description', 'Amount', 'Category']
for col, h in enumerate(headers, 1):
    cell = ws.cell(row=1, column=col, value=h)
    cell.font = Font(bold=True, color='FFFFFF')
    cell.fill = PatternFill('solid', fgColor='1E2761')
    cell.alignment = Alignment(horizontal='center')

# Add data
ws.cell(row=2, column=1, value='2024-01-15')
ws.cell(row=2, column=2, value='Office supplies')
ws.cell(row=2, column=3, value=49.99)
ws.cell(row=2, column=4, value='Expenses')

# Auto column width
for col in ws.columns:
    max_len = max(len(str(c.value or '')) for c in col)
    ws.column_dimensions[get_column_letter(col[0].column)].width = min(max_len + 4, 40)

wb.save('output.xlsx')
print('Done')
```

**Run it (then clean up):**

```powershell
python "$env:TEMP\sk_xlsx.py"
Remove-Item "$env:TEMP\sk_xlsx.py" -ErrorAction SilentlyContinue
```

---

## Editing Existing .xlsx (XML approach)

For complex formatting or structural edits:

```powershell
# Unpack
python "$env:SIDEKICK_SKILLS\office\unpack.py" "file.xlsx" "xlsx_unpacked"
# Edit XML in xlsx_unpacked\xl\worksheets\sheet1.xml
# Repack
python "$env:SIDEKICK_SKILLS\office\pack.py" "xlsx_unpacked" "output.xlsx"
```

---

## Formula Recalculation

If the file has formulas and they need fresh values for downstream tools:

```powershell
python "$env:SIDEKICK_SKILLS\xlsx\recalc.py" "output.xlsx"
```

---

## Cell Color Conventions

Follow industry-standard color coding so users instantly know what's a formula vs input:

| Cell type                    | Background           | Usage                            |
| ---------------------------- | -------------------- | -------------------------------- |
| **Input** (hardcoded values) | Pale blue `#DCE6F1`  | Numbers the user changes         |
| **Formula** (calculated)     | White / no fill      | Computed values - never override |
| **Cross-sheet link**         | Pale green `#E2EFDA` | Values pulled from other sheets  |
| **Error / warning**          | Pale red `#FCE4D6`   | Validation failures              |
| **Header row**               | Brand color (dark)   | Always bold + white text         |

```python
INPUT_FILL = PatternFill('solid', fgColor='DCE6F1')
FORMULA_FILL = PatternFill('solid', fgColor='FFFFFF')
CROSS_FILL = PatternFill('solid', fgColor='E2EFDA')
HEADER_FILL = PatternFill('solid', fgColor='1E2761')
```

---

## After Creating

Always offer to open: `Start-Process "output.xlsx"`
