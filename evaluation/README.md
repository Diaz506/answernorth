# Evaluation scaffold

This folder contains standard-library planning and reconciliation adapters, a
disabled worker, and a generated qualification notebook. It has no
preconfigured tenant, identity, output paths, customer prompts, receipts or
results. The tests use fictional inputs only. Importing `worker` performs no
qualification or execution. There is no local runner dependency, installer, or
automatic execution.

## Preparation contract

The internal TypeScript backend preparation accepts only workspace ID, agent ID,
saved suite ID and stage (`production` or `sandbox`). It resolves the owned,
integrity-checked suite and agent metadata server-side; caller-provided names,
output paths, owner IDs and additional keys are rejected. Duplicate questions are
rejected because the SDK's result-to-case mapping has not yet been established.
The output includes the suite snapshot, resolved target and
`publicationVerified: false`. The preparation method is not itself a callable
UDF; the run-draft and plan-approval UDFs reuse it internally.

`worker.prepare_sdk_input(json_text)` validates this bounded version-1 preparation,
rejects duplicate JSON keys, unexpected fields, invalid IDs, malformed cases,
duplicate questions and suite-hash mismatches, then returns an immutable input
plan. `plan.sdk_rows()` returns fresh `question` / `expected_answer` dictionaries
for the [Fabric Data Agent evaluation SDK](https://learn.microsoft.com/en-us/fabric/data-science/evaluate-data-agent).
The plan retains case IDs separately; category and critical flags remain in the
suite snapshot. No SDK, agent, network or filesystem call occurs during planning.
Preparation content can be sensitive; do not log it or expose it across users.

The suite checksum detects inconsistent content; it is **not a signature or
authorization**. A caller can recompute it. Before execution, a future
orchestrator must obtain a trusted owner-scoped snapshot, bind it to an approved
run, recheck the selected IDs, names, stage and publication, and verify both the
execution identity and access. The SDK selects by names, so renames or ambiguous
names must fail explicitly rather than silently target another agent. Case IDs
must not be paired with SDK output by assumed ordering; verify returned
correlation and completeness first.

The backend implements owner-scoped draft and plan-approval records, an
internal single-use submission claim, and create-only job receipts. A claim
without a confirmed receipt is uncertain, not evidence that a job was submitted.
An internal coordinator prechecks recent notebook jobs, makes at most one
submission attempt and records a validated receipt; it is **not wired to the
public start function**, which always rejects execution. A status function can
read a job only when an owner-scoped receipt and separately configured notebook
target match. A completed notebook is displayed as **unverified**, not as a
successful evaluation.

The status client honors the receipt's initial `Retry-After`, performs only an
explicit single GET, and returns subsequent delays for callers to honor. The UI
retains those per-run delays in session storage; they are not enforced globally
across different browsers or direct API callers. An internal app-scoped guard
coordinates runs using the same installation's database, but cannot coordinate
separate installations or manually started jobs. It has no automatic expiry or
public recovery path and is not wired to public execution. Trusted worker
manifest delivery and consumption, verified runtime identity, reserved per-attempt result paths,
result/step verification, cancellation and reconciliation are not implemented.
A future implementation must address these gaps before enabling dispatch. The adapter does not prove a
notebook identity, the SDK critic's permissions, data access, publication, result
storage or evaluation readiness.

## Offline authenticated worker manifest

The internal TypeScript issuer builds a version-1 HMAC envelope after re-reading
an owner-scoped run, validating its approval and claim, loading its saved suite,
and re-resolving the agent. The binding includes tenant, app, owner, run,
deterministic attempt, approval digest, worker workspace and notebook IDs.
The Python verifier checks the HMAC over the exact payload bytes and requires
all binding values and the dedicated key from an independent trusted context.
The encoded payload contains the complete preparation and is **not encrypted**;
do not log it or expose it as a notebook parameter.

The issuer and verifier are offline protocol prototypes, not a deployed
transport or an authorization decision. Key provisioning and delivery, worker
identity, current publication and permissions, single-use consumption, and
replay prevention are not implemented. A `submission_uncertain` claim does not
establish that a job was submitted or permit issuing a retry. Neither a valid
MAC nor successful verification enables `evaluate_manifest()`. A holder of the
shared key can also forge a valid envelope.

`worker_bootstrap.check_runtime_context()` compares host-supplied runtime user,
workspace and notebook IDs with independently configured expected values before
retrieval, and rejects pipeline and reference-run contexts in this prototype.
`retrieve_verified_manifest()` then invokes an injected reader using only the
validated run and attempt IDs and verifies the returned envelope. A candidate
`OneLakeManifestReader` uses a fixed public-cloud OneLake Blob origin,
configured workspace and lakehouse IDs, a storage-audience token provider, a
deterministic run/attempt path, no redirects and a bounded read. It has only
mocked tests and is not deployed or connected to a worker. It does not support
sovereign, private-link or custom endpoints. Callers must not supply arbitrary
endpoints, paths or secrets as job parameters.

These comparisons are **not identity attestation**: fabricated context values,
an interactive run by the same user, or a replay can satisfy them. The real
host context and authentication, the source of the expected binding and key,
storage permissions, transport, confidentiality and single-use consumption
must be independently established before a worker can run. Microsoft documents
that [notebook execution identity depends on the trigger](https://learn.microsoft.com/en-us/fabric/data-engineering/how-to-use-notebook#security-context-of-running-notebook)
and that [runtime context](https://learn.microsoft.com/en-us/fabric/data-engineering/notebookutils/notebookutils-runtime)
reports metadata rather than providing a job authorization decision. No
hosted identity test was performed by this scaffold.

The candidate storage path is not a security boundary: workspace roles and
OneLake data access must be reviewed, ideally using a dedicated restricted
lakehouse. A TypeScript publisher prototype produces a manifest from the
revalidated claimed run, uses a single conditional PUT, and confirms the ETag
and exact bytes with one bounded readback. It requires an explicitly supplied
transport; it is not wired to the coordinator or a public function. A timeout,
ambiguous write, rejected header or inconsistent readback fails closed without
automatic retry. A conflict is not permission to overwrite.

The publisher and reader have mocked tests, including cross-language
interoperability. In an isolated test, the local publisher used a delegated
Storage token for the app owner to write a synthetic manifest to a dedicated
lakehouse: concurrent attempts returned one `201` and one
`409 BlobAlreadyExists`, the winning readback matched, and the test object was
removed. A separate synthetic object confirmed a repeated create was blocked
and a wrong `If-Match` returned `412`; it was also removed. The local publisher
was not deployed, and no notebook, agent or customer data was used. This does
not verify the hosted app's injected token, the Python reader in a notebook,
other identities' permissions, or any other environment.

Azure Blob documents conditional create with
`If-None-Match: *`, while [OneLake API parity](https://learn.microsoft.com/en-us/fabric/onelake/onelake-api-parity)
does not itself establish atomic conditional create for every environment.
The isolated observation is not a guarantee of other deployments. If a service
ignored the precondition, detecting it after a response would not undo an
overwrite. Verify contention and permissions in each approved deployment before
relying on it. The global endpoint also requires
data-residency review; this candidate does not support regional, sovereign or
private-link endpoints. A deployed producer, key distribution and independently
trusted run binding remain unimplemented. Both manifest contents and storage
tokens must stay out of logs and notebook parameters; a reader must bound data
while streaming and fail closed on errors.

`worker.prepare_sdk_call(plan, run_id, attempt_id)` builds a deterministic
per-run, per-attempt table name and the pinned SDK's one-worker, one-repeat
arguments. It does not reserve a table, call the SDK, or authorize a job. The
caller must obtain the IDs from an approved owner-scoped run and a single-use
claim, verify the output location is unused, and revalidate the target and
execution identity before any future dispatch. The table plan assumes a default
lakehouse; that assumption is not yet qualified in this deployment.

`worker.reconcile_sdk_output(plan, evaluation_id, json_text)` strictly decodes
and correlates synthetic detail rows by exact question and expected answer, not
row order. It requires the same evaluation ID on every row, rejects duplicate or
missing cases and unrecognized fields, and separates passed, failed and unclear
outcomes. Passed and failed require a nonempty actual answer. The accepted
five-field row schema is **not yet qualified against a hosted SDK run**; do not
display or persist its output as real evidence until the actual schema,
provenance and result/step completeness are verified. No partial result is
returned on validation failure.

## Qualification notebook

`qualification.ipynb` is generated from the existing `worker.qualify()` source
by `build_qualification_notebook.py`. It contains no tenant values, data sources,
credentials or notebook outputs. It checks SDK availability and signatures only;
it cannot run an evaluation. To create a new copy without overwriting an
existing file, run `python -B evaluation/build_qualification_notebook.py
--output <new-file>.ipynb` from the project root.

One copy was created in an isolated test workspace and read back with its
contents intact. It has **not** been executed, and no dedicated SDK environment
has been attached or verified; a workspace default may still apply. Running it
requires an explicitly approved runtime and an installed pinned SDK; creating
the notebook does not install or qualify anything.

## SDK qualification

`worker.qualify()` checks Python 3.10 through 3.13 and the exact installed
`fabric-data-agent-sdk` distribution version `0.1.36a0`, then imports
`fabric.dataagent.evaluation` and introspects three callable signatures. A mismatch,
missing distribution or introspection failure fails closed. It does not invoke SDK
functions, access a runtime context, get tokens, call an agent, perform inference,
write data or make network requests itself. Python imports execute third-party module
code, whose behavior is outside this scaffold's control; review and provision that
package separately before invoking qualification. No package is installed here.
Introspection is not proof of authorization, permissions, runtime compatibility,
output compatibility, or readiness to run evaluations.

`worker.evaluate_manifest(...)` and `worker.suggest_tests(...)` always raise a
content-free disabled error. They do not consume, print, persist or transmit inputs.
Enabling either requires a separately designed, reviewed implementation including
customer configuration, qualification, authorization and data-handling controls;
no input flag enables them. No evaluation or fabricated results are produced.

Run the offline tests from this directory using `python -B -m unittest -v`.
They never import the real SDK. The cross-language integration tests require
Node and a built functions package; they skip when unavailable.
