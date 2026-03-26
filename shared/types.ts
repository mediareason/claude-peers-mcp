// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

// Synthetic peer ID used for system notifications (disconnect alerts, etc.)
export const SYSTEM_PEER_ID: PeerId = "system";

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
  read: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface BroadcastRequest {
  from_id: PeerId;
  scope: "machine" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  text: string;
}

export interface MessageStatusRequest {
  from_id: PeerId;
  to_id?: PeerId; // Optional: filter to messages sent to a specific peer
}

export interface MessageStatusResponse {
  messages: Array<{
    id: number;
    to_id: PeerId;
    text: string;
    sent_at: string;
    delivered: boolean;
    read: boolean;
  }>;
}

export interface MarkReadRequest {
  id: PeerId; // the reader's peer ID
  message_ids: number[];
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}
