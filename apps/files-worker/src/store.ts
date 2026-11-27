// Getting a PDF's bytes into R2 without holding them twice, and knowing their
// sha256 and size when they land. On Workers the body streams: the first
// chunk is checked for a PDF header, then one branch feeds the digest and the
// other R2 (through a FixedLengthStream, since R2 needs the length up front).
// Where those primitives are missing (the node test runner) the body is
// buffered instead; the results are the same.

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const SNIFF_WINDOW = 1024;

export type StoreResult =
  | { ok: true; sha256: string; size: number }
  | { ok: false; reason: "not_a_pdf" | "too_large" | "empty" };

/** The PDF header must appear in the first 1024 bytes (the spec tolerates leading junk). */
export function looksLikePdf(head: Uint8Array): boolean {
  const end = Math.min(head.length, SNIFF_WINDOW) - PDF_MAGIC.length;
  for (let i = 0; i <= end; i++) {
    let hit = true;
    for (let j = 0; j < PDF_MAGIC.length; j++) {
      if (head[i + j] !== PDF_MAGIC[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface StreamingPrimitives {
  FixedLengthStream: new (length: number) => { readable: ReadableStream; writable: WritableStream };
  DigestStream: new (algorithm: string) => WritableStream & { digest: Promise<ArrayBuffer> };
}

function streaming(): StreamingPrimitives | null {
  const g = globalThis as unknown as { FixedLengthStream?: StreamingPrimitives["FixedLengthStream"]; crypto: { DigestStream?: StreamingPrimitives["DigestStream"] } };
  return g.FixedLengthStream && g.crypto.DigestStream ? { FixedLengthStream: g.FixedLengthStream, DigestStream: g.crypto.DigestStream } : null;
}

const PUT_OPTIONS: R2PutOptions = { httpMetadata: { contentType: "application/pdf" } };

/**
 * Store `body` at `key` if it is a PDF of at most `maxBytes`. `length` is the
 * request's Content-Length when it sent one. Nothing is left in R2 on refusal.
 */
export async function storePdf(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array> | null,
  length: number | null,
  maxBytes: number,
): Promise<StoreResult> {
  if (!body || length === 0) return { ok: false, reason: "empty" };
  if (length !== null && length > maxBytes) return { ok: false, reason: "too_large" };
  const prims = streaming();

  if (prims && length !== null) {
    const reader = body.getReader();
    // Read until the sniff window is full (or the body ends).
    const head: Uint8Array[] = [];
    let headBytes = 0;
    while (headBytes < SNIFF_WINDOW) {
      const { done, value } = await reader.read();
      if (done) break;
      head.push(value);
      headBytes += value.byteLength;
    }
    const first = concat(head, headBytes);
    if (!looksLikePdf(first)) {
      await reader.cancel();
      return { ok: false, reason: "not_a_pdf" };
    }
    const replay = new ReadableStream<Uint8Array>({
      start(controller) {
        if (first.byteLength) controller.enqueue(first);
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    const [toDigest, toBucket] = replay.tee();
    const digest = new prims.DigestStream("SHA-256");
    const fixed = new prims.FixedLengthStream(length);
    try {
      await Promise.all([toDigest.pipeTo(digest), toBucket.pipeTo(fixed.writable), bucket.put(key, fixed.readable, PUT_OPTIONS)]);
    } catch (err) {
      await bucket.delete(key).catch(() => undefined);
      throw err;
    }
    return { ok: true, sha256: hex(await digest.digest), size: length };
  }

  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  if (bytes.byteLength === 0) return { ok: false, reason: "empty" };
  if (bytes.byteLength > maxBytes) return { ok: false, reason: "too_large" };
  if (!looksLikePdf(bytes.subarray(0, SNIFF_WINDOW))) return { ok: false, reason: "not_a_pdf" };
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  await bucket.put(key, bytes, PUT_OPTIONS);
  return { ok: true, sha256, size: bytes.byteLength };
}

/** sha256 of an object already in R2 (a completed multipart upload). */
export async function digestObject(bucket: R2Bucket, key: string): Promise<{ sha256: string; size: number } | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  const prims = streaming();
  if (prims) {
    const digest = new prims.DigestStream("SHA-256");
    await obj.body.pipeTo(digest);
    return { sha256: hex(await digest.digest), size: obj.size };
  }
  const bytes = await obj.arrayBuffer();
  return { sha256: hex(await crypto.subtle.digest("SHA-256", bytes)), size: bytes.byteLength };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Content-Length as a number, or null when absent or malformed. */
export function contentLength(request: Request): number | null {
  const v = request.headers.get("content-length");
  if (v === null || !/^\d{1,15}$/.test(v)) return null;
  return Number(v);
}
