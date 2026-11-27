import { Controller, Get, Post } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { HttpError } from "../../../common/errors/http-error.js";

const retired = () =>
  new HttpError(410, "LAIS versions are now created automatically. Review them under Version Manager ▸ LAIS transactions.", "lais_workflow_retired");

/** The retired editor workflow: kept only to give old clients a clear answer. */
@ApiExcludeController()
@Controller("lais-workflow")
export class LaisWorkflowController {
  @Get("pending")
  pending(): never {
    throw retired();
  }

  @Post(":objectId/version")
  createVersion(): never {
    throw retired();
  }
}
