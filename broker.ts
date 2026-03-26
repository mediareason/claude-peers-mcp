#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  BroadcastRequest,
  MessageStatusRequest,
  MessageStatusResponse,
  MarkReadRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
} from "./shared/types.ts";
import { SYSTEM_PEER_ID } from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// --- Schema migrations ---

try {
  db.run("ALTER TABLE messages ADD COLUMN read INTEGER NOT NULL DEFAULT 0");
} catch {
  // Column already exists
}

// Insert synthetic system peer for disconnect notifications (FK safety)
db.run(`
  INSERT OR IGNORE INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
  VALUES ('system', 0, '/', NULL, NULL, 'System notifications', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
`);

// Clean up stale peers (PIDs that no longer exist) on startup
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    if (peer.id === SYSTEM_PEER_ID) continue;
    try {
      // Check if process is still alive (signal 0 doesn't kill, just checks)
      process.kill(peer.pid, 0);
    } catch {
      // Capture full peer info before deletion for disconnect notification
      const deadPeer = db.query("SELECT * FROM peers WHERE id = ?").get(peer.id) as Peer | null;

      // Process doesn't exist, remove it
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);

      // Broadcast disconnect notification to peers in the same context
      if (deadPeer) {
        const now = new Date().toISOString();
        const text = `[SYSTEM] Peer "${deadPeer.id}" has disconnected.\n` +
          `  Summary: ${deadPeer.summary || "(none)"}\n` +
          `  CWD: ${deadPeer.cwd}\n` +
          `  Git root: ${deadPeer.git_root || "(none)"}\n` +
          `This peer is no longer available. Any pending coordination should be reassessed.`;

        const remaining = deadPeer.git_root
          ? (selectPeersByGitRoot.all(deadPeer.git_root) as Peer[])
          : (selectPeersByDirectory.all(deadPeer.cwd) as Peer[]);

        for (const target of remaining) {
          if (target.id === SYSTEM_PEER_ID || target.id === deadPeer.id) continue;
          insertMessage.run(SYSTEM_PEER_ID, target.id, text, now);
        }
      }
    }
  }
}

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers WHERE id != 'system'
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ? AND id != 'system'
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ? AND id != 'system'
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

const markRead = db.prepare(`
  UPDATE messages SET read = 1 WHERE id = ?
`);

const selectSentMessages = db.prepare(`
  SELECT id, to_id, text, sent_at, delivered, read FROM messages
  WHERE from_id = ? ORDER BY sent_at DESC LIMIT 50
`);

const selectSentMessagesTo = db.prepare(`
  SELECT id, to_id, text, sent_at, delivered, read FROM messages
  WHERE from_id = ? AND to_id = ? ORDER BY sent_at DESC LIMIT 50
`);

// --- Clean stale peers (after prepared statements are ready) ---

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Generate peer ID ---

function generateSuffix(len = 4): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

function generateId(gitRoot: string | null, cwd: string): string {
  // Derive a human-readable base from the repo or directory name
  const source = gitRoot || cwd;
  const basename = source.split("/").filter(Boolean).pop() || "claude";
  // Sanitize: lowercase, replace non-alphanumeric with hyphens, trim hyphens
  const slug = basename.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const base = slug || "claude";

  // Append a short random suffix for uniqueness
  let id = `${base}-${generateSuffix()}`;

  // Ensure no collision with existing peers
  const existing = db.query("SELECT id FROM peers WHERE id = ?");
  let attempts = 0;
  while (existing.get(id) && attempts < 10) {
    id = `${base}-${generateSuffix()}`;
    attempts++;
  }

  return id;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId(body.git_root, body.cwd);
  const now = new Date().toISOString();

  // Remove any existing registration for this PID (re-registration)
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, now, now);
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each peer's process is still alive
  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      // Clean up dead peer
      deletePeer.run(p.id);
      return false;
    }
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  // Verify target exists
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];

  // Mark them as delivered
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

function handleBroadcast(body: BroadcastRequest): { ok: boolean; count: number } {
  // Resolve targets using same scope logic as list_peers
  let peers: Peer[];
  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude sender, verify liveness
  const now = new Date().toISOString();
  let count = 0;
  for (const peer of peers) {
    if (peer.id === body.from_id) continue;
    try {
      process.kill(peer.pid, 0);
      insertMessage.run(body.from_id, peer.id, body.text, now);
      count++;
    } catch {
      deletePeer.run(peer.id);
    }
  }

  return { ok: true, count };
}

function handleMessageStatus(body: MessageStatusRequest): MessageStatusResponse {
  const messages = body.to_id
    ? (selectSentMessagesTo.all(body.from_id, body.to_id) as MessageStatusResponse["messages"])
    : (selectSentMessages.all(body.from_id) as MessageStatusResponse["messages"]);
  return { messages };
}

function handleMarkRead(body: MarkReadRequest): { ok: boolean } {
  // Only mark messages addressed to the requesting peer (security)
  for (const msgId of body.message_ids) {
    db.run(
      "UPDATE messages SET read = 1 WHERE id = ? AND to_id = ?",
      [msgId, body.id]
    );
  }
  return { ok: true };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/broadcast":
          return Response.json(handleBroadcast(body as BroadcastRequest));
        case "/message-status":
          return Response.json(handleMessageStatus(body as MessageStatusRequest));
        case "/mark-read":
          return Response.json(handleMarkRead(body as MarkReadRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[claude-peers broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
