#!/usr/bin/env node

/**
 * One-shot NDJSON → SQLite migration script.
 * Reads memory.json (NDJSON), writes to memory.db (SQLite).
 *
 * Usage: npm run migrate
 * Env: MEMORY_FILE_PATH (source), DB_PATH (target)
 */

import { readFileSync, existsSync } from 'fs';
import { SqliteStorageService } from '../persistence/sqlite-storage.js';
import { config } from '../utils/config.js';

const SYNTHETIC_PREFIXES = ['authored_by:', 'authored_at:', 'user_id:'];

interface NdjsonEntity {
  type: 'entity';
  name: string;
  entityType: string;
  observations: string[];
}

interface NdjsonRelation {
  type: 'relation';
  from: string;
  to: string;
  relationType: string;
}

function extractProvenance(observations: string[]): {
  authoredBy: string;
  authoredAt: string | null;
  userId: string | null;
} {
  let authoredBy = 'johnny5'; // legacy default
  let authoredAt: string | null = null;
  let userId: string | null = null;

  for (const obs of observations) {
    if (obs.startsWith('authored_by:') && authoredBy === 'johnny5') {
      authoredBy = obs.slice(12);
    } else if (obs.startsWith('authored_at:') && !authoredAt) {
      authoredAt = obs.slice(12);
    } else if (obs.startsWith('user_id:') && !userId) {
      userId = obs.slice(8);
    }
  }

  return { authoredBy, authoredAt, userId };
}

function isSynthetic(obs: string): boolean {
  return SYNTHETIC_PREFIXES.some(p => obs.startsWith(p));
}

function migrate() {
  const sourcePath = config.memoryFilePath;
  const targetPath = config.dbPath;

  console.log(`Migration: NDJSON → SQLite`);
  console.log(`  Source: ${sourcePath}`);
  console.log(`  Target: ${targetPath}`);

  // Safety: refuse if target already exists
  if (existsSync(targetPath)) {
    console.error(`ERROR: Target database already exists at ${targetPath}`);
    console.error(`Delete it manually to re-run migration.`);
    process.exit(1);
  }

  // Read source
  if (!existsSync(sourcePath)) {
    console.error(`ERROR: Source file not found at ${sourcePath}`);
    process.exit(1);
  }

  const data = readFileSync(sourcePath, 'utf-8');
  const lines = data.split('\n').filter(line => line.trim() !== '');

  const entities: NdjsonEntity[] = [];
  const relations: NdjsonRelation[] = [];

  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.type === 'entity') {
        entities.push(record as NdjsonEntity);
      } else if (record.type === 'relation') {
        relations.push(record as NdjsonRelation);
      }
    } catch (err) {
      console.error(`Skipping malformed line: ${line.slice(0, 80)}...`);
    }
  }

  console.log(`\nParsed NDJSON:`);
  console.log(`  Entities: ${entities.length}`);
  console.log(`  Relations: ${relations.length}`);

  // Create SQLite database
  const storage = new SqliteStorageService(targetPath);
  let obsCount = 0;
  let relCount = 0;
  let skippedRelations = 0;

  storage.transaction(() => {
    // Migrate entities
    for (const entity of entities) {
      const { authoredBy, authoredAt, userId } = extractProvenance(entity.observations);

      const entityId = storage.createEntity(
        entity.name,
        entity.entityType,
        authoredBy,
        userId,
        authoredAt ?? undefined
      );

      // Add content observations (skip synthetic tags)
      for (const obs of entity.observations) {
        if (isSynthetic(obs)) continue;
        storage.addObservation(entityId, obs, authoredBy, userId);
        obsCount++;
      }
    }

    // Migrate relations
    for (const relation of relations) {
      const fromEntity = storage.getEntityByName(relation.from);
      const toEntity = storage.getEntityByName(relation.to);

      if (!fromEntity || !toEntity) {
        console.error(`  Skipping relation: ${relation.from} → ${relation.relationType} → ${relation.to} (entity not found)`);
        skippedRelations++;
        continue;
      }

      // Check for duplicate (already exists as live)
      const existing = storage.findLiveRelation(fromEntity.id, toEntity.id, relation.relationType);
      if (existing) continue;

      storage.createRelation(fromEntity.id, toEntity.id, relation.relationType, 'migration');
      relCount++;
    }
  });

  // Rebuild FTS index
  storage.db.exec("INSERT INTO observations_fts(observations_fts) VALUES ('rebuild')");

  // Validate
  const entityCount = (storage.db.prepare('SELECT COUNT(*) AS cnt FROM entities').get() as any).cnt;
  const obsDbCount = (storage.db.prepare('SELECT COUNT(*) AS cnt FROM observations WHERE superseded_at IS NULL').get() as any).cnt;
  const relDbCount = (storage.db.prepare('SELECT COUNT(*) AS cnt FROM relations WHERE superseded_at IS NULL').get() as any).cnt;

  console.log(`\nMigrated to SQLite:`);
  console.log(`  Entities: ${entityCount} (source: ${entities.length})`);
  console.log(`  Observations: ${obsDbCount} (content only, synthetic tags stripped)`);
  console.log(`  Relations: ${relDbCount} (source: ${relations.length}, skipped: ${skippedRelations})`);

  if (entityCount !== entities.length) {
    console.error(`\nWARNING: Entity count mismatch!`);
  }

  storage.close();
  console.log(`\nMigration complete. Database written to ${targetPath}`);
}

migrate();
