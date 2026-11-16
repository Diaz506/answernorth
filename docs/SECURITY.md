# Security

## Supported scope and threat model

This pre-release accelerator is intended for a single explicitly configured Fabric app-item owner. It is not a multi-user application, a viewer-delegated access layer or an implementation of viewer-specific RLS. Protected frontend hosting does not replace backend authorization.

The browser, request parameters, selected identifiers and any client-provided owner information are untrusted. Threats include unauthorized function invocation, confused-deputy access through the app owner's broader Fabric rights, cross-owner suite access, token disclosure, sensitive information in suite contents or logs, unexpected external transmission, unsafe configuration defaults and inadvertent publication of deployment files.

## Required guardrails

- Fail closed when tenant, workspace, app item or allowed-owner configuration is absent or invalid, or the tenant or caller is unauthorized. Managed callers must match the configured workspace, app and owner; the observed subject format is a compatibility constraint that must be checked against the host. Verify the home workspace is the intended deployment target. Validate the authenticated caller server-side on every protected operation; do not trust a UI gate.
- Use the native resource-scoped Fabric token only on the server. Fabric documents that external requests run as the app-item owner, not the viewer. The backend checks tenant, audience, expiry and the injected token's object ID against the configured owner; verify the host identity, claim format and effective permissions in the deployed environment. Do not expose tokens to the browser, logs, suites, errors or support tickets. Declaring a token audience does not grant access.
- Grant the owner only needed permissions; verify cross-workspace access deliberately. A changed app owner changes the security context and requires revalidation.
- Scope suite reads and writes to the authorized owner; verify earlier suite revisions cannot be changed through supported operations. Do not conflate this with WORM storage, regulatory retention or per-user RLS.
- Treat run approvals as owner actions bound to a snapshot, not as signatures, immutable audit attestations or permission to execute. The stored digest detects inconsistent content but an authorized actor or storage administrator can recompute it. Verify direct data paths and cross-user isolation independently.
- Pending draft recovery uses browser session storage for the request ID, selection IDs and stage, not questions or answers. Treat even these IDs as potentially sensitive metadata, especially on shared devices; session storage is not a durable audit record.
- Keep the MCP probe to initialization and capability discovery. Never invoke an advertised tool or transmit a test question in the probe. Do not claim an observed tool list proves evaluation safety.
- Keep runs, scores, AI generation and prior pilot smoke evidence gated until implemented and reviewed. Do not infer a supported built-in evaluator or service-principal evaluation from generic MCP documentation.
- The internal HMAC-authenticated guard coordinates runs only within one app installation's shared database. It cannot lock other installations or manually started jobs, and its key is a server-side secret, not a digital signature or protection against privileged administrators. Recent-job checks cannot close the race with external actors. Keep dispatch disabled until the guard, worker identity, trusted manifest, publication checks, receipt recovery and result provenance are verified. Initial and subsequent polling delays must be respected; UI session storage alone is not a server-wide rate limiter.
- The offline worker-manifest envelope is authenticated but not encrypted. The verifier's expected binding and dedicated key must come from an independently trusted source, not from the envelope or untrusted notebook parameters. Anyone with the key can forge envelopes; HMAC alone does not establish worker identity, current authorization or single-use execution. No key delivery or replay protection is implemented.
- Worker runtime metadata comparisons are consistency checks only. They are not verified Entra identity or proof of a particular Fabric job; a same-user manual execution or replay must not become an authorized run. Pipeline and reference contexts are currently rejected by the offline prototype, not qualified for hosted use.
- The candidate OneLake publisher uses a conditional write and exact readback. An isolated synthetic contention test observed a single winner and a `409 BlobAlreadyExists` conflict, but does not establish a general guarantee or non-owner isolation. A rejected or ignored condition could already have overwritten an object before detection. Verify atomic create, effective permissions, isolation and data-residency requirements in each approved deployment before use. A folder path is not an access-control boundary.
- Apply organizational Microsoft Purview / Microsoft Information Protection policies to questions, expected criteria, metadata, exports and logs. Verify actual protection at each storage and export boundary. Microsoft warns that data-agent responses consumed through external clients may cross Fabric compliance or geographic boundaries; account for this before enabling any future question flow.

See [external resource authentication](https://learn.microsoft.com/en-us/fabric/apps/functions-connect-external-resources), [Data Agent MCP](https://learn.microsoft.com/en-us/fabric/data-science/data-agent-mcp-server), and [sensitivity labels in Fabric](https://learn.microsoft.com/en-us/fabric/fundamentals/apply-sensitivity-labels). Platform documentation does not certify this implementation.

## Session revocation verification

An issue affecting session revocation was observed during isolated testing.
Revocation of previously issued sessions and refresh tokens has not been
established. Treat this as an open security release blocker and follow the
organization's incident and responsible-disclosure processes. Do not assume a
successful response alone invalidates every session, or that revoking an Entra
sign-in session also revokes a separate app session. Keep diagnostic evidence
and sensitive session details in an approved private channel.

## Reporting a vulnerability

Do not include exploit details, tokens, personal information or customer data in a public issue. Use the repository's **Security** tab and **Report a vulnerability** when private vulnerability reporting is enabled, or contact the maintainer or your organization's security team through an existing trusted private channel. Copies of the project need their own reporting channel. Provide the affected version, a minimal sanitized reproduction, expected versus actual behavior and impact. Do not test against environments or data without authorization.

For a suspected exposure, restrict access through your organization's incident process, preserve appropriate sanitized evidence, rotate or revoke affected credentials or grants as directed, and assess impact. No specific response time or support commitment is implied by this staging copy.
