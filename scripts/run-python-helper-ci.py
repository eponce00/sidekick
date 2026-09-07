"""Run only public, synthetic no-GUI helper safety tests; never install dependencies.

CI provisions its own pinned Python/dependencies. Local execution uses what is already
installed and is not evidence that the CI matrix or pinned versions have executed.
PDF form, real Office workflow/fixture-oracle, and openpyxl timeout tests remain outside
this minimal lane; they require separately provisioned dependencies and qualification.
"""
import argparse
import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True

BUNDLED_CASES = (
    "test_preflight_discovers_missing_without_loading_or_installing",
    "test_preflight_cli_reports_assets",
    "test_office_unpack_pack_preserves_fixture_content",
    "test_pack_validation_rejects_invalid_package_without_publishing",
    "test_unsupported_threaded_reply_fails_before_mutation",
    "test_recalc_missing_runtime_never_changes_source",
    "test_accept_changes_timeout_is_not_success",
    "test_accept_changes_preserves_existing_output",
    "test_render_timeout_and_process_failure_preserve_source_and_publish_nothing",
)
EXCLUDED_BUNDLED_CASES = {
    "test_pdf_field_extract_fill_and_invalid_value_preserve_input": "requires pypdf and reportlab",
    "test_recalc_timeout_is_failure_and_uses_private_profile": "requires openpyxl",
}
JUNCTION_CASE = "package_safety_ci.PackageSafetyTests.test_rejects_junction_before_reading_outside_package_root"
PACK_JUNCTION_CASE = "pack_atomic_ci.PackPublicationTests.test_contained_junction_is_rejected_without_traversing_target"


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    previous_argv = sys.argv
    try:
        # Existing qualification modules parse their own CLI at import time.
        sys.argv = [str(path)]
        spec.loader.exec_module(module)
    finally:
        sys.argv = previous_argv
    return module


def selected_bundled_suite(module):
    case = module.BundledHelperQualification
    discovered = set(unittest.defaultTestLoader.getTestCaseNames(case))
    expected = set(BUNDLED_CASES) | set(EXCLUDED_BUNDLED_CASES)
    if discovered != expected:
        raise RuntimeError("Bundled helper test scope changed; review the explicit CI selection")
    return unittest.TestSuite(case(name) for name in BUNDLED_CASES)


def unexpected_skips(result, platform):
    return [
        (case, reason) for case, reason in result.skipped
        if not (platform != "win32" and case.id() in {JUNCTION_CASE, PACK_JUNCTION_CASE}
                and reason == "Windows junction regression")
    ]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parent.parent,
                        help="Read helper/tests from this checkout; all fixtures remain disposable")
    args = parser.parse_args(argv)
    root = args.source_root.resolve()
    missing = [name for name in ("lxml", "defusedxml") if importlib.util.find_spec(name) is None]
    if missing:
        print("Missing CI helper dependencies: " + ", ".join(missing), file=sys.stderr)
        return 1
    bundled = load_module(root / "scripts/qualify-bundled-skills.py", "bundled_helpers_ci")
    safety = load_module(root / "scripts/test-office-package-safety.py", "package_safety_ci")
    package_suite = unittest.defaultTestLoader.loadTestsFromModule(safety)
    if package_suite.countTestCases() < 11:
        raise RuntimeError("Package safety regression suite is incomplete")
    pack_atomic = load_module(root / "scripts/qualify-office-pack-atomic.py", "pack_atomic_ci")
    comment_transaction = load_module(root / "scripts/qualify-docx-comment-transaction.py", "comment_transaction_ci")
    pack_suite = unittest.defaultTestLoader.loadTestsFromModule(pack_atomic)
    comment_suite = unittest.defaultTestLoader.loadTestsFromModule(comment_transaction)
    if pack_suite.countTestCases() < 13 or comment_suite.countTestCases() < 6:
        raise RuntimeError("Office publication regression suites are incomplete")
    suite = unittest.TestSuite([selected_bundled_suite(bundled), package_suite,
                               pack_suite, comment_suite])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    skipped = unexpected_skips(result, sys.platform)
    if skipped:
        print("Unexpected helper skips: " + ", ".join(case.id() for case, _ in skipped), file=sys.stderr)
    return 0 if result.wasSuccessful() and not skipped else 1


if __name__ == "__main__":
    sys.exit(main())
