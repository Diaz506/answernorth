"""Validate a preparation and map it to SDK inputs without invoking the SDK."""

import hashlib
import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime

if __package__:
    from .safe_json import StrictJSONError, loads
else:
    from safe_json import StrictJSONError, loads

MAX_BYTES = 500_000
UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")
TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
CONTROL_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


class PreparationError(ValueError):
    """Content-free validation error."""


@dataclass(frozen=True)
class CaseInput:
    case_id: str
    question: str = field(repr=False)
    expected_answer: str = field(repr=False)


@dataclass(frozen=True)
class SDKInputPlan:
    workspace_id: str
    agent_id: str
    suite_id: str
    suite_hash: str
    stage: str
    workspace_name: str = field(repr=False)
    agent_name: str = field(repr=False)
    cases: tuple[CaseInput, ...] = field(repr=False)

    def sdk_rows(self):
        """Return the input columns documented for the Fabric evaluation SDK."""
        return tuple({"question": case.question, "expected_answer": case.expected_answer}
                     for case in self.cases)


def validate_sdk_input_plan(plan):
    """Validate a plan's bounded structure, not its authenticity or provenance."""
    if type(plan) is not SDKInputPlan:
        _reject()
    _id(plan.workspace_id)
    _id(plan.agent_id)
    _id(plan.suite_id)
    _text(plan.agent_name, 1, 256)
    _text(plan.workspace_name, 1, 256)
    if not isinstance(plan.suite_hash, str) or not HASH_PATTERN.fullmatch(plan.suite_hash) or \
       plan.stage not in ("production", "sandbox") or type(plan.cases) is not tuple or \
       not 1 <= len(plan.cases) <= 30:
        _reject()
    case_ids, questions = set(), set()
    for case in plan.cases:
        if type(case) is not CaseInput:
            _reject()
        _id(case.case_id)
        _text(case.question, 1, 1000)
        _text(case.expected_answer, 1, 1500)
        if case.case_id in case_ids or case.question in questions:
            _reject()
        case_ids.add(case.case_id)
        questions.add(case.question)


def _reject():
    raise PreparationError("INVALID_PREPARATION")


def _keys(value, required):
    if not isinstance(value, dict) or set(value) != set(required):
        _reject()


def _id(value):
    if not isinstance(value, str) or not UUID_PATTERN.fullmatch(value):
        _reject()
    try:
        if str(uuid.UUID(value)) != value:
            _reject()
    except ValueError:
        _reject()
    return value


def _text(value, minimum, maximum):
    if not isinstance(value, str) or (minimum > 0 and not value.strip()) or CONTROL_PATTERN.search(value):
        _reject()
    try:
        length = len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError:
        _reject()
    if not minimum <= length <= maximum:
        _reject()
    return value


def _timestamp(value):
    if not isinstance(value, str) or not TIMESTAMP_PATTERN.fullmatch(value):
        _reject()
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        _reject()
    return value


def _suite_digest(suite, cases):
    payload = [
        "proofbench-suite-v1",
        suite["id"],
        suite["name"],
        suite["version"],
        suite["createdAt"],
        [[case["id"], case["question"], case["expectedAnswer"], case["category"], case["critical"]]
         for case in cases],
    ]
    try:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (UnicodeEncodeError, ValueError):
        _reject()
    return hashlib.sha256(encoded).hexdigest()


def plan_sdk_input(raw):
    """Return bounded SDK inputs only; this does not authorize or execute a run.

    The caller must independently obtain the preparation from trusted,
    owner-scoped storage, revalidate the target and establish approval.
    """
    try:
        preparation = loads(raw, MAX_BYTES)
    except StrictJSONError:
        _reject()
    _keys(preparation, ("schemaVersion", "target", "suite"))
    if type(preparation["schemaVersion"]) is not int or preparation["schemaVersion"] != 1:
        _reject()
    target, suite = preparation["target"], preparation["suite"]
    _keys(target, ("id", "name", "workspaceId", "workspaceName", "stage", "publicationVerified"))
    _keys(suite, ("id", "name", "version", "createdAt", "cases", "hash"))
    agent_id = _id(target["id"])
    workspace_id = _id(target["workspaceId"])
    agent_name = _text(target["name"], 1, 256)
    workspace_name = _text(target["workspaceName"], 1, 256)
    if target["stage"] not in ("production", "sandbox") or target["publicationVerified"] is not False:
        _reject()
    suite_id = _id(suite["id"])
    _text(suite["name"], 1, 120)
    _timestamp(suite["createdAt"])
    if type(suite["version"]) is not int or not 1 <= suite["version"] <= 9_007_199_254_740_991:
        _reject()
    if not isinstance(suite["hash"], str) or not HASH_PATTERN.fullmatch(suite["hash"]):
        _reject()
    cases = suite["cases"]
    if not isinstance(cases, list) or not 1 <= len(cases) <= 30:
        _reject()
    case_ids, questions, inputs = set(), set(), []
    for case in cases:
        _keys(case, ("id", "question", "expectedAnswer", "category", "critical"))
        case_id = _id(case["id"])
        question = _text(case["question"], 1, 1000)
        expected = _text(case["expectedAnswer"], 1, 1500)
        _text(case["category"], 0, 80)
        if type(case["critical"]) is not bool or case_id in case_ids or question in questions:
            _reject()
        case_ids.add(case_id)
        questions.add(question)
        inputs.append(CaseInput(case_id, question, expected))
    if _suite_digest(suite, cases) != suite["hash"]:
        _reject()
    return SDKInputPlan(workspace_id, agent_id, suite_id, suite["hash"], target["stage"],
                        workspace_name, agent_name, tuple(inputs))
