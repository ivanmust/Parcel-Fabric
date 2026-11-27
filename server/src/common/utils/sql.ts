export const sql = (value: string) => `'${value.replace(/'/g, "''")}'`;

export const sqlList = (values: string[]) => values.map(sql).join(",");

export const unique = <T>(values: T[]) => [...new Set(values)];

export const textOrNull = (value: unknown) => (value === null || value === undefined || String(value).trim() === "" ? null : String(value).trim());
