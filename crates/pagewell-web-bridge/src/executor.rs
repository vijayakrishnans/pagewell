//! The browser executor: PdfCraft's tools run on a snapshot of the document open in the editor.
//!
//! The editor and PdfCraft's automation keep separate sessions, so a tool call takes the
//! editor's current bytes, opens them in a private [`Automation`] session (with
//! `Automation::open_bytes`, upstream patch P1), runs the tool with `doc` filled in, and, when the
//! tool changed the document, returns the new bytes for the editor to show. Each change keeps the
//! bytes it replaced, so [`Executor::undo`] can step back through agent edits.
//!
//! The page has no file system: tools that open, save or close files, or take a path, are refused.

use pdfcraft_automation::{Automation, Content};
use pdfcraft_engine::DocId;
use serde_json::{Map, Value, json};

/// Tools that manage files or the session this executor owns, or that make or join other
/// documents (one open document is all the browser executor works on).
const REFUSED_TOOLS: &[&str] = &[
    "doc_open",
    "doc_open_revision",
    "doc_close",
    "doc_save",
    "doc_list",
    "doc_create",
    "doc_create_multiple",
    "doc_combine",
    "doc_split",
    "doc_batch",
    "doc_bates_multi",
];

/// Argument names that name files on disk.
const FILE_ARGS: &[&str] = &["path", "paths", "out", "output", "out_dir", "dir", "folder", "file", "files", "root"];

/// How many replaced versions undo keeps (each is a whole PDF in memory).
pub const UNDO_LIMIT: usize = 20;

/// A document as the editor holds it: its name and bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub name: String,
    pub bytes: Vec<u8>,
}

/// What one tool call did.
#[derive(Debug)]
pub struct Outcome {
    /// The tool's result: an array with one entry per content block.
    pub result: Value,
    /// The document after the call, when the tool changed it.
    pub changed: Option<Snapshot>,
}

/// Runs PdfCraft's tools on snapshots and keeps the undo history of the changes.
pub struct Executor {
    automation: Automation,
    undo: Vec<Snapshot>,
}

impl Default for Executor {
    fn default() -> Self {
        Self::new()
    }
}

impl Executor {
    pub fn new() -> Self {
        Self { automation: Automation::new(), undo: Vec::new() }
    }

    /// Run `tool` with `args` on `current`. `args` must be an object (or null) without `doc`,
    /// which the executor supplies.
    pub fn run(&mut self, current: &Snapshot, tool: &str, args: Value) -> Result<Outcome, String> {
        let mut args = match args {
            Value::Object(map) => map,
            Value::Null => Map::new(),
            _ => return Err("args must be an object".into()),
        };
        refuse(tool, &args)?;
        let doc = self.automation.open_bytes(&current.name, current.bytes.clone(), None)?;
        args.insert("doc".into(), json!(doc));
        let called = self.automation.call(tool, &Value::Object(args));
        let outcome = called.map_err(|e| e.to_string()).and_then(|contents| {
            let dirty = self.automation.session().get(DocId(doc)).is_some_and(|d| d.dirty);
            let changed = if dirty {
                let bytes = self.automation.session().save_full_bytes(DocId(doc)).map_err(|e| e.to_string())?;
                Some(Snapshot { name: current.name.clone(), bytes: bytes.to_vec() })
            } else {
                None
            };
            Ok(Outcome { result: contents_json(contents), changed })
        });
        self.close(doc);
        let outcome = outcome?;
        if outcome.changed.is_some() {
            self.undo.push(current.clone());
            if self.undo.len() > UNDO_LIMIT {
                self.undo.remove(0);
            }
        }
        Ok(outcome)
    }

    /// The document as it was before the most recent change, removed from the history.
    pub fn undo(&mut self) -> Option<Snapshot> {
        self.undo.pop()
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    /// Forget the history, as when another document opens.
    pub fn clear(&mut self) {
        self.undo.clear();
    }

    fn close(&mut self, doc: u64) {
        let _ = self.automation.call("doc_close", &json!({"doc": doc, "discard_changes": true}));
    }
}

fn refuse(tool: &str, args: &Map<String, Value>) -> Result<(), String> {
    if REFUSED_TOOLS.contains(&tool) {
        return Err(format!("{tool} is not available in the browser: the editor owns the open document"));
    }
    if args.contains_key("doc") {
        return Err("leave out doc: the browser executor runs tools on the open document".into());
    }
    if let Some(key) = FILE_ARGS.iter().find(|k| args.contains_key(**k)) {
        return Err(format!("{tool} names a file ({key}), and the browser has no file system"));
    }
    Ok(())
}

fn contents_json(contents: Vec<Content>) -> Value {
    Value::Array(
        contents
            .into_iter()
            .map(|c| match c {
                Content::Json(v) => v,
                // The PNG itself travels as base64, so the page can use a render (a thumbnail).
                Content::Png { data, width, height } => {
                    json!({"type": "image/png", "width": width, "height": height, "bytes": data.len(), "data": base64(&data)})
                }
            })
            .collect(),
    )
}

/// Standard base64 (RFC 4648, with padding). Small enough not to need a crate.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], chunk.get(1).copied().unwrap_or(0), chunk.get(2).copied().unwrap_or(0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A generated PDF with `n` blank 200×300 pt pages (no real documents in fixtures).
    fn fixture(n: usize) -> Snapshot {
        let mut a = Automation::new();
        let created = a.call("doc_create", &json!({"from": "blank", "pages": n, "width": 200, "height": 300})).expect("doc_create");
        let doc = match &created[0] {
            Content::Json(v) => v["doc"].as_u64().or_else(|| v["document"]["doc"].as_u64()).expect("a doc id"),
            Content::Png { .. } => panic!("doc_create returned an image"),
        };
        let bytes = a.session().save_full_bytes(DocId(doc)).expect("bytes");
        Snapshot { name: "generated.pdf".into(), bytes: bytes.to_vec() }
    }

