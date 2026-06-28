import { AgentContext } from '../types/graph.js';
import { createTestManager } from './helpers/test-db.js';

describe('write serialization', () => {
  it('concurrent creates do not lose data', async () => {
    const { manager } = createTestManager();
    const ctx: AgentContext = { agentId: 'j5' };

    // Fire 10 concurrent creates — SQLite WAL serializes them
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        manager.createEntities(
          [{ name: `ENTITY_${i}`, entityType: 'test', observations: [`item ${i}`] }],
          ctx
        )
      )
    );

    // All 10 must be present — no lost writes
    const graph = await manager.readGraph(ctx);
    expect(graph.entities).toHaveLength(10);
    const names = graph.entities.map(e => e.name).sort();
    expect(names).toEqual(Array.from({ length: 10 }, (_, i) => `ENTITY_${i}`).sort());
  });
});

describe('soft delete preserves history', () => {
  it('deleted observations are gone from live view but preserved in history', async () => {
    const { manager } = createTestManager();
    const ctx: AgentContext = { agentId: 'j5' };

    await manager.createEntities([
      { name: 'HIST_ENTITY', entityType: 'test', observations: ['fact one', 'fact two'] }
    ], ctx);

    // Delete one observation
    await manager.deleteObservations([
      { entityName: 'HIST_ENTITY', observations: ['fact one'] }
    ], ctx);

    // Live view should not contain deleted observation
    const live = await manager.openNodes(['HIST_ENTITY'], ctx);
    expect(live.entities[0].observations).not.toContain('fact one');
    expect(live.entities[0].observations).toContain('fact two');

    // History should contain both (including superseded)
    const history = await manager.entityHistory('HIST_ENTITY');
    const contents = history.map(h => h.content);
    expect(contents).toContain('fact one');
    expect(contents).toContain('fact two');

    // The deleted one should have superseded_at set
    const deleted = history.find(h => h.content === 'fact one');
    expect(deleted!.superseded_at).not.toBeNull();
  });

  it('deleted entity is invisible but history remains', async () => {
    const { manager } = createTestManager();
    const ctx: AgentContext = { agentId: 'j5' };

    await manager.createEntities([
      { name: 'TO_DELETE', entityType: 'test', observations: ['will be deleted'] }
    ], ctx);

    await manager.deleteEntities(['TO_DELETE'], ctx);

    // Should not appear in readGraph
    const graph = await manager.readGraph(ctx);
    expect(graph.entities.map(e => e.name)).not.toContain('TO_DELETE');

    // But history should still work
    const history = await manager.entityHistory('TO_DELETE');
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].superseded_at).not.toBeNull();
  });
});
