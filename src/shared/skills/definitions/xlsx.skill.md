---
id: xlsx
name: Spreadsheets
icon: Table
description: 'Use this skill any time a .xlsx/.xls/.csv file is involved as input or output. This includes: creating spreadsheets, financial models, or trackers; reading or extracting data from spreadsheets; editing cells, formulas, or formatting in existing files; pivot tables, charts, or conditional formatting; data analysis with pandas. Trigger whenever the user mentions spreadsheet, Excel, .xlsx, .xls, .csv, or financial model.'
invocation: auto
requiresPythonPackages: ["openpyxl", "pandas", "xlrd"]
---

## SKILL: XLSX Spreadsheets

### ⚠️ Critical Rule: Never Regenerate an Existing File

**For an existing .xlsx, open it with openpyxl, make targeted edits, and save.** Never recreate the workbook from scratch and overwrite the old file. Use `load_workbook('path/to/file.xlsx')` and only change what was requested. openpyxl does not support legacy .xls or CSV: inventory .xls with xlrd and CSV with csv/pandas; agree on a supported output format before converting. For .xlsm, preserve VBA with `keep_vba=True` and explicitly verify that unsupported workbook features have not been lost.

## Quick Reference

Run the `xlsx` preflight for normal .xlsx work; it checks openpyxl only. The declared pandas
and xlrd packages serve other workflows, not every spreadsheet task: `data-analysis` checks
pandas and `xls-read` checks xlrd for legacy .xls. Missing xlrd must not block an .xlsx edit.

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

Always use openpyxl for a structured inventory — never markitdown (lossy).

Write to `./UNIQUE_xlsx_read.py`, run, delete:

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
python "./UNIQUE_xlsx_read.py" "path\to\file.xlsx"
Remove-Item "./UNIQUE_xlsx_read.py" -ErrorAction SilentlyContinue
```

For larger analysis, use pandas after the inventory:

```python
import pandas as pd
df = pd.read_excel('file.xlsx', sheet_name=0)
print(df.describe())
```

---

## Creating or Editing with openpyxl

Write a temp script to `./UNIQUE_xlsx.py`:

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
python "./UNIQUE_xlsx.py"
Remove-Item "./UNIQUE_xlsx.py" -ErrorAction SilentlyContinue
```

---

## Editing Existing .xlsx (XML approach)

For complex formatting or structural edits:

```powershell
# Unpack
python "$env:SIDEKICK_SKILLS\office\unpack.py" "file.xlsx" "xlsx_unpacked"
# Edit XML in xlsx_unpacked\xl\worksheets\sheet1.xml
# Repack
python "$env:SIDEKICK_SKILLS\office\pack.py" "xlsx_unpacked" "NEW_output.xlsx"
```

---

## Formula Recalculation

The office pack helper checks package structure, relationships, sheet IDs and duplicate cell
references by default; this is not full XLSX schema validation. Reopen with openpyxl and verify
changed cells, formulas, and sheets independently. Use `office/render.py` with a new directory to
render PDF/page images when LibreOffice is available. Formula recalculation remains a separate step.

Check the `xlsx-recalc` workflow first: LibreOffice (`soffice` on PATH) is required in addition to openpyxl. Missing LibreOffice is a blocker, not authorization to install it. The helper preserves the input and creates `NAME-recalculated.xlsx` (or a new `--output` destination), using a disposable LibreOffice profile. Conversion may change workbook formatting/features; retain the original and inspect the recalculated copy. Never claim fresh formula values when recalculation failed or timed out.

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
