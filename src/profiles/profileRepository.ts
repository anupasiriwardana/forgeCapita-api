import { pool } from "../db/pool.js";
import type { ProfileBody } from "../schemas/profileSchemas.js";

/** The owner's own profile; PII, returned to nobody else. */
export interface UserProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string | null;
  postalCode: string;
  country: string;
  dateOfBirth: string;
}

interface UserProfileRow {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  region: string | null;
  postal_code: string;
  country: string;
  date_of_birth: string;
}

const PROFILE_COLUMNS = `first_name, last_name, email, phone, address_line1, address_line2, city, region,
  postal_code, country, to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth`;

function toProfile(row: UserProfileRow): UserProfile {
  return {
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    country: row.country,
    dateOfBirth: row.date_of_birth,
  };
}

export async function findProfile(userId: string): Promise<UserProfile | null> {
  const result = await pool.query<UserProfileRow>(
    `SELECT ${PROFILE_COLUMNS} FROM app.user_profiles WHERE user_id = $1`,
    [userId]
  );
  const row = result.rows[0];
  return row ? toProfile(row) : null;
}

/**
 * Upserts the profile and writes ONE 'profile.save' audit row in the same statement. The audit row
 * names the user's wallet and carries no profile values.
 */
export async function saveProfile(userId: string, body: ProfileBody, ip: string | null): Promise<UserProfile> {
  const result = await pool.query<UserProfileRow>(
    `WITH saved AS (
       INSERT INTO app.user_profiles
         (user_id, first_name, last_name, email, phone, address_line1, address_line2, city, region,
          postal_code, country, date_of_birth)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date)
       ON CONFLICT (user_id) DO UPDATE SET
         first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, email = EXCLUDED.email,
         phone = EXCLUDED.phone, address_line1 = EXCLUDED.address_line1,
         address_line2 = EXCLUDED.address_line2, city = EXCLUDED.city, region = EXCLUDED.region,
         postal_code = EXCLUDED.postal_code, country = EXCLUDED.country,
         date_of_birth = EXCLUDED.date_of_birth, updated_at = now()
       RETURNING *
     ),
     audited AS (
       INSERT INTO app.audit_log (action, actor_user_id, target, ip)
       SELECT 'profile.save', $1::uuid, u.wallet_address, $13::text
       FROM app.users u WHERE u.id = $1::uuid
       RETURNING id
     )
     SELECT ${PROFILE_COLUMNS} FROM saved`,
    [
      userId,
      body.firstName,
      body.lastName,
      body.email,
      body.phone,
      body.addressLine1,
      body.addressLine2 ?? null,
      body.city,
      body.region ?? null,
      body.postalCode,
      body.country,
      body.dateOfBirth,
      ip,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("profile upsert returned no row");
  return toProfile(row);
}
