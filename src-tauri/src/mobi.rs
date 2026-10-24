//! Kindle books: MOBI (.mobi, .azw, .prc) and KF8 (.azw3), DRM-free only.
//!
//! Both are Palm databases: record 0 holds the headers, then come the text
//! records (PalmDOC- or HUFF/CDIC-compressed), indexes and images. A .mobi
//! made by kindlegen often holds both formats, the old MOBI7 part first and
//! a KF8 part after a boundary record; the KF8 part is preferred.
//!
//! - MOBI7: the text is one HTML document. Chapters are split at
//!   `<mbp:pagebreak/>` (and long ones at paragraphs), `filepos` links
//!   (byte offsets into the text) become anchors and links, `recindex`
//!   images become `/res/N`.
//! - KF8: the text is the book's XHTML files cut into skeletons and
//!   fragments; the skeleton and fragment indexes put the files back
//!   together, one chapter each. `kindle:pos` links point at the nearest
//!   id before the target position, `kindle:embed` images become
//!   `/res/N`.
//!
//! The cover (EXTH 201) is added as a first chapter when the text doesn't
//! show it.

use crate::book::BookSource;
use std::collections::{BTreeSet, HashMap};

/// A MOBI7 chapter longer than this (bytes of markup) is split at a paragraph.
const MAX_CHAPTER_BYTES: usize = 60_000;
/// "No index" in MOBI headers.
const NONE: u32 = 0xFFFF_FFFF;

pub struct MobiBook {
    title: String,
    author: String,
    chapters: Vec<String>,
    paths: Vec<String>,
    /// Records from the first resource on; `/res/N` is `resources[N - 1]`.
    resources: Vec<Vec<u8>>,
}

impl MobiBook {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        Self::parse_with(bytes, true)
    }

    /// `prefer_kf8 = false` reads the MOBI7 part of a combined file (tests).
    fn parse_with(bytes: &[u8], prefer_kf8: bool) -> Result<Self, String> {
        let pdb = Pdb::parse(bytes)?;
        let first = Header::parse(&pdb, 0)?;
        if first.encryption != 0 {
            return Err("The book is DRM-protected".into());
        }
        // Resources are shared: in a combined file they sit in the MOBI7
        // part, and kindle:embed numbers count from the first header's.
        let resources = match first.first_resource {
            NONE => Vec::new(),
            start => (start as usize..pdb.len())
                .map(|i| pdb.record(i).unwrap_or_default().to_vec())
                .collect(),
        };
        let kf8 = match first.exth_u32(121) {
            Some(boundary) if prefer_kf8 && first.version < 8 => {
                Header::parse(&pdb, boundary as usize).ok()
            }
            _ => None,
        };
        let (header, kf8) = match kf8 {
            Some(h) if h.version >= 8 => (h, true),
            _ => {
                let kf8 = first.version >= 8;
                (first, kf8)
            }
        };
        let text = header.text(&pdb)?;
        let (mut paths, mut chapters) = if kf8 {
            kf8_chapters(&pdb, &header, &text)?
        } else {
            mobi7_chapters(&text, header.codepage)
        };
        if chapters.is_empty() {
            return Err("The book has no text".into());
        }

        // The cover, unless the text already shows it.
        if let Some(n) = header.exth_u32(201).filter(|&n| n != NONE) {
            let n = n as usize + 1;
            if resources.get(n - 1).and_then(|r| image_mime(r)).is_some() {
                let src = format!("/res/{n}");
                if !chapters[0].contains(&format!("\"{src}\"")) {
                    chapters.insert(
                        0,
                        wrap(&format!(
                            "<div class=\"cover\"><img src=\"{src}\" alt=\"\"/></div>"
                        )),
                    );
                    paths.insert(0, "/cover.xhtml".into());
                }
            }
        }

        let title = header
            .exth_string(503)
            .unwrap_or_else(|| header.full_name.clone());
        let author = header.exth_strings(100).join(", ");
        Ok(Self {
            title,
            author,
            chapters,
            paths,
            resources,
        })
    }
}

impl BookSource for MobiBook {
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
        self.paths.clone()
    }

    /// Resources are `/res/N`: the Nth record from the first resource.
    fn read_resource(&self, path: &str) -> Result<Vec<u8>, String> {
        path.strip_prefix("/res/")
            .and_then(|n| n.parse::<usize>().ok())
            .and_then(|n| self.resources.get(n.checked_sub(1)?))
            .cloned()
            .ok_or_else(|| format!("No resource '{path}'"))
    }

    /// Records have no names, so the type comes from the image signature.
    fn mime_for(&self, path: &str) -> String {
        self.read_resource(path)
            .ok()
            .and_then(|r| image_mime(&r))
            .unwrap_or("application/octet-stream")
            .to_string()
    }
}

/// A chapter document around body markup.
fn wrap(body: &str) -> String {
    format!("<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>{body}</body></html>")
}

/// Content type of an image record, from its signature.
fn image_mime(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if data.starts_with(b"\x89PNG") {
        Some("image/png")
    } else if data.starts_with(b"GIF8") {
        Some("image/gif")
    } else if data.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    }
}

