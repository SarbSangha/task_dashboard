# Generation Recovery & Project Organization

## Phase 1 Implementation Report

Date: 2026-06-24

Scope: database design only. No runtime schema or API behavior was changed in this phase.

## Existing Architecture Review

### Current generation-adjacent storage

1. `backend/models_new.py`
   - `ITPortalToolUsageEvent` is the closest thing to a generation record today.
   - It already stores Kling-oriented fields such as `generation_id`, `request_id`, `prompt_text`, credits, `status`, and `metadata_json`.
   - `metadata_json` already carries rich capture details including `mediaAssets`, `assetHistory`, `pipelineDiagnostics`, and inferred `ownership`.
   - `user_id` is `NOT NULL`, which is a critical constraint for recovery because Phase 7 requires an unknown-owner queue.

2. `backend/routers/it_tools_router.py`
   - Capture, dedupe, and export logic is built around `ITPortalToolUsageEvent`.
   - Duplicate heuristics already inspect task IDs, generation IDs, output URLs, and metadata-derived internal IDs.
   - This is valuable raw capture data, but it is still an event log, not a clean canonical generation domain model.

3. `backend/models_new.py` and `backend/routers/tasks_router.py`
   - The current `Task` model has `project_id`, `project_name`, `project_id_raw`, and `project_id_hex`.
   - These fields drive task organization and the existing workspace “Projects” tab.
   - This is task grouping, not generation grouping, so Phase 1 must not overload it.

4. `backend/db_migrations.py`
   - The project uses an idempotent migration style in one centralized file rather than Alembic.
   - Migrations are expected to work against PostgreSQL and to remain startup-safe with `create_all()` plus `ensure_operational_schema()`.

### Why the existing usage-event table is not enough on its own

`it_portal_tool_usage_events` should remain the raw capture source of truth, but it should not be the only persistence model for recovered generations.

Reasons:

1. `user_id` is required today, but recovered rows may have no determinable owner yet.
2. The table mixes multiple event types, while recovery needs one canonical row per recoverable generation.
3. Project organization is a lifecycle/domain concern, not a raw telemetry concern.
4. Forcing recovery state into the event log would couple admin reconciliation logic to existing capture flows and increase regression risk.

## Phase 1 Decision Summary

### Necessary new entities

1. `generation_records`
   - Necessary.
   - This becomes the canonical generation domain table for both captured and recovered generations.

2. `generation_projects`
   - Necessary.
   - This supports user-owned grouping without colliding with task project folders.

3. `generation_recovery_audits`
   - Necessary.
   - This provides reconciliation/import audit history and supports admin review.

### Not necessary as separate entities in Phase 1

1. `GenerationProject`
   - Not necessary as a separate join table yet.
   - Current requirements only need zero-or-one active project per generation, plus remove/move support.
   - A nullable `project_id` on `generation_records` is the smallest safe design.

2. `GenerationOwnership`
   - Not necessary as a separate table in Phase 1.
   - Current ownership requirements can be modeled directly on `generation_records` with nullable owner fields and ownership status fields.
   - If Phase 7 later needs multi-claim history, disputes, or approval workflows with full lineage, a dedicated ownership-history table can be introduced then.

## Proposed Schema

### 1. `generation_records`

Purpose: canonical generation row used by project grouping, recovery import, unknown-owner queue, and future ownership claims.

Suggested columns:

- `id` bigint/integer primary key
- `provider` varchar(40) not null default `'kling'`
- `provider_task_id` varchar(160) null
- `provider_generation_id` varchar(160) null
- `canonical_asset_url` text null
- `canonical_asset_key` varchar(255) null
- `prompt_text` text null
- `model_label` varchar(255) null
- `duration_label` varchar(80) null
- `resolution_label` varchar(80) null
- `credits_burned` double precision/float null
- `ingestion_source` varchar(40) not null
  - Expected values: `captured`, `recovered`
- `capture_status` varchar(40) not null default `'active'`
  - Expected values for Phase 1 storage only: `active`, `archived`
- `owner_user_id` integer null references `users(id)` on delete set null
- `ownership_status` varchar(40) not null default `'unknown'`
  - Suggested values: `unknown`, `resolved`, `claimed_pending`, `claimed`
