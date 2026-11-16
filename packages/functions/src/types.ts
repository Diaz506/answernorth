/**
 * Function schema types for RayfinClient.
 *
 * AUTO-GENERATED — do not edit manually.
 * Re-generated automatically when function source files change.
 *
 * If this file is not updating automatically, run:
 *   rayfin dev functions apply
 *
 * The schema is a closed object type: only the function names listed
 * below are accepted by RayfinClient.functions.<name>.invoke(...).
 * Adding, renaming, or changing the signature of a udf.func() call
 * regenerates this file and surfaces type errors at every consumer.
 *
 * IMPORTANT: This file must NOT import any Node.js packages — it is
 * resolved by the frontend app's TypeScript compiler.
 */

export type AppFunctionsSchema = {
  proofbenchBootstrap: {
    input: Record<string, never>;
    output: string;
  };
  proofbenchAgents: {
    input: { workspaceId: string };
    output: string;
  };
  proofbenchProbeAgent: {
    input: { workspaceId: string; agentId: string };
    output: string;
  };
  proofbenchSaveSuite: {
    input: { suiteJson: string };
    output: string;
  };
  proofbenchCreateRun: {
    input: { selectionJson: string; requestId: string };
    output: string;
  };
  proofbenchApproveRun: {
    input: { runId: string; approvalDigest: string };
    output: string;
  };
  proofbenchStartRun: {
    input: { runId: string; approvalDigest: string };
    output: string;
  };
  proofbenchRunStatus: {
    input: { runId: string };
    output: string;
  };
  proofbenchSmokeStatus: {
    input: Record<string, never>;
    output: string;
  };
  proofbenchSubmitSmoke: {
    input: { approvalHash: string };
    output: string;
  };
  proofbenchSmokeEvidence: {
    input: Record<string, never>;
    output: string;
  };
  proofbenchAIQualification: {
    input: { action: string };
    output: string;
  };
  proofbenchSuggestions: {
    input: { action: string; requestJson: string };
    output: string;
  };
};
