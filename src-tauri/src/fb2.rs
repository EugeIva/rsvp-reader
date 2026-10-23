//! FB2 (FictionBook 2) books: one XML file, optionally zipped (.fb2.zip).
//!
//! The book is converted to XHTML chapters up front:
//! - the cover (if any) is chapter 0;
//! - every innermost `<section>` of the main body is a chapter, with the
//!   titles and epigraphs of the sections (and body) above it carried into
//!   the first chapter under them;
//! - every notes/comments `<body>` is one chapter at the end.
//!
//! Each chapter's content is wrapped in `<div class="fb2">`, which scopes
//! the FB2 styles in epubFlow.css (EPUBs use the same class names).
//!
//! Chapter paths are `/ch{N}.xhtml`; embedded images (`<binary>`) are served
//! at `/binary/{id}`. Internal links (`#n1`) point at the chapter holding the
//! target, so footnotes in a notes body work like EPUB cross-chapter links.

use crate::book::{mime_from_extension, BookSource};
use base64::Engine;
use roxmltree::{Document, Node, ParsingOptions};
use std::collections::HashMap;

const XLINK: &str = "http://www.w3.org/1999/xlink";

pub struct Fb2Book {
    title: String,
    author: String,
    chapters: Vec<String>,
    binaries: HashMap<String, Binary>,
}

struct Binary {
    mime: String,
    data: Vec<u8>,
}

impl Fb2Book {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let text = with_numeric_entities(strip_declaration(&decode(bytes)));
        let options = ParsingOptions {
            allow_dtd: true,
            ..ParsingOptions::default()
        };
        let doc = Document::parse_with_options(&text, options)
            .map_err(|e| format!("Invalid FB2 XML: {e}"))?;
        let root = doc.root_element();
        if name(root) != "FictionBook" {
            return Err("Not an FB2 file".into());
        }

        let title_info = child(root, "description").and_then(|d| child(d, "title-info"));
        let title = title_info
            .and_then(|t| child(t, "book-title"))
            .map(text_of)
            .unwrap_or_default();
        let author = title_info
            .and_then(|t| child(t, "author"))
            .map(author_name)
            .unwrap_or_default();
        let cover = title_info
            .and_then(|t| child(t, "coverpage"))
            .and_then(|c| child(c, "image"))
            .and_then(href)
            .and_then(|h| h.strip_prefix('#'))
            .map(str::to_string);

        let plan = plan_chapters(root, cover);
        let chapters = render_chapters(&plan, &title);
        Ok(Self {
            title,
            author,
            chapters,
            binaries: read_binaries(root),
        })
    }
}

impl BookSource for Fb2Book {
    fn title(&self) -> String {
        self.title.clone()
    }

    fn author(&self) -> String {
        self.author.clone()
    }

    fn chapter_count(&self) -> usize {
        self.chapters.len()
    }

    fn chapter_html(&self, index: usize) -> Result<String, String> {
        self.chapters
            .get(index)
            .cloned()
            .ok_or_else(|| format!("No chapter {index}"))
    }

    fn chapter_paths(&self) -> Vec<String> {
        (0..self.chapters.len())
            .map(|i| format!("/ch{i}.xhtml"))
            .collect()
    }

    fn read_resource(&self, path: &str) -> Result<Vec<u8>, String> {
        path.strip_prefix("/binary/")
            .and_then(|id| self.binaries.get(id))
            .map(|b| b.data.clone())
            .ok_or_else(|| format!("No resource '{path}'"))
    }

    fn mime_for(&self, path: &str) -> String {
        path.strip_prefix("/binary/")
            .and_then(|id| self.binaries.get(id))
            .map(|b| b.mime.clone())
            .unwrap_or_else(|| mime_from_extension(path).to_string())
    }
}

// ---------------------------------------------------------------------------
// Decoding

