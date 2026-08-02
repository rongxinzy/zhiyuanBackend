export type CatalogSyncMessage =
  | { kind: 'refresh-featured'; query?: string }
  | { kind: 'hydrate-model'; repoId: string };

type SecretsStoreSecret = {
  get(): Promise<string | null>;
};

export type CatalogEnv = Env & {
  MODEL_CATALOG_ADMIN_TOKEN?: string;
  MODEL_SCOPE_TOKEN_BUNDLE?: SecretsStoreSecret;
};
