import { SqliteStorageService, EntityRow, ObservationRow, RelationRow } from '../persistence/sqlite-storage.js';
import { config } from '../utils/config.js';
import {
  AgentContext,
  Entity,
  EntityStub,
  IndexStub,
  KnowledgeGraph,
  Relation,
  ObservationInput,
  ObservationResult,
  ObservationDeletion,
  GraphSummary,
  SearchResult,
  SearchTier
} from '../types/graph.js';

/**
 * Manages operations on the knowledge graph backed by SQLite.
 */
export class KnowledgeGraphManager {
  private storage: SqliteStorageService;

  constructor(storage: SqliteStorageService) {
    this.storage = storage;
  }

  // ── Tenant helpers ─────────────────────────────────────────────

  private getAllowedAgents(agentContext?: AgentContext): string[] | undefined {
    if (!agentContext) return undefined;
    const agents = [agentContext.agentId];
    const grants = config.agentReadGrants.get(agentContext.agentId);
    if (grants) agents.push(...grants);
    return agents;
  }

  private isEntityOwnedBy(entity: EntityRow, agentContext?: AgentContext): boolean {
    if (!agentContext) return true;
    const allowed = this.getAllowedAgents(agentContext)!;
    if (!allowed.includes(entity.created_by)) return false;
    if (agentContext.userId) {
      return entity.user_id === null || entity.user_id === agentContext.userId;
    }
    return true;
  }

  // ── Entity → wire format ──────────────────────────────────────

  private entityRowToEntity(row: EntityRow, observations: ObservationRow[]): Entity {
    const obs: string[] = observations.map(o => o.content);
    // Synthetic injection for wire compatibility
    obs.push(`authored_by:${row.created_by}`);
    obs.push(`authored_at:${row.created_at}`);
    if (row.user_id) {
      obs.push(`user_id:${row.user_id}`);
    }
    return { name: row.name, entityType: row.entity_type, observations: obs };
  }

  private relationRowToRelation(row: RelationRow): Relation {
    return {
      from: row.from_name!,
      to: row.to_name!,
      relationType: row.relation_type,
    };
  }

  // ── Index detection ───────────────────────────────────────────

  private isIndexEntity(entity: EntityRow | Entity): boolean {
    const type = 'entity_type' in entity ? entity.entity_type : entity.entityType;
    const name = entity.name;
    return type.toLowerCase().includes('index') || name.endsWith('_INDEX');
  }

  // ── Write operations ──────────────────────────────────────────

  async createEntities(entities: Entity[], agentContext?: AgentContext): Promise<Entity[]> {
    return this.storage.transaction(() => {
      const created: Entity[] = [];

      for (const input of entities) {
        // Skip duplicates
        if (this.storage.getEntityByName(input.name)) continue;

        const agentId = agentContext?.agentId || config.defaultAgentId;
        const userId = agentContext?.userId || null;

        const entityId = this.storage.createEntity(
          input.name, input.entityType, agentId, userId
        );

        // Add observations (skip synthetic tags from input)
        for (const obs of input.observations) {
          if (this.isSyntheticObservation(obs)) continue;
          this.storage.addObservation(entityId, obs, agentId, userId);
        }

        // Read back for return value
        const row = this.storage.getEntityById(entityId)!;
        const liveObs = this.storage.getLiveObservations(entityId);
        created.push(this.entityRowToEntity(row, liveObs));
      }

      return created;
    });
  }

  async createRelations(relations: Relation[], agentContext?: AgentContext): Promise<Relation[]> {
    return this.storage.transaction(() => {
      const created: Relation[] = [];
      const agentId = agentContext?.agentId || config.defaultAgentId;

      for (const input of relations) {
        const fromEntity = this.storage.getEntityByName(input.from);
        const toEntity = this.storage.getEntityByName(input.to);
        if (!fromEntity || !toEntity) continue;

        // Skip duplicates
        const existing = this.storage.findLiveRelation(fromEntity.id, toEntity.id, input.relationType);
        if (existing) continue;

        this.storage.createRelation(fromEntity.id, toEntity.id, input.relationType, agentId);
        created.push(input);
      }

      if (agentContext && created.length > 0) {
        console.error(
          `[AUDIT] agent=${agentContext.agentId} created ${created.length} relation(s):`,
          created.map(r => `${r.from} → ${r.relationType} → ${r.to}`).join(', ')
        );
      }

      return created;
    });
  }