- `ownership_source` varchar(80) null
- `ownership_notes` text null
- `assigned_by_admin_id` integer null references `users(id)` on delete set null
- `assigned_at` timestamp null
- `project_id` integer null references `generation_projects(id)` on delete set null
- `source_usage_event_id` integer null references `it_portal_tool_usage_events(id)` on delete set null
- `recovery_audit_id` integer null references `generation_recovery_audits(id)` on delete set null
- `recovered_by_admin_id` integer null references `users(id)` on delete set null
- `recovered_at` timestamp null
- `metadata_json` json null
- `created_at` timestamp not null
- `updated_at` timestamp not null
- `archived_at` timestamp null

Required indexes and constraints:

- unique partial index on `(provider, provider_task_id)` where `provider_task_id is not null`
- unique partial index on `(provider, provider_generation_id)` where `provider_generation_id is not null`
- unique partial index on `(provider, canonical_asset_key)` where `canonical_asset_key is not null`
- unique index on `source_usage_event_id` where `source_usage_event_id is not null`
- index on `(owner_user_id, project_id, created_at desc)`
- index on `(owner_user_id, ownership_status, created_at desc)`
- index on `(project_id, created_at desc)`
- index on `(ingestion_source, created_at desc)`
- check or application validation requiring at least one of:
  - `provider_task_id`
  - `provider_generation_id`
  - `canonical_asset_key`

Design notes:

1. `UNGROUPED` should be derived from `project_id is null`, not stored as a primary status value.
2. `UNKNOWN_OWNER` should be derived from `ownership_status = 'unknown'`.
3. `RECOVERED` and `CAPTURED` should be modeled via `ingestion_source`, not mixed into ownership/project state.
4. This avoids one overloaded status column trying to represent multiple orthogonal states at once.

### 2. `generation_projects`

Purpose: user-owned container for generation grouping.

Suggested columns:

- `id` bigint/integer primary key
- `owner_user_id` integer not null references `users(id)` on delete cascade
- `name` varchar(200) not null
- `normalized_name` varchar(200) not null
- `description` text null
- `created_by` integer null references `users(id)` on delete set null
- `updated_by` integer null references `users(id)` on delete set null
- `created_at` timestamp not null
- `updated_at` timestamp not null
- `archived_at` timestamp null

Required indexes and constraints:

- unique index on `(owner_user_id, normalized_name)` for active rows
- index on `(owner_user_id, updated_at desc)`
- index on `archived_at`

Design notes:

1. This table must be independent from `tasks.project_id` and `tasks.project_name`.
2. Deleting a project should not delete generation records; `generation_records.project_id` should be nulled.
3. “Ungrouped generations” becomes a fast query on `generation_records` where `project_id is null`.

### 3. `generation_recovery_audits`

Purpose: immutable admin audit log for reconciliation and import activity.

Suggested columns:

- `id` bigint/integer primary key
- `provider` varchar(40) not null default `'kling'`
- `action_type` varchar(40) not null
  - Suggested values: `reconcile`, `preview_missing`, `import_missing`
- `requested_by_admin_id` integer not null references `users(id)` on delete restrict
- `date_from` date not null
- `date_to` date not null
- `kling_count` integer not null default `0`
- `database_count` integer not null default `0`
- `missing_count` integer not null default `0`
- `imported_count` integer not null default `0`
- `duplicate_count` integer not null default `0`
- `status` varchar(40) not null
  - Suggested values: `started`, `completed`, `failed`
- `filters_json` json null
- `report_json` json null
- `error_message` text null
- `started_at` timestamp not null
- `completed_at` timestamp null
- `created_at` timestamp not null

Required indexes:

- index on `(requested_by_admin_id, created_at desc)`
- index on `(provider, action_type, created_at desc)`
- index on `(date_from, date_to, created_at desc)`

Design notes:

1. Imported `generation_records` rows should optionally point back to the audit row that created them.
2. Reconciliation reports can be retained without forcing preview rows into permanent domain tables.

## ERD Summary

Relationships:

1. `users (1) -> (many) generation_projects`
2. `generation_projects (1) -> (many) generation_records`
   - nullable from the generation side to support ungrouped rows
3. `users (1) -> (many) generation_records`
   - via `owner_user_id`
   - nullable to support unknown ownership
4. `users (1) -> (many) generation_records`
   - via `assigned_by_admin_id` and `recovered_by_admin_id`
