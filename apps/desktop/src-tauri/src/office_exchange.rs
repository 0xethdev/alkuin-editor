//! Word round trip, and Google Docs through Google's Word export.
//!
//! shortcut: Google Docs import downloads `/export?format=docx` for a doc shared
//! as anyone with the link. Export saves a Word file and the desk opens Drive.
//! Upgrade when the app has a Google client id.
//! shortcut: lists come back as bullets. Encrypted and Deflate64 files are
//! refused. Headers, footers, and footnotes are skipped. An SVG is drawn as a
//! picture. The renderer does not read other files, the network, or system fonts.
//! Upgrade when a draft needs numbering, a password, or those parts.
//! shortcut: `_italic_` stays as characters. The editor writes asterisks.

use crate::error::AppError;
use image::GenericImageView;
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const MAX_DOCX_BYTES: usize = 20 * 1024 * 1024;

const WORD_UNREADABLE: &str = "Alkuin couldn't read that Word file.";
const WORD_EMPTY: &str = "That Word file had no text Alkuin could read.";
const WORD_TOO_BIG: &str = "That Word file is too large to import.";
const GOOGLE_FAILED: &str =
    "Alkuin couldn't download that Google Doc. Share it so anyone with the link can view it, or import the Word file.";
const GOOGLE_TOO_BIG: &str = "That Google Doc is too large to import.";
const GOOGLE_EMPTY: &str = "That Google Doc had no text Alkuin could read.";
const GOOGLE_LINK: &str = "That isn't a Google Docs link.";
const GOOGLE_PASTE: &str = "Paste a Google Docs link.";
const SAVE_FAILED: &str = "Alkuin couldn't save that Word file.";
const NOT_DOCX: &str = "Choose a .docx file.";

fn office(message: impl Into<String>) -> AppError {
    AppError::Message(message.into())
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Style {
    bold: bool,
    italic: bool,
    strike: bool,
}

impl Style {
    fn plain() -> Self {
        Self {
            bold: false,
            italic: false,
            strike: false,
        }
    }
}

struct Span {
    style: Style,
    text: String,
    url: Option<String>,
}

enum MdBlock {
    Heading { level: u8, text: String },
    Text { text: String, plain: bool },
    Table { rows: Vec<Vec<String>> },
    Image { alt: String, src: String },
}

#[derive(Clone, Copy)]
enum Kind {
    Heading(u8),
    List(u32),
    Quote,
    Para,
}

struct Run {
    style: Style,
    text: String,
}

struct Para {
    heading: Option<u8>,
    list: Option<u32>,
    quote: bool,
    num_depth: u32,
    rpr_depth: u32,
    runs: Vec<Run>,
    run: Option<Run>,
}

impl Para {
    fn new() -> Self {
        Self {
            heading: None,
            list: None,
            quote: false,
            num_depth: 0,
            rpr_depth: 0,
            runs: Vec::new(),
            run: None,
        }
    }
}

/// Read a `.docx` and return the note body.
#[tauri::command]
pub async fn docx_to_markdown(path: String) -> Result<String, AppError> {
    blocking(move || {
        let bytes = read_docx_file(&path)?;
        markdown_from_docx(&bytes, WORD_EMPTY)
    })
    .await
}

/// Run blocking file and zip work off the main thread.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(format!("Word task failed: {e}")))?
}

/// Download a link-shared Google Doc as Word, then use the same reader.
#[tauri::command]
pub async fn google_doc_to_markdown(url: String) -> Result<String, AppError> {
    let id = google_document_id(&url)?;
    let export = format!("https://docs.google.com/document/d/{id}/export?format=docx");
    let bytes = fetch_docx(&export, MAX_DOCX_BYTES).await?;
    markdown_from_docx(&bytes, GOOGLE_EMPTY)
}

/// Write the open note as `.docx`. `body` is the editor buffer, without frontmatter.
/// `note_path` is the note file, used only to find pictures that sit beside it.
#[tauri::command]
pub async fn export_docx(
    path: String,
    title: String,
    body: String,
    note_path: String,
) -> Result<(), AppError> {
    blocking(move || write_docx_file(&path, &title, &body, &note_path)).await
}

pub(crate) fn google_document_id(input: &str) -> Result<String, AppError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(office(GOOGLE_PASTE));
    }
    let Some(rest) = after_http_scheme(trimmed) else {
        return Err(office(GOOGLE_LINK));
    };
    let host_and_path = rest.split(['?', '#']).next().unwrap_or(rest);
    let Some((host, path)) = host_and_path.split_once('/') else {
        return Err(office(GOOGLE_LINK));
    };
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    if !host.eq_ignore_ascii_case("docs.google.com") {
        return Err(office(GOOGLE_LINK));
    }
    let path = path.trim_start_matches('/');
    let path_lower = path.to_ascii_lowercase();
    let id_at = if path_lower.starts_with("document/d/") {
        "document/d/".len()
    } else if let Some(rest) = path_lower.strip_prefix("document/u/") {
        let Some(rel) = rest.find("/d/") else {
            return Err(office(GOOGLE_LINK));
        };
        "document/u/".len() + rel + "/d/".len()
    } else {
        return Err(office(GOOGLE_LINK));
    };
    let id: String = path[id_at..]
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .collect();
    if !(10..=128).contains(&id.len()) {
        return Err(office(GOOGLE_LINK));
    }
    Ok(id)
}

fn after_http_scheme(input: &str) -> Option<&str> {
    let lower = input.to_ascii_lowercase();
    if let Some(index) = lower.find("https://") {
        return Some(&input[index + "https://".len()..]);
    }
    if let Some(index) = lower.find("http://") {
        return Some(&input[index + "http://".len()..]);
    }
    if lower.contains("://") {
        return None;
    }
    Some(input)
}

fn read_docx_file(path: &str) -> Result<Vec<u8>, AppError> {
    let meta = fs::metadata(path).map_err(|_| office(WORD_UNREADABLE))?;
    if !meta.is_file() {
        return Err(office(WORD_UNREADABLE));
    }
    if meta.len() > MAX_DOCX_BYTES as u64 {
        return Err(office(WORD_TOO_BIG));
    }
    let bytes = fs::read(path).map_err(|_| office(WORD_UNREADABLE))?;
    if !is_zip(&bytes) {
        return Err(office(WORD_UNREADABLE));
    }
    Ok(bytes)
}

fn markdown_from_docx(bytes: &[u8], empty_message: &str) -> Result<String, AppError> {
    let xml = document_xml_from_zip(bytes)?;
    let markdown = markdown_from_document_xml(&xml)?;
    if markdown.trim().is_empty() {
        return Err(office(empty_message));
    }
    Ok(markdown)
}

fn document_xml_from_zip(bytes: &[u8]) -> Result<String, AppError> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|_| office(WORD_UNREADABLE))?;
    let mut found = None;
    for index in 0..archive.len() {
        let name = archive
            .name_for_index(index)
            .unwrap_or("")
            .replace('\\', "/");
        let name = name.trim_start_matches('/');
        if name.eq_ignore_ascii_case("word/document.xml") {
            found = Some(index);
            break;
        }
    }
    let Some(index) = found else {
        return Err(office(WORD_UNREADABLE));
    };
    let mut file = archive
        .by_index(index)
        .map_err(|_| office(WORD_UNREADABLE))?;
    if file.size() > MAX_DOCX_BYTES as u64 {
        return Err(office(WORD_TOO_BIG));
    }
    let mut buf = Vec::new();
    // The size in the zip header is only a claim. Read at most one byte past the cap.
    (&mut file)
        .take(MAX_DOCX_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|_| office(WORD_UNREADABLE))?;
    if buf.len() > MAX_DOCX_BYTES {
        return Err(office(WORD_TOO_BIG));
    }
    Ok(xml_text(&buf))
}

fn xml_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return utf16(&bytes[2..], true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return utf16(&bytes[2..], false);
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

fn utf16(bytes: &[u8], little_endian: bool) -> String {
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| {
            if little_endian {
                u16::from_le_bytes([chunk[0], chunk[1]])
            } else {
                u16::from_be_bytes([chunk[0], chunk[1]])
            }
        })
        .collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
}

fn is_zip(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"PK\x05\x06")
        || bytes.starts_with(b"PK\x07\x08")
}

