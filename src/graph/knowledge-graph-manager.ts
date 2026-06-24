import { StorageService } from '../persistence/storage.js';
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
 * Simple async mutex — serializes access to a critical section.
 */
class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    return new Promise<void>(resolve => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}

/**
 * Manages operations on the knowledge graph
 */
export class KnowledgeGraphManager {
  private storageService: StorageService;
  private writeLock = new AsyncMutex();

  constructor(storageService?: StorageService) {
    this.storageService = storageService || new StorageService();
  }

  async createEntities(entities: Entity[], agentContext?: AgentContext): Promise<Entity[]> {
    return this.writeLock.runExclusive(async () => {
      const graph = await this.storageService.loadGraph();

      const newEntities = entities.filter(
        e => !graph.entities.some(existingEntity => existingEntity.name === e.name)
      );

      if (agentContext) {
        for (const entity of newEntities) {
          if (!entity.observations.some(o => o.startsWith('authored_by:'))) {
            entity.observations.push(`authored_by:${agentContext.agentId}`);
          }
          if (agentContext.userId && !entity.observations.some(o => o.startsWith('user_id:'))) {
            entity.observations.push(`user_id:${agentContext.userId}`);
          }
          entity.observations.push(`authored_at:${new Date().toISOString()}`);
        }
      }

      graph.entities.push(...newEntities);
      await this.storageService.saveGraph(graph);
      return newEntities;
    });
  }

  async createRelations(relations: Relation[], agentContext?: AgentContext): Promise<Relation[]> {
    return this.writeLock.runExclusive(async () => {
      const graph = await this.storageService.loadGraph();

      const newRelations = relations.filter(
        r => !graph.relations.some(
          existingRelation =>
            existingRelation.from === r.from &&
            existingRelation.to === r.to &&
            existingRelation.relationType === r.relationType
        )
      );

      if (agentContext && newRelations.length > 0) {
        console.error(
          `[AUDIT] agent=${agentContext.agentId} created ${newRelations.length} relation(s):`,
          newRelations.map(r => `${r.from} → ${r.relationType} → ${r.to}`).join(', ')
        );
      }

      graph.relations.push(...newRelations);
      await this.storageService.saveGraph(graph);
      return newRelations;
    });
  }

  async addObservations(inputs: ObservationInput[], agentContext?: AgentContext): Promise<ObservationResult[]> {
    return this.writeLock.runExclusive(async () => {
      const graph = await this.storageService.loadGraph();
      const results: ObservationResult[] = [];

      for (const input of inputs) {
        const entity = graph.entities.find(e => e.name === input.entityName);

        if (!entity) {
          throw new Error(`Entity with name ${input.entityName} not found`);
        }

        const newObservations = input.contents.filter(
          content => !entity.observations.includes(content)
        );

        if (agentContext && newObservations.length > 0) {
          const authoredBy = `authored_by:${agentContext.agentId}`;
          if (!entity.observations.includes(authoredBy)) {
            newObservations.push(authoredBy);
          }
          if (agentContext.userId) {
            const userId = `user_id:${agentContext.userId}`;
            if (!entity.observations.includes(userId)) {
              newObservations.push(userId);
            }
          }
          newObservations.push(`authored_at:${new Date().toISOString()}`);
        }

        entity.observations.push(...newObservations);

        results.push({
          entityName: input.entityName,
          addedObservations: newObservations
        });
      }

      await this.storageService.saveGraph(graph);
      return results;
    });
  }

  async deleteEntities(entityNames: string[], agentContext?: AgentContext): Promise<void> {
    return this.writeLock.runExclusive(async () => {
      const graph = await this.storageService.loadGraph();
      const toDelete = new Set<string>();

      for (const name of entityNames) {
        const entity = graph.entities.find(e => e.name === name);
        if (!entity) continue;

        if (agentContext && !this.isOwnedBy(entity, agentContext)) {
          console.error(`[AUDIT] agent=${agentContext.agentId} BLOCKED delete of ${name} (not owned)`);
          continue;
        }
        toDelete.add(name);
        console.error(`[AUDIT] agent=${agentContext?.agentId || 'system'} deleted entity: ${name}`);
      }

      graph.entities = graph.entities.filter(e => !toDelete.has(e.name));
      graph.relations = graph.relations.filter(
        r => !toDelete.has(r.from) && !toDelete.has(r.to)
      );

      await this.storageService.saveGraph(graph);
    });
  }

  async deleteObservations(deletions: ObservationDeletion[], agentContext?: AgentContext): Promise<void> {
    return this.writeLock.runExclusive(async () => {
      const graph = await this.storageService.loadGraph();

      for (const deletion of deletions) {
        const entity = graph.entities.find(e => e.name === deletion.entityName);
        if (!entity) continue;

        if (agentContext && !this.isOwnedBy(entity, agentContext)) {
          console.error(`[AUDIT] agent=${agentContext.agentId} BLOCKED observation delete on ${deletion.entityName}`);
          continue;
        }

        entity.observations = entity.observations.filter(
          observation => !deletion.observations.includes(observation)
        );
      }

      await this.storageService.saveGraph(graph);
    });
  }

