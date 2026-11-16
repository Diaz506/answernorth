"""Offline checks for notebook context and a trusted manifest reader seam."""

import copy
import unittest
from unittest.mock import Mock, patch

import worker
from test_manifest import BINDING, KEY, payload, sign
from worker_bootstrap import ManifestReadError, WorkerBootstrapError, check_runtime_context, retrieve_verified_manifest


USER = "a0a00019-1234-4abc-8def-000000000019"


def context():
    return {
        "userId": USER,
        "currentWorkspaceId": BINDING["workerWorkspaceId"],
        "currentNotebookId": BINDING["workerNotebookId"],
        "isForPipeline": False,
        "isReferenceRun": False,
    }


class WorkerBootstrapTests(unittest.TestCase):
    def test_context_and_signed_manifest_are_checked_before_returning_a_plan(self):
        read = Mock(return_value=sign(payload()))
        with patch.object(worker.importlib, "import_module", side_effect=AssertionError("SDK")):
            result = retrieve_verified_manifest(context(), BINDING, USER, KEY, read)
        read.assert_called_once_with(BINDING["runId"], BINDING["attemptId"])
        self.assertEqual(result.binding, BINDING)
        self.assertEqual(result.plan.agent_id, payload()["preparation"]["target"]["id"])
        self.assertNotIn(USER, repr(check_runtime_context(context(), BINDING, USER)))
        with self.assertRaisesRegex(worker.QualificationError, "^EVALUATION_DISABLED$"):
            worker.evaluate_manifest(result)

    def test_bad_context_rejected_before_reader_runs(self):
        values = [
            None, {}, {**context(), "userId": USER.upper()},
            {**context(), "userId": BINDING["ownerId"]},
            {**context(), "currentWorkspaceId": BINDING["tenantId"]},
            {**context(), "currentNotebookId": BINDING["appId"]},
            {**context(), "isForPipeline": True},
            {**context(), "isForPipeline": 0},
            {**context(), "isReferenceRun": True},
            {**context(), "isReferenceRun": None},
        ]
        for value in values:
            read = Mock()
            with self.subTest(value=type(value)), self.assertRaisesRegex(WorkerBootstrapError, "^WORKER_CONTEXT_INVALID$"):
                retrieve_verified_manifest(value, BINDING, USER, KEY, read)
            read.assert_not_called()

    def test_bad_expected_values_or_key_rejected_before_reader_runs(self):
        cases = [
            ({}, USER, KEY),
            ({**BINDING, "runId": "invalid"}, USER, KEY),
            (BINDING, "invalid", KEY),
            (BINDING, USER, b"short"),
            (BINDING, USER, bytearray(KEY)),
        ]
        for binding, user, key in cases:
            read = Mock()
            with self.subTest(kind=type(key)), self.assertRaises(WorkerBootstrapError):
                retrieve_verified_manifest(context(), binding, user, key, read)
            read.assert_not_called()

    def test_reader_failure_and_invalid_signature_are_content_free(self):
        read = Mock(side_effect=ManifestReadError("sensitive provider text"))
        with self.assertRaisesRegex(WorkerBootstrapError, "^MANIFEST_UNAVAILABLE$") as caught:
            retrieve_verified_manifest(context(), BINDING, USER, KEY, read)
        self.assertNotIn("sensitive", str(caught.exception))
        invalid = copy.deepcopy(payload())
        invalid["binding"]["runId"] = BINDING["tenantId"]
        read = Mock(return_value=sign(invalid))
        with self.assertRaisesRegex(WorkerBootstrapError, "^MANIFEST_INVALID$"):
            retrieve_verified_manifest(context(), BINDING, USER, KEY, read)

    def test_reader_cannot_change_the_expected_binding_during_retrieval(self):
        expected = BINDING.copy()
        forged = copy.deepcopy(payload())
        forged["binding"]["runId"] = BINDING["tenantId"]

        def mutate_expected(_run_id, _attempt_id):
            expected["runId"] = BINDING["tenantId"]
            return sign(forged)

        with self.assertRaisesRegex(WorkerBootstrapError, "^MANIFEST_INVALID$"):
            retrieve_verified_manifest(context(), expected, USER, KEY, mutate_expected)

    def test_programming_errors_are_not_hidden_as_transport_failures(self):
        read = Mock(side_effect=RuntimeError("programming error"))
        with self.assertRaisesRegex(RuntimeError, "^programming error$"):
            retrieve_verified_manifest(context(), BINDING, USER, KEY, read)


if __name__ == "__main__":
    unittest.main()