fn markdown_from_document_xml(xml: &str) -> Result<String, AppError> {
    let mut reader = Reader::from_str(xml);
    let mut paras = Vec::new();
    let mut skip_del = 0u32;
    let mut rendered = Vec::new();
    loop {
        let event = reader.read_event().map_err(|_| office(WORD_UNREADABLE))?;
        match event {
            Event::Start(element) => {
                let tag = local_name(&element);
                if tag == "del" {
                    skip_del += 1;
                    continue;
                }
                if skip_del > 0 {
                    continue;
                }
                if tag == "p" {
                    paras.push(Para::new());
                    continue;
                }
                let Some(para) = paras.last_mut() else {
                    continue;
                };
                on_start(para, &element, &tag);
            }
            Event::Empty(element) => {
                if skip_del > 0 {
                    continue;
                }
                let tag = local_name(&element);
                let Some(para) = paras.last_mut() else {
                    continue;
                };
                on_start(para, &element, &tag);
                on_end(para, &tag);
            }
            Event::Text(text) => {
                if skip_del > 0 {
                    continue;
                }
                if let Some(para) = paras.last_mut() {
                    if para.rpr_depth == 0 {
                        if let Some(run) = para.run.as_mut() {
                            if let Ok(value) = text.decode() {
                                run.text.push_str(&value);
                            }
                        }
                    }
                }
            }
            Event::End(element) => {
                let tag = String::from_utf8_lossy(element.local_name().as_ref()).into_owned();
                if tag == "del" {
                    skip_del = skip_del.saturating_sub(1);
                    continue;
                }
                if skip_del > 0 {
                    continue;
                }
                if tag == "p" {
                    if let Some(para) = paras.pop() {
                        rendered.extend(render_para(para));
                    }
                    continue;
                }
                if let Some(para) = paras.last_mut() {
                    on_end(para, &tag);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(join_rendered(&rendered))
}

fn local_name(element: &BytesStart) -> String {
    String::from_utf8_lossy(element.local_name().as_ref()).into_owned()
}

fn on_start(para: &mut Para, element: &BytesStart, tag: &str) {
    match tag {
        "r" => {
            para.run = Some(Run {
                style: Style::plain(),
                text: String::new(),
            });
        }
        "rPr" => para.rpr_depth += 1,
        "numPr" => {
            para.num_depth += 1;
            if para.list.is_none() {
                para.list = Some(0);
            }
        }
        "pStyle" => apply_style(para, &attr(element, "val").unwrap_or_default()),
        "ilvl" if para.num_depth > 0 => {
            let level = attr(element, "val")
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            para.list = Some(level);
        }
        "b" | "i" | "strike" | "dstrike" if para.rpr_depth > 0 => {
            if let Some(run) = para.run.as_mut() {
                let on = flag_on(element);
                match tag {
                    "b" => run.style.bold = on,
                    "i" => run.style.italic = on,
                    "strike" | "dstrike" => run.style.strike = on,
                    _ => {}
                }
            }
        }
        "tab" => push_run_text(para, " "),
        "br" | "cr" => push_run_text(para, "\n"),
        _ => {}
    }
}

fn on_end(para: &mut Para, tag: &str) {
    match tag {
        "r" => {
            if let Some(run) = para.run.take() {
                if !run.text.is_empty() {
                    para.runs.push(run);
                }
            }
        }
        "rPr" => para.rpr_depth = para.rpr_depth.saturating_sub(1),
        "numPr" => para.num_depth = para.num_depth.saturating_sub(1),
        _ => {}
    }
}

fn push_run_text(para: &mut Para, text: &str) {
    if para.run.is_none() {
        para.run = Some(Run {
            style: Style::plain(),
            text: String::new(),
        });
    }
    if let Some(run) = para.run.as_mut() {
        run.text.push_str(text);
    }
}

fn apply_style(para: &mut Para, style: &str) {
    let compact: String = style
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '-' && *ch != '_')
        .flat_map(|ch| ch.to_lowercase())
        .collect();
    if let Some(level) = heading_level(&compact) {
        para.heading = Some(level);
        return;
    }
    if compact == "quote" || compact == "intensequote" {
        para.quote = true;
    }
}

fn heading_level(compact: &str) -> Option<u8> {
    match compact {
        "title" | "heading1" | "h1" => Some(1),
        "subtitle" | "heading2" | "h2" => Some(2),
        "heading3" | "h3" => Some(3),
        "heading4" | "h4" => Some(4),
        "heading5" | "h5" => Some(5),
        "heading6" | "h6" => Some(6),
        _ => None,
    }
}

fn flag_on(element: &BytesStart) -> bool {
    match attr(element, "val") {
        None => true,
        Some(value) => {
            let value = value.trim();
            !value.eq_ignore_ascii_case("false")
                && value != "0"
                && !value.eq_ignore_ascii_case("off")
        }
    }
}

fn attr(element: &BytesStart, name: &str) -> Option<String> {
    element.attributes().with_checks(false).find_map(|item| {
        let item = item.ok()?;
        if item.key.local_name().as_ref() == name.as_bytes() {
            item.unescape_value().ok().map(|value| value.into_owned())
        } else {
            None
        }
    })
}

struct Rendered {
    kind: Kind,
    text: String,
}

fn render_para(para: Para) -> Vec<Rendered> {
    let mut para = para;
    if let Some(run) = para.run.take() {
        if !run.text.is_empty() {
            para.runs.push(run);
        }
    }
    let kind = if let Some(level) = para.heading {
        Kind::Heading(level.clamp(1, 6))
    } else if let Some(level) = para.list {
        Kind::List(level.min(8))
    } else if para.quote {
        Kind::Quote
    } else {
        Kind::Para
    };
    render_lines(&para.runs)
        .into_iter()
        .map(|text| Rendered {
            kind: match kind {
                Kind::Heading(level) => Kind::Heading(level),
                Kind::List(level) => Kind::List(level),
                Kind::Quote => Kind::Quote,
                Kind::Para => Kind::Para,
            },
            text,
        })
        .collect()
}

fn render_lines(runs: &[Run]) -> Vec<String> {
    let mut lines: Vec<Vec<Span>> = vec![Vec::new()];
    for run in runs {
        for (index, part) in run.text.split('\n').enumerate() {
            if index > 0 {
                lines.push(Vec::new());
            }
            if part.is_empty() {
                continue;
            }
            let line = lines.last_mut().unwrap();
            if let Some(last) = line.last_mut() {
                if last.style == run.style {
                    last.text.push_str(part);
                    continue;
                }
            }
            line.push(Span {
                style: run.style,
                text: part.to_string(),
                url: None,
            });
        }
    }
    lines
        .into_iter()
        .map(|pieces| {
            let mut line = String::new();
            for piece in pieces {
                line.push_str(&wrap(piece.style, &piece.text));
            }
            line
        })
        .filter(|line| !line.trim().is_empty())
        .collect()
}

fn wrap(style: Style, text: &str) -> String {
    if text.trim().is_empty() {
        return escape_md(text);
    }
    let escaped = escape_md(text);
    match (style.bold, style.italic, style.strike) {
        (true, true, true) => format!("~~***{escaped}***~~"),
        (true, true, false) => format!("***{escaped}***"),
        (true, false, true) => format!("~~**{escaped}**~~"),
        (false, true, true) => format!("~~*{escaped}*~~"),
        (false, false, true) => format!("~~{escaped}~~"),
        (true, false, false) => format!("**{escaped}**"),
        (false, true, false) => format!("*{escaped}*"),
        (false, false, false) => escaped,
    }
}

fn escape_md(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if matches!(ch, '\\' | '*' | '_' | '`' | '[') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn join_rendered(blocks: &[Rendered]) -> String {
    let mut out = String::new();
    for block in blocks {
        let line = match block.kind {
            Kind::Heading(level) => format!("{} {}", "#".repeat(level as usize), block.text),
            Kind::List(level) => format!("{}- {}", "  ".repeat(level as usize), block.text),
            Kind::Quote => format!("> {}", block.text),
            Kind::Para => block.text.clone(),
        };
        if line.trim().is_empty() {
            continue;
        }
        if !out.is_empty() {
            let previous_list = out.lines().next_back().is_some_and(is_list_line);
            out.push_str(if previous_list && is_list_line(&line) {
                "\n"
            } else {
                "\n\n"
            });
        }
        out.push_str(&line);
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

fn is_list_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("- ")
        || trimmed.starts_with("* ")
        || trimmed.starts_with("+ ")
        || numbered_line(trimmed)
}

fn numbered_line(trimmed: &str) -> bool {
    let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0 && digits <= 9 && trimmed[digits..].starts_with(". ")
}

fn write_docx_file(path: &str, title: &str, body: &str, note_path: &str) -> Result<(), AppError> {
    if path.trim().is_empty() || !is_docx_path(path) {
        return Err(office(NOT_DOCX));
    }
    if is_markdown_path(path) {
        return Err(office(NOT_DOCX));
    }
    let bytes = markdown_to_docx(title, body, note_path)?;
    let file_path = Path::new(path);
    let dir = file_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temp_path = dir.join(format!(".~{}", uuid::Uuid::new_v4()));
    fs::write(&temp_path, &bytes).map_err(|_| office(SAVE_FAILED))?;
    if let Err(err) = fs::rename(&temp_path, file_path) {
        let _ = fs::remove_file(&temp_path);
        let _ = err;
        return Err(office(SAVE_FAILED));
    }
    Ok(())
}

fn is_docx_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("docx"))
}

fn is_markdown_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
}

struct BuiltDoc {
    document: String,
    links: Vec<String>,
    images: Vec<LocalImage>,
}

fn markdown_to_docx(title: &str, body: &str, note_path: &str) -> Result<Vec<u8>, AppError> {
    let built = build_document(title, body, note_path)?;
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let types = content_types_xml(&built);
        let rels = document_rels(&built);
        let parts = [
            ("[Content_Types].xml", types),
            ("_rels/.rels", package_rels()),
            ("word/document.xml", built.document),
            ("word/_rels/document.xml.rels", rels),
            ("word/styles.xml", styles_xml()),
        ];
        for (name, content) in parts {
            zip.start_file(name, options)
                .map_err(|_| office(SAVE_FAILED))?;
            zip.write_all(content.as_bytes())
                .map_err(|_| office(SAVE_FAILED))?;
        }
        for (index, image) in built.images.iter().enumerate() {
            let ext = if image.jpeg { "jpeg" } else { "png" };
            zip.start_file(format!("word/media/image{}.{}", index + 1, ext), options)
                .map_err(|_| office(SAVE_FAILED))?;
            zip.write_all(&image.bytes)
                .map_err(|_| office(SAVE_FAILED))?;
        }
        zip.finish().map_err(|_| office(SAVE_FAILED))?;
    }
    Ok(cursor.into_inner())
}

fn content_types_xml(built: &BuiltDoc) -> String {
    let mut extra = String::new();
    if built.images.iter().any(|image| image.jpeg) {
        extra.push_str("<Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/>");
    }
    if built.images.iter().any(|image| !image.jpeg) {
        extra.push_str("<Default Extension=\"png\" ContentType=\"image/png\"/>");
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
{extra}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"#
    )
}

fn package_rels() -> String {
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#
        .to_string()
}

fn document_rels(built: &BuiltDoc) -> String {
    let mut rels = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>"#,
    );
    for (index, url) in built.links.iter().enumerate() {
        rels.push_str(&format!(
            r#"<Relationship Id="rIdL{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="{}" TargetMode="External"/>"#,
            index + 1,
            xml_escape(url)
        ));
    }
    for (index, image) in built.images.iter().enumerate() {
        let ext = if image.jpeg { "jpeg" } else { "png" };
        rels.push_str(&format!(
            r#"<Relationship Id="rIdI{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image{}.{}"/>"#,
            index + 1,
            index + 1,
            ext
        ));
    }
    rels.push_str("</Relationships>");
    rels
}

fn styles_xml() -> String {
    let mut styles = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>"#,
    );
    let sizes = [32, 28, 26, 24, 22, 20];
    for level in 1..=6 {
        let size = sizes[level - 1];
        let outline = level - 1;
        styles.push_str(&format!(
            r#"<w:style w:type="paragraph" w:styleId="Heading{level}"><w:name w:val="heading {level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:outlineLvl w:val="{outline}"/></w:pPr><w:rPr><w:b/><w:sz w:val="{size}"/></w:rPr></w:style>"#
        ));
    }
    styles.push_str("</w:styles>");
    styles
}

fn build_document(title: &str, body: &str, note_path: &str) -> Result<BuiltDoc, AppError> {
    let mut built = BuiltDoc {
        document: String::new(),
        links: Vec::new(),
        images: Vec::new(),
    };
    let mut pictures = ImageStore::new();
    let mut body_xml = String::new();
    for block in titled_blocks(title, body)? {
        match block {
            MdBlock::Heading { level, text } => {
                let id = format!("Heading{level}");
                body_xml.push_str(&paragraph(Some(&id), &runs_xml(&text, false, &mut built)?));
            }
            MdBlock::Text { text, plain } => {
                body_xml.push_str(&paragraph(None, &runs_xml(&text, plain, &mut built)?));
            }
            MdBlock::Table { rows } => body_xml.push_str(&table_xml(&rows, &mut built)?),
            MdBlock::Image { alt, src } => {
                let index = pictures.intern(note_path, &src)?;
                let image = &pictures.images[index];
                let (cx, cy) = image_emu(image.width, image.height);
                body_xml.push_str(&drawing_xml(index + 1, cx, cy));
                if !alt.trim().is_empty() {
                    body_xml.push_str(&paragraph(None, &runs_xml(&alt, false, &mut built)?));
                }
            }
        }
    }
    built.images = pictures.images;
    if body_xml.is_empty() {
        body_xml.push_str(&paragraph(None, "<w:r><w:t></w:t></w:r>"));
    }
    built.document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>{body_xml}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    );
    Ok(built)
}

