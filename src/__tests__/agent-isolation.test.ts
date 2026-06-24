import { KnowledgeGraphManager } from '../graph/knowledge-graph-manager.js';
import { StorageService } from '../persistence/storage.js';
import { AgentContext, Entity, Relation } from '../types/graph.js';

const j5Entities: Entity[] = [
  {
    name: 'MASTER_INDEX',
    entityType: 'knowledge_index',
    observations: ['authored_by:j5', 'canonical_type:Knowledge', 'canonical_name:Master Index', 'summary: Top-level nav hub'],
  },
  {
    name: 'AUTH_SERVICE',
    entityType: 'service',
    observations: ['authored_by:j5', 'canonical_type:Service', 'handles auth tokens'],
  },
  {
    name: 'AUTH_BUG_001',
    entityType: 'bug',
    observations: ['authored_by:j5', 'canonical_type:Bug', 'status:active', 'token expiry race condition'],
  },
];

const boinxEntities: Entity[] = [
  {
    name: 'BOINX_TASK_INDEX',
    entityType: 'knowledge_index',
    observations: ['authored_by:boinx', 'canonical_type:Knowledge', 'canonical_name:Boinx Task Index', 'summary: Boinx task tracking'],
  },
  {
    name: 'BOINX_DIGEST_ANALYSIS',
    entityType: 'research',
    observations: ['authored_by:boinx', 'task analysis from digest pipeline'],
  },
];

const allEntities = [...j5Entities, ...boinxEntities];

const allRelations: Relation[] = [
  { from: 'AUTH_SERVICE', to: 'MASTER_INDEX', relationType: 'indexed_in' },
  { from: 'AUTH_BUG_001', to: 'MASTER_INDEX', relationType: 'indexed_in' },
  { from: 'AUTH_BUG_001', to: 'AUTH_SERVICE', relationType: 'depends_on' },
  { from: 'BOINX_DIGEST_ANALYSIS', to: 'BOINX_TASK_INDEX', relationType: 'indexed_in' },
];

function mockManager(entities: Entity[] = allEntities, relations: Relation[] = allRelations) {
  let state = {
    entities: entities.map(e => ({ ...e, observations: [...e.observations] })),
    relations: [...relations],
  };
  const storage = {
    loadGraph: () => Promise.resolve({
      entities: state.entities.map(e => ({ ...e, observations: [...e.observations] })),
      relations: [...state.relations],
    }),
    saveGraph: (graph: { entities: Entity[]; relations: Relation[] }) => {
      state = {
        entities: graph.entities.map(e => ({ ...e, observations: [...e.observations] })),
        relations: [...graph.relations],
      };
      return Promise.resolve();
    },
  } as unknown as StorageService;
  return new KnowledgeGraphManager(storage);
}

const j5: AgentContext = { agentId: 'j5' };
const boinx: AgentContext = { agentId: 'boinx' };

describe('readGraph with tenant isolation', () => {
  it('j5 sees only j5 entities', async () => {
    const manager = mockManager();
    const graph = await manager.readGraph(j5);
    const names = graph.entities.map(e => e.name);
    expect(names).toContain('MASTER_INDEX');
    expect(names).toContain('AUTH_SERVICE');
    expect(names).toContain('AUTH_BUG_001');
    expect(names).not.toContain('BOINX_TASK_INDEX');
    expect(names).not.toContain('BOINX_DIGEST_ANALYSIS');
  });

  it('boinx sees only boinx entities', async () => {
    const manager = mockManager();
    const graph = await manager.readGraph(boinx);
    const names = graph.entities.map(e => e.name);
    expect(names).toContain('BOINX_TASK_INDEX');
    expect(names).toContain('BOINX_DIGEST_ANALYSIS');
    expect(names).not.toContain('MASTER_INDEX');
    expect(names).not.toContain('AUTH_SERVICE');
  });

  it('no context returns full graph (backwards compat)', async () => {
    const manager = mockManager();
    const graph = await manager.readGraph();
    expect(graph.entities).toHaveLength(allEntities.length);
  });

  it('relations filtered to agent-owned endpoints only', async () => {
    const manager = mockManager();
    const graph = await manager.readGraph(j5);
    expect(graph.relations).toContainEqual({ from: 'AUTH_SERVICE', to: 'MASTER_INDEX', relationType: 'indexed_in' });
    expect(graph.relations).not.toContainEqual(expect.objectContaining({ from: 'BOINX_DIGEST_ANALYSIS' }));
  });

  it('boinx relations only include boinx entity endpoints', async () => {
    const manager = mockManager();
    const graph = await manager.readGraph(boinx);
    expect(graph.relations).toContainEqual({ from: 'BOINX_DIGEST_ANALYSIS', to: 'BOINX_TASK_INDEX', relationType: 'indexed_in' });
    expect(graph.relations).toHaveLength(1);
  });
});

