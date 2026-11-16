"""Candidate public-cloud OneLake manifest reader; not wired to execution."""

import re
import time
import urllib.error
import urllib.request

if __package__:
    from .adapter import PreparationError, _id
    from .worker_bootstrap import ManifestReadError
    from .worker_manifest import MAX_ENVELOPE_BYTES
else:
    from adapter import PreparationError, _id
    from worker_bootstrap import ManifestReadError
    from worker_manifest import MAX_ENVELOPE_BYTES

_TOKEN = re.compile(r"[A-Za-z0-9._~-]{1,32768}\Z")
_ORIGIN = "https://onelake.blob.fabric.microsoft.com"
_TIMEOUT_SECONDS = 15
_READ_BUDGET_SECONDS = 30
_CHUNK_BYTES = 16_384


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _request, _file, _code, _message, _headers, _url):
        return None


class OneLakeManifestReader:
    """Read one bounded object from a fixed public OneLake origin.

    Workspace, lakehouse and token provider must come from trusted deployment
    configuration. The provider must raise ManifestReadError on expected
    failures without exposing a token. The service, not token parsing here, authenticates the
    caller. Effective identity, permissions and endpoint parity remain
    unqualified; do not wire this reader to an enabled worker.
    """

    def __init__(self, workspace_id, lakehouse_id, storage_token):
        try:
            self._workspace_id = _id(workspace_id)
            self._lakehouse_id = _id(lakehouse_id)
        except PreparationError:
            raise ManifestReadError("MANIFEST_CONFIGURATION_INVALID") from None
        if not callable(storage_token):
            raise ManifestReadError("MANIFEST_CONFIGURATION_INVALID")
        self._storage_token = storage_token

    def __call__(self, run_id, attempt_id):
        try:
            run, attempt = _id(run_id), _id(attempt_id)
        except PreparationError:
            raise ManifestReadError("MANIFEST_CONFIGURATION_INVALID") from None
        token = self._storage_token()
        if type(token) is not str or not _TOKEN.fullmatch(token):
            raise ManifestReadError("MANIFEST_TOKEN_UNAVAILABLE")
        url = (f"{_ORIGIN}/{self._workspace_id}/{self._lakehouse_id}"
               f"/Files/answernorth/manifests/{run}/{attempt}.json")
        request = urllib.request.Request(url, method="GET", headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "x-ms-version": "2023-08-03",
        })
        try:
            deadline = time.monotonic() + _READ_BUDGET_SECONDS
            opener = urllib.request.build_opener(_NoRedirect())
            with opener.open(request, timeout=_TIMEOUT_SECONDS) as response:
                if response.status != 200:
                    raise ManifestReadError("MANIFEST_UNAVAILABLE")
                if response.headers.get("x-ms-rejected-headers"):
                    raise ManifestReadError("MANIFEST_INVALID")
                length = response.headers.get("Content-Length")
                if length is not None and (not re.fullmatch(r"[0-9]{1,10}", length)
                                           or int(length) > MAX_ENVELOPE_BYTES):
                    raise ManifestReadError("MANIFEST_INVALID")
                encoding = response.headers.get("Content-Encoding")
                if encoding is not None and encoding.lower() != "identity":
                    raise ManifestReadError("MANIFEST_INVALID")
                chunks, total = [], 0
                while True:
                    if time.monotonic() >= deadline:
                        raise ManifestReadError("MANIFEST_UNAVAILABLE")
                    chunk = response.read(min(_CHUNK_BYTES, MAX_ENVELOPE_BYTES + 1 - total))
                    if time.monotonic() >= deadline:
                        raise ManifestReadError("MANIFEST_UNAVAILABLE")
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_ENVELOPE_BYTES:
                        raise ManifestReadError("MANIFEST_INVALID")
                    chunks.append(chunk)
                if length is not None and total != int(length):
                    raise ManifestReadError("MANIFEST_INVALID")
                return b"".join(chunks).decode("utf-8")
        except ManifestReadError:
            raise
        except (urllib.error.URLError, OSError, UnicodeError):
            raise ManifestReadError("MANIFEST_UNAVAILABLE") from None
