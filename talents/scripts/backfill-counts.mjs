// Read production D1 counts (records / sources / embeddings) as JSON.
// Usage: python3 cf/scripts/backfill_remote.py backfill-counts.mjs
import { makeDeps, counts } from "./backfill-lib.mjs";

const { d1 } = await makeDeps();
console.log(JSON.stringify(await counts(d1), null, 2));
