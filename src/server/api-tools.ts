/**
 * API tools definition for MCP server
 */
export const apiTools = [
  {
    name: "create_entities",
    description: "Create multiple new entities in the knowledge graph",
    inputSchema: {
      type: "object",
      properties: {
        entities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "The name of the entity" },
              entityType: { type: "string", description: "The type of the entity" },
              observations: {
                type: "array",
                items: { type: "string" },
                description: "An array of observation contents associated with the entity"
              },
            },
            required: ["name", "entityType", "observations"],
          },
        },
      },
      required: ["entities"],
    },
  },
  {
    name: "create_relations",
    description: "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
    inputSchema: {
      type: "object",
      properties: {
        relations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "The name of the entity where the relation starts" },
              to: { type: "string", description: "The name of the entity where the relation ends" },
              relationType: { type: "string", description: "The type of the relation" },
            },
            required: ["from", "to", "relationType"],
          },
        },
      },
      required: ["relations"],
    },
  },
  {
    name: "add_observations",
    description: "Add new observations to existing entities in the knowledge graph",
    inputSchema: {
      type: "object",
      properties: {
        observations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entityName: { type: "string", description: "The name of the entity to add the observations to" },
              contents: {
                type: "array",
                items: { type: "string" },
                description: "An array of observation contents to add"
              },
            },
            required: ["entityName", "contents"],
          },
        },
      },
      required: ["observations"],
    },
  },
  {
    name: "delete_entities",
    description: "Delete multiple entities and their associated relations from the knowledge graph",
    inputSchema: {
      type: "object",
      properties: {
        entityNames: {
          type: "array",
          items: { type: "string" },
          description: "An array of entity names to delete"
        },
      },
      required: ["entityNames"],
    },
  },
  {
    name: "delete_observations",
    description: "Delete specific observations from entities in the knowledge graph",
    inputSchema: {
      type: "object",
      properties: {
        deletions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entityName: { type: "string", description: "The name of the entity containing the observations" },
              observations: {
                type: "array",
                items: { type: "string" },
                description: "An array of observations to delete"
              },
            },
            required: ["entityName", "observations"],
          },
        },
      },
      required: ["deletions"],
    },
  },
  {
    name: "delete_relations",
    description: "Delete multiple relations from the knowledge graph",
    inputSchema: {
      type: "object",
      properties: {
        relations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "The name of the entity where the relation starts" },
              to: { type: "string", description: "The name of the entity where the relation ends" },
              relationType: { type: "string", description: "The type of the relation" },
            },
            required: ["from", "to", "relationType"],
          },
          description: "An array of relations to delete"
        },
      },
      required: ["relations"],
    },
  },
  {
    name: "read_graph",
    description: "Read the knowledge graph. By default returns index stubs (name, type, canonicalName, summary) for navigation — call open_nodes() on relevant indices to get full observations. Use force=true to get the full graph.",
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "If true, returns the entire graph instead of just indices. Default: false"
        }
      },
    },
  },
  {
    name: "search_nodes",
    description: "Search for nodes in the knowledge graph. Returns lightweight stubs (name, type, matchedIn, optional snippet) — not full entities. Use open_nodes() to retrieve full observations for specific results. Multi-word queries are tokenized and results are returned in tiers by match count. Each entity appears in its highest tier only. Broadest first, most specific last. Within each tier, results are ranked by relevance: index entities first, then name matches, type matches, observation matches. Per-tier caps prevent noise.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query to match against entity names, types, and observation content" },
      },
      required: ["query"],
    },
  },
  {
    name: "open_nodes",
    description: "Open specific nodes in the knowledge graph by their names",
    inputSchema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "An array of entity names to retrieve",
        },
      },
      required: ["names"],
    },
  },
];