fn table_xml(rows: &[Vec<String>], built: &mut BuiltDoc) -> Result<String, AppError> {
    let mut xml = String::from(
        r#"<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr>"#,
    );
    for row in rows {
        xml.push_str("<w:tr>");
        for cell in row {
            xml.push_str("<w:tc><w:p>");
            xml.push_str(&runs_xml(cell, false, built)?);
            xml.push_str("</w:p></w:tc>");
        }
        xml.push_str("</w:tr>");
    }
    xml.push_str("</w:tbl>");
    Ok(xml)
}

fn image_emu(width: u32, height: u32) -> (i64, i64) {
    let mut cx = i64::from(width) * 9525;
    let mut cy = i64::from(height) * 9525;
    let max_cx = 5_943_600i64;
    let max_cy = 7_620_000i64;
    if cx > max_cx && cx > 0 {
        cy = cy * max_cx / cx;
        cx = max_cx;
    }
    if cy > max_cy && cy > 0 {
        cx = cx * max_cy / cy;
        cy = max_cy;
    }
    (cx.max(1), cy.max(1))
}

fn drawing_xml(index: usize, cx: i64, cy: i64) -> String {
    format!(
        r#"<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{index}" name="image{index}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{index}" name="image{index}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdI{index}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"#
    )
}

fn paragraph(style: Option<&str>, runs: &str) -> String {
    match style {
        Some(id) => format!("<w:p><w:pPr><w:pStyle w:val=\"{id}\"/></w:pPr>{runs}</w:p>"),
        None => format!("<w:p>{runs}</w:p>"),
    }
}

fn runs_xml(text: &str, plain: bool, built: &mut BuiltDoc) -> Result<String, AppError> {
    if plain {
        return Ok(format!("<w:r>{}</w:r>", text_el(text)));
    }
    if text.contains("![") {
        return Err(office("Put each image on its own line."));
    }
    let mut xml = String::new();
    for span in parse_inline(text)? {
        if span.text.is_empty() && span.url.is_none() {
            continue;
        }
        let run = format!("<w:r>{}{}</w:r>", rpr(span.style), text_el(&span.text));
        if let Some(url) = span.url {
            built.links.push(url);
            xml.push_str(&format!(
                "<w:hyperlink r:id=\"rIdL{}\">{run}</w:hyperlink>",
                built.links.len()
            ));
        } else {
            xml.push_str(&run);
        }
    }
    if xml.is_empty() {
        xml.push_str("<w:r><w:t></w:t></w:r>");
    }
    Ok(xml)
}

fn rpr(style: Style) -> String {
    if !style.bold && !style.italic && !style.strike {
        return String::new();
    }
    let mut inner = String::new();
    if style.bold {
        inner.push_str("<w:b/>");
    }
    if style.italic {
        inner.push_str("<w:i/>");
    }
    if style.strike {
        inner.push_str("<w:strike/>");
    }
    format!("<w:rPr>{inner}</w:rPr>")
}

fn text_el(text: &str) -> String {
    let escaped = xml_escape(text);
    if text.starts_with(' ') || text.ends_with(' ') || text.contains("  ") {
        format!("<w:t xml:space=\"preserve\">{escaped}</w:t>")
    } else {
        format!("<w:t>{escaped}</w:t>")
    }
}

fn xml_escape(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            ch if ch.is_control() && ch != '\t' && ch != '\n' && ch != '\r' => {}
            ch => out.push(ch),
        }
    }
    out
}

fn titled_blocks(title: &str, body: &str) -> Result<Vec<MdBlock>, AppError> {
    let mut blocks = markdown_blocks(body)?;
    let title = title.trim();
    if title.is_empty() {
        return Ok(blocks);
    }
    let duplicate = matches!(
        blocks.first(),
        Some(MdBlock::Heading { text, .. }) if plain_title(text) == plain_title(title)
    );
    if !duplicate {
        blocks.insert(
            0,
            MdBlock::Heading {
                level: 1,
                text: title.to_string(),
            },
        );
    }
    Ok(blocks)
}

fn plain_title(text: &str) -> String {
    text.chars()
        .filter(|ch| !matches!(ch, '*' | '_' | '`' | '~' | '\\'))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn markdown_blocks(body: &str) -> Result<Vec<MdBlock>, AppError> {
    let normalized = body
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut blocks = Vec::new();
    let mut para = Vec::new();
    // True when every line already in `para` is a list or quote line.
    let mut para_is_list = false;
    let mut fence: Option<usize> = None;
    for line in normalized.split('\n') {
        if let Some(width) = fence {
            let trimmed = line.trim();
            let closing = trimmed.len() >= width && trimmed.bytes().all(|byte| byte == b'`');
            push_plain(&mut blocks, line);
            if closing {
                fence = None;
            }
            continue;
        }
        if line.trim().is_empty() {
            flush_para(&mut para, &mut blocks)?;
            para_is_list = false;
            continue;
        }
        if let Some(width) = opening_fence(line) {
            flush_para(&mut para, &mut blocks)?;
            para_is_list = false;
            push_plain(&mut blocks, line);
            fence = Some(width);
            continue;
        }
        if let Some((level, text)) = atx(line) {
            flush_para(&mut para, &mut blocks)?;
            para_is_list = false;
            if !text.is_empty() {
                blocks.push(MdBlock::Heading { level, text });
            }
            continue;
        }
        if list_line(line) || quote_line(line) {
            if !para.is_empty() && !para_is_list {
                flush_para(&mut para, &mut blocks)?;
            }
            para.push(line.to_string());
            para_is_list = true;
            continue;
        }
        if para_is_list {
            if line.starts_with(' ') || line.starts_with('\t') {
                let last = para.last_mut().unwrap();
                last.push(' ');
                last.push_str(line.trim());
                continue;
            }
            flush_para(&mut para, &mut blocks)?;
        }
        para.push(line.to_string());
        para_is_list = false;
    }
    flush_para(&mut para, &mut blocks)?;
    Ok(blocks)
}

fn push_plain(blocks: &mut Vec<MdBlock>, line: &str) {
    let text = line.trim_end().to_string();
    if text.trim().is_empty() {
        return;
    }
    blocks.push(MdBlock::Text { text, plain: true });
}

fn flush_para(para: &mut Vec<String>, blocks: &mut Vec<MdBlock>) -> Result<(), AppError> {
    if para.is_empty() {
        return Ok(());
    }
    let lines = std::mem::take(para);
    if lines.iter().all(|line| table_row(line)) {
        if let Some(rows) = table_rows(&lines) {
            blocks.push(MdBlock::Table { rows });
            return Ok(());
        }
    }
    if lines.iter().any(|line| line.contains("![")) {
        for line in lines {
            if let Some((alt, src)) = sole_image(&line) {
                blocks.push(MdBlock::Image { alt, src });
                continue;
            }
            if line.contains("![") {
                return Err(office("Put each image on its own line."));
            }
            let text = line.trim().to_string();
            if !text.is_empty() {
                blocks.push(MdBlock::Text { text, plain: false });
            }
        }
        return Ok(());
    }
    if lines.iter().all(|line| list_line(line) || quote_line(line)) {
        for line in lines {
            let text = line.trim_end().to_string();
            if !text.trim().is_empty() {
                blocks.push(MdBlock::Text { text, plain: false });
            }
        }
        return Ok(());
    }
    let text = lines
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if !text.is_empty() {
        blocks.push(MdBlock::Text { text, plain: false });
    }
    Ok(())
}

pub(crate) fn table_row(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with('|')
        && trimmed.ends_with('|')
        && trimmed.chars().filter(|ch| *ch == '|').count() >= 2
}

fn table_cells(line: &str) -> Vec<String> {
    let trimmed = line.trim();
    let trimmed = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let trimmed = trimmed.strip_suffix('|').unwrap_or(trimmed);
    trimmed
        .split('|')
        .map(|cell| cell.trim().to_string())
        .collect()
}

fn separator_cells(cells: &[String]) -> bool {
    !cells.is_empty()
        && cells.iter().all(|cell| {
            let cell = cell.trim();
            !cell.is_empty()
                && cell.chars().all(|ch| ch == '-' || ch == ':' || ch == ' ')
                && cell.chars().any(|ch| ch == '-')
        })
}

fn table_rows(lines: &[String]) -> Option<Vec<Vec<String>>> {
    if lines.len() < 2 {
        return None;
    }
    let parsed: Vec<Vec<String>> = lines.iter().map(|line| table_cells(line)).collect();
    if !separator_cells(&parsed[1]) {
        return None;
    }
    let width = parsed[0].len();
    if width == 0 || parsed.iter().any(|row| row.len() != width) {
        return None;
    }
    let mut rows = vec![parsed[0].clone()];
    rows.extend(parsed.into_iter().skip(2));
    Some(rows)
}

pub(crate) fn sole_image(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.starts_with("![[") {
        let rest = trimmed.strip_prefix("![[")?;
        let end = rest.find("]]")?;
        if !rest[end + 2..].trim().is_empty() {
            return None;
        }
        let inner = &rest[..end];
        let (target, alias) = match inner.split_once('|') {
            Some((target, alias)) => (target.trim(), alias.trim()),
            None => (inner.trim(), ""),
        };
        if target.is_empty() {
            return None;
        }
        let alt = if alias.is_empty() { target } else { alias };
        return Some((alt.to_string(), target.to_string()));
    }
    if let Some(rest) = trimmed.strip_prefix("![") {
        let end_alt = rest.find("](")?;
        let alt = rest[..end_alt].to_string();
        let after = &rest[end_alt + 2..];
        let (src, taken) = markdown_destination(after, true)?;
        if !after[taken..].trim().is_empty() {
            return None;
        }
        return Some((alt, src.to_string()));
    }
    None
}

fn opening_fence(line: &str) -> Option<usize> {
    let trimmed = line.trim_start();
    let ticks = trimmed.bytes().take_while(|byte| *byte == b'`').count();
    if ticks >= 3 && !trimmed[ticks..].contains('`') {
        Some(ticks)
    } else {
        None
    }
}

fn atx(line: &str) -> Option<(u8, String)> {
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() && bytes[index] == b' ' {
        index += 1;
    }
    if index > 3 {
        return None;
    }
    let start = index;
    while index < bytes.len() && bytes[index] == b'#' {
        index += 1;
    }
    let hashes = index - start;
    if hashes == 0 || hashes > 6 {
        return None;
    }
    if index < bytes.len() && bytes[index] != b' ' && bytes[index] != b'\t' {
        return None;
    }
    let mut text = line[index..].trim().to_string();
    if let Some(space) = text.rfind(' ') {
        let closing = &text[space + 1..];
        if !closing.is_empty() && closing.bytes().all(|byte| byte == b'#') {
            text = text[..space].trim_end().to_string();
        }
    }
    Some((hashes as u8, text))
}

fn list_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("- ")
        || trimmed.starts_with("* ")
        || trimmed.starts_with("+ ")
        || numbered_line(trimmed)
}

fn quote_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("> ") || trimmed == ">"
}

