# AnswerNorth: Fabric Data Agent assessment accelerator

> **Early preview.** This project is being refactored for an owner-only pilot. It is not a production-ready evaluator, and the intended behavior below is not evidence that a deployment has passed acceptance tests.

Use this accelerator to prepare manually authored assessment suites, discover accessible Fabric Data Agents, and check whether a published agent advertises MCP capabilities. Its purpose is to help a technical team collect evidence before deciding whether and how to build a repeatable assessment workflow.

## What is and is not available

| Capability | Status in this preview |
| --- | --- |
| Protected React/Vite app and Fabric authentication | Intended pilot foundation; validate after deployment. |
| Manual suite storage | Intended owner-isolated, immutable suite revisions; validate persistence and authorization in your environment. |
| Cross-workspace agent metadata discovery | Intended, bounded by the app owner's actual Fabric access; validate in your environment. |
| MCP capability probe | Backend function only; no UI control. Intended to initialize and list advertised tools without asking a question. Requires a published agent. |
| Run drafts and plan approval | Owner-scoped drafts and explicit plan approval are implemented; validate the hosted deployment and authorization before use. Approval does **not** start or authorize execution. |
| SDK planning and result reconciliation | Internal offline input, table-name and synthetic result validation; not a hosted evaluator or evidence. |
| SDK qualification notebook | Generated, unexecuted notebook; SDK availability and runtime identity are not qualified. |
| Notebook job transport and status | Implemented behind a hard-disabled submission UDF. The internal coordinator and result linkage are not qualified or enabled; job completion is not an evaluation result. |
| Notebook concurrency guard | Internal, app-installation-scoped guard; a synthetic storage contention test produced one winner. It is not connected to public execution, and recovery and cross-installation coordination are not provided. |
| Worker manifest | Internal authenticated-envelope and OneLake publication/retrieval prototypes are tested offline; they are not connected to a notebook and do not authorize or prevent replay of a job. |
| Run orchestration, scoring and results | **Unavailable/gated.** No generic evaluator or results are claimed. |
| AI-generated test cases | **Unavailable/gated.** |
| Previous pilot smoke evidence | **Unavailable/gated** for this accelerator; not a reusable customer result. |
| Local evaluation runner | **Not provided.** |

Feature labels describe the target contract during refactoring, not a completed acceptance test. Do not treat a visible control, successful build, or MCP tool listing as proof of answer quality, data access, or evaluation readiness. See [architecture](docs/ARCHITECTURE.md).

The [pending work](ROADMAP.md) lists the security, execution and sharing gates
for an initial release.

Some internal identifiers retain the earlier Proofbench name for API and storage compatibility; the product name is AnswerNorth. Do not rename those contracts without a migration plan.

## Before you begin

