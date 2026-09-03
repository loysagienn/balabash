// Environment of an SDK subprocess. Both agent SDKs treat their `env` option
// as the whole subprocess environment (nothing is inherited once it is set),
// so extra variables are merged over the app process environment here.
// process.env values can be undefined; the SDKs want Record<string, string>.

export function mergeEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }

  return { ...env, ...extra };
}
