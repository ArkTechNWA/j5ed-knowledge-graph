#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express, { Request, Response } from "express";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

import { KnowledgeGraphManager } from "./graph/knowledge-graph-manager.js";
import { SqliteStorageService } from "./persistence/sqlite-storage.js";
import { allTools } from "./server/api-tools.js";
import { Entity, Relation, ObservationInput, ObservationDeletion, AgentContext } from "./types/graph.js";
import { config } from "./utils/config.js";
import pkg from '../package.json' with { type: 'json' };

export interface AuthResult {
  authenticated: boolean;
  agentId?: string;
  error?: string;
}

export function authenticateRequest(
  authHeader: string | undefined,
  credentials: Map<string, string>
): AuthResult {
  if (credentials.size === 0) {
    return { authenticated: true, agentId: undefined };
  }
  if (!authHeader) {
    return { authenticated: false, error: 'Authorization header required' };
  }
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { authenticated: false, error: 'Bearer token required' };
  }
  const token = match[1].trim();
  const agentId = credentials.get(token);
  if (!agentId) {
    return { authenticated: false, error: 'Invalid token' };
  }
  return { authenticated: true, agentId };
}

/**
 * Gracefully handle tool arguments that arrive as either parsed arrays
 * or JSON strings (some MCP clients double-serialize complex params).
 */
function ensureArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return JSON.parse(value);
  throw new Error(`Expected array or JSON string, got ${typeof value}`);
}

// Parse CLI arguments
const args = process.argv.slice(2);
const useSSE = args.includes('--sse');
const useHTTP = args.includes('--http');
const portIndex = args.indexOf('--port');
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3100;

// Create SQLite storage and knowledge graph manager
const storage = new SqliteStorageService(config.dbPath);
const knowledgeGraphManager = new KnowledgeGraphManager(storage, config.writeHooks);

/**
 * Create and configure an MCP server instance with tool handlers
 */
function createMCPServer(agentContext: AgentContext): Server {
  const server = new Server(
    {
      name: "j5ed-knowledge-graph",
      version: pkg.version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: allTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!args) {
      throw new Error(`No arguments provided for tool: ${name}`);
    }

    try {
      switch (name) {
        case "create_entities":
          return {
            content: [{
              type: "text",
              text: JSON.stringify(
                await knowledgeGraphManager.createEntities(ensureArray<Entity>(args.entities), agentContext),
                null, 2
              )
            }]
          };

        case "create_relations":
          return {
            content: [{
              type: "text",
              text: JSON.stringify(
                await knowledgeGraphManager.createRelations(ensureArray<Relation>(args.relations), agentContext),
                null, 2
              )
            }]
          };

        case "add_observations":
          return {
            content: [{
              type: "text",
              text: JSON.stringify(
                await knowledgeGraphManager.addObservations(ensureArray<ObservationInput>(args.observations), agentContext),
                null, 2
              )
            }]
          };

        case "delete_entities":
          await knowledgeGraphManager.deleteEntities(ensureArray<string>(args.entityNames), agentContext);
          return {
            content: [{ type: "text", text: "Entities soft-deleted successfully" }]
          };

        case "delete_observations":
          await knowledgeGraphManager.deleteObservations(ensureArray<ObservationDeletion>(args.deletions), agentContext);
          return {
            content: [{ type: "text", text: "Observations soft-deleted successfully" }]
          };

        case "delete_relations":
          await knowledgeGraphManager.deleteRelations(ensureArray<Relation>(args.relations), agentContext);
          return {
            content: [{ type: "text", text: "Relations soft-deleted successfully" }]
          };

        case "read_graph": {
          const force = args.force === true;
          const result = force
            ? await knowledgeGraphManager.readGraph(agentContext)
            : await knowledgeGraphManager.readGraphSummary(agentContext);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
          };
        }

        case "search_nodes":
          return {
            content: [{
              type: "text",
              text: JSON.stringify(
                await knowledgeGraphManager.searchNodes(args.query as string, agentContext),
                null, 2
              )
            }]
          };

        case "open_nodes":
          return {
            content: [{
              type: "text",
              text: JSON.stringify(
                await knowledgeGraphManager.openNodes(ensureArray<string>(args.names), agentContext),
                null, 2
              )
            }]
          };

        case "entity_history":
          return {
            content: [{
              type: "text",
              text: JSON.stringify(
                await knowledgeGraphManager.entityHistory(args.entityName as string),
                null, 2
              )
            }]
          };

        case "changes_to_mine":
          return {
            content: [{
              type: "text",
              text: JSON.stringify(
                await knowledgeGraphManager.changesToMine(agentContext.agentId),
                null, 2
              )
            }]
          };

        case "comment":
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                commentId: await knowledgeGraphManager.addComment(
                  args.observationId as number,
                  args.content as string,
                  agentContext
                )
              }, null, 2)
            }]
          };

        case "observation_comments":
          return {
            content: [{
              type: "text",
              text: JSON.stringify(
                await knowledgeGraphManager.getObservationComments(args.observationId as number),
                null, 2
              )
            }]
          };

        case "supersede":
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                newObservationId: await knowledgeGraphManager.supersedeObservation(
                  args.observationId as number,
                  args.newContent as string,
                  args.rationale as string,
                  agentContext
                )
              }, null, 2)
            }]
          };

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      console.error(`Error executing tool ${name}:`, error);
      throw error;
    }
  });

  return server;
}

