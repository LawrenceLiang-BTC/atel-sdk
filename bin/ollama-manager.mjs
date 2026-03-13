/**
 * Ollama Manager - Auto-start Ollama and ensure model availability
 */

import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const OLLAMA_API = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen2.5:0.5b';

/**
 * Check if Ollama is running
 */
export async function isOllamaRunning() {
  try {
    const response = await fetch(`${OLLAMA_API}/api/tags`, {
      signal: AbortSignal.timeout(2000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Start Ollama service
 */
export async function startOllama() {
  try {
    // Check if ollama is installed
    try {
      await execAsync('which ollama');
    } catch {
      console.error('[Ollama] Not installed. Install with: curl -fsSL https://ollama.com/install.sh | sh');
      return false;
    }
    
    // Check if already running
    if (await isOllamaRunning()) {
      return true;
    }
    
    console.log('[Ollama] Starting service...');
    
    // Start ollama serve in background with proper detachment
    const child = spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    
    // Wait for service to be ready (up to 10 seconds)
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (await isOllamaRunning()) {
        console.log('[Ollama] Service started successfully');
        return true;
      }
    }
    
    console.error('[Ollama] Service failed to start within 10 seconds');
    return false;
  } catch (error) {
    console.error('[Ollama] Failed to start:', error.message);
    return false;
  }
}

/**
 * Check if model is available
 */
export async function hasModel(modelName = DEFAULT_MODEL) {
  try {
    const response = await fetch(`${OLLAMA_API}/api/tags`);
    if (!response.ok) return false;
    
    const data = await response.json();
    return data.models?.some(m => m.name === modelName) || false;
  } catch {
    return false;
  }
}

/**
 * Pull model if not available
 */
export async function ensureModel(modelName = DEFAULT_MODEL) {
  try {
    if (await hasModel(modelName)) {
      return true;
    }
    
    console.log(`[Ollama] Downloading model ${modelName}... (this may take 1-2 minutes)`);
    await execAsync(`ollama pull ${modelName}`, { timeout: 300000 }); // 5 min timeout
    console.log(`[Ollama] Model ${modelName} downloaded successfully`);
    return true;
  } catch (error) {
    console.error(`[Ollama] Failed to download model ${modelName}:`, error.message);
    return false;
  }
}

/**
 * Initialize Ollama: start service and ensure model
 */
export async function initializeOllama(modelName = DEFAULT_MODEL) {
  console.log('[Ollama] Initializing...');
  
  // Check if already running
  if (await isOllamaRunning()) {
    console.log('[Ollama] Service already running');
  } else {
    const started = await startOllama();
    if (!started) {
      console.error('[Ollama] Failed to start service');
      console.error('[Ollama] Please start manually: ollama serve');
      return false;
    }
  }
  
  // Ensure model is available
  console.log(`[Ollama] Checking model ${modelName}...`);
  const hasModelReady = await ensureModel(modelName);
  if (!hasModelReady) {
    console.error(`[Ollama] Model ${modelName} not available`);
    console.error(`[Ollama] Please download manually: ollama pull ${modelName}`);
    return false;
  }
  
  console.log('[Ollama] Ready ✅');
  return true;
}

/**
 * Get Ollama status
 */
export async function getOllamaStatus() {
  const running = await isOllamaRunning();
  if (!running) {
    return {
      running: false,
      models: [],
      api: OLLAMA_API
    };
  }
  
  try {
    const response = await fetch(`${OLLAMA_API}/api/tags`);
    const data = await response.json();
    return {
      running: true,
      models: data.models?.map(m => ({
        name: m.name,
        size: m.size,
        modified: m.modified_at
      })) || [],
      api: OLLAMA_API
    };
  } catch {
    return {
      running: true,
      models: [],
      api: OLLAMA_API
    };
  }
}
