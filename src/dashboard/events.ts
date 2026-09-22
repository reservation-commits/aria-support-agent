import { EventEmitter } from "node:events";

/**
 * In-process pub-sub used by the live log stream (SSE).
 * Events are best-effort; we keep at most LAST_N in a ring buffer so the
 * dashboard's "Logs ao vivo" panel hydrates with recent activity on open.
 */
export type AriaEvent =
  | { kind: "message_in";    chat: string; name: string | null; text: string; at: string }
  | { kind: "message_out";   chat: string; text: string; at: string }
  | { kind: "tool_call";     chat: string | null; tool: string; success: boolean; latency_ms: number; at: string }
  | { kind: "escalation";    chat: string | null; tag: string; summary: string; at: string }
  | { kind: "error";         where: string; message: string; at: string }
  | { kind: "health_check";  overall_ok: boolean; db_ok: boolean; whatsapp_ok: boolean; anthropic_ok?: boolean; at: string }
  | { kind: "test_run";      passed: number; failed: number; total: number; at: string }
  | { kind: "suggestion_new"; title: string; category: string; priority: string; at: string }
  | { kind: "scope_blocked"; chat: string; channel: string; sender: string | null; subject: string | null; reason: string; layer: string; at: string };

const LAST_N = 100;
const ring: AriaEvent[] = [];

export const events = new EventEmitter();
events.setMaxListeners(50);

export function publish(ev: AriaEvent): void {
  ring.push(ev);
  if (ring.length > LAST_N) ring.shift();
  events.emit("event", ev);
}

export function recentEvents(): AriaEvent[] {
  return ring.slice();
}
