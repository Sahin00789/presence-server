import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL);
async function run() {
  console.log("=== USERS ===");
  console.log(await sql`SELECT id, email, role, organization_id FROM users`);
  console.log("=== EMPLOYEES ===");
  console.log(await sql`SELECT id, user_id, name, organization_id FROM employees`);
  console.log("=== SHIFTS ===");
  console.log(await sql`SELECT id, shift_name, day_name, premises_id FROM shifts`);
  console.log("=== ASSIGNMENTS ===");
  console.log(await sql`SELECT * FROM employee_shift_assignments`);
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
