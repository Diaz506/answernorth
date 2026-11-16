"""Offline worker manifest authentication and interoperability tests."""

import base64
import builtins
import dataclasses
import hashlib
import hmac
import importlib
import json
from pathlib import Path
import shutil
import socket
import subprocess
import unittest
from unittest.mock import patch

import adapter
import worker
import worker_manifest
from test_adapter import AGENT, WORKSPACE, fixture


KEY = bytes([7]) * 32
BINDING = {
    "tenantId": "a0a00011-1234-4abc-8def-000000000011",
    "appId": "a0a00012-1234-4abc-8def-000000000012",
    "ownerId": "a0a00013-1234-4abc-8def-000000000013",
    "runId": "a0a00014-1234-4abc-8def-000000000014",
    "attemptId": "a0a00015-1234-4abc-8def-000000000015",
    "approvalDigest": "ab" * 32,
    "workerWorkspaceId": "a0a00016-1234-4abc-8def-000000000016",
    "workerNotebookId": "a0a00017-1234-4abc-8def-000000000017",
}


def payload():
    return {"schemaVersion": 1, "binding": BINDING.copy(), "preparation": fixture()}


def sign_bytes(raw, key=KEY):
    encoded = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    digest = hmac.new(key, worker_manifest.DOMAIN + raw, hashlib.sha256).hexdigest()
    return json.dumps({"schemaVersion": 1, "payload": encoded, "mac": digest})


def sign(value, key=KEY):
    return sign_bytes(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), key)


