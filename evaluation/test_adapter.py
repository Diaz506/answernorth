"""Offline preparation-to-SDK input contract tests."""

import copy
import json
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch

import adapter
import worker

WORKSPACE = "a0a00001-1234-4abc-8def-000000000001"
AGENT = "a0a00002-1234-4abc-8def-000000000002"
SUITE = "a0a00003-1234-4abc-8def-000000000003"
CASE = "a0a00004-1234-4abc-8def-000000000004"
OTHER = "a0a00005-1234-4abc-8def-000000000005"


def fixture():
    suite = {
        "id": SUITE, "name": "Synthetic suite", "version": 1,
        "createdAt": "2026-01-02T03:04:05.000Z",
        "cases": [{"id": CASE, "question": "How many? \U0001f4ca",
                   "expectedAnswer": "Four.\nVerified", "category": "", "critical": True}],
    }
    suite["hash"] = adapter._suite_digest(suite, suite["cases"])
    return {
        "schemaVersion": 1,
        "target": {"id": AGENT, "name": "Synthetic agent", "workspaceId": WORKSPACE,
                   "workspaceName": "Synthetic workspace", "stage": "production",
                   "publicationVerified": False},
        "suite": suite,
    }


class AdapterTests(unittest.TestCase):
    def test_preparation_maps_only_to_sdk_inputs_without_execution(self):
        source = fixture()
        with patch.object(worker.importlib, "import_module", side_effect=AssertionError("SDK import")):
            plan = worker.prepare_sdk_input(json.dumps(source))
        self.assertEqual((plan.workspace_id, plan.agent_id, plan.suite_id), (WORKSPACE, AGENT, SUITE))
        self.assertEqual((plan.agent_name, plan.workspace_name, plan.stage),
                         ("Synthetic agent", "Synthetic workspace", "production"))
        self.assertEqual((plan.cases[0].case_id, plan.cases[0].question, plan.cases[0].expected_answer),
                         (CASE, "How many? \U0001f4ca", "Four.\nVerified"))
        self.assertEqual(plan.sdk_rows(), ({"question": "How many? \U0001f4ca", "expected_answer": "Four.\nVerified"},))
        self.assertNotIn("How many", repr(plan))
        with self.assertRaisesRegex(worker.QualificationError, "^EVALUATION_DISABLED$"):
            worker.evaluate_manifest(source)

    def test_sandbox_supported_and_ambiguous_or_malformed_inputs_rejected(self):
        source = fixture()
        source["target"]["stage"] = "sandbox"
        self.assertEqual(adapter.plan_sdk_input(json.dumps(source)).stage, "sandbox")
        for mutate in (
            lambda x: x.update(schemaVersion=True),
            lambda x: x["target"].update(stage="draft"),
            lambda x: x["target"].update(publicationVerified=True),
            lambda x: x["target"].update(outputPath="Files/other"),
            lambda x: x["target"].update(id="not-a-uuid"),
            lambda x: x["target"].update(id=AGENT.upper()),
            lambda x: x["suite"].update(version=True),
            lambda x: x["suite"].update(createdAt="2026-02-30T00:00:00.000Z"),
            lambda x: x["suite"].update(cases=[]),
            lambda x: x["suite"].update(cases=x["suite"]["cases"] * 31),
            lambda x: x["suite"]["cases"][0].update(question=""),
            lambda x: x["suite"]["cases"][0].update(question="x" * 1001),
            lambda x: x["suite"]["cases"][0].update(question="\ud800"),
            lambda x: x["suite"]["cases"][0].update(critical=1),
            lambda x: x["suite"]["cases"][0].update(expectedAnswer="altered"),
        ):
            value = copy.deepcopy(source)
            mutate(value)
            with self.subTest(value=repr(mutate)), self.assertRaisesRegex(adapter.PreparationError, "^INVALID_PREPARATION$"):
                adapter.plan_sdk_input(json.dumps(value))

    def test_duplicate_ids_questions_and_json_keys_are_rejected(self):
        for duplicate_id, duplicate_question in ((True, False), (False, True)):
            source = fixture()
            second = copy.deepcopy(source["suite"]["cases"][0])
            if not duplicate_id:
                second["id"] = OTHER
            if not duplicate_question:
                second["question"] = "Another question?"
            source["suite"]["cases"].append(second)
            source["suite"]["hash"] = adapter._suite_digest(source["suite"], source["suite"]["cases"])
            with self.assertRaisesRegex(adapter.PreparationError, "^INVALID_PREPARATION$"):
                adapter.plan_sdk_input(json.dumps(source))
        raw = json.dumps(fixture()).replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1')
        with self.assertRaisesRegex(adapter.PreparationError, "^INVALID_PREPARATION$"):
            adapter.plan_sdk_input(raw)

    def test_invalid_or_oversized_json_does_not_leak_content(self):
        for value in (None, {}, "", "{", "x" * (adapter.MAX_BYTES + 1), '"sensitive text"'):
            with self.subTest(kind=type(value)), self.assertRaises(adapter.PreparationError) as error:
                adapter.plan_sdk_input(value)
            self.assertEqual(str(error.exception), "INVALID_PREPARATION")

    def test_checksum_is_not_a_signature_or_an_authorization(self):
        source = fixture()
        source["suite"]["cases"][0]["expectedAnswer"] = "A changed answer."
        with self.assertRaisesRegex(adapter.PreparationError, "^INVALID_PREPARATION$"):
            adapter.plan_sdk_input(json.dumps(source))
        source["suite"]["hash"] = adapter._suite_digest(source["suite"], source["suite"]["cases"])
        self.assertEqual(adapter.plan_sdk_input(json.dumps(source)).cases[0].expected_answer, "A changed answer.")

    @unittest.skipUnless(shutil.which("node"), "Node is needed for cross-language hash comparison")
    def test_suite_digest_matches_javascript_json_stringify(self):
        source = fixture()
        source["suite"]["name"] = "Emoji \U0001f680 and \u2028"
        payload = ["proofbench-suite-v1", source["suite"]["id"], source["suite"]["name"],
                   source["suite"]["version"], source["suite"]["createdAt"],
                   [[x["id"], x["question"], x["expectedAnswer"], x["category"], x["critical"]]
                    for x in source["suite"]["cases"]]]
        program = ("const c=require('node:crypto');let s='';"
                   "process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);"
                   "process.stdin.on('end',()=>process.stdout.write(c.createHash('sha256')"
                   ".update(JSON.stringify(JSON.parse(s))).digest('hex')));")
        result = subprocess.run([shutil.which("node"), "-e", program], input=json.dumps(payload),
                                encoding="utf-8", capture_output=True, check=True, timeout=30)
        self.assertEqual(adapter._suite_digest(source["suite"], source["suite"]["cases"]), result.stdout)

    @unittest.skipUnless(shutil.which("node"), "Node is needed for the TypeScript contract integration")
    def test_consumes_actual_server_preparation(self):
        root = Path(__file__).resolve().parents[1]
        if not (root / "packages" / "functions" / "dist" / "run-preparation.js").exists():
            self.skipTest("Build the functions package for the cross-language integration")
        program = """
import { Suites } from './packages/functions/dist/suites.js';
import { prepareRun } from './packages/functions/dist/run-preparation.js';
const workspaceId = 'a0a00001-1234-4abc-8def-000000000001';
const agentId = 'a0a00002-1234-4abc-8def-000000000002';
const rows = new Map();
const store = {
  async manifests() { return { items: [], hasNextPage: false }; },
  async record(owner, id) { const row = rows.get(id); return row?.owner_id === owner ? row : undefined; },
  async create(row) { rows.set(row.id, row); },
};
const suite = await new Suites(store, 'synthetic-owner').save(JSON.stringify({
  name: 'Synthetic \\u{1f680} suite',
  cases: [{ question: 'Count \\u{1f4ca}?', expectedAnswer: 'Four.\\nVerified', category: '', critical: true }],
}));
const selection = { workspaceId, agentId, suiteId: suite.id, stage: 'sandbox' };
const target = { id: agentId, name: 'Synthetic agent', workspaceId, workspaceName: 'Synthetic workspace' };
process.stdout.write(JSON.stringify(prepareRun(selection, target, suite)));
"""
        result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", program], cwd=root,
                                encoding="utf-8", capture_output=True, check=True, timeout=30)
        plan = adapter.plan_sdk_input(result.stdout)
        self.assertEqual(plan.stage, "sandbox")
        self.assertEqual(plan.sdk_rows(), ({"question": "Count \U0001f4ca?", "expected_answer": "Four.\nVerified"},))


if __name__ == "__main__":
    unittest.main()
