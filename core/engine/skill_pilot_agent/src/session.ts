import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentInputItem } from '@openai/agents-core';

const SESSIONS_DIR = path.join(os.homedir(), '.spcode', 'sessions');
const INDEX_FILE = path.join(SESSIONS_DIR, 'index.json');

interface SessionIndex {
  sessions: { id: string; created: string; preview: string }[];
}

function ensureDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function readIndex(): SessionIndex {
  ensureDir();
  if (!fs.existsSync(INDEX_FILE)) return { sessions: [] };
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return { sessions: [] };
  }
}

function writeIndex(index: SessionIndex): void {
  ensureDir();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
}

function sanitizeId(id: string): string {
  // Allow only alphanumeric, dashes, and underscores in session IDs
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function sessionPath(id: string): string {
  return path.join(SESSIONS_DIR, `${sanitizeId(id)}.json`);
}

export function saveSession(id: string, items: AgentInputItem[]): void {
  ensureDir();
  fs.writeFileSync(sessionPath(id), JSON.stringify(items, null, 2), 'utf8');

  const index = readIndex();
  const existing = index.sessions.find((s) => s.id === id);
  const preview = extractPreview(items);

  if (existing) {
    existing.preview = preview;
  } else {
    index.sessions.unshift({
      id,
      created: new Date().toISOString(),
      preview,
    });
  }

  writeIndex(index);
  console.log(`Session saved: ${id}`);
}

export function loadSession(id: string): AgentInputItem[] | null {
  const filePath = sessionPath(id);
  if (!fs.existsSync(filePath)) {
    console.log(`Session not found: ${id}`);
    return null;
  }
  try {
    const items = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`Session loaded: ${id} (${items.length} items)`);
    return items;
  } catch {
    console.log(`Failed to read session: ${id}`);
    return null;
  }
}

export function listSessions(): void {
  const index = readIndex();
  if (index.sessions.length === 0) {
    console.log('No saved sessions.');
    return;
  }
  console.log('Saved sessions:');
  for (const s of index.sessions) {
    console.log(`  ${s.id} — ${s.preview} (${s.created})`);
  }
}

export function forkSession(sourceId: string, newId?: string): string | null {
  const sourcePath = sessionPath(sourceId);
  if (!fs.existsSync(sourcePath)) {
    console.log(`Session not found: ${sourceId}`);
    return null;
  }
  const forkId = newId || `${sourceId}-fork-${Date.now()}`;
  const items = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  fs.writeFileSync(sessionPath(forkId), JSON.stringify(items, null, 2), 'utf8');

  const index = readIndex();
  index.sessions.unshift({
    id: forkId,
    created: new Date().toISOString(),
    preview: extractPreview(items),
  });
  writeIndex(index);
  console.log(`Session forked: ${sourceId} -> ${forkId}`);
  return forkId;
}

function extractPreview(items: AgentInputItem[]): string {
  for (const item of items) {
    const msg = item as any;
    if (msg.type === 'message' && msg.role === 'user' && msg.content) {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      return text.substring(0, 80).replace(/\n/g, ' ');
    }
  }
  return '(empty)';
}