    fn pages(e: &mut Executor, s: &Snapshot) -> u64 {
        let out = e.run(s, "doc_inspect", Value::Null).expect("doc_inspect");
        assert!(out.changed.is_none(), "inspecting changes nothing");
        out.result[0]["document"]["pages"].as_u64().expect("pages")
    }

    #[test]
    fn a_reading_tool_changes_nothing_and_leaves_no_history() {
        let mut e = Executor::new();
        let doc = fixture(3);
        assert_eq!(pages(&mut e, &doc), 3);
        assert!(!e.can_undo());
    }

    #[test]
    fn an_editing_tool_returns_the_new_document_and_undo_returns_the_old() {
        let mut e = Executor::new();
        let doc = fixture(3);
        let out = e.run(&doc, "page_delete", json!({"pages": [2]})).expect("page_delete");
        let after = out.changed.expect("the document changed");
        assert_ne!(after.bytes, doc.bytes);
        assert_eq!(after.name, doc.name);
        assert_eq!(pages(&mut e, &after), 2);
        assert!(e.can_undo());
        assert_eq!(e.undo(), Some(doc.clone()), "undo gives back the bytes the edit replaced");
        assert!(!e.can_undo());
        assert_eq!(pages(&mut e, &doc), 3);
    }

    #[test]
    fn history_is_bounded() {
        let mut e = Executor::new();
        let mut doc = fixture(1);
        for _ in 0..UNDO_LIMIT + 3 {
            doc = e.run(&doc, "page_rotate", json!({"pages": [1], "degrees": 90})).expect("rotate").changed.expect("changed");
        }
        let mut n = 0;
        while e.undo().is_some() {
            n += 1;
        }
        assert_eq!(n, UNDO_LIMIT);
    }

    #[test]
    fn file_tools_and_paths_are_refused() {
        let mut e = Executor::new();
        let doc = fixture(1);
        assert!(e.run(&doc, "doc_open", json!({"path": "/etc/passwd"})).is_err());
        assert!(e.run(&doc, "doc_save", Value::Null).is_err());
        assert!(e.run(&doc, "doc_create", json!({"from": "blank"})).is_err(), "one document at a time");
        assert!(e.run(&doc, "doc_export_text", json!({"path": "out.txt"})).is_err(), "a path names a file");
        assert!(e.run(&doc, "doc_inspect", json!({"doc": 7})).is_err(), "doc is the executor's to supply");
        assert!(e.run(&doc, "doc_inspect", json!([1, 2])).is_err(), "args must be an object");
    }

    #[test]
    fn a_failing_tool_leaves_no_history_and_no_open_document() {
        let mut e = Executor::new();
        let doc = fixture(2);
        assert!(e.run(&doc, "no_such_tool", Value::Null).is_err());
        assert!(e.run(&doc, "page_delete", json!({"pages": [9]})).is_err());
        assert!(!e.can_undo());
        assert!(e.automation.session().docs().is_empty(), "every snapshot is closed");
    }

    #[test]
    fn bytes_that_are_not_a_pdf_are_refused() {
        let mut e = Executor::new();
        let junk = Snapshot { name: "junk.pdf".into(), bytes: b"not a pdf".to_vec() };
        assert!(e.run(&junk, "doc_inspect", Value::Null).is_err());
    }

    #[test]
    fn base64_matches_rfc_4648() {
        for (raw, encoded) in
            [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")]
        {
            assert_eq!(base64(raw.as_bytes()), encoded);
        }
    }

    #[test]
    fn a_render_carries_the_png_itself() {
        let mut e = Executor::new();
        let out = e.run(&fixture(1), "page_render", json!({"page": 1, "dpi": 24})).expect("page_render");
        let image = &out.result[0];
        assert_eq!(image["type"], "image/png");
        let data = image["data"].as_str().expect("data");
        // "\x89PNG\r\n\x1a\n" in base64 starts "iVBORw0KGgo".
        assert!(data.starts_with("iVBORw0KGgo"), "a PNG signature");
        assert_eq!(data.len(), image["bytes"].as_u64().expect("bytes").div_ceil(3) as usize * 4);
    }
}