fn parse_inline(input: &str) -> Result<Vec<Span>, AppError> {
    let mut spans = Vec::new();
    parse_into(input, Style::plain(), &mut spans)?;
    let mut merged = Vec::new();
    for span in spans {
        if span.text.is_empty() {
            continue;
        }
        if let Some(last) = merged.last_mut() {
            let last: &mut Span = last;
            if last.style == span.style && last.url == span.url {
                last.text.push_str(&span.text);
                continue;
            }
        }
        merged.push(span);
    }
    Ok(merged)
}

fn parse_into(input: &str, style: Style, out: &mut Vec<Span>) -> Result<(), AppError> {
    let mut index = 0;
    let mut plain = String::new();
    while index < input.len() {
        let rest = &input[index..];
        if rest.starts_with('\\') {
            let mut chars = rest.chars();
            chars.next();
            if let Some(ch) = chars.next() {
                plain.push(ch);
                index += 1 + ch.len_utf8();
            } else {
                plain.push('\\');
                index += 1;
            }
            continue;
        }
        if rest.starts_with('`') {
            if let Some(end) = rest[1..].find('`') {
                flush_plain(&mut plain, style, out);
                let taken = end + 2;
                out.push(Span {
                    style,
                    text: rest[..taken].to_string(),
                    url: None,
                });
                index += taken;
                continue;
            }
        }
        if let Some((label, url, taken)) = take_link(rest) {
            let url = link_target(url)?;
            flush_plain(&mut plain, style, out);
            let start = out.len();
            parse_into(label, style, out)?;
            if start == out.len() {
                out.push(Span {
                    style,
                    text: String::new(),
                    url: Some(url),
                });
            } else {
                for span in &mut out[start..] {
                    span.url = Some(url.clone());
                }
            }
            index += taken;
            continue;
        }
        if let Some((marker, next)) = opener(rest, style) {
            if let Some(rel) = find_marker(&rest[marker.len()..], marker) {
                flush_plain(&mut plain, style, out);
                let inner = &rest[marker.len()..marker.len() + rel];
                parse_into(inner, next, out)?;
                index += marker.len() * 2 + inner.len();
                continue;
            }
            plain.push_str(marker);
            index += marker.len();
            continue;
        }
        let ch = rest.chars().next().unwrap();
        plain.push(ch);
        index += ch.len_utf8();
    }
    flush_plain(&mut plain, style, out);
    Ok(())
}

fn flush_plain(plain: &mut String, style: Style, out: &mut Vec<Span>) {
    if plain.is_empty() {
        return;
    }
    out.push(Span {
        style,
        text: std::mem::take(plain),
        url: None,
    });
}

/// A markdown link or an autolink. The label may itself contain emphasis.
pub(crate) fn take_link(rest: &str) -> Option<(&str, &str, usize)> {
    if rest.starts_with('<') {
        let end = rest.find('>')?;
        let inner = &rest[1..end];
        let lower = inner.to_ascii_lowercase();
        if lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("mailto:")
        {
            return Some((inner, inner, end + 1));
        }
        return None;
    }
    if !rest.starts_with('[') {
        return None;
    }
    let close = rest.find("](")?;
    let label = &rest[1..close];
    if label.contains('\n') || label.contains("](") {
        return None;
    }
    let after = &rest[close + 2..];
    let (url, taken) = markdown_destination(after, false)?;
    Some((label, url, close + 2 + taken))
}

/// The destination that follows `](`, including its closing `)`.
/// Angle brackets are how a name with a space is written. Parentheses inside
/// the address count only when they are balanced, so the target is not cut
/// at the first `)`.
fn markdown_destination(after: &str, allow_space: bool) -> Option<(&str, usize)> {
    let bytes = after.as_bytes();
    if bytes.first() == Some(&b'<') {
        let end = after[1..].find('>')?;
        let url = &after[1..1 + end];
        if url.is_empty() || bytes.get(end + 2) != Some(&b')') {
            return None;
        }
        return Some((url, end + 3));
    }
    let mut depth = 0i32;
    let mut index = 0;
    while index < bytes.len() {
        let ch = bytes[index];
        if ch == b'\\' && index + 1 < bytes.len() {
            index += 2;
            continue;
        }
        if !allow_space && ch.is_ascii_whitespace() {
            return None;
        }
        if ch == b'(' {
            depth += 1;
        } else if ch == b')' {
            if depth == 0 {
                if index == 0 {
                    return None;
                }
                return Some((&after[..index], index + 1));
            }
            depth -= 1;
        }
        index += 1;
    }
    None
}

pub(crate) fn link_target(url: &str) -> Result<String, AppError> {
    let url = url.trim();
    if url.is_empty()
        || url
            .chars()
            .any(|ch| ch.is_control() || ch == '"' || ch == '<' || ch == '>')
    {
        return Err(office("Alkuin won't export that link."));
    }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")
    {
        return Ok(url.to_string());
    }
    if lower.contains(':')
        || url.starts_with("//")
        || url.starts_with('/')
        || url.starts_with('\\')
        || url.split(['/', '\\']).any(|part| part == "..")
    {
        return Err(office("Alkuin won't export that link."));
    }
    Ok(url.to_string())
}

fn opener(rest: &str, style: Style) -> Option<(&str, Style)> {
    if rest.starts_with("~~") {
        return Some((
            "~~",
            Style {
                strike: true,
                ..style
            },
        ));
    }
    if rest.starts_with("***") {
        return Some((
            "***",
            Style {
                bold: true,
                italic: true,
                ..style
            },
        ));
    }
    if rest.starts_with("**") {
        return Some((
            "**",
            Style {
                bold: true,
                ..style
            },
        ));
    }
    if rest.starts_with('*') {
        return Some((
            "*",
            Style {
                italic: true,
                ..style
            },
        ));
    }
    None
}

fn find_marker(hay: &str, marker: &str) -> Option<usize> {
    let bytes = hay.as_bytes();
    let mark = marker.as_bytes();
    let width = mark.len();
    let lead = mark[0];
    let mut index = 0;
    while index + width <= bytes.len() {
        if bytes[index] == lead && hay.is_char_boundary(index) && hay[index..].starts_with(marker) {
            let mut run = 0;
            while index + run < bytes.len() && bytes[index + run] == lead {
                run += 1;
            }
            if run == width {
                return Some(index);
            }
            index += run;
            continue;
        }
        index += 1;
    }
    None
}

fn host_allowed(host: &str) -> bool {
    if host == "docs.google.com"
        || host == "drive.google.com"
        || host == "googleusercontent.com"
        || host.ends_with(".googleusercontent.com")
    {
        return true;
    }
    #[cfg(test)]
    if host == "127.0.0.1" {
        return true;
    }
    false
}

async fn fetch_docx(url: &str, max_bytes: usize) -> Result<Vec<u8>, AppError> {
    let parsed = reqwest::Url::parse(url).map_err(|_| office(GOOGLE_FAILED))?;
    if !host_allowed(parsed.host_str().unwrap_or("")) {
        return Err(office(GOOGLE_FAILED));
    }
    let client = http_client()?;
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|_| office(GOOGLE_FAILED))?;
    read_limited(response, max_bytes).await
}

fn http_client() -> Result<reqwest::Client, AppError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .use_rustls_tls()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            match attempt.url().host_str() {
                Some(host) if host_allowed(host) => attempt.follow(),
                _ => attempt.error(std::io::Error::other("google-sign-in")),
            }
        }))
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("Alkuin")
        .build()
        .map_err(|_| office(GOOGLE_FAILED))
}

async fn read_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, AppError> {
    if let Some(len) = response.content_length() {
        if len > max_bytes as u64 {
            return Err(office(GOOGLE_TOO_BIG));
        }
    }
    if !response.status().is_success() {
        return Err(office(GOOGLE_FAILED));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.contains("text/html") || content_type.starts_with("text/plain") {
        return Err(office(GOOGLE_FAILED));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| office(GOOGLE_FAILED))? {
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(office(GOOGLE_TOO_BIG));
        }
        body.extend_from_slice(&chunk);
    }
    if !is_zip(&body) {
        return Err(office(GOOGLE_FAILED));
    }
    Ok(body)
}

/// Pictures decoded for one export. The same file, including a path that
/// only differs by `/` and `\`, is decoded once. `pixels` is the running total.
pub(crate) struct ImageStore {
    pub images: Vec<LocalImage>,
    by_src: HashMap<String, usize>,
    by_file: HashMap<(u64, u64), usize>,
    pixels: u64,
    filter_bytes: u64,
}

impl ImageStore {
    pub(crate) fn new() -> Self {
        Self {
            images: Vec::new(),
            by_src: HashMap::new(),
            by_file: HashMap::new(),
            pixels: 0,
            filter_bytes: 0,
        }
    }

    /// The index of `src` in `images`. A repeated spelling does no file I/O.
    /// `/` and `\` are the same key. A hard link of a file already decoded is
    /// not decoded again.
    pub(crate) fn intern(&mut self, note_path: &str, src: &str) -> Result<usize, AppError> {
        let key = src.trim().split(['/', '\\']).collect::<Vec<_>>().join("/");
        if let Some(index) = self.by_src.get(&key).copied() {
            return Ok(index);
        }
        let opened = open_picture(note_path, &key)?;
        if let Some(index) = self.by_file.get(&(opened.dev, opened.ino)).copied() {
            self.by_src.insert(key, index);
            return Ok(index);
        }
        let mut scratch = 0;
        if opened.svg {
            let (pixels, bytes) = svg_pixel_count(&opened.bytes)?;
            scratch = bytes;
            if self.pixels.saturating_add(pixels) > MAX_IMAGE_PIXELS_TOTAL
                || self.filter_bytes.saturating_add(scratch) > MAX_FILTER_BYTES_TOTAL
            {
                return Err(office("Those pictures are too large to export together."));
            }
        }
        let file_id = (opened.dev, opened.ino);
        let image = decode_picture(opened)?;
        let pixels = u64::from(image.width) * u64::from(image.height);
        if self.pixels.saturating_add(pixels) > MAX_IMAGE_PIXELS_TOTAL {
            return Err(office("Those pictures are too large to export together."));
        }
        self.pixels += pixels;
        self.filter_bytes += scratch;
        let index = self.images.len();
        self.by_src.insert(key, index);
        self.by_file.insert(file_id, index);
        self.images.push(image);
        Ok(index)
    }
}

