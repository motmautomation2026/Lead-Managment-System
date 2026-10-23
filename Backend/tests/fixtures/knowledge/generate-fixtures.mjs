// Regenerates the tiny knowledge-base extraction fixtures in this folder.
// Run from Backend/: node tests/fixtures/knowledge/generate-fixtures.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const dir = fileURLToPath(new URL(".", import.meta.url));
const out = (name, data) => writeFileSync(`${dir}${name}`, data);
// Fixed timestamps keep the zip bytes stable between runs.
const zipOptions = { type: "nodebuffer", compression: "DEFLATE" };
const fixedDate = new Date("2026-01-01T00:00:00Z");
const zipFile = (zip, path, content) => zip.file(path, content, { date: fixedDate });

// --- TXT / MD
out("sample.txt", "Northbeam helps B2B companies   find buyers.\r\n\r\n\r\nWe run outbound   campaigns.\n");
out(
  "sample.md",
  "# Services\n\nWe offer *lead generation* and **cold calling**.\n\n## Pricing\n\nPlans start at ₹50,000 per month.\n\n- Setup in two weeks\n- Cancel anytime\n",
);

// --- PDF: 3 pages, each with the same header and a "Page N" footer.
function pdf(pages) {
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids = pages.map((lines) => {
    const stream = lines.length
      ? "BT /F1 12 Tf 72 720 Td 16 TL " + lines.map((line) => `(${line}) Tj T*`).join(" ") + " ET"
      : "0 0 0 rg 72 72 400 600 re f"; // an image-like filled box, no text
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
out(
  "sample.pdf",
  pdf([
    ["Northbeam Confidential", "Our process starts with research.", "Page 1"],
    ["Northbeam Confidential", "Then we run outreach campaigns.", "Page 2"],
    ["Northbeam Confidential", "Finally we hand over warm meetings.", "Page 3"],
  ]),
);
out("scanned.pdf", pdf([[]]));

// --- DOCX: a heading, a paragraph, a second heading and a paragraph.
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text, style) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
{
  const zip = new JSZip();
  zipFile(
    zip,
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  );
  zipFile(
    zip,
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zipFile(
    zip,
    "word/_rels/document.xml.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  );
  zipFile(
    zip,
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
  );
  zipFile(
    zip,
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${para("Case study: Acme", "Heading1")}${para("Acme doubled its pipeline in 90 days.")}${para("Results", "Heading1")}${para("40 meetings &amp; 6 new clients.")}</w:body></w:document>`,
  );
  out("sample.docx", await zip.generateAsync(zipOptions));
}

// --- PPTX: two slides, listed in presentation.xml in the order 2nd file first.
{
  const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const slide = (...paragraphs) =>
    `<?xml version="1.0" encoding="UTF-8"?><p:sld ${P}><p:cSld><p:spTree>${paragraphs
      .map((runs) => `<p:sp><p:txBody>${runs.map((p) => `<a:p>${p.map((t) => `<a:r><a:t>${t}</a:t></a:r>`).join("")}</a:p>`).join("")}</p:txBody></p:sp>`)
      .join("")}</p:spTree></p:cSld></p:sld>`;
  const zip = new JSZip();
  zipFile(
    zip,
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
  );
  zipFile(
    zip,
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`,
  );
  zipFile(
    zip,
    "ppt/_rels/presentation.xml.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
  );
  zipFile(zip, "ppt/slides/slide2.xml", slide([["Why Northbeam"]], [["Senior callers, "], ["no scripts."]]));
  zipFile(zip, "ppt/slides/slide1.xml", slide([["Our results"]], [["3x reply rates"], ["&lt;30 day ramp"]]));
  out("sample.pptx", await zip.generateAsync(zipOptions));
}
console.log("fixtures written to", dir);
