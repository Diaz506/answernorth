"""Mocked OneLake reads; no network, storage or real tokens are used."""

import io
import json
from pathlib import Path
import shutil
import subprocess
import unittest
import urllib.error
from unittest.mock import Mock, patch

from onelake_manifest_reader import OneLakeManifestReader, _NoRedirect
from test_manifest import BINDING, KEY, payload, sign
from test_worker_bootstrap import USER, context
from worker_bootstrap import ManifestReadError, WorkerBootstrapError, retrieve_verified_manifest

LAKEHOUSE = "a0a00020-1234-4abc-8def-000000000020"
FAKE_TOKEN = "synthetic-token"


class Response:
    def __init__(self, body, *, status=200, headers=None, chunk_size=None):
        self.status = status
        self.headers = headers or {}
        self.stream = io.BytesIO(body)
        self.chunk_size = chunk_size

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.stream.close()

    def read(self, size):
        return self.stream.read(min(size, self.chunk_size) if self.chunk_size else size)


class OneLakeReaderTests(unittest.TestCase):
    def test_reads_fixed_location_and_authenticates_the_envelope(self):
        envelope = sign(payload())
        response = Response(envelope.encode(), headers={"Content-Length": str(len(envelope.encode()))}, chunk_size=7)
        opener = Mock()
        opener.open.return_value = response
        token_provider = Mock(return_value=FAKE_TOKEN)
        reader = OneLakeManifestReader(BINDING["workerWorkspaceId"], LAKEHOUSE, token_provider)
        with patch("urllib.request.build_opener", return_value=opener) as build:
            result = retrieve_verified_manifest(context(), BINDING, USER, KEY, reader)
        self.assertEqual(result.binding, BINDING)
        self.assertIsInstance(build.call_args.args[0], _NoRedirect)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url,
            f"https://onelake.blob.fabric.microsoft.com/{BINDING['workerWorkspaceId']}/{LAKEHOUSE}"
            f"/Files/answernorth/manifests/{BINDING['runId']}/{BINDING['attemptId']}.json")
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.get_header("Authorization"), f"Bearer {FAKE_TOKEN}")
        self.assertNotIn(FAKE_TOKEN, request.full_url)
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 15)
        token_provider.assert_called_once_with()

    def test_runtime_mismatch_is_rejected_before_token_or_network(self):
        token_provider = Mock(return_value=FAKE_TOKEN)
        reader = OneLakeManifestReader(BINDING["workerWorkspaceId"], LAKEHOUSE, token_provider)
        with patch("urllib.request.build_opener") as build, \
             self.assertRaisesRegex(WorkerBootstrapError, "^WORKER_CONTEXT_INVALID$"):
            retrieve_verified_manifest({**context(), "userId": BINDING["ownerId"]}, BINDING, USER, KEY, reader)
        token_provider.assert_not_called()
        build.assert_not_called()

    def test_redirects_are_not_followed(self):
        self.assertIsNone(_NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.invalid"))
        opener = Mock()
        opener.open.side_effect = urllib.error.HTTPError("https://example.invalid", 302, "redirect", {}, None)
        reader = OneLakeManifestReader(BINDING["workerWorkspaceId"], LAKEHOUSE, lambda: FAKE_TOKEN)
        with patch("urllib.request.build_opener", return_value=opener), \
             self.assertRaisesRegex(ManifestReadError, "^MANIFEST_UNAVAILABLE$"):
            reader(BINDING["runId"], BINDING["attemptId"])
        opener.open.assert_called_once()

    def test_bad_ids_and_token_fail_before_network(self):
        for workspace, lakehouse in (("bad", LAKEHOUSE), (BINDING["workerWorkspaceId"], "bad")):
            with self.assertRaises(ManifestReadError):
                OneLakeManifestReader(workspace, lakehouse, lambda: FAKE_TOKEN)
        for token in (None, "", "token\ninjected", "x" * 32769):
            reader = OneLakeManifestReader(BINDING["workerWorkspaceId"], LAKEHOUSE, lambda: token)
            with patch("urllib.request.build_opener") as build, self.assertRaises(ManifestReadError):
                reader(BINDING["runId"], BINDING["attemptId"])
            build.assert_not_called()
        reader = OneLakeManifestReader(BINDING["workerWorkspaceId"], LAKEHOUSE, lambda: FAKE_TOKEN)
        with patch("urllib.request.build_opener") as build, self.assertRaises(ManifestReadError):
            reader("../escape", BINDING["attemptId"])
        build.assert_not_called()

    def test_size_encoding_and_incomplete_body_fail_closed(self):
        cases = [
            Response(b"a" * 1_000_001),
            Response(b"a", headers={"Content-Length": "1000001"}),
            Response(b"a", headers={"Content-Length": "1, 1"}),
            Response(b"a", headers={"Content-Length": "2"}),
            Response(b"a", headers={"Content-Encoding": "gzip"}),
            Response(b"a", headers={"x-ms-rejected-headers": "authorization"}),
            Response(b"\xff"),
            Response(b"", status=403),
        ]
        reader = OneLakeManifestReader(BINDING["workerWorkspaceId"], LAKEHOUSE, lambda: FAKE_TOKEN)
        for response in cases:
            opener = Mock()
            opener.open.return_value = response
            with self.subTest(status=response.status), patch("urllib.request.build_opener", return_value=opener), \
                 self.assertRaises(ManifestReadError):
                reader(BINDING["runId"], BINDING["attemptId"])

    def test_slow_stream_fails_without_exposing_provider_details(self):
        response = Response(b"data")
        opener = Mock()
        opener.open.return_value = response
        reader = OneLakeManifestReader(BINDING["workerWorkspaceId"], LAKEHOUSE, lambda: FAKE_TOKEN)
        with patch("urllib.request.build_opener", return_value=opener), \
             patch("onelake_manifest_reader.time.monotonic", side_effect=[0, 0, 31]), \
             self.assertRaisesRegex(ManifestReadError, "^MANIFEST_UNAVAILABLE$"):
            reader(BINDING["runId"], BINDING["attemptId"])

    @unittest.skipUnless(shutil.which("node"), "Node is needed for publisher interoperability")
    def test_consumes_actual_typescript_publisher_output(self):
        root = Path(__file__).resolve().parents[1]
        if not (root / "packages" / "functions" / "dist" / "onelake-manifest-publisher.js").exists():
            self.skipTest("Build the functions package for publisher interoperability")
        program = """
import { Suites } from './packages/functions/dist/suites.js';
import { prepareRun } from './packages/functions/dist/run-preparation.js';
import { RunLedger, submissionClaimId } from './packages/functions/dist/runs.js';
import { publishWorkerManifest } from './packages/functions/dist/onelake-manifest-publisher.js';
const tenantId = 'a0a00011-1234-4abc-8def-000000000011';
const appId = 'a0a00012-1234-4abc-8def-000000000012';
const ownerId = 'a0a00013-1234-4abc-8def-000000000013';
const workspaceId = 'a0a00001-1234-4abc-8def-000000000001';
const agentId = 'a0a00002-1234-4abc-8def-000000000002';
const workerWorkspaceId = 'a0a00016-1234-4abc-8def-000000000016';
const workerNotebookId = 'a0a00017-1234-4abc-8def-000000000017';
const lakehouseId = 'a0a00020-1234-4abc-8def-000000000020';
const rows = new Map();
const store = {
  async manifests() { return { items: [], hasNextPage: false }; },
  async record(owner, id) { const row = rows.get(id); return row?.owner_id === owner ? row : undefined; },
  async create(row) { if (rows.has(row.id)) throw new Error('duplicate'); rows.set(row.id, row); },
};
const suite = await new Suites(store, ownerId).save(JSON.stringify({
  name: 'Synthetic suite',
  cases: [{ question: 'Count \\u{1f4ca}?', expectedAnswer: 'Four.', category: '', critical: true }],
}));
const agent = { id: agentId, name: 'Synthetic agent', workspaceId, workspaceName: 'Synthetic workspace' };
const preparation = prepareRun({ workspaceId, agentId, suiteId: suite.id, stage: 'sandbox' }, agent, suite);
const ledger = new RunLedger(store, ownerId);
const run = await ledger.create('a0a00018-1234-4abc-8def-000000000018', preparation);
await ledger.approve(run.id, run.approvalDigest, preparation);
await ledger.claimSubmission(run.id, run.approvalDigest);
const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+3600,
  tid: tenantId, oid: ownerId, aud: 'https://storage.azure.com' })).toString('base64url')}.signature`;
let saved, url;
const request = async (target, options) => {
  url = target;
  if (options.method === 'PUT') {
    saved = Buffer.from(options.body);
    return new Response(null, { status: 201, headers: { etag: '"0x1234"' } });
  }
  return new Response(saved, { status: 200, headers: { etag: '"0x1234"' } });
};
await publishWorkerManifest(store, { tenantId, appId, ownerId, workspaceId },
  { workspaceId: workerWorkspaceId, notebookId: workerNotebookId },
  { workspaceId: workerWorkspaceId, lakehouseId }, Buffer.alloc(32, 7), token,
  run.id, async () => agent, request);
const binding = { tenantId, appId, ownerId, runId: run.id, attemptId: submissionClaimId(ownerId, run.id),
  approvalDigest: run.approvalDigest, workerWorkspaceId, workerNotebookId };
process.stdout.write(JSON.stringify({ envelope: saved.toString('utf8'), binding, url }));
"""
        result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", program], cwd=root,
                                encoding="utf-8", capture_output=True, check=True, timeout=30)
        data = json.loads(result.stdout)
        binding = data["binding"]
        response = Response(data["envelope"].encode("utf-8"))
        opener = Mock()
        opener.open.return_value = response
        reader = OneLakeManifestReader(binding["workerWorkspaceId"], LAKEHOUSE, lambda: FAKE_TOKEN)
        runtime = {**context(), "currentWorkspaceId": binding["workerWorkspaceId"],
                   "currentNotebookId": binding["workerNotebookId"]}
        with patch("urllib.request.build_opener", return_value=opener):
            verified = retrieve_verified_manifest(runtime, binding, USER, KEY, reader)
        self.assertEqual(opener.open.call_args.args[0].full_url, data["url"])
        self.assertEqual(verified.plan.sdk_rows(), ({"question": "Count \U0001f4ca?",
                                                     "expected_answer": "Four."},))


if __name__ == "__main__":
    unittest.main()
