import { EntityStub, IndexStub, SearchTier } from '../types/graph.js';
import { createTestManager } from './helpers/test-db.js';
import { AgentContext } from '../types/graph.js';

const ctx: AgentContext = { agentId: 'j5' };

describe('EntityStub type', () => {
  it('has required fields', () => {
    const stub: EntityStub = {
      name: 'AUTH_SERVICE',
      type: 'component',
      matchedIn: ['name'],
    };
    expect(stub.name).toBe('AUTH_SERVICE');
    expect(stub.type).toBe('component');
    expect(stub.matchedIn).toEqual(['name']);
    expect(stub.snippet).toBeUndefined();
  });

  it('accepts optional snippet', () => {
    const stub: EntityStub = {
      name: 'SOME_ENTITY',
      type: 'component',
      matchedIn: ['observation'],
      snippet: 'auth token exchange happens here...',
    };
    expect(stub.snippet).toBeDefined();
  });
});

describe('SearchTier type', () => {
  it('uses EntityStub[] for entities and has no relations field', () => {
    const tier: SearchTier = {
      matchCount: 1,
      label: 'matches 1 token',
      total: 5,
      capped: false,
      entities: [{ name: 'FOO', type: 'component', matchedIn: ['name'] }],
    };
    expect(tier.entities[0].name).toBe('FOO');
    // @ts-expect-error relations should not exist on SearchTier
    expect(tier.relations).toBeUndefined();
  });
});

describe('buildStub()', () => {
  it('sets matchedIn name when token matches entity name', async () => {
    const { manager } = createTestManager();
    await manager.createEntities([
      { name: 'AUTH_SERVICE', entityType: 'component', observations: ['handles tokens'] }
    ], ctx);

    const result = await manager.searchNodes('auth', ctx);
    const stub = result.tiers.flatMap(t => t.entities).find(e => e.name === 'AUTH_SERVICE');
    expect(stub).toBeDefined();
    expect(stub!.matchedIn).toContain('name');
    expect(stub!.snippet).toBeUndefined();
  });

  it('sets matchedIn type when token matches entityType only', async () => {
    const { manager } = createTestManager();
    await manager.createEntities([
      { name: 'SOMETHING', entityType: 'authentication_protocol', observations: ['a thing'] }
    ], ctx);

    const result = await manager.searchNodes('auth', ctx);
    const stub = result.tiers.flatMap(t => t.entities).find(e => e.name === 'SOMETHING');
    expect(stub).toBeDefined();
    expect(stub!.matchedIn).toContain('type');
  });

  it('provides snippet when token matches observation only', async () => {
    const { manager } = createTestManager();
    await manager.createEntities([
      { name: 'TASK_MANAGER', entityType: 'component', observations: ['Unrelated note', 'auth token validation happens here'] }
    ], ctx);

    const result = await manager.searchNodes('auth', ctx);
    const stub = result.tiers.flatMap(t => t.entities).find(e => e.name === 'TASK_MANAGER');
    expect(stub).toBeDefined();
    expect(stub!.matchedIn).toContain('observation');
    expect(stub!.snippet).toBeDefined();
    expect(stub!.snippet).toContain('auth token validation');
  });

  it('truncates snippet to 120 chars + ellipsis', async () => {
    const longObs = 'auth ' + 'x'.repeat(200);
    const { manager } = createTestManager();
    await manager.createEntities([
      { name: 'LONG_OBS', entityType: 'thing', observations: [longObs] }
    ], ctx);

    const result = await manager.searchNodes('auth', ctx);
    const stub = result.tiers.flatMap(t => t.entities).find(e => e.name === 'LONG_OBS');
    expect(stub).toBeDefined();
    expect(stub!.snippet!.length).toBeLessThanOrEqual(124); // 120 + '...'
    expect(stub!.snippet!.endsWith('...')).toBe(true);
  });
});

describe('IndexStub in readGraphSummary', () => {
  it('extracts canonicalName from canonical_name: observation', async () => {
    const { manager } = createTestManager();
    await manager.createEntities([
      { name: 'MY_INDEX', entityType: 'knowledge_index', observations: ['canonical_name:My Index', 'summary: A cool index'] }
    ], ctx);

    const summary = await manager.readGraphSummary(ctx);
    const stub = summary.indices.find(i => i.name === 'MY_INDEX');
    expect(stub).toBeDefined();
    expect(stub!.canonicalName).toBe('My Index');
  });

  it('filters tag observations from summary', async () => {
    const { manager } = createTestManager();
    await manager.createEntities([
      { name: 'MY_INDEX', entityType: 'knowledge_index', observations: ['canonical_type:Knowledge', 'status:active', 'Top-level navigation hub'] }
    ], ctx);

    const summary = await manager.readGraphSummary(ctx);
    const stub = summary.indices.find(i => i.name === 'MY_INDEX');
    expect(stub).toBeDefined();
    expect(stub!.summary).toBe('Top-level navigation hub');
  });
});

describe('tierCap()', () => {
  it('single-token search caps at 20', async () => {
    const { manager } = createTestManager();
    // Create 25 entities all matching 'test'
    const entities = Array.from({ length: 25 }, (_, i) => ({
      name: `TEST_ENTITY_${i}`,
      entityType: 'test',
      observations: [`test observation ${i}`],
    }));
    await manager.createEntities(entities, ctx);

    const result = await manager.searchNodes('test', ctx);
    const tierEntities = result.tiers.flatMap(t => t.entities);
    expect(tierEntities.length).toBeLessThanOrEqual(20);
    expect(result.tiers[0].capped).toBe(true);
    expect(result.tiers[0].total).toBe(25);
  });
});