5. `it_portal_tool_usage_events (1) -> (0..1) generation_records`
   - optional canonical link when a captured usage event has been normalized
6. `generation_recovery_audits (1) -> (many) generation_records`
   - optional link for imported/recovered rows

High-level data flow:

1. Existing Kling capture remains in `it_portal_tool_usage_events`.
2. Canonical rows are created in `generation_records`.
3. User grouping lives in `generation_projects`.
4. Admin reconciliation/import actions are stored in `generation_recovery_audits`.

## Backward Compatibility Strategy

1. Do not alter `tasks.project_id`, `tasks.project_name`, or workspace task project behavior.
2. Do not repurpose `ITPortalToolUsageEvent.status` for ownership/project lifecycle.
3. Do not make existing task or usage-event reads depend on new tables.
4. Keep new foreign keys nullable where data may legitimately be unresolved.
5. Add new tables first, then backfill, then add Phase 2/4 APIs.

## Additional Pre-Phase 2 Collision Review

This review was added before implementation to specifically check collisions with the existing workspace project system.

### Finding 1. Frontend already treats "Projects" as task folders

Confirmed in:

1. `my-dashboard/src/components/leftsidebar/compofleftsidebar/workspace/WorkSpaceModal.jsx`
   - The workspace has a first-class tab keyed as `projects`.
2. `my-dashboard/src/components/leftsidebar/compofleftsidebar/workspace/tabs/ProjectsTab.jsx`
   - The UI copy explicitly says task project folders are created by using the same task project name.
3. `my-dashboard/src/components/leftsidebar/compofleftsidebar/workspace/workspaceTabData.js`
   - `buildProjectSummaries()` groups the workspace dataset from `task.projectId` and `task.projectName`.

Implication:

The frontend does currently assume one visible project system inside Workspace, and that system is task-folder based.

Guardrail:

Do not attach generation projects to the existing workspace `projects` tab or its current data loader without a deliberate UI refactor. Generation projects need their own tab, route, or explicit naming such as `Generation Projects`.

### Finding 2. No current generic `/api/projects` endpoint was found

Confirmed in:

1. `backend/routers/tasks/__init__.py`
   - Existing task endpoints are namespaced under `/api/tasks`.
2. `backend/routers/tasks/task_core_router.py`
   - Task project helpers live under `/api/tasks/project-id/*`, not a generic `/api/projects`.
3. frontend API search
   - Existing client code does not currently call a general `/api/projects` endpoint.

Implication:

There is no live backend path collision today, but using a generic `/api/projects` now would still be risky because "projects" already means task projects throughout the product.

Guardrail:

Use explicit namespaces:

1. `/api/generation-projects` for user-owned generation project APIs
2. `/api/generations/*` for generation record APIs
3. `/api/admin/generation-recovery/*` for admin reconciliation and import APIs

Avoid introducing a generic `/api/projects` route.

### Finding 3. Shared permission middleware is role-based, not project-based

Confirmed in:

1. `backend/utils/permissions.py`
   - Shared access control is role-based only.
2. `my-dashboard/src/hooks/usePermissions.js`
   - Frontend permission snapshots are also role-based only.

Implication:

There is no central middleware today that assumes project ownership only applies to tasks.

Guardrail:

Generation project ownership checks must be added explicitly in generation project handlers. Do not infer access from task creator/participant logic.

### Finding 4. Task object permissions are enforced inline in task handlers

Confirmed in:

1. `backend/routers/tasks_router.py`
   - Task visibility and edit rules are implemented with task-specific checks such as creator, assignee, and participant membership.

Implication:

If generation project APIs are added, they need dedicated owner-based checks and should not reuse task participant semantics.

Guardrail:

Introduce small, generation-specific authorization helpers in the new generation router or service layer, for example:

1. can view own generation project
2. can create own generation project
3. can edit own generation project
4. admin-only recovery actions

### Finding 5. Existing task asset directories also use task project naming

Confirmed in:

1. `backend/routers/tasks_router.py`
   - task asset directory grouping supports `project` as a grouping criterion
2. trendings/workspace UI
   - project labels shown there are task-project labels

Implication:

Generation project names should not be written into existing task asset `projectName` fields as a shortcut.

Guardrail:

Keep task project metadata and generation project metadata fully separate.

