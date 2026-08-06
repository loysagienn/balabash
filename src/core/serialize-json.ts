// JSON transport between server and browser: wraps values JSON can't carry
// (bigint, Date) into {_$_type, _$_value} markers on stringify and restores
// them on parse. Port of v1 utils/serialize-json, typed for strict mode.

const TYPE = '_$_type';
const VALUE = '_$_value';

export function prepareObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(prepareObject);
  }

  if (typeof obj === 'bigint') {
    return { [TYPE]: 'bigint', [VALUE]: obj.toString() };
  }

  if (obj instanceof Date) {
    return { [TYPE]: 'date', [VALUE]: obj.toISOString() };
  }

  if (typeof obj === 'object') {
    return Object.entries(obj).reduce<Record<string, unknown>>((acc, [key, value]) => {
      acc[key] = prepareObject(value);
      return acc;
    }, {});
  }

  return obj;
}

export function stringifyJson(obj: unknown): string {
  const prepared = prepareObject(obj);

  return JSON.stringify(prepared);
}

export function restoreObject(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(restoreObject);
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;

    if (record[TYPE] === 'bigint' && typeof record[VALUE] === 'string') {
      return BigInt(record[VALUE]);
    }

    if (record[TYPE] === 'date' && typeof record[VALUE] === 'string') {
      return new Date(record[VALUE]);
    }

    return Object.entries(record).reduce<Record<string, unknown>>((acc, [key, item]) => {
      acc[key] = restoreObject(item);
      return acc;
    }, {});
  }

  return value;
}

export function parseJson(json: string): unknown {
  const parsed = JSON.parse(json);

  return restoreObject(parsed);
}
