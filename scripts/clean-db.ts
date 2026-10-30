import postgres from 'postgres';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL is not set. Add it to .env before running db:clean.');
  process.exit(1);
}

async function cleanDatabase() {
  console.log('Connecting to database to wipe all data...');
  const sql = postgres(connectionString);

  try {
    console.log('Truncating all tables with CASCADE...');
    await sql`
      TRUNCATE TABLE
        audit_logs,
        clock_nonces,
        overtime,
        leave_requests,
        unworked_payment_rules,
        weekly_offs,
        holiday_calendars,
        payroll_transactions,
        payroll_deductions,
        staff_earning_ledger,
        monthly_payrolls,
        monthly_attendance_stats,
        location_check_events,
        location_monitoring_sessions,
        attendance_events,
        daily_attendance,
        employee_shift_assignments,
        shifts,
        multi_pose_face_templates,
        employees,
        premises,
        logged_devices,
        google_identities,
        otp_requests,
        owners,
        users,
        organizations
      CASCADE;
    `;
    console.log('All database data has been successfully deleted/wiped.');
  } catch (err) {
    console.error('Error wiping database:', err);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

cleanDatabase();
