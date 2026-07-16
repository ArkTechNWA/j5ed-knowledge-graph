/**
 * Represents an entity in the knowledge graph
 */
export interface Entity {
  /** Unique identifier for the entity */
  name: string;
  /** The type/category of the entity (e.g., person, organization, place) */
  entityType: string;
  /** List of facts/observations about this entity */
  observations: string[];
}

/**
 * Lightweight stub returned by search_nodes.
 * Use open_nodes() to retrieve the full entity with all observations.
 */
export interface EntityStub {
  /** Entity name */
  name: string;
  /** Entity type */
  type: string;
  /** Which fields contained the matching token(s) */
  matchedIn: Array<'name' | 'type' | 'observation'>;
  /**
   * Excerpt from the first matching observation, truncated to 120 chars.
   * Only present when matchedIn includes 'observation' and name did not match.
   */
  snippet?: string;
}

/**
 * Represents a directional relationship between two entities
 */
export interface Relation {
  /** Name of the source entity */
  from: string;
  /** Name of the target entity */
  to: string;
  /** Type of relationship in active voice (e.g., works_at, lives_in) */
  relationType: string;
}

/**
 * Structure representing the entire knowledge graph
 */
export interface KnowledgeGraph {
  /** Collection of all entities in the graph */
  entities: Entity[];
  /** Collection of all relations in the graph */
  relations: Relation[];
}

/**
 * Input for adding observations to an entity
 */
export interface ObservationInput {
  /** Name of the entity to add observations to */
  entityName: string;
  /** List of observations to add */
  contents: string[];
}

/**
 * Result of adding observations to an entity
 */
export interface ObservationResult {
  /** Name of the entity observations were added to */
  entityName: string;
  /** List of observations that were successfully added */
  addedObservations: string[];
}

/**
 * Input for deleting observations from an entity
 */
export interface ObservationDeletion {
  /** Name of the entity to delete observations from */
  entityName: string;
  /** List of observations to delete */
  observations: string[];
}

/**
 * A single tier in search results
 */
export interface SearchTier {
  /** How many tokens matched (1 = any single, N = all tokens) */
  matchCount: number;
  /** Label for this tier */
  label: string;
  /** Entities in this tier as stubs, ranked by relevance */
  entities: EntityStub[];
  /** Total entities before cap was applied */
  total: number;
  /** Whether results were capped (true = more exist than shown) */
  capped: boolean;
}

/**
 * Tiered search result — broadest matches first, most specific last
 */
export interface SearchResult {
  /** Original query */
  query: string;
  /** Tokens extracted from query */
  tokens: string[];
  /** Results grouped by match count, ascending */
  tiers: SearchTier[];
  /** Total unique entities matched across all tiers */
  totalMatches: number;
}

/**
 * Lightweight stub returned by read_graph() for each index entity.
 * Use open_nodes() to retrieve the full entity with all observations.
 */
export interface IndexStub {
  /** Entity name — pass directly to open_nodes() */
  name: string;
  /** Entity type */
  type: string;
  /** Value of the canonical_name:<Value> observation, if present */
  canonicalName?: string;
  /**
   * First substantive observation (non-tag, non-canonical), truncated to 120 chars.
   * Gives enough context to decide whether to open_nodes() this index.
   */
  summary?: string;
}

/**
 * Summary response when read_graph returns indices-first
 */
export interface GraphSummary {
  /** Status indicator */
  status: 'summary';
  /** Reason for returning summary */
  reason: string;
  /** Index entities as lightweight stubs — call open_nodes() for full observations */
  indices: IndexStub[];
  /** Relations between indices */
  indexRelations: Relation[];
  /** Graph statistics */
  counts: {
    total_entities: number;
    total_relations: number;
    indices_returned: number;
  };
  /** How to get more data */
  drill_down: {
    specific_entity: string;
    search: string;
    full_graph: string;
  };
}


/**
 * Defines a post-write hook that fires when matching entities are mutated.
 */
export interface WriteHook {
  /** Match criteria — at least one of entity or entity_type must be set */
  match: { entity?: string; entity_type?: string };
  /** Action to take: touch writes a timestamp file, exec runs a command */
  action: "touch" | "exec";
  /** File path (touch) or shell command (exec) */
  target: string;
}

/**
 * Describes what changed in a write operation, used for hook matching.
 */
export interface WriteEvent {
  /** Entity names affected by the write */
  entityNames: string[];
  /** Entity types affected by the write */
  entityTypes: string[];
  /** Kind of mutation */
  operation: "create" | "update" | "delete";
}

/**
 * Identity context for the calling agent.
 * Extracted from transport headers at session creation.
 * Threaded into ALL operations — writes for provenance, reads for tenant isolation.
 * `authored_by:<agentId>` observations are the tenancy boundary.
 */
export interface AgentContext {
  /** Agent identifier (e.g., 'assistant', 'agent-1'). Lowercase, alphanumeric + hyphens. */
  agentId: string;
  /** Optional user identifier (e.g., email). When present, writes are tagged with user_id:<userId> and reads filter to entities that either have no user_id tag (shared agent memory) or match this userId. */
  userId?: string;
}
