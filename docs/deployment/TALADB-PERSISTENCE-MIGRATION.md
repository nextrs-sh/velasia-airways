# TalaDB persistence migration (plan, not executed)

**Status: proposed, awaiting owner approval. Blocked on one decision (the current data, below).**
Nothing in this document has been run against production. M9.2 did not reset TalaDB, delete
records, redeploy the API, attach a volume or change the API's build.

## Where things stand

| Fact                 | Production today (verified 2026-11-26)                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database file        | `TALADB_PATH=/data/velasia.db`, inside the container's **ephemeral** filesystem (no volume in the project)                                                              |
| Build / process      | Railpack, `pnpm --filter @velasia/retailing-api start` = `tsx src/server.ts`; `docker/api/start.sh` never runs                                                          |
| Volume guard         | `TALADB_REQUIRE_VOLUME=enabled` is set but **inert** (only `start.sh` reads it)                                                                                         |
| Lifetime of the data | Until the next API deployment or restart. The last one was 2026-11-26 02:47 UTC                                                                                         |
| Redeploy triggers    | Any variable change on the API, a manual redeploy, a restart, or a merge to `main` touching `apps/retailing-api/**` (autodeploy on)                                     |
| Content              | Unknown from outside (no shell was opened). Inventory is computed from the seed and not stored; orders, holds, accounts, sessions, travellers and shopping sessions are |

**Every API redeploy today starts from an empty database.** Attaching a volume is itself a
redeploy: the container that holds the current file is replaced. The file is not moved or copied,
and the new container's `/data` is the (empty) volume. So "attach a volume" never preserves the
current data by itself.

## TalaDB facts that decide the method

From `apps/retailing-api/src/db/client.ts`, `src/tools/db-tool.ts` and `taladb@0.13.1`:

- **One file, one owner.** The API opens the database once at startup and holds TalaDB's
  **exclusive file lock** until shutdown; a second opener fails (`already open` /
  `acquire lock`).
- **Durability:** opened with `flush_every_write: true`, so every committed write (orders,
  payments, holds) is durable in the file. Shopping sessions use write-behind batching (`batched`,
  the default) and are flushed on graceful shutdown. A kill (SIGKILL; Railway's draining default
  is 0 s) can lose the last batch of shopping-session changes, never an order.
- **No online backup.** TalaDB 0.13 has no snapshot or export API, and copying the file while the
  API writes is not safe (the db-tool header says so). `db-tool backup` first takes the exclusive
  lock, so it **only works with the API stopped**: a cold, quiesced copy. It then fsyncs the copy,
  records its SHA-256 and runs a full integrity check (`checkIntegrity`) on a scratch copy.
  Restores re-check the checksum and integrity, never overwrite without `--replace`, keep the
  replaced file and swap with an atomic rename. Backups are 0600 and contain personal data.
- **Companion files:** the tooling treats the database as a single file. Confirm when the
  directory is first listed (step 2) that `/data` holds nothing else the API needs.
- **Startup** opens the file or creates an empty one, applies migrations, records the schema
  version, and refuses a file written by a newer, incompatible build. Nothing seeds orders and
  nothing resets the database automatically.
- **Writers inside the API:** request handlers plus the order sweep every 30 s
  (`ORDER_SWEEP_INTERVAL_MS`), so "no traffic" does not mean "no writes".

## The blocker: no consistent backup of the current file is possible

A consistent backup needs the API stopped (the lock). Stopping the API on Railway ends the
container, and with it the ephemeral disk that holds the file. No supported mechanism takes a
consistent copy of today's database. **This is the stop condition "the API database cannot be
backed up consistently"**, so the migration cannot be executed as a data-preserving operation
without one of these owner decisions:

| Option                                   | What it means                                                                                                                                                                                                                                                                                                                                                | Consistency                                                                              | Needs                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------- |
| **A. Accept the loss (recommended)**     | The data since 2026-11-26 02:47 UTC is demo data of a fictional airline, already lost on every API redeploy. Migrate onto an empty volume, and make the next redeploy the last data-losing one.                                                                                                                                                              | n/a                                                                                      | Owner confirms nothing in it must be kept |
| B. Best-effort hot copy                  | `railway ssh` into the API container (owner-approved). Copy `/data/velasia.db` out twice, a few seconds apart and away from a sweep tick (`tar \| base64` on stdout), and keep it only if both SHA-256 match and `db-tool verify` passes on the copy in a local Linux container. An unchanged file across the window means no commit landed during the copy. | Not guaranteed (crash-consistent at best); integrity-checked                             | SSH exec approval; a quiet window         |
| C. Add an online export to the API first | New code (for example an authenticated, lock-holding export through the running process).                                                                                                                                                                                                                                                                    | Consistent, **but deploying it redeploys the API and destroys the data it would export** | Only useful for future backups            |

After the migration, backups are cold `db-tool backup` copies taken in a maintenance window (the
API stopped, with the volume keeping the file). Railway volume backups (Backups tab) are added
where the plan offers them. They are restorable only into the same project and environment, and
wiping a volume deletes its backups.

## Runbook (after approval, in one maintenance window)

