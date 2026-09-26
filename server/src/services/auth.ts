import crypto from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { query } from "../db.js";

const scrypt = promisify(crypto.scrypt);

export interface AuthUser {
  id: string;
  username: string;
  nickname: string;
  role: "user" | "admin";
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function readCookie(request: Request, name: string) {
  const header = request.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function setSessionCookie(response: Response, token: string, maxAgeSeconds: number) {
  const parts = [
    `${config.cookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.secureCookies) parts.push("Secure");
  response.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(response: Response) {
  setSessionCookie(response, "", 0);
}

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string | null) {
  if (!stored) return false;
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, "hex");
  return expected.length === derivedKey.length && crypto.timingSafeEqual(expected, derivedKey);
}

function publicUser(row: any): AuthUser {
  return {
    id: String(row.user_id),
    username: row.email,
    nickname: row.display_name,
    role: row.role,
  };
}

export async function createSession(userId: string, request: Request, response: Response) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const sessionId = crypto.randomBytes(32).toString("hex");
  const maxAgeSeconds = config.sessionDays * 24 * 60 * 60;
  await query(
    `INSERT INTO auth_session
      (session_id, user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
    [sessionId, userId, tokenHash, request.get("user-agent")?.slice(0, 512) ?? null, request.ip?.slice(0, 64) ?? null, config.sessionDays],
  );
  setSessionCookie(response, token, maxAgeSeconds);
}

export async function destroySession(request: Request, response: Response) {
  const token = readCookie(request, config.cookieName);
  if (token) await query("DELETE FROM auth_session WHERE token_hash = ?", [hashToken(token)]);
  clearSessionCookie(response);
}

export async function currentUser(request: Request): Promise<AuthUser | null> {
  const token = readCookie(request, config.cookieName);
  if (!token) return null;
  const rows = await query<any>(
    `SELECT u.user_id, u.email, u.display_name, u.role
     FROM auth_session s INNER JOIN app_user u ON u.user_id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > NOW() AND u.is_active = TRUE LIMIT 1`,
    [hashToken(token)],
  );
  if (!rows.length) return null;
  void query("UPDATE auth_session SET last_seen_at = NOW() WHERE token_hash = ?", [hashToken(token)]).catch(() => undefined);
  return publicUser(rows[0]);
}

export async function requireAuth(request: Request, response: Response, next: NextFunction) {
  try {
    const user = await currentUser(request);
    if (!user) {
      console.warn(`[auth] rejected ${request.method} ${request.originalUrl} cookie=${Boolean(readCookie(request, config.cookieName))}`);
      return response.status(401).json({ message: "请先登录" });
    }
    request.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

export async function cleanupExpiredSessions() {
  await query("DELETE FROM auth_session WHERE expires_at <= NOW()");
}
