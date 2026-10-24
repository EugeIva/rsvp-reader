//! Plain-text books (.txt). Text has no markup or declared encoding, so:
//! - the encoding is detected (BOM, else UTF-8, else the Cyrillic code page
//!   that decodes to the most lowercase Cyrillic: windows-1251, KOI8-R or
//!   DOS 866);
//! - paragraphs follow the file's layout: one per line, blocks separated by
//!   blank lines, or wrapped lines where an indent starts a paragraph;
//! - chapters start at heading lines ("Глава 5", "Chapter V", "Часть
//!   вторая", a lone Roman numeral...) when there are at least two, else the
//!   text is cut into chunks at paragraph boundaries.
//!
//! The title is the file name. Each chapter is wrapped in `<div class="txt">`.

use crate::book::BookSource;

/// Target chapter size when the text has no headings.
const CHUNK_CHARS: usize = 30_000;
/// Headings are short lines.
const MAX_HEADING_CHARS: usize = 60;

pub struct TxtBook {
    title: String,
    chapters: Vec<String>,
}

impl TxtBook {
    pub fn parse(path: &str, bytes: &[u8]) -> Self {
        let text = decode(bytes).replace("\r\n", "\n").replace('\r', "\n");
        let title = title_from_path(path);
        let paragraphs = paragraphs(&text);
        let chapters = chapters(&paragraphs)
            .into_iter()
            .map(|paras| render(&paras, &title))
            .collect();
        Self { title, chapters }
    }
}

impl BookSource for TxtBook {
    fn title(&self) -> String {
        self.title.clone()
    }

    fn author(&self) -> String {
        String::new()
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
        Err(format!("No resource '{path}'"))
    }
}

fn title_from_path(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let stem = name
        .len()
        .checked_sub(4)
        .filter(|&i| name.is_char_boundary(i) && name[i..].eq_ignore_ascii_case(".txt"))
        .map_or(name, |i| &name[..i]);
    stem.trim().to_string()
}

// ---------------------------------------------------------------------------
// Encoding

