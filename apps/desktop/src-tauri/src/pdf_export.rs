//! Thin publisher PDF of the open document.
//!
//! Headings and paragraphs are set in the standard Times font on A4. The
//! editor passes the body it already split from the frontmatter.
//!
//! shortcut: Times draws WinAnsi. Other characters use the shipped outline
//! fonts, or the export stops. Upgrade path: subset the embedded font.
//! shortcut: a table stays as its source lines, one row per line. A picture
//! beside the note is drawn. Upgrade path: a real table grid.

use crate::error::AppError;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

const PAGE_W: i32 = 595;
const PAGE_H: i32 = 842;
const MARGIN_X: i32 = 72;
const MARGIN_Y: i32 = 64;
const CONTENT_W: i32 = PAGE_W - MARGIN_X * 2;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Face {
    Roman,
    Bold,
    Italic,
    BoldItalic,
    Courier,
    Droid,
    Emoji,
}

struct Style {
    face: Face,
    size: i32,
    leading: i32,
    gap: i32,
}

enum Block {
    Heading { level: u8, text: String },
    Paragraph(String),
    Pre(Vec<String>),
    Image { alt: String, index: usize },
}

#[derive(Clone)]
struct Run {
    face: Face,
    text: String,
    strike: bool,
    url: Option<u32>,
}

#[derive(Clone)]
struct Drawn {
    size: i32,
    x: i32,
    y: i32,
    runs: Vec<Run>,
}

#[derive(Clone, Copy)]
struct Fence {
    ch: u8,
    len: usize,
}

enum Marker {
    Bullet,
    Numbered(String),
}

struct Item {
    indent: usize,
    marker: Marker,
    text: String,
}

/// `path` is the file the save dialog returned. A markdown path is refused
/// so a PDF cannot replace the note it was exported from.
/// `note_path` is the note file, used only to find pictures that sit beside it.
#[tauri::command]
pub fn export_pdf(
    path: String,
    title: String,
    body: String,
    note_path: String,
) -> Result<(), AppError> {
    write_pdf_file(&path, &title, &body, &note_path)
}

fn markdown_to_pdf(title: &str, body: &str, note_path: &str) -> Result<Vec<u8>, AppError> {
    require_drawable(title)?;
    require_drawable(body)?;
    let (blocks, images) = document_blocks(title, body, note_path)?;
    let (pages, urls) = layout_blocks(&blocks, &images)?;
    render(&pages, &images, &urls)
}

fn write_pdf_file(path: &str, title: &str, body: &str, note_path: &str) -> Result<(), AppError> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidPath("missing path".into()));
    }
    if is_markdown_path(path) {
        return Err(AppError::InvalidPath(
            "refusing to replace a markdown file".into(),
        ));
    }
    let bytes = markdown_to_pdf(title, body, note_path)?;
    let file_path = Path::new(path);
    let dir = file_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temp_path = dir.join(format!(".~{}", uuid::Uuid::new_v4()));
    fs::write(&temp_path, &bytes)?;
    if let Err(err) = fs::rename(&temp_path, file_path) {
        let _ = fs::remove_file(&temp_path);
        return Err(err.into());
    }
    Ok(())
}

fn is_markdown_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
}

fn document_blocks(
    title: &str,
    body: &str,
    note_path: &str,
) -> Result<(Vec<Block>, Vec<super::office_exchange::LocalImage>), AppError> {
    let mut images = super::office_exchange::ImageStore::new();
    let mut blocks = parse_blocks(body, note_path, &mut images)?;
    let title = plain_inline(title);
    let title = title.trim();
    if title.is_empty() {
        return Ok((blocks, images.images));
    }
    let duplicate = matches!(
        blocks.first(),
        Some(Block::Heading { text, .. }) if plain_inline(text).trim() == title
    );
    if !duplicate {
        blocks.insert(
            0,
            Block::Heading {
                level: 1,
                text: title.to_string(),
            },
        );
    }
    Ok((blocks, images.images))
}

fn parse_blocks(
    body: &str,
    note_path: &str,
    images: &mut super::office_exchange::ImageStore,
) -> Result<Vec<Block>, AppError> {
    let normalized = body
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut blocks = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim().is_empty() {
            i += 1;
            continue;
        }
        if let Some(fence) = fence_marker(lines[i]) {
            i += 1;
            let mut code = Vec::new();
            while i < lines.len() && !fence_closes(lines[i], fence) {
                code.push(lines[i].to_string());
                i += 1;
            }
            if i < lines.len() {
                i += 1;
            }
            blocks.push(Block::Pre(code));
            continue;
        }
        if let Some((alt, src)) = super::office_exchange::sole_image(lines[i]) {
            let index = images.intern(note_path, &src)?;
            blocks.push(Block::Image { alt, index });
            i += 1;
            continue;
        }
        if let Some((level, text)) = atx_heading(lines[i]) {
            blocks.push(Block::Heading { level, text });
            i += 1;
            continue;
        }
        if is_thematic_break(lines[i]) {
            i += 1;
            continue;
        }
        if let Some(item) = list_item(lines[i]) {
            i += 1;
            let mut parts = vec![item.text];
            while i < lines.len()
                && !lines[i].trim().is_empty()
                && !interrupts(lines[i])
                && leading_spaces(lines[i]) > item.indent
            {
                parts.push(lines[i].trim().to_string());
                i += 1;
            }
            let text = parts.join(" ");
            if text.contains("![") && super::office_exchange::sole_image(&text).is_none() {
                return Err(AppError::Message("Put each image on its own line.".into()));
            }
            if !text.is_empty() {
                let line = match item.marker {
                    Marker::Bullet => format!("• {text}"),
                    Marker::Numbered(marker) => format!("{marker} {text}"),
                };
                blocks.push(Block::Paragraph(line));
            }
            continue;
        }
        if blockquote_line(lines[i]).is_some() {
            let mut parts = Vec::new();
            while i < lines.len() {
                if let Some(text) = blockquote_line(lines[i]) {
                    parts.push(text);
                    i += 1;
                } else {
                    break;
                }
            }
            let text = parts.join(" ");
            if text.contains("![") {
                return Err(AppError::Message("Put each image on its own line.".into()));
            }
            blocks.push(Block::Paragraph(text));
            continue;
        }
        let mut parts = vec![lines[i].trim().to_string()];
        i += 1;
        while i < lines.len() && !lines[i].trim().is_empty() {
            if let Some(level) = setext_level(lines[i]) {
                blocks.push(Block::Heading {
                    level,
                    text: parts.join(" "),
                });
                i += 1;
                parts.clear();
                break;
            }
            if interrupts(lines[i]) {
                break;
            }
            parts.push(lines[i].trim().to_string());
            i += 1;
        }
        if !parts.is_empty() {
            let text = parts.join(" ");
            if text.contains("![") {
                return Err(AppError::Message("Put each image on its own line.".into()));
            }
            blocks.push(Block::Paragraph(text));
        }
    }
    blocks.retain(meaningful);
    Ok(blocks)
}

fn meaningful(block: &Block) -> bool {
    match block {
        Block::Heading { text, .. } | Block::Paragraph(text) => !text.trim().is_empty(),
        Block::Pre(lines) => lines.iter().any(|line| !line.is_empty()),
        Block::Image { .. } => true,
    }
}

fn interrupts(line: &str) -> bool {
    atx_heading(line).is_some()
        || fence_marker(line).is_some()
        || is_thematic_break(line)
        || list_item(line).is_some()
        || blockquote_line(line).is_some()
        || super::office_exchange::table_row(line)
        || super::office_exchange::sole_image(line).is_some()
}

fn strip_marker_indent(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() && i < 3 && bytes[i] == b' ' {
        i += 1;
    }
    &line[i..]
}

