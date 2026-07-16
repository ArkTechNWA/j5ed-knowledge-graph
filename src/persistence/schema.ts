/**
 * SQLite DDL constants for the knowledge graph schema.
 * Always supersede, never delete — every mutation is preserved.
 */

export const PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
`;

export const CREATE_ENTITIES = `
  CREATE TABLE IF NOT EXISTS entities (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE,
    entity_type TEXT    NOT NULL,
    created_by  TEXT    NOT NULL,
    user_id     TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;

export const CREATE_OBSERVATIONS = `
  CREATE TABLE IF NOT EXISTS observations (
    id                  INTEGER PRIMARY KEY,
    entity_id           INTEGER NOT NULL REFERENCES entities(id),
    content             TEXT    NOT NULL,
    version             INTEGER NOT NULL DEFAULT 1,
    authored_by         TEXT    NOT NULL,
    user_id             TEXT,
    authored_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    superseded_at       TEXT,
    superseded_by       TEXT,
    supersede_rationale TEXT,
    previous_version_id INTEGER REFERENCES observations(id)
  );
`;

export const CREATE_COMMENTS = `
  CREATE TABLE IF NOT EXISTS comments (
    id              INTEGER PRIMARY KEY,
    observation_id  INTEGER NOT NULL REFERENCES observations(id),
    content         TEXT    NOT NULL,
    authored_by     TEXT    NOT NULL,
    authored_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;

export const CREATE_RELATIONS = `
  CREATE TABLE IF NOT EXISTS relations (
    id                  INTEGER PRIMARY KEY,
    from_entity_id      INTEGER NOT NULL REFERENCES entities(id),
    to_entity_id        INTEGER NOT NULL REFERENCES entities(id),
    relation_type       TEXT    NOT NULL,
    authored_by         TEXT    NOT NULL,
    authored_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    superseded_at       TEXT,
    superseded_by       TEXT,
    supersede_rationale TEXT
  );
`;

export const CREATE_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_entities_type       ON entities(entity_type);
  CREATE INDEX IF NOT EXISTS idx_entities_created_by ON entities(created_by);
  CREATE INDEX IF NOT EXISTS idx_entities_user_id    ON entities(user_id);

  CREATE INDEX IF NOT EXISTS idx_obs_entity          ON observations(entity_id);
  CREATE INDEX IF NOT EXISTS idx_obs_entity_live     ON observations(entity_id) WHERE superseded_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_obs_authored_by     ON observations(authored_by);
  CREATE INDEX IF NOT EXISTS idx_obs_user_id         ON observations(user_id);
  CREATE INDEX IF NOT EXISTS idx_obs_previous        ON observations(previous_version_id) WHERE previous_version_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_comments_obs        ON comments(observation_id);
  CREATE INDEX IF NOT EXISTS idx_comments_author     ON comments(authored_by);

  CREATE INDEX IF NOT EXISTS idx_rel_from_live       ON relations(from_entity_id) WHERE superseded_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_rel_to_live         ON relations(to_entity_id) WHERE superseded_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_rel_type_live       ON relations(relation_type) WHERE superseded_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_rel_author          ON relations(authored_by);
`;

export const CREATE_UNIQUE_LIVE_RELATION = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_live_unique
    ON relations(from_entity_id, to_entity_id, relation_type)
    WHERE superseded_at IS NULL;
`;

export const CREATE_FTS = `
  CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
    content,
    content='observations',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );
`;

export const CREATE_FTS_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS obs_fts_insert AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS obs_fts_supersede AFTER UPDATE OF superseded_at ON observations
    WHEN new.superseded_at IS NOT NULL AND old.superseded_at IS NULL BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
  END;
`;


// ── Boot change flag table + triggers ─────────────────────────────
// Flag table in the main DB. Triggers fire ONLY when Brick's
// MY_BOOT entity is modified (insert or supersede).
// WAL watcher checks this table — exits in <10ms for non-boot writes.

export const CREATE_BOOT_FLAG_TABLE = `
  CREATE TABLE IF NOT EXISTS boot_change_flags (
    id     INTEGER PRIMARY KEY,
    agent  TEXT    NOT NULL,
    entity TEXT    NOT NULL,
    ts     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;

export const CREATE_BOOT_FLAG_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS brick_boot_changed
  AFTER INSERT ON observations
  WHEN NEW.entity_id = (
    SELECT id FROM entities WHERE name = 'MY_BOOT' AND created_by = 'brick'
  )
  BEGIN
    INSERT INTO boot_change_flags (agent, entity)
    VALUES ('brick', 'MY_BOOT');
  END;

  CREATE TRIGGER IF NOT EXISTS brick_boot_superseded
  AFTER UPDATE OF superseded_at ON observations
  WHEN OLD.entity_id = (
    SELECT id FROM entities WHERE name = 'MY_BOOT' AND created_by = 'brick'
  )
  BEGIN
    INSERT INTO boot_change_flags (agent, entity)
    VALUES ('brick', 'MY_BOOT');
  END;
`;

/**
 * Execute all DDL in order to initialize a fresh database.
 */
export const ALL_DDL = [
  CREATE_ENTITIES,
  CREATE_OBSERVATIONS,
  CREATE_COMMENTS,
  CREATE_RELATIONS,
  CREATE_INDEXES,
  CREATE_UNIQUE_LIVE_RELATION,
  CREATE_FTS,
  CREATE_FTS_TRIGGERS,
  CREATE_BOOT_FLAG_TABLE,
  CREATE_BOOT_FLAG_TRIGGERS,
];
