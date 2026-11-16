# Contributing and testing

This staging copy is under active refactoring. Preserve the owner-only model and fail-closed configuration. Changes that enable runs, scoring, previous pilot evidence or AI generation require a separate implementation, security review, tests and documentation; a visible UI is not evidence of a working feature.

## Development setup

Use Node.js 24 and npm. Obtain approved access to the exact locked dependencies before running `npm ci`. Registry availability and prerelease package licensing must be resolved for any public distribution. Never commit tenant or customer configuration, generated deployment details, credentials, personal information or test artifacts containing sensitive data.

From the project root:

```sh
npm ci
npm run build:fabric
npm run typecheck
npm run lint
npm run test
npm run test:backend
npm run test:evaluation
npm run check:publication
```

`npm run test` runs frontend tests; backend tests use compiled functions, so build first. The evaluation tests use only the Python standard library; optional SDK introspection separately requires Python 3.10–3.13. The publication check is heuristic: it cannot establish that the selected files, identifiers, licenses, history or customer data are safe to publish. Inspect the scripts and tests in the release for prerequisites and coverage. None of these commands replaces the hosted checks in [configuration](CONFIGURATION.md#acceptance-checklist). `npm run dev` is a development script, not a local assessment runner.

The frontend build generates `packages/frontend/dist/THIRD_PARTY_NOTICES.txt`
for dependencies included in the browser bundle. The build fails if a bundled
dependency's license text is unavailable. The installed
`@microsoft/fabric-embedded-host` package supplies its license in its README;
the build checks its package version and copies that section into the notices
when no separate license file is present. This generated file is not a complete
inventory of server, build or optional dependencies, and it does not replace a
distribution-rights review.

The disabled [evaluation scaffold](../evaluation/README.md) has separate standard-library tests. From the `evaluation` directory run `python -B -m unittest -v`; these tests do not import the real SDK. Its optional SDK introspection is not an evaluation, a local runner, or evidence of hosted readiness.

## Minimum change coverage

- Backend: reject missing/malformed settings, wrong tenant and unauthorized owner; verify the configured home workspace and reject unauthorized direct calls; never leak tokens. Test owner isolation, immutable revisions, concurrent writes and retries.
- Discovery/probe: test inaccessible and unpublished agents, pagination or partial failures as applicable, and assert that capability discovery never invokes a tool or sends a question.
- Frontend: test loading, errors, empty states and gated capabilities. Never rely on the frontend as an authorization control.
- Deployment: test actual token binding, app-item ownership, resource grants, protected assets and server authorization in a permitted isolated workspace. Document what was tested and what remains unverified.

Use synthetic test fixtures. Avoid snapshots containing real identifiers, names, agent metadata, URLs, tokens or data. Keep evidence private and sanitized. Run the smallest relevant test set first, then the release checks appropriate to the change. Do not claim exactly-once execution without proving the necessary end-to-end guarantees.

## Documentation and reporting

Update the feature status, configuration contract and relevant guides when behavior changes. Cite current public platform documentation separately from observed accelerator behavior. Report vulnerabilities through [SECURITY.md](SECURITY.md), not public issue content. The existing [license](../LICENSE) remains authoritative.
