"""Offline tests for strict result JSON decoding and reconciliation."""

import json
import unittest
from unittest.mock import patch

import adapter
import worker
from result_reconciliation import ReconciliationError
from test_adapter import fixture

EVALUATION_ID = "a0a00005-1234-4abc-8def-000000000005"


class ResultInputTests(unittest.TestCase):
    def setUp(self):
        self.plan = adapter.plan_sdk_input(json.dumps(fixture()))
        case = self.plan.cases[0]
        self.row = {"evaluation_id": EVALUATION_ID, "question": case.question,
                    "expected_answer": case.expected_answer, "actual_answer": "Four.",
                    "is_match": True}

    def test_strict_json_maps_only_complete_synthetic_details(self):
        with patch.object(worker.importlib, "import_module", side_effect=AssertionError("SDK import")):
            result = worker.reconcile_sdk_output(self.plan, EVALUATION_ID, json.dumps([self.row]))
        self.assertEqual((result.counts.passed, result.counts.failed, result.counts.unclear), (1, 0, 0))
        self.assertEqual(result.cases[0].case_id, self.plan.cases[0].case_id)
        self.assertNotIn("Four.", repr(result))

    def test_rejects_duplicate_keys_nonfinite_and_malformed_or_oversized_json(self):
        raw = json.dumps([self.row])
        duplicate = raw.replace('"is_match": true', '"is_match": true, "is_match": false')
        for value in (duplicate, raw.replace('"is_match": true', '"is_match": NaN'),
                      '{', '[] trailing', 'x' * 1_000_001, None):
            with self.subTest(kind=type(value)), self.assertRaisesRegex(ReconciliationError, "^INVALID_RESULT_DETAILS$"):
                worker.reconcile_sdk_output(self.plan, EVALUATION_ID, value)


if __name__ == "__main__":
    unittest.main()
