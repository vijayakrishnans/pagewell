// Carrying a comment's anchor to a newer version of its document (PW5). The rule, from the
// design (risk PW-D): carried forward or marked outdated, never silently moved.
//
//   - the page is gone in the new version              → outdated
//   - the anchor has a quote: still on the same page    → carried, else outdated
//   - no quote: the page's text is unchanged            → carried, else outdated
//   - no text known for either version (never extracted) → carried when the page still exists
//
// Text is compared with whitespace collapsed, so re-flowed but identical text still matches.

export interface PageAnchor {
  page: number;
  rect: [number, number, number, number];
  quote: string | null;
}

export interface VersionText {
  /** Page count of the version, when known. */
  pageCount: number | null;
  /** Page number → its text; null when the version's text was never extracted. */
  pages: Map<number, string> | null;
}

export type CarryOutcome = { status: "carried"; anchor: PageAnchor } | { status: "outdated"; anchor: PageAnchor; reason: "page_gone" | "quote_gone" | "page_changed" };

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function carryAnchor(anchor: PageAnchor, from: VersionText, to: VersionText): CarryOutcome {
  const pageExists = to.pageCount !== null ? anchor.page <= to.pageCount : to.pages ? to.pages.has(anchor.page) : true;
  if (!pageExists) return { status: "outdated", anchor, reason: "page_gone" };
  const after = to.pages?.get(anchor.page);
  if (anchor.quote && anchor.quote.trim()) {
    if (after === undefined) return to.pages ? { status: "outdated", anchor, reason: "page_gone" } : { status: "carried", anchor };
    return norm(after).includes(norm(anchor.quote)) ? { status: "carried", anchor } : { status: "outdated", anchor, reason: "quote_gone" };
  }
  const before = from.pages?.get(anchor.page);
  if (before === undefined || after === undefined) return { status: "carried", anchor };
  return norm(before) === norm(after) ? { status: "carried", anchor } : { status: "outdated", anchor, reason: "page_changed" };
}

/** A version's stored text ({pages: [{page, text}]}, as the editor saves it) as a page map. */
export function versionText(json: unknown, pageCount: number | null): VersionText {
  const pages = (json as { pages?: Array<{ page?: unknown; text?: unknown }> } | null)?.pages;
  if (!Array.isArray(pages)) return { pageCount, pages: null };
  const map = new Map<number, string>();
  for (const p of pages) if (Number.isInteger(p.page) && typeof p.text === "string") map.set(p.page as number, p.text);
  return { pageCount, pages: map };
}
