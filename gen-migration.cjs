const fs = require('fs');
const path = require('path');
const { generateMigration } = require('drizzle-kit/api');

const prevPath = path.join(__dirname, 'drizzle/meta/0007_snapshot.json');
const curPath = path.join(__dirname, '../drizzle_cur_snapshot.json');

const clone = (value) => JSON.parse(JSON.stringify(value));

const removedTables = [
  'public.attendance_corrections',
  'public.attendance_events',
  'public.attendance_exceptions',
  'public.employment_records',
  'public.face_templates',
  'public.invitations',
  'public.location_check_events',
  'public.location_monitoring_sessions',
  'public.memberships',
  'public.payment_records',
  'public.payroll_items',
  'public.payroll_periods',
  'public.salary_rate_history',
  'public.salary_structures',
  'public.shift_assignments',
  'public.shift_payment_rules',
  'public.shift_templates',
  'public.staff_profiles',
  'public.wallet_transactions',
  'public.wallets',
];

async function main() {
  const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
  const cur = JSON.parse(fs.readFileSync(curPath, 'utf8'));

  const newTables = Object.keys(cur.tables).filter((key) => !prev.tables[key]);
  const newEnums = Object.keys(cur.enums).filter((key) => !prev.enums[key]);
  const commonTables = Object.keys(cur.tables).filter((key) => prev.tables[key]);

  // Full create snapshot: no candidates for rename prompts.
  const empty = clone(cur);
  empty.tables = {};
  empty.enums = {};
  empty.sequences = {};
  const createSql = await generateMigration(empty, cur);

  const createStatements = createSql.filter((statement) => {
    return (
      newEnums.some((key) => statement.includes(`"${key.replace('.', '"."')}"`)) ||
      newTables.some((key) => statement.includes(`"${key.split('.').pop()}"`))
    );
  });

  // Alter snapshot: new tables are pre-added, removed tables deleted, enums all current,
  // and common-table columns already match the target so only index/FK diffs are emitted.
  const alter = clone(prev);
  for (const key of removedTables) delete alter.tables[key];
  for (const key of newTables) alter.tables[key] = clone(cur.tables[key]);
  alter.enums = clone(cur.enums);
  for (const key of commonTables) alter.tables[key].columns = clone(cur.tables[key].columns);

  const alterSql = await generateMigration(alter, cur);

  const out = [
    '-- === NEW TYPES ===',
    ...createSql.filter((statement) =>
      newEnums.some((key) => statement.includes(`"${key.replace('.', '"."')}"`))
    ),
    '',
    '-- === NEW TABLES ===',
    ...createSql.filter((statement) =>
      newTables.some((key) => statement.includes(`"${key.split('.').pop()}"`))
    ),
    '',
    '-- === COMMON TABLE CONSTRAINTS / INDEXES ===',
    ...alterSql,
  ].join('\n--> statement-breakpoint\n');

  fs.writeFileSync(path.join(__dirname, '../drizzle_generated_parts.sql'), out);

  console.log('new enums', newEnums);
  console.log('new tables', newTables);
  console.log('common tables', commonTables);
  console.log('create statements', createSql.length, 'alter statements', alterSql.length);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
