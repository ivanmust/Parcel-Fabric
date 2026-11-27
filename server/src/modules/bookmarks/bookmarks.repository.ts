import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import { config } from "../../config/env.js";

/** One JSON file per user, named by a hash of the username. */
@Injectable()
export class BookmarksRepository {
  private readonly dir = path.resolve(config.BOOKMARKS_DIR);

  private fileFor(username: string): string {
    const name = createHash("sha256").update(username.toLowerCase()).digest("hex").slice(0, 32);
    return path.join(this.dir, `${name}.json`);
  }

  async read(username: string): Promise<unknown[]> {
    try {
      const json = JSON.parse(await readFile(this.fileFor(username), "utf8"));
      return Array.isArray(json.bookmarks) ? json.bookmarks : [];
    } catch {
      return [];
    }
  }

  async save(username: string, bookmarks: unknown[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.fileFor(username);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ username, updated: new Date().toISOString(), bookmarks }));
    await rename(tmp, file);
  }
}
