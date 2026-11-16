# Operations and troubleshooting

## Before operating

Confirm the deployment has passed the [acceptance checklist](CONFIGURATION.md#acceptance-checklist), the runtime is configured for the intended tenant/workspace/owner, and the app-item owner has only necessary Fabric permissions. Maintain a private inventory of deployment version, owner, workspace, supported configuration source, and administrator contacts. Review access and costs regularly. Treat suite content and agent metadata as potentially sensitive.

## Troubleshooting

| Symptom | Checks and safe next step |
| --- | --- |
| `npm ci` cannot fetch a package | Check approved access to the exact locked package locations, including prerelease Rayfin packages. Do not paste credentials into files or logs; do not silently change the lockfile. |
| Sign-in or deployment gives 401/403 | Confirm the intended Entra identity, tenant, workspace and item Edit permission; renew sign-in using the [Fabric deployment guide](https://learn.microsoft.com/en-us/fabric/apps/deploy-app). A successful CLI sign-in does not grant deployed resource access. |
| App denies the intended owner | Confirm each required server-side setting and identifier format using the release's documented contract. Confirm actual app-item ownership. Never disable checks or add a permissive fallback. |
| Agent or workspace missing | Check the app owner's access, workspace/item permissions, tenant settings and scope. Discovery is constrained by actual access and can be incomplete. |
| Capability probe fails | Confirm the selected agent is published, the owner can access it, the Fabric token binding is present, and network/policy allows the request. MCP requires initialization before tool listing. A missing token or a 403 is not a reason to use a browser token or broaden access. |
| Suite does not persist or a revision is unexpected | Check backend errors, data service availability, authorization and deployment/schema version. Preserve a sanitized diagnostic record; do not assume retries are exactly once or delete data to hide a conflict. |
| Draft creation or approval is uncertain | Do not automatically retry. Reload run history and reconcile the exact draft; a partial history cannot establish absence. Investigate access or storage failures before another explicit action. |
| A run draft becomes stale | Agent names, workspace names or the saved suite may no longer match the reviewed snapshot. Recheck the target and create a new draft rather than reusing the old approval. |
| Notebook guard is busy, uncertain or cannot be verified | Do not retry submission, delete guard records or rotate the signing key to force progress. A guard has no automatic expiry and currently has no public recovery flow; preserve sanitized evidence and use an approved reconciliation process once one exists. History beyond 1,000 generations also fails closed. |
| Manifest publication is uncertain or conflicts | Do not retry automatically or overwrite the object. Preserve sanitized evidence and reconcile the exact attempt and stored bytes through an approved process. One isolated synthetic OneLake test does not qualify hosted identity, permissions or other environments. |
| Job status is throttled or unavailable | Do not automatically retry. Respect the returned delay; if no valid delay is available, investigate before retrying. A completed notebook does not establish that evaluation output exists or is correct. |
| Run, score or AI control unavailable | Expected for this accelerator. These capabilities are gated, not a signal to bypass safeguards. |

Microsoft notes that tenant settings can take time to propagate. Capacity, region, licensing and outbound access policies may also affect availability. Consult [tenant settings](https://learn.microsoft.com/en-us/fabric/data-science/data-agent-tenant-settings) and the [MCP guide](https://learn.microsoft.com/en-us/fabric/data-science/data-agent-mcp-server); avoid claiming a specific cause without evidence.

## Observability, change and retirement

Capture only minimal diagnostics: time, deployed version, operation, sanitized error class and a non-sensitive correlation identifier if available. Do not log bearer tokens, authentication headers, raw questions, answers or customer data. Restrict log access and apply retention rules.

Review app owner changes as security-sensitive: external-resource identity and permissions can change with ownership. Revalidate configuration, access and negative tests after changes to identity, permissions, schema, dependencies, tenant settings or app deployment. Follow an approved backup, retention and deletion process for suites; immutability alone is not a backup.

For retirement, restrict app access, preserve or delete approved records according to policy, remove the Fabric app and related resources using your organization's process, and revoke grants no longer needed. Inventory dependent resources first; do not assume deleting an app automatically deletes all data or permissions.
