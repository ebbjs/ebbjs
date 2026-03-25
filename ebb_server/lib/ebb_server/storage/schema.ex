defmodule EbbServer.Storage.Schema do
  def initialize(db) do
    # Pragmas
    Exqlite.Sqlite3.execute(db, "PRAGMA journal_mode=WAL")
    Exqlite.Sqlite3.execute(db, "PRAGMA foreign_keys = ON")
    Exqlite.Sqlite3.execute(db, "PRAGMA busy_timeout = 5000")
    Exqlite.Sqlite3.execute(db, "PRAGMA synchronous = NORMAL")

    # Actions
    Exqlite.Sqlite3.execute(db, """
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        hlc INTEGER NOT NULL,
        gsn INTEGER NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      )
    """)

    Exqlite.Sqlite3.execute(db, "CREATE INDEX IF NOT EXISTS idx_actions_gsn ON actions(gsn)")

    Exqlite.Sqlite3.execute(
      db,
      "CREATE INDEX IF NOT EXISTS idx_actions_actor ON actions(actor_id)"
    )

    # Updates
    Exqlite.Sqlite3.execute(db, """
      CREATE TABLE IF NOT EXISTS updates (
        id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        method TEXT NOT NULL,
        data TEXT,
        FOREIGN KEY (action_id) REFERENCES actions(id)
      )
    """)

    Exqlite.Sqlite3.execute(
      db,
      "CREATE INDEX IF NOT EXISTS idx_updates_action ON updates(action_id)"
    )

    Exqlite.Sqlite3.execute(
      db,
      "CREATE INDEX IF NOT EXISTS idx_updates_subject ON updates(subject_id)"
    )

    Exqlite.Sqlite3.execute(
      db,
      "CREATE INDEX IF NOT EXISTS idx_updates_subject_type ON updates(subject_type)"
    )

    # Actors
    Exqlite.Sqlite3.execute(db, """
      CREATE TABLE IF NOT EXISTS actors (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    """)

    # Entities (with generated columns)
    Exqlite.Sqlite3.execute(db, """
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        data TEXT,
        created_hlc INTEGER NOT NULL,
        updated_hlc INTEGER NOT NULL,
        deleted_hlc INTEGER,
        deleted_by TEXT,
        last_gsn INTEGER NOT NULL,

        source_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.source_id')) STORED,
        target_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.target_id')) STORED,
        rel_type TEXT GENERATED ALWAYS AS (json_extract(data, '$.type')) STORED,
        rel_field TEXT GENERATED ALWAYS AS (json_extract(data, '$.field')) STORED,

        actor_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.actor_id')) STORED,
        group_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.group_id')) STORED,
        permissions TEXT GENERATED ALWAYS AS (json_extract(data, '$.permissions')) STORED
      )
    """)

    Exqlite.Sqlite3.execute(
      db,
      "CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type) WHERE deleted_hlc IS NULL"
    )

    Exqlite.Sqlite3.execute(
      db,
      "CREATE INDEX IF NOT EXISTS idx_entities_type_gsn ON entities(type, last_gsn)"
    )

    Exqlite.Sqlite3.execute(
      db,
      "CREATE INDEX IF NOT EXISTS idx_entities_source ON entities(source_id) WHERE type = 'relationship' AND deleted_hlc IS NULL"
    )

    Exqlite.Sqlite3.execute(
      db,
      "CREATE INDEX IF NOT EXISTS idx_entities_target ON entities(target_id) WHERE type = 'relationship' AND deleted_hlc IS NULL"
    )

    Exqlite.Sqlite3.execute(
      db,
      "CREATE INDEX IF NOT EXISTS idx_entities_actor_group ON entities(actor_id, group_id) WHERE type = 'groupMember' AND deleted_hlc IS NULL"
    )

    # Snapshots
    Exqlite.Sqlite3.execute(db, """
      CREATE TABLE IF NOT EXISTS snapshots (
        entity_id TEXT PRIMARY KEY,
        update_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        hlc INTEGER NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES entities(id)
      )
    """)

    # Cold action index
    Exqlite.Sqlite3.execute(db, """
      CREATE TABLE IF NOT EXISTS cold_action_index (
        entity_id TEXT NOT NULL,
        gsn INTEGER NOT NULL,
        PRIMARY KEY (entity_id, gsn)
      )
    """)

    # Function versions
    Exqlite.Sqlite3.execute(db, """
      CREATE TABLE IF NOT EXISTS function_versions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        code TEXT NOT NULL,
        input_schema TEXT,
        output_schema TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        activated_at INTEGER,
        UNIQUE(name, version)
      )
    """)

    Exqlite.Sqlite3.execute(
      db,
      "CREATE INDEX IF NOT EXISTS idx_function_active ON function_versions(name, status) WHERE status = 'active'"
    )
  end
end
