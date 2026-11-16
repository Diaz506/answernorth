import { AudienceType, UserDataFunctions, type RayfinContext } from '@microsoft/fabric-user-data-functions';
import type { UniversalAppSchema } from '@rayfin-app/shared';
import { backend } from './backend.js';

const udf = new UserDataFunctions();

udf.func(
  'proofbenchBootstrap',
  async (ctx: RayfinContext<UniversalAppSchema, AudienceType.Fabric>): Promise<string> =>
    backend(ctx).bootstrap(),
  []
);

udf.func(
  'proofbenchAgents',
  async (ctx: RayfinContext<UniversalAppSchema, AudienceType.Fabric>, workspaceId: string): Promise<string> =>
    backend(ctx).agents(workspaceId),
  []
);

udf.func(
  'proofbenchProbeAgent',
  async (ctx: RayfinContext<UniversalAppSchema, AudienceType.Fabric>, workspaceId: string, agentId: string): Promise<string> =>
    backend(ctx).probeAgent(workspaceId, agentId),
  []
);

udf.func(
  'proofbenchSaveSuite',
  async (ctx: RayfinContext<UniversalAppSchema, AudienceType.Fabric>, suiteJson: string): Promise<string> =>
    backend(ctx).saveSuite(suiteJson),
  []
);

udf.func(
  'proofbenchCreateRun',
  async (ctx: RayfinContext<UniversalAppSchema, AudienceType.Fabric>, selectionJson: string, requestId: string): Promise<string> =>
    backend(ctx).createRun(selectionJson, requestId),
  []
);

udf.func(
  'proofbenchApproveRun',
  async (ctx: RayfinContext<UniversalAppSchema, AudienceType.Fabric>, runId: string, approvalDigest: string): Promise<string> =>
    backend(ctx).approveRun(runId, approvalDigest),
  []
);

udf.func(
  'proofbenchStartRun',
  async (ctx: RayfinContext<UniversalAppSchema, AudienceType.Fabric>, runId: string, approvalDigest: string): Promise<string> =>
    backend(ctx).startRun(runId, approvalDigest),
  []
);

udf.func(
  'proofbenchRunStatus',
  async (ctx: RayfinContext<UniversalAppSchema, AudienceType.Fabric>, runId: string): Promise<string> =>
    backend(ctx).runStatus(runId),
  []
);

udf.func(
  'proofbenchSmokeStatus',
  async (ctx: RayfinContext<UniversalAppSchema, AudienceType.Fabric>): Promise<string> =>
    backend(ctx).smokeStatus(),
  []
);

udf.func(
  'proofbenchSubmitSmoke',
  async (ctx: RayfinContext<UniversalAppSchema, AudienceType.Fabric>, approvalHash: string): Promise<string> =>
    backend(ctx).submitSmoke(approvalHash),
  []
);

udf.func(
  'proofbenchSmokeEvidence',
  async (ctx: RayfinContext<UniversalAppSchema, AudienceType.Fabric | AudienceType.Storage>): Promise<string> =>
    backend(ctx).smokeEvidence(ctx.Tokens.Storage),
  []
);

udf.func(
  'proofbenchAIQualification',
  async (ctx: RayfinContext<UniversalAppSchema, AudienceType.Fabric>, action: string): Promise<string> =>
    backend(ctx).aiQualification(action),
  []
);

udf.func(
  'proofbenchSuggestions',
  async (ctx: RayfinContext<UniversalAppSchema, AudienceType.Fabric | AudienceType.Storage>, action: string, requestJson: string): Promise<string> =>
    backend(ctx).suggestions(ctx.Tokens.Storage, action, requestJson),
  []
);
