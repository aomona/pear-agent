import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { pearSchema } from "./schema.js";

export type PearDatabase = DrizzleD1Database<typeof pearSchema>;

export function createPearDatabase(d1: D1Database): PearDatabase {
  return drizzle(d1, { schema: pearSchema });
}
