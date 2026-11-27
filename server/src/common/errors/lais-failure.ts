export interface LaisErrorItem {
  field: string;
  code: string;
  message: string;
}

/** A failure answered in the LAIS shape: { success: false, case: "No", message, errors, data?, requestId }. */
export class LaisFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errors: LaisErrorItem[],
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "LaisFailure";
  }
}

export interface LaisSuccess<T> {
  success: true;
  case: string;
  message: string;
  data: T;
}

export const laisSuccess = <T>(message: string, data: T, laisCase = "Yes"): LaisSuccess<T> => ({ success: true, case: laisCase, message, data });

/** One error on the whole request, e.g. { field: "Transaction_ID", code: "NOT_FOUND" }. */
export const laisError = (status: number, message: string, field: string, code: string, detail = message) => new LaisFailure(status, message, [{ field, code, message: detail }]);
