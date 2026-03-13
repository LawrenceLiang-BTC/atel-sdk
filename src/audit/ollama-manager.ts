/**
 * Ollama Manager - Manages node-llama-cpp for local inference
 * 
 * Automatically downloads and loads GGUF models for audit tasks.
 * No external dependencies required (no Ollama installation needed).
 */

import { getLlama, Llama, LlamaModel, LlamaContext, LlamaChatSession } from 'node-llama-cpp';
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';

// ─── Constants ──────────────────────────────────────────────

const DEFAULT_MODEL_URL = 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_0.gguf';
const DEFAULT_MODEL_NAME = 'qwen2.5-0.5b-instruct-q4_0.gguf';
const MODELS_DIR = '.atel/models';

// ─── Ollama Manager ─────────────────────────────────────────

export class OllamaManager {
  private llama?: Llama;
  private model?: LlamaModel;
  private context?: LlamaContext;
  private session?: LlamaChatSession;
  private modelPath: string;
  private modelUrl: string;
  private log: (message: string) => void;

  constructor(config: {
    modelPath?: string;
    modelUrl?: string;
    log?: (message: string) => void;
  } = {}) {
    const modelsDir = join(process.cwd(), MODELS_DIR);
    this.modelPath = config.modelPath || join(modelsDir, DEFAULT_MODEL_NAME);
    this.modelUrl = config.modelUrl || DEFAULT_MODEL_URL;
    this.log = config.log || ((msg) => console.log(`[Ollama Manager] ${msg}`));
  }

  /**
   * Initialize the model (download if needed, then load)
   */
  async initialize(): Promise<void> {
    try {
      // 1. Ensure model exists (download if needed)
      await this.ensureModel();

      // 2. Load model
      this.log('Loading model...');
      this.llama = await getLlama();
      this.model = await this.llama.loadModel({
        modelPath: this.modelPath,
      });

      // 3. Create context
      this.context = await this.model.createContext({
        contextSize: 2048,
      });

      // 4. Create chat session
      this.session = new LlamaChatSession({
        contextSequence: this.context.getSequence(),
      });

      this.log('✅ Model ready');
    } catch (error: any) {
      this.log(`❌ Failed to initialize: ${error.message}`);
      throw error;
    }
  }

  /**
   * Ensure model file exists (download if needed)
   */
  private async ensureModel(): Promise<void> {
    if (existsSync(this.modelPath)) {
      this.log('Model already downloaded');
      return;
    }

    this.log('📦 Downloading model (first time only, ~400MB)...');
    this.log('   This may take a few minutes...');
    
    await this.downloadModel();
  }

  /**
   * Download model from HuggingFace
   */
  private async downloadModel(): Promise<void> {
    // Create directory
    mkdirSync(dirname(this.modelPath), { recursive: true });

    try {
      const response = await fetch(this.modelUrl);
      
      if (!response.ok) {
        throw new Error(`Failed to download model: ${response.statusText}`);
      }

      const total = parseInt(response.headers.get('content-length') || '0');
      let downloaded = 0;
      let lastProgress = 0;

      const fileStream = createWriteStream(this.modelPath);

      // @ts-ignore - ReadableStream types
      for await (const chunk of response.body) {
        fileStream.write(chunk);
        downloaded += chunk.length;

        // Show progress every 5%
        if (total > 0) {
          const progress = Math.floor((downloaded / total) * 100);
          if (progress >= lastProgress + 5) {
            const mb = (downloaded / 1024 / 1024).toFixed(1);
            const totalMb = (total / 1024 / 1024).toFixed(1);
            this.log(`   Progress: ${progress}% (${mb}/${totalMb} MB)`);
            lastProgress = progress;
          }
        }
      }

      fileStream.end();
      this.log('✅ Model downloaded successfully');
    } catch (error: any) {
      // Clean up partial download
      if (existsSync(this.modelPath)) {
        const fs = await import('node:fs/promises');
        await fs.unlink(this.modelPath);
      }
      throw error;
    }
  }

  /**
   * Generate text completion
   */
  async generate(prompt: string): Promise<string> {
    if (!this.session) {
      throw new Error('Model not initialized. Call initialize() first.');
    }

    try {
      const response = await this.session.prompt(prompt, {
        maxTokens: 512,
        temperature: 0.7,
      });

      return response;
    } catch (error: any) {
      this.log(`Generation failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    if (this.context) {
      await this.context.dispose();
      this.context = undefined;
    }
    if (this.model) {
      await this.model.dispose();
      this.model = undefined;
    }
    this.session = undefined;
    this.llama = undefined;
  }

  /**
   * Check if model is ready
   */
  isReady(): boolean {
    return !!this.session;
  }
}
