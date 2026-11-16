# Pilot user guide

This guide describes intended workflows to validate in a configured, deployed pre-release build. Labels and controls may change during refactoring. Run only as the explicitly allowed Fabric app-item owner; other viewers are not supported. Never enter real personal or customer data unless your organization has approved the environment and use.

## 1. Discover an agent

Sign in to the protected app using the configured owner identity. Open the agent discovery area and select an accessible workspace and Data Agent. If nothing appears, first check the app owner's workspace and item permissions and whether discovery is supported for that resource. Discovery lists metadata; it does not prove that the agent can answer questions or that a particular data source is accessible.

The discovery scope may span workspaces accessible to the owner; the configured home workspace is not an authorization grant for those workspaces.

## 2. Probe a published agent

The backend includes a capability probe, but **the current UI does not expose a probe control**. A developer can invoke the authenticated function after configuration and deployment have passed the security checks. The intended probe initializes MCP and lists advertised tools without invoking them or sending a question; the target agent must be published. An unavailable endpoint, authorization failure or empty listing is not a failed answer or a numerical score. Record the timestamp, target and sanitized outcome if needed. See [Microsoft's MCP guide](https://learn.microsoft.com/en-us/fabric/data-science/data-agent-mcp-server).

## 3. Prepare a manual suite

Create a suite and manually enter approved test questions and expected criteria supported by the current UI. Save and reopen it to verify persistence. When changing a saved suite, verify that a new immutable revision is created and the earlier revision remains unchanged. Do not put secrets, personal information or restricted data into questions, expected answers, names or notes. Apply your classification and retention rules to suite contents.

## 4. Review and approve a run draft

Select an agent and a saved suite version, open the selection review, and choose
the intended stage. Create a draft, review the questions and expected answers,
and explicitly confirm the plan before approving it. The draft records the
selected agent, stage and immutable suite version; the backend rechecks the
suite and agent metadata on approval. If the selection has changed, create and
review a new draft rather than treating an old approval as transferable.

**Approving a draft does not publish an agent, submit a job or run an
evaluation.** Publication and the execution identity remain unverified. Run
history is bounded and may be incomplete; reload it after an uncertain save or
approval rather than automatically retrying. Do not treat absence from partial
history as proof that a record was not saved.

If a future version records a notebook job receipt, the draft review can request
its status explicitly. It does not poll automatically. Respect the provider's
polling delay; a completed notebook is still **unverified** and is not an
evaluation result. If the service is throttled without a usable delay, stop and
resolve the issue rather than repeatedly refreshing.

The browser stores a pending draft's request ID and selection IDs in session
storage to help reconcile an uncertain save after reload; it does not store the
questions or expected answers there. If that browser storage is unavailable,
draft creation is blocked. A deliberate retry uses the same request ID and
selection; it is not automatic. Closing the browser session can remove this
local recovery information, so follow your organization's incident process if
the outcome cannot be reconciled.

## 5. Interpret the boundary

The accelerator does not currently run a generic assessment, invoke the agent to answer suite questions, compute scores, provide previous pilot results, or generate tests with AI. There is no local evaluation runner. A saved suite or successful capability probe is preparation evidence only. Do not present it as an evaluation result.

If a control is unexpectedly enabled or data appears across identities, stop using the app and follow [security reporting](SECURITY.md). For routine failures see [operations](OPERATIONS.md).
