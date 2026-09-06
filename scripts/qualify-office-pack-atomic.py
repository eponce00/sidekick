"""Synthetic pack publication regressions; no Office engine, installs or user files."""
from pathlib import Path
import sys
import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources/skills/office"))
import pack
from structure import validate_package


class PackPublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sidekick-pack-atomic-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "input"
        parts = {
            "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
            "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
            "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>synthetic 42</w:t></w:r></w:p></w:body></w:document>',
        }
        for name, text in parts.items():
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        self.before = self.snapshot()
        self.output = self.root / "result.docx"

    def snapshot(self):
        return {str(path.relative_to(self.source)): path.read_bytes() for path in self.source.rglob("*") if path.is_file()}

    def assert_untouched(self):
        self.assertEqual(self.snapshot(), self.before)
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob(".sidekick-pack-*")))

    def test_mid_zip_write_failure_never_publishes_final(self):
        original_write = zipfile.ZipFile.write
        count = 0

        def failing_write(archive, *args, **kwargs):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError("injected mid-write failure")
            return original_write(archive, *args, **kwargs)

        with patch.object(zipfile.ZipFile, "write", failing_write):
            try:
                _, message = pack.pack(str(self.source), str(self.output))
                self.assertTrue(message.startswith("Error:"))
            except OSError:
                pass  # The old implementation raised; publication must still be absent.
        self.assertEqual(count, 2)
        self.assert_untouched()

    def test_existing_destination_is_preserved(self):
        self.output.write_bytes(b"existing destination")
        _, message = pack.pack(str(self.source), str(self.output))
        self.assertTrue(message.startswith("Error:"))
        self.assertEqual(self.output.read_bytes(), b"existing destination")
        self.assertEqual(self.snapshot(), self.before)

    def test_destination_created_during_pack_is_not_overwritten(self):
        original_link = pack.os.link

        def raced_link(staged, destination):
            Path(destination).write_bytes(b"racing destination")
            return original_link(staged, destination)

        with patch.object(pack.os, "link", raced_link):
            _, message = pack.pack(str(self.source), str(self.output))
        self.assertTrue(message.startswith("Error:"))
        self.assertEqual(self.output.read_bytes(), b"racing destination")
        self.assertEqual(self.snapshot(), self.before)
        self.assertFalse(list(self.root.glob(".sidekick-pack-*")))

    def test_flush_failure_never_publishes(self):
        with patch.object(pack.os, "fsync", side_effect=OSError("injected flush failure")):
            _, message = pack.pack(str(self.source), str(self.output))
        self.assertTrue(message.startswith("Error:"))
        self.assert_untouched()

    def test_publication_failure_never_copies_partial_destination(self):
        with patch.object(pack.os, "link", side_effect=OSError("hard links unsupported")):
            _, message = pack.pack(str(self.source), str(self.output))
        self.assertTrue(message.startswith("Error:"))
        self.assert_untouched()

    def test_validation_failure_never_publishes(self):
        (self.source / "_rels/.rels").unlink()
        self.before = self.snapshot()
        _, message = pack.pack(str(self.source), str(self.output))
        self.assertIn("Structural validation failed", message)
        self.assert_untouched()

    def test_valid_output_is_reopenable_and_source_unchanged(self):
        _, message = pack.pack(str(self.source), str(self.output))
        self.assertIn("Successfully packed", message)
        self.assertTrue(validate_package(self.output)["valid"])
        with zipfile.ZipFile(self.output) as archive:
            self.assertIsNone(archive.testzip())
            self.assertIn(b"synthetic 42", archive.read("word/document.xml"))
        self.assertEqual(self.snapshot(), self.before)
        self.assertFalse(list(self.root.glob(".sidekick-pack-*")))

    def test_transaction_residue_is_not_packaged_even_without_validation(self):
        residue = self.source / "word/.sidekick-comment-backup-document.xml-test"
        residue.write_bytes(b"retained original bytes")
        self.before = self.snapshot()
        _, message = pack.pack(str(self.source), str(self.output), validate=False)
        self.assertIn("transaction residue", message)
        self.assert_untouched()

    def test_residue_names_rejected_before_reading_with_validation_on_or_off(self):
        for name in (".sidekick-comment-staged", ".SIDEKICK-COMMENT-backup", ".sidekick-pack-stage.tmp"):
            for validate in (True, False):
                with self.subTest(name=name, validate=validate):
                    residue = self.source / "word" / name
                    residue.mkdir()
                    with patch.object(pack, "read_package") as reader:
                        _, message = pack.pack(str(self.source), str(self.output), validate=validate)
                    reader.assert_not_called()
                    self.assertIn("transaction residue", message)
                    self.assertIn("after review", message)
                    self.assertTrue(residue.is_dir())
                    self.assertFalse(self.output.exists())
                    residue.rmdir()  # Test fixture cleanup only; helper never removes residue.
        self.assert_untouched()

    def test_residue_added_to_snapshot_after_scan_still_prevents_publication(self):
        original = pack.read_package

        def read_with_residue(path):
            parts = original(path)
            parts["word/.sidekick-comment-backup-late"] = b"retained bytes"
            return parts

        with patch.object(pack, "read_package", read_with_residue):
            _, message = pack.pack(str(self.source), str(self.output), validate=False)
        self.assertIn("transaction residue", message)
        self.assert_untouched()

    def test_empty_directory_count_is_bounded_before_content_read(self):
        for index in range(8):
            (self.source / f"empty-{index}").mkdir()
        with patch.object(pack, "MAX_PARTS", 6), patch.object(pack, "read_package") as reader:
            _, message = pack.pack(str(self.source), str(self.output))
        reader.assert_not_called()
        self.assertIn("entry/depth limits", message)
        self.assert_untouched()

    def test_deep_directory_tree_is_bounded_before_content_read(self):
        current = self.source
        for _ in range(34):
            current = current / "d"
            current.mkdir()
        with patch.object(pack, "read_package") as reader:
            _, message = pack.pack(str(self.source), str(self.output))
        reader.assert_not_called()
        self.assertIn("limits", message)
        self.assert_untouched()

    @unittest.skipUnless(sys.platform == "win32", "Windows junction regression")
    def test_contained_junction_is_rejected_without_traversing_target(self):
        target = self.root / "contained-target"
        target.mkdir()
        (target / "sentinel").write_bytes(b"must not read")
        junction = self.source / "junction"
        result = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(junction), str(target)], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, "Could not create contained test junction")
        original_scandir = os.scandir

        def guarded_scandir(path):
            self.assertNotEqual(Path(path), junction, "Attempted junction traversal")
            self.assertNotEqual(Path(path), target, "Attempted target traversal")
            return original_scandir(path)

        try:
            with patch.object(pack.os, "scandir", guarded_scandir), patch.object(pack, "read_package") as reader:
                _, message = pack.pack(str(self.source), str(self.output))
            reader.assert_not_called()
            self.assertIn("reparse points", message)
            self.assertFalse(self.output.exists())
            self.assertEqual((target / "sentinel").read_bytes(), b"must not read")
        finally:
            # Remove only the verified fixture junction, not its target tree.
            os.rmdir(junction)


if __name__ == "__main__":
    unittest.main()
