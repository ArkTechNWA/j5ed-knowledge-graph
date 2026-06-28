import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Get the current directory of the module
 */
export const getCurrentDir = () => {
  const __filename = fileURLToPath(import.meta.url);
  return path.dirname(path.dirname(__filename)); // Go up one level from utils/
};

/**
 * Parse AGENT_CREDENTIALS env var format "agent1:token1,agent2:token2"
 * into a Map<token, agentId> for O(1) token lookups.
 */
export const parseCredentials = (raw: string | undefined): Map<string, string> => {
  const map = new Map<string, string>();
  if (!raw) return map;

  for (const entry of raw.split(',')) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) continue;
    const agentId = entry.slice(0, colonIdx).trim();
    const token = entry.slice(colonIdx + 1).trim();
    if (!agentId || !token) continue;
    map.set(token, agentId);
  }

  return map;
};

/**
 * Parse AGENT_READ_GRANTS env var format "reader1:source1,reader2:source2"
 * into a Map<readerId, Set<sourceId>> for read grant lookups.
 * An agent with a read grant can read entities authored by the source agent.
 */
export const parseReadGrants = (raw: string | undefined): Map<string, Set<string>> => {
  const map = new Map<string, Set<string>>();
  if (!raw) return map;

  for (const entry of raw.split(',')) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) continue;
    const readerId = entry.slice(0, colonIdx).trim();
    const sourceId = entry.slice(colonIdx + 1).trim();
    if (!readerId || !sourceId) continue;
    if (!map.has(readerId)) map.set(readerId, new Set());
    map.get(readerId)!.add(sourceId);
  }

  return map;
};

/**
 * Configuration object for the application
 */
export interface Config {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Path to the legacy NDJSON memory file (migration source only) */
  memoryFilePath: string;
  /** Default agent identity when no X-Agent-Id header is provided */
  defaultAgentId: string;
  /** Map of token -> agentId for bearer auth; empty = no credentials configured */
  agentCredentials: Map<string, string>;
  /** True when at least one credential is configured — auth is enforced */
  authRequired: boolean;
  /** Map of readerId -> Set<sourceId> for cross-agent read grants */
  agentReadGrants: Map<string, Set<string>>;
}

/**
 * Load configuration from environment variables with sensible defaults
 */
export const loadConfig = (): Config => {
  const defaultMemoryPath = path.join(getCurrentDir(), 'memory.json');
  const defaultDbPath = path.join(getCurrentDir(), 'memory.db');

  let memoryFilePath = process.env.MEMORY_FILE_PATH || defaultMemoryPath;
  if (memoryFilePath && !path.isAbsolute(memoryFilePath)) {
    memoryFilePath = path.join(getCurrentDir(), memoryFilePath);
  }

  let dbPath = process.env.DB_PATH || defaultDbPath;
  if (dbPath && !path.isAbsolute(dbPath)) {
    dbPath = path.join(getCurrentDir(), dbPath);
  }

  const agentCredentials = parseCredentials(process.env.AGENT_CREDENTIALS);

  return {
    dbPath,
    memoryFilePath,
    defaultAgentId: process.env.DEFAULT_AGENT_ID || 'default',
    agentCredentials,
    authRequired: agentCredentials.size > 0,
    agentReadGrants: parseReadGrants(process.env.AGENT_READ_GRANTS),
  };
};

// Export a singleton config instance
export const config = loadConfig();
