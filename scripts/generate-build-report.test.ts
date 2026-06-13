import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { generateBuildReport } from "./generate-build-report";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidoku-build-report-"));
  tempDirs.push(dir);
  return dir;
}

describe("generate build report", () => {
  it("includes runtime SHA and mirrored artifact metadata", () => {
    const root = createTempDir();
    const cacheDir = path.join(root, ".cache/build-results");
    const distDir = path.join(root, "dist");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(path.join(distDir, "test-registry"), { recursive: true });

    fs.writeFileSync(
      path.join(cacheDir, "chunk-0.json"),
      JSON.stringify({
        chunk: 0,
        runtime: {
          aidokuJsSha: "abc123",
        },
        sources: [
          {
            id: "source.one",
            name: "Source One",
            registry: "test-registry",
            test: {
              status: "pass",
              durationMs: 250,
              summary: { passed: 7, failed: 0 },
              results: [{ test: "image", passed: true }],
            },
          },
        ],
      })
    );

    fs.writeFileSync(
      path.join(distDir, "test-registry/index.json"),
      JSON.stringify({
        name: "Test Registry",
        sources: [
          {
            id: "source.one",
            name: "Source One",
            artifact: {
              upstreamURL: "https://upstream.example/source.one-v1.aix",
              mirroredURL: "https://pages.example/test-registry/sources/source.one-v1.aix",
              path: "test-registry/sources/source.one-v1.aix",
              bytes: 4,
              sha256: "sha256",
            },
          },
        ],
      })
    );

    const report = generateBuildReport({
      cacheDir,
      distDir,
      env: {
        GITHUB_SHA: "def456",
        GITHUB_RUN_ID: "12345",
      },
    });

    expect(report.runtime.aidokuJsShas).toEqual(["abc123"]);
    expect(report.summary.artifacts).toEqual({ total: 1, mirrored: 1 });
    expect(report.sources[0].artifact?.mirroredURL).toBe(
      "https://pages.example/test-registry/sources/source.one-v1.aix"
    );
    expect(fs.existsSync(path.join(distDir, "build-report.json"))).toBe(true);
    expect(fs.existsSync(path.join(distDir, "build-report.html"))).toBe(true);
  });
});
