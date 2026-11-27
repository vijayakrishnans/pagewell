//! The JavaScript side: `PagewellEditor`.
//!
//! The editor is PdfCraft's `PdfCraftApp` run by eframe on a canvas the host page provides. It is
//! driven through the same hooks upstream's web build uses (`apps/pdfcraft-web`): files go in
//! through the app's open inbox, saves come out through `host_save`, unsaved state through
//! `host_dirty`, and `save()` asks the app to save through its control channel (`file.save`).
//! Events are DOM `CustomEvent`s on the canvas.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use pdfcraft_ui_egui::control::ControlClient;
use pdfcraft_ui_egui::{Inbox, PdfCraftApp};
use serde_json::{Value, json};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

use crate::executor::{Executor, Snapshot};

/// The largest file `open` accepts (as upstream's host bridge).
const MAX_OPEN_BYTES: usize = 512 << 20;

struct Inner {
    canvas: web_sys::HtmlCanvasElement,
    inbox: Inbox,
    ctx: egui::Context,
    control: ControlClient,
    dirty: Cell<bool>,
    /// The resolve/reject of a pending `save()`.
    pending_save: RefCell<Option<(js_sys::Function, js_sys::Function)>>,
    /// The name of the document last opened through `open`, for saves that come back unnamed.
    name: RefCell<String>,
    executor: RefCell<Executor>,
}

impl Inner {
    fn emit(&self, kind: &str, detail: &JsValue) {
        let init = web_sys::CustomEventInit::new();
        init.set_detail(detail);
        if let Ok(event) = web_sys::CustomEvent::new_with_event_init_dict(&format!("pagewell:{kind}"), &init) {
            let _ = self.canvas.dispatch_event(&event);
        }
    }

    fn emit_error(&self, message: &str) {
        let detail = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&detail, &"message".into(), &message.into());
        self.emit("error", &detail);
    }

    /// Queue `bytes` to open in the editor, replacing the document shown.
    fn show(&self, name: &str, bytes: Vec<u8>, replace: bool) {
        if replace {
            // The editor opens each file in a tab: close the current one first. It was just saved
            // (or is being replaced on purpose), so closing asks nothing.
            let _ = self.control.send("ui.command", json!({"id": "file.close"}));
        }
        if let Ok(mut q) = self.inbox.lock() {
            q.push((name.to_string(), bytes));
        }
        self.ctx.request_repaint();
    }

    /// A promise for the open document's bytes: asks the app to save, and `host_save` resolves it.
    fn snapshot(self: &Rc<Self>) -> js_sys::Promise {
        let inner = self.clone();
        js_sys::Promise::new(&mut move |resolve, reject| {
            if inner.pending_save.borrow().is_some() {
                let _ = reject.call1(&JsValue::NULL, &"a save is already in progress".into());
                return;
            }
            *inner.pending_save.borrow_mut() = Some((resolve, reject));
            let _ = inner.control.send("ui.command", json!({"id": "file.save"}));
            inner.ctx.request_repaint();
        })
    }
}

/// PdfCraft's editor, mounted on a canvas, as Pagewell drives it.
#[wasm_bindgen]
pub struct PagewellEditor {
    inner: Rc<Inner>,
}