class WorkerManifestTests(unittest.TestCase):
    def reject(self, envelope, expected=BINDING, key=KEY):
        with self.assertRaises(worker_manifest.ManifestError) as error:
            worker.verify_worker_manifest(envelope, expected, key)
        self.assertEqual(str(error.exception), "INVALID_WORKER_MANIFEST")
        self.assertIsNone(error.exception.__cause__)
        self.assertTrue(error.exception.__suppress_context__)

    def test_verified_plan_is_immutable_and_sensitive_fields_are_hidden(self):
        with patch.object(importlib, "import_module", side_effect=AssertionError("SDK")), \
             patch.object(socket, "socket", side_effect=AssertionError("network")), \
             patch.object(builtins, "open", side_effect=AssertionError("file")), \
             patch.object(subprocess, "Popen", side_effect=AssertionError("process")):
            verified = worker.verify_worker_manifest(sign(payload()), BINDING, KEY)
        self.assertEqual(verified.binding, BINDING)
        self.assertEqual((verified.plan.workspace_id, verified.plan.agent_id), (WORKSPACE, AGENT))
        self.assertEqual(verified.plan.sdk_rows(), ({"question": "How many? \U0001f4ca",
                                                    "expected_answer": "Four.\nVerified"},))
        self.assertNotIn("How many", repr(verified))
        self.assertNotIn(BINDING["ownerId"], repr(verified))
        with self.assertRaises(dataclasses.FrozenInstanceError):
            verified.plan = None
        with self.assertRaises(TypeError):
            verified.binding["runId"] = "changed"
        with self.assertRaisesRegex(worker.QualificationError, "^EVALUATION_DISABLED$"):
            worker.evaluate_manifest(verified)

    def test_wrong_key_and_tampered_payload_fail_before_preparation_validation(self):
        envelope = json.loads(sign(payload()))
        changed = payload()
        changed["preparation"]["target"]["name"] = "tampered"
        encoded = json.loads(sign(changed))["payload"]
        envelope["payload"] = encoded
        with patch.object(adapter, "plan_sdk_input", side_effect=AssertionError("too early")) as plan:
            self.reject(json.dumps(envelope))
            self.reject(sign(payload()), key=bytes(32))
            plan.assert_not_called()
        envelope = json.loads(sign(payload()))
        envelope["mac"] = "0" * 64
        self.reject(json.dumps(envelope))

    def test_digest_uses_constant_time_comparison_and_domain_separation(self):
        envelope = sign(payload())
        with patch.object(hmac, "compare_digest", wraps=hmac.compare_digest) as compare:
            worker.verify_worker_manifest(envelope, BINDING, KEY)
            compare.assert_called_once()
        outer = json.loads(envelope)
        raw = base64.urlsafe_b64decode(outer["payload"] + "=" * (-len(outer["payload"]) % 4))
        outer["mac"] = hmac.new(KEY, raw, hashlib.sha256).hexdigest()
        self.reject(json.dumps(outer))

    def test_each_binding_mismatch_and_invalid_expected_scope(self):
        for name in BINDING:
            expected = BINDING.copy()
            expected[name] = "cd" * 32 if name == "approvalDigest" else "b0b00001-1234-4abc-8def-000000000001"
            with self.subTest(name=name):
                self.reject(sign(payload()), expected)
        invalid = [None, [], {}, dict(BINDING, extra="x"), {**BINDING, "runId": "bad"},
                   {**BINDING, "runId": BINDING["runId"].upper()},
                   {**BINDING, "approvalDigest": "AB" * 32}, {**BINDING, "tenantId": None}]
        for expected in invalid:
            with self.subTest(expected=repr(expected)):
                self.reject(sign(payload()), expected)

    def test_invalid_key_and_manifest_types_fail_closed(self):
        for key in (None, "x" * 32, bytearray(32), b"", b"x" * 31, b"x" * 33):
            self.reject(sign(payload()), key=key)
        for raw in (None, b"{}", {}, [], "", "{", '"private"', "\ud800", "x" * 1_000_001):
            self.reject(raw)

    def test_exact_schema_version_keys_and_mac_format(self):
        original = json.loads(sign(payload()))
        for name, value in (("schemaVersion", True), ("schemaVersion", 2),
                            ("schemaVersion", 1.0), ("mac", "AB" * 32),
                            ("mac", "z" * 64), ("mac", None), ("payload", None)):
            outer = original.copy()
            outer[name] = value
            self.reject(json.dumps(outer))
        for outer in ({**original, "extra": 1}, {k: v for k, v in original.items() if k != "mac"}):
            self.reject(json.dumps(outer))
        for change in (lambda x: x.update(schemaVersion=True), lambda x: x.update(schemaVersion=2),
                       lambda x: x.update(extra="sensitive"), lambda x: x.pop("binding"),
                       lambda x: x["binding"].update(extra="x"),
                       lambda x: x["binding"].update(approvalDigest="AB" * 32),
                       lambda x: x["binding"].update(tenantId="invalid")):
            value = payload()
            change(value)
            self.reject(sign(value))

    def test_duplicate_keys_nonfinite_invalid_utf8_and_bad_preparation(self):
        raw = sign(payload())
        self.reject(raw.replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1'))
        inner = json.dumps(payload(), ensure_ascii=False)
        self.reject(sign_bytes(inner.replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1', 1).encode()))
        self.reject(sign_bytes(inner.replace('"publicationVerified": false',
                                             '"publicationVerified": false, "publicationVerified": false').encode()))
        self.reject(sign_bytes(inner.replace('"schemaVersion": 1', '"schemaVersion": NaN', 1).encode()))
        self.reject(sign_bytes(b"\xff"))
        self.reject(sign_bytes(b'{"schemaVersion":1,"binding":{},"preparation":"\\ud800"}'))
        self.reject(sign_bytes(inner.replace('"Synthetic agent"', '"\\ud800"').encode()))
        changed = payload()
        changed["preparation"]["suite"]["cases"][0]["expectedAnswer"] = "tampered"
        self.reject(sign(changed))

    def test_bad_base64_and_size_bounds(self):
        valid = json.loads(sign(payload()))
        for encoded in ("=", "a", "AA=", "AB", "AA+", "AA/", "AA\n", "\u00e9",
                        "A" * ((500_000 * 4 + 2) // 3 + 1)):
            outer = {**valid, "payload": encoded}
            with self.subTest(encoded=encoded[:8]):
                self.reject(json.dumps(outer))
        self.reject(sign_bytes(b"x" * 500_001))
        self.reject(' ' * 1_000_000 + '{}')
        # A multi-byte envelope also exceeds its limit in UTF-8 bytes.
        self.reject(json.dumps({**valid, "extra": "\u00e9" * 500_000}, ensure_ascii=False))

    def test_inclusive_size_limits(self):
        raw = json.dumps(payload(), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        raw += b" " * (500_000 - len(raw))
        envelope = sign_bytes(raw)
        envelope += " " * (1_000_000 - len(envelope.encode("utf-8")))
        self.assertEqual(len(envelope.encode("utf-8")), 1_000_000)
        self.assertEqual(worker.verify_worker_manifest(envelope, BINDING, KEY).plan.agent_id, AGENT)

    @unittest.skipUnless(shutil.which("node"), "Node is needed for issuer interoperability")
    def test_consumes_actual_typescript_issuer(self):
        root = Path(__file__).resolve().parents[1]
        if not (root / "packages" / "functions" / "dist" / "worker-manifest.js").exists():
            self.skipTest("Build the functions package to test the TypeScript issuer")
        program = """
import { Suites } from './packages/functions/dist/suites.js';
import { prepareRun } from './packages/functions/dist/run-preparation.js';
import { RunLedger, submissionClaimId } from './packages/functions/dist/runs.js';
import { createWorkerManifest } from './packages/functions/dist/worker-manifest.js';
const tenantId = 'a0a00011-1234-4abc-8def-000000000011';
const appId = 'a0a00012-1234-4abc-8def-000000000012';
const ownerId = 'a0a00013-1234-4abc-8def-000000000013';
const workspaceId = 'a0a00001-1234-4abc-8def-000000000001';
const agentId = 'a0a00002-1234-4abc-8def-000000000002';
const workerWorkspaceId = 'a0a00016-1234-4abc-8def-000000000016';
const workerNotebookId = 'a0a00017-1234-4abc-8def-000000000017';
const rows = new Map();
const store = {
  async manifests() { return { items: [], hasNextPage: false }; },
  async record(owner, id) { const row = rows.get(id); return row?.owner_id === owner ? row : undefined; },
  async create(row) { if (rows.has(row.id)) throw new Error('duplicate'); rows.set(row.id, row); },
};
const suite = await new Suites(store, ownerId).save(JSON.stringify({
  name: 'Synthetic \\u{1f680} suite',
  cases: [{ question: 'Count \\u{1f4ca}?', expectedAnswer: 'Four.\\nVerified', category: '', critical: true }],
}));
const agent = { id: agentId, name: 'Synthetic agent', workspaceId, workspaceName: 'Synthetic workspace' };
const preparation = prepareRun({ workspaceId, agentId, suiteId: suite.id, stage: 'sandbox' }, agent, suite);
const ledger = new RunLedger(store, ownerId);
const run = await ledger.create('a0a00018-1234-4abc-8def-000000000018', preparation);
await ledger.approve(run.id, run.approvalDigest, preparation);
await ledger.claimSubmission(run.id, run.approvalDigest);
const deployment = { tenantId, appId, ownerId, workspaceId };
const execution = { workspaceId: workerWorkspaceId, notebookId: workerNotebookId };
const envelope = await createWorkerManifest(store, deployment, execution, Buffer.alloc(32, 7), run.id, async () => agent);
const binding = { tenantId, appId, ownerId, runId: run.id, attemptId: submissionClaimId(ownerId, run.id),
  approvalDigest: run.approvalDigest, workerWorkspaceId, workerNotebookId };
process.stdout.write(JSON.stringify({ envelope, binding }));
"""
        result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", program], cwd=root,
                                encoding="utf-8", capture_output=True, check=True, timeout=30)
        data = json.loads(result.stdout)
        verified = worker.verify_worker_manifest(data["envelope"], data["binding"], KEY)
        self.assertEqual(verified.plan.stage, "sandbox")
        self.assertEqual(verified.plan.sdk_rows(), ({"question": "Count \U0001f4ca?",
                                                     "expected_answer": "Four.\nVerified"},))


if __name__ == "__main__":
    unittest.main()
