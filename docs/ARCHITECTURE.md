# TamgaBase Architecture

## 1. System Overview
TamgaBase is a self-hosted, Git-like, content-addressable synchronization and storage system. 
Version 1.2+ introduces **Multi-Tenancy** through isolated "Clusters", while maintaining global deduplication.
Version 1.3 adds **pluggable storage backends**: local disk and AWS S3.

## 2. Core Abstractions

### 2.1 StorageBackend
TamgaBase relies on the `StorageBackend` interface (`src/storage/interface.ts`). The core system NEVER calls
backend-specific APIs directly for object storage — it only goes through the interface.

```
StorageBackend
    ├── LocalStorageBackend   (default, unchanged behavior)
    └── S3StorageBackend      (AWS S3, v1.3+)
```

Both backends MUST implement the same contract and semantics:

| Method            | Semantics                                                                 |
|-------------------|---------------------------------------------------------------------------|
| `writeObject`     | Store content by SHA-256 hash. If the object already exists, it is a no-op (CAS deduplication). |
| `readObject`      | Read full object bytes.                                                    |
| `readObjectStream`| Stream object body for large downloads.                                    |
| `hasObject`       | Existence check (returns `false` for missing objects, never throws on 404).|
| `writeMetadata`   | Atomic store of any JSON metadata (cluster configs, snapshots, token index).|
| `readMetadata`    | Read metadata; `null` if missing.                                          |

The server (`src/server/app.ts`) and `ClusterManager` are typed against `StorageBackend`,
so a new backend can be added without touching server logic.

### 2.2 Atomicity Guarantees
- **Local backend:** write to `.tmp` then `rename()` → atomic on same filesystem.
- **S3 backend:** single-part `PutObject` is atomic; an interrupted upload never leaves a partial object.
  `SlowDown` (503) throttling is retried with exponential backoff (`putWithRetry`).

### 2.3 Object / Metadata Layout (both backends mirror each other)
- Objects (CAS): `<prefix>/objects/<first_2_hex>/<remaining_62_hex>`
- Metadata:    `<prefix>/metadata/<safeKey>.json`
  - `cluster_config_<clusterId>` — cluster config (key, quota, usage)
  - `cluster_token_index` — token → cluster mapping
  - `cluster_<clusterId>_<snapshotId>` — snapshots
  - `cluster_<clusterId>_latest` — latest snapshot pointer
- `prefix` is empty for local (under storage root) and configurable for S3 (e.g. `tamgabase`, `e2e-test-...`).

### 2.4 Global Deduplication (Content Addressable Storage - CAS)
All objects uploaded to TamgaBase are identified by their SHA-256 hash.
- If Cluster A and Cluster B upload the exact same file, it is only stored physically once (on disk or in S3).
- The server re-validates the hash of every uploaded body before storing (`400 Hash Mismatch` otherwise).

### 2.5 Clusters & Isolation
A Cluster is a strict security and authorization boundary representing a project or namespace.
- Each Cluster has its own `cluster_id` and `access_key` (`tb_cl_...`).
- Cluster metadata and snapshots are stored independently.
- The token in the `Authorization` header is mapped to its cluster; a mismatch with the URL `clusterId`
  returns `403 Forbidden` (isolation breach is logged server-side).

### 2.6 Quota Model (Logical vs Physical)
Because of CAS, physical storage size does not match logical usage.
- **Physical Storage:** total bytes of deduplicated objects (disk / S3).
- **Logical Quota:** per-cluster; usage = sum of file sizes in the cluster's `latest` snapshot.
- **In-flight protection:** `ClusterManager` keeps an in-memory `inFlightBytes` counter per cluster so that
  parallel uploads near the limit are still rejected with `402 Quota Exceeded` (no TOCTOU bypass).

## 3. Concurrency Model
To handle thousands of objects without exhausting RAM or network sockets:
- Client push/pull uses `p-limit` with `CONCURRENCY_LIMIT = 5` (not `Promise.all` over all files).
- Server-side quota checks use the in-flight reservation counter described above.
- S3 bursts are absorbed by the backend's `SlowDown` retry with backoff.

## 4. Backend Selection
`tamgabase storage local` / `tamgabase storage s3` writes `storageBackend` into `config.json`.
- `local` is the default and behaves exactly as v1.2.
- `s3` reads credentials exclusively from environment variables (never from config.json):
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` (or `AWS_DEFAULT_REGION`), `AWS_S3_BUCKET`,
  optional `TAMGABASE_S3_PREFIX`.