import { Body, Controller, Get, HttpCode, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiProperty, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { CurrentUser } from "../../common/auth/auth.decorators.js";
import type { SessionUser } from "../../common/auth/portal-auth.js";
import { HttpError } from "../../common/errors/http-error.js";
import { BookmarksRepository } from "./bookmarks.repository.js";

const Bookmark = z
  .object({
    name: z.string().max(200).optional(),
    extent: z.record(z.string(), z.unknown()).optional(),
    viewpoint: z.record(z.string(), z.unknown()).optional(),
    thumbnail: z.unknown().optional(),
    timeExtent: z.unknown().optional(),
  })
  .loose();
const BookmarksBody = z.object({ bookmarks: z.array(Bookmark).max(200) });

class BookmarksDto {
  @ApiProperty({ type: [Object], description: "Map bookmarks (name, extent, viewpoint); at most 200" })
  bookmarks!: Array<Record<string, unknown>>;
}

@ApiTags("Bookmarks")
@ApiBearerAuth()
@ApiSecurity("apiKey")
@Controller("bookmarks")
export class BookmarksController {
  constructor(private readonly repository: BookmarksRepository) {}

  @Get()
  @ApiOperation({ summary: "The signed-in user's map bookmarks" })
  async list(@CurrentUser() user: SessionUser) {
    return { bookmarks: await this.repository.read(user.username) };
  }

  @Put()
  @HttpCode(204)
  @ApiOperation({ summary: "Replace the signed-in user's map bookmarks" })
  @ApiBody({ type: BookmarksDto })
  async replace(@Body() body: unknown, @CurrentUser() user: SessionUser): Promise<void> {
    const parsed = BookmarksBody.safeParse(body);
    if (!parsed.success) throw new HttpError(400, "Invalid bookmarks payload", "invalid_bookmarks", parsed.error.issues);
    // Thumbnails can be large data URLs.
    const withoutThumbnails = parsed.data.bookmarks.map(({ thumbnail: _thumbnail, ...bookmark }) => bookmark);
    await this.repository.save(user.username, withoutThumbnails);
  }
}
