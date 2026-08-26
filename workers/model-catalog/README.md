# Model catalog Worker

`zhiyuan-model-catalog` is the read-oriented ModelScope catalog boundary for the desktop model center. It owns search, cache, evidence, scoring metadata, and the authorized ModelScope credential pool. GGUF bytes are downloaded by the desktop client directly from ModelScope so the Worker never becomes a large-file proxy.

## First deployment

1. Create the D1 database `zhiyuan-model-catalog` and set its ID in `wrangler.jsonc`.
2. Apply all checked-in migrations with `bunx wrangler d1 migrations apply zhiyuan-model-catalog --remote --config workers/model-catalog/wrangler.jsonc`.
3. Create the queue and dead-letter queue named in `wrangler.jsonc`.
4. Store `MODELSCOPE_TOKEN_BUNDLE` as a Worker secret. The value is JSON such as `[{"id":"pool-a","token":"..."}]`; tokens are never returned by the API or logged. A Secrets Store binding named `MODEL_SCOPE_TOKEN_BUNDLE` can be added later for rotation without changing code.
5. Set `MODEL_CATALOG_ADMIN_TOKEN` before enabling feedback ingestion.

Read endpoints are public and cacheable. Admin feedback requires `Authorization: Bearer <MODEL_CATALOG_ADMIN_TOKEN>`. The desktop uses the catalog when `ZHIYUAN_MODEL_CATALOG_URL` is configured and keeps its direct ModelScope adapter as a compatibility fallback.

The desktop never receives or stores a ModelScope catalogue token and has no direct ModelScope metadata fallback. When this Worker is unavailable it can show bundled browse-only records, but installation remains disabled until this API supplies an immutable revision, byte size, download URL and SHA-256 digest.

The desktop search API supports sortby=asc and sortby=desc (also parameter_asc/parameter_desc) to order models by parameter count; the default is ascending and models without a parameter count are last. The desktop keeps three result contexts separate: featured recommendations (`featured=1`), free-text search (`q=...`), and task/category browsing (`task=...`). Recommendations are a finite curated result with no misleading upstream pagination. The `全部模型` browse path requests ModelScope page-by-page with `limit` and `page`, returning the upstream `totalCount`/`nextPageNumber`. Every upstream request is restricted to GGUF text-generation repositories; the normalizer additionally rejects embeddings, rerankers, sharded files and records without a checksum-backed single-file GGUF.

The Worker owns ModelScope search/detail/file metadata, token rotation, rate-limit cooldown, D1 stale fallback and edge caching. It never proxies model bytes. The desktop downloads the selected GGUF directly, verifies byte size, SHA-256, GGUF magic/version, and only treats a real local runtime probe as final compatibility evidence.

## Device adaptation

The catalogue stores `deviceFit.base` and `deviceFit.pro` for each model. `base` is the 64 GB RAM plus 2 x 8 GB VRAM machine; `pro` is the 64 GB RAM plus 2 x 16 GB VRAM machine. The classifier follows `模型运行支持分类规则.md`: it estimates peak VRAM as model weight size x 1.3 when measured data is unavailable, treats catalogue GGUF models as using the default two-GPU inference path, checks both aggregate and balanced per-GPU VRAM, and downgrades by measured peak system memory when available. Non-GGUF formats still require explicit `supportsMultiGpu` evidence before aggregate VRAM is used.

The search endpoint keeps the existing unrestricted behavior unless both filters are requested:

- `GET /v1/catalog/search?type=base&fit=recommended`
- `GET /v1/catalog/search?type=pro&fit=runnable`
- `GET /v1/catalog/search?type=other`
- `GET /v1/catalog/search?device=base&fit=recommended`
- `GET /v1/catalog/search?device=pro&fit=runnable`

`type=base` and `type=pro` select the corresponding device profile; `type=other` means unrestricted. `fit=runnable` includes both `recommended` and `runnable` models. Omit `type`/`device`/`fit` for the unrestricted catalogue. The legacy `device` and `deviceClass` parameters remain supported, but `type` takes precedence when both are present. After applying migration `0008_device_fit.sql`, run `backfill-device-fit.ts` once to label existing rows; future Worker syncs write the labels automatically.

## Refresh pending model metadata

`workers/model-catalog/scripts/refresh-unverified-d1.sh` reads the local `claudflare` configuration, calls the public ModelScope legacy detail API, and refreshes pending `models` rows plus `model_files` in bounded batches. Set `REFRESH_BATCH_LIMIT`, `REFRESH_CONCURRENCY`, or `REFRESH_LOG` to adjust the run.

## Catalogue ordering and publication backfill

Search results use a stable order: parameter count ascending, then authoritative ModelScope publication time descending, then repository ID. Models without a parameter count are last. The legacy `sortby` parameter remains accepted but cannot change this catalogue order.

After applying migration `0009_published_at_cursor.sql`, run `backfill-published-at.ts` once to obtain `published_at` from the ModelScope detail API for existing records. The script requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`; set `PUBLISHED_AT_DRY_RUN=1` first to inspect its counts without writes.
