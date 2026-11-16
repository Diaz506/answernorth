"""Synthetic, standard-library-only tests of offline detail reconciliation."""

import copy
from dataclasses import FrozenInstanceError, replace
import importlib
import socket
import subprocess
import unittest
from unittest.mock import patch

import adapter
import result_reconciliation as rr


EVALUATION_ID = "a0000001-1234-4abc-8def-000000000001"
OTHER_ID = "a0000002-1234-4abc-8def-000000000002"


def case_id(index):
    return f"b0000000-1234-4abc-8def-{index:012x}"


def fixture(count=3):
    cases = tuple(adapter.CaseInput(case_id(i), f"Synthetic question {i}?",
                                    f"Synthetic expected {i}") for i in range(count))
    plan = adapter.SDKInputPlan(OTHER_ID, OTHER_ID, OTHER_ID, "a" * 64, "sandbox",
                                "Synthetic workspace", "Synthetic agent", cases)
    rows = [{"evaluation_id": EVALUATION_ID, "question": case.question,
             "expected_answer": case.expected_answer, "actual_answer": f"Synthetic actual {i}",
             "is_match": (True, False, None)[i % 3]}
            for i, case in enumerate(cases)]
    return plan, rows


class ReconciliationTests(unittest.TestCase):
    def assert_rejected(self, plan, rows, evaluation_id=EVALUATION_ID):
        with self.assertRaises(rr.ReconciliationError) as caught:
            rr.reconcile_results(plan, evaluation_id, rows)
        self.assertEqual(str(caught.exception), "INVALID_RESULT_DETAILS")
        self.assertIsNone(caught.exception.__cause__)
        self.assertTrue(caught.exception.__suppress_context__)

    def test_shuffled_rows_preserve_all_case_ids_and_evidence(self):
        plan, rows = fixture()
        original = copy.deepcopy(rows)
        result = rr.reconcile_results(plan, EVALUATION_ID, list(reversed(rows)))
        self.assertEqual([x.case_id for x in result.cases], [x.case_id for x in plan.cases])
        self.assertEqual([x.question for x in result.cases], [x.question for x in plan.cases])
        self.assertEqual([x.expected_answer for x in result.cases],
                         [x.expected_answer for x in plan.cases])
        self.assertEqual([x.actual_answer for x in result.cases], [x["actual_answer"] for x in rows])
        self.assertEqual([x.outcome for x in result.cases], ["passed", "failed", "unclear"])
        self.assertEqual(result.counts, rr.ResultCounts(1, 1, 1))
        self.assertEqual(rows, original)
        self.assertEqual(result.evaluation_id, EVALUATION_ID)

    def test_minimum_and_maximum_rows_and_counts(self):
        for size in (1, 30):
            plan, rows = fixture(size)
            result = rr.reconcile_results(plan, EVALUATION_ID, rows)
            self.assertEqual(len(result.cases), size)
            self.assertEqual(sum((result.counts.passed, result.counts.failed, result.counts.unclear)), size)
            self.assertEqual(result.counts.passed, (size + 2) // 3)
            self.assertEqual(result.counts.failed, (size + 1) // 3)
            self.assertEqual(result.counts.unclear, size // 3)
        for size in (0, 31):
            plan, rows = fixture(size)
            self.assert_rejected(plan, rows)

    def test_missing_extra_duplicate_and_unknown_rows(self):
        plan, rows = fixture()
        variants = [rows[:-1], rows + [copy.deepcopy(rows[0])],
                    [rows[0], rows[0], rows[2]], copy.deepcopy(rows)]
        variants[-1][-1]["question"] = "Unknown synthetic question"
        for value in variants:
            with self.subTest(count=len(value)):
                self.assert_rejected(plan, value)
        self.assert_rejected(plan, tuple(rows))
        self.assert_rejected(plan, None)

    def test_question_and_expected_answer_must_match_exactly(self):
        plan, rows = fixture()
        for key, value in (("question", rows[0]["question"] + " "),
                           ("question", rows[0]["question"].upper()),
                           ("expected_answer", rows[0]["expected_answer"] + " "),
                           ("expected_answer", rows[1]["expected_answer"])):
            altered = copy.deepcopy(rows)
            altered[0][key] = value
            with self.subTest(key=key):
                self.assert_rejected(plan, altered)
        accented = replace(plan.cases[0], question="\u00e9")
        plan = replace(plan, cases=(accented,))
        row = dict(rows[0], question="e\u0301", expected_answer=accented.expected_answer)
        self.assert_rejected(plan, [row])

    def test_uuid_required_canonical_and_matches_on_every_row(self):
        plan, rows = fixture()
        invalid = (None, "", EVALUATION_ID.upper(), "{" + EVALUATION_ID + "}",
                   EVALUATION_ID.replace("-", ""), "not-a-uuid",
                   "00000000-0000-0000-0000-000000000000",
                   "a0000001-1234-9abc-8def-000000000001",
                   "a0000001-1234-4abc-7def-000000000001")
        for value in invalid:
            with self.subTest(kind=type(value)):
                self.assert_rejected(plan, rows, value)
                altered = copy.deepcopy(rows)
                altered[1]["evaluation_id"] = value
                self.assert_rejected(plan, altered)
        for index in range(len(rows)):
            altered = copy.deepcopy(rows)
            altered[index]["evaluation_id"] = OTHER_ID
            self.assert_rejected(plan, altered)
            del altered[index]["evaluation_id"]
            self.assert_rejected(plan, altered)

    def test_closed_shape_rejects_all_extra_and_missing_keys(self):
        plan, rows = fixture()
        for key in ("error", "exception", "status", "provider_evidence", "metadata"):
            for value in (None, "", "synthetic error"):
                altered = copy.deepcopy(rows)
                altered[0][key] = value
                with self.subTest(key=key, value=value):
                    self.assert_rejected(plan, altered)
        for key in rows[0]:
            altered = copy.deepcopy(rows)
            del altered[0][key]
            self.assert_rejected(plan, altered)
        for row in (None, [], "row"):
            self.assert_rejected(plan, [row, *rows[1:]])

    def test_only_exact_booleans_and_none_are_classified(self):
        plan, rows = fixture(1)
        for value, outcome in ((True, "passed"), (False, "failed"), (None, "unclear")):
            result = rr.reconcile_results(plan, EVALUATION_ID, [dict(rows[0], is_match=value)])
            self.assertEqual(result.cases[0].outcome, outcome)
        for value in (1, 0, 1.0, 0.0, "true", "false", "", [], {}):
            self.assert_rejected(plan, [dict(rows[0], is_match=value)])

    def test_actual_answer_validation_and_unicode_boundaries(self):
        plan, rows = fixture(1)
        for value in (None, "", "plain\ntext\t", "\U0001f600" * (rr.MAX_ACTUAL_UNITS // 2),
                      "a" * rr.MAX_ACTUAL_UNITS):
            result = rr.reconcile_results(plan, EVALUATION_ID,
                                          [dict(rows[0], actual_answer=value, is_match=None)])
            self.assertEqual(result.cases[0].actual_answer, value)
        for value in (True, 1, 1.0, [], {}, b"text", "\ud800", "\x00",
                      "a" * (rr.MAX_ACTUAL_UNITS + 1),
                      "\U0001f600" * (rr.MAX_ACTUAL_UNITS // 2) + "a"):
            self.assert_rejected(plan, [dict(rows[0], actual_answer=value)])

    def test_decisive_outcomes_require_non_whitespace_actual_answer(self):
        plan, rows = fixture(1)
        for actual in (None, "", "   ", "\t\n", "\u2003"):
            for match in (True, False):
                with self.subTest(actual=repr(actual), match=match):
                    self.assert_rejected(plan, [dict(rows[0], actual_answer=actual, is_match=match)])
            result = rr.reconcile_results(plan, EVALUATION_ID,
                                          [dict(rows[0], actual_answer=actual, is_match=None)])
            self.assertEqual(result.cases[0].outcome, "unclear")
            self.assertEqual(result.cases[0].actual_answer, actual)
        for match, outcome in ((True, "passed"), (False, "failed")):
            result = rr.reconcile_results(plan, EVALUATION_ID,
                                          [dict(rows[0], actual_answer="  answer  ", is_match=match)])
            self.assertEqual(result.cases[0].outcome, outcome)

    def test_question_and_expected_utf16_limits(self):
        plan, rows = fixture(1)
        for key, limit in (("question", rr.MAX_QUESTION_UNITS),
                           ("expected_answer", rr.MAX_EXPECTED_UNITS)):
            case = replace(plan.cases[0], **{key: "\U0001f600" * (limit // 2)})
            valid_plan = replace(plan, cases=(case,))
            valid_row = dict(rows[0], **{key: getattr(case, key)})
            rr.reconcile_results(valid_plan, EVALUATION_ID, [valid_row])
            invalid_case = replace(case, **{key: getattr(case, key) + "a"})
            self.assert_rejected(replace(plan, cases=(invalid_case,)), [valid_row])
            self.assert_rejected(valid_plan, [dict(valid_row, **{key: getattr(case, key) + "a"})])
        for value in ("", "\udfff", "\x01", None, 1):
            for key in ("question", "expected_answer"):
                self.assert_rejected(plan, [dict(rows[0], **{key: value})])
                self.assert_rejected(replace(plan, cases=(replace(plan.cases[0], **{key: value}),)), rows)

    def test_aggregate_bound_includes_plan_and_details(self):
        plan, rows = fixture(1)
        baseline = 2 * (len(plan.cases[0].question) + len(plan.cases[0].expected_answer))
        with patch.object(rr, "MAX_TOTAL_UNITS", baseline + 3):
            rr.reconcile_results(plan, EVALUATION_ID, [dict(rows[0], actual_answer="abc")])
            self.assert_rejected(plan, [dict(rows[0], actual_answer="abcd")])
        plan, rows = fixture(30)
        cases = tuple(replace(case, question=str(i).zfill(2) + "q" * 998,
                              expected_answer="e" * 1500) for i, case in enumerate(plan.cases))
        plan = replace(plan, cases=cases)
        rows = [dict(row, question=case.question, expected_answer=case.expected_answer,
                     actual_answer="a" * rr.MAX_ACTUAL_UNITS) for case, row in zip(cases, rows)]
        self.assert_rejected(plan, rows)

    def test_invalid_directly_constructed_plans_are_rejected(self):
        plan, rows = fixture()
        bad_plans = (None, {}, replace(plan, cases=list(plan.cases)),
                     replace(plan, cases=(None, *plan.cases[1:])),
                     replace(plan, cases=(replace(plan.cases[0], case_id="bad"), *plan.cases[1:])),
                     replace(plan, cases=(plan.cases[0], plan.cases[0], plan.cases[2])),
                     replace(plan, cases=(plan.cases[0], replace(plan.cases[1], case_id=plan.cases[0].case_id),
                                          plan.cases[2])),
                     replace(plan, cases=(plan.cases[0], replace(plan.cases[1], question=plan.cases[0].question),
                                          plan.cases[2])))
        for bad in bad_plans:
            self.assert_rejected(bad, rows)

    def test_immutable_redacted_results_and_no_partial_result(self):
        plan, rows = fixture()
        result = rr.reconcile_results(plan, EVALUATION_ID, rows)
        for text in (EVALUATION_ID, plan.cases[0].case_id, plan.cases[0].question,
                     plan.cases[0].expected_answer, rows[0]["actual_answer"]):
            self.assertNotIn(text, repr(result))
            self.assertNotIn(text, repr(result.cases[0]))
        for obj, name, value in ((result, "cases", ()), (result.counts, "passed", 5),
                                 (result.cases[0], "case_id", "changed")):
            with self.assertRaises(FrozenInstanceError):
                setattr(obj, name, value)
        altered = copy.deepcopy(rows)
        altered[-1]["actual_answer"] = "sensitive synthetic content"
        altered[-1]["unexpected"] = "sensitive synthetic error"
        with self.assertRaises(rr.ReconciliationError) as caught:
            rr.reconcile_results(plan, EVALUATION_ID, altered)
        self.assertNotIn("sensitive", str(caught.exception))
        self.assertNotIn("sensitive", repr(caught.exception))
        self.assertEqual(caught.exception.args, ("INVALID_RESULT_DETAILS",))

    def test_no_file_network_process_or_dynamic_sdk_calls(self):
        plan, rows = fixture()
        with patch("builtins.open", side_effect=AssertionError("file")), \
             patch.object(socket, "socket", side_effect=AssertionError("network")), \
             patch.object(subprocess, "Popen", side_effect=AssertionError("process")), \
             patch.object(importlib, "import_module", side_effect=AssertionError("import")):
            result = rr.reconcile_results(plan, EVALUATION_ID, rows)
            self.assertEqual(result.counts, rr.ResultCounts(1, 1, 1))
            self.assert_rejected(plan, [*rows, rows[0]])


if __name__ == "__main__":
    unittest.main()