  async addObservations(inputs: ObservationInput[], agentContext?: AgentContext): Promise<ObservationResult[]> {
    return this.storage.transaction(() => {
      const results: ObservationResult[] = [];
      const agentId = agentContext?.agentId || config.defaultAgentId;
      const userId = agentContext?.userId || null;

      for (const input of inputs) {
        const entity = this.storage.getEntityByName(input.entityName);
        if (!entity) {
          throw new Error(`Entity with name ${input.entityName} not found`);
        }

        const added: string[] = [];
        for (const content of input.contents) {
          if (this.isSyntheticObservation(content)) continue;
          // Skip duplicates
          const existing = this.storage.findLiveObservation(entity.id, content);
          if (existing) continue;
          this.storage.addObservation(entity.id, content, agentId, userId);
          added.push(content);
        }

        // Synthetic tags for wire compat in response
        if (agentContext && added.length > 0) {
          added.push(`authored_by:${agentId}`);
          if (userId) added.push(`user_id:${userId}`);
          added.push(`authored_at:${new Date().toISOString()}`);
        }

        results.push({ entityName: input.entityName, addedObservations: added });
      }

      return results;
    });
  }

  async deleteEntities(entityNames: string[], agentContext?: AgentContext): Promise<void> {
    this.storage.transaction(() => {
      const agentId = agentContext?.agentId || 'system';

      for (const name of entityNames) {
        const entity = this.storage.getEntityByName(name);
        if (!entity) continue;

        if (agentContext && !this.isEntityOwnedBy(entity, agentContext)) {
          console.error(`[AUDIT] agent=${agentContext.agentId} BLOCKED delete of ${name} (not owned)`);
          continue;
        }

        // Soft-delete: supersede all live observations and relations
        const liveObs = this.storage.getLiveObservations(entity.id);
        for (const obs of liveObs) {
          this.storage.softDeleteObservation(obs.id, agentId);
        }
        this.storage.softDeleteRelationsForEntity(entity.id, agentId);

        console.error(`[AUDIT] agent=${agentId} soft-deleted entity: ${name}`);
      }
    });
  }

  async deleteObservations(deletions: ObservationDeletion[], agentContext?: AgentContext): Promise<void> {
    this.storage.transaction(() => {
      const agentId = agentContext?.agentId || 'system';

      for (const deletion of deletions) {
        const entity = this.storage.getEntityByName(deletion.entityName);
        if (!entity) continue;

        if (agentContext && !this.isEntityOwnedBy(entity, agentContext)) {
          console.error(`[AUDIT] agent=${agentContext.agentId} BLOCKED observation delete on ${deletion.entityName}`);
          continue;
        }

        for (const obsContent of deletion.observations) {
          const obs = this.storage.findLiveObservation(entity.id, obsContent);
          if (obs) {
            this.storage.softDeleteObservation(obs.id, agentId);
          }
        }
      }
    });
  }

  async deleteRelations(relations: Relation[], agentContext?: AgentContext): Promise<void> {
    this.storage.transaction(() => {
      const agentId = agentContext?.agentId || 'system';

      for (const rel of relations) {
        const fromEntity = this.storage.getEntityByName(rel.from);
        const toEntity = this.storage.getEntityByName(rel.to);
        if (!fromEntity || !toEntity) continue;

        if (agentContext && !this.isEntityOwnedBy(fromEntity, agentContext)) {
          console.error(`[AUDIT] agent=${agentContext.agentId} BLOCKED relation delete: ${rel.from} -> ${rel.to}`);
          continue;
        }

        const existing = this.storage.findLiveRelation(fromEntity.id, toEntity.id, rel.relationType);
        if (existing) {
          this.storage.softDeleteRelation(existing.id, agentId);
        }
      }
    });
  }

  // ── Read operations ───────────────────────────────────────────

  async readGraph(agentContext?: AgentContext): Promise<KnowledgeGraph> {
    const allowedAgents = this.getAllowedAgents(agentContext);
    const userId = agentContext?.userId;

    const entityRows = this.storage.getAllEntities(allowedAgents, userId);
    const entities: Entity[] = [];

    for (const row of entityRows) {
      const obs = this.storage.getLiveObservations(row.id);
      if (obs.length === 0 && agentContext) continue; // Skip entities with no live observations for tenant views
      entities.push(this.entityRowToEntity(row, obs));
    }

    const entityNames = new Set(entities.map(e => e.name));
    const entityIds = entityRows.filter(r => entityNames.has(r.name)).map(r => r.id);
    const relationRows = this.storage.getLiveRelationsBetweenEntities(entityIds);
    const relations = relationRows.map(r => this.relationRowToRelation(r));

    return { entities, relations };
  }

