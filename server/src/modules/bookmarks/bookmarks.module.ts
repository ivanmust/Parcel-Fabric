import { Module } from "@nestjs/common";
import { BookmarksController } from "./bookmarks.controller.js";
import { BookmarksRepository } from "./bookmarks.repository.js";

@Module({
  controllers: [BookmarksController],
  providers: [BookmarksRepository],
})
export class BookmarksModule {}
