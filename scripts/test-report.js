import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tapInput = process.argv[2];
const outputDir = resolve(__dirname, '../reports');
const outputPath = resolve(outputDir, 'test-report.html');

const tap = tapInput ? readFileSync(tapInput, 'utf-8') : '';
const lines = tap.split('\n');

const tests = [];
let current = null;
let summary = { total: 0, passed: 0, failed: 0, skipped: 0 };

for (const line of lines) {
  if (line.startsWith('ok ')) {
    const name = line.replace(/^ok \d+( -)? /, '').replace(/ # .*/, '');
    const directive = line.includes('# SKIP') ? 'skipped' : 'passed';
    tests.push({ name, status: directive, message: '' });
    summary.total++;
    if (directive === 'skipped') summary.skipped++;
    else summary.passed++;
    current = null;
  } else if (line.startsWith('not ok ')) {
    const name = line.replace(/^not ok \d+( -)? /, '').replace(/ # .*/, '');
    current = { name, status: 'failed', message: '' };
    tests.push(current);
    summary.total++;
    summary.failed++;
  } else if (line.startsWith('  ') && current && line.trim()) {
    current.message += line.trim() + '\n';
  } else if (line.trim() && !line.startsWith('#') && current) {
    // Non-indented, non-comment line after a failure ends the failure context.
    current = null;
  } else if (line.startsWith('# tests ')) {
    summary.total = Number(line.replace('# tests ', '').trim()) || summary.total;
  } else if (line.startsWith('# pass ')) {
    summary.passed = Number(line.replace('# pass ', '').trim()) || summary.passed;
  } else if (line.startsWith('# fail ')) {
    summary.failed = Number(line.replace('# fail ', '').trim()) || summary.failed;
  }
}

const statusClass = summary.failed > 0 ? 'fail' : summary.skipped > 0 ? 'warn' : 'pass';

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>iRoute Test Report</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; margin: 2rem; background: #0d1117; color: #c9d1d9; }
    h1 { margin-bottom: 0.5rem; }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin: 1.5rem 0; }
    .card { padding: 1rem; border-radius: 0.5rem; background: #161b22; border: 1px solid #30363d; }
    .card .value { font-size: 2rem; font-weight: 700; }
    .pass { color: #3fb950; }
    .fail { color: #f85149; }
    .warn { color: #d29922; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #30363d; }
    th { background: #161b22; color: #f0f6fc; }
    td.status { font-weight: 600; text-transform: uppercase; }
    tr:hover { background: #161b22; }
    pre { background: #0d1117; padding: 0.75rem; border-radius: 0.25rem; overflow-x: auto; border: 1px solid #30363d; color: #f85149; }
  </style>
</head>
<body>
  <h1>iRoute Test Report</h1>
  <p>Generated at ${new Date().toISOString()}</p>

  <div class="summary">
    <div class="card"><div class="value ${statusClass}">${summary.total}</div><div>Total</div></div>
    <div class="card"><div class="value pass">${summary.passed}</div><div>Passed</div></div>
    <div class="card"><div class="value fail">${summary.failed}</div><div>Failed</div></div>
    <div class="card"><div class="value warn">${summary.skipped}</div><div>Skipped</div></div>
  </div>

  <table>
    <thead>
      <tr><th>Status</th><th>Test</th><th>Message</th></tr>
    </thead>
    <tbody>
      ${tests.map(t => `
        <tr>
          <td class="status ${t.status === 'passed' ? 'pass' : t.status === 'failed' ? 'fail' : 'warn'}">${t.status}</td>
          <td>${escapeHtml(t.name)}</td>
          <td>${t.message ? `<pre>${escapeHtml(t.message)}</pre>` : '-'}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
</body>
</html>`;

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputPath, html);
console.log(`Test report written to ${outputPath}`);
console.log(`Total: ${summary.total}, Passed: ${summary.passed}, Failed: ${summary.failed}, Skipped: ${summary.skipped}`);
process.exit(summary.failed > 0 ? 1 : 0);