  async deleteRelations(relations: Relation[], agentContext?: AgentContext): Promise<void> {
    return this.writeLock.runExclusive(async () => {
      const graph = await this.storageService.loadGraph();

      graph.relations = graph.relations.filter(
        r => !relations.some(
          delRelation => {
            const matches = r.from === delRelation.from &&
              r.to === delRelation.to &&
              r.relationType === delRelation.relationType;

            if (matches && agentContext) {
              const fromEntity = graph.entities.find(e => e.name === r.from);
              if (fromEntity && !this.isOwnedBy(fromEntity, agentContext)) {
                console.error(`[AUDIT] agent=${agentContext.agentId} BLOCKED relation delete: ${r.from} -> ${r.to}`);
                return false;
              }
            }
            return matches;
          }
        )
      );

      await this.storageService.saveGraph(graph);
    });
  }

  async readGraph(agentContext?: AgentContext): Promise<KnowledgeGraph> {
    const graph = await this.storageService.loadGraph();
    if (!agentContext) return graph;

    const filteredEntities = graph.entities.filter(e => this.isOwnedBy(e, agentContext));
    const ownedNames = new Set(filteredEntities.map(e => e.name));
    const filteredRelations = graph.relations.filter(
      r => ownedNames.has(r.from) && ownedNames.has(r.to)
    );

    return { entities: filteredEntities, relations: filteredRelations };
  }

  private isIndexEntity(entity: Entity): boolean {
    return (
      entity.entityType.toLowerCase().includes('index') ||
      entity.name.endsWith('_INDEX')
    );
  }

  private isOwnedBy(entity: Entity, agentContext?: AgentContext): boolean {
    if (!agentContext) return true;

    if (entity.observations.includes(`authored_by:${agentContext.agentId}`)) {
      if (agentContext.userId) {
        const entityUserId = entity.observations.find(o => o.startsWith('user_id:'));
        if (!entityUserId) return true;
        return entityUserId === `user_id:${agentContext.userId}`;
      }
      return true;
    }

    const grants = config.agentReadGrants.get(agentContext.agentId);
    if (grants) {
      const authorTag = entity.observations.find(o => o.startsWith('authored_by:'));
      if (authorTag) {
        const sourceAgent = authorTag.slice(12);
        if (grants.has(sourceAgent)) return true;
      }
    }
    return false;
  }

  private buildIndexStub(entity: Entity): IndexStub {
    let canonicalName: string | undefined;
    let summary: string | undefined;

    for (const obs of entity.observations) {
      const canonicalMatch = obs.match(/^canonical_name:(.+)$/);
      if (canonicalMatch) {
        canonicalName = canonicalMatch[1].trim();
        continue;
      }
      if (/^[a-z_]+:[^\s]/.test(obs)) continue;
      if (!summary) {
        summary = obs.length > 120 ? obs.slice(0, 120) + '...' : obs;
      }
    }

    return { name: entity.name, type: entity.entityType, canonicalName, summary };
  }

  async readGraphSummary(agentContext?: AgentContext): Promise<GraphSummary> {
    const graph = await this.storageService.loadGraph();

    const tenantEntities = agentContext
      ? graph.entities.filter(e => this.isOwnedBy(e, agentContext))
      : graph.entities;
    const tenantEntityNames = new Set(tenantEntities.map(e => e.name));
    const tenantRelations = agentContext
      ? graph.relations.filter(r => tenantEntityNames.has(r.from) && tenantEntityNames.has(r.to))
      : graph.relations;

    const indices = tenantEntities.filter(e => this.isIndexEntity(e));
    const indexNames = new Set(indices.map(e => e.name));
    const indexRelations = tenantRelations.filter(
      r => indexNames.has(r.from) && indexNames.has(r.to)
    );

    return {
      status: 'summary',
      reason: 'Returning indices as navigation layer. Use force=true for full graph.',
      indices: indices.map(e => this.buildIndexStub(e)),
      indexRelations,
      counts: {
        total_entities: tenantEntities.length,
        total_relations: tenantRelations.length,
        indices_returned: indices.length
      },
      drill_down: {
        specific_entity: "open_nodes(['entity_name'])",
        search: "search_nodes('query')",
        full_graph: "read_graph({ force: true })"
      }
    };
  }

  private entityMatchesToken(entity: Entity, token: string): boolean {
    return (
      entity.name.toLowerCase().includes(token) ||
      entity.entityType.toLowerCase().includes(token) ||
      entity.observations.some(o => o.toLowerCase().includes(token))
    );
  }

