function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not set`);
  }

  return value;
}

export const config = {
  get databaseUrl(): string {
    return requireEnv('DATABASE_URL');
  },
};
