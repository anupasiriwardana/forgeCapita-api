import { pool } from "../db/pool.js";

/** Stores one gas price sample; the bigint travels as a string into NUMERIC(78,0). */
export async function insertGasSample(chainId: number, gasPriceWei: bigint): Promise<void> {
  await pool.query("INSERT INTO app.gas_samples (chain_id, gas_price_wei) VALUES ($1::integer, $2::numeric)", [
    chainId,
    gasPriceWei.toString(),
  ]);
}

/** Deletes samples older than the retention window. */
export async function pruneGasSamples(retentionHours: number): Promise<void> {
  await pool.query("DELETE FROM app.gas_samples WHERE sampled_at < now() - make_interval(hours => $1::integer)", [
    retentionHours,
  ]);
}

function toBigInt(value: string | null | undefined): bigint | null {
  return value === null || value === undefined ? null : BigInt(value);
}

/** Integer-floored average gas price over the last `hours`, or null without samples. */
export async function averageGasPrice(chainId: number, hours: number): Promise<bigint | null> {
  const result = await pool.query<{ avg: string | null }>(
    `SELECT FLOOR(AVG(gas_price_wei))::text AS avg FROM app.gas_samples
     WHERE chain_id = $1::integer AND sampled_at >= now() - make_interval(hours => $2::integer)`,
    [chainId, hours]
  );
  return toBigInt(result.rows[0]?.avg);
}

/** Most recent gas price sample regardless of age, or null without samples. */
export async function latestGasPrice(chainId: number): Promise<bigint | null> {
  const result = await pool.query<{ gas_price_wei: string }>(
    "SELECT gas_price_wei::text AS gas_price_wei FROM app.gas_samples WHERE chain_id = $1::integer ORDER BY sampled_at DESC, id DESC LIMIT 1",
    [chainId]
  );
  return toBigInt(result.rows[0]?.gas_price_wei);
}