pub(crate) struct LocalImage {
    pub bytes: Vec<u8>,
    pub jpeg: bool,
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 4_000_000;
const MAX_IMAGE_PIXELS_TOTAL: u64 = 32_000_000;
/// One SVG. resvg 0.45 keeps every primitive result until that filter returns.
const MAX_FILTER_BYTES: u64 = 32 * 1024 * 1024;
/// Every SVG in one export, added together. The allocator is not asked to reuse.
const MAX_FILTER_BYTES_TOTAL: u64 = 64 * 1024 * 1024;
/// feConvolveMatrix order. Above this the inner loop is pixels × kernel.
const MAX_CONVOLVE_TAPS: u32 = 25;

/// A picture that sits beside the note. Web addresses are refused, and the
/// file has to stay inside the note's folder after `..` is resolved.
pub(crate) fn load_local_image(note_path: &str, src: &str) -> Result<LocalImage, AppError> {
    decode_picture(open_picture(note_path, src)?)
}

struct OpenedPicture {
    bytes: Vec<u8>,
    dev: u64,
    ino: u64,
    svg: bool,
}

fn open_picture(note_path: &str, src: &str) -> Result<OpenedPicture, AppError> {
    let src = src.trim();
    if src.is_empty() {
        return Err(office("Alkuin couldn't find that image."));
    }
    let lower = src.to_ascii_lowercase();
    if lower.contains("://") || src.starts_with("//") {
        return Err(office(
            "Alkuin doesn't download images. Save the picture beside the note.",
        ));
    }
    if src.starts_with('/')
        || src.starts_with('\\')
        || src.chars().any(|ch| ch.is_control())
        || src
            .split(['/', '\\'])
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(office("That image has to sit beside the note."));
    }
    let ext = src.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let svg = ext == "svg";
    if !svg && !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
        return Err(office("Alkuin can't put that image in the file."));
    }
    if note_path.trim().is_empty() {
        return Err(office("Alkuin couldn't find that image."));
    }
    let note = Path::new(note_path);
    let Some(dir) = note
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    else {
        return Err(office("Alkuin couldn't find that image."));
    };
    let (bytes, dev, ino) = read_beside(dir, src)?;
    Ok(OpenedPicture {
        bytes,
        dev,
        ino,
        svg,
    })
}

fn decode_picture(opened: OpenedPicture) -> Result<LocalImage, AppError> {
    if opened.svg {
        return rasterize_svg(&opened.bytes);
    }
    decode_raster(opened.bytes)
}

fn decode_raster(file_bytes: Vec<u8>) -> Result<LocalImage, AppError> {
    let (width, height) = image::ImageReader::new(Cursor::new(file_bytes.as_slice()))
        .with_guessed_format()
        .map_err(|_| office("Alkuin couldn't read that image."))?
        .into_dimensions()
        .map_err(|_| office("Alkuin couldn't read that image."))?;
    if width == 0
        || height == 0
        || u64::from(width).saturating_mul(u64::from(height)) > MAX_IMAGE_PIXELS
    {
        return Err(office("That image is too large to export."));
    }
    let img = image::load_from_memory(&file_bytes)
        .map_err(|_| office("Alkuin couldn't read that image."))?;
    let (width, height) = img.dimensions();
    if width == 0
        || height == 0
        || u64::from(width).saturating_mul(u64::from(height)) > MAX_IMAGE_PIXELS
    {
        return Err(office("That image is too large to export."));
    }
    let rgb = flatten_white(&img);
    let jpeg = file_bytes.starts_with(&[0xFF, 0xD8, 0xFF]);
    let bytes = if jpeg {
        file_bytes
    } else {
        let mut buf = Vec::new();
        img.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
            .map_err(|_| office("Alkuin couldn't read that image."))?;
        buf
    };
    Ok(LocalImage {
        bytes,
        jpeg,
        width,
        height,
        rgb,
    })
}

/// Pixel count and filter scratch of an SVG, before a pixmap is allocated.
fn svg_pixel_count(bytes: &[u8]) -> Result<(u64, u64), AppError> {
    let (width, height, scratch) = svg_size(bytes)?;
    Ok((u64::from(width) * u64::from(height), scratch))
}

fn svg_size(bytes: &[u8]) -> Result<(u32, u32, u64), AppError> {
    let tree = svg_tree(bytes)?;
    let width = tree.size().width();
    let height = tree.size().height();
    if !width.is_finite() || !height.is_finite() || width < 1.0 || height < 1.0 {
        return Err(office("Alkuin couldn't read that image."));
    }
    if width > u32::MAX as f32 || height > u32::MAX as f32 {
        return Err(office("That image is too large to export."));
    }
    let width = width.ceil() as u32;
    let height = height.ceil() as u32;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err(office("That image is too large to export."));
    }
    let scratch = svg_filter_scratch(&tree)?;
    Ok((width, height, scratch))
}

fn canvas_pixels(rect: resvg::usvg::NonZeroRect) -> Result<u64, AppError> {
    let width = rect.width();
    let height = rect.height();
    if !width.is_finite() || !height.is_finite() {
        return Err(office("That image is too large to export."));
    }
    let pixels = (width.ceil() as u64).saturating_mul(height.ceil() as u64);
    if pixels > MAX_IMAGE_PIXELS {
        return Err(office("That image is too large to export."));
    }
    Ok(pixels)
}

/// Bytes resvg 0.45.1 allocates for one filter, from `filter/mod.rs`:
/// every primitive result is a pixmap of the filter region (4 bytes per pixel)
/// and `results` keeps them all until the filter returns. `SourceGraphic`
/// clones the source first. `feGaussianBlur` adds one `f64` per pixel
/// (`iir_blur.rs`). `feDropShadow` also holds an output pixmap and a shadow
/// copy beside that blur buffer. A convolution or morphology adds one RGBA
/// copy. Filters are summed, not maxed: the next filter starts only after the
/// previous returns, and this budget does not assume the allocator reuses it.
fn filter_scratch(
    group: &resvg::usvg::Group,
    filter: &resvg::usvg::filter::Filter,
) -> Result<u64, AppError> {
    let ts = group.abs_transform();
    let region = filter
        .rect()
        .transform(ts)
        .ok_or_else(|| office("That image is too large to export."))?;
    let pixels = canvas_pixels(region)?;
    let mut extra = 0u64;
    for primitive in filter.primitives() {
        match primitive.kind() {
            resvg::usvg::filter::Kind::ConvolveMatrix(matrix) => {
                let taps = matrix
                    .matrix()
                    .columns()
                    .saturating_mul(matrix.matrix().rows());
                if taps > MAX_CONVOLVE_TAPS {
                    return Err(office("Alkuin can't export that filter."));
                }
                extra = extra.max(pixels.saturating_mul(4));
            }
            resvg::usvg::filter::Kind::Morphology(_) => extra = extra.max(pixels.saturating_mul(4)),
            resvg::usvg::filter::Kind::GaussianBlur(_) => {
                extra = extra.max(pixels.saturating_mul(8));
            }
            resvg::usvg::filter::Kind::DropShadow(_) => {
                extra = extra.max(pixels.saturating_mul(16));
            }
            _ => {}
        }
    }
    let kept = pixels
        .saturating_mul(4)
        .saturating_mul((filter.primitives().len() as u64).saturating_add(1));
    Ok(kept.saturating_add(extra))
}

fn svg_filter_scratch(tree: &resvg::usvg::Tree) -> Result<u64, AppError> {
    fn walk(group: &resvg::usvg::Group) -> Result<u64, AppError> {
        canvas_pixels(group.abs_layer_bounding_box())?;
        let mut total = 0u64;
        for filter in group.filters() {
            total = total.saturating_add(filter_scratch(group, filter)?);
        }
        if let Some(clip) = group.clip_path() {
            total = total.saturating_add(walk(clip.root())?);
        }
        if let Some(mask) = group.mask() {
            total = total.saturating_add(walk(mask.root())?);
        }
        for child in group.children() {
            if let resvg::usvg::Node::Group(child) = child {
                total = total.saturating_add(walk(child)?);
            }
        }
        Ok(total)
    }
    let total = walk(tree.root())?;
    if total > MAX_FILTER_BYTES {
        return Err(office("That image is too large to export."));
    }
    Ok(total)
}

fn rasterize_svg(bytes: &[u8]) -> Result<LocalImage, AppError> {
    let (width, height, _) = svg_size(bytes)?;
    let tree = svg_tree(bytes)?;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| office("That image is too large to export."))?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::default(),
        &mut pixmap.as_mut(),
    );
    let mut pixels = pixmap.take();
    straight_rgba(&mut pixels);
    let rgba = image::RgbaImage::from_raw(width, height, pixels)
        .ok_or_else(|| office("Alkuin couldn't read that image."))?;
    let img = image::DynamicImage::ImageRgba8(rgba);
    let rgb = flatten_white(&img);
    let mut png = Vec::new();
    img.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|_| office("Alkuin couldn't read that image."))?;
    Ok(LocalImage {
        bytes: png,
        jpeg: false,
        width,
        height,
        rgb,
    })
}

/// resvg's pixmap is premultiplied. PNG and the white flatten expect straight alpha.
fn straight_rgba(pixels: &mut [u8]) {
    for pixel in pixels.chunks_exact_mut(4) {
        let alpha = pixel[3];
        if alpha == 0 {
            pixel[0] = 0;
            pixel[1] = 0;
            pixel[2] = 0;
        } else if alpha != 255 {
            let scale = f64::from(alpha) / 255.0;
            for channel in &mut pixel[..3] {
                *channel = (f64::from(*channel) / scale + 0.5) as u8;
            }
        }
    }
}

/// Parse an SVG with no file, network, or system-font lookup.
fn svg_tree(bytes: &[u8]) -> Result<resvg::usvg::Tree, AppError> {
    let mut opt = resvg::usvg::Options::default();
    opt.resources_dir = None;
    opt.font_family = "Newsreader".to_string();
    opt.fontdb = svg_fonts();
    opt.image_href_resolver.resolve_string = Box::new(|_, _| None);
    opt.image_href_resolver.resolve_data = Box::new(|mime, data, opts| {
        if data.len() as u64 > MAX_IMAGE_BYTES {
            return None;
        }
        let counted = image::ImageReader::new(Cursor::new(data.as_ref()))
            .with_guessed_format()
            .ok()
            .and_then(|reader| reader.into_dimensions().ok());
        let Some((width, height)) = counted else {
            return None;
        };
        if u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
            return None;
        }
        (resvg::usvg::ImageHrefResolver::default_data_resolver())(mime, data, opts)
    });
    resvg::usvg::Tree::from_data(bytes, &opt)
        .map_err(|_| office("Alkuin couldn't read that image."))
}

fn svg_fonts() -> std::sync::Arc<fontdb::Database> {
    static DB: std::sync::OnceLock<std::sync::Arc<fontdb::Database>> = std::sync::OnceLock::new();
    DB.get_or_init(|| {
        let mut db = fontdb::Database::new();
        db.load_font_data(super::fallback_font::NEWSREADER.to_vec());
        db.load_font_data(super::fallback_font::DROID.to_vec());
        db.load_font_data(super::fallback_font::EMOJI.to_vec());
        db.set_serif_family("Newsreader");
        db.set_sans_serif_family("Newsreader");
        db.set_cursive_family("Newsreader");
        db.set_fantasy_family("Newsreader");
        db.set_monospace_family("Newsreader");
        std::sync::Arc::new(db)
    })
    .clone()
}