fn leading_spaces(line: &str) -> usize {
    line.bytes().take_while(|byte| *byte == b' ').count()
}

fn atx_heading(line: &str) -> Option<(u8, String)> {
    let trimmed = strip_marker_indent(line);
    let bytes = trimmed.as_bytes();
    let mut hashes = 0;
    while hashes < bytes.len() && bytes[hashes] == b'#' {
        hashes += 1;
    }
    if !(1..=6).contains(&hashes) {
        return None;
    }
    if hashes < bytes.len() && bytes[hashes] != b' ' && bytes[hashes] != b'\t' {
        return None;
    }
    Some((hashes as u8, atx_text(&trimmed[hashes..])))
}

fn atx_text(rest: &str) -> String {
    let trimmed = rest.trim();
    let bytes = trimmed.as_bytes();
    let mut end = bytes.len();
    while end > 0 && bytes[end - 1] == b'#' {
        end -= 1;
    }
    if end < bytes.len() && (end == 0 || bytes[end - 1] == b' ' || bytes[end - 1] == b'\t') {
        return trimmed[..end].trim().to_string();
    }
    trimmed.to_string()
}

fn setext_level(line: &str) -> Option<u8> {
    let trimmed = strip_marker_indent(line).trim_end();
    if trimmed.len() < 3 {
        return None;
    }
    let bytes = trimmed.as_bytes();
    if bytes.iter().all(|byte| *byte == b'=') {
        return Some(1);
    }
    if bytes.iter().all(|byte| *byte == b'-') {
        return Some(2);
    }
    None
}

fn is_thematic_break(line: &str) -> bool {
    let trimmed = strip_marker_indent(line).trim();
    let mut marks = trimmed.chars().filter(|ch| !ch.is_whitespace());
    let Some(first) = marks.next() else {
        return false;
    };
    if first != '-' && first != '*' && first != '_' {
        return false;
    }
    let mut count = 1;
    for ch in marks {
        if ch != first {
            return false;
        }
        count += 1;
    }
    count >= 3
}

fn fence_marker(line: &str) -> Option<Fence> {
    let trimmed = strip_marker_indent(line);
    let bytes = trimmed.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let ch = bytes[0];
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let mut len = 0;
    while len < bytes.len() && bytes[len] == ch {
        len += 1;
    }
    if len < 3 {
        return None;
    }
    let rest = trimmed[len..].trim();
    if ch == b'`' && rest.contains('`') {
        return None;
    }
    Some(Fence { ch, len })
}

fn fence_closes(line: &str, open: Fence) -> bool {
    let trimmed = strip_marker_indent(line).trim_end();
    let bytes = trimmed.as_bytes();
    bytes.len() >= open.len && bytes.iter().all(|byte| *byte == open.ch)
}

fn list_item(line: &str) -> Option<Item> {
    let indent = leading_spaces(line);
    let rest = line.trim_start_matches(' ');
    if let Some(text) = rest
        .strip_prefix("- ")
        .or_else(|| rest.strip_prefix("* "))
        .or_else(|| rest.strip_prefix("+ "))
    {
        return Some(Item {
            indent,
            marker: Marker::Bullet,
            text: text.to_string(),
        });
    }
    let bytes = rest.as_bytes();
    let mut n = 0;
    while n < bytes.len() && n < 9 && bytes[n].is_ascii_digit() {
        n += 1;
    }
    if n == 0 || n >= bytes.len() || (bytes[n] != b'.' && bytes[n] != b')') {
        return None;
    }
    let after = &rest[n + 1..];
    if !after.starts_with(' ') {
        return None;
    }
    Some(Item {
        indent,
        marker: Marker::Numbered(rest[..n + 1].to_string()),
        text: after.trim_start().to_string(),
    })
}

fn blockquote_line(line: &str) -> Option<String> {
    let trimmed = strip_marker_indent(line);
    let mut rest = trimmed.strip_prefix('>')?;
    if let Some(stripped) = rest.strip_prefix(' ') {
        rest = stripped;
    }
    while let Some(inner) = rest.strip_prefix('>') {
        rest = inner.strip_prefix(' ').unwrap_or(inner);
    }
    Some(rest.to_string())
}

