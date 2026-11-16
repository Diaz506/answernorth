"""Explicit, offline SDK introspection; execution and suggestions are disabled."""

import importlib
import importlib.metadata
import inspect
import sys

if __package__:
    from .adapter import plan_sdk_input as prepare_sdk_input
    from .result_reconciliation import ReconciliationError, reconcile_results
    from .safe_json import StrictJSONError, loads
    from .sdk_call_plan import prepare_sdk_call
    from .worker_manifest import verify_worker_manifest
else:
    from adapter import plan_sdk_input as prepare_sdk_input
    from result_reconciliation import ReconciliationError, reconcile_results
    from safe_json import StrictJSONError, loads
    from sdk_call_plan import prepare_sdk_call
    from worker_manifest import verify_worker_manifest

SDK_DISTRIBUTION = "fabric-data-agent-sdk"
SDK_VERSION = "0.1.36a0"
SDK_MODULE = "fabric.dataagent.evaluation"
SDK_FUNCTIONS = (
    "evaluate_data_agent",
    "get_evaluation_summary",
    "get_evaluation_details",
)


class QualificationError(RuntimeError):
    """A stable, content-free reason why qualification could not proceed."""


def qualify():
    """Introspect an already installed SDK; never execute its evaluation functions.

    This is not authorization, runtime readiness, or an evaluation result.
    Importing a third-party package executes that package's own import code.
    """
    if not ((3, 10) <= sys.version_info[:2] < (3, 14)):
        raise QualificationError("UNSUPPORTED_PYTHON")
    try:
        version = importlib.metadata.version(SDK_DISTRIBUTION)
    except importlib.metadata.PackageNotFoundError:
        raise QualificationError("SDK_NOT_INSTALLED") from None
    except Exception:
        raise QualificationError("SDK_VERSION_UNAVAILABLE") from None
    if version != SDK_VERSION:
        raise QualificationError("SDK_VERSION_MISMATCH")
    try:
        module = importlib.import_module(SDK_MODULE)
        functions = {}
        for name in SDK_FUNCTIONS:
            func = getattr(module, name)
            if not callable(func):
                raise TypeError
            signature = inspect.signature(func)
            functions[name] = [
                {"name": p.name, "kind": p.kind.name,
                 "required": p.default is inspect.Parameter.empty}
                for p in signature.parameters.values()
            ]
    except Exception:
        raise QualificationError("SDK_INTROSPECTION_FAILED") from None
    return {
        "status": "INTROSPECTION_ONLY",
        "sdk_version": version,
        "python_version": ".".join(str(v) for v in sys.version_info[:3]),
        "functions": functions,
        "evaluation_ready": False,
    }

def reconcile_sdk_output(plan, evaluation_id, raw):
    """Validate synthetic detail JSON; no execution or provenance is implied."""
    try:
        rows = loads(raw, 1_000_000)
    except StrictJSONError:
        raise ReconciliationError("INVALID_RESULT_DETAILS") from None
    return reconcile_results(plan, evaluation_id, rows)


def evaluate_manifest(_manifest=None):
    """Fail closed regardless of input; orchestration is not implemented."""
    raise QualificationError("EVALUATION_DISABLED")


def suggest_tests(_request=None):
    """Fail closed; configuration and qualification are not implemented."""
    raise QualificationError("SUGGESTIONS_DISABLED")
