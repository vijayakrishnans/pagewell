// Generated PDFs for pdf-runner's tests: never a real document. Plain text pages, a page with a
// filled form field, and a page with a redaction mark over a line of text.

function build(objects, catalogExtra = "") {
  let out = "%PDF-1.7\n";
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  void catalogExtra;
  return Buffer.from(out, "latin1");
}

const stream = (text) => `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;

/** `pages` pages of generated text; page i says "Generated page i". */
export function textPdf(pages = 3, tag = "") {
  const objects = [];
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let i = 0; i < pages; i++) {
    const text = `BT /F1 28 Tf 72 700 Td (Generated page ${i + 1} ${tag}) Tj 0 -40 Td /F1 14 Tf (Nothing here is a real document.) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(stream(text));
  }
  return build(objects);
}

/** One page with a filled text field (with its appearance), for flatten. */
export function formPdf() {
  const ap = "/Tx BMC BT /F1 12 Tf 2 6 Td (Generated value) Tj ET EMC";
  return build([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] /DA (/F1 12 Tf 0 g) /DR << /Font << /F1 3 0 R >> >> >> >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>",
    stream("BT /F1 18 Tf 72 720 Td (Generated form) Tj ET"),
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Generated value) /DA (/F1 12 Tf 0 g) /Rect [72 600 300 624] /P 4 0 R /F 4 /AP << /N 7 0 R >> >>",
    `<< /Type /XObject /Subtype /Form /BBox [0 0 228 24] /Resources << /Font << /F1 3 0 R >> >> /Length ${ap.length} >>\nstream\n${ap}\nendstream`,
  ]);
}

/** One page whose first line is covered by a redaction mark; the second line is not. */
export function redactPdf() {
  return build([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>",
    stream("BT /F1 18 Tf 72 720 Td (Hidden generated words) Tj 0 -60 Td (Visible generated words) Tj ET"),
    "<< /Type /Annot /Subtype /Redact /Rect [60 705 400 745] /QuadPoints [60 745 400 745 60 705 400 705] /IC [0 0 0] /P 4 0 R >>",
  ]);
}

/** A small generated PNG (a dark stroke on transparency), standing in for a drawn signature. */
export async function signaturePng(width = 120, height = 40) {
  const { deflateSync } = await import("node:zlib");
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const on = Math.abs(y - (height / 2 + Math.sin(x / 8) * (height / 4))) < 2;
      const o = y * (width * 4 + 1) + 1 + x * 4;
      raw[o] = 20;
      raw[o + 1] = 30;
      raw[o + 2] = 90;
      raw[o + 3] = on ? 255 : 0;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** The options of a generated envelope's completion (two documents, two signers). */
export function completionOptions() {
  return {
    fields: [
      { doc: 0, page: 1, kind: "signature", rect: [72, 600, 200, 40], text: "Ann Example" },
      { doc: 0, page: 1, kind: "date", rect: [300, 610, 120, 20], text: "2026-11-28" },
      { doc: 0, page: 2, kind: "checkbox", rect: [72, 500, 14, 14], checked: true },
      { doc: 0, page: 2, kind: "text", rect: [100, 500, 200, 16], text: "Generated note" },
      { doc: 1, page: 1, kind: "signature", rect: [72, 600, 200, 40], image: 0 },
      { doc: 1, page: 1, kind: "initials", rect: [300, 600, 60, 30], text: "BE" },
    ],
    certificate: {
      envelopeId: "env_generated",
      title: "Generated agreement",
      completedAt: "2026-11-28T10:05:00Z",
      documents: [
        { name: "Generated A.pdf", version: 3, sha256: "a".repeat(64) },
        { name: "Generated B.pdf", version: 1, sha256: "b".repeat(64) },
      ],
      signers: [
        { name: "Ann Example", email: "ann@example.com", signedAt: "2026-11-28T10:00:00Z", ip: "203.0.113.7" },
        { name: "Ben Example", email: "ben@example.com", signedAt: "2026-11-28T10:04:00Z", ip: "198.51.100.4" },
      ],
      evidenceHead: "c".repeat(64),
    },
  };
}
