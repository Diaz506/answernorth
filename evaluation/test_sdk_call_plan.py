"""Offline tests for isolated, deterministic SDK call planning."""

import json
import socket
import unittest
from dataclasses import replace
from unittest.mock import patch

import adapter
import sdk_call_plan
import worker
from test_adapter import fixture

RUN = "a0a00006-1234-4abc-8def-000000000006"
ATTEMPT = "a0a00007-1234-4abc-8def-000000000007"
OTHER = "a0a00008-1234-4abc-8def-000000000008"


class SDKCallPlanTests(unittest.TestCase):
    def setUp(self):
        self.plan = adapter.plan_sdk_input(json.dumps(fixture()))

    def test_isolated_names_and_exact_sdk_arguments_without_execution(self):
        with patch.object(socket, "socket", side_effect=AssertionError("network")), \
             patch.object(worker.importlib, "import_module", side_effect=AssertionError("SDK import")):
            call = sdk_call_plan.prepare_sdk_call(self.plan, RUN, ATTEMPT)
        self.assertRegex(call.table_name, r"^answernorth_[0-9a-f]{32}_[0-9a-f]{32}$")
        self.assertLessEqual(len(call.table_name + "_steps"), 128)
        self.assertEqual(call.sdk_kwargs(), {"workspace_name": "Synthetic workspace", "table_name": call.table_name,
                                             "data_agent_stage": "production", "max_workers": 1, "num_query_repeats": 1})
        self.assertEqual(call.sdk_rows(), self.plan.sdk_rows())
        self.assertNotIn("Synthetic", repr(call))
        self.assertNotIn("How many", repr(call))
        self.assertNotIn(RUN, repr(call))
        self.assertNotIn(call.table_name, repr(call))
        self.assertNotIn("output_path", call.sdk_kwargs())

    def test_names_are_deterministic_and_differ_per_run_and_attempt(self):
        first = sdk_call_plan.prepare_sdk_call(self.plan, RUN, ATTEMPT)
        self.assertEqual(first, sdk_call_plan.prepare_sdk_call(self.plan, RUN, ATTEMPT))
        self.assertNotEqual(first.table_name, sdk_call_plan.prepare_sdk_call(self.plan, OTHER, ATTEMPT).table_name)
        self.assertNotEqual(first.table_name, sdk_call_plan.prepare_sdk_call(self.plan, RUN, OTHER).table_name)

    def test_malformed_ids_and_inputs_fail_without_raw_content(self):
        for value in (None, "", "../unsafe", RUN.upper(), RUN + "/path"):
            with self.subTest(value=value), self.assertRaisesRegex(sdk_call_plan.SDKCallPlanError, "^INVALID_SDK_CALL_PLAN$"):
                sdk_call_plan.prepare_sdk_call(self.plan, value, ATTEMPT)
        for value in (None, {}, []):
            with self.subTest(value=value), self.assertRaisesRegex(sdk_call_plan.SDKCallPlanError, "^INVALID_SDK_CALL_PLAN$"):
                sdk_call_plan.prepare_sdk_call(value, RUN, ATTEMPT)
        with self.assertRaisesRegex(worker.QualificationError, "^EVALUATION_DISABLED$"):
            worker.evaluate_manifest(self.plan)

    def test_directly_constructed_invalid_plans_fail_closed(self):
        case = self.plan.cases[0]
        for value in (replace(self.plan, agent_name="x" * 257),
                      replace(self.plan, suite_hash="wrong"),
                      replace(self.plan, workspace_id="invalid"),
                      replace(self.plan, cases=(case, case)),
                      replace(self.plan, cases=(replace(case, question="x" * 1001),)),
                      replace(self.plan, cases=(replace(case, expected_answer=" \t"),))):
            with self.subTest(kind=type(value)), self.assertRaisesRegex(sdk_call_plan.SDKCallPlanError, "^INVALID_SDK_CALL_PLAN$"):
                sdk_call_plan.prepare_sdk_call(value, RUN, ATTEMPT)


if __name__ == "__main__":
    unittest.main()