fn decode(bytes: &[u8], codepage: u32) -> String {
    if codepage == 1252 {
        encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

// ---------------------------------------------------------------------------
// Palm database and headers

fn be16(b: &[u8], off: usize) -> Option<u32> {
    b.get(off..off + 2)
        .map(|s| u16::from_be_bytes([s[0], s[1]]) as u32)
}

fn be32(b: &[u8], off: usize) -> Option<u32> {
    b.get(off..off + 4)
        .map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

struct Pdb<'a> {
    data: &'a [u8],
    offsets: Vec<usize>,
}

impl<'a> Pdb<'a> {
    fn parse(data: &'a [u8]) -> Result<Self, String> {
        if data.get(60..68) != Some(b"BOOKMOBI") {
            return Err("Not a MOBI book".into());
        }
        let count = be16(data, 76).ok_or("Truncated MOBI header")? as usize;
        let mut offsets = (0..count)
            .map(|i| be32(data, 78 + i * 8).map(|o| o as usize))
            .collect::<Option<Vec<_>>>()
            .ok_or("Truncated MOBI record list")?;
        offsets.push(data.len());
        Ok(Self { data, offsets })
    }

    fn len(&self) -> usize {
        self.offsets.len() - 1
    }

    fn record(&self, i: usize) -> Option<&'a [u8]> {
        let (start, end) = (*self.offsets.get(i)?, *self.offsets.get(i + 1)?);
        self.data.get(start..end.max(start))
    }
}

struct Header {
    /// Record index of this header (0, or the KF8 boundary).
    start: usize,
    compression: u32,
    text_records: usize,
    encryption: u32,
    codepage: u32,
    version: u32,
    full_name: String,
    /// Absolute record index of the first resource (images), or NONE.
    first_resource: u32,
    huff: (usize, usize),
    /// Trailing entries on text records: their count, and whether a
    /// multibyte-overlap entry comes last.
    trailers: (u32, bool),
    fdst: u32,
    fragment_index: u32,
    skeleton_index: u32,
    exth: HashMap<u32, Vec<Vec<u8>>>,
}

impl Header {
    fn parse(pdb: &Pdb, start: usize) -> Result<Self, String> {
        let r = pdb.record(start).ok_or("Missing MOBI header")?;
        if r.get(16..20) != Some(b"MOBI") {
            return Err("Not a MOBI book".into());
        }
        let field = |off| be32(r, off).unwrap_or(NONE);
        let header_len = field(20);
        let codepage = field(28);
        let version = field(36);
        // Index fields in a KF8 header count from the KF8 header's record.
        let rel = |v: u32| match v {
            NONE => NONE,
            v => v.wrapping_add(start as u32),
        };
        let name = r
            .get(field(84) as usize..)
            .and_then(|s| s.get(..field(88) as usize))
            .unwrap_or_default();

        let trailers = if header_len >= 0xE4 && version >= 5 {
            let flags = be16(r, 0xF2).unwrap_or(0);
            ((flags >> 1).count_ones(), flags & 1 == 1)
        } else {
            (0, false)
        };
        let kf8 = version >= 8;
        let mut exth = HashMap::new();
        if field(0x80) & 0x40 != 0 {
            let at = 16 + header_len as usize;
            if r.get(at..at + 4) == Some(b"EXTH") {
                let count = be32(r, at + 8).unwrap_or(0);
                let mut pos = at + 12;
                for _ in 0..count {
                    let (Some(kind), Some(len)) = (be32(r, pos), be32(r, pos + 4)) else {
                        break;
                    };
                    let len = (len as usize).max(8);
                    let Some(value) = r.get(pos + 8..pos + len) else {
                        break;
                    };
                    exth.entry(kind)
                        .or_insert_with(Vec::new)
                        .push(value.to_vec());
                    pos += len;
                }
            }
        }
        Ok(Self {
            start,
            compression: be16(r, 0).unwrap_or(1),
            text_records: be16(r, 8).unwrap_or(0) as usize,
            encryption: be16(r, 12).unwrap_or(0),
            codepage,
            version,
            full_name: decode(name, codepage),
            first_resource: if start == 0 {
                field(0x6C)
            } else {
                rel(field(0x6C))
            },
            huff: (rel(field(0x70)) as usize, field(0x74) as usize),
            trailers,
            fdst: if kf8 { rel(field(0xC0)) } else { NONE },
            fragment_index: if kf8 { rel(field(0xF8)) } else { NONE },
            skeleton_index: if kf8 { rel(field(0xFC)) } else { NONE },
            exth,
        })
    }

    fn exth_u32(&self, kind: u32) -> Option<u32> {
        self.exth.get(&kind)?.first().and_then(|v| be32(v, 0))
    }

    fn exth_strings(&self, kind: u32) -> Vec<String> {
        self.exth
            .get(&kind)
            .into_iter()
            .flatten()
            .map(|v| decode(v, self.codepage).trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }

    fn exth_string(&self, kind: u32) -> Option<String> {
        self.exth_strings(kind).into_iter().next()
    }

    /// The whole text, decompressed.
    fn text(&self, pdb: &Pdb) -> Result<Vec<u8>, String> {
        let records = (1..=self.text_records)
            .map(|i| pdb.record(self.start + i).map(|r| self.trim_trailers(r)))
            .collect::<Option<Vec<_>>>()
            .ok_or("Missing text records")?;
        match self.compression {
            1 => Ok(records.concat()),
            2 => Ok(records.iter().flat_map(|r| palmdoc_decompress(r)).collect()),
            17480 => {
                let (first, count) = self.huff;
                let huff = pdb.record(first).ok_or("Missing HUFF record")?;
                let cdics = (first + 1..first + count)
                    .map(|i| pdb.record(i))
                    .collect::<Option<Vec<_>>>()
                    .ok_or("Missing CDIC records")?;
                let mut reader = HuffCdic::new(huff, &cdics)?;
                let mut out = Vec::new();
                for r in records {
                    out.extend(reader.unpack(r, 0)?);
                }
                Ok(out)
            }
            c => Err(format!("Unknown MOBI compression {c}")),
        }
    }

    /// A text record without its trailing entries.
    fn trim_trailers<'a>(&self, mut data: &'a [u8]) -> &'a [u8] {
        let (count, multibyte) = self.trailers;
        for _ in 0..count {
            // The entry's size is a backward-encoded number in its last bytes.
            let mut size = 0usize;
            for &b in &data[data.len().saturating_sub(4)..] {
                if b & 0x80 != 0 {
                    size = 0;
                }
                size = (size << 7) | (b & 0x7F) as usize;
            }
            data = &data[..data.len().saturating_sub(size)];
        }
        if multibyte {
            if let Some(&last) = data.last() {
                data = &data[..data.len().saturating_sub((last & 3) as usize + 1)];
            }
        }
        data
    }
}

