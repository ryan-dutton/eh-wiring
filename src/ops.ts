/**
 * Edit operations exchanged between browsers and a HarnessRoom.
 *
 * A harness is { components: [...], wires: [...], ...fields }. Edits are last-writer-wins per
 * component, per wire and per top-level field, so two people editing different parts of the
 * drawing never overwrite each other.
 */

export type Coll = "components" | "wires";
export type Entity = { id: string; [k: string]: unknown };

export type Op =
  | { op: "put"; coll: Coll; id: string; value: Entity; index?: number }
  | { op: "del"; coll: Coll; id: string }
  | { op: "set"; key: string; value?: unknown };

export const COLLS: readonly Coll[] = ["components", "wires"];
const FIELD_KEYS = new Set(["version", "meta", "page", "reference", "colors", "mfColors"]);
const ID_RE = /^[\w.:-]{1,80}$/;
const MAX_ENTITY_JSON = 256 * 1024;
const MAX_OPS = 2000;

export class OpError extends Error {}

/** Throws OpError unless `raw` is a well-formed list of ops. */
export function validateOps(raw: unknown): Op[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_OPS) throw new OpError("ops must be a non-empty array");
  for (const o of raw as Record<string, unknown>[]) {
    if (!o || typeof o !== "object") throw new OpError("bad op");
    if (o.op === "set") {
      if (typeof o.key !== "string" || !FIELD_KEYS.has(o.key)) throw new OpError(`unknown field ${String(o.key)}`);
      continue;
    }
    if (o.op !== "put" && o.op !== "del") throw new OpError(`unknown op ${String(o.op)}`);
    if (!COLLS.includes(o.coll as Coll)) throw new OpError("bad collection");
    if (typeof o.id !== "string" || !ID_RE.test(o.id)) throw new OpError("bad id");
    if (o.op === "put") {
      const v = o.value as Entity | undefined;
      if (!v || typeof v !== "object" || Array.isArray(v) || v.id !== o.id) throw new OpError("put value must be an object with a matching id");
      if (JSON.stringify(v).length > MAX_ENTITY_JSON) throw new OpError("entity too large");
      if (o.index !== undefined && (typeof o.index !== "number" || !Number.isFinite(o.index))) throw new OpError("bad index");
    }
  }
  return raw as Op[];
}

export function isFieldKey(key: string): boolean {
  return FIELD_KEYS.has(key);
}
