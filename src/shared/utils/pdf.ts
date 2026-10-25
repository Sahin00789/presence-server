/**
 * Minimal dependency-free PDF writer used by the reporting module.
 *
 * Reports only need tabular text, so a tiny PDF 1.4 generator is sufficient and
 * keeps the backend free of heavyweight rendering dependencies. Money values are
 * always passed in as pre-formatted integer strings.
 */

function escapePdfText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7E]/g, '?');
}

function wrapLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) {
    return [line];
  }

  const parts: string[] = [];
  let remaining = line;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf(' ', maxChars);
    if (cut <= 0) {
      cut = maxChars;
    }
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) {
    parts.push(remaining);
  }
  return parts;
}

export interface PdfTable {
  title: string;
  subtitle?: string;
  columns: string[];
  rows: Array<Array<string | number>>;
}

/**
 * Builds a printable PDF document containing a heading and a text table.
 */
export function buildPdfReport(table: PdfTable): Buffer {
  const maxChars = 108;
  const lines: string[] = [];

  lines.push(table.title);
  if (table.subtitle) {
    lines.push(table.subtitle);
  }
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(table.columns.join(' | '));
  lines.push('-'.repeat(Math.min(maxChars, table.columns.join(' | ').length)));

  for (const row of table.rows) {
    const text = row
      .map((cell) => String(cell ?? ''))
      .join(' | ');
    lines.push(...wrapLine(text, maxChars));
  }

  const linesPerPage = 58;
  const pages: string[][] = [];
  for (let index = 0; index < lines.length; index += linesPerPage) {
    pages.push(lines.slice(index, index + linesPerPage));
  }
  if (pages.length === 0) {
    pages.push(['No data']);
  }

  const objects: string[] = [];
  const pageObjectNumbers = pages.map((_, index) => 4 + index * 2);
  const fontObjectNumber = 3;

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Kids [${pageObjectNumbers
      .map((number) => `${number} 0 R`)
      .join(' ')}] /Count ${pages.length} >>`
  );
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');

  pages.forEach((pageLines, index) => {
    const pageObjectNumber = 4 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;

    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`
    );

    const body = [
      'BT',
      '/F1 8 Tf',
      '40 800 Td',
      '10 TL',
      ...pageLines.map((line) => `(${escapePdfText(line)}) Tj T*`),
      'ET',
    ].join('\n');

    objects.push(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`);
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}
