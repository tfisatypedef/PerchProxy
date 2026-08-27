import { readFile, rename, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export type PerchAuth = { token: string | null; source: string };

const SESSION_FILENAME = "cli-auth-session.json";
const SUPABASE_URL =
  process.env.PERCH_SUPABASE_URL?.trim() ||
  "https://zlfuvsfjtgsdtqcaykia.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.PERCH_SUPABASE_ANON_KEY?.trim() ||
  "sb_publishable_w4R_pNkUpygBFIljZCoOlA_67ACg0FO";
const EXPIRY_SKEW_MS = 120_000;

const cache = {
  path: "",
  mtimeMs: 0,
  accessToken: null as string | null,
  refreshToken: null as string | null,
  expiresAt: 0,
  source: "",
  readAt: 0,
  refreshing: null as Promise<boolean> | null,
};
const CACHE_TTL_MS = 30_000;

function candidateDirs(): string[] {
  const dirs: string[] = [];
  const override = process.env.PERCH_CLI_AUTH_DIR?.trim();
  if (override) dirs.push(override);
  dirs.push(join(homedir(), ".perch"));
  if (process.env.APPDATA?.trim()) {
    dirs.push(join(process.env.APPDATA, "Perch AI Desktop"));
  }
  return [...new Set(dirs)];
}

async function newestSessionFile(): Promise<{ path: string; mtimeMs: number } | null> {
  let best: { path: string; mtimeMs: number } | null = null;
  for (const dir of candidateDirs()) {
    const path = join(dir, SESSION_FILENAME);
    try {
      const s = await stat(path);
      if (s.size > 0 && (!best || s.mtimeMs > best.mtimeMs)) {
        best = { path, mtimeMs: s.mtimeMs };
      }
    } catch {}
  }
  return best;
}

type SessionFile = {
  version?: number;
  appUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  userId?: string;
  email?: string;
  updatedAt?: string;
};

function parseExpiry(expiresAt: unknown): number {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return 0;
  if (expiresAt > 1e12) return expiresAt;
  if (expiresAt > 1e9) return expiresAt * 1000;
  return 0;
}

async function loadSession(forcePathCheck: boolean): Promise<void> {
  const found = await newestSessionFile();
  if (!found) {
    cache.accessToken = null;
    cache.refreshToken = null;
    cache.expiresAt = 0;
    cache.source = `no ${SESSION_FILENAME} found`;
    return;
  }
  const { path, mtimeMs } = found;
  // Re-read if the file path changed, the file was rewritten in place
  // (e.g. Perch Desktop re-logged in), or the caller forced a re-check.
  if (
    !forcePathCheck &&
    path === cache.path &&
    mtimeMs === cache.mtimeMs &&
    cache.accessToken
  ) {
    return;
  }
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as SessionFile;
    cache.path = path;
    cache.mtimeMs = mtimeMs;
    cache.accessToken = parsed.accessToken ?? null;
    cache.refreshToken = parsed.refreshToken ?? null;
    cache.expiresAt = parseExpiry(parsed.expiresAt);
    cache.source = path;
  } catch {
    cache.path = path;
    cache.mtimeMs = mtimeMs;
    cache.accessToken = null;
    cache.source = `${path} (unreadable)`;
  }
}

async function persistSession(): Promise<void> {
  if (!cache.path || !cache.accessToken || !cache.refreshToken) return;
  const updated: SessionFile = {
    version: 1,
    appUrl: "https://app.perchai.app",
    accessToken: cache.accessToken,
    refreshToken: cache.refreshToken,
    expiresAt: Math.floor(cache.expiresAt / 1000),
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${cache.path}.tmp`;
  await writeFile(tmp, JSON.stringify(updated, null, 2), "utf8");
  await rename(tmp, cache.path);
}

async function refreshAccessToken(): Promise<boolean> {
  if (!cache.refreshToken) return false;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ refresh_token: cache.refreshToken }),
      },
    );
    if (!res.ok) {
      cache.refreshToken = null;
      return false;
    }
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_at?: number;
    };
    if (!data.access_token) return false;
    cache.accessToken = data.access_token;
    if (data.refresh_token) cache.refreshToken = data.refresh_token;
    cache.expiresAt = parseExpiry(data.expires_at);
    await persistSession();
    return true;
  } catch {
    return false;
  }
}

function tokenValid(now: number): boolean {
  return (
    !!cache.accessToken &&
    (cache.expiresAt === 0 || cache.expiresAt > now + EXPIRY_SKEW_MS)
  );
}

export async function getPerchAuth(force = false): Promise<PerchAuth> {
  const env = process.env.PERCH_TOKEN?.trim();
  if (env) return { token: env, source: "PERCH_TOKEN" };

  const now = Date.now();
  if (!force && cache.accessToken && now - cache.readAt < CACHE_TTL_MS) {
    if (!tokenValid(now)) {
      const ok = await ensureRefreshed();
      if (!ok) return { token: null, source: `${cache.source} (expired)` };
    }
    return { token: cache.accessToken, source: cache.source };
  }

  await loadSession(!cache.path);
  cache.readAt = Date.now();

  if (!tokenValid(Date.now())) {
    const ok = await ensureRefreshed();
    if (!ok && !tokenValid(Date.now())) {
      return {
        token: cache.accessToken,
        source: `${cache.source}${cache.accessToken ? " (expired)" : ""}`,
      };
    }
  }
  return { token: cache.accessToken, source: cache.source };
}

async function ensureRefreshed(): Promise<boolean> {
  if (!cache.refreshing) {
    cache.refreshing = refreshAccessToken().finally(() => {
      cache.refreshing = null;
    });
  }
  return cache.refreshing;
}
