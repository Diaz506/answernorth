"""Reconcile synthetic decoded detail rows offline; this is not hosted qualification.

The only accepted row keys are evaluation_id, question, expected_answer,
actual_answer and is_match, all required. Provider errors, status fields and
all other evidence are rejected, even when empty, until the schema is qualified.
Duplicate JSON keys cannot be detected after decoding; rejecting them during
JSON decoding is the caller's responsibility. UUIDs are canonical lowercase
RFC 4122-variant strings with a version from 1 through 8. Text limits are
UTF-16 code units; the aggregate
includes plan questions/answers and row questions/expected/actual answers.
actual_answer may be None or a string, including an empty string. Passed or
failed requires an actual_answer containing non-whitespace text. None for
is_match is unclear, not an operational error or a pass/fail.

No execution, identity verification, authorization or attestation is implied.
"""

import re
import uuid
from dataclasses import dataclass, field

if __package__:
    from .adapter import CaseInput, SDKInputPlan
else:
    from adapter import CaseInput, SDKInputPlan


MAX_CASES = 30
MAX_QUESTION_UNITS = 1000
MAX_EXPECTED_UNITS = 1500
MAX_ACTUAL_UNITS = 8192
MAX_TOTAL_UNITS = 350_000
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_KEYS = frozenset(("evaluation_id", "question", "expected_answer", "actual_answer", "is_match"))


class ReconciliationError(ValueError):
    """Content-free rejection of the entire reconciliation."""


@dataclass(frozen=True)
class CaseResult:
    case_id: str = field(repr=False)
    question: str = field(repr=False)
    expected_answer: str = field(repr=False)
    actual_answer: str | None = field(repr=False)
    outcome: str


@dataclass(frozen=True)
class ResultCounts:
    passed: int
    failed: int
    unclear: int


@dataclass(frozen=True)
class ReconciliationResult:
    evaluation_id: str = field(repr=False)
    cases: tuple[CaseResult, ...] = field(repr=False)
    counts: ResultCounts


def _reject():
    raise ReconciliationError("INVALID_RESULT_DETAILS") from None


def _id(value):
    if type(value) is not str or len(value) != 36 or not _UUID.fullmatch(value):
        _reject()
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        _reject()
    if str(parsed) != value:
        _reject()
    return value


def _units(value, minimum, maximum):
    if type(value) is not str or len(value) > maximum or _CONTROL.search(value):
        _reject()
    try:
        units = len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError:
        _reject()
    if not minimum <= units <= maximum:
        _reject()
    return units


def reconcile_results(plan: SDKInputPlan, expected_evaluation_id: str, rows: list) -> ReconciliationResult:
    """Return all reconciled cases or raise ReconciliationError, without side effects.

    Matching is by exact question, never row position. Output follows plan order.
    All input is validated independently, including directly constructed plans.
    Neither this function nor its output proves where the rows originated.
    """
    _id(expected_evaluation_id)
    if type(plan) is not SDKInputPlan or type(plan.cases) is not tuple:
        _reject()
    if not 1 <= len(plan.cases) <= MAX_CASES or type(rows) is not list or len(rows) != len(plan.cases):
        _reject()

    by_question = {}
    ids = set()
    total = 0
    for case in plan.cases:
        if type(case) is not CaseInput:
            _reject()
        _id(case.case_id)
        total += _units(case.question, 1, MAX_QUESTION_UNITS)
        total += _units(case.expected_answer, 1, MAX_EXPECTED_UNITS)
        if case.case_id in ids or case.question in by_question:
            _reject()
        ids.add(case.case_id)
        by_question[case.question] = case

    matched = {}
    counts = {"passed": 0, "failed": 0, "unclear": 0}
    for row in rows:
        if type(row) is not dict or len(row) != len(_KEYS) or row.keys() != _KEYS:
            _reject()
        if _id(row["evaluation_id"]) != expected_evaluation_id:
            _reject()
        question = row["question"]
        total += _units(question, 1, MAX_QUESTION_UNITS)
        total += _units(row["expected_answer"], 1, MAX_EXPECTED_UNITS)
        actual = row["actual_answer"]
        if actual is not None:
            total += _units(actual, 0, MAX_ACTUAL_UNITS)
        if total > MAX_TOTAL_UNITS:
            _reject()
        case = by_question.get(question)
        if case is None or question in matched or row["expected_answer"] != case.expected_answer:
            _reject()
        match = row["is_match"]
        if match is True:
            outcome = "passed"
        elif match is False:
            outcome = "failed"
        elif match is None:
            outcome = "unclear"
        else:
            _reject()
        if match is not None and (actual is None or not actual.strip()):
            _reject()
        matched[question] = CaseResult(case.case_id, case.question, case.expected_answer, actual, outcome)
        counts[outcome] += 1

    if len(matched) != len(by_question):
        _reject()
    return ReconciliationResult(expected_evaluation_id,
                                tuple(matched[case.question] for case in plan.cases),
                                ResultCounts(**counts))
