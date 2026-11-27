import { Injectable, type NestMiddleware } from "@nestjs/common";
import express, { type NextFunction, type Request, type Response } from "express";

const parseJson = express.json({ limit: "256kb" });

/** JSON bodies up to 256 KB. Parse errors are thrown, so the exception filter answers them in the API's shape. */
@Injectable()
export class JsonBodyMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): Promise<void> {
    return new Promise((resolve, reject) => {
      parseJson(request, response, (error?: unknown) => {
        if (error) return reject(error);
        next();
        resolve();
      });
    });
  }
}
