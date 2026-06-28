import { KnowledgeGraphManager } from '../../graph/knowledge-graph-manager.js';
import { SqliteStorageService } from '../../persistence/sqlite-storage.js';

/**
 * Create a test manager backed by an in-memory SQLite database.
 * Each call returns a completely isolated instance.
 */
export function createTestManager(): { manager: KnowledgeGraphManager; storage: SqliteStorageService } {
  const storage = new SqliteStorageService(':memory:');
  const manager = new KnowledgeGraphManager(storage);
  return { manager, storage };
}
