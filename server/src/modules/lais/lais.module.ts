import { Module } from "@nestjs/common";
import { LaisTransactionsController } from "./controllers/lais-transactions.controller.js";
import { LaisEditingController } from "./controllers/lais-editing.controller.js";
import { LaisWorkflowController } from "./controllers/lais-workflow.controller.js";
import { LaisTransactionsService } from "./services/lais-transactions.service.js";
import { LaisEditingService } from "./services/lais-editing.service.js";

@Module({
  controllers: [LaisTransactionsController, LaisEditingController, LaisWorkflowController],
  providers: [LaisTransactionsService, LaisEditingService],
})
export class LaisModule {}
