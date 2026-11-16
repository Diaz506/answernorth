"""Offline-only qualification and fail-closed contract tests."""

import builtins
import importlib
import importlib.metadata
import io
import socket
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import Mock, patch

import worker


class QualificationTests(unittest.TestCase):
    def setUp(self):
        self.agent = Mock(side_effect=AssertionError("SDK function must not run"))
        self.summary = Mock(side_effect=AssertionError("SDK function must not run"))
        self.details = Mock(side_effect=AssertionError("SDK function must not run"))
        # Provide explicit signatures without calling the fake functions.
        def signature_example(question, *, output_path=None):
            pass
        self.agent.__signature__ = __import__("inspect").signature(signature_example)
        self.summary.__signature__ = self.agent.__signature__
        self.details.__signature__ = self.agent.__signature__
        self.module = SimpleNamespace(evaluate_data_agent=self.agent,
                                      get_evaluation_summary=self.summary,
                                      get_evaluation_details=self.details)

    def qualify_with(self, py=(3, 11, 0), version=worker.SDK_VERSION, module=None):
        with patch.object(worker.sys, "version_info", py), \
             patch.object(worker.importlib.metadata, "version", return_value=version) as metadata, \
             patch.object(worker.importlib, "import_module", return_value=module or self.module) as importer, \
             patch.object(socket, "socket", side_effect=AssertionError("network")), \
             patch.object(builtins, "open", side_effect=AssertionError("file write or read")):
            result = worker.qualify()
        return result, metadata, importer

    def test_pinned_distribution_and_signatures_without_sdk_calls(self):
        result, metadata, importer = self.qualify_with()
        metadata.assert_called_once_with("fabric-data-agent-sdk")
        importer.assert_called_once_with("fabric.dataagent.evaluation")
        self.assertEqual(result["status"], "INTROSPECTION_ONLY")
        self.assertFalse(result["evaluation_ready"])
        self.assertEqual(result["functions"]["evaluate_data_agent"], [
            {"name": "question", "kind": "POSITIONAL_OR_KEYWORD", "required": True},
            {"name": "output_path", "kind": "KEYWORD_ONLY", "required": False},
        ])
        for func in (self.agent, self.summary, self.details):
            func.assert_not_called()

    def test_supported_python_boundaries(self):
        for py in ((3, 10, 0), (3, 13, 99)):
            with self.subTest(py=py):
                self.assertFalse(self.qualify_with(py=py)[0]["evaluation_ready"])

    def test_unsupported_python_never_checks_or_imports_sdk(self):
        for py in ((3, 9, 99), (3, 14, 0), (4, 0, 0)):
            with self.subTest(py=py), patch.object(worker.sys, "version_info", py), \
                 patch.object(worker.importlib.metadata, "version") as metadata, \
                 patch.object(worker.importlib, "import_module") as importer:
                with self.assertRaisesRegex(worker.QualificationError, "^UNSUPPORTED_PYTHON$"):
                    worker.qualify()
                metadata.assert_not_called()
                importer.assert_not_called()

    def test_missing_and_wrong_version_never_import(self):
        for outcome, code in ((importlib.metadata.PackageNotFoundError(), "SDK_NOT_INSTALLED"),
                              ("0.1.36", "SDK_VERSION_MISMATCH"),
                              (RuntimeError("fictional sensitive message"), "SDK_VERSION_UNAVAILABLE")):
            with self.subTest(code=code), patch.object(worker.sys, "version_info", (3, 11, 0)), \
                 patch.object(worker.importlib.metadata, "version", side_effect=(outcome if isinstance(outcome, Exception) else None), return_value=outcome), \
                 patch.object(worker.importlib, "import_module") as importer:
                with self.assertRaisesRegex(worker.QualificationError, "^" + code + "$"):
                    worker.qualify()
                importer.assert_not_called()

    def test_bad_or_missing_functions_fail_without_exposing_exception(self):
        for module in (SimpleNamespace(), SimpleNamespace(evaluate_data_agent=None)):
            with self.subTest(module=module), patch.object(worker.sys, "version_info", (3, 11, 0)), \
                 patch.object(worker.importlib.metadata, "version", return_value=worker.SDK_VERSION), \
                 patch.object(worker.importlib, "import_module", return_value=module):
                with self.assertRaisesRegex(worker.QualificationError, "^SDK_INTROSPECTION_FAILED$"):
                    worker.qualify()
        with patch.object(worker.sys, "version_info", (3, 11, 0)), \
             patch.object(worker.importlib.metadata, "version", return_value=worker.SDK_VERSION), \
             patch.object(worker.importlib, "import_module", side_effect=RuntimeError("fictional secret")):
            with self.assertRaisesRegex(worker.QualificationError, "^SDK_INTROSPECTION_FAILED$") as error:
                worker.qualify()
            self.assertNotIn("fictional secret", str(error.exception))

    def test_import_has_no_qualification_or_execution(self):
        with patch.object(importlib.metadata, "version") as metadata, \
             patch.object(importlib, "import_module") as importer, \
             patch.object(socket, "socket", side_effect=AssertionError("network")):
            importlib.reload(worker)
        metadata.assert_not_called()
        importer.assert_not_called()


class DisabledOperationsTests(unittest.TestCase):
    def test_all_inputs_fail_closed_without_side_effects_or_leaks(self):
        fixture = {"fictional_content": "do not reveal this fictional text", "enabled": True}
        for operation, code in ((worker.evaluate_manifest, "EVALUATION_DISABLED"),
                                (worker.suggest_tests, "SUGGESTIONS_DISABLED")):
            for value in (None, fixture, True, "fictional text"):
                with self.subTest(operation=operation.__name__, value=type(value)), \
                     patch.object(worker.importlib, "import_module") as importer, \
                     patch.object(socket, "socket", side_effect=AssertionError("network")), \
                     patch.object(builtins, "open", side_effect=AssertionError("file access")), \
                     redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()) as err:
                    with self.assertRaisesRegex(worker.QualificationError, "^" + code + "$"):
                        operation(value)
                    importer.assert_not_called()
                    self.assertEqual(out.getvalue(), "")
                    self.assertEqual(err.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
