"""Disposable bundled-helper qualification. Run with Python 3.10+; installs nothing.

Optional dependencies produce explicit skips, never fabricated passes.
Use --assets PATH to exercise a packaged resources/skills directory.
"""

import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

# Qualification must not create bytecode inside the source or installed helper bundle.
sys.dont_write_bytecode = True

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--assets", type=Path, default=Path(__file__).resolve().parents[1] / "resources" / "skills")
args = parser.parse_args()
ASSETS = args.assets.resolve()


def load_helper(relative):
    spec = importlib.util.spec_from_file_location("qualification_helper", ASSETS / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BundledHelperQualification(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sidekick-skills-qualification-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def require(self, *modules):
        missing = [module for module in modules if importlib.util.find_spec(module) is None]
        if missing:
            self.skipTest("Missing dependencies (not installed): " + ", ".join(missing))

    def helper(self, relative, *arguments, expected=0):
        result = subprocess.run([sys.executable, "-B", str(ASSETS / relative), *map(str, arguments)],
                                cwd=self.root, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result.stdout

    def test_preflight_discovers_missing_without_loading_or_installing(self):
        module = load_helper("preflight.py")
        with patch.object(module.importlib.util, "find_spec", return_value=None):
            result = module.inspect("pdf", self.root)
        self.assertEqual(result["status"], "missing_dependencies")
        self.assertTrue(all(not check["available"] for check in result["checks"]))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_preflight_cli_reports_assets(self):
        result = subprocess.run([sys.executable, "-B", str(ASSETS / "preflight.py"), "office-xsd"],
                                cwd=self.root, capture_output=True, text=True, timeout=10)
        report = json.loads(result.stdout)
        self.assertIn(result.returncode, (0, 2))
        schema = next(check for check in report["checks"] if check["kind"] == "bundled-asset")
        self.assertEqual(schema["available"], (ASSETS / "office/schemas").exists())

    def test_office_unpack_pack_preserves_fixture_content(self):
        self.require("defusedxml", "lxml")
        original = self.root / "fixture.docx"
        with zipfile.ZipFile(original, "w") as archive:
            archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
            archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Fixture café 42</w:t></w:r></w:p></w:body></w:document>')
        before = original.read_bytes()
        unpacked = self.root / "unpacked"
        self.helper("office/unpack.py", original, unpacked)
        output = self.root / "repacked.docx"
        self.helper("office/pack.py", unpacked, output, "--validate", "false")
        with zipfile.ZipFile(output) as archive:
            self.assertIn("Fixture café 42", archive.read("word/document.xml").decode())
        self.assertEqual(original.read_bytes(), before)

    def test_pdf_field_extract_fill_and_invalid_value_preserve_input(self):
        self.require("pypdf", "reportlab")
        from reportlab.pdfgen.canvas import Canvas
        from pypdf import PdfReader
        original = self.root / "form.pdf"
        canvas = Canvas(str(original))
        canvas.acroForm.textfield(name="customer", x=50, y=700, width=150, height=20)
        canvas.showPage()
        canvas.save()
        before = original.read_bytes()
        self.helper("pdf/check_fillable_fields.py", original)
        fields = self.root / "fields.json"
        self.helper("pdf/extract_form_field_info.py", original, fields)
        data = json.loads(fields.read_text())
        self.assertEqual(data[0]["field_id"], "customer")
        data[0]["value"] = "Fixture 42"
        fields.write_text(json.dumps(data))
        output = self.root / "filled.pdf"
        self.helper("pdf/fill_fillable_fields.py", original, fields, output)
        self.assertEqual(PdfReader(output).get_fields()["customer"]["/V"], "Fixture 42")
        data[0]["field_id"] = "not-a-field"
        fields.write_text(json.dumps(data))
        rejected = self.root / "rejected.pdf"
        self.helper("pdf/fill_fillable_fields.py", original, fields, rejected, expected=1)
        self.assertFalse(rejected.exists())
        self.assertEqual(original.read_bytes(), before)

    def test_pack_validation_rejects_invalid_package_without_publishing(self):
        self.require("defusedxml", "lxml")
        unpacked = self.root / "unpacked"
        unpacked.mkdir()
        output = self.root / "output.docx"
        message = self.helper("office/pack.py", unpacked, output, expected=1)
        self.assertIn("Structural validation failed", message)
        self.assertFalse(output.exists())

    def test_unsupported_threaded_reply_fails_before_mutation(self):
        self.require("lxml")
        module = load_helper("docx/comment.py")
        word = self.root / "word"
        word.mkdir()
        _, message = module.add_comment(str(self.root), 0, "fixture", parent_id=0)
        self.assertIn("Threaded replies are not supported", message)
        self.assertEqual(list(word.iterdir()), [])

    def test_recalc_missing_runtime_never_changes_source(self):
        module = load_helper("xlsx/recalc.py")
        source = self.root / "source.xlsx"
        source.write_bytes(b"fixture")
        with patch.object(module.shutil, "which", return_value=None):
            report = module.recalc(source)
        self.assertIn("Missing dependency", report["error"])
        self.assertEqual(source.read_bytes(), b"fixture")
        self.assertEqual(list(self.root.iterdir()), [source])

    def test_recalc_timeout_is_failure_and_uses_private_profile(self):
        self.require("openpyxl")
        module = load_helper("xlsx/recalc.py")
        source = self.root / "source.xlsx"
        source.write_bytes(b"fixture")
        with patch.object(module.shutil, "which", return_value="soffice"), patch.object(module.subprocess, "run", side_effect=subprocess.TimeoutExpired("soffice", 1)) as run:
            report = module.recalc(source, 1)
        self.assertIn("timed out", report["error"])
        command = run.call_args.args[0]
        self.assertTrue(any(arg.startswith("-env:UserInstallation=file:") for arg in command))
        self.assertEqual(list(self.root.iterdir()), [source])

    def test_accept_changes_timeout_is_not_success(self):
        self.require("defusedxml")
        module = load_helper("docx/accept_changes.py")
        source = self.root / "source.docx"
        source.write_bytes(b"fixture")
        output = self.root / "output.docx"
        with patch.object(module.shutil, "which", return_value="soffice"), patch.object(module, "_setup_libreoffice_macro", return_value=True), patch.object(module.subprocess, "run", side_effect=subprocess.TimeoutExpired("soffice", 30)):
            _, message = module.accept_changes(str(source), str(output))
        self.assertIn("Error: LibreOffice timed out", message)
        self.assertFalse(output.exists())
        self.assertEqual(source.read_bytes(), b"fixture")

    def test_accept_changes_preserves_existing_output(self):
        module = load_helper("docx/accept_changes.py")
        source = self.root / "source.docx"
        output = self.root / "existing.docx"
        source.write_bytes(b"source")
        output.write_bytes(b"existing")
        _, message = module.accept_changes(str(source), str(output))
        self.assertIn("Error:", message)
        self.assertEqual(output.read_bytes(), b"existing")

    def test_render_timeout_and_process_failure_preserve_source_and_publish_nothing(self):
        module = load_helper("office/render.py")
        source = self.root / "source.docx"
        source.write_bytes(b"render fixture")
        for outcome in (subprocess.TimeoutExpired("soffice", 1), subprocess.CompletedProcess("soffice", 1)):
            with self.subTest(outcome=type(outcome).__name__):
                destination = self.root / "rendered"
                with patch.object(module.shutil, "which", return_value="soffice"), patch.object(module.subprocess, "run") as run:
                    if isinstance(outcome, Exception):
                        run.side_effect = outcome
                    else:
                        run.return_value = outcome
                    report = module.render(source, destination, timeout=1)
                self.assertIn("error", report)
                self.assertFalse(destination.exists())
                self.assertEqual(source.read_bytes(), b"render fixture")


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]], verbosity=2)
