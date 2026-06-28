import { AgentContext } from '../types/graph.js';
import { createTestManager } from './helpers/test-db.js';

const j5: AgentContext = { agentId: 'j5' };
const boinx: AgentContext = { agentId: 'boinx' };

describe('entity_history', () => {
  it('returns full mutation timeline including superseded observations', async () => {
    const { manager, storage } = createTestManager();
    await manager.createEntities([
      { name: 'HIST_ENTITY', entityType: 'test', observations: ['fact one', 'fact two'] }
    ], j5);

    // Delete an observation (soft delete)
    await manager.deleteObservations([
      { entityName: 'HIST_ENTITY', observations: ['fact one'] }
    ], j5);

    const history = await manager.entityHistory('HIST_ENTITY');
    const contents = history.map(h => h.content);
    expect(contents).toContain('fact one');
    expect(contents).toContain('fact two');

    // fact one should be superseded
    const deleted = history.find(h => h.content === 'fact one');
    expect(deleted!.superseded_at).not.toBeNull();
    expect(deleted!.superseded_by).toBe('j5');

    // fact two should still be live
    const live = history.find(h => h.content === 'fact two');
    expect(live!.superseded_at).toBeNull();
  });

  it('returns empty array for non-existent entity', async () => {
    const { manager } = createTestManager();
    const history = await manager.entityHistory('DOES_NOT_EXIST');
    expect(history).toEqual([]);
  });
});

describe('supersede', () => {
  it('creates replacement observation with version chain', async () => {
    const { manager, storage } = createTestManager();
    await manager.createEntities([
      { name: 'SUPER_ENTITY', entityType: 'test', observations: ['original fact'] }
    ], j5);

    // Find the observation ID
    const entity = storage.getEntityByName('SUPER_ENTITY')!;
    const obs = storage.getLiveObservations(entity.id);
    const originalId = obs.find(o => o.content === 'original fact')!.id;

    // Supersede it
    const newId = await manager.supersedeObservation(
      originalId, 'updated fact', 'correcting inaccuracy', j5
    );

    // Original should be superseded
    const original = storage.getObservationById(originalId)!;
    expect(original.superseded_at).not.toBeNull();
    expect(original.superseded_by).toBe('j5');
    expect(original.supersede_rationale).toBe('correcting inaccuracy');

    // New observation should link back
    const replacement = storage.getObservationById(newId)!;
    expect(replacement.content).toBe('updated fact');
    expect(replacement.version).toBe(2);
    expect(replacement.previous_version_id).toBe(originalId);

    // Live view should show only the new content
    const live = await manager.openNodes(['SUPER_ENTITY'], j5);
    expect(live.entities[0].observations).toContain('updated fact');
    expect(live.entities[0].observations).not.toContain('original fact');

    // History should show both
    const history = await manager.entityHistory('SUPER_ENTITY');
    const contents = history.map(h => h.content);
    expect(contents).toContain('original fact');
    expect(contents).toContain('updated fact');
  });

  it('rejects superseding an already-superseded observation', async () => {
    const { manager, storage } = createTestManager();
    await manager.createEntities([
      { name: 'DOUBLE_SUPER', entityType: 'test', observations: ['will be superseded'] }
    ], j5);

    const entity = storage.getEntityByName('DOUBLE_SUPER')!;
    const obs = storage.getLiveObservations(entity.id);
    const id = obs.find(o => o.content === 'will be superseded')!.id;

    await manager.supersedeObservation(id, 'v2', 'first change', j5);
    await expect(
      manager.supersedeObservation(id, 'v3', 'second change', j5)
    ).rejects.toThrow('already superseded');
  });
});

describe('comments', () => {
  it('adds and retrieves comments on an observation', async () => {
    const { manager, storage } = createTestManager();
    await manager.createEntities([
      { name: 'COMMENTED', entityType: 'test', observations: ['a fact'] }
    ], j5);

    const entity = storage.getEntityByName('COMMENTED')!;
    const obs = storage.getLiveObservations(entity.id);
    const obsId = obs.find(o => o.content === 'a fact')!.id;

    // Add comments
    await manager.addComment(obsId, 'This seems outdated', boinx);
    await manager.addComment(obsId, 'Agreed, needs review', j5);

    // Retrieve
    const comments = await manager.getObservationComments(obsId);
    expect(comments).toHaveLength(2);
    expect(comments[0].content).toBe('This seems outdated');
    expect(comments[0].authored_by).toBe('boinx');
    expect(comments[1].content).toBe('Agreed, needs review');
    expect(comments[1].authored_by).toBe('j5');
  });

  it('returns empty array for observation with no comments', async () => {
    const { manager, storage } = createTestManager();
    await manager.createEntities([
      { name: 'NO_COMMENTS', entityType: 'test', observations: ['lonely fact'] }
    ], j5);

    const entity = storage.getEntityByName('NO_COMMENTS')!;
    const obs = storage.getLiveObservations(entity.id);
    const obsId = obs.find(o => o.content === 'lonely fact')!.id;

    const comments = await manager.getObservationComments(obsId);
    expect(comments).toEqual([]);
  });
});

describe('changes_to_mine', () => {
  it('shows observations I wrote that another agent changed', async () => {
    const { manager, storage } = createTestManager();
    await manager.createEntities([
      { name: 'SHARED_ENTITY', entityType: 'test', observations: ['j5 original'] }
    ], j5);

    const entity = storage.getEntityByName('SHARED_ENTITY')!;
    const obs = storage.getLiveObservations(entity.id);
    const obsId = obs.find(o => o.content === 'j5 original')!.id;

    // Boinx supersedes j5's observation
    await manager.supersedeObservation(obsId, 'boinx correction', 'was wrong', boinx);

    // J5 checks what changed
    const changes = await manager.changesToMine('j5');
    expect(changes.length).toBeGreaterThanOrEqual(1);
    const change = changes.find((c: any) => c.original_content === 'j5 original');
    expect(change).toBeDefined();
    expect(change!.replaced_with).toBe('boinx correction');
    expect(change!.changed_by).toBe('boinx');
    expect(change!.rationale).toBe('was wrong');
  });

  it('returns empty array when nothing was changed', async () => {
    const { manager } = createTestManager();
    await manager.createEntities([
      { name: 'UNTOUCHED', entityType: 'test', observations: ['pristine'] }
    ], j5);

    const changes = await manager.changesToMine('j5');
    expect(changes).toEqual([]);
  });
});
