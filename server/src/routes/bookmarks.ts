import { Router } from "express";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "../middleware/authenticate.js";
import { HttpError } from "../utils/httpError.js";
import { config } from "../config/env.js";

/** Per-user map bookmarks, stored as JSON files keyed by a hash of the username. */
export const bookmarks = Router();

const dir = path.resolve(config.BOOKMARKS_DIR);
const fileFor = (username: string) =>
  path.join(dir, `${createHash("sha256").update(username.toLowerCase()).digest("hex").slice(0, 32)}.json`);

const BookmarkJson = z
  .object({
    name: z.string().max(200).optional(),
    extent: z.record(z.string(), z.unknown()).optional(),
    viewpoint: z.record(z.string(), z.unknown()).optional(),
    thumbnail: z.unknown().optional(),
    timeExtent: z.unknown().optional(),
  })
  .loose();

const Body = z.object({ bookmarks: z.array(BookmarkJson).max(200) });

bookmarks.get("/bookmarks", requireAuth, async (req, res) => {
  try {
    const json = JSON.parse(await readFile(fileFor(req.user!.username), "utf8"));
    res.json({ bookmarks: Array.isArray(json.bookmarks) ? json.bookmarks : [] });
  } catch {
    res.json({ bookmarks: [] });
  }
});

bookmarks.put("/bookmarks", requireAuth, async (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "Invalid bookmarks payload", "invalid_bookmarks", parsed.error.issues);
  // Thumbnails can be large data URLs; strip them to keep files small.
  const clean = parsed.data.bookmarks.map(({ thumbnail: _t, ...b }) => b);
  await mkdir(dir, { recursive: true });
  const file = fileFor(req.user!.username);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ username: req.user!.username, updated: new Date().toISOString(), bookmarks: clean }));
  await rename(tmp, file); // atomic replace
  res.status(204).end();
});
