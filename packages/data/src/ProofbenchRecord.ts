import { date, entity, role, text, uuid } from '@microsoft/rayfin-core';

@entity()
@role('authenticated', ['read', 'create'], {
  policy: (claims, row) => claims.sub.eq(row.owner_id),
})
export class ProofbenchRecord {
  @uuid() id!: string;
  @text({ min: 1, max: 1024 }) owner_id!: string;
  @text({ min: 1, max: 64 }) kind!: string;
  @uuid({ optional: true }) suiteId?: string;
  @date() createdAt!: Date;
  @text({ min: 1, max: 4000 }) payload!: string;
}
