import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEvent, type PlukEvent } from './event.js';
import { resolveRunDir } from './run-dir.js';
import { tmuxListSessionNames } from './tmux.js';
import { sanitizeField } from './ansi.js';

// Re-exported for existing consumers; the sanitizer now lives in ansi.ts so
// every module that prints untrusted log-derived text shares one definition.
export { sanitizeField } from './ansi.js';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const MAX_TAIL_LINES = 100;

export interface SessionInfo {
  session: string;
  cli: string;
  state: string;
  lastActivity: string;
  lastActivityAgo: string;
  eventCount: number;
  logFile: string;
  tmuxAlive: boolean;
}

function readLastEvents(filePath: string, maxEvents: number): PlukEvent[] {
  const events: PlukEvent[] = [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    let nonRawLines = 0;
    let latestActivity: PlukEvent | undefined;
    let latestCli: PlukEvent | undefined;

    for (let i = lines.length - 1; i >= 0 && nonRawLines < MAX_TAIL_LINES; i--) {
      const event = parseEvent(lines[i]);
      if (!event) continue;

      latestActivity ??= event;
      if (!latestCli && event.data['cli'] && event.data['cli'] !== 'unknown') {
        latestCli = event;
      }

      if (event.type === 'raw_output') continue;
      nonRawLines++;
      if (events.length < maxEvents) events.unshift(event);
    }

    // Raw output is frequent and carries little summary metadata. Keep only the
    // latest activity and CLI marker while counting the tail limit on other
    // event types, so terminal output cannot evict state changes from the view.
    if (latestCli && !events.includes(latestCli)) events.push(latestCli);
    if (latestActivity && !events.includes(latestActivity)) events.push(latestActivity);
    events.sort((a, b) => a.ts.localeCompare(b.ts));
  } catch {
    // file unreadable
  }
  return events;
}

function formatAgo(isoTimestamp: string): string {
  const diff = Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 1000);
  if (diff < 0) return 'just now';
  if (diff < SECONDS_PER_MINUTE) return `${diff}s ago`;
  if (diff < SECONDS_PER_HOUR) return `${Math.floor(diff / SECONDS_PER_MINUTE)}m ago`;
  if (diff < SECONDS_PER_DAY) return `${Math.floor(diff / SECONDS_PER_HOUR)}h ago`;
  return `${Math.floor(diff / SECONDS_PER_DAY)}d ago`;
}

function getTmuxSessions(): Set<string> {
  const sessions = new Set<string>();
  try {
    for (const name of tmuxListSessionNames()) {
      sessions.add(name);
    }
  } catch {
    // tmux not running or not installed
  }
  return sessions;
}

function countEvents(filePath: string): number {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return content.split('\n').filter(l => l.trim() && parseEvent(l) !== null).length;
  } catch {
    return 0;
  }
}

export function discoverSessions(runDir?: string): SessionInfo[] {
  const dir = resolveRunDir(runDir);
  const logsDir = join(dir, 'logs');

  let files: string[];
  try {
    files = readdirSync(logsDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const tmuxSessions = getTmuxSessions();
  const results: SessionInfo[] = [];
  const MAX_TAIL_EVENTS = 50;

  for (const file of files) {
    const session = sanitizeField(file.replace('.jsonl', ''));
    const filePath = join(logsDir, file);
    const events = readLastEvents(filePath, MAX_TAIL_EVENTS);

    if (events.length === 0) continue;

    let cli = 'unknown';
    let state = 'unknown';
    let lastTs = '';

    for (const e of events) {
      if (e.ts > lastTs) lastTs = e.ts;

      if (e.data['cli'] && e.data['cli'] !== 'unknown') {
        cli = sanitizeField(e.data['cli']);
      }

      if (e.type === 'state_change') {
        state = sanitizeField(e.data['to'] ?? 'unknown');
      }
    }

    results.push({
      session,
      cli,
      state,
      lastActivity: lastTs,
      lastActivityAgo: lastTs ? formatAgo(lastTs) : 'unknown',
      eventCount: countEvents(filePath),
      logFile: filePath,
      tmuxAlive: tmuxSessions.has(session),
    });
  }

  results.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return results;
}
