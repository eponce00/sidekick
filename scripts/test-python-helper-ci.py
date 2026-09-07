"""Stdlib-only contract tests for the isolated Python helper CI lane."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("helper_ci", ROOT / "scripts/run-python-helper-ci.py")
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class PythonHelperCIContract(unittest.TestCase):
    def test_missing_dependency_fails_before_importing_tests(self):
        with patch.object(ci.importlib.util, "find_spec", return_value=None), \
                patch.object(ci, "load_module") as load, patch.object(ci.sys, "stderr"):
            self.assertEqual(ci.main([]), 1)
        load.assert_not_called()

    def test_workflow_is_explicit_cross_platform_and_independent(self):
        workflow = (ROOT / ".github/workflows/python-helpers.yml").read_text(encoding="utf-8")
        for required in ("contents: read", "actions/checkout@v7", "actions/setup-python@v7",
                         "python-version: '3.13'", "timeout-minutes: 10",
                         "os: [windows-latest, macos-14, ubuntu-22.04]",
                         "python -B scripts/test-python-helper-ci.py",
                         "python -B scripts/run-python-helper-ci.py",
                         "--only-binary=:all: --no-deps -r scripts/requirements-python-helpers-ci.txt"):
            self.assertIn(required, workflow)
        for forbidden in ("secrets.", "npm ci", "soffice", "workflow_call", "pull_request_target",
                          "SIDEKICK_AGENT_EVAL", "qualify-office-workflows.py"):
            self.assertNotIn(forbidden, workflow)

    def test_dependency_manifest_is_minimal_and_ci_only(self):
        lines = (ROOT / "scripts/requirements-python-helpers-ci.txt").read_text(encoding="utf-8").splitlines()
        pins = {line.strip() for line in lines if line.strip() and not line.lstrip().startswith("#")}
        self.assertEqual(pins, {"lxml==6.1.3", "defusedxml==0.7.1"})

    def test_only_explicit_bundled_cases_are_selected(self):
        names = set(ci.BUNDLED_CASES) | set(ci.EXCLUDED_BUNDLED_CASES)
        case = type("Fixture", (unittest.TestCase,), {name: lambda self: None for name in names})
        suite = ci.selected_bundled_suite(SimpleNamespace(BundledHelperQualification=case))
        self.assertEqual(suite.countTestCases(), 9)
        self.assertEqual({test._testMethodName for test in suite}, set(ci.BUNDLED_CASES))

    def test_scope_drift_requires_review_instead_of_silent_omission(self):
        for names in (set(), set(ci.BUNDLED_CASES) | set(ci.EXCLUDED_BUNDLED_CASES) | {"test_new"}):
            case = type("Fixture", (unittest.TestCase,), {name: lambda self: None for name in names})
            with self.assertRaisesRegex(RuntimeError, "scope changed"):
                ci.selected_bundled_suite(SimpleNamespace(BundledHelperQualification=case))

    def test_only_the_real_windows_only_case_may_skip_on_posix(self):
        junction = SimpleNamespace(id=lambda: ci.JUNCTION_CASE)
        dependency_skip = SimpleNamespace(id=lambda: "bundled_helpers_ci.missing_dependency")
        result = SimpleNamespace(skipped=[(junction, "Windows junction regression")])
        self.assertEqual(ci.unexpected_skips(result, "linux"), [])
        self.assertEqual(ci.unexpected_skips(result, "darwin"), [])
        self.assertEqual(len(ci.unexpected_skips(result, "win32")), 1)
        result.skipped.append((dependency_skip, "Missing dependency"))
        self.assertEqual(len(ci.unexpected_skips(result, "linux")), 1)
        result.skipped = [(junction, "Missing dependency")]
        self.assertEqual(len(ci.unexpected_skips(result, "linux")), 1)

    def test_pack_junction_has_the_same_exact_platform_skip_policy(self):
        junction = SimpleNamespace(id=lambda: ci.PACK_JUNCTION_CASE)
        result = SimpleNamespace(skipped=[(junction, "Windows junction regression")])
        self.assertEqual(ci.unexpected_skips(result, "linux"), [])
        self.assertEqual(ci.unexpected_skips(result, "darwin"), [])
        self.assertEqual(len(ci.unexpected_skips(result, "win32")), 1)
        result.skipped = [(junction, "Missing dependency")]
        self.assertEqual(len(ci.unexpected_skips(result, "linux")), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
