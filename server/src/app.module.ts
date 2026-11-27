import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "./common/auth/auth.guard.js";
import { JsonBodyMiddleware } from "./common/http/json-body.middleware.js";
import { SystemModule } from "./modules/system/system.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { AuditModule } from "./modules/audit/audit.module.js";
import { BookmarksModule } from "./modules/bookmarks/bookmarks.module.js";
import { LaisModule } from "./modules/lais/lais.module.js";
import { WebhooksModule } from "./modules/webhooks/webhooks.module.js";

@Module({
  imports: [SystemModule, AuthModule, AuditModule, BookmarksModule, LaisModule, WebhooksModule],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(JsonBodyMiddleware).forRoutes({ path: "*path", method: RequestMethod.ALL });
  }
}
