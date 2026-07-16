/**
 * Ollama embedding client for ambient recall.
 * Calls the local Ollama instance to generate embeddings.
 * Best-effort — errors are thrown, caller decides retry/skip policy.
 */

export interface EmbedResponse {
  embeddings: number[][];
}

export class OllamaEmbedder {
  constructor(
    private url: string,
    private model: string,
    private dim: number,
    private timeoutMs: number = 10_000,
  ) {}

  /**
   * Embed a single text string. Returns a Buffer (Float32Array backing)
   * ready for sqlite-vec insertion.
   */
  async embed(text: string): Promise<Buffer> {
    const embeddings = await this.embedBatch([text]);
    return embeddings[0];
  }

  /**
   * Embed multiple texts in a single Ollama call.
   * Returns an array of Buffers, one per input text.
   */
  async embedBatch(texts: string[]): Promise<Buffer[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.url}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Ollama embed failed: ${response.status} ${body}`);
      }

      const data = await response.json() as EmbedResponse;

      if (!data.embeddings || data.embeddings.length !== texts.length) {
        throw new Error(`Ollama returned ${data.embeddings?.length ?? 0} embeddings for ${texts.length} inputs`);
      }

      return data.embeddings.map(emb => {
        if (emb.length !== this.dim) {
          throw new Error(`Expected ${this.dim}-dim embedding, got ${emb.length}`);
        }
        return Buffer.from(new Float32Array(emb).buffer);
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Health check — try to embed a single token.
   */
  async ping(): Promise<boolean> {
    try {
      await this.embed('ping');
      return true;
    } catch {
      return false;
    }
  }
}
