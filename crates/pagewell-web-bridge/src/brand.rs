//! The brand the editor shows: Pagewell's name in place of PdfCraft's, and none of ArtCraft's
//! marks or community links (vendor/UPSTREAM-PATCHES.md, P2).

use pdfcraft_ui_egui::brand::HostBrand;

/// Pagewell's brand for the editor.
pub const PAGEWELL: HostBrand =
    HostBrand { name: "Pagewell", about: "Pagewell is built on PdfCraft (MIT OR Apache-2.0). Not affiliated with ArtCraft or Adobe." };

/// Set the brand before the editor starts. Idempotent.
pub fn install() {
    let _ = pdfcraft_ui_egui::brand::set(PAGEWELL);
}

#[cfg(test)]
mod tests {
    #[test]
    fn installs_once_and_names_the_app_pagewell() {
        super::install();
        super::install();
        assert_eq!(pdfcraft_ui_egui::brand::name(), "Pagewell");
        assert!(!pdfcraft_ui_egui::brand::community(), "ArtCraft's community links are hidden");
        assert!(pdfcraft_ui_egui::brand::hides("help.discord"));
    }
}
