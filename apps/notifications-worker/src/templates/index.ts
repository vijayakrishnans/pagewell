/**
 * Static email templates for the notifications worker.
 *
 * Spec 14 allows V1 templates to be static files as long as template
 * versions remain traceable — these renderers are the V1 "static files"
 * form, keyed by the same `templateKey` strings the calling workers pass
 * to POST /v1/notifications.
 *
 * Every substitution is HTML-escaped before it reaches the html body, so a
 * hostile value in `templateData` (or a recipient-controlled field such as
 * an email hint) can never inject markup. Renderers only read the fields
 * they need; unknown extra fields are ignored, and unknown template keys
 * return null so the provider can fail the send with a bounded reason
 * instead of delivering an empty message.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export type TemplateData = Record<string, string | number | boolean | null>;

export interface TemplateRenderOptions {
  /**
   * Product display name used in subjects/footers (e.g. "Pagewell").
   * Falls back to neutral copy when not configured so a misconfigured
   * deployment still produces a sensible email.
   */
  brandName?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Stringify a templateData value; null/undefined render as "". */
function str(data: TemplateData, key: string): string {
  const v = data[key];
  if (v === null || v === undefined) return "";
  return String(v);
}

/**
 * Render an ISO timestamp as a human-readable UTC string. Falls back to the
 * raw value when it does not parse — a slightly ugly email beats a failed
 * send.
 */
function formatTimestamp(raw: string): string {
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toUTCString();
}

/**
 * Shared shell so all transactional emails look consistent. Body fragments
 * passed in MUST already be escaped.
 */
function htmlShell(title: string, bodyHtml: string, footerLine: string): string {
  return [
    '<!DOCTYPE html><html><body style="margin:0;padding:0;background-color:#f4f4f7;">',
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;color:#1a1a2e;">',
    '<div style="background:#ffffff;border-radius:8px;padding:32px;">',
    `<h1 style="margin:0 0 16px;font-size:20px;">${title}</h1>`,
    bodyHtml,
    "</div>",
    `<p style="margin:16px 0 0;font-size:12px;color:#6b6b80;text-align:center;">${footerLine}</p>`,
    "</div></body></html>",
  ].join("");
}

type TemplateRenderer = (data: TemplateData, opts: TemplateRenderOptions) => RenderedEmail;

const renderMagicLink: TemplateRenderer = (data, opts) => {
  const code = str(data, "code");
  const expires = formatTimestamp(str(data, "expiresAt"));
  const brand = opts.brandName ?? "";
  const subject = brand ? `Your ${brand} login code` : "Your login code";
  const expiryLineText = expires ? `This code expires at ${expires}.` : "This code expires shortly.";

  const text = [
    "Use this code to finish signing in:",
    "",
    code,
    "",
    expiryLineText,
    "If you did not request this code, you can safely ignore this email.",
  ].join("\n");

  const html = htmlShell(
    "Finish signing in",
    [
      '<p style="margin:0 0 16px;font-size:14px;">Use this code to finish signing in:</p>',
      `<p style="margin:0 0 16px;font-size:28px;font-weight:700;letter-spacing:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(code)}</p>`,
      `<p style="margin:0 0 8px;font-size:13px;color:#6b6b80;">${escapeHtml(expiryLineText)}</p>`,
      '<p style="margin:0;font-size:13px;color:#6b6b80;">If you did not request this code, you can safely ignore this email.</p>',
    ].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated security email."),
  );

  return { subject, html, text };
};

