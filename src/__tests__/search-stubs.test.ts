// src/__tests__/search-stubs.test.ts
import { EntityStub, IndexStub, SearchTier } from '../types/graph.js';
import { KnowledgeGraphManager } from '../graph/knowledge-graph-manager.js';
import { StorageService } from '../persistence/storage.js';

function mockManager(entities: any[] = [], relations: any[] = []) {
  const storage = {
    loadGraph: () => Promise.resolve({ entities, relations }),
    saveGraph: () => Promise.resolve(undefined),
  } as unknown as StorageService;
  return new KnowledgeGraphManager(storage);
}

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
  let buildStub: (entity: any, tokens: string[]) => any;

  beforeAll(() => {
    const manager = mockManager();
    buildStub = (manager as any).buildStub.bind(manager);
  });

  it('sets matchedIn name when token matches entity name', () => {
    const entity = { name: 'AUTH_SERVICE', entityType: 'component', observations: [] };
    const stub = buildStub(entity, ['auth']);
    expect(stub.matchedIn).toContain('name');
    expect(stub.snippet).toBeUndefined();
  });

  it('sets matchedIn type when token matches entityType only', () => {
    const entity = { name: 'SOMETHING', entityType: 'authentication_protocol', observations: [] };
    const stub = buildStub(entity, ['auth']);
    expect(stub.matchedIn).toContain('type');
    expect(stub.snippet).toBeUndefined();
  });

  it('sets matchedIn observation and provides snippet when token matches observation only', () => {
    const entity = {
      name: 'TASK_MANAGER',
      entityType: 'component',
      observations: ['Unrelated note', 'auth token validation happens here'],
    };
    const stub = buildStub(entity, ['auth']);
    expect(stub.matchedIn).toContain('observation');
    expect(stub.snippet).toBe('auth token validation happens here');
  });

  it('no snippet when name matched, even if observation also matches', () => {
    const entity = {
      name: 'AUTH_SERVICE',
      entityType: 'component',
      observations: ['auth is mentioned here too'],
    };
    const stub = buildStub(entity, ['auth']);
    expect(stub.snippet).toBeUndefined();
  });

  it('truncates long snippets to 120 chars with ellipsis', () => {
    const longObs = 'auth: ' + 'x'.repeat(200);
    const entity = { name: 'ENTITY', entityType: 'component', observations: [longObs] };
    const stub = buildStub(entity, ['auth']);
    expect(stub.snippet).toHaveLength(123); // 120 + '...'
    expect(stub.snippet).toMatch(/\.\.\.$/);
  });

  it('sets multiple matchedIn fields when token matches several', () => {
    const entity = {
      name: 'AUTH_COMPONENT',
      entityType: 'auth_module',
      observations: ['handles auth flow'],
    };
    const stub = buildStub(entity, ['auth']);
    expect(stub.matchedIn).toContain('name');
    expect(stub.matchedIn).toContain('type');
    expect(stub.snippet).toBeUndefined();
  });
});

describe('searchNodes() returns stubs', () => {
  const entities = [
    {
      name: 'AUTH_SERVICE',
      entityType: 'component',
      observations: ['Handles token exchange', 'Validates JWT'],
    },
    {
      name: 'TASK_MANAGER',
      entityType: 'component',
      observations: ['Manages job queue', 'auth check on every task'],
    },
    {
      name: 'UNRELATED',
      entityType: 'goal',
      observations: ['Something totally different'],
    },
  ];
  const relations = [
    { from: 'AUTH_SERVICE', to: 'TASK_MANAGER', relationType: 'depends_on' },
  ];

  it('result entities have no observations field', async () => {
    const manager = mockManager(entities, relations);
    const result = await manager.searchNodes('auth');
    const allEntities = result.tiers.flatMap(t => t.entities);
    expect(allEntities.length).toBeGreaterThan(0);
    allEntities.forEach(e => {
      expect((e as any).observations).toBeUndefined();
    });
  });

  it('result entities have name, type, matchedIn', async () => {
    const manager = mockManager(entities, relations);
    const result = await manager.searchNodes('auth');
    const allEntities = result.tiers.flatMap(t => t.entities);
    allEntities.forEach(e => {
      expect(e.name).toBeDefined();
      expect(e.type).toBeDefined();
      expect(e.matchedIn).toBeDefined();
    });
  });

  it('tiers have no relations field', async () => {
    const manager = mockManager(entities, relations);
    const result = await manager.searchNodes('auth');
    result.tiers.forEach(tier => {
      expect((tier as any).relations).toBeUndefined();
    });
  });

  it('AUTH_SERVICE stub has no snippet (name match)', async () => {
    const manager = mockManager(entities, relations);
    const result = await manager.searchNodes('auth');
    const allStubs = result.tiers.flatMap(t => t.entities);
    const authStub = allStubs.find(e => e.name === 'AUTH_SERVICE');
    expect(authStub).toBeDefined();
    expect(authStub!.matchedIn).toContain('name');
    expect(authStub!.snippet).toBeUndefined();
  });

  it('TASK_MANAGER stub has snippet (observation match only)', async () => {
    const manager = mockManager(entities, relations);
    const result = await manager.searchNodes('auth');
    const allStubs = result.tiers.flatMap(t => t.entities);
    const taskStub = allStubs.find(e => e.name === 'TASK_MANAGER');
    expect(taskStub).toBeDefined();
    expect(taskStub!.matchedIn).toContain('observation');
    expect(taskStub!.snippet).toContain('auth');
  });
});

