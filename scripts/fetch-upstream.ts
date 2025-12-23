#!/usr/bin/env bun
/**
 * Fetch all upstream registries.
 *
 * Usage: bun scripts/fetch-upstream.ts
 *
 * Reads: data/registries.json
 * Outputs: dist/<id>/upstream.json for each registry
 */

import { fetchRegistry, type Registry } from "@nemu.pm/aidoku-cli/lib/registry";
import * as fs from "fs";
import * as path from "path";

interface RegistryConfig {
  id: string;
  name: string;
  url: string;
  repo: string;
  hasHistoricalCommits: boolean;
}

const ROOT_DIR = path.join(import.meta.dirname, "..");
const REGISTRIES_PATH = path.join(ROOT_DIR, "data/registries.json");
const DIST_DIR = path.join(ROOT_DIR, "dist");

async function main() {
  const configs: RegistryConfig[] = JSON.parse(
    fs.readFileSync(REGISTRIES_PATH, "utf-8")
  );

  console.log(`Fetching ${configs.length} registries...\n`);

  for (const config of configs) {
    console.log(`Fetching ${config.name}...`);

    const registry = await fetchRegistry(config.url);
    const outDir = path.join(DIST_DIR, config.id);
    const outPath = path.join(outDir, "upstream.json");

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(registry, null, 2));

    console.log(`  → ${outPath} (${registry.sources.length} sources)`);
  }

  console.log("\nDone");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
