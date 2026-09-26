import { pool, query } from "./db.js";
import { config } from "./config.js";
import { hashPassword } from "./services/auth.js";

async function main() {
  // Create the default user with password "password123" on first run only.
  // Existing accounts keep their current password so re-running seed never resets it.
  const defaultPassword = await hashPassword("password123");
  await query(
    `INSERT INTO app_user (email, display_name, password_hash) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
    [config.defaultUser.email, config.defaultUser.displayName, defaultPassword],
  );

  await pool.end();
  console.log("Seed data is ready.");
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
});
