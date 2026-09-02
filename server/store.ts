// World files on disk: one JSON document per world, written atomically.
//
// A save is written to a temporary file first, the previous file is kept as a
// `.bak`, and only then is the new file moved into place — so a crash or a
// full disk mid-write can never leave a world unreadable. Loading falls back
// to the backup when the main file is missing or corrupt, and everything read
// goes through `validateWorldSave`, so a hand-edited or truncated file loads
// as far as it can rather than taking the server down.

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORLD_ID_PATTERN } from '../src/net/protocol.ts';
import { validateWorldSave, type WorldSave } from '../src/shared/save.ts';

export interface WorldSummary {
  id: string;
  name: string;
  host: string;
  seed: number;
  updated: number;
  /** Keys of everyone who has ever played in the world. */
  playerKeys: string[];
}

function summarize(save: WorldSave): WorldSummary {
  return {
    id: save.id,
    name: save.name,
    host: save.host,
    seed: save.seed,
    updated: save.updated,
    playerKeys: Object.keys(save.players),
  };
}

export class WorldStore {
  readonly dir: string;
  private readonly summaries = new Map<string, WorldSummary>();
  /** In-flight write per world, so two saves of one world never interleave. */
  private readonly writes = new Map<string, Promise<void>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Create the directory and index whatever worlds are already there. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!WORLD_ID_PATTERN.test(id)) continue;
      const save = await this.load(id);
      if (save) this.summaries.set(id, summarize(save));
    }
  }

  list(): WorldSummary[] {
    return [...this.summaries.values()];
  }

  get(id: string): WorldSummary | undefined {
    return this.summaries.get(id);
  }

  private pathFor(id: string, suffix = ''): string {
    if (!WORLD_ID_PATTERN.test(id)) throw new Error(`bad world id: ${id}`);
    return join(this.dir, `${id}.json${suffix}`);
  }

  /** Read a world, preferring the main file and falling back to the backup. */
  async load(id: string): Promise<WorldSave | null> {
    if (!WORLD_ID_PATTERN.test(id)) return null;
    for (const suffix of ['', '.bak']) {
      try {
        const raw = await readFile(this.pathFor(id, suffix), 'utf8');
        const save = validateWorldSave(JSON.parse(raw));
        if (save && save.id === id) return save;
      } catch {
        // Missing or unreadable: try the next candidate.
      }
    }
    return null;
  }

  /** Write a world. Resolves once it is safely on disk. */
  save(save: WorldSave): Promise<void> {
    const previous = this.writes.get(save.id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const main = this.pathFor(save.id);
        const tmp = this.pathFor(save.id, '.tmp');
        await writeFile(tmp, JSON.stringify(save), 'utf8');
        if (existsSync(main)) await rename(main, this.pathFor(save.id, '.bak'));
        await rename(tmp, main);
        this.summaries.set(save.id, summarize(save));
      });
    this.writes.set(save.id, next);
    return next;
  }

  /** Blocking write for shutdown, when there is no event loop left to wait on. */
  saveSync(save: WorldSave): void {
    mkdirSync(this.dir, { recursive: true });
    const main = this.pathFor(save.id);
    const tmp = this.pathFor(save.id, '.tmp');
    writeFileSync(tmp, JSON.stringify(save), 'utf8');
    if (existsSync(main)) renameSync(main, this.pathFor(save.id, '.bak'));
    renameSync(tmp, main);
    this.summaries.set(save.id, summarize(save));
  }
}