  private scoreEntity(entity: Entity, tokens: string[]): number {
    let score = 0;

    if (this.isIndexEntity(entity)) {
      score += 1000;
    }

    const nameLower = entity.name.toLowerCase();
    const typeLower = entity.entityType.toLowerCase();

    for (const token of tokens) {
      if (nameLower.includes(token)) {
        score += 30;
      } else if (typeLower.includes(token)) {
        score += 20;
      } else if (entity.observations.some(o => o.toLowerCase().includes(token))) {
        score += 10;
      }
    }

    return score;
  }

  private buildStub(entity: Entity, tokens: string[]): EntityStub {
    const nameLower = entity.name.toLowerCase();
    const typeLower = entity.entityType.toLowerCase();
    const matchedIn: Array<'name' | 'type' | 'observation'> = [];

    for (const token of tokens) {
      if (nameLower.includes(token) && !matchedIn.includes('name')) {
        matchedIn.push('name');
      }
      if (typeLower.includes(token) && !matchedIn.includes('type')) {
        matchedIn.push('type');
      }
      if (
        entity.observations.some(o => o.toLowerCase().includes(token)) &&
        !matchedIn.includes('observation')
      ) {
        matchedIn.push('observation');
      }
    }

    const stub: EntityStub = {
      name: entity.name,
      type: entity.entityType,
      matchedIn,
    };

    if (matchedIn.includes('observation') && !matchedIn.includes('name')) {
      const matchingToken = tokens.find(t =>
        entity.observations.some(o => o.toLowerCase().includes(t))
      );
      if (matchingToken) {
        const matchingObs = entity.observations.find(o =>
          o.toLowerCase().includes(matchingToken)
        );
        if (matchingObs) {
          stub.snippet = matchingObs.length > 120
            ? matchingObs.slice(0, 120) + '...'
            : matchingObs;
        }
      }
    }

    return stub;
  }

  private tierCap(matchCount: number, totalTokens: number): number {
    if (totalTokens <= 1) return 20;
    return 10 + (matchCount - 1) * 5;
  }

  async searchNodes(query: string, agentContext?: AgentContext): Promise<SearchResult> {
    const graph = await this.storageService.loadGraph();
    const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);

    const searchableEntities = agentContext
      ? graph.entities.filter(e => this.isOwnedBy(e, agentContext))
      : graph.entities;

    if (tokens.length <= 1) {
      const token = tokens[0] || '';
      const matched = searchableEntities.filter(e => this.entityMatchesToken(e, token));

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
          capped: matched.length > cap
        }] : [],
        totalMatches: matched.length
      };
    }

    const entityScores = new Map<string, number>();
    for (const entity of searchableEntities) {
      let count = 0;
      for (const token of tokens) {
        if (this.entityMatchesToken(entity, token)) {
          count++;
        }
      }
      if (count > 0) {
        entityScores.set(entity.name, count);
      }
    }

    const tierMap = new Map<number, Entity[]>();
    for (const entity of searchableEntities) {
      const score = entityScores.get(entity.name);
      if (score) {
        if (!tierMap.has(score)) tierMap.set(score, []);
        tierMap.get(score)!.push(entity);
      }
    }

    const tiers: SearchTier[] = [];
    const sortedCounts = [...tierMap.keys()].sort((a, b) => a - b);

    for (const count of sortedCounts) {
      const tierEntities = tierMap.get(count)!;
      tierEntities.sort((a, b) => this.scoreEntity(b, tokens) - this.scoreEntity(a, tokens));

      const cap = this.tierCap(count, tokens.length);
      const capped = tierEntities.slice(0, cap);

      const label = count === tokens.length
        ? `matches all ${count} tokens`
        : `matches ${count} of ${tokens.length} tokens`;

      tiers.push({
        matchCount: count,
        label,
        entities: capped.map(e => this.buildStub(e, tokens)),
        total: tierEntities.length,
        capped: tierEntities.length > cap
      });
    }

    return {
      query,
      tokens,
      tiers,
      totalMatches: entityScores.size
    };
  }

  async openNodes(names: string[], agentContext?: AgentContext): Promise<KnowledgeGraph> {
    const graph = await this.storageService.loadGraph();

    const filteredEntities = graph.entities.filter(
      e => names.includes(e.name) && this.isOwnedBy(e, agentContext)
    );

    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
    const hasIndex = filteredEntities.some(e => this.isIndexEntity(e));

    const filteredRelations = graph.relations.filter(r => {
      if (filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)) return true;
      if (hasIndex && filteredEntityNames.has(r.to) && this.isOwnedBy(
        graph.entities.find(e => e.name === r.from) || { observations: [] } as any,
        agentContext
      )) return true;
      return false;
    });

    return {
      entities: filteredEntities,
      relations: filteredRelations
    };
  }
}
