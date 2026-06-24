import { jest } from '@jest/globals';
import { KnowledgeGraphManager } from '../graph/knowledge-graph-manager.js';
import { StorageService } from '../persistence/storage.js';
import { AgentContext } from '../types/graph.js';

function mockManager(entities: any[] = [], relations: any[] = []) {
  let savedGraph: any = null;
  const storage = {
    loadGraph: () => Promise.resolve({
      entities: entities.map(e => ({ ...e, observations: [...e.observations] })),
      relations: [...relations],
    }),
    saveGraph: (graph: any) => { savedGraph = graph; return Promise.resolve(); },
  } as unknown as StorageService;
  const manager = new KnowledgeGraphManager(storage);
  return { manager, getSaved: () => savedGraph };
}

const boinxContext: AgentContext = { agentId: 'boinx' };
const j5Context: AgentContext = { agentId: 'j5' };

describe('createEntities with AgentContext', () => {
  it('injects authored_by observation when agentContext provided', async () => {
    const { manager, getSaved } = mockManager();
    await manager.createEntities([
      { name: 'TEST_ENTITY', entityType: 'test', observations: ['some fact'] }
    ], boinxContext);

    const saved = getSaved();
    const entity = saved.entities.find((e: any) => e.name === 'TEST_ENTITY');
    expect(entity.observations).toContainEqual('authored_by:boinx');
  });

  it('injects authored_at observation with ISO timestamp', async () => {
    const { manager, getSaved } = mockManager();
    await manager.createEntities([
      { name: 'TEST_ENTITY', entityType: 'test', observations: ['some fact'] }
    ], boinxContext);

    const saved = getSaved();
    const entity = saved.entities.find((e: any) => e.name === 'TEST_ENTITY');
    expect(entity.observations).toContainEqual(expect.stringMatching(/^authored_at:\d{4}-\d{2}-\d{2}T/));
  });

  it('does not inject when agentContext is undefined (backwards compat)', async () => {
    const { manager, getSaved } = mockManager();
    await manager.createEntities([
      { name: 'TEST_ENTITY', entityType: 'test', observations: ['some fact'] }
    ]);

    const saved = getSaved();
    const entity = saved.entities.find((e: any) => e.name === 'TEST_ENTITY');
    expect(entity.observations).not.toContainEqual(expect.stringMatching(/^authored_by:/));
    expect(entity.observations).not.toContainEqual(expect.stringMatching(/^authored_at:/));
  });

  it('does not duplicate authored_by if already present in observations', async () => {
    const { manager, getSaved } = mockManager();
    await manager.createEntities([
      { name: 'TEST_ENTITY', entityType: 'test', observations: ['authored_by:boinx', 'some fact'] }
    ], boinxContext);

    const saved = getSaved();
    const entity = saved.entities.find((e: any) => e.name === 'TEST_ENTITY');
    const authoredByCount = entity.observations.filter((o: string) => o.startsWith('authored_by:')).length;
    expect(authoredByCount).toBe(1);
  });
});

describe('addObservations with AgentContext', () => {
  it('injects authored_at on new observations', async () => {
    const existing = [
      { name: 'EXISTING_ENTITY', entityType: 'test', observations: ['authored_by:boinx', 'old fact'] }
    ];
    const { manager, getSaved } = mockManager(existing);
    await manager.addObservations([
      { entityName: 'EXISTING_ENTITY', contents: ['new fact'] }
    ], boinxContext);

    const saved = getSaved();
    const entity = saved.entities.find((e: any) => e.name === 'EXISTING_ENTITY');
    expect(entity.observations).toContainEqual(expect.stringMatching(/^authored_at:/));
  });

  it('does not duplicate authored_by if entity already has it', async () => {
    const existing = [
      { name: 'EXISTING_ENTITY', entityType: 'test', observations: ['authored_by:boinx', 'old fact'] }
    ];
    const { manager, getSaved } = mockManager(existing);
    await manager.addObservations([
      { entityName: 'EXISTING_ENTITY', contents: ['new fact'] }
    ], boinxContext);

    const saved = getSaved();
    const entity = saved.entities.find((e: any) => e.name === 'EXISTING_ENTITY');
    const authoredByCount = entity.observations.filter((o: string) => o === 'authored_by:boinx').length;
    expect(authoredByCount).toBe(1);
  });

  it('does not inject when agentContext is undefined', async () => {
    const existing = [
      { name: 'EXISTING_ENTITY', entityType: 'test', observations: ['old fact'] }
    ];
    const { manager, getSaved } = mockManager(existing);
    await manager.addObservations([
      { entityName: 'EXISTING_ENTITY', contents: ['new fact'] }
    ]);

    const saved = getSaved();
    const entity = saved.entities.find((e: any) => e.name === 'EXISTING_ENTITY');
    expect(entity.observations).not.toContainEqual(expect.stringMatching(/^authored_by:/));
    expect(entity.observations).not.toContainEqual(expect.stringMatching(/^authored_at:/));
  });
});

describe('createRelations with AgentContext', () => {
  let consoleSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('logs agent identity to stderr for audit trail', async () => {
    const existing = [
      { name: 'A', entityType: 'test', observations: ['authored_by:boinx'] },
      { name: 'B', entityType: 'test', observations: ['authored_by:boinx'] },
    ];
    const { manager } = mockManager(existing);
    await manager.createRelations([
      { from: 'A', to: 'B', relationType: 'depends_on' }
    ], boinxContext);

    const calls = consoleSpy.mock.calls;
    const auditCall = calls.find((args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('[AUDIT]'));
    expect(auditCall).toBeDefined();
    expect(auditCall![0]).toContain('boinx');
  });

  it('does not log audit when agentContext is undefined', async () => {
    const existing = [
      { name: 'A2', entityType: 'test', observations: [] },
      { name: 'B2', entityType: 'test', observations: [] },
    ];
    const { manager } = mockManager(existing);
    await manager.createRelations([
      { from: 'A2', to: 'B2', relationType: 'depends_on' }
    ]);

    const calls = consoleSpy.mock.calls;
    const auditCall = calls.find((args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('[AUDIT]'));
    expect(auditCall).toBeUndefined();
  });
});
