const db = require("./db");

let connection;
function getDatabase() {
  if (!connection) {
    const databaseUrl = new URL(process.env.VERCEL_ENV === "production"
      ? process.env.WEB_PLANNER_DATABASE_URL : process.env.WEB_PLANNER_TEST_DATABASE_URL);
    for (const parameter of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert"]) databaseUrl.searchParams.delete(parameter);
    const ca = process.env.WEB_PLANNER_DATABASE_CA?.replaceAll("\\n", "\n");
    connection = db.database(() => databaseUrl.href, { rejectUnauthorized: true, ...(ca && { ca }) });
  }
  return connection;
}

module.exports = {
  query: (...args) => getDatabase().query(...args),
  withTransaction: (...args) => getDatabase().withTransaction(...args),
};
