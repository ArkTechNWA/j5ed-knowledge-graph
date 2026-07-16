import Database from 'better-sqlite3';
import { PRAGMAS, ALL_DDL } from './schema.js';

// ── Row types (internal to persistence layer) ──────────────────────

export interface EntityRow {
  id: number;
  name: string;
  entity_type: string;
  created_by: string;
  user_id: string | null;
  created_at: string;
}

export interface ObservationRow {
  id: number;
  entity_id: number;
  content: string;
  version: number;
  authored_by: string;
  user_id: string | null;
  authored_at: string;
  superseded_at: string | null;
  superseded_by: string | null;
  supersede_rationale: string | null;
  previous_version_id: number | null;
}

export interface CommentRow {
  id: number;
  observation_id: number;
  content: string;
  authored_by: string;
  authored_at: string;
}

export interface RelationRow {
  id: number;
  from_entity_id: number;
  to_entity_id: number;
  from_name?: string;
  to_name?: string;
  relation_type: string;
  authored_by: string;
  authored_at: string;
  superseded_at: string | null;
  superseded_by: string | null;
  supersede_rationale: string | null;
}

export interface FtsMatchRow {
  entity_id: number;
  entity_name: string;
  entity_type: string;
  snippet: string;
}

// ── SqliteStorageService ────────────────────────────────────────────

