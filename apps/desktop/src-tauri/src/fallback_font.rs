//! Outline fonts for PDF characters Times cannot draw, and for SVG text.
//!
//! Times stays the face for WinAnsi. Droid Sans Fallback covers Han and the
//! other BMP letters in that file. Noto Emoji covers the outline emoji in
//! that file. A character in none of the three stops the export. SVG Latin
//! uses Newsreader, the face in `fonts/` beside the other two, and is not embedded
//! in the PDF.
//!
//! shortcut: a PDF that needs one of these fonts embeds the whole file.
//! Upgrade path: subset the glyf table to the characters on the page.

use crate::error::AppError;
use std::sync::OnceLock;
use ttf_parser::Face;

pub const DROID: &[u8] = include_bytes!("../fonts/DroidSansFallbackFull.ttf");
pub const EMOJI: &[u8] = include_bytes!("../fonts/NotoEmoji-Regular.ttf");
/// Typographic family name is Newsreader. SVG generic families point here.
pub const NEWSREADER: &[u8] = include_bytes!("../fonts/Newsreader-Variable.ttf");

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Droid,
    Emoji,
}

pub fn covers(kind: Kind, ch: char) -> bool {
    glyph(kind, ch).is_some()
}

pub fn glyph(kind: Kind, ch: char) -> Option<(u16, u16)> {
    let face = face(kind);
    let id = face.glyph_index(ch)?;
    if id.0 == 0 {
        return None;
    }
    let advance = face.glyph_hor_advance(id).unwrap_or(face.units_per_em());
    Some((id.0, advance))
}

pub fn units_per_em(kind: Kind) -> u16 {
    face(kind).units_per_em()
}

pub fn missing(ch: char) -> String {
    format!(
        "Alkuin can't draw \"{ch}\" in the PDF. It isn't in Times, Droid Sans Fallback, or Noto Emoji."
    )
}

fn face(kind: Kind) -> &'static Face<'static> {
    match kind {
        Kind::Droid => {
            DROID_FACE.get_or_init(|| Face::parse(DROID, 0).expect("Droid Sans Fallback"))
        }
        Kind::Emoji => EMOJI_FACE.get_or_init(|| Face::parse(EMOJI, 0).expect("Noto Emoji")),
    }
}

static DROID_FACE: OnceLock<Face<'static>> = OnceLock::new();
static EMOJI_FACE: OnceLock<Face<'static>> = OnceLock::new();

/// Append a Type0 font and return its object id. `chars` are the characters
/// this export actually shows in that font.
pub fn embed(objects: &mut Vec<Vec<u8>>, kind: Kind, chars: &[char]) -> Result<usize, AppError> {
    let bytes = match kind {
        Kind::Droid => DROID,
        Kind::Emoji => EMOJI,
    };
    let name = match kind {
        Kind::Droid => "DroidSansFallback",
        Kind::Emoji => "NotoEmoji",
    };
    let face = face(kind);
    let mut used = Vec::new();
    for ch in chars {
        if let Some((gid, advance)) = glyph(kind, *ch) {
            if !used.iter().any(|(id, _)| *id == gid) {
                used.push((gid, (*ch, advance)));
            }
        }
    }
    let file_id = objects.len() + 1;
    objects.push(font_file(bytes)?);
    let descriptor_id = objects.len() + 1;
    objects.push(font_descriptor(name, face, file_id).into_bytes());
    let cid_id = objects.len() + 1;
    objects.push(cid_font(name, face, descriptor_id, &used).into_bytes());
    let unicode_id = objects.len() + 1;
    objects.push(to_unicode(&used).into_bytes());
    let type0_id = objects.len() + 1;
    objects.push(type0(name, cid_id, unicode_id).into_bytes());
    Ok(type0_id)
}

pub fn glyph_hex(kind: Kind, text: &str) -> Result<String, AppError> {
    let mut hex = String::from("<");
    for ch in text.chars() {
        let (gid, _) = glyph(kind, ch).ok_or_else(|| AppError::Message(missing(ch)))?;
        hex.push_str(&format!("{gid:04X}"));
    }
    hex.push('>');
    Ok(hex)
}

fn font_file(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut encoder, bytes).map_err(|err| AppError::Io(err.to_string()))?;
    let data = encoder
        .finish()
        .map_err(|err| AppError::Io(err.to_string()))?;
    let mut object = format!(
        "<< /Length {} /Length1 {} /Filter /FlateDecode >>\nstream\n",
        data.len(),
        bytes.len()
    )
    .into_bytes();
    object.extend(data);
    object.extend(b"\nendstream");
    Ok(object)
}

fn font_descriptor(name: &str, face: &Face, file_id: usize) -> String {
    let bbox = face.global_bounding_box();
    let (x_min, y_min, x_max, y_max) = (bbox.x_min, bbox.y_min, bbox.x_max, bbox.y_max);
    format!(
        "<< /Type /FontDescriptor /FontName /{name} /Flags 4 /FontBBox [{x_min} {y_min} {x_max} {y_max}] /ItalicAngle 0 /Ascent {} /Descent {} /CapHeight {} /StemV 80 /FontFile2 {file_id} 0 R >>",
        face.ascender(),
        face.descender(),
        face.capital_height().unwrap_or(face.ascender())
    )
}

fn cid_font(name: &str, face: &Face, descriptor_id: usize, used: &[(u16, (char, u16))]) -> String {
    let upem = u32::from(face.units_per_em().max(1));
    let mut widths = String::from("[");
    for (gid, (_, advance)) in used {
        let width = u32::from(*advance) * 1000 / upem;
        widths.push_str(&format!("{gid} [{width}] "));
    }
    widths.push(']');
    format!(
        "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor {descriptor_id} 0 R /DW 1000 /CIDToGIDMap /Identity /W {widths} >>"
    )
}

fn to_unicode(used: &[(u16, (char, u16))]) -> String {
    let mut body = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
    );
    for chunk in used.chunks(100) {
        body.push_str(&format!("{} beginbfchar\n", chunk.len()));
        for (gid, (ch, _)) in chunk {
            body.push_str(&format!("<{gid:04X}> <{}>\n", utf16_hex(*ch)));
        }
        body.push_str("endbfchar\n");
    }
    body.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    format!("<< /Length {} >>\nstream\n{body}endstream", body.len())
}

fn type0(name: &str, cid_id: usize, unicode_id: usize) -> String {
    format!(
        "<< /Type /Font /Subtype /Type0 /BaseFont /{name} /Encoding /Identity-H /DescendantFonts [{cid_id} 0 R] /ToUnicode {unicode_id} 0 R >>"
    )
}

fn utf16_hex(ch: char) -> String {
    let mut buf = [0u16; 2];
    ch.encode_utf16(&mut buf)
        .iter()
        .map(|unit| format!("{unit:04X}"))
        .collect()
}
