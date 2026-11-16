"""Offline tests for the generated, unexecuted qualification notebook."""

import contextlib
import importlib
import importlib.metadata
import inspect
import io
import json
from pathlib import Path
import socket
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import build_qualification_notebook as builder
import worker


class NotebookTests(unittest.TestCase):
    def test_notebook_is_unexecuted_deterministic_and_matches_committed_copy(self):
        first = builder.build_notebook()
        self.assertEqual(first, builder.build_notebook())
        self.assertEqual(first["nbformat"], 4)
        self.assertEqual(first["metadata"]["kernel_info"]["name"], "synapse_pyspark")
        self.assertEqual(len(first["cells"]), 2)
        cell = first["cells"][1]
        self.assertEqual(cell["cell_type"], "code")
        self.assertEqual(cell["execution_count"], None)
        self.assertEqual(cell["outputs"], [])
        self.assertTrue(all(line.endswith("\n") for line in cell["source"]))
        compile("".join(cell["source"]), "<qualification-cell>", "exec")
        artifact = Path(builder.__file__).with_name("qualification.ipynb")
        self.assertEqual(json.loads(artifact.read_text(encoding="utf-8")), first)

    def test_notebook_introspects_fakes_without_sdk_invocation_or_network(self):
        def fake_signature(question, *, output_path=None):
            pass
        functions = [Mock(side_effect=AssertionError("SDK call")) for _ in range(3)]
        for func in functions:
            func.__signature__ = inspect.signature(fake_signature)
        fake = SimpleNamespace(**dict(zip(worker.SDK_FUNCTIONS, functions)))
        output = io.StringIO()
        code = "".join(builder.build_notebook()["cells"][1]["source"])
        with patch.object(sys, "version_info", (3, 11, 0)), \
             patch.object(importlib.metadata, "version", return_value=worker.SDK_VERSION), \
             patch.object(importlib, "import_module", return_value=fake), \
             patch.object(socket, "socket", side_effect=AssertionError("network")), \
             contextlib.redirect_stdout(output):
            exec(compile(code, "<qualification-cell>", "exec"), {})
        result = json.loads(output.getvalue())
        self.assertEqual(result["status"], "INTROSPECTION_ONLY")
        self.assertFalse(result["evaluation_ready"])
        for func in functions:
            func.assert_not_called()

    def test_missing_sdk_is_reported_without_raw_error(self):
        code = "".join(builder.build_notebook()["cells"][1]["source"])
        output = io.StringIO()
        with patch.object(sys, "version_info", (3, 11, 0)), \
             patch.object(importlib.metadata, "version", side_effect=importlib.metadata.PackageNotFoundError()), \
             patch.object(importlib, "import_module") as importer, \
             contextlib.redirect_stdout(output):
            exec(compile(code, "<qualification-cell>", "exec"), {})
        self.assertEqual(json.loads(output.getvalue()),
                         {"code": "SDK_NOT_INSTALLED", "evaluation_ready": False, "status": "BLOCKED"})
        importer.assert_not_called()


if __name__ == "__main__":
    unittest.main()