fn decode(bytes: &[u8]) -> String {
    if let Some((encoding, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        return encoding
            .decode_without_bom_handling(&bytes[bom_len..])
            .0
            .into_owned();
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    let candidates = [
        encoding_rs::WINDOWS_1251,
        encoding_rs::KOI8_R,
        encoding_rs::IBM866,
    ];
    candidates
        .iter()
        .map(|enc| enc.decode_without_bom_handling(bytes).0.into_owned())
        .max_by_key(|text| lowercase_cyrillic_share(text))
        .unwrap_or_default()
}

/// Per mille of non-ASCII characters that are lowercase Cyrillic letters.
/// Russian text is mostly lowercase; decoded with the wrong code page it
/// turns into capitals (KOI8-R has the cases swapped) or symbols.
fn lowercase_cyrillic_share(text: &str) -> usize {
    let (mut lower, mut non_ascii) = (0usize, 0usize);
    for c in text.chars().filter(|c| !c.is_ascii()) {
        non_ascii += 1;
        if ('а'..='я').contains(&c) || c == 'ё' {
            lower += 1;
        }
    }
    (lower * 1000).checked_div(non_ascii).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Paragraphs and chapters

#[derive(Debug, PartialEq)]
enum Para {
    Heading(String),
    SceneBreak,
    Text(String),
}

/// How paragraphs are laid out in the file.
#[derive(Debug, PartialEq)]
enum Layout {
    /// Every non-empty line is a paragraph.
    LinePerParagraph,
    /// Wrapped lines; blank lines separate paragraphs.
    BlankLineSeparated,
    /// Wrapped lines; an indented line starts a paragraph.
    IndentStarts,
}

fn layout(lines: &[&str]) -> Layout {
    let non_empty: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|l| !l.trim().is_empty())
        .collect();
    if non_empty.is_empty() {
        return Layout::LinePerParagraph;
    }
    let n = non_empty.len();
    let long = non_empty.iter().filter(|l| l.chars().count() > 120).count();
    let blank = lines.iter().filter(|l| l.trim().is_empty()).count();
    let indented = non_empty
        .iter()
        .filter(|l| l.starts_with([' ', '\t', '\u{a0}']))
        .count();
    if long * 10 > n * 3 {
        // Long lines: one paragraph each, however they're spaced.
        Layout::LinePerParagraph
    } else if blank * 10 >= n {
        Layout::BlankLineSeparated
    } else if indented * 20 >= n && indented * 10 <= n * 6 {
        Layout::IndentStarts
    } else {
        Layout::LinePerParagraph
    }
}

fn is_scene_break(line: &str) -> bool {
    let t: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    !t.is_empty() && t.len() <= 12 && t.chars().all(|c| matches!(c, '*' | '#' | '~' | '-' | '='))
}

fn is_heading(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() || t.chars().count() > MAX_HEADING_CHARS {
        return false;
    }
    // Headings are capitalised (or numbered); a wrapped line in the middle
    // of a sentence ("часть дороги...") isn't one.
    if !t
        .chars()
        .next()
        .is_some_and(|c| c.is_uppercase() || c.is_ascii_digit())
    {
        return false;
    }
    let lower = t.to_lowercase();
    const WORDS: [&str; 14] = [
        "глава",
        "часть",
        "книга",
        "пролог",
        "эпилог",
        "предисловие",
        "послесловие",
        "chapter",
        "part",
        "book",
        "prologue",
        "epilogue",
        "preface",
        "afterword",
    ];
    let first = lower
        .split(|c: char| !c.is_alphanumeric())
        .next()
        .unwrap_or("");
    if WORDS.contains(&first) {
        return true;
    }
    // A lone Roman numeral or number, e.g. "IV" or "12."
    let bare = t.trim_end_matches('.');
    !bare.is_empty()
        && bare.len() <= 7
        && (bare.chars().all(|c| "IVXLC".contains(c)) || bare.chars().all(|c| c.is_ascii_digit()))
}

fn paragraphs(text: &str) -> Vec<Para> {
    let lines: Vec<&str> = text.lines().collect();
    let layout = layout(&lines);
    let mut out = Vec::new();
    let mut current = String::new();
    let flush = |current: &mut String, out: &mut Vec<Para>| {
        let t = current.split_whitespace().collect::<Vec<_>>().join(" ");
        if !t.is_empty() {
            out.push(Para::Text(t));
        }
        current.clear();
    };
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            flush(&mut current, &mut out);
            continue;
        }
        // A heading or scene break stands on its own: it can't continue a
        // wrapped paragraph.
        let starts_block = match layout {
            Layout::LinePerParagraph => true,
            Layout::BlankLineSeparated => current.is_empty(),
            Layout::IndentStarts => current.is_empty() || line.starts_with([' ', '\t', '\u{a0}']),
        };
        if starts_block && (is_scene_break(trimmed) || is_heading(trimmed)) {
            flush(&mut current, &mut out);
            out.push(if is_scene_break(trimmed) {
                Para::SceneBreak
            } else {
                Para::Heading(trimmed.to_string())
            });
            continue;
        }
        match layout {
            Layout::LinePerParagraph => {
                flush(&mut current, &mut out);
                current.push_str(trimmed);
                flush(&mut current, &mut out);
            }
            Layout::BlankLineSeparated => {
                current.push(' ');
                current.push_str(trimmed);
            }
            Layout::IndentStarts => {
                if line.starts_with([' ', '\t', '\u{a0}']) {
                    flush(&mut current, &mut out);
                }
                current.push(' ');
                current.push_str(trimmed);
            }
        }
    }
    flush(&mut current, &mut out);
    out
}