/// Decode to UTF-8: a BOM wins, then the XML declaration's encoding
/// (many Russian FB2 files are windows-1251), else UTF-8.
fn decode(bytes: &[u8]) -> String {
    if let Some((encoding, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        return encoding
            .decode_without_bom_handling(&bytes[bom_len..])
            .0
            .into_owned();
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(200)]);
    let label = head.find("encoding=").and_then(|i| {
        let rest = &head[i + "encoding=".len()..];
        let quote = rest.chars().next().filter(|q| *q == '"' || *q == '\'')?;
        let rest = &rest[1..];
        rest.find(quote).map(|end| rest[..end].trim().to_string())
    });
    let encoding = label
        .and_then(|l| encoding_rs::Encoding::for_label(l.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode_without_bom_handling(bytes).0.into_owned()
}

/// Drop the XML declaration: the text is UTF-8 now, whatever it declared.
fn strip_declaration(text: &str) -> &str {
    let text = text.trim_start_matches('\u{feff}').trim_start();
    if text.starts_with("<?xml") {
        if let Some(end) = text.find("?>") {
            return &text[end + 2..];
        }
    }
    text
}

/// HTML entities some FB2 files use, which XML doesn't define.
fn with_numeric_entities(text: &str) -> String {
    const ENTITIES: [(&str, &str); 14] = [
        ("&nbsp;", "&#160;"),
        ("&mdash;", "&#8212;"),
        ("&ndash;", "&#8211;"),
        ("&laquo;", "&#171;"),
        ("&raquo;", "&#187;"),
        ("&hellip;", "&#8230;"),
        ("&copy;", "&#169;"),
        ("&shy;", "&#173;"),
        ("&ldquo;", "&#8220;"),
        ("&rdquo;", "&#8221;"),
        ("&lsquo;", "&#8216;"),
        ("&rsquo;", "&#8217;"),
        ("&bdquo;", "&#8222;"),
        ("&minus;", "&#8722;"),
    ];
    let mut out = text.to_string();
    for (named, numeric) in ENTITIES {
        if out.contains(named) {
            out = out.replace(named, numeric);
        }
    }
    out
}

fn read_binaries(root: Node) -> HashMap<String, Binary> {
    // Some files omit base64 padding.
    let engine = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    );
    let mut binaries = HashMap::new();
    for node in children(root, "binary") {
        let Some(id) = node.attribute("id") else {
            continue;
        };
        let encoded: String = node
            .text()
            .unwrap_or("")
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        if let Ok(data) = engine.decode(encoded) {
            let mime = node
                .attribute("content-type")
                .map(str::to_string)
                .unwrap_or_else(|| mime_from_extension(id).to_string());
            binaries.insert(id.to_string(), Binary { mime, data });
        }
    }
    binaries
}

// ---------------------------------------------------------------------------
// Tree helpers

fn name<'a>(node: Node<'a, '_>) -> &'a str {
    node.tag_name().name()
}

fn children<'a, 'i>(node: Node<'a, 'i>, tag: &'static str) -> impl Iterator<Item = Node<'a, 'i>> {
    node.children()
        .filter(move |c| c.is_element() && name(*c) == tag)
}

fn child<'a, 'i>(node: Node<'a, 'i>, tag: &'static str) -> Option<Node<'a, 'i>> {
    children(node, tag).next()
}

/// `l:href` / `xlink:href` (whatever the prefix), or a plain `href`.
fn href<'a>(node: Node<'a, '_>) -> Option<&'a str> {
    node.attribute((XLINK, "href")).or_else(|| {
        node.attributes()
            .find(|a| a.name() == "href")
            .map(|a| a.value())
    })
}

/// All text inside `node`, with whitespace collapsed.
fn text_of(node: Node) -> String {
    let text: String = node
        .descendants()
        .filter(|n| n.is_text())
        .filter_map(|n| n.text())
        .collect();
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn author_name(author: Node) -> String {
    let parts: Vec<String> = ["first-name", "middle-name", "last-name"]
        .iter()
        .filter_map(|tag| child(author, tag).map(text_of))
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        child(author, "nickname").map(text_of).unwrap_or_default()
    } else {
        parts.join(" ")
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_attr(text: &str) -> String {
    escape(text).replace('"', "&quot;")
}

// ---------------------------------------------------------------------------
// Chapter plan

/// A piece of a chapter.
enum Part<'a, 'i> {
    Cover(String),
    /// A body without sections, as one chapter.
    Body(Node<'a, 'i>),
    /// A body's title, epigraphs and images before its first section.
    BodyHead(Node<'a, 'i>),
    /// A section with subsections: its title, epigraphs and anything before
    /// the first subsection.
    SectionHead(Node<'a, 'i>, usize),
    /// Anything in a section after its last subsection.
    SectionTail(Node<'a, 'i>, usize),
    /// A section without subsections, whole.
    Section(Node<'a, 'i>, usize),
    /// A notes/comments body.
    Notes(Node<'a, 'i>),
}

fn plan_chapters<'a, 'i>(root: Node<'a, 'i>, cover: Option<String>) -> Vec<Vec<Part<'a, 'i>>> {
    let mut chapters: Vec<Vec<Part>> = Vec::new();
    if let Some(id) = cover {
        chapters.push(vec![Part::Cover(id)]);
    }
    for (i, body) in children(root, "body").enumerate() {
        // The main body comes first; later named bodies hold notes or comments.
        if i > 0 && body.attribute("name").is_some() {
            chapters.push(vec![Part::Notes(body)]);
            continue;
        }
        let sections: Vec<Node> = children(body, "section").collect();
        if sections.is_empty() {
            chapters.push(vec![Part::Body(body)]);
            continue;
        }
        let mut pending = Vec::new();
        if body
            .children()
            .any(|c| c.is_element() && name(c) != "section")
        {
            pending.push(Part::BodyHead(body));
        }
        for section in sections {
            plan_section(section, 1, &mut pending, &mut chapters);
        }
        if !pending.is_empty() {
            chapters.push(pending);
        }
    }
    chapters
}

fn plan_section<'a, 'i>(
    section: Node<'a, 'i>,
    depth: usize,
    pending: &mut Vec<Part<'a, 'i>>,
    chapters: &mut Vec<Vec<Part<'a, 'i>>>,
) {
    let subsections: Vec<Node> = children(section, "section").collect();
    if subsections.is_empty() {
        pending.push(Part::Section(section, depth));
        chapters.push(std::mem::take(pending));
        return;
    }
    pending.push(Part::SectionHead(section, depth));
    for sub in subsections {
        plan_section(sub, depth + 1, pending, chapters);
    }
    let last = section
        .children()
        .rfind(|c| c.is_element() && name(*c) == "section");
    let has_tail = last
        .map(|l| l.next_siblings().skip(1).any(|c| c.is_element()))
        .unwrap_or(false);
    if has_tail {
        match chapters.last_mut() {
            Some(chapter) => chapter.push(Part::SectionTail(section, depth)),
            None => pending.push(Part::SectionTail(section, depth)),
        }
    }
}

// ---------------------------------------------------------------------------
// Rendering

/// Render every chapter twice: the first pass finds which chapter each `id`
/// ends up in, the second writes links to them (`#id` in the same chapter,
/// `/chN.xhtml#id` in another).
fn render_chapters(plan: &[Vec<Part>], title: &str) -> Vec<String> {
    let mut ids = HashMap::new();
    for (index, parts) in plan.iter().enumerate() {
        let mut r = Renderer::new(&ids, index);
        r.parts(parts);
        for id in r.found {
            ids.entry(id).or_insert(index);
        }
    }
    plan.iter()
        .enumerate()
        .map(|(index, parts)| {
            let mut r = Renderer::new(&ids, index);
            r.parts(parts);
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>{}</title></head><body><div class=\"fb2\">{}</div></body></html>",
                escape(title),
                r.out
            )
        })
        .collect()
}

struct Renderer<'m> {
    ids: &'m HashMap<String, usize>,
    chapter: usize,
    found: Vec<String>,
    out: String,
}

impl<'m> Renderer<'m> {
    fn new(ids: &'m HashMap<String, usize>, chapter: usize) -> Self {
        Self {
            ids,
            chapter,
            found: Vec::new(),
            out: String::new(),
        }
    }

    fn parts(&mut self, parts: &[Part]) {
        for part in parts {
            match part {
                Part::Cover(id) => {
                    self.out
                        .push_str("<div class=\"cover\"><img src=\"/binary/");
                    self.out.push_str(&escape_attr(id));
                    self.out.push_str("\" alt=\"\"/></div>");
                }
                Part::Body(body) => self.blocks(body.children(), 0),
                Part::BodyHead(body) => self.blocks(
                    body.children()
                        .filter(|c| !(c.is_element() && name(*c) == "section")),
                    0,
                ),
                Part::SectionHead(section, depth) => {
                    let id = self.id_attr(*section);
                    self.out
                        .push_str(&format!("<div class=\"section-head\"{id}>"));
                    self.blocks(
                        section
                            .children()
                            .take_while(|c| !(c.is_element() && name(*c) == "section")),
                        *depth,
                    );
                    self.out.push_str("</div>");
                }
                Part::SectionTail(section, depth) => {
                    let after_last = section
                        .children()
                        .rfind(|c| c.is_element() && name(*c) == "section")
                        .map(|l| l.next_siblings().skip(1).collect::<Vec<_>>())
                        .unwrap_or_default();
                    self.blocks(after_last.into_iter(), *depth);
                }
                Part::Section(section, depth) => self.section(*section, *depth),
                Part::Notes(body) => {
                    self.out.push_str("<div class=\"notes\">");
                    for node in body.children().filter(|c| c.is_element()) {
                        if name(node) == "section" {
                            self.note(node);
                        } else {
                            self.block(node, 1);
                        }
                    }
                    self.out.push_str("</div>");
                }
            }
        }
    }

    /// ` id="..."` for a node with an id (recorded for link targets), or "".
    fn id_attr(&mut self, node: Node) -> String {
        match node.attribute("id") {
            Some(id) => {
                self.found.push(id.to_string());
                format!(" id=\"{}\"", escape_attr(id))
            }
            None => String::new(),
        }
    }

    fn section(&mut self, section: Node, depth: usize) {
        let id = self.id_attr(section);
        self.out.push_str(&format!("<div class=\"section\"{id}>"));
        self.blocks(section.children(), depth);
        self.out.push_str("</div>");
    }

    /// A footnote: its title (usually the note number) in bold, then the text.
    fn note(&mut self, section: Node) {
        let id = self.id_attr(section);
        self.out.push_str(&format!("<div class=\"note\"{id}>"));
        for node in section.children().filter(|c| c.is_element()) {
            match name(node) {
                "title" => {
                    self.out.push_str("<p class=\"note-title\"><strong>");
                    self.title_lines(node);
                    self.out.push_str("</strong></p>");
                }
                "section" => self.note(node),
                _ => self.block(node, 2),
            }
        }
        self.out.push_str("</div>");
    }

    fn blocks<'a, 'i: 'a>(&mut self, nodes: impl Iterator<Item = Node<'a, 'i>>, depth: usize) {
        for node in nodes {
            if node.is_element() {
                self.block(node, depth);
            } else if let Some(text) = node.text().filter(|t| !t.trim().is_empty()) {
                // Stray text between blocks.
                self.out
                    .push_str(&format!("<p>{}</p>", escape(text.trim())));
            }
        }
    }

    fn block(&mut self, node: Node, depth: usize) {
        match name(node) {
            "title" => {
                let level = (depth + 1).min(6);
                let id = self.id_attr(node);
                self.out
                    .push_str(&format!("<h{level} class=\"title\"{id}>"));
                self.title_lines(node);
                self.out.push_str(&format!("</h{level}>"));
            }
            "p" => self.paragraph(node, None),
            "subtitle" => {
                let id = self.id_attr(node);
                self.out
                    .push_str(&format!("<p class=\"subtitle\"{id}><strong>"));
                self.inline(node);
                self.out.push_str("</strong></p>");
            }
            "text-author" => self.paragraph(node, Some("text-author")),
            "date" => self.paragraph(node, Some("date")),
            "v" => self.paragraph(node, Some("v")),
            "empty-line" => self.out.push_str("<p class=\"empty-line\">\u{a0}</p>"),
            "epigraph" => self.wrapped(node, "blockquote", "epigraph", depth),
            "cite" => self.wrapped(node, "blockquote", "cite", depth),
            "annotation" => self.wrapped(node, "div", "annotation", depth),
            "stanza" => self.wrapped(node, "div", "stanza", depth),
            "poem" => {
                let id = self.id_attr(node);
                self.out.push_str(&format!("<div class=\"poem\"{id}>"));
                for c in node.children().filter(|c| c.is_element()) {
                    if name(c) == "title" {
                        self.out.push_str("<p class=\"poem-title\"><strong>");
                        self.title_lines(c);
                        self.out.push_str("</strong></p>");
                    } else {
                        self.block(c, depth);
                    }
                }
                self.out.push_str("</div>");
            }
            "image" => {
                self.out.push_str("<p class=\"image\">");
                self.image(node);
                self.out.push_str("</p>");
            }
            "table" => self.table(node),
            "section" => self.section(node, depth + 1),
            // Inline content at block level: give it a paragraph.
            "emphasis" | "strong" | "strikethrough" | "sub" | "sup" | "code" | "style" | "a" => {
                self.out.push_str("<p>");
                self.inline_node(node);
                self.out.push_str("</p>");
            }
            _ => self.blocks(node.children(), depth),
        }
    }

    fn paragraph(&mut self, node: Node, class: Option<&str>) {
        let id = self.id_attr(node);
        let class = class.map(|c| format!(" class=\"{c}\"")).unwrap_or_default();
        self.out.push_str(&format!("<p{class}{id}>"));
        self.inline(node);
        self.out.push_str("</p>");
    }

    fn wrapped(&mut self, node: Node, tag: &str, class: &str, depth: usize) {
        let id = self.id_attr(node);
        self.out.push_str(&format!("<{tag} class=\"{class}\"{id}>"));
        self.blocks(node.children(), depth);
        self.out.push_str(&format!("</{tag}>"));
    }

    /// A title's paragraphs as lines of one heading.
    fn title_lines(&mut self, title: Node) {
        let mut first = true;
        for p in title
            .children()
            .filter(|c| c.is_element() && name(*c) == "p")
        {
            if !first {
                self.out.push_str("<br/>");
            }
            first = false;
            self.inline(p);
        }
    }

    fn table(&mut self, table: Node) {
        let id = self.id_attr(table);
        self.out.push_str(&format!("<table{id}>"));
        for tr in children(table, "tr") {
            self.out.push_str("<tr>");
            for cell in tr
                .children()
                .filter(|c| c.is_element() && matches!(name(*c), "td" | "th"))
            {
                let tag = name(cell);
                let mut attrs = String::new();
                for attr in ["colspan", "rowspan", "align"] {
                    if let Some(v) = cell.attribute(attr) {
                        attrs.push_str(&format!(" {attr}=\"{}\"", escape_attr(v)));
                    }
                }
                self.out.push_str(&format!("<{tag}{attrs}>"));
                self.inline(cell);
                self.out.push_str(&format!("</{tag}>"));
            }
            self.out.push_str("</tr>");
        }
        self.out.push_str("</table>");
    }

    fn image(&mut self, node: Node) {
        if let Some(id) = href(node).and_then(|h| h.strip_prefix('#')) {
            self.out.push_str(&format!(
                "<img src=\"/binary/{}\" alt=\"\"/>",
                escape_attr(id)
            ));
        }
    }

    fn inline(&mut self, node: Node) {
        for c in node.children() {
            self.inline_node(c);
        }
    }

    fn inline_node(&mut self, node: Node) {
        if node.is_text() {
            self.out.push_str(&escape(node.text().unwrap_or("")));
            return;
        }
        if !node.is_element() {
            return;
        }
        let tag = match name(node) {
            "emphasis" => "em",
            "strong" => "strong",
            "strikethrough" => "s",
            "sub" => "sub",
            "sup" => "sup",
            "code" => "code",
            "style" => "span",
            "a" => return self.link(node),
            "image" => return self.image(node),
            _ => return self.inline(node),
        };
        self.out.push_str(&format!("<{tag}>"));
        self.inline(node);
        self.out.push_str(&format!("</{tag}>"));
    }

    fn link(&mut self, a: Node) {
        let target = href(a).unwrap_or("");
        let resolved = match target.strip_prefix('#') {
            Some(id) => match self.ids.get(id) {
                Some(&chapter) if chapter != self.chapter => format!("/ch{chapter}.xhtml#{id}"),
                _ => format!("#{id}"),
            },
            None => target.to_string(),
        };
        let note = a.attribute("type") == Some("note");
        let class = if note { " class=\"note-ref\"" } else { "" };
        self.out
            .push_str(&format!("<a href=\"{}\"{class}>", escape_attr(&resolved)));
        if note {
            self.out.push_str("<sup>");
        }
        self.inline(a);
        if note {
            self.out.push_str("</sup>");
        }
        self.out.push_str("</a>");
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::book::{find_chapter, resolve_link};

    /// A small book with the things real FB2 files have: a cover, nested
    /// sections, an epigraph, a poem, a footnote and an embedded image.
    pub const SAMPLE: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
 <description>
  <title-info>
   <author><first-name>Иван</first-name><middle-name>Петрович</middle-name><last-name>Сидоров</last-name></author>
   <book-title>Тестовая книга</book-title>
   <coverpage><image l:href="#cover.jpg"/></coverpage>
   <lang>ru</lang>
  </title-info>
 </description>
 <body>
  <title><p>Иван Сидоров</p><p>Тестовая книга</p></title>
  <epigraph><p>Эпиграф к книге.</p><text-author>Автор эпиграфа</text-author></epigraph>
  <section id="part1">
   <title><p>Часть первая</p></title>
   <section id="ch1">
    <title><p>Глава 1</p></title>
    <p>Первый абзац со <emphasis>словом</emphasis> и сноской<a l:href="#n1" type="note">[1]</a>.</p>
    <empty-line/>
    <image l:href="#pic.png"/>
   </section>
   <section id="ch2">
    <title><p>Глава 2</p></title>
    <poem><title><p>Стих</p></title><stanza><v>Строка один,</v><v>строка два.</v></stanza></poem>
    <p>Ссылка на <a l:href="#ch1">первую главу</a> и на <a l:href="https://example.com/">сайт</a>.</p>
   </section>
  </section>
 </body>
 <body name="notes">
  <title><p>Примечания</p></title>
  <section id="n1"><title><p>1</p></title><p>Текст сноски.</p></section>
 </body>
 <binary id="cover.jpg" content-type="image/jpeg">/9j/4AAQ</binary>
 <binary id="pic.png" content-type="image/png">iVBORw0KGgo</binary>
</FictionBook>"##;

    fn sample() -> Fb2Book {
        Fb2Book::parse(SAMPLE.as_bytes()).expect("sample parses")
    }

    #[test]
    fn test_metadata() {
        let book = sample();
        assert_eq!(book.title(), "Тестовая книга");
        assert_eq!(book.author(), "Иван Петрович Сидоров");
    }

    #[test]
    fn test_chapters_cover_sections_and_notes() {
        let book = sample();
        // cover, Глава 1 (with the body and part titles above it), Глава 2, notes
        assert_eq!(book.chapter_count(), 4);
        let c = |i| book.chapter_html(i).unwrap();
        assert!(c(0).contains("<div class=\"cover\"><img src=\"/binary/cover.jpg\""));
        assert!(c(1).contains("<h1 class=\"title\">Иван Сидоров<br/>Тестовая книга</h1>"));
        assert!(c(1).contains("Эпиграф к книге"));
        assert!(c(1).contains("<h2 class=\"title\">Часть первая</h2>"));
        assert!(c(1).contains("<h3 class=\"title\">Глава 1</h3>"));
        assert!(c(1).contains("со <em>словом</em>"));
        assert!(c(1).contains("<p class=\"image\"><img src=\"/binary/pic.png\" alt=\"\"/></p>"));
        assert!(c(2).contains("<h3 class=\"title\">Глава 2</h3>"));
        assert!(!c(2).contains("Часть первая"));
        assert!(c(2).contains("<p class=\"v\">Строка один,</p>"));
        assert!(c(3).contains("<div class=\"note\" id=\"n1\">"));
        assert!(c(3).contains("Текст сноски."));
    }

    #[test]
    fn test_chapters_are_well_formed_xhtml() {
        let book = sample();
        for i in 0..book.chapter_count() {
            let html = book.chapter_html(i).unwrap();
            Document::parse(&html).unwrap_or_else(|e| panic!("chapter {i}: {e}"));
        }
    }

    #[test]
    fn test_links_point_at_the_chapter_holding_the_target() {
        let book = sample();
        let ch1 = book.chapter_html(1).unwrap();
        let ch2 = book.chapter_html(2).unwrap();
        assert!(ch1.contains("<a href=\"/ch3.xhtml#n1\" class=\"note-ref\"><sup>[1]</sup></a>"));
        assert!(ch2.contains("<a href=\"/ch1.xhtml#ch1\">первую главу</a>"));
        assert!(ch2.contains("<a href=\"https://example.com/\">сайт</a>"));

        // The app resolves them like EPUB links.
        let paths = book.chapter_paths();
        let (path, anchor) = resolve_link(&paths[1], "/ch3.xhtml#n1");
        assert_eq!(find_chapter(&paths, &path), Some(3));
        assert_eq!(anchor.as_deref(), Some("n1"));
    }

    #[test]
    fn test_images_are_served_with_their_type() {
        let book = sample();
        assert_eq!(
            book.read_resource("/binary/pic.png").unwrap(),
            b"\x89PNG\r\n\x1a\n"
        );
        assert_eq!(book.mime_for("/binary/cover.jpg"), "image/jpeg");
        assert!(book.read_resource("/binary/missing.png").is_err());
    }

    #[test]
    fn test_windows_1251_and_html_entities() {
        let xml = SAMPLE
            .replace("encoding=\"UTF-8\"", "encoding=\"windows-1251\"")
            .replace("Первый абзац", "Первый&nbsp;абзац&mdash;");
        let (bytes, _, unmappable) = encoding_rs::WINDOWS_1251.encode(&xml);
        assert!(!unmappable);
        let book = Fb2Book::parse(&bytes).unwrap();
        assert_eq!(book.title(), "Тестовая книга");
        assert!(book
            .chapter_html(1)
            .unwrap()
            .contains("Первый\u{a0}абзац\u{2014}"));
    }

    #[test]
    fn test_body_without_sections_and_escaping() {
        let xml = r#"<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>A &amp; B</book-title></title-info></description><body><p>x &lt; y &amp; "z"</p></body></FictionBook>"#;
        let book = Fb2Book::parse(xml.as_bytes()).unwrap();
        assert_eq!(book.chapter_count(), 1);
        let html = book.chapter_html(0).unwrap();
        assert!(html.contains("<title>A &amp; B</title>"));
        assert!(html.contains("<p>x &lt; y &amp; \"z\"</p>"));
    }

    #[test]
    fn test_rejects_other_xml() {
        assert!(Fb2Book::parse(b"<html><body/></html>").is_err());
        assert!(Fb2Book::parse(b"not xml at all").is_err());
    }

    #[test]
    fn test_zipped_fb2() {
        use std::io::Write;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file("книга.fb2", options).unwrap();
            zip.write_all(SAMPLE.as_bytes()).unwrap();
            zip.finish().unwrap();
        }
        let book = crate::book::load_book("/x/книга.fb2.zip", buf.get_ref()).unwrap();
        assert_eq!(book.title(), "Тестовая книга");
        assert_eq!(book.chapter_count(), 4);
    }
}