async function startStdio() {
  console.error(`j5ed-knowledge-graph v${pkg.version}`);
  console.error(`Database: ${config.dbPath}`);

  const server = createMCPServer({ agentId: config.defaultAgentId });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("j5ed-knowledge-graph running on stdio");
}

async function startSSE() {
  console.error(`j5ed-knowledge-graph v${pkg.version}`);
  console.error(`Database: ${config.dbPath}`);

  const app = express();
  const sessions = new Map<string, { transport: SSEServerTransport; server: Server }>();

  app.get('/sse', async (req: Request, res: Response) => {
    const authResult = authenticateRequest(
      req.headers['authorization'] as string | undefined,
      config.agentCredentials
    );
    if (!authResult.authenticated) {
      console.error(`[SSE] Auth rejected from ${req.ip}: ${authResult.error}`);
      res.status(401).json({ error: authResult.error });
      return;
    }
    const agentId = authResult.agentId || config.defaultAgentId;
    const agentContext: AgentContext = { agentId };
    console.error(`[SSE] New connection from ${req.ip}, agent: ${agentContext.agentId}`);

    const transport = new SSEServerTransport('/messages', res);
    const server = createMCPServer(agentContext);

    transport.onclose = () => {
      console.error(`[SSE] Connection closed: ${transport.sessionId}`);
      sessions.delete(transport.sessionId);
    };

    sessions.set(transport.sessionId, { transport, server });

    try {
      await server.connect(transport);
      console.error(`[SSE] Connected session: ${transport.sessionId}`);
    } catch (err) {
      console.error(`[SSE] Connect error:`, err);
      sessions.delete(transport.sessionId);
    }
  });

  app.post('/messages', express.json(), async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    const session = sessions.get(sessionId);

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    await session.transport.handlePostMessage(req, res);
  });

  app.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      name: 'j5ed-knowledge-graph',
      version: pkg.version,
      activeSessions: sessions.size,
      dbPath: config.dbPath,
      defaultAgentId: config.defaultAgentId,
      tenantIsolation: true,
      storage: 'sqlite'
    });
  });

  // JSON 404 for unknown routes — prevents HTML responses that break MCP SDK OAuth probes
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.listen(port, () => {
    console.error(`j5ed-knowledge-graph running on SSE at http://localhost:${port}`);
    console.error(`  SSE endpoint: http://localhost:${port}/sse`);
    console.error(`  Messages endpoint: http://localhost:${port}/messages`);
    console.error(`  Health check: http://localhost:${port}/health`);
  });
}

async function startHTTP() {
  console.error(`j5ed-knowledge-graph v${pkg.version}`);
  console.error(`Database: ${config.dbPath}`);

  const app = express();
  app.use(express.json());

  const SESSION_TTL_MS = 10 * 60 * 1000;

  interface Session {
    server: Server;
    transport: StreamableHTTPServerTransport;
    lastActivity: number;
  }
  const sessions = new Map<string, Session>();

  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [sessionId, session] of sessions.entries()) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        sessions.delete(sessionId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.error(`[HTTP] Cleaned up ${cleaned} stale session(s). Active: ${sessions.size}`);
    }
  }, 5 * 60 * 1000);

  app.all('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    console.error(`[HTTP] ${req.method} from ${req.ip}, session: ${sessionId || 'new'}`);

    try {
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.lastActivity = Date.now();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      const authResult = authenticateRequest(
        req.headers['authorization'] as string | undefined,
        config.agentCredentials
      );
      if (!authResult.authenticated) {
        console.error(`[HTTP] Auth rejected from ${req.ip}: ${authResult.error}`);
        res.status(401).json({ error: authResult.error });
        return;
      }
      const agentId = authResult.agentId || config.defaultAgentId;
      const userId = req.headers['x-user-id'] as string | undefined;
      const agentContext: AgentContext = { agentId, ...(userId && { userId }) };
      const newSessionId = randomUUID();
      const server = createMCPServer(agentContext);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
      });

      await server.connect(transport);
      sessions.set(newSessionId, { server, transport, lastActivity: Date.now() });
      console.error(`[HTTP] Created new session: ${newSessionId}, agent: ${agentContext.agentId}${agentContext.userId ? `, user: ${agentContext.userId}` : ''}`);

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[HTTP] Error:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      name: 'j5ed-knowledge-graph',
      version: pkg.version,
      transport: 'streamable-http',
      activeSessions: sessions.size,
      dbPath: config.dbPath,
      defaultAgentId: config.defaultAgentId,
      tenantIsolation: true,
      storage: 'sqlite'
    });
  });

  // JSON 404 for unknown routes — prevents HTML responses that break MCP SDK OAuth probes
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.listen(port, () => {
    console.error(`j5ed-knowledge-graph running on Streamable HTTP at http://localhost:${port}`);
    console.error(`  MCP endpoint: http://localhost:${port}/mcp`);
    console.error(`  Health check: http://localhost:${port}/health`);
  });
}

async function main() {
  try {
    if (useHTTP) {
      await startHTTP();
    } else if (useSSE) {
      await startSSE();
    } else {
      await startStdio();
    }
  } catch (error) {
    console.error("Error starting server:", error);
    process.exit(1);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });
}
