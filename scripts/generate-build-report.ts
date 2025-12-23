#!/usr/bin/env bun
/**
 * Generate build report from test results
 *
 * Usage: bun scripts/generate-build-report.ts
 *
 * Reads: .cache/build-results/*.json
 * Writes: dist/build-report.json, dist/build-report.html
 */

import * as fs from "fs";
import * as path from "path";

interface TestResult {
  test: string;
  passed: boolean;
  error?: string;
  data?: unknown;
}

interface SourceResult {
  id: string;
  name: string;
  registry?: string;
  test?: {
    status: "pass" | "fail" | "error" | "skipped";
    durationMs?: number;
    summary?: {
      passed?: number;
      failed?: number;
    };
    results?: TestResult[];
  };
}

interface ChunkResult {
  chunk: number;
  sources: SourceResult[];
}

interface BuildReport {
  timestamp: string;
  commit: string;
  runId: string;
  duration: string;
  summary: {
    total: number;
    tested: number;
    passed: number;
    failed: number;
  };
  sources: SourceResult[];
}

const TEST_TYPES = ["home", "listings", "search", "details", "chapters", "pages", "image"] as const;

const ROOT_DIR = path.join(import.meta.dirname, "..");
const cacheDir = path.join(ROOT_DIR, ".cache/build-results");
const distDir = path.join(ROOT_DIR, "dist");

const allSources: SourceResult[] = [];
const startTime = process.env.BUILD_START_TIME ? new Date(process.env.BUILD_START_TIME) : new Date();

if (fs.existsSync(cacheDir)) {
  const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(cacheDir, file), "utf-8");
      const chunk: ChunkResult = JSON.parse(content);
      allSources.push(...chunk.sources);
    } catch (e) {
      console.error(`Error reading ${file}:`, e);
    }
  }
}

allSources.sort((a, b) => a.id.localeCompare(b.id));

const summary = {
  total: allSources.length,
  tested: allSources.filter((s) => s.test).length,
  passed: allSources.filter((s) => s.test?.status === "pass").length,
  failed: allSources.filter((s) => s.test && s.test.status !== "pass" && s.test.status !== "skipped").length,
};

const endTime = new Date();
const durationMs = endTime.getTime() - startTime.getTime();
const durationStr = `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`;

const report: BuildReport = {
  timestamp: endTime.toISOString(),
  commit: process.env.GITHUB_SHA || "local",
  runId: process.env.GITHUB_RUN_ID || "local",
  duration: durationStr,
  summary,
  sources: allSources,
};

fs.mkdirSync(distDir, { recursive: true });

fs.writeFileSync(path.join(distDir, "build-report.json"), JSON.stringify(report, null, 2));

const html = generateHtmlReport(report);
fs.writeFileSync(path.join(distDir, "build-report.html"), html);

console.log(`Build report generated:`);
console.log(`  Total: ${summary.total}`);
console.log(`  Tested: ${summary.tested}`);
console.log(`  Passed: ${summary.passed} ✓`);
console.log(`  Failed: ${summary.failed} ✗`);

function getTestResult(src: SourceResult, testName: string): "pass" | "fail" | "skip" {
  const result = src.test?.results?.find((r) => r.test === testName);
  if (!result) return "skip";
  return result.passed ? "pass" : "fail";
}

