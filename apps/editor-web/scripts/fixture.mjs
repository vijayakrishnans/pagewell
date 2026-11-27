// A generated PDF for /edit/fixture and the budget tests: `pages` US Letter pages, each with a
// heading and a few lines of placeholder text. Never a real document.

export function fixturePdf(pages) {
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;

  const catalog = add(null);
  const pageTree = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const kids = [];
  for (let n = 1; n <= pages; n++) {
    const lines = [
      `BT /F1 24 Tf 72 700 Td (Pagewell fixture) Tj ET`,
      `BT /F1 14 Tf 72 670 Td (Page ${n} of ${pages}) Tj ET`,
      ...Array.from({ length: 8 }, (_, i) => `BT /F1 11 Tf 72 ${630 - i * 18} Td (Generated placeholder line ${i + 1}. Nothing here is a real document.) Tj ET`),
    ].join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(lines, "latin1")} >>\nstream\n${lines}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`;
  objects[pageTree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${pages} >>`;
  const info = add("<< /Title (Pagewell fixture) /Producer (Pagewell) >>");

  let out = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
