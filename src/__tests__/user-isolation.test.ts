import { KnowledgeGraphManager } from '../graph/knowledge-graph-manager.js';
import { StorageService } from '../persistence/storage.js';
import { AgentContext, Entity, Relation } from '../types/graph.js';

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

const brickAlice: AgentContext = { agentId: 'brick', userId: 'alice@example.com' };
const brickBob: AgentContext = { agentId: 'brick', userId: 'bob@example.com' };
const brickNoUser: AgentContext = { agentId: 'brick' };

describe('User isolation — write provenance', () => {
  it('injects user_id observation when userId is present', async () => {
    const { manager, getState } = mockManagerWithState();
    await manager.createEntities([
      { name: 'MY_PHOTO', entityType: 'test', observations: ['a photo'] }
    ], brickAlice);

    const entity = getState().entities[0];
    expect(entity.observations).toContain('user_id:alice@example.com');
    expect(entity.observations).toContain('authored_by:brick');
  });

  it('does not inject user_id when userId is absent', async () => {
    const { manager, getState } = mockManagerWithState();
    await manager.createEntities([
      { name: 'SHARED_NOTE', entityType: 'test', observations: ['shared fact'] }
    ], brickNoUser);

    const entity = getState().entities[0];
    expect(entity.observations).toContain('authored_by:brick');
    expect(entity.observations).not.toContainEqual(expect.stringMatching(/^user_id:/));
  });

  it('injects user_id on addObservations', async () => {
    const { manager, getState } = mockManagerWithState();
    await manager.createEntities([
      { name: 'ENTITY', entityType: 'test', observations: ['authored_by:brick', 'base'] }
    ], brickNoUser);

    await manager.addObservations([
      { entityName: 'ENTITY', contents: ['new fact'] }
    ], brickAlice);

    const entity = getState().entities[0];
    expect(entity.observations).toContain('user_id:alice@example.com');
  });
});

describe('User isolation — read filtering', () => {
  it('user sees their own entities + shared agent entities (no user_id tag)', async () => {
    const { manager } = mockManagerWithState();

    // Shared agent entity (no userId)
    await manager.createEntities([
      { name: 'BRICK_SHARED', entityType: 'test', observations: ['shared knowledge'] }
    ], brickNoUser);

    // Alice's private entity
    await manager.createEntities([
      { name: 'ALICE_PHOTO', entityType: 'test', observations: ['my photo'] }
    ], brickAlice);

    // Bob's private entity
    await manager.createEntities([
      { name: 'BOB_PHOTO', entityType: 'test', observations: ['her photo'] }
    ], brickBob);

    // Alice sees shared + own, not Bob's
    const aliceGraph = await manager.readGraph(brickAlice);
    const aliceNames = aliceGraph.entities.map(e => e.name);
    expect(aliceNames).toContain('BRICK_SHARED');
    expect(aliceNames).toContain('ALICE_PHOTO');
    expect(aliceNames).not.toContain('BOB_PHOTO');

    // Bob sees shared + own, not Alice's
    const bobGraph = await manager.readGraph(brickBob);
    const bobNames = bobGraph.entities.map(e => e.name);
    expect(bobNames).toContain('BRICK_SHARED');
    expect(bobNames).toContain('BOB_PHOTO');
    expect(bobNames).not.toContain('ALICE_PHOTO');

    // Agent-only context (no userId) sees all brick entities
    const agentGraph = await manager.readGraph(brickNoUser);
    const agentNames = agentGraph.entities.map(e => e.name);
    expect(agentNames).toContain('BRICK_SHARED');
    expect(agentNames).toContain('ALICE_PHOTO');
    expect(agentNames).toContain('BOB_PHOTO');
  });

  it('searchNodes respects user isolation', async () => {
    const { manager } = mockManagerWithState();

    await manager.createEntities([
      { name: 'SHARED_CONFIG', entityType: 'test', observations: ['authored_by:brick', 'camera settings'] }
    ], brickNoUser);
    await manager.createEntities([
      { name: 'ALICE_DRAFT', entityType: 'test', observations: ['draft render'] }
    ], brickAlice);
    await manager.createEntities([
      { name: 'BOB_DRAFT', entityType: 'test', observations: ['draft render'] }
    ], brickBob);

    // Alice searches 'draft' — sees own + shared, not Bob's
    const result = await manager.searchNodes('draft', brickAlice);
    const names = result.tiers.flatMap(t => t.entities).map(e => e.name);
    expect(names).toContain('ALICE_DRAFT');
    expect(names).not.toContain('BOB_DRAFT');
  });

  it('openNodes respects user isolation', async () => {
    const { manager } = mockManagerWithState();

    await manager.createEntities([
      { name: 'BOB_SECRET', entityType: 'test', observations: ['private'] }
    ], brickBob);

    // Alice can't open Bob's entity
    const result = await manager.openNodes(['BOB_SECRET'], brickAlice);
    expect(result.entities).toHaveLength(0);

    // Bob can
    const result2 = await manager.openNodes(['BOB_SECRET'], brickBob);
    expect(result2.entities).toHaveLength(1);
  });
});