/// Read `rel` from the note's folder. Each path step is opened from the
/// directory handle with `O_NOFOLLOW`, and the bytes come from that file
/// handle. A symlink swapped in after a path check cannot be followed.
/// shortcut: a symlink is refused, even when its target sits in the folder.
/// Upgrade path: open the link, then check that handle's path before reading.
fn read_beside(dir: &Path, rel: &str) -> Result<(Vec<u8>, u64, u64), AppError> {
    #[cfg(unix)]
    {
        read_beside_unix(dir, rel)
    }
    #[cfg(not(unix))]
    {
        let _ = (dir, rel);
        Err(office("Alkuin couldn't read that image."))
    }
}

#[cfg(unix)]
fn read_beside_unix(dir: &Path, rel: &str) -> Result<(Vec<u8>, u64, u64), AppError> {
    use std::ffi::{c_char, CString};
    use std::os::fd::{AsRawFd, FromRawFd};

    const AT_FDCWD: i32 = -100;
    const O_RDONLY: i32 = 0;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const O_NOFOLLOW: i32 = 0x20000;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const O_CLOEXEC: i32 = 0x80000;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const O_DIRECTORY: i32 = 0x10000;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const O_NONBLOCK: i32 = 0x800;
    #[cfg(target_os = "macos")]
    const O_NOFOLLOW: i32 = 0x100;
    #[cfg(target_os = "macos")]
    const O_CLOEXEC: i32 = 0x1000000;
    #[cfg(target_os = "macos")]
    const O_DIRECTORY: i32 = 0x100000;
    #[cfg(target_os = "macos")]
    const O_NONBLOCK: i32 = 0x4;
    #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
    compile_error!("image export needs O_NOFOLLOW constants for this unix");

    extern "C" {
        fn openat(dirfd: i32, pathname: *const c_char, flags: i32) -> i32;
    }

    fn open_at(dirfd: i32, name: &str, flags: i32) -> Result<fs::File, std::io::Error> {
        let c_name = CString::new(name)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "nul in path"))?;
        let fd = unsafe { openat(dirfd, c_name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(unsafe { fs::File::from_raw_fd(fd) })
    }

    fn is_symlink_error(err: &std::io::Error) -> bool {
        // Linux ELOOP is 40. macOS ELOOP is 62. O_NOFOLLOW returns ELOOP.
        matches!(err.raw_os_error(), Some(40 | 62))
    }

    let dir_name = dir
        .to_str()
        .ok_or_else(|| office("Alkuin couldn't find that image."))?;
    let mut current = open_at(AT_FDCWD, dir_name, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        .map_err(|_| office("Alkuin couldn't find that image."))?;
    let parts: Vec<&str> = rel.split(['/', '\\']).collect();
    for (index, part) in parts.iter().enumerate() {
        let last = index + 1 == parts.len();
        let mut flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW;
        if last {
            // A FIFO would block a plain read open. Non-blocking open, then
            // keep only a regular file from this same handle.
            flags |= O_NONBLOCK;
        } else {
            flags |= O_DIRECTORY;
        }
        let next = match open_at(current.as_raw_fd(), part, flags) {
            Ok(file) => file,
            Err(err) if is_symlink_error(&err) => {
                return Err(office("That image has to sit beside the note."));
            }
            Err(_) => return Err(office("Alkuin couldn't find that image.")),
        };
        let meta = next
            .metadata()
            .map_err(|_| office("Alkuin couldn't read that image."))?;
        if last {
            if !meta.is_file() {
                return Err(office("Alkuin couldn't find that image."));
            }
            if meta.len() > MAX_IMAGE_BYTES {
                return Err(office("That image is too large to export."));
            }
            let mut limited = next.take(MAX_IMAGE_BYTES + 1);
            let mut bytes = Vec::new();
            limited
                .read_to_end(&mut bytes)
                .map_err(|_| office("Alkuin couldn't read that image."))?;
            if bytes.len() as u64 > MAX_IMAGE_BYTES {
                return Err(office("That image is too large to export."));
            }
            use std::os::unix::fs::MetadataExt;
            return Ok((bytes, meta.dev(), meta.ino()));
        }
        if !meta.is_dir() {
            return Err(office("Alkuin couldn't find that image."));
        }
        current = next;
    }
    Err(office("Alkuin couldn't find that image."))
}

fn flatten_white(img: &image::DynamicImage) -> Vec<u8> {
    let rgba = img.to_rgba8();
    let mut out = Vec::with_capacity(rgba.pixels().len() * 3);
    for pixel in rgba.pixels() {
        let alpha = u32::from(pixel[3]);
        let blend = |channel: u8| -> u8 {
            ((u32::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
        };
        out.push(blend(pixel[0]));
        out.push(blend(pixel[1]));
        out.push(blend(pixel[2]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    const SAMPLE: &str = "# Harbor\n\nThe dock is **long** and *quiet* and ~~closed~~.\n\n## Notes\n\n- Tide at dawn\n- Wind at dusk\n";

    fn word_xml() -> String {
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Harbor</w:t></w:r></w:p>
    <w:p>
      <w:r><w:t>The dock is </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>long</w:t></w:r>
      <w:r><w:t> and </w:t></w:r>
      <w:r><w:rPr><w:i/></w:rPr><w:t>quiet</w:t></w:r>
      <w:r><w:t>.</w:t></w:r>
    </w:p>
    <w:p><w:r><w:rPr><w:b w:val="false"/></w:rPr><w:t>plain</w:t></w:r></w:p>
    <w:p><w:del><w:r><w:t>gone</w:t></w:r></w:del><w:r><w:t>kept</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading 2"/></w:pPr><w:r><w:t>Notes</w:t></w:r></w:p>
    <w:p>
      <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>Tide at dawn</w:t></w:r>
    </w:p>
    <w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr><w:r><w:t>Hold the line.</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>"#
            .to_string()
    }

    fn zip_xml(xml: &str, method: CompressionMethod) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut cursor);
            let options = SimpleFileOptions::default().compression_method(method);
            zip.start_file("word/document.xml", options).unwrap();
            zip.write_all(xml.as_bytes()).unwrap();
            zip.finish().unwrap();
        }
        cursor.into_inner()
    }

    #[test]
    fn a_docx_whose_document_lies_about_its_size_is_refused() {
        let xml = "a".repeat(MAX_DOCX_BYTES + 1024);
        let mut bytes = zip_xml(&xml, CompressionMethod::Deflated);
        // Declare an uncompressed size of 1 in the local and central headers.
        let patch = |bytes: &mut Vec<u8>, sig: [u8; 4], offset: usize| {
            let at = bytes
                .windows(4)
                .position(|w| w == sig)
                .expect("header signature present");
            bytes[at + offset..at + offset + 4].copy_from_slice(&1u32.to_le_bytes());
        };
        patch(&mut bytes, 0x04034b50u32.to_le_bytes(), 22);
        patch(&mut bytes, 0x02014b50u32.to_le_bytes(), 24);
        // Either the reader stops at the cap (WORD_TOO_BIG) or the zip crate
        // rejects the mismatch while reading (WORD_UNREADABLE).
        let err = markdown_from_docx(&bytes, WORD_EMPTY).unwrap_err();
        let message = format!("{err:?}");
        assert!(
            message.contains(WORD_TOO_BIG) || message.contains(WORD_UNREADABLE),
            "unexpected error: {message}"
        );
    }

    #[test]
    fn round_trip_keeps_headings_paragraphs_and_marks() {
        let docx = markdown_to_docx("Harbor", SAMPLE, "").unwrap();
        let xml = document_xml_from_zip(&docx).unwrap();
        assert!(xml.contains("Heading1"));
        assert!(xml.contains("Heading2"));
        assert!(xml.contains("<w:b/>"));
        assert!(xml.contains("<w:i/>"));
        assert!(xml.contains("<w:strike/>"));
        assert!(xml.contains(">long<"));
        assert!(!xml.contains("frontmatter"));
        let back = markdown_from_docx(&docx, WORD_EMPTY).unwrap();
        assert!(back.starts_with("# Harbor\n"));
        assert_eq!(back.matches("# Harbor").count(), 1);
        assert!(back.contains("The dock is **long** and *quiet* and ~~closed~~."));
        assert!(back.contains("## Notes"));
        assert!(back.contains("- Tide at dawn\n- Wind at dusk\n"));
    }

    fn texts(body: &str) -> Vec<String> {
        markdown_blocks(body)
            .unwrap()
            .into_iter()
            .map(|block| match block {
                MdBlock::Text { text, .. } => text,
                MdBlock::Heading { level, text } => format!("h{level}:{text}"),
                MdBlock::Table { rows } => format!("table:{}", rows.len()),
                MdBlock::Image { alt, src } => format!("img:{alt}:{src}"),
            })
            .collect()
    }

    #[test]
    fn a_long_list_is_split_once_per_line_without_rescanning() {
        let mut body = String::new();
        for n in 0..400 {
            body.push_str(&format!("- item {n}\n"));
        }
        body.push_str("\nNot a list.\n");
        let blocks = texts(&body);
        assert_eq!(blocks.len(), 401);
        assert_eq!(blocks[0], "- item 0");
        assert_eq!(blocks[399], "- item 399");
        assert_eq!(blocks[400], "Not a list.");
        assert_eq!(
            texts("- item\n  more\n> next\n"),
            vec!["- item more", "> next"]
        );
        assert_eq!(texts("Prose\n- item\n"), vec!["Prose", "- item"]);
        assert_eq!(texts("> quote\n- item\n"), vec!["> quote", "- item"]);
    }

    #[test]
    fn a_raster_wider_than_the_pixel_budget_is_refused_before_decode() {
        // IHDR says 100000×100000 and an empty IDAT follows, so the header can be read
        // without allocating the pixmap. Decoding that pixmap is the bug.
        let huge = hex_png("89504e470d0a1a0a0000000d49484452000186a0000186a0080200000027309c9f000000004944415435af061e0000000049454e44ae426082");
        let Err(err) = decode_raster(huge) else {
            panic!("a huge header was decoded");
        };
        assert!(err.to_string().contains("too large"), "{err}");
        let mut pixels = Vec::new();
        image::DynamicImage::ImageRgb8(image::RgbImage::from_raw(1, 1, vec![9, 8, 7]).unwrap())
            .write_to(&mut Cursor::new(&mut pixels), image::ImageFormat::Png)
            .unwrap();
        let image = decode_raster(pixels).unwrap();
        assert_eq!((image.width, image.height), (1, 1));
    }

    fn hex_png(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn wrapped_lines_stay_one_paragraph() {
        let back = markdown_from_docx(
            &markdown_to_docx("", "The dock\nis long.\n", "").unwrap(),
            WORD_EMPTY,
        )
        .unwrap();
        assert!(back.contains("The dock is long."));
        assert!(!back.contains("The dock\n"));
    }

    #[test]
    fn word_package_reads_headings_marks_lists_and_skips_deletions() {
        let docx = zip_xml(&word_xml(), CompressionMethod::Deflated);
        let back = markdown_from_docx(&docx, WORD_EMPTY).unwrap();
        assert!(back.starts_with("# Harbor\n"));
        assert!(back.contains("The dock is **long** and *quiet*."));
        assert!(back.contains("plain"));
        assert!(!back.contains("**plain**"));
        assert!(back.contains("kept"));
        assert!(!back.contains("gone"));
        assert!(back.contains("## Notes"));
        assert!(back.contains("- Tide at dawn"));
        assert!(back.contains("> Hold the line."));
    }

    #[test]
    fn literal_asterisk_and_code_do_not_become_bold() {
        let docx = markdown_to_docx("", "2 \\* 3 and `a **b**`.\n", "").unwrap();
        let xml = document_xml_from_zip(&docx).unwrap();
        assert!(!xml.contains("<w:b/>"));
        assert!(xml.contains("2 * 3"));
        assert!(xml.contains("`a **b**`"));
    }

    #[test]
    fn empty_and_markdown_paths_are_refused() {
        let err = markdown_from_docx(
            &zip_xml("<w:document></w:document>", CompressionMethod::Stored),
            WORD_EMPTY,
        );
        assert!(err.unwrap_err().to_string().contains("no text"));
        let dir = tempfile::tempdir().unwrap();
        let md = dir.path().join("note.md");
        let err = write_docx_file(md.to_str().unwrap(), "T", "Body", "").unwrap_err();
        assert!(err.to_string().contains(".docx"));
        assert!(!md.exists());
        let docx = dir.path().join("note.docx");
        write_docx_file(
            docx.to_str().unwrap(),
            "Harbor",
            "The dock is **long**.\n",
            "",
        )
        .unwrap();
        let back = markdown_from_docx(&fs::read(&docx).unwrap(), WORD_EMPTY).unwrap();
        assert!(back.contains("# Harbor"));
        assert!(back.contains("**long**"));
    }

    #[test]
    fn google_ids_come_only_from_docs_links() {
        let id = "1aBcDeFgHiJkLmNoPqRs";
        assert_eq!(
            google_document_id(&format!(
                "https://docs.google.com/document/d/{id}/edit?usp=sharing"
            ))
            .unwrap(),
            id
        );
        assert_eq!(
            google_document_id(&format!("http://docs.google.com/document/u/0/d/{id}/edit"))
                .unwrap(),
            id
        );
        assert_eq!(
            google_document_id(&format!("docs.google.com/document/d/{id}")).unwrap(),
            id
        );
        assert!(google_document_id("")
            .unwrap_err()
            .to_string()
            .contains("Paste"));
        assert!(
            google_document_id("https://docs.google.com/spreadsheets/d/1aBcDeFgHiJkLmNoPqRs")
                .is_err()
        );
        assert!(
            google_document_id("https://drive.google.com/file/d/1aBcDeFgHiJkLmNoPqRs").is_err()
        );
        assert!(google_document_id("https://example.com/document/d/1aBcDeFgHiJkLmNoPqRs").is_err());
        assert!(
            google_document_id("javascript:docs.google.com/document/d/1aBcDeFgHiJkLmNoPqRs")
                .is_err()
        );
    }

    fn serve(status: &str, headers: &str, body: &[u8]) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let status = status.to_string();
        let headers = headers.to_string();
        let body = body.to_vec();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
            let mut buf = [0u8; 1];
            let mut seen = Vec::new();
            while stream.read(&mut buf).ok() == Some(1) {
                seen.push(buf[0]);
                if seen.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let head = format!(
                "HTTP/1.1 {status}\r\n{headers}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&body);
        });
        format!("http://127.0.0.1:{port}/export?format=docx")
    }

    #[test]
    fn google_download_accepts_a_word_body_and_refuses_html_and_a_redirect() {
        let docx = zip_xml(&word_xml(), CompressionMethod::Stored);
        let url = serve(
            "200 OK",
            "Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            &docx,
        );
        let bytes = tauri::async_runtime::block_on(fetch_docx(&url, MAX_DOCX_BYTES)).unwrap();
        let back = markdown_from_docx(&bytes, GOOGLE_EMPTY).unwrap();
        assert!(back.contains("**long**"));

        let html = serve(
            "200 OK",
            "Content-Type: text/html; charset=utf-8",
            b"<html>sign in</html>",
        );
        let err = tauri::async_runtime::block_on(fetch_docx(&html, MAX_DOCX_BYTES)).unwrap_err();
        assert!(err.to_string().contains("anyone with the link"));

        let redirect = serve("302 Found", "Location: http://example.invalid/secret", b"");
        let err = tauri::async_runtime::block_on(fetch_docx(&redirect, 64)).unwrap_err();
        assert!(err.to_string().contains("anyone with the link"));

        let huge = serve(
            "200 OK",
            "Content-Type: application/octet-stream",
            b"PK\x03\x04too-big",
        );
        let err = tauri::async_runtime::block_on(fetch_docx(&huge, 4)).unwrap_err();
        assert!(err.to_string().contains("too large"));
    }

    fn zip_names(bytes: &[u8]) -> Vec<String> {
        let archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        (0..archive.len())
            .map(|index| archive.name_for_index(index).unwrap_or("").to_string())
            .collect()
    }

    fn rels_xml(bytes: &[u8]) -> String {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut file = archive.by_name("word/_rels/document.xml.rels").unwrap();
        let mut buf = String::new();
        file.read_to_string(&mut buf).unwrap();
        buf
    }

    #[test]
    fn links_are_hyperlinks_and_unsafe_schemes_are_refused() {
        let docx = markdown_to_docx(
            "",
            "See [the book](https://example.com/harbor) and <https://example.com/tide>.\n",
            "",
        )
        .unwrap();
        let xml = document_xml_from_zip(&docx).unwrap();
        assert!(xml.contains("rIdL1"));
        assert!(xml.contains(">the book<"));
        assert!(!xml.contains("](https://example.com/harbor)"));
        let rels = rels_xml(&docx);
        assert!(rels.contains("https://example.com/harbor"));
        assert!(rels.contains("https://example.com/tide"));
        assert!(rels.contains("TargetMode=\"External\""));
        let paren = "https://example.com/wiki/Rust_(programming_language)";
        let docx = markdown_to_docx("", &format!("See [Rust]({paren}).\n"), "").unwrap();
        let rels = rels_xml(&docx);
        assert!(rels.contains(paren));
        assert!(!rels.contains("Rust_(programming_language\""));
        let err = markdown_to_docx("", "[x](javascript:alert(1))\n", "").unwrap_err();
        assert!(err.to_string().contains("won't export"));
        let err = markdown_to_docx("", "[x](../../etc/passwd)\n", "").unwrap_err();
        assert!(err.to_string().contains("won't export"));
    }

    #[test]
    fn tables_keep_cells_in_reading_order() {
        let body = "| Watch | Tide |\n| --- | --- |\n| Dawn | High |\n| Dusk | **Low** |\n";
        let xml = document_xml_from_zip(&markdown_to_docx("", body, "").unwrap()).unwrap();
        let dawn = xml.find(">Dawn<").unwrap();
        let high = xml.find(">High<").unwrap();
        let dusk = xml.find(">Dusk<").unwrap();
        let low = xml.find(">Low<").unwrap();
        assert!(xml.contains("<w:tbl>"));
        assert!(dawn < high && high < dusk && dusk < low);
        assert!(xml.contains("<w:b/>"));
        assert_eq!(xml.matches("<w:tc>").count(), 6);
        let dashed = "| A | B |\n| --- | --- |\n| - | - |\n| x | y |\n";
        let xml = document_xml_from_zip(&markdown_to_docx("", dashed, "").unwrap()).unwrap();
        assert_eq!(xml.matches("<w:tc>").count(), 6);
        assert!(xml.contains(">-<"));
        assert!(xml.contains(">x<"));
    }

    #[test]
    fn a_picture_beside_the_note_is_embedded_and_others_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("note.md");
        let png = dir.path().join("pier.png");
        image::RgbImage::from_pixel(2, 2, image::Rgb([20, 90, 180]))
            .save(&png)
            .unwrap();
        let docx =
            markdown_to_docx("", "![Pier at dusk](pier.png)\n", note.to_str().unwrap()).unwrap();
        let names = zip_names(&docx);
        assert!(names.iter().any(|name| name == "word/media/image1.png"));
        let xml = document_xml_from_zip(&docx).unwrap();
        assert!(xml.contains("rIdI1"));
        assert!(xml.contains("Pier at dusk"));
        let err = markdown_to_docx(
            "",
            "![x](https://example.com/a.png)\n",
            note.to_str().unwrap(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("doesn't download"));
        let err = markdown_to_docx("", "![x](../pier.png)\n", note.to_str().unwrap()).unwrap_err();
        assert!(err.to_string().contains("beside the note"));
        let err = markdown_to_docx("", "![x](missing.png)\n", note.to_str().unwrap()).unwrap_err();
        assert!(err.to_string().contains("couldn't find"));

        let spaced = dir.path().join("my file.png");
        image::RgbImage::from_pixel(2, 2, image::Rgb([4, 5, 6]))
            .save(&spaced)
            .unwrap();
        let docx = markdown_to_docx(
            "",
            "![Pier](<my file.png>)\n\n![Again](pier.png)\n\n![Third](pier.png)\n",
            note.to_str().unwrap(),
        )
        .unwrap();
        let names = zip_names(&docx);
        assert!(names.iter().any(|name| name == "word/media/image1.png"));
        assert_eq!(
            names
                .iter()
                .filter(|name| name.starts_with("word/media/"))
                .count(),
            2
        );
        let xml = document_xml_from_zip(&docx).unwrap();
        assert_eq!(xml.matches("<w:drawing>").count(), 3);
        assert!(xml.contains("Pier"));
    }

    #[test]
    fn a_separator_alias_is_one_picture() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("note.md");
        fs::write(&note, "").unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        image::RgbImage::from_pixel(2, 2, image::Rgb([1, 1, 1]))
            .save(sub.join("pic.png"))
            .unwrap();
        std::fs::hard_link(sub.join("pic.png"), dir.path().join("other.png")).unwrap();
        let docx = markdown_to_docx(
            "",
            "![A](sub/pic.png)\n\n![B](sub\\pic.png)\n\n![C](other.png)\n",
            note.to_str().unwrap(),
        )
        .unwrap();
        let names = zip_names(&docx);
        assert_eq!(
            names
                .iter()
                .filter(|name| name.starts_with("word/media/"))
                .count(),
            1
        );
        assert_eq!(
            document_xml_from_zip(&docx)
                .unwrap()
                .matches("<w:drawing>")
                .count(),
            3
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_swapped_symlink_is_not_embedded() {
        use std::os::unix::fs::symlink;
        use std::sync::atomic::{AtomicBool, Ordering};

        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let note = dir.path().join("note.md");
        fs::write(&note, "").unwrap();
        let secret = outside.path().join("secret.png");
        let safe = dir.path().join("safe.png");
        image::RgbImage::from_pixel(2, 2, image::Rgb([1, 2, 3]))
            .save(&secret)
            .unwrap();
        image::RgbImage::from_pixel(2, 2, image::Rgb([9, 8, 7]))
            .save(&safe)
            .unwrap();
        let pic = dir.path().join("pic.png");
        symlink(&secret, &pic).unwrap();
        match load_local_image(note.to_str().unwrap(), "pic.png") {
            Err(err) => assert!(err.to_string().contains("beside the note")),
            Ok(_) => panic!("a symlink was opened"),
        }
        symlink(&safe, dir.path().join("alias.png")).unwrap();
        assert!(load_local_image(note.to_str().unwrap(), "alias.png").is_err());

        let _ = fs::remove_file(&pic);
        fs::copy(&safe, &pic).unwrap();
        match load_local_image(note.to_str().unwrap(), "pic.png") {
            Ok(image) => assert!(image.rgb.chunks(3).all(|pixel| pixel == [9, 8, 7])),
            Err(err) => panic!("real file: {err}"),
        }

        let stop = AtomicBool::new(false);
        let pic_swap = pic.clone();
        let secret_swap = secret.clone();
        let safe_swap = safe.clone();
        let stop_flag = &stop;
        std::thread::scope(|scope| {
            scope.spawn(|| {
                while !stop_flag.load(Ordering::Relaxed) {
                    let _ = fs::remove_file(&pic_swap);
                    let _ = fs::copy(&safe_swap, &pic_swap);
                    std::thread::sleep(std::time::Duration::from_millis(2));
                    let _ = fs::remove_file(&pic_swap);
                    let _ = symlink(&secret_swap, &pic_swap);
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            });
            let mut opened = 0;
            let mut leaked = 0;
            for _ in 0..30 {
                match load_local_image(note.to_str().unwrap(), "pic.png") {
                    Ok(image) => {
                        opened += 1;
                        if image.rgb.chunks(3).any(|pixel| pixel == [1, 2, 3]) {
                            leaked += 1;
                        }
                    }
                    Err(_) => {}
                }
            }
            stop.store(true, Ordering::Relaxed);
            assert_eq!(leaked, 0);
            assert!(opened > 0, "the real file was never read during the swap");
        });
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_does_not_block_the_export() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("note.md");
        fs::write(&note, "").unwrap();
        let fifo = dir.path().join("pic.png");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let started = std::time::Instant::now();
        match load_local_image(note.to_str().unwrap(), "pic.png") {
            Err(err) => assert!(
                err.to_string().contains("couldn't find")
                    || err.to_string().contains("couldn't read")
            ),
            Ok(_) => panic!("a fifo was exported"),
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn footnote_syntax_stays_as_text_because_it_is_not_a_footnote() {
        let xml = document_xml_from_zip(
            &markdown_to_docx("", "A marker [^1].\n\n[^1]: The lamp note.\n", "").unwrap(),
        )
        .unwrap();
        assert!(xml.contains("[^1]"));
        assert!(xml.contains("The lamp note."));
        assert!(!xml.contains("footnoteReference"));
    }

    #[test]
    fn an_svg_is_a_picture_and_does_not_read_a_neighbor() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("note.md");
        fs::write(&note, "").unwrap();
        image::RgbImage::from_pixel(8, 8, image::Rgb([1, 2, 3]))
            .save(dir.path().join("secret.png"))
            .unwrap();
        fs::write(
            dir.path().join("mark.svg"),
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="220" height="48"><rect width="36" height="48" fill="#123456"/><text x="44" y="32" font-size="28" fill="#010101">SVG</text><text x="120" y="32" font-size="28" font-family="Papyrus" fill="#010101">AB</text><image href="secret.png" width="8" height="8"/><filter id="ext"><feImage href="secret.png"/></filter></svg>"##,
        )
        .unwrap();
        let docx = markdown_to_docx("", "![Mark](mark.svg)\n", note.to_str().unwrap()).unwrap();
        let names = zip_names(&docx);
        let media = names
            .iter()
            .find(|name| name.starts_with("word/media/"))
            .unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(&docx)).unwrap();
        let mut file = archive.by_name(media).unwrap();
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).unwrap();
        assert!(!buf.windows(3).any(|window| window == [1, 2, 3]));
        assert!(
            png_has_shape_and_latin(&buf),
            "svg latin text was not drawn"
        );
        fs::write(
            dir.path().join("half.svg"),
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#ff0000" opacity="0.5"/></svg>"##,
        )
        .unwrap();
        let half =
            media_png(&markdown_to_docx("", "![H](half.svg)\n", note.to_str().unwrap()).unwrap());
        let image = image::load_from_memory(&half).unwrap();
        let straight = image.to_rgba8().get_pixel(4, 4).0;
        assert!(
            straight[0] > 240 && straight[1] < 20 && straight[3] > 100 && straight[3] < 160,
            "{straight:?}"
        );
        let flat = flatten_white(&image);
        let i = (4 * 8 + 4) * 3;
        assert!(
            flat[i] > 240 && flat[i + 1] > 100 && flat[i + 1] < 160,
            "{flat:?}"
        );
        let pdf_path = dir.path().join("out.pdf");
        crate::pdf_export::export_pdf(
            pdf_path.to_str().unwrap().to_string(),
            String::new(),
            "![Mark](mark.svg)\n".to_string(),
            note.to_str().unwrap().to_string(),
        )
        .unwrap();
        let pdf = fs::read(&pdf_path).unwrap();
        assert!(pdf
            .windows(b"/Width 220".len())
            .any(|window| window == b"/Width 220"));
        assert!(pdf_rgb_has_shape_and_latin(&pdf));
        fs::write(
            dir.path().join("huge.svg"),
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"></svg>"#,
        )
        .unwrap();
        let err = markdown_to_docx("", "![H](huge.svg)\n", note.to_str().unwrap()).unwrap_err();
        assert!(err.to_string().contains("too large"));
        fs::write(
            dir.path().join("filter.svg"),
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><filter id="f" x="-50000" y="-50000" width="100000" height="100000"><feGaussianBlur stdDeviation="1"/></filter><rect width="10" height="10" filter="url(#f)"/></svg>"#,
        )
        .unwrap();
        let err = markdown_to_docx("", "![F](filter.svg)\n", note.to_str().unwrap()).unwrap_err();
        assert!(err.to_string().contains("too large"));
        let mut kernel = String::from("1");
        for _ in 1..256 {
            kernel.push_str(" 0");
        }
        fs::write(
            dir.path().join("kernel.svg"),
            format!(
                r#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><filter id="k"><feConvolveMatrix order="16" kernelMatrix="{kernel}"/></filter><rect width="16" height="16" filter="url(#k)"/></svg>"#
            ),
        )
        .unwrap();
        let err = markdown_to_docx("", "![K](kernel.svg)\n", note.to_str().unwrap()).unwrap_err();
        assert!(err.to_string().contains("filter"));
        let matrix =
            r#"<feColorMatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0"/>"#;
        let mut chain = String::new();
        for _ in 0..300 {
            chain.push_str(matrix);
        }
        fs::write(
            dir.path().join("chain.svg"),
            format!(
                r#"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><filter id="c">{chain}</filter><rect width="200" height="200" filter="url(#c)"/></svg>"#
            ),
        )
        .unwrap();
        let err = markdown_to_docx("", "![C](chain.svg)\n", note.to_str().unwrap()).unwrap_err();
        assert!(err.to_string().contains("too large"));
        fs::write(
            dir.path().join("soft.svg"),
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><filter id="b"><feGaussianBlur stdDeviation="2"/></filter><rect x="30" y="30" width="20" height="20" fill="#0000ff" filter="url(#b)"/></svg>"##,
        )
        .unwrap();
        let soft = markdown_to_docx("", "![S](soft.svg)\n", note.to_str().unwrap()).unwrap();
        let soft_png = media_png(&soft);
        assert!(blur_leaves_the_rect(&soft_png));
        // Each file is under the per-image cap. The third crosses the export total.
        let heavy = heavy_svg();
        fs::write(dir.path().join("h1.svg"), &heavy).unwrap();
        fs::write(dir.path().join("h2.svg"), &heavy).unwrap();
        fs::write(dir.path().join("h3.svg"), &heavy).unwrap();
        let err = markdown_to_docx(
            "",
            "![A](h1.svg)\n![B](h2.svg)\n![C](h3.svg)\n",
            note.to_str().unwrap(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("together"), "{}", err);
    }

    fn media_png(docx: &[u8]) -> Vec<u8> {
        let names = zip_names(docx);
        let media = names
            .iter()
            .find(|name| name.starts_with("word/media/"))
            .unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(docx)).unwrap();
        let mut file = archive.by_name(media).unwrap();
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).unwrap();
        buf
    }

    fn png_has_shape_and_latin(png: &[u8]) -> bool {
        let img = image::load_from_memory(png).unwrap().to_rgba8();
        let mut blue = 0;
        let mut ink = 0;
        for (x, _, pixel) in img.enumerate_pixels() {
            if pixel[3] > 200
                && pixel[0] < 0x30
                && pixel[1] > 0x28
                && pixel[1] < 0x48
                && pixel[2] > 0x48
                && pixel[2] < 0x70
            {
                blue += 1;
            }
            if x >= 40 && pixel[3] > 200 && pixel[0] < 40 && pixel[1] < 40 && pixel[2] < 40 {
                ink += 1;
            }
        }
        blue > 20 && ink > 30
    }

    fn pdf_rgb_has_shape_and_latin(pdf: &[u8]) -> bool {
        let marker = b"/Width 220 /Height 48";
        let start = pdf
            .windows(marker.len())
            .position(|window| window == marker);
        let Some(start) = start else {
            return false;
        };
        let stream = pdf[start..]
            .windows(7)
            .position(|window| window == b"stream\n");
        let Some(stream) = stream else {
            return false;
        };
        let data = &pdf[start + stream + 7..];
        let end = data.windows(10).position(|window| window == b"\nendstream");
        let Some(end) = end else {
            return false;
        };
        let mut decoder = flate2::read::ZlibDecoder::new(&data[..end]);
        let mut rgb = Vec::new();
        if decoder.read_to_end(&mut rgb).is_err() {
            return false;
        }
        let mut blue = 0;
        let mut ink = 0;
        for (index, pixel) in rgb.chunks_exact(3).enumerate() {
            let x = index % 220;
            if pixel[0] < 0x30
                && pixel[1] > 0x28
                && pixel[1] < 0x48
                && pixel[2] > 0x48
                && pixel[2] < 0x70
            {
                blue += 1;
            }
            if x >= 40 && pixel[0] < 80 && pixel[1] < 80 && pixel[2] < 80 {
                ink += 1;
            }
        }
        blue > 20 && ink > 30
    }

    fn blur_leaves_the_rect(png: &[u8]) -> bool {
        let img = image::load_from_memory(png).unwrap().to_rgba8();
        let outside = img.get_pixel(28, 40);
        let corner = img.get_pixel(2, 2);
        outside[2] > 20 && outside[3] > 20 && corner[3] < 10
    }

    /// Two flood primitives on a canvas whose scratch is under 32MB and over 20MB.
    fn heavy_svg() -> String {
        let matrix = r##"<feFlood flood-color="#123456"/><feFlood flood-color="#123456"/>"##;
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="1500"><filter id="h" filterUnits="userSpaceOnUse" x="0" y="0" width="1500" height="1500">{matrix}</filter><rect width="1500" height="1500" filter="url(#h)"/></svg>"#
        )
    }
}
