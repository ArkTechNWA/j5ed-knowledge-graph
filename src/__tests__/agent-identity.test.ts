import { jest } from '@jest/globals';
import { AgentContext } from '../types/graph.js';
import { createTestManager } from './helpers/test-db.js';

const boinxContext: AgentContext = { agentId: 'boinx' };

describe('createEntities with AgentContext', () => {
  it('injects authored_by observation when agentContext provided', async () => {
    const { manager } = createTestManager();
    const created = await manager.createEntities([
      { name: 'TEST_ENTITY', entityType: 'test', observations: ['some fact'] }
    ], boinxContext);

    const entity = created[0];
    expect(entity.observations).toContainEqual('authored_by:boinx');
  });

  it('injects authored_at observation with ISO timestamp', async () => {
    const { manager } = createTestManager();
    const created = await manager.createEntities([
      { name: 'TEST_ENTITY', entityType: 'test', observations: ['some fact'] }
    ], boinxContext);

    const entity = created[0];
    expect(entity.observations).toContainEqual(expect.stringMatching(/^authored_at:\d{4}-\d{2}-\d{2}T/));
  });

  it('uses default agent when agentContext is undefined', async () => {
    const { manager } = createTestManager();
    const created = await manager.createEntities([
      { name: 'TEST_ENTITY', entityType: 'test', observations: ['some fact'] }
    ]);

    // SQLite always has provenance — defaults to config.defaultAgentId
    const entity = created[0];
    expect(entity.observations).toContainEqual(expect.stringMatching(/^authored_by:/));
    expect(entity.observations).toContainEqual(expect.stringMatching(/^authored_at:/));
  });

  it('does not duplicate authored_by if already present in observations', async () => {
    const { manager } = createTestManager();
    const created = await manager.createEntities([
      { name: 'TEST_ENTITY', entityType: 'test', observations: ['authored_by:boinx', 'some fact'] }
    ], boinxContext);

    const entity = created[0];
    const authoredByCount = entity.observations.filter((o: string) => o.startsWith('authored_by:')).length;
    expect(authoredByCount).toBe(1);
  });
});

describe('addObservations with AgentContext', () => {
  it('injects authored_at on new observations', async () => {
    const { manager } = createTestManager();
    await manager.createEntities([
      { name: 'EXISTING_ENTITY', entityType: 'test', observations: ['old fact'] }
    ], boinxContext);

    const results = await manager.addObservations([
      { entityName: 'EXISTING_ENTITY', contents: ['new fact'] }
    ], boinxContext);

    expect(results[0].addedObservations).toContainEqual(expect.stringMatching(/^authored_at:/));
  });

  it('does not duplicate authored_by on addObservations', async () => {
    const { manager } = createTestManager();
    await manager.createEntities([
      { name: 'EXISTING_ENTITY', entityType: 'test', observations: ['old fact'] }
    ], boinxContext);

    const results = await manager.addObservations([
      { entityName: 'EXISTING_ENTITY', contents: ['new fact'] }
    ], boinxContext);

    const authoredByCount = results[0].addedObservations.filter(
      (o: string) => o.startsWith('authored_by:')
    ).length;
    expect(authoredByCount).toBe(1);
  });
});

describe('createRelations audit trail', () => {
  it('logs audit event when creating relations with agentContext', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation();
    const { manager } = createTestManager();

    await manager.createEntities([
      { name: 'A', entityType: 'test', observations: ['fact a'] },
      { name: 'B', entityType: 'test', observations: ['fact b'] },
    ], boinxContext);

    await manager.createRelations([
      { from: 'A', to: 'B', relationType: 'depends_on' }
    ], boinxContext);

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('[AUDIT]'),
      expect.stringContaining('A → depends_on → B')
    );
    spy.mockRestore();
  });
});
