/**
 * Post-build obfuscation script.
 * Obfuscates all .js files in dist/ to protect source code.
 * Preserves .d.ts files (type declarations) untouched.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import JavaScriptObfuscator from 'javascript-obfuscator';

const DIST_DIR = resolve(import.meta.dirname, '../dist');

function getAllJsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...getAllJsFiles(full));
    } else if (full.endsWith('.js') && !full.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

const files = getAllJsFiles(DIST_DIR);
console.log(`[obfuscate] Found ${files.length} JS files to obfuscate`);

let count = 0;
let skipped = 0;
for (const file of files) {
  const code = readFileSync(file, 'utf-8');
  try {
    const result = JavaScriptObfuscator.obfuscate(code, {
    // Medium protection — good balance of security vs performance
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.5,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.2,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false, // Don't rename exports
    selfDefending: false, // Can cause issues in strict mode
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.5,
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
    // Preserve module structure
    target: 'node',
    sourceMap: false,
  });
  writeFileSync(file, result.getObfuscatedCode());
    count++;
  } catch (err) {
    skipped++;
    console.log(`[obfuscate] Skipped (parse error): ${file.replace(DIST_DIR, 'dist')}`);
  }
}

console.log(`[obfuscate] Done. ${count} files obfuscated, ${skipped} skipped.`);
