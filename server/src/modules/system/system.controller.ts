import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "../../common/auth/auth.decorators.js";
import { SystemService } from "./system.service.js";

@ApiTags("System")
@Public()
@Controller()
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Get("health")
  @ApiOperation({ summary: "Liveness and ArcGIS Enterprise reachability" })
  health() {
    return this.system.health();
  }

  @Get("config")
  @ApiOperation({ summary: "Public settings for the web app" })
  clientConfig() {
    return this.system.clientConfig();
  }
}
