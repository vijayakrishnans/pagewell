// The editor page: mounts PagewellEditor (crates/pagewell-web-bridge) on the canvas and wires
// open, save and undo. /edit/local opens files from this device; /edit/<docId> opens a seeded
// document (until the drive arrives in PW2, only the generated fixture).
//
// `window.pagewell` exposes the editor and the page's helpers to tests (Playwright drives the
// bridge API through it).

const pkg = document.querySelector("script[data-pkg]").dataset.pkg;
const { default: init, PagewellEditor } = await import(`/pkg/${pkg}/pagewell_web_bridge.js`);

const $ = (id) => document.getElementById(id);
const status = $("status");
const saveButton = $("save");
const undoButton = $("undo");
const canvas = $("editor");

let fileName = "document.pdf";
let fileHandle = null;

function say(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", isError);
}

const docId = location.pathname.replace(/^\/edit\/?/, "").replace(/\/$/, "") || "local";

// The editor draws with WebGL2. Without it eframe never starts, so say why instead of waiting.
const probe = document.createElement("canvas").getContext("webgl2");
if (!probe) {
  say("This browser can't run the editor: WebGL2 is off or unavailable. Turn on hardware acceleration, or try another browser.", true);
  throw new Error("WebGL2 unavailable");
}
probe.getExtension("WEBGL_lose_context")?.loseContext();

await init();
const editor = await PagewellEditor.mount("editor");
window.pagewell = { editor, open: openBytes, save: saveBytes, automation, docId };

canvas.addEventListener("pagewell:dirty", (e) => {
  say(e.detail.dirty ? `${fileName} — unsaved changes` : fileName);
});
canvas.addEventListener("pagewell:error", (e) => say(e.detail.message, true));
// A save started inside the editor (its menu or Ctrl+S) arrives as an event.
canvas.addEventListener("pagewell:save", (e) => {
  writeOut(e.detail.bytes, e.detail.name || fileName).catch((err) => say(String(err), true));
});

function openBytes(bytes, name) {
  fileName = name || "document.pdf";
  editor.open(bytes, fileName);
  saveButton.disabled = false;
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
    await writeOut(await editor.save(), fileName);
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

window.addEventListener("beforeunload", (e) => {
  if (editor.isDirty()) e.preventDefault();
});

if (docId === "local") {
  say("Open a PDF from this device to start.");
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
