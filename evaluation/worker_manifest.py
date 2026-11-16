"""Offline authentication and validation of a worker manifest."""

import base64
import hashlib
import hmac
import json
import re
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Mapping

if __package__:
    from . import adapter
    from .safe_json import loads
else:
    import adapter
    from safe_json import loads

MAX_ENVELOPE_BYTES = 1_000_000
MAX_PAYLOAD_BYTES = 500_000
DOMAIN = b"answernorth-worker-manifest-v1\x00"
_BASE64URL = re.compile(r"[A-Za-z0-9_-]*\Z")
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_BINDING_KEYS = (
    "tenantId", "appId", "ownerId", "runId", "attemptId", "approvalDigest",
    "workerWorkspaceId", "workerNotebookId",
)


class ManifestError(ValueError):
    """Content-free manifest rejection."""


@dataclass(frozen=True)
class VerifiedWorkerManifest:
    binding: Mapping[str, str] = field(repr=False)
    plan: adapter.SDKInputPlan = field(repr=False)


def validate_worker_binding(value):
    """Validate an independently obtained binding; this does not authenticate it."""
    if type(value) is not dict or set(value) != set(_BINDING_KEYS):
        raise ValueError
    for name in _BINDING_KEYS:
        item = value[name]
        if type(item) is not str:
            raise ValueError
        if name == "approvalDigest":
            if not _HASH.fullmatch(item):
                raise ValueError
        else:
            adapter._id(item)
    return value


def verify_worker_manifest(envelope, expected_binding, key):
    """Authenticate offline using independently obtained binding and key.

    The caller must obtain both from trusted execution configuration and an
    authenticated run context, not from the manifest being verified.
    """
    try:
        if type(envelope) is not str or type(key) is not bytes or len(key) != 32:
            raise ValueError
        expected = validate_worker_binding(expected_binding).copy()
        outer = loads(envelope, MAX_ENVELOPE_BYTES)
        if type(outer) is not dict or set(outer) != {"schemaVersion", "payload", "mac"}:
            raise ValueError
        if type(outer["schemaVersion"]) is not int or outer["schemaVersion"] != 1:
            raise ValueError
        encoded, mac = outer["payload"], outer["mac"]
        if type(encoded) is not str or len(encoded) > (MAX_PAYLOAD_BYTES * 4 + 2) // 3 \
                or not _BASE64URL.fullmatch(encoded) or len(encoded) % 4 == 1 \
                or type(mac) is not str or not _HASH.fullmatch(mac):
            raise ValueError
        payload_bytes = base64.b64decode(encoded + "=" * (-len(encoded) % 4),
                                         altchars=b"-_", validate=True)
        if len(payload_bytes) > MAX_PAYLOAD_BYTES or \
                base64.urlsafe_b64encode(payload_bytes).rstrip(b"=").decode("ascii") != encoded:
            raise ValueError
        digest = hmac.new(key, DOMAIN + payload_bytes, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(digest, mac):
            raise ValueError
        inner = loads(payload_bytes.decode("utf-8"), MAX_PAYLOAD_BYTES)
        if type(inner) is not dict or set(inner) != {"schemaVersion", "binding", "preparation"}:
            raise ValueError
        if type(inner["schemaVersion"]) is not int or inner["schemaVersion"] != 1:
            raise ValueError
        binding = validate_worker_binding(inner["binding"])
        if any(binding[name] != expected[name] for name in _BINDING_KEYS):
            raise ValueError
        raw_preparation = json.dumps(inner["preparation"], ensure_ascii=False,
                                     separators=(",", ":"), allow_nan=False)
        plan = adapter.plan_sdk_input(raw_preparation)
        return VerifiedWorkerManifest(MappingProxyType(binding.copy()), plan)
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise ManifestError("INVALID_WORKER_MANIFEST") from None
