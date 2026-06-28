import { jest } from '@jest/globals';
import { AgentContext } from '../types/graph.js';
import { createTestManager } from './helpers/test-db.js';

const j5: AgentContext = { agentId: 'j5' };
const boinx: AgentContext = { agentId: 'boinx' };

function seedGraph() {
  const { manager, storage } = createTestManager();

  // Seed j5 entities
  manager.createEntities([
    { name: 'MASTER_INDEX', entityType: 'knowledge_index', observations: ['canonical_type:Knowledge', 'canonical_name:Master Index', 'summary: Top-level nav hub'] },
    { name: 'AUTH_SERVICE', entityType: 'service', observations: ['canonical_type:Service', 'handles auth tokens'] },
    { name: 'AUTH_BUG_001', entityType: 'bug', observations: ['canonical_type:Bug', 'status:active', 'token expiry race condition'] },
  ], j5);

  // Seed boinx entities
  manager.createEntities([
    { name: 'BOINX_TASK_INDEX', entityType: 'knowledge_index', observations: ['canonical_type:Knowledge', 'canonical_name:Boinx Task Index', 'summary: Boinx task tracking'] },
    { name: 'BOINX_DIGEST_ANALYSIS', entityType: 'research', observations: ['task analysis from digest pipeline'] },
  ], boinx);

  // Seed relations
  manager.createRelations([
    { from: 'AUTH_SERVICE', to: 'MASTER_INDEX', relationType: 'indexed_in' },
    { from: 'AUTH_BUG_001', to: 'MASTER_INDEX', relationType: 'indexed_in' },
    { from: 'AUTH_BUG_001', to: 'AUTH_SERVICE', relationType: 'depends_on' },
    { from: 'BOINX_DIGEST_ANALYSIS', to: 'BOINX_TASK_INDEX', relationType: 'indexed_in' },
  ], j5); // j5 creates all relations for simplicity; boinx's are created by j5 here

  // Boinx creates its own relation for proper ownership
  // Actually re-seed: boinx creates its own
  return { manager, storage };
}

describe('readGraph with tenant isolation', () => {
  it('j5 sees only j5 entities', async () => {
    const { manager } = seedGraph();
    const graph = await manager.readGraph(j5);
    const names = graph.entities.map(e => e.name);
    expect(names).toContain('MASTER_INDEX');
    expect(names).toContain('AUTH_SERVICE');
    expect(names).toContain('AUTH_BUG_001');
    expect(names).not.toContain('BOINX_TASK_INDEX');
    expect(names).not.toContain('BOINX_DIGEST_ANALYSIS');
  });

  it('boinx sees only boinx entities', async () => {
    const { manager } = seedGraph();
    const graph = await manager.readGraph(boinx);
    const names = graph.entities.map(e => e.name);
    expect(names).toContain('BOINX_TASK_INDEX');
    expect(names).toContain('BOINX_DIGEST_ANALYSIS');
    expect(names).not.toContain('MASTER_INDEX');
    expect(names).not.toContain('AUTH_SERVICE');
  });

  it('no context returns all entities', async () => {
    const { manager } = seedGraph();
    const graph = await manager.readGraph();
    expect(graph.entities.length).toBeGreaterThanOrEqual(5);
  });
});

describe('readGraphSummary with tenant isolation', () => {
  it('j5 sees only j5 indices', async () => {
    const { manager } = seedGraph();
    const summary = await manager.readGraphSummary(j5);
    const indexNames = summary.indices.map(i => i.name);
    expect(indexNames).toContain('MASTER_INDEX');
    expect(indexNames).not.toContain('BOINX_TASK_INDEX');
  });

  it('boinx sees only boinx indices', async () => {
    const { manager } = seedGraph();
    const summary = await manager.readGraphSummary(boinx);
    const indexNames = summary.indices.map(i => i.name);
    expect(indexNames).toContain('BOINX_TASK_INDEX');
    expect(indexNames).not.toContain('MASTER_INDEX');
  });
});

describe('searchNodes with tenant isolation', () => {
  it('j5 search finds only j5 entities', async () => {
    const { manager } = seedGraph();
    const results = await manager.searchNodes('auth', j5);
    const names = results.tiers.flatMap(t => t.entities).map(e => e.name);
    expect(names).toContain('AUTH_SERVICE');
    expect(names).not.toContain('BOINX_DIGEST_ANALYSIS');
  });

  it('boinx search finds only boinx entities', async () => {
    const { manager } = seedGraph();
    const results = await manager.searchNodes('task', boinx);
    const names = results.tiers.flatMap(t => t.entities).map(e => e.name);
    expect(names).toContain('BOINX_TASK_INDEX');
    expect(names).not.toContain('MASTER_INDEX');
  });
});

describe('openNodes with tenant isolation', () => {
  it('j5 can open own entities', async () => {
    const { manager } = seedGraph();
    const result = await manager.openNodes(['AUTH_SERVICE'], j5);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('AUTH_SERVICE');
  });

  it('j5 cannot open boinx entities', async () => {
    const { manager } = seedGraph();
    const result = await manager.openNodes(['BOINX_DIGEST_ANALYSIS'], j5);
    expect(result.entities).toHaveLength(0);
  });
});

describe('deleteEntities with tenant isolation', () => {
  it('j5 can delete own entities (soft delete)', async () => {
    const { manager } = seedGraph();
    await manager.deleteEntities(['AUTH_BUG_001'], j5);
    const graph = await manager.readGraph(j5);
    const names = graph.entities.map(e => e.name);
    expect(names).not.toContain('AUTH_BUG_001');
  });

  it('j5 cannot delete boinx entities', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation();
    const { manager } = seedGraph();
    await manager.deleteEntities(['BOINX_DIGEST_ANALYSIS'], j5);
    const graph = await manager.readGraph(boinx);
    expect(graph.entities.map(e => e.name)).toContain('BOINX_DIGEST_ANALYSIS');
    spy.mockRestore();
  });
});

describe('deleteObservations with tenant isolation', () => {
  it('j5 can delete own observations (soft delete)', async () => {
    const { manager } = seedGraph();
    await manager.deleteObservations([
      { entityName: 'AUTH_SERVICE', observations: ['handles auth tokens'] }
    ], j5);
    const graph = await manager.openNodes(['AUTH_SERVICE'], j5);
    expect(graph.entities[0].observations).not.toContain('handles auth tokens');
  });

  it('j5 cannot delete boinx observations', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation();
    const { manager } = seedGraph();
    await manager.deleteObservations([
      { entityName: 'BOINX_DIGEST_ANALYSIS', observations: ['task analysis from digest pipeline'] }
    ], j5);
    const graph = await manager.openNodes(['BOINX_DIGEST_ANALYSIS'], boinx);
    expect(graph.entities[0].observations).toContain('task analysis from digest pipeline');
    spy.mockRestore();
  });
});

describe('deleteRelations with tenant isolation', () => {
  it('j5 can delete own relations (soft delete)', async () => {
    const { manager } = seedGraph();
    await manager.deleteRelations([
      { from: 'AUTH_BUG_001', to: 'AUTH_SERVICE', relationType: 'depends_on' }
    ], j5);
    const graph = await manager.readGraph(j5);
    const deps = graph.relations.filter(r => r.relationType === 'depends_on');
    expect(deps).toHaveLength(0);
  });
});