// ---------------------------------------------------------------------------
// Compression

fn palmdoc_decompress(data: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(data.len() * 2);
    let mut i = 0;
    while i < data.len() {
        let c = data[i];
        i += 1;
        match c {
            1..=8 => {
                let end = (i + c as usize).min(data.len());
                out.extend_from_slice(&data[i..end]);
                i = end;
            }
            0 | 9..=0x7F => out.push(c),
            0xC0..=0xFF => {
                out.push(b' ');
                out.push(c ^ 0x80);
            }
            _ => {
                let Some(&next) = data.get(i) else { break };
                i += 1;
                let pair = ((c as usize) << 8) | next as usize;
                let distance = (pair >> 3) & 0x07FF;
                let length = (pair & 7) + 3;
                if distance == 0 || distance > out.len() {
                    continue;
                }
                for _ in 0..length {
                    out.push(out[out.len() - distance]);
                }
            }
        }
    }
    out
}

/// HUFF/CDIC decompression (the "huffdic" of kindlegen -c2 and store books).
struct HuffCdic {
    /// Per first code byte: code length, terminal flag, max code.
    dict1: Vec<(u32, bool, u64)>,
    mincode: Vec<u64>,
    maxcode: Vec<u64>,
    /// Phrases, and whether each is already decompressed.
    dictionary: Vec<(Vec<u8>, bool)>,
}

