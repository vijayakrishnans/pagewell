import { LEASE_TTL_MS, type RoomEvent } from "@saas/contracts/review";
import type { Env } from "./env.js";

// DocRoom (PW5): one Durable Object per document, named "<orgId>:<docId>". Everyone with the
// document open in the editor is connected here over a WebSocket (hibernatable, so an idle room
// costs nothing). It keeps who is here, who holds the edit lease, and fans out new comments and
// new-version notices.
//
// Joining takes a ticket: the worker checks the person's access to the document as the drive
// sees it, then asks the room for a single-use ticket that lives 60 seconds; the browser opens
// the WebSocket with it. A browser cannot send an Authorization header on a WebSocket, and this
// keeps the session token out of URLs (OWASP A07). Only the worker reaches the room's
// /ticket and /broadcast; from outside, only /connect with a ticket gets through.
//
// The lease: whoever may edit takes it; it lasts LEASE_TTL_MS unless renewed; it is released on
// leave; someone who may share the document can break it. It belongs to one connection, so the
// same person in two tabs edits in one.

export interface Person {
  id: string;
  name: string | null;
  canEdit: boolean;
  canBreak: boolean;
}

export interface Attachment extends Person {
  conn: string;
}

interface Lease {
  conn: string;
  id: string;
  name: string | null;
  expiresAt: number;
}

const TICKET_TTL_MS = 60_000;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class DocRoom implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    void this.env;
  }

  private sockets(): Array<{ ws: WebSocket; who: Attachment }> {
    return this.state.getWebSockets().flatMap((ws) => {
      const who = ws.deserializeAttachment() as Attachment | null;
      return who ? [{ ws, who }] : [];
    });
  }

  private send(ws: WebSocket, event: RoomEvent) {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      /* closing */
    }
  }

  private broadcast(event: RoomEvent, except?: WebSocket) {
    for (const { ws } of this.sockets()) if (ws !== except) this.send(ws, event);
  }

  private async lease(): Promise<Lease | null> {
    const l = (await this.state.storage.get<Lease>("lease")) ?? null;
    if (l && l.expiresAt <= Date.now()) {
      await this.state.storage.delete("lease");
      return null;
    }
    return l;
  }

  private leaseEvent(l: Lease | null, conn?: string): RoomEvent {
    return { type: "lease", holder: l ? { id: l.id, name: l.name } : null, expiresAt: l ? new Date(l.expiresAt).toISOString() : null, mine: Boolean(l && conn && l.conn === conn) };
  }

  /** The lease to everyone, each told whether it is theirs (one person can be in two tabs). */
  private broadcastLease(l: Lease | null) {
    for (const { ws, who } of this.sockets()) this.send(ws, this.leaseEvent(l, who.conn));
  }

  private async presence(): Promise<RoomEvent> {
    const l = await this.lease();
    const seen = new Map<string, { id: string; name: string | null; editing: boolean }>();
    for (const { who } of this.sockets()) {
      const prev = seen.get(who.id);
      seen.set(who.id, { id: who.id, name: who.name, editing: Boolean(prev?.editing) || l?.conn === who.conn });
    }
    return { type: "presence", people: [...seen.values()] };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/ticket") {
      const person = (await request.json()) as Person;
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const ticket = b64url(bytes);
      await this.state.storage.put(`ticket:${await sha256Hex(ticket)}`, { person, expiresAt: Date.now() + TICKET_TTL_MS });
      return Response.json({ ticket, expiresAt: new Date(Date.now() + TICKET_TTL_MS).toISOString() });
    }
    if (request.method === "POST" && url.pathname === "/broadcast") {
      this.broadcast((await request.json()) as RoomEvent);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/connect") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket", { status: 426 });
      const who = await this.admit(url.searchParams.get("ticket") ?? "");
      if (!who) return new Response("not found", { status: 404 });
      const pair = new WebSocketPair();
      await this.join(pair[1], who);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not found", { status: 404 });
  }

  /** The person a ticket admits, once: a ticket is deleted when it is used, whatever happens next. */
  async admit(ticket: string): Promise<Attachment | null> {
    const key = `ticket:${await sha256Hex(ticket)}`;
    const stored = await this.state.storage.get<{ person: Person; expiresAt: number }>(key);
    await this.state.storage.delete(key);
    if (!stored || stored.expiresAt <= Date.now()) return null;
    return { ...stored.person, conn: crypto.randomUUID() };
  }

  /** Take an admitted person's socket into the room: they get the lease state, everyone the presence. */
  async join(server: WebSocket, who: Attachment): Promise<void> {
    this.state.acceptWebSocket(server);
    server.serializeAttachment(who);
    this.send(server, { type: "hello", you: { id: who.id, name: who.name }, canEdit: who.canEdit, canBreak: who.canBreak });
    this.send(server, this.leaseEvent(await this.lease(), who.conn));
    this.broadcast(await this.presence());
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const who = ws.deserializeAttachment() as Attachment | null;
    if (!who || typeof message !== "string" || message.length > 2048) return;
    let cmd: { type?: string; version?: number };
    try {
      cmd = JSON.parse(message) as { type?: string; version?: number };
    } catch {
      return;
    }
    const now = Date.now();
    const current = await this.lease();
    switch (cmd.type) {
      case "lease.take":
      case "lease.renew": {
        if (!who.canEdit) return this.send(ws, this.leaseEvent(current, who.conn));
        if (current && current.conn !== who.conn) return this.send(ws, this.leaseEvent(current, who.conn));
        if (!current && cmd.type === "lease.renew") return this.send(ws, this.leaseEvent(null, who.conn));
        const next: Lease = { conn: who.conn, id: who.id, name: who.name, expiresAt: now + LEASE_TTL_MS };
        await this.state.storage.put("lease", next);
        await this.state.storage.setAlarm(next.expiresAt);
        if (!current) {
          this.broadcastLease(next);
          this.broadcast(await this.presence());
        } else this.send(ws, this.leaseEvent(next, who.conn));
        return;
      }
      case "lease.release":
        if (current?.conn === who.conn) await this.clearLease();
        return;
      case "lease.break":
        if (who.canBreak && current) await this.clearLease();
        else this.send(ws, this.leaseEvent(current, who.conn));
        return;
      case "version":
        // A save by whoever holds the lease: everyone else learns there is a newer version.
        if (current?.conn === who.conn && Number.isInteger(cmd.version) && (cmd.version as number) > 0) {
          this.broadcast({ type: "version", version: cmd.version as number, by: who.name }, ws);
        }
        return;
      case "ping":
        return;
    }
  }

  private async clearLease() {
    await this.state.storage.delete("lease");
    await this.state.storage.deleteAlarm();
    this.broadcastLease(null);
    this.broadcast(await this.presence());
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const who = ws.deserializeAttachment() as Attachment | null;
    try {
      ws.close(1000, "bye");
    } catch {
      /* already closed */
    }
    const current = await this.lease();
    if (who && current?.conn === who.conn) await this.clearLease();
    else this.broadcast(await this.presence(), ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    const l = (await this.state.storage.get<Lease>("lease")) ?? null;
    if (!l) return;
    if (l.expiresAt > Date.now()) {
      await this.state.storage.setAlarm(l.expiresAt);
      return;
    }
    await this.clearLease();
  }
}

/** The room of one document. */
export function roomFor(env: Env, orgId: string, docId: string): DurableObjectStub | null {
  if (!env.DOC_ROOM) return null;
  return env.DOC_ROOM.get(env.DOC_ROOM.idFromName(`${orgId}:${docId}`));
}
