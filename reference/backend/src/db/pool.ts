import pg from "pg";
import { getPgConfig } from "./config.js";

export function createPool(): pg.Pool {
  return new pg.Pool(getPgConfig());
}