## Confirmed Product Decisions

The following requirements were explicitly confirmed before Phase 2 implementation:

1. One generation belongs to only one project.
2. Deleting a project must not delete generations; they become Ungrouped.
3. Recovered generations should auto-assign ownership only when confidence is very high; otherwise they move to the Unknown Queue.
4. Future support for prompt tags such as `#project: ProjectName` is important and should be considered in the design.
5. Kling is the reconciliation source of truth; reconciliation should add missing records into the database, not delete database rows.
6. Unknown ownership claims may require admin approval.
7. Capture Center must support both single-day and date-range reconciliation.
8. Any generation without a project must automatically appear in Ungrouped Generations.

## Migration Plan

### Revised rollout recommendation

For deployment safety, the original Phase 2 should be split into smaller delivery slices:

1. Phase 2A: schema, migration, and backfill only
2. Phase 2B: project create/list APIs only
3. Phase 2C: assignment and ungrouped behavior APIs

This reduces the blast radius if migration or backfill uncovers data-quality issues.

### Phase 2A. Add new tables only

Add the following SQLAlchemy models and matching idempotent migration DDL:

1. `GenerationProject`
2. `GenerationRecord`
3. `GenerationRecoveryAudit`

Do not modify existing query paths yet.

### Phase 2A. Add indexes and constraints

Create all supporting indexes in the same migration pass, especially:

1. duplicate-prevention partial unique indexes
2. ownership queue indexes
3. user-project listing indexes
4. recovery audit date-range indexes

For PostgreSQL:

1. use partial unique indexes for nullable identity fields
2. use explicit `ON DELETE SET NULL` / `ON DELETE CASCADE` actions

For local compatibility:

1. keep migration code idempotent inside `backend/db_migrations.py`
2. avoid startup-breaking DDL assumptions
3. mirror existing `create_all()` plus `ensure_operational_schema()` flow

### Phase 2A. Backfill captured generations

Backfill `generation_records` from `it_portal_tool_usage_events` only for rows that represent real Kling generations.

Backfill mapping rules:

1. `provider = 'kling'`
2. `provider_task_id` from best available task/generation identifier
3. `provider_generation_id` from existing generation-specific IDs when present
4. `canonical_asset_key` from normalized output asset URL
5. `owner_user_id` from the captured user when confidently known
6. `source_usage_event_id` set to the source event row
7. `ingestion_source = 'captured'`

Backfill must be idempotent and use the new unique indexes to avoid duplicates.

Additional backfill guardrails:

1. do not fail the whole run because one source row is malformed
2. log inserted, skipped, duplicate, and unresolved counts
3. produce a dry-run mode before first production execution
4. keep backfill replay-safe so the same script can be rerun after fixes
5. auto-assign `owner_user_id` only when confidence is very high
6. leave low-confidence ownership unresolved for the future Unknown Queue flow

### Phase 2B. Enable project create/list APIs only

Once tables exist and backfill is stable:

1. add create/list project APIs

No assignment or move behavior should be included in this slice.

Recommended Phase 2B endpoints:

1. `POST /api/generation-projects`
2. `GET /api/generation-projects`

Required checks:

1. a user can only create projects for themself
2. a user can only list their own active generation projects
3. name normalization prevents duplicate active project names per owner
4. deleting a project is not required in this slice

### Phase 2C. Enable assignment and ungrouped behavior

Only after Phase 2A and 2B are stable:

1. add assign generation to project API
2. add remove generation from project API
3. add ungrouped generations query
4. add move generation between projects API

Required checks:

1. one generation belongs to only one project at a time
2. ungrouped is always derived from `project_id is null`
3. project deletion must null `project_id` instead of deleting generation rows

### Later Phase 4. Enable recovery counts

After canonical generation rows exist:

1. add admin reconciliation endpoint
2. compare Kling source results against `generation_records`
3. write audit rows for counts and reports
4. do not import yet

Additional recovery design constraints:

1. support both single-day and date-range reconciliation
2. treat Kling as the source of truth for finding missing generations
3. never delete local generation rows during reconciliation

### Later phases. Enable recovery import and claims

Future phases can safely build on this schema by:

