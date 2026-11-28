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
