const { Pool } = require("pg");

function database(connectionString, ssl = { rejectUnauthorized: false }) {
  let pool;
  function getPool() {
    if (!pool) {
      pool = new Pool({ connectionString: connectionString(), ssl });
    }
    return pool;
  }

  async function query(text, params) {
    return getPool().query(text, params);
  }

  async function withTransaction(fn) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("transaction rollback failed", rollbackError);
      }
      throw error;
    } finally {
      client.release();
    }
  }
  return { query, withTransaction };
}

module.exports = { ...database(() => process.env.DATABASE_URL), database };