describe('readGraphSummary with tenant isolation', () => {
  it('j5 sees only j5 index stubs', async () => {
    const manager = mockManager();
    const summary = await manager.readGraphSummary(j5);
    const indexNames = summary.indices.map(i => i.name);
    expect(indexNames).toContain('MASTER_INDEX');
    expect(indexNames).not.toContain('BOINX_TASK_INDEX');
  });

  it('boinx sees only boinx index stubs', async () => {
    const manager = mockManager();
    const summary = await manager.readGraphSummary(boinx);
    const indexNames = summary.indices.map(i => i.name);
    expect(indexNames).toContain('BOINX_TASK_INDEX');
    expect(indexNames).not.toContain('MASTER_INDEX');
  });

  it('counts reflect agent-scoped view, not global', async () => {
    const manager = mockManager();
    const summary = await manager.readGraphSummary(boinx);
    expect(summary.counts.total_entities).toBe(2);
    expect(summary.counts.total_relations).toBe(1);
  });

  it('no context returns full summary (backwards compat)', async () => {
    const manager = mockManager();
    const summary = await manager.readGraphSummary();
    expect(summary.counts.total_entities).toBe(allEntities.length);
  });
});

describe('searchNodes with tenant isolation', () => {
  it('j5 search only returns j5 entities', async () => {
    const manager = mockManager();
    const result = await manager.searchNodes('auth', j5);
    const allStubs = result.tiers.flatMap(t => t.entities);
    const names = allStubs.map(s => s.name);
    expect(names).toContain('AUTH_SERVICE');
    expect(names).not.toContain('BOINX_DIGEST_ANALYSIS');
  });

  it('boinx search only returns boinx entities', async () => {
    const manager = mockManager();
    const result = await manager.searchNodes('task', boinx);
    const allStubs = result.tiers.flatMap(t => t.entities);
    const names = allStubs.map(s => s.name);
    expect(names).toContain('BOINX_TASK_INDEX');
    expect(names).not.toContain('AUTH_SERVICE');
  });

  it('boinx search for j5-only term returns empty', async () => {
    const manager = mockManager();
    // 'token' matches j5 entities (AUTH_BUG_001 obs: 'token expiry race condition') but not boinx entities
    const result = await manager.searchNodes('token', boinx);
    expect(result.totalMatches).toBe(0);
  });

  it('no context searches full graph (backwards compat)', async () => {
    const manager = mockManager();
    const result = await manager.searchNodes('auth');
    expect(result.totalMatches).toBeGreaterThan(0);
  });
});

describe('openNodes with tenant isolation', () => {
  it('j5 can open j5 entities', async () => {
    const manager = mockManager();
    const result = await manager.openNodes(['MASTER_INDEX', 'AUTH_SERVICE'], j5);
    expect(result.entities).toHaveLength(2);
  });

  it('boinx cannot open j5 entities', async () => {
    const manager = mockManager();
    const result = await manager.openNodes(['MASTER_INDEX'], boinx);
    expect(result.entities).toHaveLength(0);
  });

  it('boinx can open boinx entities', async () => {
    const manager = mockManager();
    const result = await manager.openNodes(['BOINX_TASK_INDEX'], boinx);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('BOINX_TASK_INDEX');
  });

  it('mixed request returns only owned entities', async () => {
    const manager = mockManager();
    const result = await manager.openNodes(['MASTER_INDEX', 'BOINX_TASK_INDEX'], boinx);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('BOINX_TASK_INDEX');
  });

  it('no context opens all requested entities (backwards compat)', async () => {
    const manager = mockManager();
    const result = await manager.openNodes(['MASTER_INDEX', 'BOINX_TASK_INDEX']);
    expect(result.entities).toHaveLength(2);
  });
});