impl HuffCdic {
    fn new(huff: &[u8], cdics: &[&[u8]]) -> Result<Self, String> {
        if huff.get(..8) != Some(b"HUFF\x00\x00\x00\x18") {
            return Err("Bad HUFF record".into());
        }
        let bad = || "Bad HUFF record".to_string();
        let off1 = be32(huff, 8).ok_or_else(bad)? as usize;
        let off2 = be32(huff, 12).ok_or_else(bad)? as usize;
        let dict1 = (0..256)
            .map(|i| {
                let v = be32(huff, off1 + i * 4)?;
                let len = v & 0x1F;
                let max = (((v >> 8) as u64 + 1) << (32 - len)).wrapping_sub(1);
                Some((len, v & 0x80 != 0, max))
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(bad)?;
        let mut mincode = vec![0u64];
        let mut maxcode = vec![u32::MAX as u64];
        for len in 1..=32u32 {
            let i = off2 + (len as usize - 1) * 8;
            let min = be32(huff, i).ok_or_else(bad)? as u64;
            let max = be32(huff, i + 4).ok_or_else(bad)? as u64;
            mincode.push(min << (32 - len));
            maxcode.push(((max + 1) << (32 - len)) - 1);
        }
        let mut dictionary = Vec::new();
        for cdic in cdics {
            if cdic.get(..8) != Some(b"CDIC\x00\x00\x00\x10") {
                return Err("Bad CDIC record".into());
            }
            let phrases = be32(cdic, 8).unwrap_or(0) as usize;
            let bits = be32(cdic, 12).unwrap_or(0).min(31);
            let n = (1usize << bits).min(phrases.saturating_sub(dictionary.len()));
            for k in 0..n {
                let off = be16(cdic, 16 + k * 2).ok_or("Bad CDIC record")? as usize;
                let blen = be16(cdic, 16 + off).ok_or("Bad CDIC record")? as usize;
                let phrase = cdic
                    .get(18 + off..18 + off + (blen & 0x7FFF))
                    .ok_or("Bad CDIC record")?;
                dictionary.push((phrase.to_vec(), blen & 0x8000 != 0));
            }
        }
        Ok(Self {
            dict1,
            mincode,
            maxcode,
            dictionary,
        })
    }

    fn unpack(&mut self, data: &[u8], depth: usize) -> Result<Vec<u8>, String> {
        if depth > 32 {
            return Err("HUFF/CDIC phrases nest too deep".into());
        }
        let mut padded = data.to_vec();
        padded.extend_from_slice(&[0; 8]);
        let read = |pos: usize| u64::from_be_bytes(padded[pos..pos + 8].try_into().unwrap());
        let mut bits_left = data.len() as i64 * 8;
        let mut pos = 0;
        let mut x = read(pos);
        let mut n: i32 = 32;
        let mut out = Vec::new();
        loop {
            if n <= 0 {
                pos += 4;
                if pos + 8 > padded.len() {
                    break;
                }
                x = read(pos);
                n += 32;
            }
            let code = (x >> n) & 0xFFFF_FFFF;
            let (mut len, term, mut max) = self.dict1[(code >> 24) as usize];
            if !term {
                while len < 32 && code < self.mincode[len as usize] {
                    len += 1;
                }
                max = self.maxcode[len as usize];
            }
            if len == 0 {
                return Err("Bad HUFF code".into());
            }
            n -= len as i32;
            bits_left -= len as i64;
            if bits_left < 0 {
                break;
            }
            let r = ((max.wrapping_sub(code)) >> (32 - len)) as usize;
            let (phrase, done) = self.dictionary.get(r).cloned().ok_or("Bad HUFF code")?;
            let phrase = if done {
                phrase
            } else {
                let unpacked = self.unpack(&phrase, depth + 1)?;
                self.dictionary[r] = (unpacked.clone(), true);
                unpacked
            };
            out.extend_from_slice(&phrase);
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// Byte-string helpers for markup

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from > hay.len() || needle.is_empty() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

fn find_ci(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from > hay.len() || needle.is_empty() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w.eq_ignore_ascii_case(needle))
        .map(|p| p + from)
}

/// Where the tag that `pos` is inside starts (a `<` with no `>` yet), if any.
fn inside_tag(text: &[u8], pos: usize) -> Option<usize> {
    let lt = text[..pos].iter().rposition(|&b| b == b'<')?;
    let gt = text[..pos].iter().rposition(|&b| b == b'>');
    (gt.is_none_or(|gt| gt < lt)).then_some(lt)
}

/// An attribute value at `pos` (quoted or not): its bytes and where it ends.
fn attr_value(text: &[u8], pos: usize) -> (&[u8], usize) {
    match text.get(pos) {
        Some(&q) if q == b'"' || q == b'\'' => {
            let end = find(text, &[q], pos + 1).unwrap_or(text.len());
            (&text[pos + 1..end], (end + 1).min(text.len()))
        }
        _ => {
            let end = text[pos..]
                .iter()
                .position(|&b| b.is_ascii_whitespace() || b == b'>' || b == b'/')
                .map_or(text.len(), |p| p + pos);
            (&text[pos..end], end)
        }
    }
}

fn digits(s: &[u8]) -> Option<usize> {
    std::str::from_utf8(s).ok()?.trim().parse().ok()
}

// ---------------------------------------------------------------------------
// MOBI7

fn mobi7_chapters(text: &[u8], codepage: u32) -> (Vec<String>, Vec<String>) {
    // Link targets: put an anchor at every filepos a link points to.
    let mut targets = BTreeSet::new();
    let mut at = 0;
    while let Some(p) = find_ci(text, b"filepos=", at) {
        let (value, end) = attr_value(text, p + 8);
        if let Some(n) = digits(value).filter(|&n| n < text.len()) {
            targets.insert(n);
        }
        at = end.max(p + 8);
    }
    let mut anchored = Vec::with_capacity(text.len() + targets.len() * 24);
    let mut copied = 0;
    for &target in &targets {
        // An anchor can't go inside a tag: put it before the tag.
        let pos = inside_tag(text, target).unwrap_or(target).max(copied);
        anchored.extend_from_slice(&text[copied..pos]);
        anchored.extend_from_slice(format!("<a id=\"fp{target}\"></a>").as_bytes());
        copied = pos;
    }
    anchored.extend_from_slice(&text[copied..]);
    let text = anchored;

    let body_start = find_ci(&text, b"<body", 0)
        .and_then(|p| find(&text, b">", p))
        .map_or(0, |p| p + 1);
    let body_end = find_ci(&text, b"</body", body_start).unwrap_or(text.len());
    let body = &text[body_start..body_end];

    let mut pieces = Vec::new();
    let mut at = 0;
    while let Some(p) = find_ci(body, b"<mbp:pagebreak", at) {
        pieces.push(&body[at..p]);
        at = find(body, b">", p).map_or(body.len(), |e| e + 1);
    }
    pieces.push(&body[at..]);
    let pieces: Vec<&[u8]> = pieces
        .into_iter()
        .flat_map(split_long)
        .filter(|p| has_content(p))
        .collect();

    let paths: Vec<String> = (0..pieces.len()).map(|i| format!("/c{i}.xhtml")).collect();
    let mut anchor_chapter = HashMap::new();
    for (i, piece) in pieces.iter().enumerate() {
        let mut at = 0;
        while let Some(p) = find(piece, b"<a id=\"fp", at) {
            let (value, end) = attr_value(piece, p + 6);
            if let Some(n) = value.strip_prefix(b"fp").and_then(digits) {
                anchor_chapter.insert(n, i);
            }
            at = end;
        }
    }

    let chapters = pieces
        .iter()
        .map(|piece| {
            let html = mobi7_markup(piece, &|n| {
                anchor_chapter
                    .get(&n)
                    .map(|&c| format!("{}#fp{n}", paths[c]))
            });
            wrap(&decode(&html, codepage))
        })
        .collect();
    (paths, chapters)
}

/// True if the markup has any text or images.
fn has_content(piece: &[u8]) -> bool {
    let mut in_tag = false;
    for (i, &b) in piece.iter().enumerate() {
        match b {
            b'<' => {
                if piece[i..].len() > 4 && piece[i + 1..i + 4].eq_ignore_ascii_case(b"img") {
                    return true;
                }
                in_tag = true;
            }
            b'>' => in_tag = false,
            _ if !in_tag && !b.is_ascii_whitespace() => return true,
            _ => {}
        }
    }
    false
}

/// Split markup longer than MAX_CHAPTER_BYTES before a paragraph or heading
/// that isn't inside a container (div, blockquote, table, list).
fn split_long(piece: &[u8]) -> Vec<&[u8]> {
    const CONTAINERS: [&[u8]; 6] = [b"div", b"blockquote", b"table", b"ul", b"ol", b"dl"];
    let mut out = Vec::new();
    let mut start = 0;
    let mut depth = 0i32;
    let mut at = 0;
    while let Some(lt) = find(piece, b"<", at) {
        let end = find(piece, b">", lt).unwrap_or(piece.len());
        let tag = &piece[lt + 1..end];
        let closing = tag.first() == Some(&b'/');
        let name: Vec<u8> = tag[closing as usize..]
            .iter()
            .take_while(|b| b.is_ascii_alphanumeric())
            .map(u8::to_ascii_lowercase)
            .collect();
        let opens_block = !closing
            && (name == b"p" || (name.len() == 2 && name[0] == b'h' && name[1].is_ascii_digit()));
        if opens_block && depth <= 0 && lt - start > MAX_CHAPTER_BYTES {
            out.push(&piece[start..lt]);
            start = lt;
        }
        if CONTAINERS.contains(&name.as_slice()) && !tag.ends_with(b"/") {
            depth += if closing { -1 } else { 1 };
        }
        at = end;
    }
    out.push(&piece[start..]);
    out
}

/// MOBI7 markup → HTML: filepos links, recindex images, mbp: tags removed.
fn mobi7_markup(piece: &[u8], link: &dyn Fn(usize) -> Option<String>) -> Vec<u8> {
    let mut out = Vec::with_capacity(piece.len());
    let mut at = 0;
    while let Some(lt) = find(piece, b"<", at) {
        out.extend_from_slice(&piece[at..lt]);
        let end = find(piece, b">", lt).map_or(piece.len(), |e| e + 1);
        let tag = &piece[lt..end];
        let name_at = if tag.get(1) == Some(&b'/') { 2 } else { 1 };
        if tag.len() > name_at + 4 && tag[name_at..name_at + 4].eq_ignore_ascii_case(b"mbp:") {
            at = end;
            continue;
        }
        out.extend(mobi7_tag(tag, link));
        at = end;
    }
    out.extend_from_slice(&piece[at..]);
    out
}

/// One tag with `filepos=` turned into `href=` and `recindex=` into `src=`.
fn mobi7_tag(tag: &[u8], link: &dyn Fn(usize) -> Option<String>) -> Vec<u8> {
    let mut out = Vec::with_capacity(tag.len());
    let mut i = 0;
    while i < tag.len() {
        let after_space = i > 0 && tag[i - 1].is_ascii_whitespace();
        let rest = &tag[i..];
        if after_space && rest.len() > 8 && rest[..8].eq_ignore_ascii_case(b"filepos=") {
            let (value, end) = attr_value(tag, i + 8);
            if let Some(href) = digits(value).and_then(link) {
                out.extend_from_slice(format!("href=\"{href}\"").as_bytes());
            }
            i = end;
        } else if after_space && rest.len() > 9 && rest[..9].eq_ignore_ascii_case(b"recindex=") {
            let (value, end) = attr_value(tag, i + 9);
            if let Some(n) = digits(value) {
                out.extend_from_slice(format!("src=\"/res/{n}\"").as_bytes());
            }
            i = end;
        } else {
            out.push(tag[i]);
            i += 1;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// KF8

/// An index entry: its label and its tag values.
type IndexEntry = (Vec<u8>, HashMap<u8, Vec<u32>>);

/// Entries of a KF8 index (INDX records).
fn read_index(pdb: &Pdb, first: u32) -> Result<Vec<IndexEntry>, String> {
    let bad = || "Bad KF8 index".to_string();
    let head = pdb.record(first as usize).ok_or_else(bad)?;
    if !head.starts_with(b"INDX") {
        return Err(bad());
    }
    let header_len = be32(head, 4).ok_or_else(bad)? as usize;
    let records = be32(head, 24).ok_or_else(bad)? as usize;
    // TAGX: (tag, values per entry, mask, end of control byte)
    let mut tags = Vec::new();
    let mut control_bytes = 0;
    if head.get(header_len..header_len + 4) == Some(b"TAGX") {
        let tagx_len = be32(head, header_len + 4).ok_or_else(bad)? as usize;
        control_bytes = be32(head, header_len + 8).ok_or_else(bad)? as usize;
        for p in (header_len + 12..header_len + tagx_len).step_by(4) {
            let t = head.get(p..p + 4).ok_or_else(bad)?;
            tags.push((t[0], t[1] as usize, t[2], t[3]));
        }
    }

    let mut entries = Vec::new();
    for i in 1..=records {
        let data = pdb.record(first as usize + i).ok_or_else(bad)?;
        let idxt = be32(data, 20).ok_or_else(bad)? as usize;
        let count = be32(data, 24).ok_or_else(bad)? as usize;
        let mut starts = (0..count)
            .map(|j| be16(data, idxt + 4 + j * 2).map(|p| p as usize))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(bad)?;
        starts.push(idxt);
        for j in 0..count {
            let (start, end) = (starts[j], starts[j + 1]);
            let len = *data.get(start).ok_or_else(bad)? as usize;
            let label = data
                .get(start + 1..start + 1 + len)
                .ok_or_else(bad)?
                .to_vec();
            let values =
                tag_values(data, &tags, control_bytes, start + 1 + len, end).ok_or_else(bad)?;
            entries.push((label, values));
        }
    }
    Ok(entries)
}

/// Variable-width number (7 bits per byte, last byte has the high bit set).
fn varint(data: &[u8], pos: usize) -> Option<(usize, u32)> {
    let mut value = 0u32;
    for (i, &b) in data.get(pos..)?.iter().enumerate().take(5) {
        value = (value << 7) | (b & 0x7F) as u32;
        if b & 0x80 != 0 {
            return Some((i + 1, value));
        }
    }
    None
}

fn tag_values(
    data: &[u8],
    tags: &[(u8, usize, u8, u8)],
    control_bytes: usize,
    start: usize,
    end: usize,
) -> Option<HashMap<u8, Vec<u32>>> {
    let mut found = Vec::new();
    let mut control = 0;
    for &(tag, per_entry, mask, end_flag) in tags {
        if end_flag == 1 {
            control += 1;
            continue;
        }
        let value = data.get(start + control)? & mask;
        if value == 0 {
            continue;
        }
        if value == mask && mask.count_ones() > 1 {
            // A byte count follows instead of a value count.
            found.push((tag, per_entry, None, true));
        } else {
            found.push((
                tag,
                per_entry,
                Some((value >> mask.trailing_zeros()) as usize),
                false,
            ));
        }
    }
    let mut pos = start + control_bytes;
    let mut out = HashMap::new();
    // Byte counts come first, right after the control bytes.
    let mut byte_counts = Vec::new();
    for f in &found {
        if f.3 {
            let (used, n) = varint(data, pos)?;
            pos += used;
            byte_counts.push(n as usize);
        }
    }
    let mut byte_counts = byte_counts.into_iter();
    for (tag, per_entry, count, by_bytes) in found {
        let mut values = Vec::new();
        if by_bytes {
            let bytes = byte_counts.next()?;
            let stop = pos + bytes;
            while pos < stop && pos < end {
                let (used, v) = varint(data, pos)?;
                pos += used;
                values.push(v);
            }
        } else {
            for _ in 0..count? * per_entry {
                let (used, v) = varint(data, pos)?;
                pos += used;
                values.push(v);
            }
        }
        out.insert(tag, values);
    }
    Some(out)
}

fn base32(s: &[u8]) -> Option<usize> {
    let s = std::str::from_utf8(s).ok()?;
    usize::from_str_radix(s, 32).ok()
}

/// A rebuilt KF8 file: its markup and the raw-text span it came from.
struct Part {
    markup: Vec<u8>,
    start: usize,
    end: usize,
}

fn kf8_chapters(pdb: &Pdb, h: &Header, text: &[u8]) -> Result<(Vec<String>, Vec<String>), String> {
    // Flow 0 (the XHTML) ends where flow 1 (CSS, SVG...) starts.
    let flow_end = pdb
        .record(h.fdst as usize)
        .filter(|r| r.starts_with(b"FDST") && be32(r, 8).unwrap_or(0) > 1)
        .and_then(|r| be32(r, 16))
        .map_or(text.len(), |e| (e as usize).min(text.len()));
    let text = &text[..flow_end];

    let skeletons = read_index(pdb, h.skeleton_index)?;
    let fragments = read_index(pdb, h.fragment_index)?;
    // Fragments: insert position, length.
    let frags: Vec<(usize, usize)> = fragments
        .iter()
        .map(|(label, tags)| {
            let insert = digits(label).unwrap_or(0);
            let len = tags.get(&6).and_then(|v| v.get(1)).copied().unwrap_or(0);
            (insert, len as usize)
        })
        .collect();

    let mut parts = Vec::new();
    let mut next_frag = 0;
    for (_, tags) in &skeletons {
        let count = tags.get(&1).and_then(|v| v.first()).copied().unwrap_or(0) as usize;
        let span = tags.get(&6).cloned().unwrap_or_default();
        let (skel_pos, skel_len) = (
            *span.first().unwrap_or(&0) as usize,
            *span.get(1).unwrap_or(&0) as usize,
        );
        let mut base = (skel_pos + skel_len).min(text.len());
        let mut markup = text[skel_pos.min(base)..base].to_vec();
        for &(insert, len) in frags.iter().skip(next_frag).take(count) {
            let piece = &text[base.min(text.len())..(base + len).min(text.len())];
            let at = insert.saturating_sub(skel_pos).min(markup.len());
            markup.splice(at..at, piece.iter().copied());
            base += len;
        }
        next_frag += count;
        parts.push(Part {
            markup,
            start: skel_pos,
            end: base,
        });
    }

    let paths: Vec<String> = (0..parts.len())
        .map(|i| format!("/part{i}.xhtml"))
        .collect();
    let target = |fid: usize, off: usize| -> Option<String> {
        let pos = frags.get(fid)?.0 + off;
        let (i, part) = parts
            .iter()
            .enumerate()
            .find(|(_, p)| p.start <= pos && pos < p.end)?;
        Some(match id_before(&part.markup, pos - part.start) {
            Some(id) => format!("{}#{id}", paths[i]),
            None => paths[i].clone(),
        })
    };
    let chapters = parts
        .iter()
        .map(|part| {
            let html = kf8_markup(&part.markup, &target);
            decode(&html, h.codepage)
        })
        .collect();
    Ok((paths, chapters))
}

/// The last id (or name) attribute before `pos` in the markup: the target
/// of a kindle:pos link, as kindlegen keeps the source's ids.
fn id_before(markup: &[u8], pos: usize) -> Option<String> {
    let mut pos = pos.min(markup.len());
    // A position inside a tag counts the whole tag.
    if let Some(gt) = find(markup, b">", pos) {
        if find(markup, b"<", pos).is_none_or(|lt| lt == pos || gt < lt) {
            pos = gt + 1;
        }
    }
    let before = &markup[..pos];
    let mut best = None;
    let mut at = 0;
    while let Some(lt) = find(before, b"<", at) {
        let end = find(before, b">", lt).unwrap_or(before.len());
        let tag = &before[lt..end];
        for attr in [&b" id="[..], b" name="] {
            if let Some(p) = find_ci(tag, attr, 0) {
                let (value, _) = attr_value(tag, p + attr.len());
                if !value.is_empty() {
                    best = Some(String::from_utf8_lossy(value).into_owned());
                }
            }
        }
        at = end;
    }
    best
}

/// KF8 markup → XHTML: kindle:pos links and kindle:embed images rewritten.
fn kf8_markup(markup: &[u8], target: &dyn Fn(usize, usize) -> Option<String>) -> Vec<u8> {
    let mut out = Vec::with_capacity(markup.len());
    let mut at = 0;
    while let Some(p) = find(markup, b"kindle:", at) {
        out.extend_from_slice(&markup[at..p]);
        let end = markup[p..]
            .iter()
            .position(|&b| matches!(b, b'"' | b'\'' | b')' | b'>') || b.is_ascii_whitespace())
            .map_or(markup.len(), |e| e + p);
        let url = &markup[p..end];
        let replacement = if let Some(rest) = url.strip_prefix(b"kindle:pos:fid:") {
            // kindle:pos:fid:XXXX:off:YYYYYYYYYY
            let mut it = rest.split(|&b| b == b':');
            let fid = it.next().and_then(base32);
            let off = it.nth(1).and_then(base32);
            fid.zip(off).and_then(|(f, o)| target(f, o))
        } else if let Some(rest) = url.strip_prefix(b"kindle:embed:") {
            let id = rest.split(|&b| b == b'?').next().unwrap_or_default();
            base32(id).map(|n| format!("/res/{n}"))
        } else {
            None
        };
        match replacement {
            Some(r) => out.extend_from_slice(r.as_bytes()),
            None => out.extend_from_slice(url),
        }
        at = end;
    }
    out.extend_from_slice(&markup[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Built by kindling from a small Russian EPUB (cover, four chapters, an
    /// image, two footnotes with back-links, a notes chapter): test.azw3 is
    /// KF8 only, test.mobi has a MOBI7 part and a KF8 part.
    fn sample(name: &str) -> Vec<u8> {
        std::fs::read(format!("{}/../scripts/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }

    fn check_book(book: &MobiBook, chapter: &str) {
        assert_eq!(book.title(), "Тестовая книга MOBI");
        assert_eq!(book.author(), "Иван Петров");
        let c = |i| book.chapter_html(i).unwrap();
        assert_eq!(book.chapter_count(), 6);
        assert_eq!(book.chapter_paths()[0], "/cover.xhtml");
        assert!(c(0).contains("<img src=\"/res/1\""));
        assert!(c(1).contains("Глава 1"));
        assert!(c(3).contains("<img src=\"/res/2\""));
        assert!(c(5).contains("Первое примечание"));
        assert_eq!(book.chapter_paths()[1], format!("/{chapter}0.xhtml"));
        assert_eq!(book.mime_for("/res/1"), "image/png");
        assert!(book
            .read_resource("/res/2")
            .unwrap()
            .starts_with(b"\x89PNG"));
        assert!(book.read_resource("/res/99").is_err());
    }

    #[test]
    fn test_azw3() {
        let book = MobiBook::parse(&sample("test.azw3")).unwrap();
        check_book(&book, "part");
        let c = |i| book.chapter_html(i).unwrap();
        // kindle:pos links point at the target's id.
        assert!(c(2).contains("href=\"/part4.xhtml#n1\""));
        assert!(c(5).contains("href=\"/part1.xhtml#ref2\""));
        assert!(!c(2).contains("kindle:pos") && !c(3).contains("kindle:embed"));
    }

    #[test]
    fn test_combined_mobi_prefers_kf8() {
        let book = MobiBook::parse(&sample("test.mobi")).unwrap();
        check_book(&book, "part");
    }

    #[test]
    fn test_mobi7() {
        let book = MobiBook::parse_with(&sample("test.mobi"), false).unwrap();
        check_book(&book, "c");
        let c = |i| book.chapter_html(i).unwrap();
        // filepos links point at anchors placed at the target offsets.
        let href = |html: &str, from: &str| {
            let at = html.find(from).unwrap();
            let start = html[at..].find("href=\"").unwrap() + at + 6;
            html[start..start + html[start..].find('"').unwrap()].to_string()
        };
        let note = href(&c(2), "id=\"ref1\"");
        let (path, id) = note.split_once('#').unwrap();
        assert_eq!(path, "/c4.xhtml");
        let notes = c(5);
        let anchor = notes.find(&format!("<a id=\"{id}\"></a>")).unwrap();
        assert!(notes[anchor..]
            .trim_start_matches(|ch| ch != '>')
            .contains("Первое"));
        let back = href(&notes, "Первое примечание");
        assert!(back.starts_with("/c1.xhtml#fp"));
        assert!(c(2).contains(&format!(
            "<a id=\"{}\"></a>",
            back.split_once('#').unwrap().1
        )));
        assert!(!c(1).contains("mbp:") && !c(1).contains("filepos"));
    }

    #[test]
    fn test_drm_is_refused() {
        let mut bytes = sample("test.azw3");
        let rec0 = be32(&bytes, 78).unwrap() as usize;
        bytes[rec0 + 13] = 2;
        let err = MobiBook::parse(&bytes).err().unwrap();
        assert!(err.contains("DRM"), "{err}");
    }

    #[test]
    fn test_palmdoc_decompress() {
        // literal run, plain bytes, space + char, back-reference
        let data = [4, b'a', b'b', b'c', b'd', 0xE5, 0x80, 0x33];
        // 0x8033: distance 6, length 6 -> "abcd e" again
        assert_eq!(palmdoc_decompress(&data), b"abcd eabcd e");
    }

    #[test]
    fn test_trim_trailers() {
        let pdb_header = |flags: u32| Header {
            start: 0,
            compression: 2,
            text_records: 0,
            encryption: 0,
            codepage: 65001,
            version: 6,
            full_name: String::new(),
            first_resource: NONE,
            huff: (0, 0),
            trailers: ((flags >> 1).count_ones(), flags & 1 == 1),
            fdst: NONE,
            fragment_index: NONE,
            skeleton_index: NONE,
            exth: HashMap::new(),
        };
        // text, multibyte entry (1 extra byte + its size byte), then a
        // 3-byte trailing entry whose size is backward-encoded in its last byte
        let record = b"text\xD0\x01xx\x83";
        assert_eq!(pdb_header(0b11).trim_trailers(record), b"text");
        assert_eq!(pdb_header(0b10).trim_trailers(record), b"text\xD0\x01");
    }

    #[test]
    fn test_split_long_chapters_at_paragraphs_outside_containers() {
        let para = format!("<p>{}</p>", "слово ".repeat(1000));
        let quote = format!("<blockquote>{}</blockquote>", para.repeat(12));
        let piece = format!("{}{quote}{}", para.repeat(12), para.repeat(12));
        let parts = split_long(piece.as_bytes());
        assert!(parts.len() > 1);
        assert_eq!(parts.concat(), piece.as_bytes());
        for p in &parts {
            assert!(p.starts_with(b"<p>") || p.starts_with(b"<blockquote>"));
        }
    }

    #[test]
    fn test_mobi7_markup() {
        let piece = br#"<mbp:frameset><p>See <a filepos=0000000123>note</a> <img recindex="00004" /></p></mbp:frameset><mbp:nu>x</mbp:nu>"#;
        let html = mobi7_markup(piece, &|n| Some(format!("/c1.xhtml#fp{n}")));
        assert_eq!(
            String::from_utf8(html).unwrap(),
            r#"<p>See <a href="/c1.xhtml#fp123">note</a> <img src="/res/4" /></p>x"#
        );
    }
}