#[wasm_bindgen]
impl PagewellEditor {
    /// Start the editor on the canvas with id `canvas_id`. Resolves to the editor once it runs;
    /// `pagewell:ready` fires on the canvas too.
    pub async fn mount(canvas_id: String) -> Result<PagewellEditor, JsValue> {
        crate::brand::install();
        let canvas = web_sys::window()
            .and_then(|w| w.document())
            .and_then(|d| d.get_element_by_id(&canvas_id))
            .and_then(|e| e.dyn_into::<web_sys::HtmlCanvasElement>().ok())
            .ok_or_else(|| JsValue::from_str(&format!("no canvas with id {canvas_id}")))?;

        let slot: Rc<RefCell<Option<Rc<Inner>>>> = Rc::new(RefCell::new(None));
        let built = slot.clone();
        let host_canvas = canvas.clone();
        let options = eframe::WebOptions { renderer: eframe::Renderer::Glow, ..Default::default() };
        eframe::WebRunner::new()
            .start(
                canvas.clone(),
                options,
                Box::new(move |cc| {
                    let mut app = PdfCraftApp::new();
                    // Pagewell's own pages say what Pagewell is; PdfCraft's Home community card is not ours.
                    app.community_card_closed = true;
                    let control = app.attach_control(&cc.egui_ctx);
                    let inner = Rc::new(Inner {
                        canvas: host_canvas,
                        inbox: app.startup_inbox.clone(),
                        ctx: cc.egui_ctx.clone(),
                        control,
                        dirty: Cell::new(false),
                        pending_save: RefCell::new(None),
                        name: RefCell::new("document.pdf".into()),
                        executor: RefCell::new(Executor::new()),
                    });
                    let on_save = inner.clone();
                    app.host_save = Some(Box::new(move |name: &str, bytes: &[u8], save_as: bool| {
                        let array = js_sys::Uint8Array::from(bytes);
                        if let Some((resolve, _)) = on_save.pending_save.borrow_mut().take() {
                            let _ = resolve.call1(&JsValue::NULL, &array);
                        } else {
                            let detail = js_sys::Object::new();
                            let _ = js_sys::Reflect::set(&detail, &"name".into(), &name.into());
                            let _ = js_sys::Reflect::set(&detail, &"bytes".into(), &array);
                            let _ = js_sys::Reflect::set(&detail, &"saveAs".into(), &save_as.into());
                            on_save.emit("save", &detail);
                        }
                        Ok(())
                    }));
                    let on_dirty = inner.clone();
                    app.host_dirty = Some(Box::new(move |dirty: bool| {
                        if on_dirty.dirty.replace(dirty) != dirty {
                            let detail = js_sys::Object::new();
                            let _ = js_sys::Reflect::set(&detail, &"dirty".into(), &dirty.into());
                            on_dirty.emit("dirty", &detail);
                        }
                    }));
                    *built.borrow_mut() = Some(inner);
                    Ok(Box::new(app))
                }),
            )
            .await?;
        let inner = slot.borrow_mut().take().ok_or_else(|| JsValue::from_str("the editor did not start"))?;
        inner.emit("ready", &JsValue::UNDEFINED);
        Ok(PagewellEditor { inner })
    }

    /// Open a PDF from its bytes.
    pub fn open(&self, bytes: js_sys::Uint8Array, name: String) -> Result<(), JsValue> {
        if bytes.length() as usize > MAX_OPEN_BYTES {
            return Err(JsValue::from_str("the file is over the 512 MiB open limit"));
        }
        let name = if name.trim().is_empty() { "document.pdf".to_string() } else { name };
        *self.inner.name.borrow_mut() = name.clone();
        self.inner.executor.borrow_mut().clear();
        self.inner.show(&name, bytes.to_vec(), false);
        Ok(())
    }

    /// The open document's bytes, as a `Uint8Array` (the editor saves to produce them).
    pub fn save(&self) -> js_sys::Promise {
        self.inner.snapshot()
    }

    /// Whether the open document has unsaved changes.
    #[wasm_bindgen(js_name = isDirty)]
    pub fn is_dirty(&self) -> bool {
        self.inner.dirty.get()
    }

    /// Run one of PdfCraft's tools on the open document: `{tool, args}`. Resolves to
    /// `{result, changed, canUndo}`; a change is shown in the editor and can be undone.
    pub async fn automation(&self, call: JsValue) -> Result<JsValue, JsValue> {
        let call: Value = serde_json::from_str(&js_sys::JSON::stringify(&call)?.as_string().unwrap_or_default())
            .map_err(|e| JsValue::from_str(&format!("call: {e}")))?;
        let tool = call.get("tool").and_then(Value::as_str).ok_or_else(|| JsValue::from_str("call.tool is required"))?.to_string();
        let args = call.get("args").cloned().unwrap_or(Value::Null);

        let bytes = wasm_bindgen_futures::JsFuture::from(self.inner.snapshot()).await?;
        let current = Snapshot { name: self.inner.name.borrow().clone(), bytes: js_sys::Uint8Array::new(&bytes).to_vec() };
        let outcome = self.inner.executor.borrow_mut().run(&current, &tool, args);
        let outcome = outcome.map_err(|e| {
            self.inner.emit_error(&e);
            JsValue::from_str(&e)
        })?;
        let changed = outcome.changed.is_some();
        if let Some(next) = outcome.changed {
            self.inner.show(&next.name, next.bytes, true);
        }
        let reply = json!({"result": outcome.result, "changed": changed, "canUndo": self.inner.executor.borrow().can_undo()});
        js_sys::JSON::parse(&reply.to_string())
    }

    /// Step back over the last change `automation` made. Resolves to whether there was one.
    pub fn undo(&self) -> bool {
        let previous = self.inner.executor.borrow_mut().undo();
        match previous {
            Some(s) => {
                self.inner.show(&s.name, s.bytes, true);
                true
            }
            None => false,
        }
    }

    /// Whether `undo` has anything to step back over.
    #[wasm_bindgen(js_name = canUndo)]
    pub fn can_undo(&self) -> bool {
        self.inner.executor.borrow().can_undo()
    }
}
