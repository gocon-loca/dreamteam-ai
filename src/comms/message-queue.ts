/**
 * Message Queue - Communication between orchestrator, project agents, and user
 *
 * All parties communicate through JSON files:
 * - inbox.json: Messages TO the orchestrator
 * - outbox.json: Messages FROM the orchestrator to user
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const DATA_DIR = resolve(process.cwd(), 'data');
const INBOX_PATH = resolve(DATA_DIR, 'inbox.json');
const OUTBOX_PATH = resolve(DATA_DIR, 'outbox.json');

export interface Message {
  id: string;
  timestamp: string;
  from: 'user' | 'orchestrator' | string; // string = project agent name
  to: 'orchestrator' | 'user' | string;
  type: 'chat' | 'status' | 'help' | 'progress' | 'blocked' | 'complete';
  content: string;
  metadata?: Record<string, any>;
  read?: boolean;
}

interface MessageQueue {
  messages: Message[];
  lastUpdated: string;
}

function loadQueue(path: string): MessageQueue {
  if (!existsSync(path)) {
    return { messages: [], lastUpdated: new Date().toISOString() };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { messages: [], lastUpdated: new Date().toISOString() };
  }
}

function saveQueue(path: string, queue: MessageQueue): void {
  queue.lastUpdated = new Date().toISOString();
  writeFileSync(path, JSON.stringify(queue, null, 2));
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// === INBOX (messages TO orchestrator) ===

export function sendToOrchestrator(
  from: string,
  type: Message['type'],
  content: string,
  metadata?: Record<string, any>
): Message {
  const queue = loadQueue(INBOX_PATH);
  const message: Message = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    from,
    to: 'orchestrator',
    type,
    content,
    metadata,
    read: false,
  };
  queue.messages.push(message);
  saveQueue(INBOX_PATH, queue);
  return message;
}

export function getUnreadInbox(): Message[] {
  const queue = loadQueue(INBOX_PATH);
  return queue.messages.filter(m => !m.read);
}

export function markInboxRead(messageIds: string[]): void {
  const queue = loadQueue(INBOX_PATH);
  for (const msg of queue.messages) {
    if (messageIds.includes(msg.id)) {
      msg.read = true;
    }
  }
  saveQueue(INBOX_PATH, queue);
}

export function getRecentInbox(count = 20): Message[] {
  const queue = loadQueue(INBOX_PATH);
  return queue.messages.slice(-count);
}

// === OUTBOX (messages FROM orchestrator to user) ===

export function sendToUser(content: string, metadata?: Record<string, any>): Message {
  const queue = loadQueue(OUTBOX_PATH);
  const message: Message = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    from: 'orchestrator',
    to: 'user',
    type: 'chat',
    content,
    metadata,
    read: false,
  };
  queue.messages.push(message);
  saveQueue(OUTBOX_PATH, queue);
  return message;
}

export function getUnreadOutbox(): Message[] {
  const queue = loadQueue(OUTBOX_PATH);
  return queue.messages.filter(m => !m.read);
}

export function markOutboxRead(messageIds: string[]): void {
  const queue = loadQueue(OUTBOX_PATH);
  for (const msg of queue.messages) {
    if (messageIds.includes(msg.id)) {
      msg.read = true;
    }
  }
  saveQueue(OUTBOX_PATH, queue);
}

// === Helper for project agents ===

export function agentCheckIn(
  projectName: string,
  status: 'progress' | 'blocked' | 'complete' | 'help',
  message: string,
  metadata?: Record<string, any>
): Message {
  return sendToOrchestrator(projectName, status, message, {
    project: projectName,
    ...metadata,
  });
}

export function agentNeedsHelp(
  projectName: string,
  problem: string,
  context?: string
): Message {
  return sendToOrchestrator(projectName, 'help', problem, {
    project: projectName,
    context,
  });
}

// === Status ===

export function getQueueStatus(): {
  inbox: { total: number; unread: number };
  outbox: { total: number; unread: number };
} {
  const inbox = loadQueue(INBOX_PATH);
  const outbox = loadQueue(OUTBOX_PATH);
  return {
    inbox: {
      total: inbox.messages.length,
      unread: inbox.messages.filter(m => !m.read).length,
    },
    outbox: {
      total: outbox.messages.length,
      unread: outbox.messages.filter(m => !m.read).length,
    },
  };
}
