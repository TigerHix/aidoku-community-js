#!/usr/bin/env bun
/**
 * Post-process registries - adds author attribution to sources.
 *
 * Usage:
 *   bun scripts/postprocess-registry.ts
 *
 * Reads: dist/<id>/upstream.json for each registry
 * Writes: dist/<id>/index.json, dist/<id>/index.min.json
 *
 * Environment:
 *   REPOS_DIR - path to cloned source repos (default: ./repos)
 */

import { execSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { Registry, RegistrySource } from "@nemu.pm/aidoku-cli/lib/registry";

const SCRIPTS_DIR = import.meta.dirname;
const ROOT_DIR = path.join(SCRIPTS_DIR, "..");

const REGISTRIES_PATH = path.join(ROOT_DIR, "data/registries.json");
const HISTORICAL_COMMITS_PATH = path.join(ROOT_DIR, "data/historical-commits.json");
const DIST_DIR = path.join(ROOT_DIR, "dist");

const REPOS_DIR = process.env.REPOS_DIR ?? path.join(ROOT_DIR, "repos");
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ?? "https://tigerhix.github.io/aidoku-community-js";
const MIRROR_AIX = process.env.MIRROR_AIX === "true";
const AIDOKU_COMMUNITY_CUTOFF = "2025-06-12";

// Types
interface RegistryConfig {
  id: string;
  name: string;
  url: string;
  repo: string;
  hasHistoricalCommits: boolean;
}

interface ContributorData {
  email: string;
  name: string;
  commits: number;
  firstCommit: string;
}

interface AuthorOutput {
  github: string | null;
  name: string;
  commits: number;
  firstCommit: string;
}

interface ArtifactMetadata {
  upstreamURL: string;
  mirroredURL: string;
  path: string;
  bytes: number;
  sha256: string;
}

interface EnrichedSource extends RegistrySource {
  authors: AuthorOutput[];
  artifact?: ArtifactMetadata;
}

interface EnrichedRegistry {
  name: string;
  generated: string;
  upstream: string;
  sources: EnrichedSource[];
}

interface ProcessRegistryOptions {
  distDir?: string;
  reposDir?: string;
  mirrorAix?: boolean;
  publicBaseUrl?: string;
  fetch?: typeof fetch;
}

export function resolveRegistryAssetUrl(registryUrl: string, pathOrUrl: string): string {
  try {
    return new URL(pathOrUrl).toString();
  } catch {
    return new URL(pathOrUrl, registryUrl).toString();
  }
}

function joinUrl(baseUrl: string, ...parts: string[]): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedParts = parts.map((part) => part.replace(/^\/+|\/+$/g, ""));
  return [normalizedBase, ...normalizedParts].filter(Boolean).join("/");
}

function artifactFilename(source: RegistrySource, upstreamURL: string): string {
  const pathname = new URL(upstreamURL).pathname;
  return path.posix.basename(pathname) || `${source.id}-v${source.version}.aix`;
}

