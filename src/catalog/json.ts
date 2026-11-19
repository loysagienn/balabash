// The JSON forms the catalog works in. They are the catalog's own: nothing
// here leans on the rest of the app.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

// A JSON Schema, in the catalog's form: a named type is a reference
// `#/types/<Name>`.
export type JsonSchema = Record<string, unknown>;
