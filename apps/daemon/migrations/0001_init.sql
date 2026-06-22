-- OD daemon 多租户 PG schema(从已应用迁移的 SQLite dump 翻译)
-- 方言: INTEGER→BIGINT, REAL→DOUBLE PRECISION;表按 FK 依赖排序
BEGIN;

CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      skill_id TEXT,
      design_system_id TEXT,
      pending_prompt TEXT,
      metadata_json TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    , custom_instructions TEXT, applied_plugin_snapshot_id TEXT, tenant_id TEXT NOT NULL DEFAULT '__legacy__');

CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT,
      session_mode TEXT NOT NULL DEFAULT 'design',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL, applied_plugin_snapshot_id TEXT, tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      agent_id TEXT,
      agent_name TEXT,
      events_json TEXT,
      attachments_json TEXT,
      produced_files_json TEXT,
      feedback_json TEXT,
      pre_turn_file_names_json TEXT,
      session_mode TEXT,
      run_context_json TEXT,
      applied_plugin_snapshot_json TEXT,
      telemetry_finalized_at BIGINT,
      started_at BIGINT,
      ended_at BIGINT,
      position BIGINT NOT NULL,
      created_at BIGINT NOT NULL, run_id TEXT, run_status TEXT, last_run_event_id TEXT, comment_attachments_json TEXT, tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS agent_sessions (
      conversation_id TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      stable_prompt_hash TEXT,
      updated_at      BIGINT NOT NULL, tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      PRIMARY KEY (conversation_id, agent_id),
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS preview_comments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      element_id TEXT NOT NULL,
      selector TEXT NOT NULL,
      label TEXT NOT NULL,
      text TEXT NOT NULL,
      position_json TEXT NOT NULL,
      html_hint TEXT NOT NULL,
      selection_kind TEXT,
      member_count BIGINT,
      pod_members_json TEXT,
      style_json TEXT,
      attachments_json TEXT,
      slide_index BIGINT,
      slide_key BIGINT NOT NULL DEFAULT -1,
      note TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL, tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      UNIQUE(project_id, conversation_id, file_path, element_id, slide_key),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      source_project_id TEXT,
      files_json TEXT NOT NULL,
      created_at BIGINT NOT NULL
    , tenant_id TEXT NOT NULL DEFAULT '__legacy__');