async function mirrorAixArtifact(
  config: RegistryConfig,
  source: RegistrySource,
  upstreamURL: string,
  options: Required<Pick<ProcessRegistryOptions, "distDir" | "publicBaseUrl" | "fetch">>
): Promise<ArtifactMetadata> {
  const filename = artifactFilename(source, upstreamURL);
  const relativePath = path.posix.join(config.id, "sources", filename);
  const outputPath = path.join(options.distDir, config.id, "sources", filename);
  const response = await options.fetch(upstreamURL);

  if (!response.ok) {
    throw new Error(`Failed to mirror ${source.id}: ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, bytes);

  return {
    upstreamURL,
    mirroredURL: joinUrl(options.publicBaseUrl, relativePath),
    path: relativePath,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

// Cache historical commits data
let historicalCommitsCache: { sources: Record<string, ContributorData[]> } | null = null;

function loadHistoricalCommits(): { sources: Record<string, ContributorData[]> } {
  if (historicalCommitsCache) return historicalCommitsCache;

  const data = fs.existsSync(HISTORICAL_COMMITS_PATH)
    ? JSON.parse(fs.readFileSync(HISTORICAL_COMMITS_PATH, "utf-8"))
    : { sources: {} };

  historicalCommitsCache = data;
  return data;
}

function extractGithubFromNoreply(email: string): string | null {
  const match = email.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/);
  return match ? match[1] : null;
}

function getRepoCommits(
  repoPath: string,
  sourceId: string,
  cutoffDate?: string
): ContributorData[] {
  // Try common source directory patterns
  const patterns = [
    `sources/${sourceId}`,
    `src/${sourceId}`,
    sourceId,
  ];

  let fullPath: string | null = null;
  for (const pattern of patterns) {
    const testPath = path.join(repoPath, pattern);
    if (fs.existsSync(testPath)) {
      fullPath = pattern;
      break;
    }
  }

  if (!fullPath) return [];

  try {
    const afterArg = cutoffDate ? `--after="${cutoffDate}"` : "";
    const output = execSync(
      `git log --format="%ae|%an|%aI" ${afterArg} -- "${fullPath}"`,
      { cwd: repoPath, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );

    const commits = output.trim().split("\n").filter(Boolean);
    const byEmail = new Map<string, { name: string; commits: number; firstCommit: string }>();

    for (const line of commits.reverse()) {
      const [email, name, date] = line.split("|");
      if (!email || !name || !date) continue;

      const dateOnly = date.split("T")[0];
      const existing = byEmail.get(email);

      if (existing) {
        existing.commits++;
        if (dateOnly < existing.firstCommit) {
          existing.firstCommit = dateOnly;
        }
      } else {
        byEmail.set(email, { name, commits: 1, firstCommit: dateOnly });
      }
    }

    return Array.from(byEmail.entries()).map(([email, data]) => ({ email, ...data }));
  } catch {
    return [];
  }
}

function mergeContributors(
  historical: ContributorData[],
  current: ContributorData[]
): AuthorOutput[] {
  // Merge by email
  const byEmail = new Map<string, ContributorData>();

  for (const c of historical) {
    byEmail.set(c.email, { ...c });
  }

  for (const c of current) {
    const existing = byEmail.get(c.email);
    if (existing) {
      existing.commits += c.commits;
      if (c.firstCommit < existing.firstCommit) {
        existing.firstCommit = c.firstCommit;
      }
    } else {
      byEmail.set(c.email, { ...c });
    }
  }

  // Dedupe by GitHub username or email
  const byIdentity = new Map<string, AuthorOutput>();

  for (const c of byEmail.values()) {
    const github = extractGithubFromNoreply(c.email);
    const key = github?.toLowerCase() ?? c.email.toLowerCase();

    const existing = byIdentity.get(key);
    if (existing) {
      existing.commits += c.commits;
      if (c.firstCommit < existing.firstCommit) {
        existing.firstCommit = c.firstCommit;
        existing.name = c.name;
      }
      if (github && !existing.github) {
        existing.github = github;
      }
    } else {
      byIdentity.set(key, {
        github,
        name: c.name,
        commits: c.commits,
        firstCommit: c.firstCommit,
      });
    }
  }

  return Array.from(byIdentity.values()).sort((a, b) =>
    a.firstCommit.localeCompare(b.firstCommit)
  );
}

export async function processRegistry(
  config: RegistryConfig,
  options: ProcessRegistryOptions = {}
): Promise<void> {
  const distDir = options.distDir ?? DIST_DIR;
  const reposDir = options.reposDir ?? REPOS_DIR;
  const mirrorAix = options.mirrorAix ?? MIRROR_AIX;
  const publicBaseUrl = options.publicBaseUrl ?? PUBLIC_BASE_URL;
  const fetchImpl = options.fetch ?? fetch;

  const upstreamPath = path.join(distDir, config.id, "upstream.json");
  const outputPath = path.join(distDir, config.id, "index.json");
  const minOutputPath = path.join(distDir, config.id, "index.min.json");

  if (!fs.existsSync(upstreamPath)) {
    console.error(`Upstream not found: ${upstreamPath}`);
    return;
  }

  const upstream: Registry = JSON.parse(fs.readFileSync(upstreamPath, "utf-8"));
  const repoName = config.repo.split("/").slice(-2).join("/");
  const repoPath = path.join(reposDir, repoName);
  const repoExists = fs.existsSync(repoPath);

  // Get base URL from registry URL
  const baseUrl = new URL(".", config.url).toString();

  console.log(`\nProcessing ${config.name} (${upstream.sources.length} sources)...`);
  if (!repoExists) {
    console.log(`  (repo not cloned, skipping author lookup)`);
  }

  const historicalData = config.hasHistoricalCommits ? loadHistoricalCommits() : { sources: {} };
  const enrichedSources: EnrichedSource[] = [];

  for (const source of upstream.sources) {
    let authors: AuthorOutput[] = [];

    if (repoExists) {
      const historical = historicalData.sources[source.id] ?? [];
      const cutoff = config.hasHistoricalCommits ? AIDOKU_COMMUNITY_CUTOFF : undefined;
      const current = getRepoCommits(repoPath, source.id, cutoff);
      authors = mergeContributors(historical, current);
    }

    const upstreamDownloadURL = resolveRegistryAssetUrl(config.url, source.downloadURL);
    const upstreamIconURL = resolveRegistryAssetUrl(config.url, source.iconURL);
    const artifact = mirrorAix
      ? await mirrorAixArtifact(config, source, upstreamDownloadURL, {
          distDir,
          publicBaseUrl,
          fetch: fetchImpl,
        })
      : undefined;

    enrichedSources.push({
      ...source,
      downloadURL: artifact?.mirroredURL ?? upstreamDownloadURL,
      iconURL: upstreamIconURL,
      authors,
      ...(artifact ? { artifact } : {}),
    });

    const authorsInfo = authors.length > 0 ? ` (${authors.length} authors)` : "";
    const artifactInfo = artifact ? `, mirrored ${artifact.bytes} bytes` : "";
    console.log(`  ✓ ${source.id}${authorsInfo}${artifactInfo}`);
  }

  const enriched: EnrichedRegistry = {
    name: config.name,
    generated: new Date().toISOString(),
    upstream: baseUrl,
    sources: enrichedSources,
  };

  fs.writeFileSync(outputPath, JSON.stringify(enriched, null, 2));
  fs.writeFileSync(minOutputPath, JSON.stringify(enriched));

  const withAuthors = enrichedSources.filter((s) => s.authors.length > 0).length;
  console.log(`  → ${outputPath} (${withAuthors}/${enrichedSources.length} with authors)`);
}

async function main() {
  const configs: RegistryConfig[] = JSON.parse(
    fs.readFileSync(REGISTRIES_PATH, "utf-8")
  );

  for (const config of configs) {
    await processRegistry(config);
  }

  console.log("\nDone");
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