  async readGraphSummary(agentContext?: AgentContext): Promise<GraphSummary> {
    const allowedAgents = this.getAllowedAgents(agentContext);
    const userId = agentContext?.userId;

    const allEntities = this.storage.getAllEntities(allowedAgents, userId);
    // Only count entities with live observations for tenant views
    const visibleEntities = agentContext
      ? allEntities.filter(e => this.storage.entityHasLiveObservations(e.id))
      : allEntities;

    const indices = visibleEntities.filter(e => this.isIndexEntity(e));
    const indexEntities: Entity[] = [];
    for (const idx of indices) {
      const obs = this.storage.getLiveObservations(idx.id);
      indexEntities.push(this.entityRowToEntity(idx, obs));
    }

    const indexIds = indices.map(e => e.id);
    const indexRelationRows = this.storage.getLiveRelationsBetweenEntities(indexIds);
    const indexRelations = indexRelationRows.map(r => this.relationRowToRelation(r));

    const totalRelations = this.storage.countLiveRelations(allowedAgents, userId);

    return {
      status: 'summary',
      reason: 'Returning indices as navigation layer. Use force=true for full graph.',
      indices: indexEntities.map(e => this.buildIndexStub(e)),
      indexRelations,
      counts: {
        total_entities: visibleEntities.length,
        total_relations: totalRelations,
        indices_returned: indices.length,
      },
      drill_down: {
        specific_entity: "open_nodes(['entity_name'])",
        search: "search_nodes('query')",
        full_graph: "read_graph({ force: true })",
      },
    };
  }

