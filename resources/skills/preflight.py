"""Read-only dependency discovery. Never installs packages or executes document code."""

import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys


WORKFLOWS = {
    "pdf": {"python": {"pypdf": "pypdf", "pdfplumber": "pdfplumber", "reportlab": "reportlab"}},
    "pdf-render": {"python": {"pdf2image": "pdf2image"}, "executables": ["pdfinfo", "pdftoppm"]},
    "office": {"python": {"defusedxml": "defusedxml", "lxml": "lxml"}},
    "office-validate": {"python": {"lxml": "lxml"}, "assets": ["office/structure.py"]},
    "office-xsd": {"python": {"lxml": "lxml"}, "assets": ["office/schemas"]},
    "docx-create": {"node": ["docx"]},
    "docx-create-python": {"python": {"python-docx": "docx"}},
    "docx-comment": {"python": {"lxml": "lxml"}},
    "pptx-create": {"node": ["pptxgenjs"]},
    "pptx-create-python": {"python": {"python-pptx": "pptx"}},
    "pptx-read": {"python": {"python-pptx": "pptx"}},
    "xlsx": {"python": {"openpyxl": "openpyxl"}},
    "xls-read": {"python": {"xlrd": "xlrd"}},
    "data-analysis": {"python": {"pandas": "pandas"}},
    "xlsx-recalc": {"python": {"openpyxl": "openpyxl"}, "executables": ["soffice"]},
    "docx-accept": {"python": {"defusedxml": "defusedxml"}, "executables": ["soffice"]},
    "office-render": {"executables": ["soffice"]},
    "office-render-images": {"executables": ["soffice", "pdftoppm"]},
}


def inspect(workflow, workspace):
    requirements = WORKFLOWS[workflow]
    checks = []
    for package, module in requirements.get("python", {}).items():
        try:
            available = importlib.util.find_spec(module) is not None
        except (ImportError, ValueError):
            available = False
        checks.append({"kind": "python", "name": package, "available": available})
    for executable in requirements.get("executables", []):
        checks.append({"kind": "executable", "name": executable, "available": shutil.which(executable) is not None})
    for asset in requirements.get("assets", []):
        checks.append({"kind": "bundled-asset", "name": asset, "available": (Path(__file__).parent / asset).exists()})
    for package in requirements.get("node", []):
        available = False
        node = shutil.which("node")
        if node:
            try:
                # Resolve only; do not load or run the package. Match generated-script guidance.
                result = subprocess.run(
                    [node, "-e", "require.resolve(process.argv[1], {paths: [process.argv[2]]})", package, str(workspace)],
                    cwd=workspace, capture_output=True, timeout=5, check=False,
                )
                available = result.returncode == 0
            except (OSError, subprocess.TimeoutExpired):
                pass
        checks.append({"kind": "node", "name": package, "available": available})
    return {"workflow": workflow, "status": "available" if all(c["available"] for c in checks) else "missing_dependencies",
            "checks": checks, "note": "Discovery only, not execution qualification. No packages installed. Browser-only tasks do not require this helper."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workflow", choices=WORKFLOWS)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    args = parser.parse_args()
    report = inspect(args.workflow, args.workspace.resolve())
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["status"] == "available" else 2)
