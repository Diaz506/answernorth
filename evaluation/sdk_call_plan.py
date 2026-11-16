"""Build a bounded SDK call plan without executing or authorizing it."""

import re
import uuid
from dataclasses import dataclass, field

if __package__:
    from .adapter import CaseInput, PreparationError, validate_sdk_input_plan
else:
    from adapter import CaseInput, PreparationError, validate_sdk_input_plan

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


class SDKCallPlanError(ValueError):
    """Content-free rejection of an invalid SDK call plan."""


def _id(value):
    if type(value) is not str or not _UUID.fullmatch(value):
        raise SDKCallPlanError("INVALID_SDK_CALL_PLAN")
    try:
        if str(uuid.UUID(value)) != value:
            raise SDKCallPlanError("INVALID_SDK_CALL_PLAN")
    except ValueError:
        raise SDKCallPlanError("INVALID_SDK_CALL_PLAN") from None
    return value


@dataclass(frozen=True)
class SDKCallPlan:
    run_id: str = field(repr=False)
    attempt_id: str = field(repr=False)
    table_name: str = field(repr=False)
    stage: str
    agent_name: str = field(repr=False)
    workspace_name: str = field(repr=False)
    rows: tuple[CaseInput, ...] = field(repr=False)

    def sdk_rows(self):
        return tuple({"question": case.question, "expected_answer": case.expected_answer}
                     for case in self.rows)

    def sdk_kwargs(self):
        return {"workspace_name": self.workspace_name, "table_name": self.table_name,
                "data_agent_stage": self.stage, "max_workers": 1, "num_query_repeats": 1}


def prepare_sdk_call(plan, run_id, attempt_id):
    """Plan a unique table namespace; this does not reserve storage or run the SDK.

    IDs must come from a verified owner-scoped run and a single-use claim. The
    caller must independently verify authorization, publication, current target
    metadata, runtime identity and absence of prior output before execution.
    """
    run_id, attempt_id = _id(run_id), _id(attempt_id)
    try:
        validate_sdk_input_plan(plan)
    except PreparationError:
        raise SDKCallPlanError("INVALID_SDK_CALL_PLAN") from None
    table = "answernorth_" + run_id.replace("-", "") + "_" + attempt_id.replace("-", "")
    return SDKCallPlan(run_id, attempt_id, table, plan.stage, plan.agent_name,
                       plan.workspace_name, plan.cases)