describe('IndexStub type', () => {
  it('has required fields', () => {
    const stub: IndexStub = { name: 'MASTER_INDEX', type: 'Knowledge Graph Index' };
    expect(stub.name).toBe('MASTER_INDEX');
    expect(stub.type).toBe('Knowledge Graph Index');
    expect(stub.canonicalName).toBeUndefined();
    expect(stub.summary).toBeUndefined();
  });

  it('accepts optional canonicalName and summary', () => {
    const stub: IndexStub = {
      name: 'MASTER_INDEX',
      type: 'Knowledge Graph Index',
      canonicalName: 'Master Index',
      summary: 'Primary entry point for knowledge graph navigation.',
    };
    expect(stub.canonicalName).toBe('Master Index');
    expect(stub.summary).toBeDefined();
  });
});

describe('buildIndexStub() via readGraphSummary()', () => {
  const indexEntity = {
    name: 'MASTER_INDEX',
    entityType: 'Knowledge Graph Index',
    observations: [
      'canonical_name:Master Index',
      'canonical_type:Knowledge',
      'Primary entry point for knowledge graph navigation and discovery.',
      'Contains references to all major organizational structures and indices.',
    ],
  };

  it('returns IndexStub[] not Entity[]', async () => {
    const manager = mockManager([indexEntity]);
    const result = await manager.readGraphSummary();
    const stub = result.indices[0];
    expect(stub.name).toBe('MASTER_INDEX');
    expect(stub.type).toBe('Knowledge Graph Index');
    expect((stub as any).observations).toBeUndefined();
  });

  it('extracts canonicalName from canonical_name: observation', async () => {
    const manager = mockManager([indexEntity]);
    const result = await manager.readGraphSummary();
    expect(result.indices[0].canonicalName).toBe('Master Index');
  });

  it('skips tag observations for summary', async () => {
    const manager = mockManager([indexEntity]);
    const result = await manager.readGraphSummary();
    const summary = result.indices[0].summary;
    expect(summary).toBe('Primary entry point for knowledge graph navigation and discovery.');
    expect(summary).not.toContain('canonical_');
  });

  it('truncates long summary to 120 chars with ellipsis', async () => {
    const longObs = 'A'.repeat(130);
    const entity = { name: 'LONG_INDEX', entityType: 'Some Index', observations: [longObs] };
    const manager = mockManager([entity]);
    const result = await manager.readGraphSummary();
    expect(result.indices[0].summary!.length).toBe(123); // 120 + '...'
    expect(result.indices[0].summary!.endsWith('...')).toBe(true);
  });

  it('omits summary when all observations are tags', async () => {
    const entity = {
      name: 'TAG_INDEX',
      entityType: 'Some Index',
      observations: ['canonical_type:Knowledge', 'canonical_name:Tag Index', 'status:active'],
    };
    const manager = mockManager([entity]);
    const result = await manager.readGraphSummary();
    expect(result.indices[0].summary).toBeUndefined();
  });

  it('non-index entities are excluded', async () => {
    const nonIndex = { name: 'AUTH_SERVICE', entityType: 'component', observations: [] };
    const manager = mockManager([indexEntity, nonIndex]);
    const result = await manager.readGraphSummary();
    expect(result.indices).toHaveLength(1);
    expect(result.indices[0].name).toBe('MASTER_INDEX');
  });
});

describe('tierCap()', () => {
  it('single-token cap is 20', async () => {
    const manyEntities = Array.from({ length: 25 }, (_, i) => ({
      name: `ENTITY_${i}`,
      entityType: 'component',
      observations: [`tag match ${i}`],
    }));
    const manager = mockManager(manyEntities);
    const result = await manager.searchNodes('tag');
    const tier = result.tiers[0];
    expect(tier.total).toBe(25);
    expect(tier.capped).toBe(true);
    expect(tier.entities.length).toBe(20);
  });
});
