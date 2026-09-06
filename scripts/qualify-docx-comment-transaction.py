"""Synthetic ordinary-I/O failure tests, not multi-file crash-atomicity tests."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources/skills/docx"))
import comment


class CommentTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sidekick-comment-transaction-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.first, self.second = self.root / "first.xml", self.root / "second.xml"
        self.first.write_bytes(b"original first")
        self.second.write_bytes(b"original second")
        self.parts = {self.first: b"updated first", self.second: b"updated second"}

    def assert_originals(self):
        self.assertEqual(self.first.read_bytes(), b"original first")
        self.assertEqual(self.second.read_bytes(), b"original second")
        self.assertFalse(list(self.root.glob(".sidekick-comment-*")))

    def test_staging_write_failure_cleans_temporary(self):
        original = comment.tempfile.NamedTemporaryFile

        class FailingStream:
            def __init__(self, *args, **kwargs):
                self.stream = original(*args, **kwargs)
                self.name = self.stream.name
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return self.stream.__exit__(*args)
            def write(self, _content):
                self.stream.write(b"partial staging")
                raise OSError("injected write failure")

        with patch.object(comment.tempfile, "NamedTemporaryFile", FailingStream):
            with self.assertRaises(Exception):
                comment.commit_parts(self.parts)
        self.assert_originals()

    def test_replacement_failure_restores_originals(self):
        original = comment.os.replace
        count = 0

        def fail_second(*args):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError("injected replacement failure")
            return original(*args)

        with patch.object(comment.os, "replace", fail_second):
            with self.assertRaises(Exception):
                comment.commit_parts(self.parts)
        self.assert_originals()

    def test_backup_staging_failure_occurs_before_any_replacement(self):
        original = comment.tempfile.NamedTemporaryFile

        class FailingBackup:
            def __init__(self, *args, **kwargs):
                self.stream = original(*args, **kwargs)
                self.name = self.stream.name
                self.is_backup = "backup-" in kwargs.get("prefix", "")
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return self.stream.__exit__(*args)
            def write(self, content):
                self.stream.write(content)
                if self.is_backup:
                    raise OSError("injected backup failure")

        with patch.object(comment.tempfile, "NamedTemporaryFile", FailingBackup):
            with self.assertRaises(RuntimeError):
                comment.commit_parts(self.parts)
        self.assert_originals()

    def test_success_preserves_api_and_updates_all_parts(self):
        self.assertIsNone(comment.commit_parts(self.parts))
        self.assertEqual(self.first.read_bytes(), b"updated first")
        self.assertEqual(self.second.read_bytes(), b"updated second")
        self.assertFalse(list(self.root.glob(".sidekick-comment-*")))

    def test_rollback_failure_is_sanitized_preserves_backup_and_continues_other_rollbacks(self):
        third = self.root / "third.xml"
        third.write_bytes(b"original third")
        parts = {**self.parts, third: b"updated third"}
        original = comment.os.replace
        count = 0

        def fail_forward_and_one_rollback(*args):
            nonlocal count
            count += 1
            if count in (3, 4):
                raise OSError("PRIVATE_DOCUMENT_CONTENT PRIVATE_PATH")
            return original(*args)

        with patch.object(comment.os, "replace", fail_forward_and_one_rollback):
            with self.assertRaises(RuntimeError) as error:
                comment.commit_parts(parts)
        self.assertEqual(count, 5)  # Failure restoring second did not prevent restoring first.
        self.assertEqual(self.first.read_bytes(), b"original first")
        self.assertEqual(self.second.read_bytes(), b"updated second")
        self.assertEqual(third.read_bytes(), b"original third")
        self.assertIn("Rollback incomplete for 1 part(s)", str(error.exception))
        self.assertNotIn("PRIVATE_", str(error.exception))
        self.assertNotIn(str(self.root), str(error.exception))
        backups = list(self.root.glob(".sidekick-comment-backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), b"original second")

    def test_new_part_removed_when_later_replacement_fails(self):
        new = self.root / "new.xml"
        original = comment.os.replace
        count = 0

        def fail_second(*args):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError("injected failure")
            return original(*args)

        with patch.object(comment.os, "replace", fail_second):
            with self.assertRaises(RuntimeError):
                comment.commit_parts({new: b"new part", **self.parts})
        self.assertFalse(new.exists())
        self.assert_originals()


if __name__ == "__main__":
    unittest.main()
