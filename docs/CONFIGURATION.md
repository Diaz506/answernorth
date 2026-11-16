# Configuration and deployment

## Release gate: configuration contract

The backend reads the four settings below once per invocation through the Rayfin context's `getSecret` API, validates them as RFC-variant UUIDs, and has no defaults. Missing, malformed or unavailable values return `CONFIGURATION_ERROR` before outbound requests or database access. The installed SDK resolves the invocation secret bag first and falls back to the local process environment. An isolated hosted test confirmed that missing settings are rejected and that configured settings are read.

Microsoft documents [setting function secrets](https://learn.microsoft.com/en-us/fabric/apps/manage-function-secrets) on a deployed Fabric app with `rayfin secret set`. The installed SDK marks `getSecret` deprecated in favor of generated, registry-typed `ctx.Secrets`; it remains supported for names not yet registered. This accelerator uses `getSecret` deliberately so a fresh clone can build and fail closed before any deployment or generated registry exists. Never hand-edit `secrets.generated.ts`; a future migration to the typed API must use supported Rayfin generation and be validated end to end.

The initial deployment needed to provision secrets must be made only in an approved isolated environment. The intended functions fail closed until all four values are set; this does not establish that all other platform data paths are secured. Hosted identity comparisons and the negative tests below remain release gates. Do not treat this project as ready for customer data until those checks pass.

**Managed identity compatibility (November 2026):** In one isolated deployment, the host-authenticated Rayfin caller token's `tid` differed from the Fabric tenant, although its managed subject referenced the intended workspace, app and administrator. The backend now accepts only the observed managed-subject shape and checks all three identifiers against configuration; unknown formats fail closed. For other caller tokens it requires the configured tenant and a direct owner UUID. Independently, every supported function must validate the Fabric resource token's configured tenant, audience and owner before accessing data or making requests. This managed-subject format is an observed compatibility constraint, not a documented stability guarantee.

The revised binding allowed the configured owner to load workspace metadata and save two distinct revisions of a synthetic suite in that isolated deployment. Both revisions remained visible after refresh, with their original expected answers. Anonymous and signature-tampered function requests returned HTTP 401. These observations do **not** establish authorization for another authenticated user, all direct data paths, concurrency, or compatibility in another tenant. Those checks remain release gates.

An additional isolated test used an empty, unpublished synthetic agent and a synthetic suite to create and explicitly approve one run draft. The approval remained visible after reload; anonymous and signature-tampered calls to the new draft and approval functions returned HTTP 401. No agent question, notebook job or evaluation was submitted. A separate authenticated non-owner and hosted failure/retry cases still need verification.

An unexecuted SDK qualification notebook was also created and read back in an
isolated test workspace. Its existence does not establish that the pinned SDK,
runtime identity, critic permissions or output storage are ready.

The isolated app's hard-disabled start function and read-only status function
were subsequently checked against the approved synthetic draft: status reported
no job, start returned `FEATURE_DISABLED`, and anonymous and tampered requests
were rejected. The qualification notebook still had no job instances. This did
not exercise a real job receipt, hosted polling or an authenticated non-owner.

| Setting | Meaning | Required behavior |
| --- | --- | --- |
| `ANSWERNORTH_TENANT_ID` | The permitted Microsoft Entra tenant UUID. | Reject absent, invalid or mismatched tenant. |
| `ANSWERNORTH_WORKSPACE_ID` | The intended home workspace UUID. | Reject absent or invalid configuration; use this as the home workspace. It is not a blanket grant to every discovered workspace. Verify the configured workspace is the intended deployment target. |
| `ANSWERNORTH_APP_ID` | The deployed Fabric app item UUID. | Reject absent or invalid configuration and managed callers bound to a different app. |
| `ANSWERNORTH_OWNER_ID` | The single authorized app-item owner's identity UUID. | Reject absent, invalid or mismatched owner, including direct function calls. |

Job status reads for a recorded receipt additionally require server-only
`ANSWERNORTH_JOB_WORKSPACE_ID` and `ANSWERNORTH_JOB_NOTEBOOK_ID`, both canonical
UUIDs. They must match the receipt's configured execution target. They are not
needed for drafts or approvals, and setting them does not enable execution. Do
not point them at the qualification notebook as an evaluator; an actual
evaluation worker and its identity have not been qualified.

The internal notebook guard requires `ANSWERNORTH_JOB_GUARD_KEY` through the
server-side secret mechanism when a future, explicitly approved integration
constructs the coordinator. It must be a canonical unpadded base64url encoding
of 32 cryptographically random bytes, stable for the lifetime of the guard
history, and inaccessible to clients. No key is required for the currently
disabled public start function. Do not generate or provision a real key until
the execution integration and its key lifecycle are approved. Never put its
value in source, command arguments, output or logs. Key loss or rotation makes
existing signed history fail closed; a safe migration and recovery procedure
has not yet been implemented. Do not clear records or rotate a key to bypass a
held guard.

The synthetic storage contention probe exercised the local guard against an
isolated app database and produced one winner without any notebook job calls.
The guard itself has not been deployed or exposed as a public function; this
observation does not verify authenticated non-owner isolation or job recovery.
Session revocation remains an open release blocker; see
[session revocation](SECURITY.md#session-revocation-verification).

The offline worker-manifest prototype accepts a dedicated 32-byte HMAC key as
an internal dependency. It is distinct from the guard key and has no deployed
secret name, provisioning, rotation, delivery or worker-side trust mechanism.
No real key should be provisioned for it until those mechanisms and runtime
identity are designed and reviewed. Anyone holding that shared key can also
produce a valid MAC. The manifest contains suite content in encoded, not
encrypted, form and must be treated as sensitive.

These names describe staging source, not a successful deployment. Validation checks UUID syntax and rejects a common placeholder; it cannot detect every invented but syntactically valid UUID. Independently verify that all four values identify the intended real tenant, workspace, app item and owner. The owner check normalizes UUIDs in the managed subject; for non-managed caller tokens the direct subject is compared case-sensitively against the normalized owner. The Fabric resource token must contain an `oid` matching that owner. The backend checks token claims but relies on the host for signature validation. Verify that the hosted identity supplies the expected forms and that the host validates signatures. Do not commit environment-specific identifiers, tokens or credentials or disclose them in public issues. Client-side/Vite configuration is not a security boundary. Do not deploy with hard-coded defaults.

## Prerequisites

1. Install Node.js 24 and npm. Obtain the project and its dependencies through organization-approved channels. The lockfile records package tarball locations, so changing only the default npm registry may not make `npm ci` portable. See [dependency availability](#dependency-availability). The Rayfin dependencies include prerelease versions; availability, access and licensing must be checked before release. Do not work around package access by copying credentials or replacing packages without review.
2. Arrange a Fabric workspace, suitable Fabric capacity, a published test Data Agent, and an account permitted to deploy the app. Follow [Microsoft's prerequisites](https://learn.microsoft.com/en-us/fabric/data-science/how-to-create-data-agent#prerequisites) and [tenant settings](https://learn.microsoft.com/en-us/fabric/data-science/data-agent-tenant-settings). Access to a source and permission to deploy an app are distinct.
3. Confirm that the designated allowed owner is also the Fabric app item owner. The external token uses that identity and its permissions. Grant only the access needed to the agent workspaces and resources. A Contributor or higher workspace role may be needed for app creation; an existing app requires at least item Edit permission for deployment. Check current tenant rules and [deployment documentation](https://learn.microsoft.com/en-us/fabric/apps/deploy-app).
4. Assess data classification, residency, retention and cost with your security and capacity administrators. Cross-geo settings are policy decisions, not troubleshooting shortcuts.

## Dependency availability

The current lockfile's resolved package URLs use the Microsoft-hosted feed `https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/`. This is a dependency source, not a deployment target. An anonymous ranged request for the pinned Rayfin CLI 1.36.2 returned HTTP 206 in the staging environment, and `npm ci --offline` succeeded there using an existing local cache. Neither observation verifies all packages, fresh downloads, or access from a clean external customer machine. Public npm was unreachable from that environment, so no equivalence or availability there was established. Verify access, licenses and a clean install in your own approved environment; if unavailable, stop and arrange an authorized distribution path.

On one Windows development machine, Rayfin CLI 1.36.2 produced its dry-run output but aborted on exit under Node 24.13.0. An isolated Node 22.15.0 installation completed the same preview and deployment; the private build and backend tests also ran under it. This is an environment-specific observation, not a change to the project's Node 24 development baseline or evidence that other Node versions are supported end to end.

## Build and deploy

Work in a private deployment copy. From its root:

```sh
npm ci
npm run build:fabric
npm run typecheck
npm run test
```

Review the [Fabric deployment procedure](https://learn.microsoft.com/en-us/fabric/apps/deploy-app). `npm run rayfin:up` invokes the project's `rayfin up` script. Microsoft documents `npx rayfin up --dry-run` to preview a deployment and `npx rayfin login` for authentication. Use the locally installed CLI; do not download an unreviewed newer version automatically. The CLI may open interactive sign-in; sign in with the intended authorized identity, verify the workspace and item before accepting any changes, and follow your change-control process. A dry run is not an authorization or functional test.

After an approved initial deployment to the isolated target, use the CLI's masked prompts to configure each value on that exact deployed item:

```sh
npx rayfin secret set ANSWERNORTH_TENANT_ID
npx rayfin secret set ANSWERNORTH_WORKSPACE_ID
npx rayfin secret set ANSWERNORTH_APP_ID
npx rayfin secret set ANSWERNORTH_OWNER_ID
npx rayfin secret list
```

Do not include values in command arguments, screenshots, public logs or committed files. Confirm the CLI's active deployment before every update; `secret list` shows names, not values. Secret commands can modify the remote item and local generated metadata; review and protect the private deployment copy. One isolated deployment confirmed the provisioning sequence reaches the functions. Complete the acceptance checks before loading sensitive data.

Deployment can create or update an app item, schema and static content, and may write deployment details to `rayfin/rayfin.yml` and `.env.fabric-*` locally. Keep those generated, environment-specific values private. Do not assume a clean source tree after deployment or publish the deployment copy.

## Acceptance checklist

- [ ] Confirm server configuration is present through the supported mechanism; restart/redeploy as required by that mechanism.
- [ ] Confirm missing and malformed settings deny access, that a wrong tenant or owner is rejected, and that the configured home workspace is the intended accessible target; check direct backend calls as well as the UI.
- [ ] Verify the allowed identity is the actual app-item owner and that a second, unauthorized identity cannot read or write suites or invoke privileged actions.
- [ ] Verify the host-injected Fabric token's effective identity and rights are appropriate. The backend requires its tenant, audience, expiry and object ID to match the configured owner; test this against the real hosted identity.
- [ ] Verify protected assets and function authorization separately.
- [ ] Verify owner-isolated manual suite persistence and immutable revisions after a refresh; test concurrent saves and retry behavior without assuming exactly-once semantics.
- [ ] Verify session revocation for the deployed authentication mode, including previously issued refresh tokens; see [session revocation](SECURITY.md#session-revocation-verification).
- [ ] Verify cross-workspace discovery only shows resources accessible to the app owner; test inaccessible and unpublished agents.
- [ ] Capture sanitized protocol or server evidence that a probe performs discovery only, with no tool invocation or question.
- [ ] Verify run, scoring, prior smoke evidence and AI generation are unavailable/gated. Record version and results privately.

Do not treat this checklist as already passed. If a check fails, stop and resolve it before use.