export class SqliteStorageService {
  public db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initialize();
  }

  private initialize(): void {
    // Set pragmas (must be individual statements)
    for (const pragma of PRAGMAS.trim().split('\n')) {
      const stmt = pragma.trim();
      if (stmt && !stmt.startsWith('--')) {
        this.db.exec(stmt);
      }
    }

    // Create tables, indexes, FTS, triggers
    for (const ddl of ALL_DDL) {
      this.db.exec(ddl);
    }

  }


  // ── Entity operations ──────────────────────────────────────────

  createEntity(
    name: string,
    entityType: string,
    createdBy: string,
    userId?: string | null,
    createdAt?: string
  ): number {
    const stmt = createdAt
      ? this.db.prepare(
          'INSERT INTO entities (name, entity_type, created_by, user_id, created_at) VALUES (?, ?, ?, ?, ?)'
        )
      : this.db.prepare(
          'INSERT INTO entities (name, entity_type, created_by, user_id) VALUES (?, ?, ?, ?)'
        );
    const result = createdAt
      ? stmt.run(name, entityType, createdBy, userId ?? null, createdAt)
      : stmt.run(name, entityType, createdBy, userId ?? null);
    return result.lastInsertRowid as number;
  }

  getEntityByName(name: string): EntityRow | undefined {
    return this.db.prepare('SELECT * FROM entities WHERE name = ?').get(name) as EntityRow | undefined;
  }

  getEntityById(id: number): EntityRow | undefined {
    return this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow | undefined;
  }

  getEntitiesByNames(names: string[]): EntityRow[] {
    if (names.length === 0) return [];
    const placeholders = names.map(() => '?').join(', ');
    return this.db.prepare(`SELECT * FROM entities WHERE name IN (${placeholders})`).all(...names) as EntityRow[];
  }

  getAllEntities(allowedAgents?: string[], userId?: string | null): EntityRow[] {
    if (!allowedAgents || allowedAgents.length === 0) {
      return this.db.prepare('SELECT * FROM entities').all() as EntityRow[];
    }

    const agentPlaceholders = allowedAgents.map(() => '?').join(', ');

    if (userId) {
      // Entities created by allowed agents AND either matching userId or no userId (shared)
      return this.db.prepare(`
        SELECT DISTINCT e.* FROM entities e
        LEFT JOIN observations o ON o.entity_id = e.id AND o.superseded_at IS NULL
        WHERE (e.created_by IN (${agentPlaceholders}) OR o.authored_by IN (${agentPlaceholders}))
          AND (e.user_id IS NULL OR e.user_id = ?)
      `).all(...allowedAgents, ...allowedAgents, userId) as EntityRow[];
    }

    return this.db.prepare(`
      SELECT DISTINCT e.* FROM entities e
      LEFT JOIN observations o ON o.entity_id = e.id AND o.superseded_at IS NULL
      WHERE e.created_by IN (${agentPlaceholders}) OR o.authored_by IN (${agentPlaceholders})
    `).all(...allowedAgents, ...allowedAgents) as EntityRow[];
  }

  getIndexEntities(allowedAgents?: string[], userId?: string | null): EntityRow[] {
    const all = this.getAllEntities(allowedAgents, userId);
    return all.filter(
      e => e.entity_type.toLowerCase().includes('index') || e.name.endsWith('_INDEX')
    );
  }

  entityHasLiveObservations(entityId: number): boolean {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM observations WHERE entity_id = ? AND superseded_at IS NULL'
    ).get(entityId) as { cnt: number };
    return row.cnt > 0;
  }

  // ── Observation operations ─────────────────────────────────────

  addObservation(
    entityId: number,
    content: string,
    authoredBy: string,
    userId?: string | null,
    version?: number,
    previousVersionId?: number | null
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO observations (entity_id, content, version, authored_by, user_id, previous_version_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(entityId, content, version ?? 1, authoredBy, userId ?? null, previousVersionId ?? null);
    return result.lastInsertRowid as number;
  }

  getLiveObservations(entityId: number): ObservationRow[] {
    return this.db.prepare(
      'SELECT * FROM observations WHERE entity_id = ? AND superseded_at IS NULL ORDER BY id'
    ).all(entityId) as ObservationRow[];
  }

  getAllObservations(entityId: number): ObservationRow[] {
    return this.db.prepare(
      'SELECT * FROM observations WHERE entity_id = ? ORDER BY authored_at ASC'
    ).all(entityId) as ObservationRow[];
  }

  getObservationById(id: number): ObservationRow | undefined {
    return this.db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as ObservationRow | undefined;
  }

  findLiveObservation(entityId: number, content: string): ObservationRow | undefined {
    return this.db.prepare(
      'SELECT * FROM observations WHERE entity_id = ? AND content = ? AND superseded_at IS NULL'
    ).get(entityId, content) as ObservationRow | undefined;
  }

  softDeleteObservation(observationId: number, byAgent: string, rationale?: string): void {
    this.db.prepare(`
      UPDATE observations
      SET superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          superseded_by = ?,
          supersede_rationale = ?
      WHERE id = ? AND superseded_at IS NULL
    `).run(byAgent, rationale ?? null, observationId);
  }

  supersedeObservation(
    observationId: number,
    newContent: string,
    authoredBy: string,
    rationale: string,
    userId?: string | null
  ): number {
    const old = this.getObservationById(observationId);
    if (!old) throw new Error(`Observation ${observationId} not found`);
    if (old.superseded_at) throw new Error(`Observation ${observationId} is already superseded`);

    // Soft-delete the old
    this.softDeleteObservation(observationId, authoredBy, rationale);

    // Insert the replacement
    return this.addObservation(
      old.entity_id,
      newContent,
      authoredBy,
      userId ?? old.user_id,
      old.version + 1,
      old.id
    );
  }

  // ── Comment operations ─────────────────────────────────────────

  addComment(observationId: number, content: string, authoredBy: string): number {
    const result = this.db.prepare(
      'INSERT INTO comments (observation_id, content, authored_by) VALUES (?, ?, ?)'
    ).run(observationId, content, authoredBy);
    return result.lastInsertRowid as number;
  }

  getComments(observationId: number): CommentRow[] {
    return this.db.prepare(
      'SELECT * FROM comments WHERE observation_id = ? ORDER BY authored_at ASC'
    ).all(observationId) as CommentRow[];
  }

  // ── Relation operations ────────────────────────────────────────

  createRelation(
    fromEntityId: number,
    toEntityId: number,
    relationType: string,
    authoredBy: string
  ): number {
    const result = this.db.prepare(`
      INSERT INTO relations (from_entity_id, to_entity_id, relation_type, authored_by)
      VALUES (?, ?, ?, ?)
    `).run(fromEntityId, toEntityId, relationType, authoredBy);
    return result.lastInsertRowid as number;
  }

  findLiveRelation(fromEntityId: number, toEntityId: number, relationType: string): RelationRow | undefined {
    return this.db.prepare(`
      SELECT * FROM relations
      WHERE from_entity_id = ? AND to_entity_id = ? AND relation_type = ? AND superseded_at IS NULL
    `).get(fromEntityId, toEntityId, relationType) as RelationRow | undefined;
  }

  getLiveRelationsForEntities(entityIds: number[]): RelationRow[] {
    if (entityIds.length === 0) return [];
    const placeholders = entityIds.map(() => '?').join(', ');
    return this.db.prepare(`
      SELECT r.*, ef.name AS from_name, et.name AS to_name
      FROM relations r
      JOIN entities ef ON ef.id = r.from_entity_id
      JOIN entities et ON et.id = r.to_entity_id
      WHERE r.superseded_at IS NULL
        AND (r.from_entity_id IN (${placeholders}) OR r.to_entity_id IN (${placeholders}))
    `).all(...entityIds, ...entityIds) as RelationRow[];
  }

  getLiveRelationsBetweenEntities(entityIds: number[]): RelationRow[] {
    if (entityIds.length === 0) return [];
    const placeholders = entityIds.map(() => '?').join(', ');
    return this.db.prepare(`
      SELECT r.*, ef.name AS from_name, et.name AS to_name
      FROM relations r
      JOIN entities ef ON ef.id = r.from_entity_id
      JOIN entities et ON et.id = r.to_entity_id
      WHERE r.superseded_at IS NULL
        AND r.from_entity_id IN (${placeholders}) AND r.to_entity_id IN (${placeholders})
    `).all(...entityIds, ...entityIds) as RelationRow[];
  }

  getInboundRelations(entityIds: number[], allowedAgents?: string[]): RelationRow[] {
    if (entityIds.length === 0) return [];
    const placeholders = entityIds.map(() => '?').join(', ');

    if (allowedAgents && allowedAgents.length > 0) {
      const agentPlaceholders = allowedAgents.map(() => '?').join(', ');
      return this.db.prepare(`
        SELECT r.*, ef.name AS from_name, et.name AS to_name
        FROM relations r
        JOIN entities ef ON ef.id = r.from_entity_id
        JOIN entities et ON et.id = r.to_entity_id
        WHERE r.superseded_at IS NULL
          AND r.to_entity_id IN (${placeholders})
          AND ef.created_by IN (${agentPlaceholders})
      `).all(...entityIds, ...allowedAgents) as RelationRow[];
    }

    return this.db.prepare(`
      SELECT r.*, ef.name AS from_name, et.name AS to_name
      FROM relations r
      JOIN entities ef ON ef.id = r.from_entity_id
      JOIN entities et ON et.id = r.to_entity_id
      WHERE r.superseded_at IS NULL AND r.to_entity_id IN (${placeholders})
    `).all(...entityIds) as RelationRow[];
  }

  softDeleteRelation(relationId: number, byAgent: string, rationale?: string): void {
    this.db.prepare(`
      UPDATE relations
      SET superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          superseded_by = ?,
          supersede_rationale = ?
      WHERE id = ? AND superseded_at IS NULL
    `).run(byAgent, rationale ?? null, relationId);
  }

  softDeleteRelationsForEntity(entityId: number, byAgent: string): void {
    this.db.prepare(`
      UPDATE relations
      SET superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          superseded_by = ?
      WHERE (from_entity_id = ? OR to_entity_id = ?) AND superseded_at IS NULL
    `).run(byAgent, entityId, entityId);
  }

  // ── Search (FTS5) ─────────────────────────────────────────────

  searchFTS(query: string): FtsMatchRow[] {
    return this.db.prepare(`
      SELECT DISTINCT e.id AS entity_id, e.name AS entity_name, e.entity_type,
             snippet(observations_fts, 0, '', '', '...', 20) AS snippet
      FROM observations_fts
      JOIN observations o ON o.id = observations_fts.rowid
      JOIN entities e ON e.id = o.entity_id
      WHERE observations_fts MATCH ?
        AND o.superseded_at IS NULL
      ORDER BY rank
    `).all(query) as FtsMatchRow[];
  }

  // ── History / wiki queries ────────────────────────────────────

  getEntityHistory(entityName: string): ObservationRow[] {
    return this.db.prepare(`
      SELECT o.*
      FROM observations o
      JOIN entities e ON e.id = o.entity_id
      WHERE e.name = ?
      ORDER BY o.authored_at ASC
    `).all(entityName) as ObservationRow[];
  }

  getChangesToMine(agentId: string): Array<{
    entity_name: string;
    original_content: string;
    original_author: string;
    original_date: string;
    replaced_with: string;
    changed_by: string;
    changed_at: string;
    rationale: string | null;
  }> {
    return this.db.prepare(`
      SELECT
        e.name              AS entity_name,
        original.content    AS original_content,
        original.authored_by AS original_author,
        original.authored_at AS original_date,
        replacement.content AS replaced_with,
        replacement.authored_by AS changed_by,
        replacement.authored_at AS changed_at,
        original.supersede_rationale AS rationale
      FROM observations original
      JOIN observations replacement ON replacement.previous_version_id = original.id
      JOIN entities e ON e.id = original.entity_id
      WHERE original.authored_by = ?
        AND replacement.authored_by != ?
      ORDER BY replacement.authored_at DESC
    `).all(agentId, agentId) as any[];
  }

  // ── Counts ────────────────────────────────────────────────────

  countEntities(allowedAgents?: string[], userId?: string | null): number {
    if (!allowedAgents || allowedAgents.length === 0) {
      return (this.db.prepare('SELECT COUNT(*) AS cnt FROM entities').get() as { cnt: number }).cnt;
    }
    // Count entities that have at least one live observation (visible entities)
    const all = this.getAllEntities(allowedAgents, userId);
    return all.filter(e => this.entityHasLiveObservations(e.id)).length;
  }

  countLiveRelations(allowedAgents?: string[], userId?: string | null): number {
    if (!allowedAgents || allowedAgents.length === 0) {
      return (this.db.prepare('SELECT COUNT(*) AS cnt FROM relations WHERE superseded_at IS NULL').get() as { cnt: number }).cnt;
    }
    const entities = this.getAllEntities(allowedAgents, userId);
    const entityIds = new Set(entities.map(e => e.id));
    // Count relations where both endpoints are visible
    const allLive = this.db.prepare('SELECT from_entity_id, to_entity_id FROM relations WHERE superseded_at IS NULL').all() as Array<{ from_entity_id: number; to_entity_id: number }>;
    return allLive.filter(r => entityIds.has(r.from_entity_id) && entityIds.has(r.to_entity_id)).length;
  }

  // ── Transaction helper ────────────────────────────────────────

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
