import { AgentContext } from '../types/graph.js';
import { createTestManager } from './helpers/test-db.js';

const brickAlice: AgentContext = { agentId: 'brick', userId: 'alice@example.com' };
const brickBob: AgentContext = { agentId: 'brick', userId: 'bob@example.com' };
const brickNoUser: AgentContext = { agentId: 'brick' };

describe('User isolation — write provenance', () => {
  it('injects user_id observation when userId is present', async () => {
    const { manager } = createTestManager();
    const created = await manager.createEntities([
      { name: 'MY_PHOTO', entityType: 'test', observations: ['a photo'] }
    ], brickAlice);

    const entity = created[0];
    expect(entity.observations).toContain('user_id:alice@example.com');
    expect(entity.observations).toContain('authored_by:brick');
  });

  it('does not inject user_id when userId is absent', async () => {
    const { manager } = createTestManager();
    const created = await manager.createEntities([
      { name: 'SHARED_NOTE', entityType: 'test', observations: ['shared fact'] }
    ], brickNoUser);

    const entity = created[0];
    expect(entity.observations).toContain('authored_by:brick');
    expect(entity.observations).not.toContainEqual(expect.stringMatching(/^user_id:/));
  });

  it('injects user_id on addObservations', async () => {
    const { manager } = createTestManager();
    await manager.createEntities([
      { name: 'ENTITY', entityType: 'test', observations: ['base'] }
    ], brickNoUser);

    const results = await manager.addObservations([
      { entityName: 'ENTITY', contents: ['new fact'] }
    ], brickAlice);

    expect(results[0].addedObservations).toContain('user_id:alice@example.com');
  });
});

describe('User isolation — read filtering', () => {
  it('user sees their own entities + shared agent entities (no user_id tag)', async () => {
    const { manager } = createTestManager();

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
  });

  it('user isolation applies to search', async () => {
    const { manager } = createTestManager();
    await manager.createEntities([
      { name: 'ALICE_NOTE', entityType: 'test', observations: ['alice secret data'] }
    ], brickAlice);
    await manager.createEntities([
      { name: 'BOB_NOTE', entityType: 'test', observations: ['bob secret data'] }
    ], brickBob);

    const aliceSearch = await manager.searchNodes('secret', brickAlice);
    const aliceNames = aliceSearch.tiers.flatMap(t => t.entities).map(e => e.name);
    expect(aliceNames).toContain('ALICE_NOTE');
    expect(aliceNames).not.toContain('BOB_NOTE');
  });

  it('user isolation applies to openNodes', async () => {
    const { manager } = createTestManager();
    await manager.createEntities([
      { name: 'ALICE_DATA', entityType: 'test', observations: ['private'] }
    ], brickAlice);
    await manager.createEntities([
      { name: 'BOB_DATA', entityType: 'test', observations: ['private'] }
    ], brickBob);

    const aliceOpen = await manager.openNodes(['ALICE_DATA', 'BOB_DATA'], brickAlice);
    expect(aliceOpen.entities.map(e => e.name)).toContain('ALICE_DATA');
    expect(aliceOpen.entities.map(e => e.name)).not.toContain('BOB_DATA');
  });
});
