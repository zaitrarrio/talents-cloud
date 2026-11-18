// Canonical record store — P0 runtime implementation.
// P0: a JSON file (data/registry.json) + in-memory Map index.
// Production target: Postgres via prisma/schema.prisma (ARCHITECTURE-v2 §4).
// The registry stores metadata, pointers, declarations and attestations —
// never the skill itself (catalog, not CDN).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RegistryFile, SkillRecord, DeadLetter } from "./types.js";

export class RegistryStore {
  private data: RegistryFile;
  private index: Map<string, SkillRecord>;

  constructor(private filePath: string) {
    if (existsSync(filePath)) {
      this.data = JSON.parse(readFileSync(filePath, "utf8")) as RegistryFile;
    } else {
      this.data = { version: 1, updatedAt: new Date().toISOString(), namespaces: {}, records: {}, deadLetters: [] };
    }
    this.index = new Map(Object.entries(this.data.records));
  }

  get(id: string): SkillRecord | undefined {
    return this.index.get(id.toLowerCase());
  }

  all(): SkillRecord[] {
    return [...this.index.values()];
  }

  upsert(record: SkillRecord): void {
    this.index.set(record.id, record);
    this.data.records[record.id] = record;
  }

  addDeadLetters(letters: DeadLetter[]): void {
    this.data.deadLetters.push(...letters);
  }

  deadLetters(): DeadLetter[] {
    return this.data.deadLetters;
  }

  raw(): RegistryFile {
    return this.data;
  }

  save(): void {
    this.data.updatedAt = new Date().toISOString();
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}