describe('untagged entities — strict ownership', () => {
  it('entity without authored_by is NOT visible to j5 (must be explicitly tagged)', async () => {
    const entities: Entity[] = [
      { name: 'UNTAGGED', entityType: 'test', observations: ['no authorship tag'] },
      { name: 'J5_ENTITY', entityType: 'test', observations: ['authored_by:j5', 'some fact'] },
    ];
    const manager = mockManager(entities, []);
    const graph = await manager.readGraph(j5);
    const names = graph.entities.map(e => e.name);
    expect(names).toContain('J5_ENTITY');
    expect(names).not.toContain('UNTAGGED');
  });

  it('entity without authored_by is NOT visible to boinx', async () => {
    const entities: Entity[] = [
      { name: 'UNTAGGED', entityType: 'test', observations: ['no authorship tag'] },
    ];
    const manager = mockManager(entities, []);
    const graph = await manager.readGraph(boinx);
    expect(graph.entities).toHaveLength(0);
  });

  it('entity without authored_by IS visible with no agentContext (programmatic use)', async () => {
    const entities: Entity[] = [
      { name: 'UNTAGGED', entityType: 'test', observations: ['no authorship tag'] },
    ];
    const manager = mockManager(entities, []);
    const graph = await manager.readGraph();
    expect(graph.entities).toHaveLength(1);
  });
});

describe('deleteEntities with tenant isolation', () => {
  it('j5 can delete j5 entities', async () => {
    const entities = allEntities.map(e => ({ ...e, observations: [...e.observations] }));
    const manager = mockManager(entities, [...allRelations]);
    await manager.deleteEntities(['AUTH_BUG_001'], j5);
    const graph = await manager.readGraph(j5);
    expect(graph.entities.map(e => e.name)).not.toContain('AUTH_BUG_001');
  });

  it('boinx CANNOT delete j5 entities', async () => {
    const entities = allEntities.map(e => ({ ...e, observations: [...e.observations] }));
    const manager = mockManager(entities, [...allRelations]);
    await manager.deleteEntities(['MASTER_INDEX'], boinx);
    const graph = await manager.readGraph(j5);
    expect(graph.entities.map(e => e.name)).toContain('MASTER_INDEX');
  });

  it('boinx can delete boinx entities', async () => {
    const entities = allEntities.map(e => ({ ...e, observations: [...e.observations] }));
    const manager = mockManager(entities, [...allRelations]);
    await manager.deleteEntities(['BOINX_DIGEST_ANALYSIS'], boinx);
    const graph = await manager.readGraph(boinx);
    expect(graph.entities.map(e => e.name)).not.toContain('BOINX_DIGEST_ANALYSIS');
  });

  it('deleteEntities without agentContext still works (backwards compat)', async () => {
    const entities = allEntities.map(e => ({ ...e, observations: [...e.observations] }));
    const manager = mockManager(entities, [...allRelations]);
    await manager.deleteEntities(['AUTH_BUG_001']);
    const graph = await manager.readGraph();
    expect(graph.entities.map(e => e.name)).not.toContain('AUTH_BUG_001');
  });
});

describe('deleteObservations with tenant isolation', () => {
  it('boinx CANNOT delete observations from j5 entities', async () => {
    const entities = allEntities.map(e => ({ ...e, observations: [...e.observations] }));
    const manager = mockManager(entities, [...allRelations]);
    await manager.deleteObservations(
      [{ entityName: 'AUTH_BUG_001', observations: ['status:active'] }],
      boinx
    );
    const graph = await manager.readGraph(j5);
    const bug = graph.entities.find(e => e.name === 'AUTH_BUG_001');
    expect(bug?.observations).toContain('status:active');
  });
});

describe('deleteRelations with tenant isolation', () => {
  it('boinx CANNOT delete relations involving j5 entities', async () => {
    const entities = allEntities.map(e => ({ ...e, observations: [...e.observations] }));
    const manager = mockManager(entities, [...allRelations]);
    await manager.deleteRelations(
      [{ from: 'AUTH_SERVICE', to: 'MASTER_INDEX', relationType: 'indexed_in' }],
      boinx
    );
    const graph = await manager.readGraph(j5);
    expect(graph.relations).toContainEqual({ from: 'AUTH_SERVICE', to: 'MASTER_INDEX', relationType: 'indexed_in' });
  });

  it('boinx can delete boinx relations', async () => {
    const entities = allEntities.map(e => ({ ...e, observations: [...e.observations] }));
    const manager = mockManager(entities, [...allRelations]);
    await manager.deleteRelations(
      [{ from: 'BOINX_DIGEST_ANALYSIS', to: 'BOINX_TASK_INDEX', relationType: 'indexed_in' }],
      boinx
    );
    const graph = await manager.readGraph(boinx);
    expect(graph.relations).not.toContainEqual(
      expect.objectContaining({ from: 'BOINX_DIGEST_ANALYSIS' })
    );
  });
});