- Node.js 24 and npm; run commands from the project root. The lockfile resolves packages from the Microsoft-hosted feed `https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/`. `npm ci` requires access to **all** locked packages, including the preview `@microsoft` Rayfin dependencies. This has not been verified on a clean external machine. See [dependency availability](docs/CONFIGURATION.md#dependency-availability); do not assume the public npm registry is an equivalent source or copy credentials into the project.
- A Fabric-enabled tenant and a suitable capacity: Microsoft documents a paid **F2 or higher**, or eligible Power BI Premium capacity, for Data Agents. Review [Data Agent prerequisites](https://learn.microsoft.com/en-us/fabric/data-science/how-to-create-data-agent#prerequisites), applicable [tenant settings](https://learn.microsoft.com/en-us/fabric/data-science/data-agent-tenant-settings), geography and organizational policy. An administrator may need to enable Copilot-related settings.
- A Fabric workspace where the deployer has the required item permissions (at least **Edit** on an existing app; workspace Contributor or higher may be needed to create one), and an app-item owner with access to the agent workspaces and resources needed for the pilot.
- A published Data Agent to probe; an unpublished agent cannot expose its MCP endpoint. Use test data approved for this purpose.
- An approved way to provide the deployment-specific tenant, workspace, app item and allowed-owner configuration to the **server runtime**. An isolated deployment confirmed the owner can connect, but authorization for another authenticated user and other security checks remain unverified. See [configuration and deployment](docs/CONFIGURATION.md). An unset or invalid value must fail closed.

## Quickstart

1. Review [security](docs/SECURITY.md), costs and the [configuration checklist](docs/CONFIGURATION.md). Work in a private, approved deployment copy: deployment tooling can write environment-specific values into local project files.
2. Verify Node and package access, then install from the lockfile:

   ```sh
   node --version
   npm --version
   npm ci
   ```

3. Identify the required server-side tenant, workspace, app item and owner values for an approved isolated target. Do not put credentials, identifiers, customer data or deployment-generated files in a public repository. Do not substitute browser environment variables for server-side authorization.
4. Build and check the package:

   ```sh
   npm run build:fabric
   npm run typecheck
   npm run test
   npm run test:backend
   npm run test:evaluation
   ```

   The evaluation scaffold tests use Python's standard library. Optional SDK introspection separately requires Python 3.10–3.13. These scripts are not proof of a functioning deployed evaluator; see [contributing and testing](docs/CONTRIBUTING.md).
   The frontend build also generates `packages/frontend/dist/THIRD_PARTY_NOTICES.txt`
   for the browser bundle; review the other dependencies separately.
5. Once the target and resulting changes are approved, follow [configuration and deployment](docs/CONFIGURATION.md): deploy to the isolated target, then provision the four values using masked secret prompts. Deployment changes remote Fabric resources and can update local configuration.
6. Sign in as the explicitly allowed app-item owner. Verify that an unauthorized identity and missing or incorrect configuration are rejected. Only then try metadata discovery, a backend capability-only probe and manual suite creation using [the user guide](docs/USER-GUIDE.md). Record the actual results and date; never substitute example evidence.

The usual Rayfin development script exists, but this accelerator does not include a local evaluator or a supported local end-to-end assessment path. A frontend preview is not a substitute for hosted identity or authorization verification.

## Access and security

This is an **owner-only** pilot, not a multi-user delegated-access application. Fabric's native external resource token is used server-side as the Fabric app item owner; it is **not** the visiting user's delegated identity. An app viewer does not acquire separate Fabric permissions through this app, and the design must not be represented as enforcing viewer-specific row-level security. Owner-scoped suite storage is an application isolation boundary, not a claim of per-viewer RLS. See [security boundaries](docs/SECURITY.md) and [Microsoft's external-resource guidance](https://learn.microsoft.com/en-us/fabric/apps/functions-connect-external-resources).

Questions, expected answers, agent metadata and logs can themselves be sensitive. Apply your organization's Microsoft Purview / Microsoft Information Protection classification, retention and sharing policies before entering or exporting any content. A sensitivity label is not a substitute for access controls; verify what labels and protection are actually supported and enforced by each storage and export path.

The app uses locally installed fonts or system fallbacks. It does not fetch
fonts from a third-party service; typography can vary by device.

## Costs and limitations

Fabric capacity, storage, network and related services can incur charges, including while experimenting. Review your capacity, budgets and [Fabric pricing](https://azure.microsoft.com/pricing/details/microsoft-fabric/) with your administrator. The probe only discovers capabilities; it does not establish answer quality, accuracy, correctness, latency or cost of a question. Preview services and SDKs may change; the [Fabric Data Agent Python SDK is preview](https://learn.microsoft.com/en-us/fabric/data-science/fabric-data-agent-sdk) and is not a promised accelerator dependency or evaluator.

## Documentation

- [Architecture and evidence boundaries](docs/ARCHITECTURE.md)
- [Pending work](ROADMAP.md)
- [Configuration, deployment and prerequisites](docs/CONFIGURATION.md)
- [User guide](docs/USER-GUIDE.md)
- [Operations and troubleshooting](docs/OPERATIONS.md)
- [Contributing and testing](docs/CONTRIBUTING.md)
- [Security and vulnerability reporting](docs/SECURITY.md)

The existing [MIT license](LICENSE) is preserved. Review the licenses and availability of dependencies separately. This staging copy does not itself constitute a support commitment.
