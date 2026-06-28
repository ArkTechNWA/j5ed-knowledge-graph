import { promises as fs } from 'fs';
import path from 'path';
import { KnowledgeGraph, Entity, Relation } from '../types/graph.js';
import { config } from '../utils/config.js';

/**
 * Storage service for persisting and retrieving knowledge graph data
 */
export class StorageService {
  private static readonly MAX_BACKUPS = 5;
  private memoryFilePath: string;

  constructor(filePath?: string) {
    this.memoryFilePath = filePath || config.memoryFilePath;
  }

  private async rotateBackups(dirPath: string): Promise<void> {
    try {
      await fs.access(this.memoryFilePath);
    } catch {
      return;
    }

    try {
      const backupName = `${path.basename(this.memoryFilePath)}.bak.${Date.now()}`;
      await fs.copyFile(this.memoryFilePath, path.join(dirPath, backupName));

      const files = await fs.readdir(dirPath);
      const backups = files
        .filter(f => f.startsWith(`${path.basename(this.memoryFilePath)}.bak.`))
        .sort()
        .reverse();

      for (const old of backups.slice(StorageService.MAX_BACKUPS)) {
        await fs.unlink(path.join(dirPath, old));
      }
    } catch (err) {
      console.error('Backup rotation error (non-fatal):', err);
    }
  }

  /**
   * Load knowledge graph from the file system
   * Creates an empty graph if file doesn't exist
   */
  public async loadGraph(): Promise<KnowledgeGraph> {
    try {
      const data = await fs.readFile(this.memoryFilePath, 'utf-8');
      const lines = data.split('\n').filter(line => line.trim() !== '');

      return lines.reduce((graph: KnowledgeGraph, line) => {
        try {
          const item = JSON.parse(line);
          if (item.type === 'entity') {
            const { type: _type, ...entity } = item;
            graph.entities.push(entity as Entity);
          }
          if (item.type === 'relation') {
            const { type: _type, ...relation } = item;
            graph.relations.push(relation as Relation);
          }
        } catch (parseError) {
          console.error('Error parsing line in memory file:', parseError);
        }
        return graph;
      }, { entities: [], relations: [] });
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as any).code === 'ENOENT') {
        return { entities: [], relations: [] };
      }
      throw error;
    }
  }

  /**
   * Save knowledge graph to the file system
   */
  public async saveGraph(graph: KnowledgeGraph): Promise<void> {
    const lines = [
      ...graph.entities.map(e => JSON.stringify({ type: 'entity', ...e })),
      ...graph.relations.map(r => JSON.stringify({ type: 'relation', ...r })),
    ];

    try {
      const dirPath = this.memoryFilePath.substring(0, this.memoryFilePath.lastIndexOf('/'));
      await fs.mkdir(dirPath, { recursive: true });
      await this.rotateBackups(dirPath);

      await fs.writeFile(this.memoryFilePath, lines.join('\n'));
    } catch (error) {
      console.error('Error saving graph to file:', error);
      throw error;
    }
  }
}
