// The editor page: mounts PagewellEditor (crates/pagewell-web-bridge) on the canvas and wires
// open, save and undo.
//
//   /edit/local                 a file from this device, saved back to disk
//   /edit/fixture               the generated 100-page fixture
//   /edit/<doc_…>?org=<org_…>   a document in the drive (cloud.js): opened with the session the
//                               console hands this tab, saved as the next version
//   /l/<token>                  a share link (cloud.js), view only: nothing is saved anywhere
//
// `window.pagewell` exposes the editor and the page's helpers to tests (Playwright drives the
// bridge API through it).

const pkg = document.querySelector("script[data-pkg]").dataset.pkg;
const { default: init, PagewellEditor } = await import(`/pkg/${pkg}/pagewell_web_bridge.js`);
const cloudModule = import("/cloud.js");

const $ = (id) => document.getElementById(id);
const status = $("status");
const saveButton = $("save");
const undoButton = $("undo");
const downloadButton = $("download");
const canvas = $("editor");

let fileName = "document.pdf";
let fileHandle = null;
/** Set when the open document lives in the drive: saves go there instead of to disk. */
let cloud = null;
/** Set on a share link: nothing is saved, and a download is offered only if the link allows it. */
let viewOnly = false;

function say(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", isError);
}

const linkToken = location.pathname.match(/^\/l\/([A-Za-z0-9_-]{20,128})\/?$/)?.[1] ?? null;
const docId = linkToken ? "link" : location.pathname.replace(/^\/edit\/?/, "").replace(/\/$/, "") || "local";

// The editor draws with WebGL2. Without it eframe never starts, so say why instead of waiting.
const probe = document.createElement("canvas").getContext("webgl2");
if (!probe) {
  say("This browser can't run the editor: WebGL2 is off or unavailable. Turn on hardware acceleration, or try another browser.", true);
  throw new Error("WebGL2 unavailable");
}
probe.getExtension("WEBGL_lose_context")?.loseContext();

await init();
const editor = await PagewellEditor.mount("editor");
window.pagewell = { editor, open: openBytes, save: saveBytes, automation, docId, get cloud() { return cloud; } };

canvas.addEventListener("pagewell:dirty", (e) => {
  say(e.detail.dirty ? `${fileName} — unsaved changes` : fileName);
});
canvas.addEventListener("pagewell:error", (e) => say(e.detail.message, true));
// A save started inside the editor (its menu or Ctrl+S) arrives as an event.
canvas.addEventListener("pagewell:save", (e) => {
  store(e.detail.bytes, e.detail.name || fileName).catch((err) => say(String(err), true));
});

/** Save where the document came from: the drive, or this device. */
async function store(bytes, name) {
  if (viewOnly) {
    say("This is a shared link: it's view only, so changes aren't saved.", true);
    return null;
  }
  if (cloud) return cloud.save(bytes);
  return writeOut(bytes, name);
}

function openBytes(bytes, name) {
  fileName = name || "document.pdf";
  editor.open(bytes, fileName);
  saveButton.disabled = viewOnly;
  undoButton.disabled = true;
  say(fileName);
}

async function saveBytes() {
  return editor.save();
}

async function writeOut(bytes, name) {
  if (fileHandle && "createWritable" in fileHandle) {
    const w = await fileHandle.createWritable();
    await w.write(bytes);
    await w.close();
  } else if ("showSaveFilePicker" in window) {
    fileHandle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }] });
    return writeOut(bytes, name);
  } else {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  say(`Saved ${name}`);
}

$("open").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  fileHandle = null;
  openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
  e.target.value = "";
});

saveButton.addEventListener("click", async () => {
  try {
    await store(await editor.save(), fileName);
  } catch (err) {
    if (err?.name !== "AbortError") say(String(err), true);
  }
});

undoButton.addEventListener("click", () => {
  editor.undo();
  undoButton.disabled = !editor.canUndo();
});
// Tool calls (the assistant, from PW5) go through here so Undo follows them.
async function automation(call) {
  const reply = await editor.automation(call);
  undoButton.disabled = !reply.canUndo;
  return reply;
}

// Set when the page navigates on purpose (to a copy it just saved), so the guard stays quiet.
let leaving = false;
window.addEventListener("beforeunload", (e) => {
  if (!leaving && !viewOnly && editor.isDirty()) e.preventDefault();
});
function leave(href) {
  leaving = true;
  location.assign(href);
}

if (linkToken) {
  viewOnly = true;
  for (const el of [saveButton, undoButton, $("open-label")]) el.hidden = true;
  $("open").disabled = true;
  const { openFromLink } = await cloudModule;
  const shared = await openFromLink({ token: linkToken, say, openBytes });
  if (shared?.allowDownload) {
    downloadButton.hidden = false;
    // The file as it was shared, not any changes made here.
    downloadButton.addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob([shared.bytes], { type: "application/pdf" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: shared.name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    });
  }
} else if (docId === "local") {
  say("Open a PDF from this device to start.");
} else if (docId.startsWith("doc_")) {
  const { openFromDrive } = await cloudModule;
  cloud = await openFromDrive({ docId, say, openBytes, automation, leave });
  if (cloud) {
    $("open-label").hidden = true;
    const printButton = $("print");
    printButton.hidden = false;
    printButton.addEventListener("click", () => {
      // The tab opens now, on the click; it gets the PDF when the job is done.
      const tab = window.open("", "_blank");
      cloud.print(tab).catch((err) => say(String(err), true));
    });
  }
} else {
  say("Opening…");
  const res = await fetch(`/fixtures/${encodeURIComponent(docId)}.pdf`);
  if (res.ok) {
    openBytes(new Uint8Array(await res.arrayBuffer()), `${docId}.pdf`);
  } else {
    say(`No document ${docId}. Sign-in and the drive arrive in a later release.`, true);
  }
}
canvas.focus();