fn chapters(paras: &[Para]) -> Vec<Vec<&Para>> {
    let headings = paras
        .iter()
        .filter(|p| matches!(p, Para::Heading(_)))
        .count();
    let mut chapters: Vec<Vec<&Para>> = Vec::new();
    let mut current: Vec<&Para> = Vec::new();
    let mut size = 0;
    for p in paras {
        let starts_chapter = if headings >= 2 {
            matches!(p, Para::Heading(_))
        } else {
            size >= CHUNK_CHARS
        };
        if starts_chapter && !current.is_empty() {
            chapters.push(std::mem::take(&mut current));
            size = 0;
        }
        size += match p {
            Para::Text(t) | Para::Heading(t) => t.chars().count(),
            Para::SceneBreak => 0,
        };
        current.push(p);
    }
    if !current.is_empty() || chapters.is_empty() {
        chapters.push(current);
    }
    chapters
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn render(paras: &[&Para], title: &str) -> String {
    let mut body = String::new();
    for p in paras {
        match p {
            Para::Heading(t) => body.push_str(&format!("<h2 class=\"title\">{}</h2>", escape(t))),
            Para::SceneBreak => body.push_str("<p class=\"scene-break\">* * *</p>"),
            Para::Text(t) => body.push_str(&format!("<p>{}</p>", escape(t))),
        }
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>{}</title></head><body><div class=\"txt\">{}</div></body></html>",
        escape(title),
        body
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUSSIAN: &str = "Глава 1\n\nОн вышел из дома и пошёл по улице. Было холодно, и снег\nпадал на крыши.\n\nОна ждала его у моста.\n\nГлава 2\n\nНа следующий день всё было иначе.\n";

    fn texts(book: &TxtBook, i: usize) -> String {
        book.chapter_html(i).unwrap()
    }

    #[test]
    fn test_title_from_file_name() {
        assert_eq!(
            title_from_path("/books/Мастер и Маргарита.txt"),
            "Мастер и Маргарита"
        );
        assert_eq!(title_from_path("/books/notes.TXT"), "notes");
        assert_eq!(title_from_path("plain"), "plain");
    }

    #[test]
    fn test_detects_cyrillic_code_pages() {
        for enc in [
            encoding_rs::WINDOWS_1251,
            encoding_rs::KOI8_R,
            encoding_rs::IBM866,
        ] {
            let (bytes, _, unmappable) = enc.encode(RUSSIAN);
            assert!(!unmappable);
            assert_eq!(decode(&bytes), RUSSIAN, "{}", enc.name());
        }
        assert_eq!(decode(RUSSIAN.as_bytes()), RUSSIAN);
        let mut utf16 = vec![0xFF, 0xFE];
        utf16.extend(RUSSIAN.encode_utf16().flat_map(|u| u.to_le_bytes()));
        assert_eq!(decode(&utf16), RUSSIAN);
    }

    #[test]
    fn test_blank_line_paragraphs_and_heading_chapters() {
        let book = TxtBook::parse("/b/Книга.txt", RUSSIAN.as_bytes());
        assert_eq!(book.title(), "Книга");
        assert_eq!(book.chapter_count(), 2);
        let c0 = texts(&book, 0);
        assert!(c0.contains("<h2 class=\"title\">Глава 1</h2>"));
        // The wrapped line is joined into one paragraph.
        assert!(c0.contains(
            "<p>Он вышел из дома и пошёл по улице. Было холодно, и снег падал на крыши.</p>"
        ));
        assert!(c0.contains("<p>Она ждала его у моста.</p>"));
        assert!(texts(&book, 1).contains("<h2 class=\"title\">Глава 2</h2>"));
    }

    #[test]
    fn test_one_paragraph_per_line() {
        let long = "Очень длинная строка текста, которая занимает больше ста двадцати символов, как это бывает в книгах, где каждый абзац записан одной строкой.";
        let text = format!("{long}\n{long}\n{long}\n");
        let paras = paragraphs(&text);
        assert_eq!(paras.len(), 3);
    }

    #[test]
    fn test_wrapped_line_starting_with_a_heading_word_is_not_a_heading() {
        let text = "Они долго шли, и\nЧасть пути была трудной.\n\nПотом стало легче.\n";
        assert_eq!(
            paragraphs(text),
            vec![
                Para::Text("Они долго шли, и Часть пути была трудной.".into()),
                Para::Text("Потом стало легче.".into()),
            ]
        );
    }

    #[test]
    fn test_indent_starts_paragraph() {
        let text = "  Первый абзац начинается\nс отступа и продолжается\nна следующей строке.\n  Второй абзац тоже\nс отступом.\n";
        assert_eq!(
            paragraphs(text),
            vec![
                Para::Text(
                    "Первый абзац начинается с отступа и продолжается на следующей строке.".into()
                ),
                Para::Text("Второй абзац тоже с отступом.".into()),
            ]
        );
    }

    #[test]
    fn test_headings_and_scene_breaks() {
        for h in [
            "Глава 5",
            "ГЛАВА ПЯТАЯ",
            "Chapter 12",
            "Часть вторая",
            "Пролог",
            "IV",
            "12.",
        ] {
            assert!(is_heading(h), "{h}");
        }
        for not in [
            "Главная мысль этой книги в том, что всё проходит и нужно жить дальше.",
            "Он сказал.",
            "часть дороги шла лесом",
        ] {
            assert!(!is_heading(not), "{not}");
        }
        assert!(is_scene_break("* * *"));
        assert!(is_scene_break("***"));
        assert!(!is_scene_break("*важно*"));
    }

    #[test]
    fn test_text_without_headings_is_cut_into_chunks() {
        let para = "Слово ".repeat(200);
        let text: String = (0..200).map(|_| format!("{para}\n\n")).collect();
        let book = TxtBook::parse("/b/x.txt", text.as_bytes());
        assert!(book.chapter_count() > 1);
        for i in 0..book.chapter_count() {
            assert!(texts(&book, i).len() < CHUNK_CHARS * 3);
        }
    }

    #[test]
    fn test_escapes_markup_and_is_well_formed() {
        let book = TxtBook::parse("/b/x & y.txt", "a < b && c > d\n".as_bytes());
        let html = texts(&book, 0);
        assert!(html.contains("<p>a &lt; b &amp;&amp; c &gt; d</p>"));
        assert!(html.contains("<title>x &amp; y</title>"));
        roxmltree::Document::parse(&html).unwrap();
    }

    #[test]
    fn test_empty_file_has_one_empty_chapter() {
        let book = TxtBook::parse("/b/empty.txt", b"");
        assert_eq!(book.chapter_count(), 1);
    }
}
