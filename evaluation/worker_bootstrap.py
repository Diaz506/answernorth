"""Offline runtime-context checks and a manifest retrieval boundary."""

from dataclasses import dataclass, field

if __package__:
    from .adapter import PreparationError, _id
    from .worker_manifest import ManifestError, validate_worker_binding, verify_worker_manifest
else:
    from adapter import PreparationError, _id
    from worker_manifest import ManifestError, validate_worker_binding, verify_worker_manifest


class WorkerBootstrapError(ValueError):
    """A content-free rejection before evaluation."""


class ManifestReadError(OSError):
    """A content-free transport failure from a future manifest reader."""


@dataclass(frozen=True)
class RuntimeCheck:
    """Context consistency only; not a token or identity attestation."""

    user_id: str = field(repr=False)
    workspace_id: str = field(repr=False)
    notebook_id: str = field(repr=False)


def check_runtime_context(context, expected_binding, expected_user_id):
    """Compare host-supplied runtime metadata to independently configured values.

    Context values are not proof of identity, job ownership, or single use.
    Pipeline and reference runs are outside this prototype's supported scope.
    """
    try:
        binding = validate_worker_binding(expected_binding)
        user = _id(expected_user_id)
        if type(context) is not dict:
            raise ValueError
        runtime_user = _id(context.get("userId"))
        workspace = _id(context.get("currentWorkspaceId"))
        notebook = _id(context.get("currentNotebookId"))
        if context.get("isForPipeline") is not False or context.get("isReferenceRun") is not False:
            raise ValueError
        if runtime_user != user or workspace != binding["workerWorkspaceId"] or \
                notebook != binding["workerNotebookId"]:
            raise ValueError
        return RuntimeCheck(runtime_user, workspace, notebook)
    except (ValueError, TypeError, PreparationError):
        raise WorkerBootstrapError("WORKER_CONTEXT_INVALID") from None


def retrieve_verified_manifest(context, expected_binding, expected_user_id, key, read_manifest):
    """Check context before an independently authenticated manifest read.

    The reader must be a trusted implementation that confines requests to
    configured storage, bounds data while reading, and raises ManifestReadError
    on expected failures. This seam does not implement a transport or
    authenticate the runtime.
    """
    try:
        binding = validate_worker_binding(expected_binding).copy()
    except (ValueError, TypeError, PreparationError):
        raise WorkerBootstrapError("WORKER_CONTEXT_INVALID") from None
    check_runtime_context(context, binding, expected_user_id)
    if type(key) is not bytes or len(key) != 32 or not callable(read_manifest):
        raise WorkerBootstrapError("WORKER_CONFIGURATION_INVALID")
    try:
        envelope = read_manifest(binding["runId"], binding["attemptId"])
    except ManifestReadError:
        raise WorkerBootstrapError("MANIFEST_UNAVAILABLE") from None
    try:
        return verify_worker_manifest(envelope, binding, key)
    except ManifestError:
        raise WorkerBootstrapError("MANIFEST_INVALID") from None
