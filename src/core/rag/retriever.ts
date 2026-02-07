import { AgentDB } from '../state/db';
import { LLMProvider } from '../llm/provider';
import { cosineSimilarity } from './math';
import { ProcessedChunk } from '../types';
import * as path from 'path';
interface SearchResult {
  chunk: ProcessedChunk;
  score: number;
}

interface FileContext {
  filePath: string;
  relevance: number;
  chunks: ProcessedChunk[];
  imports: string[];
  skeleton?: string; // <--- ADDED
}

export class RetrieverService {
  private db = AgentDB.getInstance();

  /**
   * Searches the codebase using Vector Embeddings (Cosine Similarity).
   * @param query - The natural language query.
   * @param limit - Max chunks to retrieve.
   */
  public async query(
    query: string,
    limit: number = 5,
  ): Promise<SearchResult[]> {
    console.log(`🔍 [RAG] Embedding Query: "${query}"...`);

    const embeddingModel = LLMProvider.getEmbeddingsModel();
    const queryVector = await embeddingModel.embedQuery(query);

    const stmt = this.db.prepare('SELECT * FROM code_chunks');
    const rows = stmt.all() as any[];

    const scoredChunks: SearchResult[] = rows.map((row) => {
      const vector = JSON.parse(row.vector_json);
      const score = cosineSimilarity(queryVector, vector);
      const metadata = JSON.parse(row.metadata);

      return {
        score,
        chunk: {
          id: row.id,
          type: row.chunk_type,
          content: row.content,
          metadata: metadata,
          // Ensure filePath is recovered from the DB row or metadata
          filePath: row.file_path || metadata.filePath,
        } as ProcessedChunk,
      };
    });

    return scoredChunks.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Retrieves the 'Skeleton' (Signatures) for a file from the registry.
   */
  private getFileSkeleton(sourcePath: string): string | undefined {
    const normalizedPath = sourcePath.split(path.sep).join('/');
    try {
      const stmt = this.db.prepare(
        'SELECT skeleton_signature FROM file_registry WHERE path = ? OR path = ?',
      );
      const result = stmt.get(normalizedPath, sourcePath) as any;
      return result?.skeleton_signature;
    } catch (error) {
      console.error(`Error fetching skeleton for ${sourcePath}:`, error);
      return undefined;
    }
  }

  /**
   * Retrieves the 'Graph Dependencies' for a specific file from the DB.
   * This allows the Agent to know what other files are related (DTOs, Interfaces).
   */
  private getDependencies(sourcePath: string): string[] {
    // 1. IMPORTANTE: Normalizar la ruta para que coincida con lo guardado en DB
    // Esto convierte "src\module\..." a "src/module/..."
    const normalizedPath = sourcePath.split(path.sep).join('/');
    try {
      // 2. Consultar la tabla dependency_graph que definiste en AgentDB
      // Buscamos todo lo que este archivo (source) importa (target)
      const stmt = this.db.prepare(`
            SELECT target 
            FROM dependency_graph 
            WHERE source = ? OR source = ?
        `);

      // Probamos con la ruta normalizada y la original por si acaso
      const results = stmt.all(normalizedPath, sourcePath) as {
        target: string;
      }[];

      // 3. Devolver solo los strings de los targets
      return results.map((row) => row.target);
    } catch (error) {
      console.error(`Error fetching dependencies for ${sourcePath}:`, error);
      return [];
    }
  }

  /**
   * Generates a Rich Context Report for the LLM.
   * It combines:
   * 1. The matched code snippets (Vector Search).
   * 2. The file's dependencies (Graph Search).
   * 3. Explicit File Paths to encourage using 'read_file'.
   */
  public async getContextForLLM(query: string): Promise<string> {
    const results = await this.query(query, 4);

    // Group chunks by File to provide a structured view
    const filesMap = new Map<string, FileContext>();

    for (const res of results) {
      const path = res.chunk.filePath || 'unknown';
      // console.log(res);
      // console.log(path);
      // console.log(this.getDependencies(path));
      if (!filesMap.has(path)) {
        filesMap.set(path, {
          filePath: path,
          relevance: res.score,
          chunks: [],
          imports: this.getDependencies(path), // <--- GRAPH MAGIC 🕸️
          skeleton: this.getFileSkeleton(path), // <--- STRUCTURAL MAGIC 🏗️
        });
      }
      filesMap.get(path)?.chunks.push(res.chunk);
    }

    // Build the formatted string
    let output = `🔎 **RAG ANALYSIS REPORT**\n`;
    output += `Query: "${query}"\n`;
    output += `Found ${filesMap.size} relevant files.\n\n`;

    filesMap.forEach((fileCtx) => {
      const relevancePct = (fileCtx.relevance * 100).toFixed(1);

      output += `=================================================================\n`;
      output += `📂 **FILE:** ${fileCtx.filePath}\n`;
      output += `📊 **RELEVANCE:** ${relevancePct}%\n`;

      if (fileCtx.imports.length > 0) {
        output += `🔗 **DEPENDENCIES (Imports):**\n`;
        // Show top 5 imports to give context on DTOs/Entities used
        fileCtx.imports
          .slice(0, 5)
          .forEach((imp) => (output += `   - ${imp}\n`));
        if (fileCtx.imports.length > 5)
          output += `   - (...and ${fileCtx.imports.length - 5} more)\n`;
      }

      if (fileCtx.skeleton) {
        output += `🏗️ **FILE SKELETON (MAP):**\n${fileCtx.skeleton}\n\n`;
      }

      output += `📝 **CODE SNIPPETS:**\n`;
      fileCtx.chunks.forEach((chunk) => {
        output += `   --- [${chunk.metadata.methodName || 'Class Structure'}] ---\n`;
        output += `${chunk.content.trim()}\n\n`;
      });

      output += `💡 **AGENT HINT:** To edit this file or see full imports, run: read_file("${fileCtx.filePath}")\n`;
      output += `=================================================================\n\n`;
    });
    // console.log(output);

    return output;
  }
}