1. inserting recovered rows with `ingestion_source = 'recovered'`
2. leaving `owner_user_id` null when unknown
3. placing rows into the unknown queue via `ownership_status = 'unknown'`
4. linking imports to `generation_recovery_audits`
5. requiring admin approval for unknown-owner claims where policy demands it

### Prompt tag future-proofing

Prompt tags are important, but they do not need a dedicated Phase 2 schema table yet.

Recommendation:

1. preserve prompt text on `generation_records`
2. reserve prompt-tag parsing for application logic in a later phase
3. when prompt-tagging is introduced, project auto-assignment must still respect user ownership boundaries and confidence rules

## Risk Analysis

### 1. Overloading the existing usage-event table

Risk:

Using `it_portal_tool_usage_events` directly for recovered unknown-owner rows would either require nulling a currently required `user_id` or storing fake ownership.

Impact:

High. This can corrupt permission assumptions and break existing reporting/export behavior.

Mitigation:

Introduce `generation_records` as a canonical domain table and keep `it_portal_tool_usage_events` as raw capture history.

### 2. Colliding with current task project behavior

Risk:

Reusing `tasks.project_id` or `tasks.project_name` for generation grouping would blur task folders with user-owned generation projects.

Impact:

High. Existing workspace project views could change behavior unexpectedly.

Mitigation:

Create a separate `generation_projects` table and keep task project fields unchanged.

### 3. Duplicate recovered imports

Risk:

The same Kling generation may be rediscovered by task ID, generation ID, or asset URL in separate runs.

Impact:

High. Duplicate rows would pollute project views and ownership workflows.

Mitigation:

Use partial unique indexes on all three identity paths and require at least one canonical identity field before insert.

### 4. One status field doing too much

Risk:

Combining `RECOVERED`, `UNKNOWN_OWNER`, `UNGROUPED`, and `CLAIMED` into one column creates invalid state combinations and brittle business logic.

Impact:

Medium to high.

Mitigation:

Split state into orthogonal fields:

1. `ingestion_source`
2. `ownership_status`
3. `project_id is null` for ungrouped
4. `archived_at` or `capture_status` for archival state

### 5. Backfill quality from existing metadata

Risk:

Historical capture rows may have incomplete or inconsistent identifiers.

Impact:

Medium.

Mitigation:

1. Backfill only rows meeting minimum identity confidence.
2. Preserve source metadata in `metadata_json`.
3. Log unmatched candidates into audit reports instead of forcing inserts.

### 6. Migration style mismatch

Risk:

Adding Alembic-style assumptions to a codebase using `create_all()` plus `ensure_operational_schema()` can create drift or startup failures.

Impact:

Medium.

Mitigation:

Implement Phase 2 schema work inside the current model and `db_migrations.py` pattern.

### 7. Workspace naming collision

Risk:

Users and developers may confuse task project folders with generation projects because the current workspace already has a `Projects` tab backed by task data.

Impact:

High. This is a likely source of regression and UX confusion.

Mitigation:

1. keep generation project APIs and models explicitly namespaced
2. avoid wiring generation data into the current workspace `Projects` tab
3. introduce generation-specific UI naming when that phase begins

## Affected Files For Future Phases

Backend:

- `backend/models_new.py`
- `backend/db_migrations.py`
- `backend/run_db_migrations.py`
- `backend/routers/it_tools_router.py`
- `backend/routers/tasks/workspace_router.py`
- `backend/routers/tasks_router.py`
- `backend/schemas.py`

Frontend:

- `my-dashboard/src/services/api.js`
- `my-dashboard/src/components/leftsidebar/compofleftsidebar/workspace/Tools.jsx`
- `my-dashboard/src/components/leftsidebar/compofleftsidebar/workspace/tabs/ProjectsTab.jsx`
- any future admin Capture Center components

## Phase 1 Verification

Changed files reviewed:

1. `docs/generation-recovery-project-organization-phase-1.md`

Verification completed:

1. No Python runtime files were modified.
2. No frontend runtime files were modified.
3. No imports changed.
4. No API contracts changed.
5. No migration DDL was executed in this phase.
6. Existing generation capture, workspace, dashboard, and task flows remain untouched.

## Recommendation Before Phase 2

Proceed with the new canonical `generation_records` table first. It is the smallest design that supports:

1. recovered rows without known owners
2. user-owned generation projects
3. ungrouped views
4. recovery auditing
5. safe future ownership workflows
