// Run one read-only SQL query against production D1, print rows as JSON.
// Usage: backfill_remote.py backfill-sql.mjs "SELECT ... "
import { makeDeps } from "./backfill-lib.mjs";

const { d1 } = await makeDeps();
const rows = await d1.query(process.argv[2]);
console.log(JSON.stringify(rows, null, 2));
