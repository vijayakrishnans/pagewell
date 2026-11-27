//! A host's brand: the name a product embedding PdfCraft shows in its place, set once before the
//! app starts. Unset, the app reads as PdfCraft. Under a host brand, PdfCraft's own community
//! links (Discord, web page, GitHub, ArtCraft website) and the ArtCraft marks are left out of the
//! menus, palette, tool bar, Home and About, since they are not the host's to show.

use std::sync::OnceLock;

/// What an embedding host shows instead of PdfCraft's name and marks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostBrand {
    /// The product name in the window and page titles, the app menu and About.
    pub name: &'static str,
    /// One line for About under the name, such as "Built on PdfCraft (MIT OR Apache-2.0)".
    pub about: &'static str,
}

static BRAND: OnceLock<HostBrand> = OnceLock::new();

/// Set the host brand. The first call wins; `false` when a brand was already set.
pub fn set(brand: HostBrand) -> bool {
    BRAND.set(brand).is_ok()
}

/// The host brand, when one is set.
pub fn get() -> Option<&'static HostBrand> {
    BRAND.get()
}

/// The app's name: the host's, or PdfCraft.
pub fn name() -> &'static str {
    name_for(get())
}

/// Whether PdfCraft's community links and ArtCraft marks show: only without a host brand.
pub fn community() -> bool {
    get().is_none()
}

/// Whether command `id` is left out of menus, the palette and the tool bar under the brand.
pub fn hides(id: &str) -> bool {
    hides_for(get(), id)
}

fn name_for(brand: Option<&HostBrand>) -> &'static str {
    brand.map_or("PdfCraft", |b| b.name)
}

fn hides_for(brand: Option<&HostBrand>, id: &str) -> bool {
    brand.is_some() && pdfcraft_engine::links::for_command(id).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: HostBrand = HostBrand { name: "Host", about: "Built on PdfCraft" };

    #[test]
    fn unset_reads_as_pdfcraft_and_hides_nothing() {
        assert_eq!(name_for(None), "PdfCraft");
        for link in pdfcraft_engine::links::LINKS {
            assert!(!hides_for(None, link.command), "{} shows without a brand", link.command);
        }
    }

    #[test]
    fn a_brand_renames_the_app_and_hides_only_the_community_links() {
        assert_eq!(name_for(Some(&HOST)), "Host");
        for link in pdfcraft_engine::links::LINKS {
            assert!(hides_for(Some(&HOST), link.command), "{} is hidden under a brand", link.command);
        }
        assert!(!hides_for(Some(&HOST), "help.about"));
        assert!(!hides_for(Some(&HOST), "file.save"));
    }
}
