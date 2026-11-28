// review-worker over the REAL files-worker (one SQLite engine with every migration, one
// in-memory R2, the real policy engine). The DocRoom runs on an in-memory Durable Object state
// with fake sockets: Node cannot open a real 101 WebSocket, so tests drive admit/join and the
// socket handlers directly.
import { route as filesRoute } from "@files-worker/router";
import { route as reviewRoute } from "@review-worker/router";
import { DocRoom, type Attachment } from "@review-worker/room";
import type { Env as ReviewEnv } from "@review-worker/env";
import { fixturePdf, world as filesWorld, type World as FilesWorld } from "../../files-worker/src/harness.js";

export { fixturePdf };

/** A socket that records what the room sent it. */
export class FakeSocket {
  sent: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  closed = false;
  private attachment: unknown = null;
  send(data: string) {
    if (this.closed) throw new Error("closed");
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  serializeAttachment(v: unknown) {
    this.attachment = structuredClone(v);
  }
  deserializeAttachment() {
    return this.attachment;
  }
  last(type: string) {
    return [...this.sent].reverse().find((e) => e.type === type);
  }
}

/** The part of DurableObjectState the room uses, in memory. */
export class FakeState {
  store = new Map<string, unknown>();
  alarm: number | null = null;
  sockets: FakeSocket[] = [];
  storage = {
    get: async <T>(k: string) => this.store.get(k) as T | undefined,
    put: async (k: string, v: unknown) => void this.store.set(k, structuredClone(v)),
    delete: async (k: string) => this.store.delete(k),
    setAlarm: async (t: number) => void (this.alarm = t),
    deleteAlarm: async () => void (this.alarm = null),
  };
  acceptWebSocket(ws: FakeSocket) {
    this.sockets.push(ws);
  }
  getWebSockets() {
    return this.sockets.filter((s) => !s.closed);
  }
}

export interface ReviewWorld {
  files: FilesWorld;
  env: ReviewEnv;
  rooms: Map<string, { room: DocRoom; state: FakeState }>;
  request(method: string, path: string, init?: { user?: string; email?: string; json?: unknown }): Promise<Response>;
  room(orgId: string, docId: string): { room: DocRoom; state: FakeState };
  /** Open a fake socket into a room with a ticket, as the browser would. */
  connect(orgId: string, docId: string, ticket: string): Promise<{ socket: FakeSocket; who: Attachment } | null>;
}

export function reviewWorld(): ReviewWorld {
  const files = filesWorld();
  const rooms = new Map<string, { room: DocRoom; state: FakeState }>();
  const roomFor = (name: string) => {
    let r = rooms.get(name);
    if (!r) {
      const state = new FakeState();
      r = { room: new DocRoom(state as unknown as DurableObjectState, {} as ReviewEnv), state };
      rooms.set(name, r);
    }
    return r;
  };
  const env: ReviewEnv = {
    ENVIRONMENT: "test",
    EDITOR_URL: "https://editor.example.com",
    PLATFORM_DB: files.env.PLATFORM_DB!,
    FILES_WORKER: { fetch: (input: string | Request, init?: RequestInit) => filesRoute(input instanceof Request ? input : new Request(input, init), files.env, files.now) } as unknown as Fetcher,
    NOTIFICATIONS_WORKER: files.env.NOTIFICATIONS_WORKER!,
    DOC_ROOM: {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: (id: { name: string }) => ({ fetch: (input: string | Request, init?: RequestInit) => roomFor(id.name).room.fetch(input instanceof Request ? input : new Request(input, init)) }),
    } as unknown as DurableObjectNamespace,
  };
  const w: ReviewWorld = {
    files,
    env,
    rooms,
    async request(method, path, init = {}) {
      const headers: Record<string, string> = {};
      if (init.user) {
        headers["x-actor-subject-id"] = init.user;
        headers["x-actor-subject-type"] = "user";
        if (init.email) headers["x-actor-email"] = init.email;
      }
      let body: string | null = null;
      if (init.json !== undefined) {
        body = JSON.stringify(init.json);
        headers["content-type"] = "application/json";
      }
      return reviewRoute(new Request(`http://review${path}`, { method, headers, body }), env, files.now);
    },
    room: (orgId, docId) => roomFor(`${orgId}:${docId}`),
    async connect(orgId, docId, ticket) {
      const { room } = roomFor(`${orgId}:${docId}`);
      const who = await room.admit(ticket);
      if (!who) return null;
      const socket = new FakeSocket();
      await room.join(socket as unknown as WebSocket, who);
      return { socket, who };
    },
  };
  return w;
}
