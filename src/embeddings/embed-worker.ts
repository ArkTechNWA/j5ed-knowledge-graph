/**
 * Embedding worker — subscribes to KnowledgeGraphManager events,
 * generates embeddings via Ollama, writes to sqlite-vec.
 *
 * Best-effort: if Ollama is down or embedding fails, the observation
 * is skipped (logged). The backfill/reconciliation script repairs gaps.
 */

import { SqliteStorageService } from '../persistence/sqlite-storage.js';
import { KnowledgeGraphManager, ObservationAddedEvent, ObservationSupersededEvent, ObservationDeletedEvent, EntityDeletedEvent } from '../graph/knowledge-graph-manager.js';
import { OllamaEmbedder } from './ollama-client.js';

export class EmbedWorker {
  private running = false;

  constructor(
    private storage: SqliteStorageService,
    private embedder: OllamaEmbedder,
    private manager: KnowledgeGraphManager,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    this.manager.on('observation:added', this.handleAdded);
    this.manager.on('observation:superseded', this.handleSuperseded);
    this.manager.on('observation:deleted', this.handleDeleted);
    this.manager.on('entity:deleted', this.handleEntityDeleted);

    console.log('[EMBED] Worker started — listening for write events');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    this.manager.off('observation:added', this.handleAdded);
    this.manager.off('observation:superseded', this.handleSuperseded);
    this.manager.off('observation:deleted', this.handleDeleted);
    this.manager.off('entity:deleted', this.handleEntityDeleted);

    console.log('[EMBED] Worker stopped');
  }

  private handleAdded = async (event: ObservationAddedEvent): Promise<void> => {
    try {
      // Skip synthetic/metadata observations
      if (this.isSynthetic(event.content)) return;

      const embedding = await this.embedder.embed(event.content);
      this.storage.addVecEmbedding(
        event.observationId,
        embedding,
        event.entityName,
        event.authoredBy,
      );
    } catch (err) {
      console.error(`[EMBED] Failed to embed observation ${event.observationId}:`, (err as Error).message);
    }
  };

  private handleSuperseded = async (event: ObservationSupersededEvent): Promise<void> => {
    try {
      // Delete old embedding
      this.storage.deleteVecEmbedding(event.oldId);

      // Skip synthetic content
      if (this.isSynthetic(event.newContent)) return;

      // Embed and insert new
      const embedding = await this.embedder.embed(event.newContent);
      this.storage.addVecEmbedding(
        event.newId,
        embedding,
        event.entityName,
        event.authoredBy,
      );
    } catch (err) {
      console.error(`[EMBED] Failed to handle supersede ${event.oldId} → ${event.newId}:`, (err as Error).message);
    }
  };

  private handleDeleted = (event: ObservationDeletedEvent): void => {
    try {
      this.storage.deleteVecEmbedding(event.observationId);
    } catch (err) {
      console.error(`[EMBED] Failed to delete embedding ${event.observationId}:`, (err as Error).message);
    }
  };

  private handleEntityDeleted = (event: EntityDeletedEvent): void => {
    try {
      for (const obsId of event.observationIds) {
        this.storage.deleteVecEmbedding(obsId);
      }
    } catch (err) {
      console.error(`[EMBED] Failed to delete embeddings for entity ${event.entityName}:`, (err as Error).message);
    }
  };

  private isSynthetic(content: string): boolean {
    return (
      content.startsWith('authored_by:') ||
      content.startsWith('authored_at:') ||
      content.startsWith('user_id:') ||
      content.startsWith('canonical_type:') ||
      content.startsWith('status:')
    );
  }
}