function generateHtmlReport(report: BuildReport): string {
  const statusClass = (status: string) => {
    switch (status) {
      case "pass":
      case "success":
        return "success";
      case "fail":
      case "failed":
        return "failed";
      case "error":
        return "error";
      default:
        return "skipped";
    }
  };

  const testIcon = (status: "pass" | "fail" | "skip") => {
    switch (status) {
      case "pass":
        return '<span class="success">✅</span>';
      case "fail":
        return '<span class="failed">❌</span>';
      default:
        return '<span class="skipped">—</span>';
    }
  };

  const sourceRows = report.sources
    .map((src) => {
      const testStatus = src.test?.status ?? "skipped";
      const testCells = TEST_TYPES.map((t) => `<td>${testIcon(getTestResult(src, t))}</td>`).join("");

      const failedTests = src.test?.results?.filter((r) => !r.passed) ?? [];
      const errorSection =
        failedTests.length > 0
          ? `<details class="error-details"><summary>${failedTests.length} failed</summary><pre>${failedTests
              .map((t) => `${t.test}: ${escapeHtml(t.error || "unknown error")}`)
              .join("\n")}</pre></details>`
          : "";

      return `
      <tr class="${statusClass(testStatus)}">
        <td><code>${src.id}</code></td>
        <td>${src.name}</td>
        ${testCells}
        <td>${src.test?.durationMs ? `${(src.test.durationMs / 1000).toFixed(1)}s` : "-"}</td>
        <td>${errorSection}</td>
      </tr>
    `;
    })
    .join("");

  const testHeaders = TEST_TYPES.map((t) => `<th title="${t}">${t.slice(0, 4)}</th>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Aidoku Sources - Test Report</title>
  <style>
    :root {
      --bg: #0d1117;
      --bg-secondary: #161b22;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --border: #30363d;
      --success: #3fb950;
      --failed: #f85149;
      --warning: #d29922;
      --skipped: #8b949e;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 2rem;
      line-height: 1.5;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 { margin: 0 0 0.5rem; font-size: 1.75rem; }
    .meta { color: var(--text-muted); margin-bottom: 2rem; font-size: 0.9rem; }
    .meta code { background: var(--bg-secondary); padding: 0.2em 0.4em; border-radius: 4px; }
    
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      text-align: center;
    }
    .stat-value { font-size: 2rem; font-weight: bold; }
    .stat-label { color: var(--text-muted); font-size: 0.85rem; }
    .stat.success .stat-value { color: var(--success); }
    .stat.failed .stat-value { color: var(--failed); }
    
    .filters {
      margin-bottom: 1rem;
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .filter-btn {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.9rem;
    }
    .filter-btn:hover { border-color: var(--text-muted); }
    .filter-btn.active { border-color: var(--success); background: rgba(63, 185, 80, 0.1); }
    
    .table-wrapper { overflow-x: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--bg-secondary);
      border-radius: 8px;
      overflow: hidden;
      font-size: 0.9rem;
    }
    th, td {
      padding: 0.5rem 0.75rem;
      text-align: center;
      border-bottom: 1px solid var(--border);
    }
    th { 
      background: var(--bg);
      font-weight: 600;
      position: sticky;
      top: 0;
      font-size: 0.8rem;
      text-transform: capitalize;
    }
    td:first-child, td:nth-child(2), th:first-child, th:nth-child(2) { text-align: left; }
    tr:last-child td { border-bottom: none; }
    tr:hover { background: rgba(255,255,255,0.02); }
    
    .success { color: var(--success); }
    .failed { color: var(--failed); }
    .error { color: var(--warning); }
    .skipped { color: var(--skipped); }
    
    code { font-family: 'SF Mono', Consolas, monospace; font-size: 0.85em; }
    
    .error-details { margin-top: 0.25rem; }
    .error-details summary {
      cursor: pointer;
      color: var(--failed);
      font-size: 0.75rem;
    }
    .error-details pre {
      background: var(--bg);
      padding: 0.75rem;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 0.75rem;
      margin: 0.25rem 0 0;
      max-height: 200px;
      overflow-y: auto;
      text-align: left;
    }
    
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🧪 Aidoku Sources - Test Report</h1>
    <div class="meta">
      <span>Commit: <code>${report.commit.slice(0, 7)}</code></span> · 
      <span>Run: <code>#${report.runId}</code></span> · 
      <span>Duration: <strong>${report.duration}</strong></span> · 
      <span>${new Date(report.timestamp).toLocaleString()}</span>
    </div>
    
    <div class="summary">
      <div class="stat">
        <div class="stat-value">${report.summary.total}</div>
        <div class="stat-label">Total</div>
      </div>
      <div class="stat">
        <div class="stat-value">${report.summary.tested}</div>
        <div class="stat-label">Tested</div>
      </div>
      <div class="stat success">
        <div class="stat-value">${report.summary.passed}</div>
        <div class="stat-label">Passed</div>
      </div>
      <div class="stat failed">
        <div class="stat-value">${report.summary.failed}</div>
        <div class="stat-label">Failed</div>
      </div>
    </div>
    
    <div class="filters">
      <button class="filter-btn active" data-filter="all">All (${report.summary.total})</button>
      <button class="filter-btn" data-filter="success">Passed (${report.summary.passed})</button>
      <button class="filter-btn" data-filter="failed">Failed (${report.summary.failed})</button>
    </div>
    
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Source ID</th>
            <th>Name</th>
            ${testHeaders}
            <th>Time</th>
            <th>Errors</th>
          </tr>
        </thead>
        <tbody id="sources">
          ${sourceRows}
        </tbody>
      </table>
    </div>
  </div>
  
  <script>
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        const filter = btn.dataset.filter;
        document.querySelectorAll('#sources tr').forEach(row => {
          if (filter === 'all') {
            row.classList.remove('hidden');
          } else {
            row.classList.toggle('hidden', !row.classList.contains(filter));
          }
        });
      });
    });
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
