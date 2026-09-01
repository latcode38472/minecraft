// World persistence in IndexedDB. Saves are small because we store only the
// seed, player state, and per-chunk *edit diffs* — terrain regenerates from
// the seed and the diffs are re-applied on top.

import type { ItemStack } from './items/inventory';
import type { ChunkEdits } from './world/world';

const DB_NAME = 'voxelcraft';
const DB_VERSION = 1;
const STORE = 'world';
const META_KEY = 'meta';
const EDITS_PREFIX = 'edits:';

export interface SaveMeta {
  seed: number;
  timeOfDay: number;
  player: { x: number; y: number; z: number; yaw: number; pitch: number };
  selectedSlot: number;
  // Survival state — optional so worlds saved before survival existed still load.
  inventory?: (ItemStack | null)[];
  armor?: (ItemStack | null)[];
  health?: number;
  hunger?: number;
  spawn?: { x: number; y: number; z: number };
}

interface EditsRecord {
  indices: Uint32Array;
  ids: Uint8Array;
}

export class SaveStore {
  private constructor(private readonly db: IDBDatabase) {}

  static open(): Promise<SaveStore> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(new SaveStore(req.result));
      req.onerror = () => reject(req.error);
    });
  }

  private tx(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  private request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async loadMeta(): Promise<SaveMeta | undefined> {
    return (await this.request(this.tx('readonly').get(META_KEY))) as SaveMeta | undefined;
  }

  async loadAllEdits(): Promise<Map<string, ChunkEdits>> {
    const store = this.tx('readonly');
    const keys = (await this.request(store.getAllKeys())) as string[];
    const out = new Map<string, ChunkEdits>();
    for (const key of keys) {
      if (typeof key !== 'string' || !key.startsWith(EDITS_PREFIX)) continue;
      const record = (await this.request(this.tx('readonly').get(key))) as EditsRecord;
      const edits: ChunkEdits = new Map();
      for (let i = 0; i < record.indices.length; i++) {
        edits.set(record.indices[i], record.ids[i]);
      }
      out.set(key.slice(EDITS_PREFIX.length), edits);
    }
    return out;
  }

  saveMeta(meta: SaveMeta): Promise<IDBValidKey> {
    return this.request(this.tx('readwrite').put(meta, META_KEY));
  }

  saveChunkEdits(chunkKey: string, edits: ChunkEdits): Promise<IDBValidKey> {
    const record: EditsRecord = {
      indices: new Uint32Array(edits.keys()),
      ids: new Uint8Array(edits.values()),
    };
    return this.request(this.tx('readwrite').put(record, EDITS_PREFIX + chunkKey));
  }

  clearAll(): Promise<undefined> {
    return this.request(this.tx('readwrite').clear());
  }
}
