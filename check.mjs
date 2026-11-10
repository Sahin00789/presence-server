import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './dist/db/schema.js';
import { listShiftAssignments } from './dist/modules/shifts/service.js';
import { listOvertime } from './dist/modules/overtime/service.js';

const sql = postgres(process.env.DATABASE_URL);
const db = drizzle(sql, { schema });

async function run() {
  const fastifyMock = { db };
  const orgId = 'd93d2b52-8d27-44fb-8102-41e78479583e';
  const userId = '3432002d-3cb7-45ac-b7dc-da71fd1c2b95';

  console.log("=== CALLING listShiftAssignments ===");
  const assignments = await listShiftAssignments(fastifyMock, orgId, undefined, userId);
  console.log("ASSIGNMENTS RESULT:", assignments);

  console.log("=== CALLING listOvertime FOR EMPLOYEE ===");
  const ot = await listOvertime(fastifyMock, { userId, role: 'EMPLOYEE' }, orgId, {});
  console.log("OVERTIME RESULT:", ot);

  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
