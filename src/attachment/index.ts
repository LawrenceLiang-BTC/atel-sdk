/**
 * Attachment Module - Platform API Version
 * 
 * This module handles rich media attachments (images/files/audio/video)
 * by uploading to ATEL Platform instead of directly to COS.
 */

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import crypto from 'node:crypto';
import type { InlineImage, AttachmentImage, ImageContent, Attachment } from '../envelope/index.js';

// Configuration
export interface AttachmentConfig {
  platformURL: string;           // ATEL Platform URL
  inlineThreshold: number;       // Max size for inline images (bytes)
  maxImages: number;             // Max images per message
  maxAttachments: number;        // Max attachments per message
}

const DEFAULT_CONFIG: AttachmentConfig = {
  platformURL: process.env.ATEL_PLATFORM || 'https://api.atelai.org',
  inlineThreshold: parseInt(process.env.ATEL_IMAGE_INLINE_MAX_SIZE || '262144'), // 256KB
  maxImages: parseInt(process.env.ATEL_MAX_IMAGES_PER_MESSAGE || '9'),
  maxAttachments: parseInt(process.env.ATEL_MAX_ATTACHMENTS_PER_MESSAGE || '5'),
};

let config: AttachmentConfig = DEFAULT_CONFIG;

export function configure(cfg: Partial<AttachmentConfig>) {
  config = { ...config, ...cfg };
}

// Types
export type AttachmentKind = 'image' | 'file' | 'audio' | 'video';

export interface ProcessImageOptions {
  kind: AttachmentKind;
  uploadedBy: string;
  taskId?: string;
}

// MIME type validation
const ALLOWED_MIME_TYPES: Record<AttachmentKind, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
  file: ['application/pdf', 'application/zip', 'text/plain', 'application/json'],
};

export function validateMimeType(kind: AttachmentKind, mimeType: string): boolean {
  const allowed = ALLOWED_MIME_TYPES[kind];
  return allowed.some(t => mimeType.startsWith(t));
}

// File size limits
const MAX_FILE_SIZES: Record<AttachmentKind, number> = {
  image: parseInt(process.env.ATEL_ATTACHMENT_MAX_SIZE_IMAGE || '10485760'),   // 10MB
  audio: parseInt(process.env.ATEL_ATTACHMENT_MAX_SIZE_AUDIO || '52428800'),   // 50MB
  video: parseInt(process.env.ATEL_ATTACHMENT_MAX_SIZE_VIDEO || '524288000'),  // 500MB
  file: parseInt(process.env.ATEL_ATTACHMENT_MAX_SIZE_FILE || '104857600'),    // 100MB
};

export function validateFileSize(kind: AttachmentKind, size: number): boolean {
  return size <= MAX_FILE_SIZES[kind];
}

// Calculate SHA-256 hash
export function calculateHash(filePath: string): string {
  const data = readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  return `sha256:${hash}`;
}

// Process image (auto inline or upload)
export async function processImage(
  filePath: string,
  options: ProcessImageOptions
): Promise<ImageContent> {
  const stats = statSync(filePath);
  const size = stats.size;
  const name = basename(filePath);

  // Detect MIME type (simple detection based on extension)
  const ext = name.split('.').pop()?.toLowerCase();
  const mimeType = getMimeType(ext || '');

  // Validate
  if (!validateMimeType('image', mimeType)) {
    throw new Error(`Invalid image type: ${mimeType}`);
  }

  if (!validateFileSize('image', size)) {
    throw new Error(`Image too large: ${size} bytes (max ${MAX_FILE_SIZES.image})`);
  }

  // Small image: inline as base64
  if (size < config.inlineThreshold) {
    const data = readFileSync(filePath);
    const base64 = data.toString('base64');
    const dataURL = `data:${mimeType};base64,${base64}`;

    return {
      kind: 'inline',
      name,
      mimeType,
      size,
      data: dataURL,
    };
  }

  // Large image: upload to platform
  return uploadAttachment(filePath, options) as Promise<AttachmentImage>;
}

// Upload attachment to platform
export async function uploadAttachment(
  filePath: string,
  options: ProcessImageOptions
): Promise<Attachment | AttachmentImage> {
  const stats = statSync(filePath);
  const size = stats.size;
  const name = basename(filePath);
  const ext = name.split('.').pop()?.toLowerCase();
  const mimeType = getMimeType(ext || '');

  // Validate
  if (!validateMimeType(options.kind, mimeType)) {
    throw new Error(`Invalid ${options.kind} type: ${mimeType}`);
  }

  if (!validateFileSize(options.kind, size)) {
    throw new Error(`File too large: ${size} bytes (max ${MAX_FILE_SIZES[options.kind]})`);
  }

  // Calculate hash
  const hash = calculateHash(filePath);

  // Upload to platform (use native FormData + Blob for Node 18+ fetch compatibility)
  const form = new FormData();
  const blob = new Blob([readFileSync(filePath)], { type: mimeType });
  form.append('file', blob, name);
  form.append('kind', options.kind);
  form.append('uploadedBy', options.uploadedBy);
  if (options.taskId) {
    form.append('taskId', options.taskId);
  }

  const response = await fetch(`${config.platformURL}/attachment/v1/upload`, {
    method: 'POST',
    body: form as any,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(`Upload failed: ${error.error || response.statusText}`);
  }

  const result = await response.json();

  // Return formatted response
  if (options.kind === 'image') {
    return {
      kind: 'attachment',
      attachmentId: result.attachmentId,
      name: result.name,
      mimeType: result.mimeType,
      size: result.size,
      hash: result.hash,
      downloadUrl: result.downloadUrl,
      urlExpiresAt: result.urlExpiresAt,
    } as AttachmentImage;
  }

  return {
    kind: options.kind as 'file' | 'audio' | 'video',
    attachmentId: result.attachmentId,
    name: result.name,
    mimeType: result.mimeType,
    size: result.size,
    hash: result.hash,
    downloadUrl: result.downloadUrl,
    urlExpiresAt: result.urlExpiresAt,
  } as Attachment;
}

// Helper: Get MIME type from extension
function getMimeType(ext: string): string {
  const types: Record<string, string> = {
    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    // Audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    // Video
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    // Files
    pdf: 'application/pdf',
    zip: 'application/zip',
    txt: 'text/plain',
    json: 'application/json',
  };

  return types[ext] || 'application/octet-stream';
}
