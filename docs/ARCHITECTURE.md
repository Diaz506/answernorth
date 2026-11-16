# Architecture and evidence boundaries

## Purpose and status

This is a pre-release owner-only pilot architecture for assessment preparation, not a general-purpose evaluation system. The implementation is changing. Each item below is a target to verify against the deployed revision, not a statement that acceptance testing has succeeded.

## Trust and data flow

```text
Allowed app-item owner
   │ Fabric sign-in; protected static frontend
   ▼
React / Vite frontend ──authenticated requests──► Rayfin Functions
                                                       │ server-side identity check
                                                       ├──► owner-isolated suite storage
                                                       └──► native Fabric external resource token
                                                                 │
                                                                 ├──► accessible workspace/agent metadata
                                                                 └──► published agent MCP:
                                                                      initialize + tools/list only
```

The deployment is intended to use application authentication. Microsoft documents that the native Fabric token uses the app item owner's identity for external calls, not the person viewing the frontend. The backend requires the Fabric token's tenant, audience, expiry and object ID to match the configured owner. The host-injected identity remains a trust boundary: verify its claim format, signature validation and effective rights in the actual deployment. A declared audience is not a grant of permissions. The app owner must have access to each target; discoverability may differ across workspaces. Authentication and backend authorization are separate: protected static content is not enough to secure function calls or stored suites.

The backend policy requires an explicitly configured tenant, home workspace, app item and allowed owner. Managed caller sessions must match the configured workspace, app and owner in the observed subject format; their issuer tenant is not assumed to be the Fabric tenant. Non-managed caller tokens must match the configured tenant and owner. All paths also require a Fabric resource token matching the configured tenant, audience and owner. Missing or malformed values, a wrong tenant or an unauthorized caller must deny access, including direct calls that bypass the UI. Verify the configured home workspace is the intended accessible target; cross-workspace discovery does not mean every target must equal that home workspace. Never replace these checks with a client-side flag or a default tenant, workspace or identity. The managed subject shape and host signature-validation boundary require independent hosted verification.

## Data and isolation

Suites are manually authored; the intended persistence contract is immutable revisions, scoped to the authorized owner. Changes should create a new revision, leaving earlier revisions intact. Run drafts reference a verified suite version and freeze its hash, selected agent metadata and stage. Their owner-scoped records and approval markers are create-only. A client-generated request UUID produces a deterministic owner-scoped run ID to prevent duplicate records on an exact retry; a conflicting selection fails. History returns at most ten drafts and explicitly reports when incomplete.

An explicit owner approval records the reviewed snapshot digest after rechecking the saved suite and current agent metadata. It approves a plan only: publication is not verified, and no agent is called. A separate internal, single-use submission claim precedes a single attempted POST; a validated job receipt can be recorded without ever following the response's location as a request URL. A claimed submission without a receipt remains uncertain and must never be automatically retried. The internal coordinator is not wired to the public start function, which is hard-disabled.

The internal coordinator acquires a create-only, HMAC-authenticated notebook guard shared by runs using the same app installation's database and tenant/workspace/notebook scope. It repeats the recent-job precheck after acquisition. A synthetic contention probe against isolated app storage produced one winner and one guard record; it did not submit a notebook job or establish hosted authorization, recovery or production readiness. The guard does not coordinate separate installations or independently started Fabric jobs. Recent-job checks reduce that risk but cannot eliminate the race with external actors.

Guard records do not expire. Release requires a matching persisted receipt, a terminal job observation, and complete recent-job history containing that job with no active or recent jobs. An uncertain acquisition, preflight or submission can leave the guard held, and there is no public recovery or release flow. History is capped at 1,000 generations and ten pages per record kind; incomplete, invalid, tampered or key-mismatched history fails closed. Loss or rotation of the HMAC key requires a reviewed migration or recovery procedure, which does not yet exist. Checksums, HMAC and create-only application APIs are not digital signatures, legal holds, WORM storage or protection against privileged administrators. Validate isolation by attempting reads and writes as a different identity and checking direct function and data paths. No exactly-once delivery is claimed.

An internal offline worker-manifest prototype re-reads the owner-scoped run,
approved claim and saved suite, re-resolves agent metadata, and binds their
snapshot to the deployment, run, attempt and configured notebook target. Its
HMAC covers the exact serialized payload using a separate key; the worker-side
verifier requires independently supplied expected binding values and key. The
envelope is encoded, not encrypted. This prototype is not connected to the
coordinator, public API, notebook or job transport. A valid MAC does not prove
the runtime identity, publication or current permissions, nor does it prevent
replay. A claim marked uncertain is not proof of submission or permission to
retry. Secure manifest delivery, key provisioning, runtime identity and
single-use consumption remain unsolved.

The offline worker bootstrap now checks runtime user, workspace and notebook
metadata against separately supplied expected values before invoking a
manifest-reader interface. It rejects pipeline and reference-run contexts, but
does not authenticate those values, prove which job is running or prevent a
manual replay. A fixed-origin OneLake publisher and bounded reader exist as
candidates, but no production transport or independent expected-binding
source is wired in. The publisher uses a conditional PUT, then checks ETag and
exact bytes; it never retries uncertain writes. A local publisher probe against
an isolated lakehouse, using the app owner's delegated Storage token and
synthetic content, observed one successful write and one `409 BlobAlreadyExists`
conflict. The winner's readback matched and the test object was removed. A
separate synthetic probe also checked repeat writes and conditional reads.
These observations do not establish non-owner isolation, the hosted app's
injected token, notebook identity, cross-tenant behavior, or a production
guarantee. Fabric documents different execution identities for manual/API,
pipeline and scheduled notebook runs; the actual context and effective
permissions must be qualified for the chosen trigger.

Metadata discovery is for agent selection, not data access certification. A published agent can expose an MCP endpoint. The intended probe performs the protocol handshake and lists capabilities; it must never invoke an agent tool or send an assessment question. A successful probe is evidence only of the capability response at that time, for that identity and target. Publication, permissions or policy can change.

## Deliberate exclusions

An internal, unregistered run-preparation method resolves an owner-scoped suite and target metadata and produces a versioned snapshot; the run-draft and plan-approval functions reuse it. Offline Python adapters validate the snapshot, plan a per-attempt SDK table name, and reconcile a conservative synthetic result shape. A pure notebook-job protocol parser rejects ambiguous receipts and never treats notebook completion as proof of a successful evaluation. None of these components dispatches a job or authorizes execution. The suite checksum detects inconsistencies but is not an authenticity guarantee. See [evaluation scaffold](../evaluation/README.md).

There is no supported generic run orchestration, scoring, results pipeline, AI-generated suite content, previous pilot smoke evidence or local evaluation runner. An unavailable or gated feature must remain unavailable until implemented, tested and reviewed. Do not infer support for a service-principal built-in evaluator from Fabric MCP authentication documentation; the two are different capabilities.

## Source versus verification

Microsoft's documentation explains [Fabric app external resource identity](https://learn.microsoft.com/en-us/fabric/apps/functions-connect-external-resources), [Data Agent MCP](https://learn.microsoft.com/en-us/fabric/data-science/data-agent-mcp-server), and [Fabric app deployment](https://learn.microsoft.com/en-us/fabric/apps/deploy-app). These are platform references, not proof that this accelerator works in your tenant. Establish a separate dated acceptance record containing the tested version, configuration, identity, test cases and actual outcomes, without recording tokens or sensitive content.