CREATE TABLE IF NOT EXISTS tabs (
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position BIGINT NOT NULL,
      is_active BIGINT NOT NULL DEFAULT 0, tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      PRIMARY KEY(project_id, name),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS tabs_state (
      project_id TEXT PRIMARY KEY,
      updated_at BIGINT NOT NULL,
      state_json TEXT, tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      url TEXT NOT NULL,
      deployment_id TEXT,
      deployment_count BIGINT NOT NULL DEFAULT 1,
      target TEXT NOT NULL DEFAULT 'preview',
      status TEXT NOT NULL DEFAULT 'ready',
      status_message TEXT,
      reachable_at BIGINT,
      provider_metadata_json TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL, tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      UNIQUE(project_id, file_name, provider_id),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_kind TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      schedule_json TEXT,
      project_mode TEXT NOT NULL,
      project_id TEXT,
      skill_id TEXT,
      agent_id TEXT,
      context_json TEXT,
      enabled BIGINT NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    , tenant_id TEXT NOT NULL DEFAULT '__legacy__');

CREATE TABLE IF NOT EXISTS routine_runs (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      agent_run_id TEXT NOT NULL,
      started_at BIGINT NOT NULL,
      completed_at BIGINT,
      summary TEXT,
      error TEXT,
      error_code TEXT, tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      FOREIGN KEY(routine_id) REFERENCES routines(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS routine_schedule_claims (
      routine_id TEXT NOT NULL,
      slot_at BIGINT NOT NULL,
      claimed_at BIGINT NOT NULL, tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      PRIMARY KEY(routine_id, slot_at),
      FOREIGN KEY(routine_id) REFERENCES routines(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS media_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN
        ('queued','running','done','failed','interrupted')),
      surface TEXT,
      model TEXT,
      progress_json TEXT NOT NULL DEFAULT '[]',
      file_json TEXT,
      error_json TEXT,
      started_at BIGINT NOT NULL,
      ended_at BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL, tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS critique_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT,
      artifact_path TEXT,
      status TEXT NOT NULL CHECK (status IN
        ('shipped','below_threshold','timed_out','interrupted','degraded','failed','legacy','running')),
      score DOUBLE PRECISION,
      rounds_json TEXT NOT NULL DEFAULT '[]',
      transcript_path TEXT,
      protocol_version BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL, tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
    );

CREATE TABLE IF NOT EXISTS installed_plugins (
      id                   TEXT PRIMARY KEY,
      title                TEXT NOT NULL,
      version              TEXT NOT NULL,
      source_kind          TEXT NOT NULL,
      source               TEXT NOT NULL,
      pinned_ref           TEXT,
      source_digest        TEXT,
      source_marketplace_id TEXT,
      source_marketplace_entry_name TEXT,
      source_marketplace_entry_version TEXT,
      marketplace_trust    TEXT,
      resolved_source      TEXT,
      resolved_ref         TEXT,
      manifest_digest      TEXT,
      archive_integrity    TEXT,
      trust                TEXT NOT NULL,
      capabilities_granted TEXT NOT NULL,
      manifest_json        TEXT NOT NULL,
      fs_path              TEXT NOT NULL,
      installed_at         BIGINT NOT NULL,
      updated_at           BIGINT NOT NULL
    , tenant_id TEXT NOT NULL DEFAULT '__legacy__');

CREATE TABLE IF NOT EXISTS plugin_marketplaces (
      id            TEXT PRIMARY KEY,
      url           TEXT NOT NULL,
      spec_version  TEXT NOT NULL DEFAULT '1.0.0',
      version       TEXT NOT NULL DEFAULT '0.0.0',
      trust         TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      added_at      BIGINT NOT NULL,
      refreshed_at  BIGINT NOT NULL
    , tenant_id TEXT NOT NULL DEFAULT '__legacy__');

CREATE TABLE IF NOT EXISTS applied_plugin_snapshots (
      id                       TEXT PRIMARY KEY,
      project_id               TEXT NOT NULL,
      conversation_id          TEXT,
      run_id                   TEXT,
      plugin_id                TEXT NOT NULL,
      plugin_spec_version      TEXT NOT NULL DEFAULT '1.0.0',
      plugin_version           TEXT NOT NULL,
      manifest_source_digest   TEXT NOT NULL,
      source_marketplace_id    TEXT,
      source_marketplace_entry_name TEXT,
      source_marketplace_entry_version TEXT,
      marketplace_trust        TEXT,
      resolved_source          TEXT,
      resolved_ref             TEXT,
      archive_integrity        TEXT,
      pinned_ref               TEXT,
      task_kind                TEXT NOT NULL,
      inputs_json              TEXT NOT NULL,
      resolved_context_json    TEXT NOT NULL,
      craft_requires_json      TEXT NOT NULL DEFAULT '[]',
      pipeline_json            TEXT,
      genui_surfaces_json      TEXT NOT NULL DEFAULT '[]',
      capabilities_granted     TEXT NOT NULL,
      capabilities_required    TEXT NOT NULL DEFAULT '[]',
      assets_staged_json       TEXT NOT NULL,
      connectors_required_json TEXT NOT NULL DEFAULT '[]',
      connectors_resolved_json TEXT NOT NULL DEFAULT '[]',
      mcp_servers_json         TEXT NOT NULL DEFAULT '[]',
      plugin_title             TEXT,
      plugin_description       TEXT,
      query_text               TEXT,
      status                   TEXT NOT NULL DEFAULT 'fresh',
      applied_at               BIGINT NOT NULL,
      expires_at               BIGINT, tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      FOREIGN KEY (project_id)      REFERENCES projects(id)      ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
    );

CREATE TABLE IF NOT EXISTS run_devloop_iterations (
      id                    TEXT PRIMARY KEY,
      run_id                TEXT NOT NULL,
      stage_id              TEXT NOT NULL,
      iteration             BIGINT NOT NULL,
      artifact_diff_summary TEXT,
      critique_summary      TEXT,
      tokens_used           BIGINT,
      ended_at              BIGINT NOT NULL
    , tenant_id TEXT NOT NULL DEFAULT '__legacy__');

CREATE TABLE IF NOT EXISTS genui_surfaces (
      id                    TEXT PRIMARY KEY,
      project_id            TEXT NOT NULL,
      conversation_id       TEXT,
      run_id                TEXT,
      plugin_snapshot_id    TEXT NOT NULL,
      surface_id            TEXT NOT NULL,
      kind                  TEXT NOT NULL,
      persist               TEXT NOT NULL,
      schema_digest         TEXT,
      value_json            TEXT,
      status                TEXT NOT NULL,
      responded_by          TEXT,
      requested_at          BIGINT NOT NULL,
      responded_at          BIGINT,
      expires_at            BIGINT, tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      FOREIGN KEY (project_id)         REFERENCES projects(id)                  ON DELETE CASCADE,
      FOREIGN KEY (plugin_snapshot_id) REFERENCES applied_plugin_snapshots(id)  ON DELETE SET NULL
    );

CREATE TABLE IF NOT EXISTS skill_plugin_candidates (
      id                   TEXT PRIMARY KEY,
      project_id           TEXT NOT NULL,
      run_id               TEXT,
      conversation_id      TEXT,
      assistant_message_id TEXT,
      fingerprint          TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'active',
      title                TEXT NOT NULL,
      description          TEXT NOT NULL,
      confidence           DOUBLE PRECISION NOT NULL,
      source_refs_json     TEXT NOT NULL,
      provenance_json      TEXT NOT NULL,
      draft_path           TEXT,
      created_at           BIGINT NOT NULL,
      updated_at           BIGINT NOT NULL,
      dismissed_at         BIGINT, tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      UNIQUE(project_id, fingerprint),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS registry_entries (
      backend_id TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL,
      entry_json TEXT NOT NULL, updated_at BIGINT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      PRIMARY KEY (backend_id, name));

CREATE INDEX IF NOT EXISTS idx_agent_sessions_tenant ON agent_sessions(tenant_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_applied_plugin_snapshots_tenant ON applied_plugin_snapshots(tenant_id);
CREATE INDEX IF NOT EXISTS idx_conv_project
      ON conversations(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant ON conversations(tenant_id, project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_critique_runs_project
      ON critique_runs(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_critique_runs_status
      ON critique_runs(status);
CREATE INDEX IF NOT EXISTS idx_critique_runs_tenant ON critique_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_deployments_project
      ON deployments(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_tenant ON deployments(tenant_id, project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_devloop_run        ON run_devloop_iterations(run_id);
CREATE INDEX IF NOT EXISTS idx_devloop_run_stage  ON run_devloop_iterations(run_id, stage_id);
CREATE INDEX IF NOT EXISTS idx_genui_conv_surface ON genui_surfaces(conversation_id, surface_id);
CREATE INDEX IF NOT EXISTS idx_genui_proj_surface ON genui_surfaces(project_id, surface_id);
CREATE INDEX IF NOT EXISTS idx_genui_run          ON genui_surfaces(run_id);
CREATE INDEX IF NOT EXISTS idx_genui_surfaces_tenant ON genui_surfaces(tenant_id);
CREATE INDEX IF NOT EXISTS idx_installed_plugins_source_kind
      ON installed_plugins(source_kind);
CREATE INDEX IF NOT EXISTS idx_installed_plugins_tenant ON installed_plugins(tenant_id);
CREATE INDEX IF NOT EXISTS idx_marketplaces_version ON plugin_marketplaces(version);
CREATE INDEX IF NOT EXISTS idx_media_tasks_project
      ON media_tasks(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_tasks_status
      ON media_tasks(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_tasks_tenant ON media_tasks(tenant_id, project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conv
      ON messages(conversation_id, position);
CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id, conversation_id, position);
CREATE INDEX IF NOT EXISTS idx_plugin_marketplaces_tenant ON plugin_marketplaces(tenant_id);
CREATE INDEX IF NOT EXISTS idx_preview_comments_conversation
      ON preview_comments(project_id, conversation_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_preview_comments_conversation_created
      ON preview_comments(project_id, conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_preview_comments_tenant ON preview_comments(tenant_id, project_id, conversation_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects(tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_routine_runs_routine
      ON routine_runs(routine_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_routine_runs_tenant ON routine_runs(tenant_id, routine_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_routine_schedule_claims_tenant ON routine_schedule_claims(tenant_id, routine_id);
CREATE INDEX IF NOT EXISTS idx_routines_tenant ON routines(tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_devloop_iterations_tenant ON run_devloop_iterations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_skill_plugin_candidates_project
      ON skill_plugin_candidates(project_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_plugin_candidates_tenant ON skill_plugin_candidates(tenant_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_plugin  ON applied_plugin_snapshots(plugin_id, plugin_version);
CREATE INDEX IF NOT EXISTS idx_snapshots_project ON applied_plugin_snapshots(project_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_run     ON applied_plugin_snapshots(run_id);
CREATE INDEX IF NOT EXISTS idx_tabs_project
      ON tabs(project_id, position);
CREATE INDEX IF NOT EXISTS idx_tabs_state_tenant ON tabs_state(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_tabs_tenant ON tabs(tenant_id, project_id, position);
CREATE INDEX IF NOT EXISTS idx_templates_tenant ON templates(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_registry_entries_tenant ON registry_entries(tenant_id);
COMMIT;
