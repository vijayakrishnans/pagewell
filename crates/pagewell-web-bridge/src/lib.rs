//! Pagewell's editor in the browser.
//!
//! PdfCraft's egui editor (`pdfcraft-ui-egui`, vendored at `vendor/pdfcraft`) mounted on a canvas
//! in a host page, with a small JavaScript API (`PagewellEditor`, wasm32 only):
//!
//! - `PagewellEditor.mount(canvasId)` starts the editor under the Pagewell brand;
//! - `open(bytes, name)` opens a PDF; `save()` resolves to the document's bytes; `isDirty()`;
//! - `automation({tool, args})` runs one of PdfCraft's tools (the schemas in
//!   `specs/epics/pagewell-pdf-workspace/pdf-tools.json`) on the open document and shows the
//!   result in place; `undo()` steps back through those runs;
//! - events on the canvas: `pagewell:ready`, `pagewell:dirty` (`{dirty}`), `pagewell:save`
//!   (`{name, bytes}`, when the user saves), `pagewell:error` (`{message}`).
//!
//! [`executor`] is the platform-independent part, tested natively.

pub mod brand;
pub mod executor;

#[cfg(target_arch = "wasm32")]
mod web;
