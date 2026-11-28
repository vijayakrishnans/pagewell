import { SPOTS, actions, envelopeRequest, progress, spotRect, type RequestForm } from "../../../apps/web-console-next/src/lib/sign";

// The Request signatures dialog and the Envelopes page (PW6): pure helpers.

const form = (over: Partial<RequestForm> = {}): RequestForm => ({
  title: "Generated agreement",
  message: "",
  orderMode: "parallel",
  reminderDays: 3,
  signers: [
    { name: "Ann", email: "Ann@Example.com", page: 2, spot: "bottom-left", withDate: true },
    { name: "Ben", email: "ben@example.com", page: 2, spot: "bottom-right", withDate: false },
  ],
  ...over,
});

describe("sign helpers", () => {
  it("builds one signature field per signer (and a date under it when asked)", () => {
    const r = envelopeRequest("doc_1", 2, form());
    if (!r.ok) throw new Error(r.error);
    expect(r.request.signers).toEqual([
      { key: "s1", name: "Ann", email: "ann@example.com", order: 1 },
      { key: "s2", name: "Ben", email: "ben@example.com", order: 1 },
    ]);
    expect(r.request.fields.map((f) => [f.signer, f.kind, f.page])).toEqual([["s1", "signature", 2], ["s1", "date", 2], ["s2", "signature", 2]]);
    expect(r.request.message).toBeNull();
    const seq = envelopeRequest("doc_1", 2, form({ orderMode: "sequential" }));
    expect(seq.ok && seq.request.signers.map((s) => s.order)).toEqual([1, 2]);
  });

  it("refuses an empty title, a bad email, a repeated signer, a page off the document", () => {
    expect(envelopeRequest("doc_1", 2, form({ title: " " }))).toMatchObject({ ok: false });
    expect(envelopeRequest("doc_1", 2, form({ signers: [{ ...form().signers[0]!, email: "nope" }] }))).toMatchObject({ ok: false, error: expect.stringContaining("email") });
    expect(envelopeRequest("doc_1", 2, form({ signers: [form().signers[1]!, { ...form().signers[1]!, name: "Ben again" }] }))).toMatchObject({ ok: false, error: expect.stringContaining("twice") });
    expect(envelopeRequest("doc_1", 2, form({ signers: [{ ...form().signers[0]!, page: 3 }] }))).toMatchObject({ ok: false, error: expect.stringContaining("1 to 2") });
  });

  it("places every spot inside a Letter page, the date just under its signature", () => {
    for (const { id } of SPOTS) {
      for (const kind of ["signature", "initials", "date"] as const) {
        const [x, y, w, h] = spotRect(id, kind);
        expect(x >= 0 && y >= 0 && x + w <= 612 && y + h <= 792).toBe(true);
      }
      const [, sy, , sh] = spotRect(id, "signature");
      expect(spotRect(id, "date")[1]).toBe(sy + sh + 6);
    }
  });

  it("says how far it got and what the sender may do", () => {
    expect(progress({ signers: [{ status: "signed" }, { status: "viewed" }] as never })).toBe("1 of 2 signed");
    expect(actions({ status: "sent" })).toEqual({ resend: true, void: true, open: false });
    expect(actions({ status: "completed" })).toEqual({ resend: false, void: false, open: true });
  });
});
