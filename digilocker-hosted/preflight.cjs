"use strict";
const { countPdf } = require("../digilocker-local/documents.cjs");

// Exercise the actual isolated PDF worker before advertising readiness. This
// generated blank page contains no customer data and needs no provider request.
function probePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += "xref\n0 4\n0000000000 65535 f \n";
  pdf += offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function parserPreflight(config) {
  try {
    if (await countPdf(probePdf(), config.frontend) !== 1) throw new Error();
    if(config.pdfUnlock){
      const opened=await require("../digilocker-local/unlock-pdf.cjs").unlockPdf(probePdf(),"startup-probe",config);
      opened.bytes.fill(0);
    }
  } catch {
    throw Object.assign(new Error("PDF parser startup check failed"), { code: "PDF_PARSER_UNAVAILABLE" });
  }
}
module.exports = { parserPreflight, probePdf };
