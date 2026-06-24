import { KnowledgeGraphManager } from '../graph/knowledge-graph-manager.js';
import { StorageService } from '../persistence/storage.js';
import { AgentContext, Entity, Relation } from '../types/graph.js';

/**
 * Integration test: verifies full tenant isolation lifecycle.
 * Two agents write to the same graph — reads are isolated.
 * Uses a stateful mock that persists across operations.
 */

function mockManagerWithState() {
  let graphState: { entities: Entity[]; relations: Relation[] } = { entities: [], relations: [] };
  const storage = {
    loadGraph: () => Promise.resolve({
      entities: graphState.entities.map(e => ({ ...e, observations: [...e.observations] })),
      relations: [...graphState.relations],
    }),
    saveGraph: (graph: any) => { graphState = graph; return Promise.resolve(); },
  } as unknown as StorageService;
  const manager = new KnowledgeGraphManager(storage);
  return { manager, getState: () => graphState };
}

const j5: AgentContext = { agentId: 'j5' };
const boinx: AgentContext = { agentId: 'boinx' };

describe('Multi-agent isolation round-trip', () => {
  it('full lifecycle: write, read, search — agents are isolated', async () => {
    const { manager } = mockManagerWithState();

    // J5 creates entities
    await manager.createEntities([
      { name: 'J5_INDEX', entityType: 'knowledge_index', observations: ['canonical_type:Knowledge', 'summary: J5 nav hub'] },
      { name: 'J5_AUTH_SERVICE', entityType: 'service', observations: ['canonical_type:Service', 'handles auth'] },
    ], j5);

    // J5 creates relations
    await manager.createRelations([
      { from: 'J5_AUTH_SERVICE', to: 'J5_INDEX', relationType: 'indexed_in' },
    ], j5);

    // Boinx creates entities
    await manager.createEntities([
      { name: 'BOINX_INDEX', entityType: 'knowledge_index', observations: ['canonical_type:Knowledge', 'summary: Boinx nav hub'] },
      { name: 'BOINX_ANALYSIS', entityType: 'research', observations: ['digest analysis results'] },
    ], boinx);

    // Boinx creates relations
    await manager.createRelations([
      { from: 'BOINX_ANALYSIS', to: 'BOINX_INDEX', relationType: 'indexed_in' },
    ], boinx);

    // J5 reads — sees only J5 data
    const j5Graph = await manager.readGraph(j5);
    expect(j5Graph.entities.map(e => e.name).sort()).toEqual(['J5_AUTH_SERVICE', 'J5_INDEX']);
    expect(j5Graph.relations).toHaveLength(1);
    expect(j5Graph.relations[0].from).toBe('J5_AUTH_SERVICE');

    // Boinx reads — sees only Boinx data
    const boinxGraph = await manager.readGraph(boinx);
    expect(boinxGraph.entities.map(e => e.name).sort()).toEqual(['BOINX_ANALYSIS', 'BOINX_INDEX']);
    expect(boinxGraph.relations).toHaveLength(1);
    expect(boinxGraph.relations[0].from).toBe('BOINX_ANALYSIS');

    // J5 search — only J5 results
    const j5Search = await manager.searchNodes('auth', j5);
    const j5Names = j5Search.tiers.flatMap(t => t.entities).map(e => e.name);
    expect(j5Names).toContain('J5_AUTH_SERVICE');
    expect(j5Names).not.toContain('BOINX_ANALYSIS');

    // Boinx search — only Boinx results
    const boinxSearch = await manager.searchNodes('analysis', boinx);
    const boinxNames = boinxSearch.tiers.flatMap(t => t.entities).map(e => e.name);
    expect(boinxNames).toContain('BOINX_ANALYSIS');
    expect(boinxNames).not.toContain('J5_AUTH_SERVICE');

    // J5 summary — only J5 indices
    const j5Summary = await manager.readGraphSummary(j5);
    expect(j5Summary.indices.map(i => i.name)).toEqual(['J5_INDEX']);
    expect(j5Summary.counts.total_entities).toBe(2);

    // Boinx summary — only Boinx indices
    const boinxSummary = await manager.readGraphSummary(boinx);
    expect(boinxSummary.indices.map(i => i.name)).toEqual(['BOINX_INDEX']);
    expect(boinxSummary.counts.total_entities).toBe(2);

    // J5 open_nodes — cannot see Boinx entities
    const j5Open = await manager.openNodes(['BOINX_INDEX'], j5);
    expect(j5Open.entities).toHaveLength(0);

    // Boinx open_nodes — cannot see J5 entities
    const boinxOpen = await manager.openNodes(['J5_INDEX'], boinx);
    expect(boinxOpen.entities).toHaveLength(0);
  });

  it('addObservations respects tenant — only works on owned entities', async () => {
    const { manager } = mockManagerWithState();

    // J5 creates an entity
    await manager.createEntities([
      { name: 'J5_NOTE', entityType: 'test', observations: ['original'] }
    ], j5);

    // J5 can add observations to its own entity
    const result = await manager.addObservations([
      { entityName: 'J5_NOTE', contents: ['new fact from j5'] }
    ], j5);
    expect(result[0].addedObservations).toContain('new fact from j5');

    // Verify J5 sees the updated entity
    const j5Graph = await manager.readGraph(j5);
    const note = j5Graph.entities.find(e => e.name === 'J5_NOTE');
    expect(note!.observations).toContain('new fact from j5');
  });
});
