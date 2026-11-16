# AnswerNorth: pending work

This is a pre-release assessment-preparation app. It can save manual suites,
discover accessible agents, and prepare run drafts for review. Approval records
a plan; it does not start an evaluation. Execution, scoring, results and AI
test generation remain disabled. The items below are not commitments or dates.

## Source distribution and review

These checks apply to each proposed copy or distribution of the source.

- [ ] Review the exact files and any Git history for tenant identifiers,
  credentials, customer material and deployment artifacts. Automated scans are
  supporting checks, not proof of anonymization.
- [ ] Confirm organizational approval for the intended repository and audience.
  Review the existing license and dependency distribution rights, including
  prerelease Rayfin packages and access to their locked package feed. Review
  branding and trademark use for the intended distribution.
- [ ] Establish a private vulnerability-reporting channel and review any
  platform security findings through the appropriate disclosure process.
- [ ] Verify the documented build and installation steps in a clean environment
  with access to the locked dependencies.

## Before enabling evaluation

- [ ] Resolve the session-revocation issue and verify previously issued
  sessions and refresh tokens. See [security](docs/SECURITY.md).
- [ ] Test an authenticated non-owner against app functions, direct data
  access, and storage. Confirm the intended owner's rights and the effective
  notebook identity for the chosen execution trigger.
- [ ] Supply the worker with a trusted run binding and verification material.
  Design secure key management, manifest delivery, authorization, replay
  prevention and access-controlled storage; do not rely on notebook parameters
  or runtime metadata as proof of identity.
- [ ] Add a reviewed recovery path for held guards and uncertain submissions.
  Address the app-scoped guard's limits and coordination with external jobs.
- [ ] Qualify the pinned SDK and runtime in an approved isolated environment.
  Check publication, data-source permissions and per-attempt output isolation.
- [ ] Implement the worker and test a complete evaluation against a published
  synthetic agent with synthetic data. Reconcile actual result and step records
  before displaying outcomes; a completed notebook alone is not a result.
- [ ] Add a results view and handle failures, polling limits, cancellation and
  uncertain outcomes. Verify the end-to-end behavior and security boundaries.

## Later work

- [ ] Design optional AI-generated test suggestions with human review and
  appropriate data-handling controls.
- [ ] Review customer readiness, support ownership, accessibility, costs and
  dependency availability before offering a supported release.

See [architecture](docs/ARCHITECTURE.md), [configuration](docs/CONFIGURATION.md)
and the [evaluation scaffold](evaluation/README.md) for design boundaries.
