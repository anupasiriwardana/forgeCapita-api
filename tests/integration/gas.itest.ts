import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { averageGasPrice, insertGasSample, latestGasPrice, pruneGasSamples } from "../../src/gas/gasRepository.js";
import { bootstrapDatabase, closePool, pool, resetData } from "./db.js";

beforeAll(async () => {
  await bootstrapDatabase();
});
afterAll(closePool);
beforeEach(resetData);

describe("gas samples", () => {
  it("averages (floored), reads the latest and prunes old rows without losing wei precision", async () => {
    const huge = 10n ** 30n + 1n;
    await insertGasSample(421614, huge);
    await insertGasSample(421614, huge + 2n);
    await insertGasSample(97, 5n);
    expect(await averageGasPrice(421614, 24)).toBe(huge + 1n);
    expect(await latestGasPrice(421614)).toBe(huge + 2n);
    expect(await averageGasPrice(56, 24)).toBeNull();

    await pool.query("UPDATE app.gas_samples SET sampled_at = now() - interval '49 hours' WHERE chain_id = 97");
    expect(await averageGasPrice(97, 24)).toBeNull();
    expect(await latestGasPrice(97)).toBe(5n);
    await pruneGasSamples(48);
    expect(await latestGasPrice(97)).toBeNull();
    expect(await latestGasPrice(421614)).toBe(huge + 2n);
  });
});
