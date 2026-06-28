import { KnowledgeGraphManager } from '../graph/knowledge-graph-manager.js';
import { StorageService } from '../persistence/storage.js';
import { AgentContext, Entity } from '../types/graph.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

describe('write serialization', () => {
  it('concurrent creates do not lose data', async () => {
    let savedEntities: Entity[] = [];
    const storage = {
      loadGraph: () => new Promise(resolve => setTimeout(() => resolve({
        entities: [...savedEntities],
        relations: [],
      }), 5)),
      saveGraph: (graph: any) => {
        savedEntities = [...graph.entities];
        return Promise.resolve();
      },
    } as unknown as StorageService;

    const manager = new KnowledgeGraphManager(storage);
    const ctx: AgentContext = { agentId: 'j5' };

    // Fire 10 concurrent creates
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        manager.createEntities(
          [{ name: `ENTITY_${i}`, entityType: 'test', observations: [`item ${i}`] }],
          ctx
        )
      )
    );

    // All 10 must be present — no lost writes
    expect(savedEntities).toHaveLength(10);
    const names = savedEntities.map(e => e.name).sort();
    expect(names).toEqual(Array.from({ length: 10 }, (_, i) => `ENTITY_${i}`).sort());
  });
});

describe('backup rotation', () => {
  let tmpDir: string;
  let memoryPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'j5ed-test-'));
    memoryPath = path.join(tmpDir, 'memory.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a backup before saving', async () => {
    const storage = new StorageService(memoryPath);
    await storage.saveGraph({ entities: [{ name: 'A', entityType: 'test', observations: ['v1'] }], relations: [] });
    await storage.saveGraph({ entities: [{ name: 'A', entityType: 'test', observations: ['v2'] }], relations: [] });
    const files = await fs.readdir(tmpDir);
    const backups = files.filter(f => f.startsWith('memory.json.bak.'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('limits backups to 5', async () => {
    const storage = new StorageService(memoryPath);
    for (let i = 0; i < 8; i++) {
      await storage.saveGraph({
        entities: [{ name: 'A', entityType: 'test', observations: [`v${i}`] }],
        relations: [],
      });
    }
    const files = await fs.readdir(tmpDir);
    const backups = files.filter(f => f.startsWith('memory.json.bak.'));
    expect(backups.length).toBeLessThanOrEqual(5);
  });
});
