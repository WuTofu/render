import { Env } from "./env";

export function corsOriginHeader(env: Env): string {
  return env.ALLOWED_ORIGINS || "";
}