  async openNodes(names: string[], agentContext?: AgentContext): Promise<KnowledgeGraph> {
    const entityRows = this.storage.getEntitiesByNames(names);
    const filtered = agentContext
      ? entityRows.filter(r => this.isEntityOwnedBy(r, agentContext))
      : entityRows;

    const entities: Entity[] = [];
    for (const row of filtered) {
      const obs = this.storage.getLiveObservations(row.id);
      entities.push(this.entityRowToEntity(row, obs));
    }

    const entityIds = filtered.map(r => r.id);
    const hasIndex = filtered.some(e => this.isIndexEntity(e));

    let relations: Relation[];
    if (hasIndex) {
      // For index entities, also include inbound indexed_in relations
      const betweenRows = this.storage.getLiveRelationsBetweenEntities(entityIds);
      const allowedAgents = this.getAllowedAgents(agentContext);
      const inboundRows = this.storage.getInboundRelations(entityIds, allowedAgents);
      // Merge, dedup by relation id
      const seen = new Set<number>();
      const allRelRows: RelationRow[] = [];
      for (const r of [...betweenRows, ...inboundRows]) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          allRelRows.push(r);
        }
      }
      relations = allRelRows.map(r => this.relationRowToRelation(r));
    } else {
      const relRows = this.storage.getLiveRelationsForEntities(entityIds);
      relations = relRows.map(r => this.relationRowToRelation(r));
    }

    return { entities, relations };
  }

  // ── Search ────────────────────────────────────────────────────

  async searchNodes(query: string, agentContext?: AgentContext): Promise<SearchResult> {
    const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    const allowedAgents = this.getAllowedAgents(agentContext);
    const userId = agentContext?.userId;

    // Get all searchable entities
    const allEntities = this.storage.getAllEntities(allowedAgents, userId);
    const visibleEntities = agentContext
      ? allEntities.filter(e => this.storage.entityHasLiveObservations(e.id))
      : allEntities;

    // Build Entity objects for scoring (reuse existing scoring logic)
    const entityMap = new Map<string, Entity>();
    for (const row of visibleEntities) {
      const obs = this.storage.getLiveObservations(row.id);
      entityMap.set(row.name, this.entityRowToEntity(row, obs));
    }

    if (tokens.length <= 1) {
      const token = tokens[0] || '';
      const matched = [...entityMap.values()].filter(e => this.entityMatchesToken(e, token));
      matched.sort((a, b) => this.scoreEntity(b, [token]) - this.scoreEntity(a, [token]));
      const cap = this.tierCap(1, 1);
      const capped = matched.slice(0, cap);

      return {
        query,
        tokens,
        tiers: capped.length > 0 ? [{
          matchCount: 1,
          label: `matches "${token}"`,
          entities: capped.map(e => this.buildStub(e, [token])),
          total: matched.length,
          capped: matched.length > cap,
        }] : [],
        totalMatches: matched.length,
      };
    }

    const entityScores = new Map<string, number>();
    for (const entity of entityMap.values()) {
      let count = 0;
      for (const token of tokens) {
        if (this.entityMatchesToken(entity, token)) count++;
      }
      if (count > 0) entityScores.set(entity.name, count);
    }

    const tierMap = new Map<number, Entity[]>();
    for (const [name, score] of entityScores) {
      if (!tierMap.has(score)) tierMap.set(score, []);
      tierMap.get(score)!.push(entityMap.get(name)!);
    }

    const tiers: SearchTier[] = [];
    for (const count of [...tierMap.keys()].sort((a, b) => a - b)) {
      const tierEntities = tierMap.get(count)!;
      tierEntities.sort((a, b) => this.scoreEntity(b, tokens) - this.scoreEntity(a, tokens));
      const cap = this.tierCap(count, tokens.length);
      const capped = tierEntities.slice(0, cap);

      tiers.push({
        matchCount: count,
        label: count === tokens.length
          ? `matches all ${count} tokens`
          : `matches ${count} of ${tokens.length} tokens`,
        entities: capped.map(e => this.buildStub(e, tokens)),
        total: tierEntities.length,
        capped: tierEntities.length > cap,
      });
    }

    return { query, tokens, tiers, totalMatches: entityScores.size };
  }

  // ── Search internals (preserved from original) ────────────────

  private entityMatchesToken(entity: Entity, token: string): boolean {
    return (
      entity.name.toLowerCase().includes(token) ||
      entity.entityType.toLowerCase().includes(token) ||
      entity.observations.some(o => o.toLowerCase().includes(token))
    );
  }

  private scoreEntity(entity: Entity, tokens: string[]): number {
    let score = 0;
    if (this.isIndexEntity(entity)) score += 1000;

    const nameLower = entity.name.toLowerCase();
    const typeLower = entity.entityType.toLowerCase();

    for (const token of tokens) {
      if (nameLower.includes(token)) score += 30;
      else if (typeLower.includes(token)) score += 20;
      else if (entity.observations.some(o => o.toLowerCase().includes(token))) score += 10;
    }
    return score;
  }

  private buildStub(entity: Entity, tokens: string[]): EntityStub {
    const nameLower = entity.name.toLowerCase();
    const typeLower = entity.entityType.toLowerCase();
    const matchedIn: Array<'name' | 'type' | 'observation'> = [];

    for (const token of tokens) {
      if (nameLower.includes(token) && !matchedIn.includes('name')) matchedIn.push('name');
      if (typeLower.includes(token) && !matchedIn.includes('type')) matchedIn.push('type');
      if (entity.observations.some(o => o.toLowerCase().includes(token)) && !matchedIn.includes('observation'))
        matchedIn.push('observation');
    }

    const stub: EntityStub = { name: entity.name, type: entity.entityType, matchedIn };

    if (matchedIn.includes('observation') && !matchedIn.includes('name')) {
      const matchingToken = tokens.find(t => entity.observations.some(o => o.toLowerCase().includes(t)));
      if (matchingToken) {
        const matchingObs = entity.observations.find(o => o.toLowerCase().includes(matchingToken));
        if (matchingObs) {
          stub.snippet = matchingObs.length > 120 ? matchingObs.slice(0, 120) + '...' : matchingObs;
        }
      }
    }

    return stub;
  }

  private buildIndexStub(entity: Entity): IndexStub {
    let canonicalName: string | undefined;
    let summary: string | undefined;

    for (const obs of entity.observations) {
      const canonicalMatch = obs.match(/^canonical_name:(.+)$/);
      if (canonicalMatch) { canonicalName = canonicalMatch[1].trim(); continue; }
      if (/^[a-z_]+:[^\s]/.test(obs)) continue;
      if (!summary) {
        summary = obs.length > 120 ? obs.slice(0, 120) + '...' : obs;
      }
    }

    return { name: entity.name, type: entity.entityType, canonicalName, summary };
  }

  private tierCap(matchCount: number, totalTokens: number): number {
    if (totalTokens <= 1) return 20;
    return 10 + (matchCount - 1) * 5;
  }

  // ── Wiki-mode operations (new) ────────────────────────────────

  async entityHistory(entityName: string): Promise<ObservationRow[]> {
    return this.storage.getEntityHistory(entityName);
  }

  async changesToMine(agentId: string): Promise<any[]> {
    return this.storage.getChangesToMine(agentId);
  }

  async addComment(observationId: number, content: string, agentContext?: AgentContext): Promise<number> {
    const authoredBy = agentContext?.agentId || config.defaultAgentId;
    return this.storage.addComment(observationId, content, authoredBy);
  }

  async getObservationComments(observationId: number): Promise<any[]> {
    return this.storage.getComments(observationId);
  }

  async supersedeObservation(
    observationId: number,
    newContent: string,
    rationale: string,
    agentContext?: AgentContext
  ): Promise<number> {
    const authoredBy = agentContext?.agentId || config.defaultAgentId;
    const userId = agentContext?.userId || null;
    return this.storage.supersedeObservation(observationId, newContent, authoredBy, rationale, userId);
  }

  // ── Helpers ───────────────────────────────────────────────────

  private isSyntheticObservation(obs: string): boolean {
    return (
      obs.startsWith('authored_by:') ||
      obs.startsWith('authored_at:') ||
      obs.startsWith('user_id:')
    );
  }
}