Estimated API downtime: **about 1–3 minutes per API redeploy, two redeploys** (estimates; Railway
stops the old deployment before a volume-backed one starts, plus startup and the health check).
Image builds happen before the switch and do not count. The storefronts stay up throughout:
prerendered pages work, and booking/search answer "temporarily unavailable" while the API is
down.

**0. Preconditions.** Owner approval of this runbook, of the option (A or B), and of the exact
plans. Merges to `main` touching `apps/retailing-api/**` are frozen for the window (autodeploy).
No benchmark runner exists.

1. **Record the database's identity.** Active deployment ID, image digest and commit
   (`railway status --json`). Startup log lines with the schema version (`railway logs -s
@velasia/retailing-api -d <id>`). Save them to private evidence.
2. **Locate the file.** `TALADB_PATH=/data/velasia.db` (variables). With option B: list `/data`
   (size, other files).
3. **Backup method.** Option A: none (documented decision). Option B: the hot-copy procedure
   above.
4. **Export.** Option B: the copy plus any companion file found in step 2.
5. **Durable storage.** Owner's encrypted storage, mode 0600; never Git, CI artefacts or chat.
6. **Verify.** `sha256sum`; `node dist/db-tool.mjs verify --db <copy>` in a local container built
   from `docker/Dockerfile.api` (TalaDB has no darwin-x64 binary; use Linux).
7. **Restore into an isolated environment.** `pnpm docker:restore` into the local Compose stack
   with the same image, then start the API on it.
8. **Check records.** The integrity report's counts (orders, accounts, sessions, travellers) and
   a sample of order references through the local storefront.
9. **Prepare the volume (plan only).** Write `.railway/proposals/taladb-volume.ts`:
   - `volume('velasia-api-data', { region: 'iad', sizeMB: 500 })` (Trial maximum 0.5 GB) mounted
     at `/data`;
   - the API built from `docker/Dockerfile.api` (`builder: 'DOCKERFILE'`, no build or start
     command, so the entrypoint `start.sh` and `node dist/server.mjs` run);
   - `RAILWAY_RUN_UID=0` (the volume mounts root-owned; `start.sh` gives `/data` to uid 1000 and
     drops privileges), `NODE_ENV=production`, health check `/health/ready`,
     `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`;
   - **`TALADB_PATH=/data/bootstrap.db`** for the first start (see step 11).

   Its `expectedChanges` must be exactly the volume `resource.create`, the API `resource.update`
   and the listed `variable.set` entries. `pnpm railway:plan-gate --file …` must pass. Update
   `scripts/railway/expected-production.mjs` and the rules (the volume becomes expected) in the
   same PR. Note that `RAILWAY_RUN_UID=0`, `NODE_ENV` and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` are
   on the M9.2 pending list on purpose.

10. **Apply (owner) = API redeploy 1.** Railway builds the Docker image, stops the Railpack
    deployment and starts the new one with the volume. `start.sh` refuses to start unless `/data`
    is a mount point (the guard is now live), then the API creates an empty `bootstrap.db`.
    `/health/ready` gates the switch. The storefronts reconnect on their own: the private host
    name does not change, and its IPv4 address does, which stays inside the NextRS allowlist.
    Re-check it with `railway logs --dns`.
11. **Restore onto the volume (option B only).** Volumes mount only at runtime, so nothing can be
    baked into the image. The API holds the lock on `bootstrap.db`, not on `velasia.db`, so:
    copy the verified backup in over `railway ssh` as `/data/velasia.db`, run `node
dist/db-tool.mjs verify --db /data/velasia.db` in the container, then set
    `TALADB_PATH=/data/velasia.db` (a one-variable proposal through the gate) = **API redeploy
    2**. Option A: also set `TALADB_PATH=/data/velasia.db` now, so the final path is the
    documented one (or keep `bootstrap.db`, decided in the proposal).
12. **Ownership.** `start.sh`, running as root, gives top-level files in `/data` to uid 1000 at
    every start. Nothing else is needed after an SSH copy as root.
13. **One process.** One replica (Railway refuses replicas with a volume), TalaDB's lock, and no
    deployment overlap for volume-backed services. Startup logs show the database opened once.
14. **Survives restart and redeploy.** Create one demo booking (`VEL-…` reference recorded), then
    `railway restart` and one more redeploy. The booking is still retrievable, and the startup log
    says `opening the existing database at /data/velasia.db`.
15. **Rollback.** Before step 10: nothing changed. After it, roll back to the Railpack deployment
    in the dashboard, or apply the M9.2 `railway.ts`: the volume is not attached, and the data on
    it stays untouched for a later retry. Any data written while rolled back is ephemeral again.
    A bad restore in step 11: point `TALADB_PATH` back at `bootstrap.db`. The restored file and
    the backup stay where they are. Never delete the volume as a rollback step: deleting a volume
    deletes its backups too.

## After the migration

- Fold the proposal into `.railway/railway.ts` and `expected-production.mjs`: the volume and
  Docker build become current state, and the "no volume" rules become "exactly this volume".
- Schedule cold backups (maintenance window) and enable Railway volume backups where available.
- Then the auth rollout's enforcement stage, which also redeploys the API
  ([RAILWAY-AUTH-ROLLOUT.md](RAILWAY-AUTH-ROLLOUT.md)), can be scheduled without losing data.
