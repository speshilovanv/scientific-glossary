import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await mkdir('qa-papers', { recursive: true });
const papers = JSON.parse(await readFile('tests/papers.json', 'utf8'));
for (const paper of papers) {
  const path = `qa-papers/${paper.id}.pdf`;
  let bytes;
  try { bytes = await readFile(path); } catch {
    const response = await fetch(paper.url, { signal: AbortSignal.timeout(90000) });
    if (!response.ok) throw new Error(`${paper.id}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(path, bytes);
  }
  if (bytes.subarray(0, 4).toString() !== '%PDF') throw new Error(`Not a PDF: ${path}`);
  // arXiv's unversioned URLs may be updated: report the actual hash, never substitute a mock.
  console.log(paper.id, bytes.length, createHash('sha256').update(bytes).digest('hex'));
}
