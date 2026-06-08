import { afterEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { processRegistry, resolveRegistryAssetUrl } from "./postprocess-registry";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidoku-community-js-"));
  tempDirs.push(dir);
  return dir;
}

describe("postprocess registry", () => {
  it("resolves relative URLs from the upstream registry URL", () => {
    expect(resolveRegistryAssetUrl("https://example.com/root/index.min.json", "sources/a.aix")).toBe(
      "https://example.com/root/sources/a.aix"
    );
    expect(resolveRegistryAssetUrl("https://example.com/root/index.min.json", "https://cdn.example/a.aix")).toBe(
      "https://cdn.example/a.aix"
    );
  });

  it("can mirror AIX artifacts and point downloadURL at the mirrored artifact", async () => {
    const root = createTempDir();
    const distDir = path.join(root, "dist");
    const registryDir = path.join(distDir, "test-registry");
    const reposDir = path.join(root, "repos");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.mkdirSync(reposDir, { recursive: true });

    fs.writeFileSync(
      path.join(registryDir, "upstream.json"),
      JSON.stringify({
        name: "Test Registry",
        sources: [
          {
            id: "source.one",
            name: "Source One",
            version: 7,
            iconURL: "icons/source.one.png",
            downloadURL: "sources/source.one-v7.aix",
            languages: ["en"],
          },
        ],
      })
    );

    const aixBytes = new Uint8Array([1, 3, 3, 7]);
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://upstream.example/root/sources/source.one-v7.aix");
      return new Response(aixBytes);
    });

    await processRegistry(
      {
        id: "test-registry",
        name: "Test Registry",
        url: "https://upstream.example/root/index.min.json",
        repo: "https://github.com/example/sources",
        hasHistoricalCommits: false,
      },
      {
        distDir,
        reposDir,
        mirrorAix: true,
        publicBaseUrl: "https://pages.example/aidoku-community-js",
        fetch: fetchMock,
      }
    );

    const mirroredPath = path.join(registryDir, "sources/source.one-v7.aix");
    expect(fs.existsSync(mirroredPath)).toBe(true);
    expect(new Uint8Array(fs.readFileSync(mirroredPath))).toEqual(aixBytes);

    const index = JSON.parse(fs.readFileSync(path.join(registryDir, "index.json"), "utf-8"));
    const [source] = index.sources;
    expect(source.iconURL).toBe("https://upstream.example/root/icons/source.one.png");
    expect(source.downloadURL).toBe(
      "https://pages.example/aidoku-community-js/test-registry/sources/source.one-v7.aix"
    );
    expect(source.artifact).toEqual({
      upstreamURL: "https://upstream.example/root/sources/source.one-v7.aix",
      mirroredURL: "https://pages.example/aidoku-community-js/test-registry/sources/source.one-v7.aix",
      path: "test-registry/sources/source.one-v7.aix",
      bytes: 4,
      sha256: createHash("sha256").update(aixBytes).digest("hex"),
    });
  });
});
