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
import * as fs from "fs";
import * as path from "path";
import type { Registry, RegistrySource } from "@nemu.pm/aidoku-cli/lib/registry";

const SCRIPTS_DIR = import.meta.dirname;
const ROOT_DIR = path.join(SCRIPTS_DIR, "..");

const REGISTRIES_PATH = path.join(ROOT_DIR, "data/registries.json");
const HISTORICAL_COMMITS_PATH = path.join(ROOT_DIR, "data/historical-commits.json");
const DIST_DIR = path.join(ROOT_DIR, "dist");

const REPOS_DIR = process.env.REPOS_DIR ?? path.join(ROOT_DIR, "repos");
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

interface EnrichedSource extends RegistrySource {
  authors: AuthorOutput[];
}

interface EnrichedRegistry {
  name: string;
  generated: string;
  upstream: string;
  sources: EnrichedSource[];
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

function processRegistry(config: RegistryConfig): void {
  const upstreamPath = path.join(DIST_DIR, config.id, "upstream.json");
  const outputPath = path.join(DIST_DIR, config.id, "index.json");
  const minOutputPath = path.join(DIST_DIR, config.id, "index.min.json");

  if (!fs.existsSync(upstreamPath)) {
    console.error(`Upstream not found: ${upstreamPath}`);
    return;
  }

  const upstream: Registry = JSON.parse(fs.readFileSync(upstreamPath, "utf-8"));
  const repoName = config.repo.split("/").slice(-2).join("/");
  const repoPath = path.join(REPOS_DIR, repoName);
  const repoExists = fs.existsSync(repoPath);

  // Get base URL from registry URL
  const baseUrl = config.url.replace(/\/[^/]+$/, "/");

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

    enrichedSources.push({
      ...source,
      // Rewrite relative URLs to absolute
      downloadURL: source.downloadURL.startsWith("http")
        ? source.downloadURL
        : `${baseUrl}${source.downloadURL}`,
      iconURL: source.iconURL.startsWith("http")
        ? source.iconURL
        : `${baseUrl}${source.iconURL}`,
      authors,
    });

    const authorsInfo = authors.length > 0 ? ` (${authors.length} authors)` : "";
    console.log(`  ✓ ${source.id}${authorsInfo}`);
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

function main() {
  const configs: RegistryConfig[] = JSON.parse(
    fs.readFileSync(REGISTRIES_PATH, "utf-8")
  );

  for (const config of configs) {
    processRegistry(config);
  }

  console.log("\nDone");
}

main();
