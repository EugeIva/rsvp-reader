//! EPUB books, read with rbook.

use crate::book::{resolve_link, BookSource};
use rbook::epub::rewrite::{EpubRewriteOptions, PathRewrite};
use rbook::Epub;

pub struct EpubBook {
    epub: Epub,
}

impl EpubBook {
    pub fn open(path: &str) -> Result<Self, String> {
        let epub = Epub::open(path).map_err(|e| format!("Failed to open EPUB: {e}"))?;
        Ok(Self { epub })
    }
}

impl BookSource for EpubBook {
    fn title(&self) -> String {
        self.epub
            .metadata()
            .title()
            .map(|t| t.value().to_string())
            .unwrap_or_default()
    }

    fn author(&self) -> String {
        self.epub
            .metadata()
            .creators()
            .next()
            .map(|c| c.value().to_string())
            .unwrap_or_default()
    }

    fn chapter_count(&self) -> usize {
        self.epub.spine().len()
    }

    /// Book-relative paths (`img src`, `a href`, SVG image `href`) are
    /// rewritten to absolute book paths with rbook's path rewrite; `#fragment`
    /// links and URLs with a scheme are left alone. Chapters that aren't
    /// well-formed XML can't be rewritten and are returned unchanged.
    fn chapter_html(&self, index: usize) -> Result<String, String> {
        let rewrite = EpubRewriteOptions::new().rewrite_paths(PathRewrite::root_relative());
        if let Ok(content) = self
            .epub
            .reader_builder()
            .rewrite(rewrite)
            .create()
            .get(index)
        {
            return Ok(content.into_string());
        }
        let content = self
            .epub
            .reader()
            .get(index)
            .map_err(|e| format!("Failed to read chapter {index}: {e}"))?;
        Ok(content.into_string())
    }

    fn chapter_paths(&self) -> Vec<String> {
        let spine = self.epub.spine();
        (0..spine.len())
            .map(|i| {
                spine
                    .get(i)
                    .and_then(|entry| entry.manifest_entry())
                    .map(|m| resolve_link("", m.href().as_str()).0)
                    .unwrap_or_default()
            })
            .collect()
    }

    fn read_resource(&self, path: &str) -> Result<Vec<u8>, String> {
        self.epub
            .read_resource_bytes(path)
            .map_err(|e| format!("Failed to read resource '{path}': {e}"))
    }
}
