import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import { config } from "./config.js";

async function main() {
  if (!/^[a-zA-Z0-9_]+$/.test(config.mysql.database)) {
    throw new Error("MYSQL_DATABASE 只能包含字母、数字和下划线");
  }

  const bootstrap = await mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    multipleStatements: true,
  });
  await bootstrap.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.mysql.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await bootstrap.end();

  const connection = await mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    database: config.mysql.database,
    user: config.mysql.user,
    password: config.mysql.password,
    multipleStatements: true,
  });
  const migrationDirectory = path.resolve(process.cwd(), "server/sql");
  const files = (await fs.readdir(migrationDirectory))
    .filter((file) => /^\d+_.*\.sql$/.test(file))
    .sort();
  await connection.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(128) NOT NULL PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const [applied] = await connection.query<any[]>(
      "SELECT version FROM schema_migrations WHERE version = ? LIMIT 1",
      [version],
    );
    if (applied.length) continue;
    const sql = await fs.readFile(path.join(migrationDirectory, file), "utf8");
    await connection.beginTransaction();
    try {
      await connection.query(sql);
      await connection.query("INSERT INTO schema_migrations (version) VALUES (?)", [version]);
      await connection.commit();
      console.log(`Applied migration ${version}`);
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }
  await connection.end();
  console.log(`Database ${config.mysql.database} is ready.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
