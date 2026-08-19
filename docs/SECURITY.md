# TamgaBase Security & Isolation Model

## 1. Authentication Separation
TamgaBase implements strict role separation:
- **Server Key (`tb_sk_...`):** High-privileged credential. Granted only to server admins. Used to create/delete clusters.
- **Cluster Key (`tb_cl_...`):** Scoped credential. Granted to clients/nodes. Used only to push/pull data for a specific cluster.

## 2. Cluster Isolation & Authorization
- Every Data API request to `/api/v1/clusters/:clusterId/...` is intercepted by `requireClusterAuth` middleware.
- The middleware extracts the `tb_cl_...` token, looks up the exact Cluster ID it belongs to.
- It compares the requested `:clusterId` in the URL with the token's authenticated Cluster ID.
- **If they mismatch, a `403 Forbidden` is thrown instantly.**
- A client cannot spoof `cluster_id` in the URL or Body to access another cluster's data.

## 3. Path Traversal & Injection Prevention
- All user-supplied strings (Cluster IDs, Snapshot IDs, Hashes) are aggressively sanitized.
- Hashes must match `/^[a-f0-9]{64}$/i`.
- Cluster/Snapshot IDs are stripped of any characters other than `a-z0-9-_`. Paths like `../../` are intrinsically neutralized before they reach the `StorageBackend`.

## 4. Key Leakage Prevention
- Keys are stored locally with `0o600` (`chmod 600`) permissions.
- Keys are NEVER written to logs (Logger masks them).
- Keys are NEVER included in error responses or normal GET responses (unless explicitly returned upon creation/rotation).

## 5. Quota Bypass Protection & Race Conditions
- Storage limits are enforced logically.
- Concurrent uploads to the same cluster might trigger race conditions if quota is checked naively. 
- Quota is recalculated deterministically when a new Snapshot is committed.
- **In-flight reservation:** `ClusterManager.checkAndReserveQuota` increments an in-memory per-cluster
  `inFlightBytes` counter BEFORE the physical write and releases it after (in `finally`). Parallel uploads
  near the limit are therefore rejected with `402 Quota Exceeded` — the quota cannot be bypassed with
  simultaneous requests (TOCTOU protected). This works identically on both backends.
- Atomic `.tmp` to final `fs.rename` ensures no partial/corrupted files exist on disk (local).
- Single-part atomic `PutObject` ensures no partial objects on S3; interrupted client uploads never leave
  a partial object in the bucket.

## 6. AWS S3 Security (v1.3+)
- **Credentials never touch disk or code:** `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are read
  exclusively from environment variables at server startup. They are never written to `config.json`,
  snapshots, logs, API responses, or error messages. The `S3StorageBackend.mapError` layer maps every
  AWS exception to a generic message (e.g. `S3: invalid AWS credentials`, `S3: Access Denied`) so raw
  AWS error bodies cannot leak anything.
- **Bucket scope:** the backend only talks to the configured bucket. It performs no `ListBuckets`, no
  cross-account discovery, and no lifecycle/ACL operations.
- **Minimum IAM permissions** (recommended policy for the TamgaBase server role):
  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "s3:GetObject",
          "s3:PutObject",
          "s3:HeadObject",
          "s3:ListBucket"
        ],
        "Resource": [
          "arn:aws:s3:::YOUR-BUCKET",
          "arn:aws:s3:::YOUR-BUCKET/*"
        ]
      }
    ]
  }
  ```
  `s3:ListBucket` is only needed for `listObjects` (used by tests/cleanup); the server itself works with
  `GetObject`/`PutObject`/`HeadObject` alone.
- **Failure handling:** invalid credentials, wrong bucket, wrong region, and network errors are mapped to
  meaningful `S3: ...` errors; the server never crashes and `/api/v1/health` remains responsive.
- **Throttling:** `SlowDown` (503) responses are retried with backoff (up to 3 attempts).