fn plain_inline(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' {
            if let Some(next) = chars.get(i + 1).copied() {
                if is_md_punct(next) {
                    out.push(next);
                    i += 2;
                    continue;
                }
            }
        }
        if chars[i] == '!' && chars.get(i + 1) == Some(&'[') {
            if let Some((label, next)) = parse_link(&chars, i + 1) {
                out.push_str(&plain_inline(&label));
                i = next;
                continue;
            }
        }
        if chars[i] == '[' {
            if let Some((label, next)) = parse_link(&chars, i) {
                out.push_str(&plain_inline(&label));
                i = next;
                continue;
            }
        }
        if chars[i] == '`' {
            if let Some((code, next)) = parse_code(&chars, i) {
                out.push_str(&code);
                i = next;
                continue;
            }
        }
        if chars[i] == '~' && chars.get(i + 1) == Some(&'~') {
            if let Some((inner, next)) = take_delimited(&chars, i, '~', 2) {
                out.push_str(&plain_inline(&inner));
                i = next;
                continue;
            }
        }
        if chars[i] == '*' || chars[i] == '_' {
            if let Some((inner, next)) = take_emphasis(&chars, i) {
                out.push_str(&plain_inline(&inner));
                i = next;
                continue;
            }
        }
        if chars[i] == '<' {
            if let Some((inner, next)) = parse_autolink(&chars, i) {
                out.push_str(&inner);
                i = next;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    collapse_ws(&out)
}

fn is_md_punct(ch: char) -> bool {
    matches!(
        ch,
        '\\' | '`'
            | '*'
            | '_'
            | '{'
            | '}'
            | '['
            | ']'
            | '('
            | ')'
            | '#'
            | '+'
            | '-'
            | '.'
            | '!'
            | '~'
            | '|'
            | '<'
            | '>'
    )
}

fn parse_link(chars: &[char], start: usize) -> Option<(String, usize)> {
    if chars.get(start) != Some(&'[') {
        return None;
    }
    let mut i = start + 1;
    while i < chars.len() && chars[i] != ']' {
        i += 1;
    }
    if i >= chars.len() || chars.get(i + 1) != Some(&'(') {
        return None;
    }
    let label: String = chars[start + 1..i].iter().collect();
    i += 2;
    while i < chars.len() && chars[i] != ')' {
        i += 1;
    }
    if i >= chars.len() {
        return None;
    }
    Some((label, i + 1))
}

fn parse_code(chars: &[char], start: usize) -> Option<(String, usize)> {
    let mut width = 0;
    while start + width < chars.len() && chars[start + width] == '`' {
        width += 1;
    }
    if width == 0 {
        return None;
    }
    let mut i = start + width;
    while i < chars.len() {
        if chars[i] != '`' {
            i += 1;
            continue;
        }
        let mut run = 0;
        while i + run < chars.len() && chars[i + run] == '`' {
            run += 1;
        }
        if run == width {
            let inner: String = chars[start + width..i].iter().collect();
            return Some((trim_code_span(&inner), i + run));
        }
        i += run;
    }
    None
}

fn trim_code_span(inner: &str) -> String {
    let chars: Vec<char> = inner.chars().collect();
    if chars.len() >= 2 && chars[0] == ' ' && *chars.last().unwrap_or(&' ') == ' ' {
        let body: String = chars[1..chars.len() - 1].iter().collect();
        if body.chars().any(|ch| ch != ' ') {
            return body.replace('\n', " ");
        }
    }
    inner.replace('\n', " ")
}

fn parse_autolink(chars: &[char], start: usize) -> Option<(String, usize)> {
    if chars.get(start) != Some(&'<') {
        return None;
    }
    let mut i = start + 1;
    while i < chars.len() && chars[i] != '>' && chars[i] != ' ' && chars[i] != '<' {
        i += 1;
    }
    if chars.get(i) != Some(&'>') {
        return None;
    }
    let inner: String = chars[start + 1..i].iter().collect();
    if inner.starts_with("http://") || inner.starts_with("https://") || inner.contains('@') {
        return Some((inner, i + 1));
    }
    None
}

fn take_emphasis(chars: &[char], start: usize) -> Option<(String, usize)> {
    let marker = chars[start];
    if marker != '*' && marker != '_' {
        return None;
    }
    let mut run = 0;
    while chars.get(start + run) == Some(&marker) {
        run += 1;
    }
    let run = run.min(3);
    for width in (1..=run).rev() {
        if marker == '_' && !boundary_before(chars, start) {
            continue;
        }
        let Some((inner, next)) = take_delimited(chars, start, marker, width) else {
            continue;
        };
        if marker == '_' && !boundary_after(chars, next - 1) {
            continue;
        }
        return Some((inner, next));
    }
    None
}

fn take_delimited(
    chars: &[char],
    start: usize,
    marker: char,
    width: usize,
) -> Option<(String, usize)> {
    if start + width > chars.len() || chars[start..start + width].iter().any(|ch| *ch != marker) {
        return None;
    }
    let close = find_close(chars, start + width, marker, width)?;
    let inner: String = chars[start + width..close].iter().collect();
    if inner.is_empty()
        || inner.starts_with(char::is_whitespace)
        || inner.ends_with(char::is_whitespace)
    {
        return None;
    }
    Some((inner, close + width))
}

fn find_close(chars: &[char], from: usize, marker: char, width: usize) -> Option<usize> {
    let mut i = from;
    while i + width <= chars.len() {
        if chars[i..i + width].iter().all(|ch| *ch == marker) {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn boundary_before(chars: &[char], start: usize) -> bool {
    start == 0 || !chars[start - 1].is_alphanumeric()
}

fn boundary_after(chars: &[char], last: usize) -> bool {
    last + 1 >= chars.len() || !chars[last + 1].is_alphanumeric()
}

fn collapse_ws(input: &str) -> String {
    let mut out = String::new();
    let mut pending = false;
    for ch in input.chars() {
        if ch.is_whitespace() {
            pending = true;
            continue;
        }
        if pending && !out.is_empty() {
            out.push(' ');
        }
        pending = false;
        out.push(ch);
    }
    out
}

fn style_for(block: &Block) -> Style {
    match block {
        Block::Heading { level: 1, .. } => Style {
            face: Face::Bold,
            size: 18,
            leading: 24,
            gap: 16,
        },
        Block::Heading { level: 2, .. } => Style {
            face: Face::Bold,
            size: 14,
            leading: 20,
            gap: 14,
        },
        Block::Heading { level: 3, .. } => Style {
            face: Face::Bold,
            size: 12,
            leading: 16,
            gap: 12,
        },
        Block::Heading { .. } => Style {
            face: Face::Bold,
            size: 11,
            leading: 15,
            gap: 10,
        },
        Block::Paragraph(_) | Block::Image { .. } => Style {
            face: Face::Roman,
            size: 11,
            leading: 15,
            gap: 8,
        },
        Block::Pre(_) => Style {
            face: Face::Courier,
            size: 9,
            leading: 12,
            gap: 8,
        },
    }
}

#[derive(Clone)]
struct Page {
    lines: Vec<Drawn>,
    pictures: Vec<Picture>,
}

#[derive(Clone)]
struct Picture {
    index: usize,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

fn layout_blocks(
    blocks: &[Block],
    images: &[super::office_exchange::LocalImage],
) -> Result<(Vec<Page>, Vec<String>), AppError> {
    let mut urls = UrlTable::new();
    let mut pages = vec![Page {
        lines: Vec::new(),
        pictures: Vec::new(),
    }];
    let mut y = PAGE_H - MARGIN_Y;
    let mut at_top = true;
    for block in blocks {
        if let Block::Image { alt, index } = block {
            let image = &images[*index];
            let (w, h) = fit_image(image.width, image.height);
            let gap = if at_top { 0 } else { 8 };
            let mut bottom = y - gap - h;
            if bottom < MARGIN_Y {
                pages.push(Page {
                    lines: Vec::new(),
                    pictures: Vec::new(),
                });
                y = PAGE_H - MARGIN_Y;
                bottom = y - h;
            }
            pages.last_mut().expect("page").pictures.push(Picture {
                index: *index,
                x: MARGIN_X,
                y: bottom,
                w,
                h,
            });
            y = bottom - 4;
            at_top = false;
            if !alt.trim().is_empty() {
                place_lines(
                    &mut pages,
                    &mut y,
                    &mut at_top,
                    &wrap_runs(&decorate(alt, Face::Roman, &mut urls)?, 11)?,
                    11,
                    15,
                    4,
                )?;
            }
            continue;
        }
        let style = style_for(block);
        let lines = match block {
            Block::Pre(lines) => {
                let mut wrapped = Vec::new();
                for text in wrap_pre(lines, style.size) {
                    wrapped.push(expand_fonts(&[Run {
                        face: Face::Courier,
                        text,
                        strike: false,
                        url: None,
                    }])?);
                }
                wrapped
            }
            Block::Heading { text, .. } => {
                wrap_runs(&decorate(text, Face::Bold, &mut urls)?, style.size)?
            }
            Block::Paragraph(text) => {
                wrap_runs(&decorate(text, style.face, &mut urls)?, style.size)?
            }
            Block::Image { .. } => Vec::new(),
        };
        place_lines(
            &mut pages,
            &mut y,
            &mut at_top,
            &lines,
            style.size,
            style.leading,
            style.gap,
        )?;
    }
    Ok((pages, urls.values))
}

struct UrlTable {
    values: Vec<String>,
    index: HashMap<String, u32>,
}

impl UrlTable {
    fn new() -> Self {
        Self {
            values: Vec::new(),
            index: HashMap::new(),
        }
    }

    fn intern(&mut self, url: String) -> u32 {
        if let Some(id) = self.index.get(&url).copied() {
            return id;
        }
        let id = self.values.len() as u32;
        self.index.insert(url.clone(), id);
        self.values.push(url);
        id
    }
}

fn place_lines(
    pages: &mut Vec<Page>,
    y: &mut i32,
    at_top: &mut bool,
    lines: &[Vec<Run>],
    size: i32,
    leading: i32,
    gap_before: i32,
) -> Result<(), AppError> {
    for (index, runs) in lines.iter().enumerate() {
        if runs.iter().all(|run| run.text.is_empty()) {
            continue;
        }
        let gap = if index == 0 && !*at_top {
            gap_before
        } else {
            0
        };
        let mut baseline = *y - gap - size;
        if baseline < MARGIN_Y {
            pages.push(Page {
                lines: Vec::new(),
                pictures: Vec::new(),
            });
            *y = PAGE_H - MARGIN_Y;
            baseline = *y - size;
        }
        if baseline < MARGIN_Y {
            baseline = MARGIN_Y;
        }
        pages.last_mut().expect("page").lines.push(Drawn {
            size,
            x: MARGIN_X,
            y: baseline,
            runs: runs.clone(),
        });
        *y = baseline - (leading - size);
        *at_top = false;
    }
    Ok(())
}

fn fit_image(width: u32, height: u32) -> (i32, i32) {
    // 96 dpi into PDF points. Shrink to the content box. Do not enlarge.
    let mut w = (i64::from(width.max(1)) * 72 / 96).max(1) as i32;
    let mut h = (i64::from(height.max(1)) * 72 / 96).max(1) as i32;
    if w > CONTENT_W {
        h = (i64::from(h) * i64::from(CONTENT_W) / i64::from(w)).max(1) as i32;
        w = CONTENT_W;
    }
    let max_h = PAGE_H - MARGIN_Y * 2;
    if h > max_h {
        w = (i64::from(w) * i64::from(max_h) / i64::from(h)).max(1) as i32;
        h = max_h;
    }
    (w, h)
}

fn decorate(text: &str, base: Face, urls: &mut UrlTable) -> Result<Vec<Run>, AppError> {
    let mut runs = Vec::new();
    decorate_into(text, base, false, false, false, urls, &mut runs)?;
    Ok(runs)
}

fn decorate_into(
    text: &str,
    base: Face,
    bold: bool,
    italic: bool,
    strike: bool,
    urls: &mut UrlTable,
    out: &mut Vec<Run>,
) -> Result<(), AppError> {
    let mut index = 0;
    let mut plain = String::new();
    let flush = |plain: &mut String, out: &mut Vec<Run>| {
        if plain.is_empty() {
            return;
        }
        out.push(Run {
            face: face_for(base, bold, italic),
            text: std::mem::take(plain),
            strike,
            url: None,
        });
    };
    while index < text.len() {
        let rest = &text[index..];
        if rest.starts_with('\\') {
            let mut chars = rest.chars();
            chars.next();
            if let Some(ch) = chars.next() {
                if is_md_punct(ch) {
                    plain.push(ch);
                    index += 1 + ch.len_utf8();
                    continue;
                }
            }
            plain.push('\\');
            index += 1;
            continue;
        }
        if rest.starts_with('`') {
            if let Some(end) = rest[1..].find('`') {
                flush(&mut plain, out);
                let inner = &rest[1..1 + end];
                out.push(Run {
                    face: Face::Courier,
                    text: inner.to_string(),
                    strike,
                    url: None,
                });
                index += end + 2;
                continue;
            }
        }
        if let Some((label, url, taken)) = super::office_exchange::take_link(rest) {
            let url = super::office_exchange::link_target(url)?;
            flush(&mut plain, out);
            let visible = if label == url {
                url.clone()
            } else {
                format!("{label} ({url})")
            };
            let id = urls.intern(url);
            out.push(Run {
                face: face_for(base, bold, italic),
                text: visible,
                strike,
                url: Some(id),
            });
            index += taken;
            continue;
        }
        if rest.starts_with("~~") {
            if let Some(end) = find_ascii(&rest[2..], "~~") {
                flush(&mut plain, out);
                decorate_into(&rest[2..2 + end], base, bold, italic, true, urls, out)?;
                index += end + 4;
                continue;
            }
        }
        if rest.starts_with("***") {
            if let Some(end) = find_ascii(&rest[3..], "***") {
                flush(&mut plain, out);
                decorate_into(&rest[3..3 + end], base, true, true, strike, urls, out)?;
                index += end + 6;
                continue;
            }
        }
        if rest.starts_with("**") {
            if let Some(end) = find_ascii(&rest[2..], "**") {
                flush(&mut plain, out);
                decorate_into(&rest[2..2 + end], base, true, italic, strike, urls, out)?;
                index += end + 4;
                continue;
            }
        }
        if rest.starts_with('*') || rest.starts_with('_') {
            let marker = &rest[..1];
            // `_` inside a word is a character. `snake_case_variable` stays.
            let underscore = marker == "_";
            let flanked = !underscore || !word_char_before(text, index);
            if flanked {
                if let Some(end) = find_ascii(&rest[1..], marker) {
                    let inner = &rest[1..1 + end];
                    let after = index + end + 2;
                    if !inner.is_empty()
                        && !inner.contains(marker)
                        && !(underscore && word_char_at(text, after))
                    {
                        flush(&mut plain, out);
                        decorate_into(inner, base, bold, true, strike, urls, out)?;
                        index += end + 2;
                        continue;
                    }
                }
            }
        }
        let ch = rest.chars().next().unwrap();
        plain.push(ch);
        index += ch.len_utf8();
    }
    flush(&mut plain, out);
    Ok(())
}

fn find_ascii(hay: &str, marker: &str) -> Option<usize> {
    hay.find(marker)
}

fn word_char_before(text: &str, index: usize) -> bool {
    text[..index]
        .chars()
        .next_back()
        .is_some_and(|ch| ch.is_alphanumeric())
}

fn word_char_at(text: &str, index: usize) -> bool {
    text[index..]
        .chars()
        .next()
        .is_some_and(|ch| ch.is_alphanumeric())
}

fn face_for(base: Face, bold: bool, italic: bool) -> Face {
    if base == Face::Courier {
        return Face::Courier;
    }
    let bold = bold || matches!(base, Face::Bold | Face::BoldItalic);
    let italic = italic || matches!(base, Face::Italic | Face::BoldItalic);
    match (bold, italic) {
        (true, true) => Face::BoldItalic,
        (true, false) => Face::Bold,
        (false, true) => Face::Italic,
        (false, false) => Face::Roman,
    }
}

fn wrap_runs(runs: &[Run], size: i32) -> Result<Vec<Vec<Run>>, AppError> {
    let runs = expand_fonts(runs)?;
    let mut words = Vec::new();
    let mut pending_space = false;
    for run in &runs {
        let mut rest = run.text.as_str();
        while !rest.is_empty() {
            if rest.starts_with(|ch: char| ch.is_whitespace()) {
                pending_space = true;
                rest = rest.trim_start();
                continue;
            }
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            words.push((pending_space, &rest[..end], run));
            pending_space = false;
            rest = &rest[end..];
        }
    }
    let mut lines = Vec::new();
    let mut current: Vec<Run> = Vec::new();
    let mut width = 0i32;
    for (spaced, word, run) in words {
        let text = if spaced && !current.is_empty() {
            format!(" {word}")
        } else {
            word.to_string()
        };
        let add = text_width(&text, run.face, size);
        if !current.is_empty() && width + add > CONTENT_W {
            lines.push(std::mem::take(&mut current));
            width = 0;
        }
        if current.is_empty() && text_width(word, run.face, size) > CONTENT_W {
            let mut parts = split_overlong(word, run.face, size);
            let last = parts.pop().unwrap_or_default();
            for part in parts {
                lines.push(vec![Run {
                    text: part,
                    face: run.face,
                    strike: run.strike,
                    url: run.url,
                }]);
            }
            width = text_width(&last, run.face, size);
            current.push(Run {
                text: last,
                face: run.face,
                strike: run.strike,
                url: run.url,
            });
            continue;
        }
        let text = if current.is_empty() {
            word.to_string()
        } else if spaced {
            format!(" {word}")
        } else {
            word.to_string()
        };
        width += text_width(&text, run.face, size);
        current.push(Run {
            text,
            face: run.face,
            strike: run.strike,
            url: run.url,
        });
    }
    if !current.is_empty() {
        lines.push(current);
    }
    Ok(lines)
}

fn wrap_pre(lines: &[String], size: i32) -> Vec<String> {
    let mut out = Vec::new();
    for line in lines {
        if line.is_empty() {
            out.push(String::new());
        } else if text_width(line, Face::Courier, size) <= CONTENT_W {
            out.push(line.clone());
        } else {
            out.extend(split_overlong(line, Face::Courier, size));
        }
    }
    out
}

fn split_overlong(text: &str, face: Face, size: i32) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut width = Measure::new();
    for ch in text.chars() {
        let mut next = width;
        next.add(face, ch);
        if !current.is_empty() && next.points(size) > CONTENT_W {
            lines.push(std::mem::take(&mut current));
            width = Measure::new();
            width.add(face, ch);
        } else {
            width = next;
        }
        current.push(ch);
    }
    if !current.is_empty() {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn text_width(text: &str, face: Face, size: i32) -> i32 {
    let mut width = Measure::new();
    for ch in text.chars() {
        width.add(face, ch);
    }
    width.points(size)
}

/// Running width. WinAnsi stays in the face's 1000-unit grid. A fallback
/// character adds that font's own units, so a code line is not measured as
/// zero and the wrap does not rescan the prefix.
#[derive(Clone, Copy)]
struct Measure {
    units: i64,
    droid: i64,
    emoji: i64,
}

impl Measure {
    fn new() -> Self {
        Self {
            units: 0,
            droid: 0,
            emoji: 0,
        }
    }

    fn add(&mut self, face: Face, ch: char) {
        if let Some(kind) = fallback_kind(face, ch) {
            let advance = i64::from(
                super::fallback_font::glyph(kind, ch)
                    .map(|(_, advance)| advance)
                    .unwrap_or(0),
            );
            match kind {
                super::fallback_font::Kind::Droid => self.droid += advance,
                super::fallback_font::Kind::Emoji => self.emoji += advance,
            }
            return;
        }
        self.units += i64::from(glyph_units(face, ch));
    }

    fn points(&self, size: i32) -> i32 {
        let size = i64::from(size);
        let win = (self.units * size + 500) / 1000;
        let droid = self.droid * size
            / i64::from(
                super::fallback_font::units_per_em(super::fallback_font::Kind::Droid).max(1),
            );
        let emoji = self.emoji * size
            / i64::from(
                super::fallback_font::units_per_em(super::fallback_font::Kind::Emoji).max(1),
            );
        i32::try_from(win + droid + emoji).unwrap_or(i32::MAX)
    }
}

fn fallback_kind(face: Face, ch: char) -> Option<super::fallback_font::Kind> {
    use super::fallback_font::Kind;
    if matches!(face, Face::Droid) {
        return Some(Kind::Droid);
    }
    if matches!(face, Face::Emoji) {
        return Some(Kind::Emoji);
    }
    if encode_char(ch).is_ok() {
        return None;
    }
    if super::fallback_font::covers(Kind::Droid, ch) {
        return Some(Kind::Droid);
    }
    if super::fallback_font::covers(Kind::Emoji, ch) {
        return Some(Kind::Emoji);
    }
    None
}

fn expand_fonts(runs: &[Run]) -> Result<Vec<Run>, AppError> {
    let mut out = Vec::new();
    for run in runs {
        let mut face = None;
        let mut text = String::new();
        let flush = |face: &mut Option<Face>, text: &mut String, out: &mut Vec<Run>, run: &Run| {
            if text.is_empty() {
                return;
            }
            out.push(Run {
                face: face.take().unwrap_or(run.face),
                text: std::mem::take(text),
                strike: run.strike,
                url: run.url,
            });
        };
        for ch in run.text.chars() {
            let next = face_for_char(run.face, ch)?;
            if face != Some(next) {
                flush(&mut face, &mut text, &mut out, run);
                face = Some(next);
            }
            text.push(ch);
        }
        flush(&mut face, &mut text, &mut out, run);
    }
    Ok(out)
}

fn face_for_char(base: Face, ch: char) -> Result<Face, AppError> {
    if encode_char(ch).is_ok() && !matches!(base, Face::Droid | Face::Emoji) {
        return Ok(base);
    }
    if super::fallback_font::covers(super::fallback_font::Kind::Droid, ch) {
        return Ok(Face::Droid);
    }
    if super::fallback_font::covers(super::fallback_font::Kind::Emoji, ch) {
        return Ok(Face::Emoji);
    }
    Err(AppError::Message(super::fallback_font::missing(ch)))
}

fn glyph_units(face: Face, ch: char) -> u16 {
    // shortcut: italic wraps with the roman or bold widths. The italic face is
    // not wider than the bold face, so a line breaks before it clips.
    let Ok(byte) = encode_char(ch) else {
        return 0;
    };
    match face {
        Face::Courier => 600,
        Face::Roman | Face::Italic => TIMES_ROMAN[byte as usize],
        Face::Bold | Face::BoldItalic => TIMES_BOLD[byte as usize],
        Face::Droid | Face::Emoji => 0,
    }
}

fn require_drawable(text: &str) -> Result<(), AppError> {
    for ch in text.chars() {
        let _ = face_for_char(Face::Roman, ch)?;
    }
    Ok(())
}

fn render(
    pages: &[Page],
    images: &[super::office_exchange::LocalImage],
    urls: &[String],
) -> Result<Vec<u8>, AppError> {
    let pages = if pages.is_empty() {
        vec![Page {
            lines: Vec::new(),
            pictures: Vec::new(),
        }]
    } else {
        pages.to_vec()
    };
    let mut objects: Vec<Vec<u8>> = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        Vec::new(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>"
            .to_vec(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>"
            .to_vec(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>".to_vec(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic /Encoding /WinAnsiEncoding >>"
            .to_vec(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-BoldItalic /Encoding /WinAnsiEncoding >>"
            .to_vec(),
    ];
    for image in images {
        objects.push(image_object(image)?);
    }
    let page_links: Vec<Vec<PageLink>> = pages.iter().map(collect_links).collect();
    let droid_chars = face_chars(&pages, Face::Droid);
    let emoji_chars = face_chars(&pages, Face::Emoji);
    let droid_id = if droid_chars.is_empty() {
        None
    } else {
        Some(super::fallback_font::embed(
            &mut objects,
            super::fallback_font::Kind::Droid,
            &droid_chars,
        )?)
    };
    let emoji_id = if emoji_chars.is_empty() {
        None
    } else {
        Some(super::fallback_font::embed(
            &mut objects,
            super::fallback_font::Kind::Emoji,
            &emoji_chars,
        )?)
    };
    let first_action = objects.len() + 1;
    for url in urls {
        objects.push(format!("<< /S /URI /URI {} >>", pdf_literal(url)?).into_bytes());
    }
    let mut page_ids = Vec::new();
    for (page, links) in pages.iter().zip(page_links) {
        let page_id = objects.len() + 1;
        let content_id = page_id + 1;
        let annot_ids: Vec<usize> = (0..links.len())
            .map(|index| content_id + 1 + index)
            .collect();
        objects.push(
            page_object(
                page_id,
                content_id,
                &annot_ids,
                images.len(),
                droid_id,
                emoji_id,
            )
            .into_bytes(),
        );
        let stream = page_stream(page)?;
        let length = stream.len() + 1;
        objects.push(format!("<< /Length {length} >>\nstream\n{stream}\nendstream").into_bytes());
        for link in links {
            objects.push(link_annot(&link, first_action).into_bytes());
        }
        page_ids.push(page_id);
    }
    let mut kids = String::from("[");
    for (index, id) in page_ids.iter().enumerate() {
        if index > 0 {
            kids.push(' ');
        }
        kids.push_str(&format!("{id} 0 R"));
    }
    kids.push(']');
    objects[1] = format!("<< /Type /Pages /Kids {kids} /Count {} >>", page_ids.len()).into_bytes();

    let mut out = Vec::new();
    out.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend(format!("{} 0 obj\n", index + 1).as_bytes());
        out.extend(body);
        out.extend(b"\nendobj\n");
    }
    let xref = out.len();
    let size = objects.len() + 1;
    out.extend(format!("xref\n0 {size}\n").as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for offset in offsets {
        out.extend(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend(
        format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
    );
    Ok(out)
}

fn image_object(image: &super::office_exchange::LocalImage) -> Result<Vec<u8>, AppError> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut encoder, &image.rgb)
        .map_err(|err| AppError::Io(err.to_string()))?;
    let data = encoder
        .finish()
        .map_err(|err| AppError::Io(err.to_string()))?;
    let mut object = format!(
        "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length {} >>\nstream\n",
        image.width, image.height, data.len()
    )
    .into_bytes();
    object.extend(data);
    object.extend(b"\nendstream");
    Ok(object)
}

fn page_object(
    page_id: usize,
    content_id: usize,
    annots: &[usize],
    image_count: usize,
    droid_id: Option<usize>,
    emoji_id: Option<usize>,
) -> String {
    let _ = page_id;
    let mut annot = String::new();
    if !annots.is_empty() {
        annot.push_str(" /Annots [");
        for (index, id) in annots.iter().enumerate() {
            if index > 0 {
                annot.push(' ');
            }
            annot.push_str(&format!("{id} 0 R"));
        }
        annot.push(']');
    }
    let mut xobjects = String::new();
    if image_count > 0 {
        xobjects.push_str(" /XObject <<");
        for index in 0..image_count {
            xobjects.push_str(&format!(" /Im{} {} 0 R", index + 1, 8 + index));
        }
        xobjects.push_str(" >>");
    }
    let mut extra_fonts = String::new();
    if let Some(id) = droid_id {
        extra_fonts.push_str(&format!(" /F6 {id} 0 R"));
    }
    if let Some(id) = emoji_id {
        extra_fonts.push_str(&format!(" /F7 {id} 0 R"));
    }
    format!(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] \
         /Contents {content_id} 0 R{annot} /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R /F5 7 0 R{extra_fonts} >>{xobjects} >> >>"
    )
}

fn face_chars(pages: &[Page], face: Face) -> Vec<char> {
    let mut chars = Vec::new();
    for page in pages {
        for line in &page.lines {
            for run in &line.runs {
                if run.face != face {
                    continue;
                }
                for ch in run.text.chars() {
                    if !chars.contains(&ch) {
                        chars.push(ch);
                    }
                }
            }
        }
    }
    chars
}

struct PageLink {
    action: usize,
    rects: Vec<(i32, i32, i32, i32)>,
}

/// One annotation per address on the page. The URI string is a single object
/// shared by every page, so wrapping a long link does not copy it per fragment.
fn collect_links(page: &Page) -> Vec<PageLink> {
    let mut links: Vec<PageLink> = Vec::new();
    for line in &page.lines {
        let mut x = line.x;
        for run in &line.runs {
            let width = text_width(&run.text, run.face, line.size);
            if let Some(action) = run.url {
                if width > 0 {
                    let action = action as usize;
                    let rect = (x, line.y - 2, x + width, line.y + line.size);
                    if let Some(link) = links.iter_mut().find(|link| link.action == action) {
                        link.rects.push(rect);
                    } else {
                        links.push(PageLink {
                            action,
                            rects: vec![rect],
                        });
                    }
                }
            }
            x += width;
        }
    }
    links
}

fn link_annot(link: &PageLink, first_action: usize) -> String {
    let (mut left, mut bottom, mut right, mut top) = link.rects[0];
    for (x0, y0, x1, y1) in &link.rects {
        left = left.min(*x0);
        bottom = bottom.min(*y0);
        right = right.max(*x1);
        top = top.max(*y1);
    }
    let mut quads = String::new();
    if link.rects.len() > 1 {
        quads.push_str(" /QuadPoints [");
        for (index, (x0, y0, x1, y1)) in link.rects.iter().enumerate() {
            if index > 0 {
                quads.push(' ');
            }
            quads.push_str(&format!("{x0} {y0} {x1} {y0} {x1} {y1} {x0} {y1}"));
        }
        quads.push(']');
    }
    format!(
        "<< /Type /Annot /Subtype /Link /Rect [{left} {bottom} {right} {top}] /Border [0 0 0]{quads} /A {} 0 R >>",
        first_action + link.action
    )
}

fn page_stream(page: &Page) -> Result<String, AppError> {
    let mut stream = String::from("BT\n");
    let mut strokes = Vec::new();
    for line in &page.lines {
        let mut x = line.x;
        for run in &line.runs {
            if run.text.is_empty() {
                continue;
            }
            let width = text_width(&run.text, run.face, line.size);
            let shown = match run.face {
                Face::Droid => {
                    super::fallback_font::glyph_hex(super::fallback_font::Kind::Droid, &run.text)?
                }
                Face::Emoji => {
                    super::fallback_font::glyph_hex(super::fallback_font::Kind::Emoji, &run.text)?
                }
                _ => pdf_literal(&run.text)?,
            };
            stream.push_str(&format!(
                "{} {} Tf\n1 0 0 1 {} {} Tm\n{shown} Tj\n",
                face_op(run.face),
                line.size,
                x,
                line.y,
            ));
            if run.strike {
                let mid = line.y + line.size / 3;
                strokes.push(format!("{x} {mid} m {} {mid} l", x + width));
            }
            x += width;
        }
    }
    stream.push_str("ET");
    if !strokes.is_empty() {
        stream.push_str("\n0.6 w\n");
        stream.push_str(&strokes.join("\n"));
        stream.push_str("\nS");
    }
    for picture in &page.pictures {
        stream.push_str(&format!(
            "\nq\n{} 0 0 {} {} {} cm\n/Im{} Do\nQ",
            picture.w,
            picture.h,
            picture.x,
            picture.y,
            picture.index + 1
        ));
    }
    Ok(stream)
}

fn face_op(face: Face) -> &'static str {
    match face {
        Face::Roman => "/F1",
        Face::Bold => "/F2",
        Face::Courier => "/F3",
        Face::Italic => "/F4",
        Face::BoldItalic => "/F5",
        Face::Droid => "/F6",
        Face::Emoji => "/F7",
    }
}

fn pdf_literal(text: &str) -> Result<String, AppError> {
    let mut out = String::from("(");
    for ch in text.chars() {
        let byte = encode_char(ch)?;
        match byte {
            b'\\' | b'(' | b')' => {
                out.push('\\');
                out.push(byte as char);
            }
            0x20..=0x7E => out.push(byte as char),
            _ => out.push_str(&format!("\\{byte:03o}")),
        }
    }
    out.push(')');
    Ok(out)
}

/// WinAnsi byte. A character Times cannot draw is an error, not a question mark.
fn encode_char(ch: char) -> Result<u8, AppError> {
    match ch {
        '\u{00AD}' => Ok(0xAD),
        '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}' => Err(undrawable(ch)),
        '\u{00A0}' | '\u{202F}' => Ok(0xA0),
        '\u{2011}' | '\u{2212}' => Ok(b'-'),
        '\u{20AC}' => Ok(0x80),
        '\u{201A}' => Ok(0x82),
        '\u{0192}' => Ok(0x83),
        '\u{201E}' => Ok(0x84),
        '\u{2026}' => Ok(0x85),
        '\u{2020}' => Ok(0x86),
        '\u{2021}' => Ok(0x87),
        '\u{02C6}' => Ok(0x88),
        '\u{2030}' => Ok(0x89),
        '\u{0160}' => Ok(0x8A),
        '\u{2039}' => Ok(0x8B),
        '\u{0152}' => Ok(0x8C),
        '\u{017D}' => Ok(0x8E),
        '\u{2018}' => Ok(0x91),
        '\u{2019}' => Ok(0x92),
        '\u{201C}' => Ok(0x93),
        '\u{201D}' => Ok(0x94),
        '\u{2022}' => Ok(0x95),
        '\u{2013}' => Ok(0x96),
        '\u{2014}' => Ok(0x97),
        '\u{02DC}' => Ok(0x98),
        '\u{2122}' => Ok(0x99),
        '\u{0161}' => Ok(0x9A),
        '\u{203A}' => Ok(0x9B),
        '\u{0153}' => Ok(0x9C),
        '\u{017E}' => Ok(0x9E),
        '\u{0178}' => Ok(0x9F),
        ch if ('\u{0020}'..='\u{007E}').contains(&ch) => Ok(ch as u8),
        ch if ('\u{00A1}'..='\u{00FF}').contains(&ch) => Ok(ch as u8),
        ch if ch.is_whitespace() => Ok(b' '),
        ch => Err(undrawable(ch)),
    }
}

fn undrawable(ch: char) -> AppError {
    AppError::Message(format!(
        "Alkuin can't draw \"{ch}\" in the PDF. The page is Times, and that character isn't in the font."
    ))
}

include!("pdf_widths.inc");

#[cfg(test)]
mod tests {
    use super::*;

    fn find_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len())
            .position(|window| window == needle)
    }

    fn content_streams(pdf: &[u8]) -> Vec<&[u8]> {
        let mut streams = Vec::new();
        let mut i = 0;
        let key = b"/Length ";
        while let Some(rel) = find_bytes(&pdf[i..], key) {
            let at = i + rel + key.len();
            let end = pdf[at..]
                .iter()
                .position(|byte| !byte.is_ascii_digit())
                .map(|pos| pos + at)
                .unwrap();
            let len: usize = std::str::from_utf8(&pdf[at..end]).unwrap().parse().unwrap();
            let stream_rel = find_bytes(&pdf[end..], b"stream\n").unwrap();
            assert!(stream_rel < 128);
            let data = end + stream_rel + b"stream\n".len();
            let mut after = data + len;
            if pdf.get(after) == Some(&b'\n') {
                after += 1;
            }
            assert!(pdf[after..].starts_with(b"endstream"));
            streams.push(&pdf[data..data + len]);
            i = after;
        }
        streams
    }

    fn pdf_literals(stream: &[u8]) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < stream.len() {
            if stream[i] != b'(' {
                i += 1;
                continue;
            }
            i += 1;
            let mut buf = Vec::new();
            while i < stream.len() {
                match stream[i] {
                    b')' => {
                        i += 1;
                        break;
                    }
                    b'\\' => {
                        i += 1;
                        if i >= stream.len() {
                            break;
                        }
                        match stream[i] {
                            b'n' => buf.push(b'\n'),
                            b'r' => buf.push(b'\r'),
                            b't' => buf.push(b'\t'),
                            b'b' => buf.push(8),
                            b'f' => buf.push(12),
                            b'\n' | b'\r' => {}
                            b'0'..=b'7' => {
                                let mut val = u32::from(stream[i] - b'0');
                                let mut count = 1;
                                while count < 3
                                    && i + 1 < stream.len()
                                    && (b'0'..=b'7').contains(&stream[i + 1])
                                {
                                    i += 1;
                                    val = val * 8 + u32::from(stream[i] - b'0');
                                    count += 1;
                                }
                                buf.push(val as u8);
                            }
                            other => buf.push(other),
                        }
                        i += 1;
                    }
                    byte => {
                        buf.push(byte);
                        i += 1;
                    }
                }
            }
            out.push(buf);
        }
        out
    }

    fn decode_byte(byte: u8) -> char {
        match byte {
            0x80 => '\u{20AC}',
            0x82 => '\u{201A}',
            0x83 => '\u{0192}',
            0x84 => '\u{201E}',
            0x85 => '\u{2026}',
            0x86 => '\u{2020}',
            0x87 => '\u{2021}',
            0x88 => '\u{02C6}',
            0x89 => '\u{2030}',
            0x8A => '\u{0160}',
            0x8B => '\u{2039}',
            0x8C => '\u{0152}',
            0x8E => '\u{017D}',
            0x91 => '\u{2018}',
            0x92 => '\u{2019}',
            0x93 => '\u{201C}',
            0x94 => '\u{201D}',
            0x95 => '\u{2022}',
            0x96 => '\u{2013}',
            0x97 => '\u{2014}',
            0x98 => '\u{02DC}',
            0x99 => '\u{2122}',
            0x9A => '\u{0161}',
            0x9B => '\u{203A}',
            0x9C => '\u{0153}',
            0x9E => '\u{017E}',
            0x9F => '\u{0178}',
            0x20..=0x7E | 0xA0..=0xFF => char::from_u32(u32::from(byte)).unwrap_or('?'),
            _ => '?',
        }
    }

    fn pdf_lines(pdf: &[u8]) -> Vec<String> {
        content_streams(pdf)
            .into_iter()
            .flat_map(pdf_literals)
            .map(|bytes| bytes.into_iter().map(decode_byte).collect())
            .collect()
    }

    fn pdf_words(pdf: &[u8]) -> String {
        pdf_lines(pdf)
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn pdf_page_count(pdf: &[u8]) -> usize {
        let key = b"/Count ";
        let at = find_bytes(pdf, key).unwrap() + key.len();
        let end = pdf[at..]
            .iter()
            .position(|byte| !byte.is_ascii_digit())
            .unwrap()
            + at;
        std::str::from_utf8(&pdf[at..end]).unwrap().parse().unwrap()
    }

    fn page_object_count(pdf: &[u8]) -> usize {
        let key = b"/Type /Page";
        let mut count = 0;
        let mut i = 0;
        while let Some(rel) = find_bytes(&pdf[i..], key) {
            let at = i + rel + key.len();
            if pdf.get(at) != Some(&b's') {
                count += 1;
            }
            i = at;
        }
        count
    }

    fn draw(title: &str, body: &str) -> Vec<u8> {
        markdown_to_pdf(title, body, "").unwrap()
    }

    fn assert_well_formed(pdf: &[u8]) {
        assert!(pdf.starts_with(b"%PDF-1.4\n"));
        assert!(pdf.ends_with(b"%%EOF\n"));
        let start = find_bytes(pdf, b"startxref\n").unwrap();
        let num_at = start + b"startxref\n".len();
        let num_end = pdf[num_at..]
            .iter()
            .position(|byte| !byte.is_ascii_digit())
            .unwrap()
            + num_at;
        let xref: usize = std::str::from_utf8(&pdf[num_at..num_end])
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(&pdf[xref..xref + 4], b"xref");
        assert_eq!(page_object_count(pdf), pdf_page_count(pdf));
        let _ = content_streams(pdf);
    }

    #[test]
    fn publisher_draft_keeps_headings_and_paragraphs() {
        let pdf = draw(
            "",
            "# Chapter One\r\n\r\nThe river was wide.\r\n\r\n## The bend\r\n\r\nIt narrowed.\r\n",
        );
        assert_well_formed(&pdf);
        assert_eq!(pdf_page_count(&pdf), 1);
        let words = pdf_words(&pdf);
        assert!(words.contains("Chapter One"));
        assert!(words.contains("The river was wide."));
        assert!(words.contains("The bend"));
        assert!(words.contains("It narrowed."));
        let raw = String::from_utf8_lossy(&pdf);
        assert!(raw.contains("/F2 18 Tf"));
        assert!(raw.contains("/F2 14 Tf"));
        assert!(raw.contains("/F1 11 Tf"));

        let blank = draw("", "");
        assert_well_formed(&blank);
        assert_eq!(pdf_page_count(&blank), 1);
        assert!(pdf_lines(&blank).is_empty());
    }

    #[test]
    fn title_is_not_repeated_when_the_body_starts_with_it() {
        let pdf = draw("Harbor", "# Harbor\n\nThe dock.\n");
        assert_eq!(pdf_words(&pdf).matches("Harbor").count(), 1);
        assert!(pdf_words(&pdf).contains("The dock."));
    }

    #[test]
    fn document_title_leads_when_the_body_has_another_heading() {
        let words = pdf_words(&draw("The Book", "# Chapter 1\n\nHello.\n"));
        assert!(words.starts_with("The Book"));
        assert!(words.contains("Chapter 1"));
        assert!(words.contains("Hello."));
    }

    #[test]
    fn inline_markup_keeps_emphasis_and_the_url() {
        let body = "\
See **bold** and *italic* and `code_here` and ~~gone~~ and snake_case.
Read [the book](https://example.com/secret).
A \\*star\\* stays.
";
        let pdf = draw("", body);
        let words = pdf_words(&pdf);
        assert!(words.contains("See bold and italic and code_here and gone and snake_case."));
        assert!(words.contains("the book (https://example.com/secret)"));
        assert!(words.contains("A *star* stays."));
        assert!(!words.contains("**"));
        let raw = String::from_utf8_lossy(&pdf);
        assert!(raw.contains("/F2 11 Tf"));
        assert!(raw.contains("/F4 11 Tf"));
        assert!(raw.contains("/URI"));
        let err = markdown_to_pdf("", "![A harbor](h.png)\n", "").unwrap_err();
        assert!(err.to_string().contains("couldn't find"));
    }

    #[test]
    fn a_long_link_is_stored_once_and_an_underscore_word_stays() {
        let url = format!("https://example.com/{}", "a".repeat(4_000));
        let pdf = draw("", &format!("See [notes]({url}).\n"));
        assert_well_formed(&pdf);
        let copies = pdf
            .windows(url.len())
            .filter(|window| *window == url.as_bytes())
            .count();
        assert_eq!(copies, 1);
        assert!(pdf.len() < url.len() * 8);
        assert!(pdf_words(&pdf).contains("notes"));
        assert!(pdf_words(&pdf).contains("https://example.com/"));

        let words = pdf_words(&draw("", "A snake_case_variable and _quiet_ water.\n"));
        assert!(words.contains("snake_case_variable"));
        assert!(words.contains("quiet"));
        assert!(!words.contains("snakecasevariable"));
    }

    #[test]
    fn lists_quotes_code_and_setext_stay_readable() {
        let body = "\
Harbor
======

- salt
- bread
  and butter

1. one

> The dock held.

```
keep   spaces
# not a heading
```
";
        let pdf = draw("", body);
        let lines = pdf_lines(&pdf);
        let words = pdf_words(&pdf);
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.as_str() == "Harbor")
                .count(),
            1
        );
        assert!(words.contains("• salt"));
        assert!(words.contains("• bread and butter"));
        assert!(words.contains("1. one"));
        assert!(words.contains("The dock held."));
        assert!(lines.iter().any(|line| line == "keep   spaces"));
        assert!(lines.iter().any(|line| line == "# not a heading"));
        assert!(String::from_utf8_lossy(&pdf).contains("/F3 9 Tf"));
    }

    #[test]
    fn a_long_fallback_code_line_wraps_without_copying_the_prefix() {
        let han = "港".repeat(80);
        let line = format!("{han}AAAA");
        let wrapped = wrap_pre(&[line.clone()], 9);
        assert!(wrapped.len() > 1, "{}", wrapped.len());
        assert_eq!(wrapped.concat(), line);
        for part in &wrapped {
            assert!(text_width(part, Face::Courier, 9) <= CONTENT_W);
        }
    }

    #[test]
    fn punctuation_stays_and_an_undrawable_character_writes_nothing() {
        let pdf = draw("", "Width — and “quotes”.\n\nSee (note) and C:\\notes.\n");
        let words = pdf_words(&pdf);
        assert!(words.contains("Width — and “quotes”."));
        assert!(words.contains("See (note) and C:\\notes."));
        assert!(pdf.windows(4).any(|window| window == b"\\227"));
        assert!(pdf.windows(4).any(|window| window == b"\\223"));
        let snow = draw("", "Snow 雪 falls.\n");
        assert!(String::from_utf8_lossy(&snow).contains("96EA"));
        let err = markdown_to_pdf("", "Linear \u{10000} B.\n", "").unwrap_err();
        assert!(err.to_string().contains("isn't in Times"));
    }

    #[test]
    fn han_and_the_wave_keep_a_unicode_map() {
        let pdf = draw("", "Harbor 港 and 🌊.\n");
        let raw = String::from_utf8_lossy(&pdf);
        assert!(raw.contains("6E2F"));
        assert!(raw.contains("D83CDF0A"));
        assert!(raw.contains("/F1"));
        assert!(raw.contains("/F6"));
        assert!(raw.contains("/F7"));
        assert!(pdf_words(&pdf).contains("Harbor"));
    }

    #[test]
    fn lines_fit_the_page_and_a_long_draft_continues() {
        assert_eq!(TIMES_ROMAN[b'M' as usize], 889);
        assert_eq!(TIMES_ROMAN[b'i' as usize], 278);
        assert_eq!(TIMES_BOLD[b'M' as usize], 944);
        let (wide, _) = layout_blocks(&[Block::Paragraph("M".repeat(80))], &[]).unwrap();
        let (narrow, _) = layout_blocks(&[Block::Paragraph("i".repeat(80))], &[]).unwrap();
        let count = |pages: &[Page]| pages.iter().map(|page| page.lines.len()).sum::<usize>();
        assert!(count(&wide) > count(&narrow));
        assert_eq!(wide[0].lines[0].runs[0].text.chars().count(), 46);

        let body = format!(
            "# Start\n\n{}\n\nEnd of the draft.\n",
            "The river was wide. ".repeat(400)
        );
        let (blocks, images) = document_blocks("", &body, "").unwrap();
        let (pages, urls) = layout_blocks(&blocks, &images).unwrap();
        assert!(pages.len() >= 2);
        for page in &pages {
            let mut previous_y = i32::MAX;
            for line in &page.lines {
                let width: i32 = line
                    .runs
                    .iter()
                    .map(|run| text_width(&run.text, run.face, line.size))
                    .sum();
                assert!(line.x >= MARGIN_X);
                assert!(line.x + width <= PAGE_W - MARGIN_X);
                assert!(line.y >= MARGIN_Y);
                assert!(line.y <= PAGE_H - MARGIN_Y);
                assert!(line.y < previous_y);
                previous_y = line.y;
            }
        }
        let pdf = render(&pages, &images, &urls).unwrap();
        assert_well_formed(&pdf);
        assert_eq!(pdf_page_count(&pdf), pages.len());
        let words = pdf_words(&pdf);
        assert!(words.contains("Start"));
        assert!(words.contains("End of the draft."));
    }

    #[test]
    fn endstream_in_the_prose_does_not_cut_the_page() {
        let pdf = draw("", "The word endstream sits in the sentence.\n");
        assert_well_formed(&pdf);
        assert!(pdf_words(&pdf).contains("The word endstream sits in the sentence."));
    }

    #[test]
    fn write_pdf_file_replaces_a_pdf_and_refuses_markdown() {
        let dir = tempfile::tempdir().unwrap();
        let pdf_path = dir.path().join("note.pdf");
        write_pdf_file(pdf_path.to_str().unwrap(), "Harbor", "The dock.\n", "").unwrap();
        let bytes = fs::read(&pdf_path).unwrap();
        assert_eq!(bytes, draw("Harbor", "The dock.\n"));
        write_pdf_file(pdf_path.to_str().unwrap(), "Harbor", "Again.\n", "").unwrap();
        assert!(pdf_words(&fs::read(&pdf_path).unwrap()).contains("Again."));
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["note.pdf".to_string()]);

        for name in ["note.md", "note.MD", "note.markdown"] {
            let path = dir.path().join(name);
            assert!(write_pdf_file(path.to_str().unwrap(), "T", "Hi", "").is_err());
            assert!(!path.exists());
        }
        assert!(write_pdf_file("   ", "T", "Hi", "").is_err());
    }
}