const renderInvitationCreated: TemplateRenderer = (data, opts) => {
  const role = str(data, "role");
  const expires = formatTimestamp(str(data, "expiresAt"));
  const brand = opts.brandName ?? "";
  const subject = brand
    ? `You have been invited to an organization on ${brand}`
    : "You have been invited to an organization";
  const roleLineText = role
    ? `You have been invited to join an organization as ${role}.`
    : "You have been invited to join an organization.";
  const expiryLineText = expires ? `The invitation expires at ${expires}.` : "";

  const text = [
    roleLineText,
    expiryLineText,
    "Sign in with this email address to view and accept the invitation.",
    "If you were not expecting this invitation, you can safely ignore this email.",
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");

  const html = htmlShell(
    "You have been invited",
    [
      `<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(roleLineText)}</p>`,
      expiryLineText
        ? `<p style="margin:0 0 16px;font-size:13px;color:#6b6b80;">${escapeHtml(expiryLineText)}</p>`
        : "",
      '<p style="margin:0 0 8px;font-size:14px;">Sign in with this email address to view and accept the invitation.</p>',
      '<p style="margin:0;font-size:13px;color:#6b6b80;">If you were not expecting this invitation, you can safely ignore this email.</p>',
    ].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated email."),
  );

  return { subject, html, text };
};

const renderInvitationAccepted: TemplateRenderer = (data, opts) => {
  const role = str(data, "role");
  const brand = opts.brandName ?? "";
  const subject = brand ? `You have joined an organization on ${brand}` : "You have joined an organization";
  const bodyLineText = role
    ? `Your invitation was accepted and you are now a member with the ${role} role.`
    : "Your invitation was accepted and you are now a member of the organization.";

  const text = [
    bodyLineText,
    "If this was not you, contact your organization administrator.",
  ].join("\n\n");

  const html = htmlShell(
    "Welcome aboard",
    [
      `<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(bodyLineText)}</p>`,
      '<p style="margin:0;font-size:13px;color:#6b6b80;">If this was not you, contact your organization administrator.</p>',
    ].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated email."),
  );

  return { subject, html, text };
};

/**
 * Pagewell (PW3): something in a drive was shared with this address. The name of the folder or
 * document is what the person who shared it chose to show; the link opens Pagewell, where the
 * recipient signs in with this same address to see it (Shared with me).
 */
const renderFilesShared: TemplateRenderer = (data, opts) => {
  const brand = opts.brandName ?? "";
  const role = str(data, "role");
  const kind = str(data, "resourceKind") === "folder" ? "folder" : "document";
  const name = str(data, "resourceName");
  const message = str(data, "message");
  const openUrl = str(data, "openUrl");
  const safeUrl = /^https:\/\/[^\s"'<>]+$/.test(openUrl) ? openUrl : "";
  const what = name ? `the ${kind} "${name}"` : `a ${kind}`;
  const subject = name ? `"${name}" was shared with you${brand ? ` on ${brand}` : ""}` : `A ${kind} was shared with you${brand ? ` on ${brand}` : ""}`;
  const lead = `You can now ${role === "editor" ? "edit" : role === "commenter" ? "comment on" : "view"} ${what}.`;
  const signIn = "Sign in with this email address to open it.";

  const text = [lead, message ? `Message: ${message}` : "", safeUrl ? `Open it: ${safeUrl}` : "", signIn, "If you were not expecting this, you can ignore this email."]
    .filter((line) => line.length > 0)
    .join("\n\n");

  const html = htmlShell(
    "Shared with you",
    [
      `<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(lead)}</p>`,
      message ? `<p style="margin:0 0 16px;font-size:14px;border-left:3px solid #d0d0dc;padding-left:12px;">${escapeHtml(message)}</p>` : "",
      safeUrl ? `<p style="margin:0 0 16px;"><a href="${escapeHtml(safeUrl)}" style="display:inline-block;background:#1a1a2e;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:14px;">Open</a></p>` : "",
      `<p style="margin:0 0 8px;font-size:14px;">${escapeHtml(signIn)}</p>`,
      '<p style="margin:0;font-size:13px;color:#6b6b80;">If you were not expecting this, you can ignore this email.</p>',
    ].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated email."),
  );

  return { subject, html, text };
};

/** Only a plain https URL becomes a link in an email. */
const safeLink = (url: string) => (/^https:\/\/[^\s"'<>]+$/.test(url) ? url : "");
const button = (url: string, label: string) =>
  url ? `<p style="margin:0 0 16px;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#1a1a2e;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:14px;">${escapeHtml(label)}</a></p>` : "";

/** Pagewell (PW5): someone @-mentioned this address in a comment. */
const renderReviewMentioned: TemplateRenderer = (data, opts) => {
  const brand = opts.brandName ?? "";
  const name = str(data, "documentName");
  const page = str(data, "page");
  const excerpt = str(data, "excerpt");
  const by = str(data, "by");
  const url = safeLink(str(data, "openUrl"));
  const lead = `${by || "Someone"} mentioned you in a comment${page ? ` on page ${page}` : ""}${name ? ` of "${name}"` : ""}.`;
  const subject = `You were mentioned${name ? ` in "${name}"` : ""}${brand ? ` on ${brand}` : ""}`;
  const text = [lead, excerpt ? `"${excerpt}"` : "", url ? `Open it: ${url}` : ""].filter(Boolean).join("\n\n");
  const html = htmlShell(
    "You were mentioned",
    [`<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(lead)}</p>`, excerpt ? `<p style="margin:0 0 16px;font-size:14px;border-left:3px solid #d0d0dc;padding-left:12px;">${escapeHtml(excerpt)}</p>` : "", button(url, "Open the comment")].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated email."),
  );
  return { subject, html, text };
};

/** Pagewell (PW5): this address was asked to review a document. */
const renderReviewRequested: TemplateRenderer = (data, opts) => {
  const brand = opts.brandName ?? "";
  const name = str(data, "documentName");
  const by = str(data, "by");
  const message = str(data, "message");
  const due = formatTimestamp(str(data, "dueAt"));
  const url = safeLink(str(data, "openUrl"));
  const lead = `${by || "Someone"} asked you to review${name ? ` "${name}"` : " a document"}${due ? ` by ${due}` : ""}.`;
  const subject = `Review requested${name ? `: "${name}"` : ""}${brand ? ` on ${brand}` : ""}`;
  const text = [lead, message ? `Message: ${message}` : "", url ? `Open it: ${url}` : "", "Sign in with this email address to comment and decide."].filter(Boolean).join("\n\n");
  const html = htmlShell(
    "Review requested",
    [`<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(lead)}</p>`, message ? `<p style="margin:0 0 16px;font-size:14px;border-left:3px solid #d0d0dc;padding-left:12px;">${escapeHtml(message)}</p>` : "", button(url, "Open the document"), '<p style="margin:0;font-size:13px;color:#6b6b80;">Sign in with this email address to comment and decide.</p>'].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated email."),
  );
  return { subject, html, text };
};

/** Pagewell (PW5): a review this address was asked for is due soon or overdue. */
const renderReviewReminder: TemplateRenderer = (data, opts) => {
  const brand = opts.brandName ?? "";
  const due = formatTimestamp(str(data, "dueAt"));
  const overdue = data.overdue === true;
  const url = safeLink(str(data, "openUrl"));
  const lead = overdue ? `A review you were asked for is overdue${due ? ` (it was due ${due})` : ""}.` : `A review you were asked for is due${due ? ` ${due}` : " soon"}.`;
  const subject = `${overdue ? "Overdue" : "Reminder"}: a review is waiting for you${brand ? ` on ${brand}` : ""}`;
  const text = [lead, url ? `Open it: ${url}` : ""].filter(Boolean).join("\n\n");
  const html = htmlShell("A review is waiting", [`<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(lead)}</p>`, button(url, "Open the document")].join(""), escapeHtml(brand ? `Sent by ${brand}` : "This is an automated email."));
  return { subject, html, text };
};

const TEMPLATES: Record<string, TemplateRenderer> = {
  "review.mentioned": renderReviewMentioned,
  "review.requested": renderReviewRequested,
  "review.reminder": renderReviewReminder,
  "auth.magic_link": renderMagicLink,
  "files.shared": renderFilesShared,
  "invitation.created": renderInvitationCreated,
  "invitation.accepted": renderInvitationAccepted,
};

/**
 * Render the email for a template key, or null when the key has no
 * registered template. Callers (the provider adapters) MUST treat null as a
 * bounded send failure — never deliver an empty or generic body.
 */
export function renderEmailTemplate(
  templateKey: string,
  templateData: TemplateData,
  opts: TemplateRenderOptions = {},
): RenderedEmail | null {
  const renderer = TEMPLATES[templateKey];
  if (!renderer) return null;
  return renderer(templateData, opts);
}
