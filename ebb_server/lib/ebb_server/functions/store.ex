defmodule EbbServer.Functions.Store.Version do
  @moduledoc """
  One row of `function_versions`.

  `params_schema` and `output_schema` are decoded draft-7 JSON Schema maps, or
  `nil` when the bundle declared none. `contract` is the integer the TEXT column
  holds. `status` is the row's stored vocabulary: `"active"`, `"retired"` or
  `"disabled"`. `pinned` is what keeps a version past retention and `created_at`
  / `activated_at` are epoch milliseconds. `previous_version_id` is the version
  that was active when this one was last activated; rollback follows it, so the
  chain walks back through activations rather than toggling between two rows.
  """

  @enforce_keys [
    :id,
    :name,
    :version,
    :code,
    :digest,
    :runtime,
    :entry,
    :access,
    :contract,
    :timeout_ms,
    :memory_bytes,
    :status,
    :created_at
  ]
  defstruct [
    :id,
    :name,
    :version,
    :code,
    :digest,
    :signature,
    :signer_key_id,
    :runtime,
    :entry,
    :access,
    :params_schema,
    :output_schema,
    :contract,
    :timeout_ms,
    :memory_bytes,
    :status,
    :created_at,
    :activated_at,
    :created_by,
    :pinned,
    :previous_version_id
  ]

  @type status :: String.t()
  @type t :: %__MODULE__{
          id: String.t(),
          name: String.t(),
          version: String.t(),
          code: binary(),
          digest: String.t(),
          signature: String.t() | nil,
          signer_key_id: String.t() | nil,
          runtime: String.t(),
          entry: String.t(),
          access: String.t(),
          params_schema: map() | nil,
          output_schema: map() | nil,
          contract: integer() | nil,
          timeout_ms: integer(),
          memory_bytes: integer(),
          status: status(),
          created_at: integer(),
          activated_at: integer() | nil,
          created_by: String.t() | nil,
          pinned: boolean(),
          previous_version_id: String.t() | nil
        }
end

defmodule EbbServer.Functions.Store do
  @moduledoc """
  Owns `data/functions.db`: every uploaded function version, the RPC schemas it
  carries, and which version each name is currently serving.

  ## Why this file exists

  These rows have no rebuild path. The SQLite database in
  `EbbServer.Storage.SQLite` is a materialized entity cache, documented as
  rebuildable from the Action log; RocksDB *is* the Action log. A function
  version's code, its params/output schemas, and the pointer saying which
  version is active are all primary data — lose them and there is nothing to
  replay them from. So they live in their own file, owned only by this module.

  The bundle's **entity** schema is not stored here: it is inlined in the code
  the runtime reads (`__ebbFunction.schema._registry`). The schemas in this
  table are the RPC params and output JSON Schemas.

  ## Schema

  One row per `(name, version)`. `UNIQUE (name, version)` makes a re-upload of
  an existing version a write error rather than a silent replacement of code
  somebody may already have run.

  `status` has exactly three values:

    * `active` — the name's serving version
    * `retired` — superseded by a later activation
    * `disabled` — switched off by an operator

  Exactly one row per name may be `active`, and that is a database constraint
  (`idx_function_active`, a partial unique index) rather than an application
  check. Because the index only matches `active`, a disabled name holds no
  active slot at all: it resolves no bundle and answers `404` like any unknown
  name. Re-enabling is an activation, not a fourth status.

  ## Deviation from the issue's DDL

  Issue #595 lists sixteen columns. Five more are here: `runtime`, `entry` and
  `access` are the envelope's execution identity and permission posture, which
  are not derivable from stored code; `pinned` is how a `--keep` pin survives
  retention; and `previous_version_id` is the activation chain `rollback/2`
  follows (migration v2, so a database created before it gains the column
  without losing rows).

  `contract` is stored as TEXT per that DDL and parsed on read. `params_schema`
  and `output_schema` are draft-7 JSON Schema documents as JSON text, or NULL
  when the bundle declared none.

  ## Migrations

  `PRAGMA user_version` records how far the schema has been migrated, and
  `@migrations` is the ordered list that gets it there. Each step runs in one
  transaction with its own `user_version` bump, so a crash mid-upgrade leaves
  the previous version intact. A second start at the current version does
  nothing.

  ## Retention

  After an insert, older versions of that name are pruned: the newest
  `:retention` rows (default 20) by `(created_at DESC, rowid DESC)` survive,
  plus every `pinned` row, and an `active` row is never deleted. Retention is
  arrangement, not history: pinning is the way to keep a version past N.

  ## Errors

  `Sqlite3.execute/2` and `Sqlite3.step/2` answer `{:error, reason}` instead of
  raising. This process is shared by every function on the node, so a failure a
  caller can act on (`:already_exists`, `:not_found`, an unresolvable schema) is
  replied rather than raised, and transaction bodies roll back on their own.
  `list/1` and `versions/2` return a list by contract, so a read that fails is
  an empty list rather than a crashed shared process.

  ## Isolated instances

  Every accessor takes an optional `server` (default `__MODULE__`) so concurrent
  tests can run multiple isolated databases, and `start_link/1` accepts
  `name: nil` for a store that is only reached through its pid.
  """

  use GenServer

  alias EbbServer.Functions.Schema
  alias EbbServer.Functions.Store.Version
  alias Exqlite.Sqlite3

  @db_file "functions.db"
  @default_retention 20

  # Every column, in the order every statement below reads. `runtime`, `entry`,
  # `access`, `pinned` and `previous_version_id` are the deviation documented in
  # the moduledoc.
  @columns """
  id, name, version, code, digest, signature, signer_key_id, runtime, entry,
  access, params_schema, output_schema, contract, timeout_ms, memory_bytes,
  status, created_at, activated_at, created_by, pinned, previous_version_id
  """

  # ---------------------------------------------------------------------------
  # SQL constants
  # ---------------------------------------------------------------------------

  @pragmas """
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -64000;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
  """

  @migrations [
    # v1 — the table plus the active-slot constraint and the per-name lookup.
    """
    CREATE TABLE IF NOT EXISTS function_versions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      code TEXT NOT NULL,
      digest TEXT NOT NULL,
      signature TEXT,
      signer_key_id TEXT,
      runtime TEXT NOT NULL,
      entry TEXT NOT NULL,
      access TEXT NOT NULL,
      params_schema TEXT,                 -- draft-7 JSON Schema, JSON text or NULL
      output_schema TEXT,
      contract TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL,
      memory_bytes INTEGER NOT NULL,
      -- active = the name's serving version, retired = superseded by a later
      -- activation, disabled = switched off by an operator.
      status TEXT NOT NULL CHECK (status IN ('active','retired','disabled')),
      created_at INTEGER NOT NULL,        -- epoch ms
      activated_at INTEGER,
      created_by TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      UNIQUE (name, version)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_function_active ON function_versions(name) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_function_versions_name ON function_versions(name, created_at DESC);
    """,
    # v2 — the rollback chain. `activated_at` is an activation time, not a
    # history; a pointer to the version that was active when this one was
    # activated is what lets rollback walk back instead of toggling.
    """
    ALTER TABLE function_versions ADD COLUMN previous_version_id TEXT;
    """
  ]

  @insert_sql """
  INSERT INTO function_versions (
    id, name, version, code, digest, signature, signer_key_id, runtime, entry,
    access, params_schema, output_schema, contract, timeout_ms, memory_bytes,
    status, created_at, activated_at, created_by, pinned, previous_version_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  """

  @get_sql "SELECT #{@columns} FROM function_versions WHERE name = ? AND version = ?"

  @get_active_sql "SELECT #{@columns} FROM function_versions WHERE name = ? AND status = 'active'"

  @get_schemas_sql "SELECT params_schema, output_schema FROM function_versions WHERE name = ? AND version = ?"

  # Retiring every other active row is what makes the switch a single
  # transaction: the partial unique index would reject a second active row
  # while the old one is still there.
  @retire_active_sql """
  UPDATE function_versions SET status = 'retired'
  WHERE name = ? AND status = 'active' AND version <> ?
  """

  @set_active_sql """
  UPDATE function_versions
  SET status = 'active', activated_at = ?, previous_version_id = ?
  WHERE name = ? AND version = ?
  """

  # Rollback keeps the target's own pointer: following that chain is what walks
  # back through activations. Rewriting it here would turn rollback into a
  # toggle.
  @set_previous_active_sql """
  UPDATE function_versions SET status = 'active', activated_at = ?
  WHERE name = ? AND version = ?
  """

  @set_disabled_sql """
  UPDATE function_versions SET status = 'disabled'
  WHERE name = ? AND status = 'active'
  """

  # The previous version is the one the active row points at, and it must still
  # be servable. A `disabled` row is not a rollback candidate: switching it off
  # was an operator decision, and re-enabling is an activation, not a rollback.
  @previous_sql """
  SELECT #{@columns} FROM function_versions
  WHERE id = ? AND name = ? AND status = 'retired'
  """

  @list_sql "SELECT #{@columns} FROM function_versions WHERE status = 'active' ORDER BY name"

  @versions_sql """
  SELECT #{@columns} FROM function_versions
  WHERE name = ? ORDER BY created_at DESC, rowid DESC
  """

  # The LIMIT counts only unpinned rows, so a pin is additional rather than a
  # slot a normal version has to compete for. The delete below never touches a
  # pinned or active row regardless.
  @prune_sql """
  DELETE FROM function_versions
  WHERE name = ? AND pinned = 0 AND status <> 'active'
    AND id NOT IN (
      SELECT id FROM function_versions WHERE name = ? AND pinned = 0
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    )
  """

  @user_version_sql "PRAGMA user_version"

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Starts the store.

  Options:

    * `:data_dir` — required; the database is `<data_dir>/functions.db`
    * `:name` — registered name (default `EbbServer.Functions.Store`, `nil` for none)
    * `:retention` — non-active versions kept per name (default 20)
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    case Keyword.get(opts, :name, __MODULE__) do
      nil -> GenServer.start_link(__MODULE__, opts)
      name -> GenServer.start_link(__MODULE__, opts, name: name)
    end
  end

  @doc """
  Records a new function version, retired until somebody activates it.

  Required attributes: `:name`, `:version`, `:code`, `:digest`, `:runtime`,
  `:contract`, `:access`, `:timeout_ms`, `:memory_bytes`, `:entry`. Optional:
  `:signature`, `:signer_key_id`, `:params_schema`, `:output_schema`,
  `:created_by`, `:pinned`.

  `params_schema` and `output_schema` are validated here, before the row
  exists: a schema that draft-7 resolution rejects can never be stored, so it
  can never be activated. The digest is the caller's to verify against `:code`;
  this module only records it.

  A `(name, version)` that already exists answers `{:error, :already_exists}`
  and leaves the stored code untouched.
  """
  @spec put_version(map(), GenServer.server()) :: {:ok, Version.t()} | {:error, term()}
  def put_version(attrs, server \\ __MODULE__) do
    GenServer.call(server, {:put_version, attrs})
  end

  @doc """
  Makes `version` the serving version of `name`.

  One transaction retires whatever was active and points the name at the
  target, refreshing `activated_at` when the target was already active. It also
  records the target's `previous_version_id` as the row that was active before
  it (keeping the existing pointer when there is no current active), which is
  the chain `rollback/2` follows. An unknown version answers
  `{:error, :not_found}` and changes nothing. The target's stored schemas are
  re-resolved first, so a row tampered with after upload cannot become active.
  """
  @spec activate(String.t(), String.t(), GenServer.server()) ::
          {:ok, Version.t()}
          | {:error, :not_found | {:invalid_schema, String.t(), String.t()} | term()}
  def activate(name, version, server \\ __MODULE__) do
    GenServer.call(server, {:activate, name, version})
  end

  @doc """
  Activates the version that was active when the current one was last
  activated, following `previous_version_id`. Repeated rollbacks therefore walk
  back through the activation history (v3 → v2 → v1) rather than toggling
  between the last two; a version that was disabled or pruned is not a
  candidate.

  `{:error, :not_found}` when the name has no active version at all, so there
  is nothing to roll back from; `{:error, :no_previous_version}` when the
  active row has no earlier activation to return to. Stored schemas are
  re-resolved before the switch, exactly as `activate/3` does, so the answer
  carries the same `{:invalid_schema, field, reason}` possibility.
  """
  @spec rollback(String.t(), GenServer.server()) ::
          {:ok, Version.t()}
          | {:error,
             :not_found
             | :no_previous_version
             | {:invalid_schema, String.t(), String.t()}
             | term()}
  def rollback(name, server \\ __MODULE__) do
    GenServer.call(server, {:rollback, name})
  end

  @doc """
  Switches `name` off: its active row becomes `disabled`.

  `activated_at` is left alone, so a later activation of the same row does not
  pretend the function was never in service. No active row means
  `{:error, :not_found}`.
  """
  @spec disable(String.t(), GenServer.server()) ::
          {:ok, Version.t()} | {:error, :not_found | term()}
  def disable(name, server \\ __MODULE__) do
    GenServer.call(server, {:disable, name})
  end

  @doc """
  The version `name` is currently serving, or `:not_found`.

  A disabled name has no active version and answers `:not_found`.
  """
  @spec active(String.t(), GenServer.server()) ::
          {:ok, Version.t()} | :not_found | {:error, term()}
  def active(name, server \\ __MODULE__) do
    GenServer.call(server, {:active, name})
  end

  @doc """
  A specific `(name, version)` row, retired or not.
  """
  @spec get(String.t(), String.t(), GenServer.server()) ::
          {:ok, Version.t()} | :not_found | {:error, term()}
  def get(name, version, server \\ __MODULE__) do
    GenServer.call(server, {:get, name, version})
  end

  @doc """
  Every active version, ordered by name. `GET /functions` lists these.

  A read failure is an error rather than an empty list: an operator UI must not
  show an unreadable catalogue as an empty one.
  """
  @spec list(GenServer.server()) :: {:ok, [Version.t()]} | {:error, term()}
  def list(server \\ __MODULE__) do
    GenServer.call(server, :list)
  end

  @doc """
  Every version of `name`, newest first.

  A read failure is an error, not an empty history: an operator UI must not
  show an unreadable name as one that never had versions.
  """
  @spec versions(String.t(), GenServer.server()) ::
          {:ok, [Version.t()]} | {:error, term()}
  def versions(name, server \\ __MODULE__) do
    GenServer.call(server, {:versions, name})
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(opts) do
    data_dir = Keyword.fetch!(opts, :data_dir)
    File.mkdir_p!(data_dir)

    path = Path.join(data_dir, @db_file)
    {:ok, db} = Sqlite3.open(path)

    :ok = Sqlite3.execute(db, @pragmas)
    migrate!(db)

    state = %{
      db: db,
      stmts: prepare_all!(db),
      retention: Keyword.get(opts, :retention, @default_retention)
    }

    {:ok, state}
  end

  @impl true
  def handle_call({:put_version, attrs}, _from, state) do
    {:reply, do_put_version(state, attrs), state}
  end

  @impl true
  def handle_call({:activate, name, version}, _from, state) do
    result = transaction(state.db, fn -> activate_in(state.db, state.stmts, name, version) end)
    {:reply, result, state}
  end

  @impl true
  def handle_call({:rollback, name}, _from, state) do
    result = transaction(state.db, fn -> rollback_in(state.db, state.stmts, name) end)
    {:reply, result, state}
  end

  @impl true
  def handle_call({:disable, name}, _from, state) do
    {:reply, do_disable(state, name), state}
  end

  @impl true
  def handle_call({:active, name}, _from, state) do
    {:reply, fetch_one(state.db, state.stmts.get_active, [name]), state}
  end

  @impl true
  def handle_call({:get, name, version}, _from, state) do
    {:reply, fetch_one(state.db, state.stmts.get, [name, version]), state}
  end

  @impl true
  def handle_call(:list, _from, state) do
    {:reply, fetch_many(state.db, state.stmts.list, []), state}
  end

  @impl true
  def handle_call({:versions, name}, _from, state) do
    {:reply, fetch_many(state.db, state.stmts.versions, [name]), state}
  end

  @impl true
  def terminate(_reason, %{db: db, stmts: stmts}) do
    Enum.each(Map.values(stmts), fn stmt -> Sqlite3.release(db, stmt) end)
    Sqlite3.close(db)
  end

  # ---------------------------------------------------------------------------
  # Operations
  # ---------------------------------------------------------------------------

  defp do_put_version(state, attrs) do
    with {:ok, attrs} <- normalize(attrs),
         :ok <- Schema.validate(attrs.params_schema, "params_schema"),
         :ok <- Schema.validate(attrs.output_schema, "output_schema"),
         :ok <- ensure_absent(state, attrs.name, attrs.version),
         version = build_version(attrs, new_id(), now_ms()),
         :ok <- insert_version(state.db, state.stmts.insert, version) do
      # The row is committed; a retention failure is not the uploader's to fix
      # and must not turn a successful write into an error reply.
      _ = prune(state.db, state.stmts.prune, version.name, state.retention)
      {:ok, version}
    end
  end

  # A re-upload is refused before the write, so the stored code is never
  # replaced. `UNIQUE (name, version)` is still the guarantee; this only decides
  # which error the uploader sees. One writer process makes the check race-free.
  defp ensure_absent(state, name, version) do
    case fetch_one(state.db, state.stmts.get, [name, version]) do
      :not_found -> :ok
      {:ok, _row} -> {:error, :already_exists}
      {:error, _reason} = error -> error
    end
  end

  defp do_disable(state, name) do
    with {:ok, row} <- fetch_active_or_error(state.db, state.stmts, name),
         :ok <- write(state.db, state.stmts.disable, [name]) do
      {:ok, %{row | status: "disabled"}}
    end
  end

  defp activate_in(db, stmts, name, version) do
    with {:ok, target} <- fetch_target(db, stmts, name, version),
         :ok <- verify_stored_schemas(db, stmts, name, version),
         {:ok, current} <- active_or_nil(db, stmts, name),
         :ok <- switch_active(db, stmts, name, target, current) do
      fetch_target(db, stmts, name, version)
    end
  end

  defp rollback_in(db, stmts, name) do
    with {:ok, active} <- fetch_active_or_error(db, stmts, name),
         {:ok, previous} <- fetch_previous(db, stmts, name, active.previous_version_id),
         :ok <- verify_stored_schemas(db, stmts, name, previous.version),
         :ok <- switch_to_previous(db, stmts, name, previous.version) do
      fetch_target(db, stmts, name, previous.version)
    end
  end

  defp active_or_nil(db, stmts, name) do
    case fetch_one(db, stmts.get_active, [name]) do
      :not_found -> {:ok, nil}
      other -> other
    end
  end

  defp fetch_active_or_error(db, stmts, name) do
    case fetch_one(db, stmts.get_active, [name]) do
      :not_found -> {:error, :not_found}
      other -> other
    end
  end

  defp fetch_target(db, stmts, name, version) do
    case fetch_one(db, stmts.get, [name, version]) do
      :not_found -> {:error, :not_found}
      other -> other
    end
  end

  defp fetch_previous(_db, _stmts, _name, nil), do: {:error, :no_previous_version}

  defp fetch_previous(db, stmts, name, version_id) do
    case fetch_one(db, stmts.previous, [version_id, name]) do
      :not_found -> {:error, :no_previous_version}
      other -> other
    end
  end

  # Activation records what was active when this version took over. Keeping the
  # target's existing pointer when there is no current active is what lets a
  # disabled version be re-enabled without erasing its rollback chain.
  defp switch_active(db, stmts, name, target, current) do
    previous_id =
      case current do
        %Version{id: id} when id != target.id -> id
        _none_or_same -> target.previous_version_id
      end

    with :ok <- write(db, stmts.retire_active, [name, target.version]),
         :ok <- write(db, stmts.set_active, [now_ms(), previous_id, name, target.version]) do
      check_changed(db)
    end
  end

  defp switch_to_previous(db, stmts, name, version) do
    with :ok <- write(db, stmts.retire_active, [name, version]),
         :ok <- write(db, stmts.set_previous_active, [now_ms(), name, version]) do
      check_changed(db)
    end
  end

  defp check_changed(db) do
    case Sqlite3.changes(db) do
      {:ok, 0} -> {:error, :not_found}
      {:ok, _changed} -> :ok
      {:error, reason} -> {:error, {:sqlite, reason}}
    end
  end

  defp prune(db, stmt, name, retention) do
    write(db, stmt, [name, name, retention])
  end

  # ---------------------------------------------------------------------------
  # Attribute normalization
  # ---------------------------------------------------------------------------

  defp normalize(attrs) when is_map(attrs) do
    with :ok <- check_required(attrs),
         :ok <- check_optional(attrs) do
      {:ok,
       %{
         name: attrs.name,
         version: attrs.version,
         code: attrs.code,
         digest: attrs.digest,
         signature: Map.get(attrs, :signature),
         signer_key_id: Map.get(attrs, :signer_key_id),
         runtime: attrs.runtime,
         entry: attrs.entry,
         access: attrs.access,
         params_schema: Map.get(attrs, :params_schema),
         output_schema: Map.get(attrs, :output_schema),
         contract: attrs.contract,
         timeout_ms: attrs.timeout_ms,
         memory_bytes: attrs.memory_bytes,
         created_by: Map.get(attrs, :created_by),
         pinned: Map.get(attrs, :pinned, false)
       }}
    end
  end

  defp normalize(_attrs), do: {:error, {:invalid_field, :attrs}}

  @required_attrs [
    name: :binary,
    version: :binary,
    code: :binary,
    digest: :binary,
    runtime: :binary,
    entry: :binary,
    access: :binary,
    contract: :integer,
    timeout_ms: :integer,
    memory_bytes: :integer
  ]

  @optional_attrs [
    signature: :binary,
    signer_key_id: :binary,
    created_by: :binary,
    pinned: :boolean
  ]

  defp check_required(attrs) do
    Enum.find_value(@required_attrs, :ok, &required_error(attrs, &1))
  end

  defp required_error(attrs, {key, type}) do
    case Map.get(attrs, key) do
      nil -> {:error, {:missing_field, key}}
      value -> type_error(value, key, type)
    end
  end

  defp check_optional(attrs) do
    Enum.find_value(@optional_attrs, :ok, &optional_error(attrs, &1))
  end

  defp optional_error(attrs, {key, type}) do
    case Map.get(attrs, key) do
      nil -> nil
      value -> type_error(value, key, type)
    end
  end

  defp type_error(value, key, type) do
    if type?(value, type), do: nil, else: {:error, {:invalid_field, key}}
  end

  defp type?(value, :binary), do: is_binary(value)
  defp type?(value, :integer), do: is_integer(value)
  defp type?(value, :boolean), do: is_boolean(value)

  defp build_version(attrs, id, now) do
    %Version{
      id: id,
      name: attrs.name,
      version: attrs.version,
      code: attrs.code,
      digest: attrs.digest,
      signature: attrs.signature,
      signer_key_id: attrs.signer_key_id,
      runtime: attrs.runtime,
      entry: attrs.entry,
      access: attrs.access,
      params_schema: attrs.params_schema,
      output_schema: attrs.output_schema,
      contract: attrs.contract,
      timeout_ms: attrs.timeout_ms,
      memory_bytes: attrs.memory_bytes,
      status: "retired",
      created_at: now,
      activated_at: nil,
      created_by: attrs.created_by,
      pinned: attrs.pinned,
      previous_version_id: nil
    }
  end

  defp new_id do
    "fv_" <> Nanoid.generate(16, "abcdefghijklmnopqrstuvwxyz0123456789")
  end

  defp now_ms, do: System.system_time(:millisecond)

  defp verify_stored_schemas(db, stmts, name, version) do
    case run(db, stmts.get_schemas, [name, version]) do
      {:row, [params, output]} ->
        with :ok <- Schema.validate_text(params, "params_schema") do
          Schema.validate_text(output, "output_schema")
        end

      :done ->
        {:error, :not_found}

      :busy ->
        {:error, :busy}

      {:error, reason} ->
        {:error, {:sqlite, reason}}
    end
  end

  # ---------------------------------------------------------------------------
  # Migrations
  # ---------------------------------------------------------------------------

  defp migrate!(db) do
    current = user_version!(db)

    @migrations
    |> Enum.with_index(1)
    |> Enum.each(fn {sql, version} ->
      if version > current, do: apply_migration!(db, sql, version)
    end)
  end

  defp apply_migration!(db, sql, version) do
    with :ok <- Sqlite3.execute(db, "BEGIN IMMEDIATE"),
         :ok <- Sqlite3.execute(db, sql),
         :ok <- Sqlite3.execute(db, "PRAGMA user_version = #{version}"),
         :ok <- Sqlite3.execute(db, "COMMIT") do
      :ok
    else
      {:error, reason} ->
        Sqlite3.execute(db, "ROLLBACK")
        raise "functions.db migration to version #{version} failed: #{inspect(reason)}"
    end
  end

  defp user_version!(db) do
    case Sqlite3.prepare(db, @user_version_sql) do
      {:ok, stmt} ->
        try do
          case Sqlite3.step(db, stmt) do
            {:row, [version]} -> version
            other -> raise "could not read functions.db user_version: #{inspect(other)}"
          end
        after
          Sqlite3.release(db, stmt)
        end

      {:error, reason} ->
        raise "could not read functions.db user_version: #{inspect(reason)}"
    end
  end

  defp prepare_all!(db) do
    Enum.map(
      [
        insert: @insert_sql,
        get: @get_sql,
        get_active: @get_active_sql,
        get_schemas: @get_schemas_sql,
        retire_active: @retire_active_sql,
        set_active: @set_active_sql,
        set_previous_active: @set_previous_active_sql,
        disable: @set_disabled_sql,
        previous: @previous_sql,
        list: @list_sql,
        versions: @versions_sql,
        prune: @prune_sql
      ],
      fn {key, sql} ->
        case Sqlite3.prepare(db, sql) do
          {:ok, stmt} -> {key, stmt}
          {:error, reason} -> raise "could not prepare #{key} statement: #{inspect(reason)}"
        end
      end
    )
    |> Map.new()
  end

  # ---------------------------------------------------------------------------
  # Statement helpers
  # ---------------------------------------------------------------------------

  defp insert_version(db, stmt, version) do
    params = [
      version.id,
      version.name,
      version.version,
      version.code,
      version.digest,
      version.signature,
      version.signer_key_id,
      version.runtime,
      version.entry,
      version.access,
      encode_schema(version.params_schema),
      encode_schema(version.output_schema),
      Integer.to_string(version.contract),
      version.timeout_ms,
      version.memory_bytes,
      version.status,
      version.created_at,
      version.activated_at,
      version.created_by,
      if(version.pinned, do: 1, else: 0),
      version.previous_version_id
    ]

    write(db, stmt, params)
  end

  defp write(db, stmt, params) do
    case run(db, stmt, params) do
      :done -> :ok
      :busy -> {:error, :busy}
      {:row, _row} -> {:error, :unexpected_row}
      {:error, reason} -> {:error, {:sqlite, reason}}
    end
  end

  defp run(db, stmt, params) do
    case Sqlite3.bind(stmt, params) do
      :ok ->
        try do
          Sqlite3.step(db, stmt)
        after
          _ = Sqlite3.reset(stmt)
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp fetch_one(db, stmt, params) do
    case run(db, stmt, params) do
      {:row, row} -> {:ok, row_to_version(row)}
      :done -> :not_found
      :busy -> {:error, :busy}
      {:error, reason} -> {:error, {:sqlite, reason}}
    end
  end

  defp fetch_many(db, stmt, params) do
    case Sqlite3.bind(stmt, params) do
      :ok ->
        try do
          collect_rows(db, stmt, [])
        after
          _ = Sqlite3.reset(stmt)
        end

      {:error, reason} ->
        {:error, {:sqlite, reason}}
    end
  end

  defp collect_rows(db, stmt, acc) do
    case Sqlite3.step(db, stmt) do
      {:row, row} -> collect_rows(db, stmt, [row_to_version(row) | acc])
      :done -> {:ok, Enum.reverse(acc)}
      :busy -> {:error, :busy}
      {:error, reason} -> {:error, {:sqlite, reason}}
    end
  end

  # `BEGIN IMMEDIATE` takes the write lock up front, so a transaction that will
  # write does not fail halfway through on a lock upgrade.
  defp transaction(db, fun) do
    case Sqlite3.execute(db, "BEGIN IMMEDIATE") do
      :ok -> run_transaction(db, fun)
      {:error, reason} -> {:error, {:sqlite, reason}}
    end
  end

  defp run_transaction(db, fun) do
    result =
      try do
        fun.()
      rescue
        error ->
          _ = Sqlite3.execute(db, "ROLLBACK")
          reraise error, __STACKTRACE__
      end

    case result do
      {:ok, _value} = ok ->
        case Sqlite3.execute(db, "COMMIT") do
          :ok ->
            ok

          {:error, reason} ->
            _ = Sqlite3.execute(db, "ROLLBACK")
            {:error, {:sqlite, reason}}
        end

      {:error, _reason} = error ->
        _ = Sqlite3.execute(db, "ROLLBACK")
        error
    end
  end

  # ---------------------------------------------------------------------------
  # Row decoding
  # ---------------------------------------------------------------------------

  defp row_to_version([
         id,
         name,
         version,
         code,
         digest,
         signature,
         signer_key_id,
         runtime,
         entry,
         access,
         params_schema,
         output_schema,
         contract,
         timeout_ms,
         memory_bytes,
         status,
         created_at,
         activated_at,
         created_by,
         pinned,
         previous_version_id
       ]) do
    %Version{
      id: id,
      name: name,
      version: version,
      code: code,
      digest: digest,
      signature: signature,
      signer_key_id: signer_key_id,
      runtime: runtime,
      entry: entry,
      access: access,
      params_schema: decode_schema(params_schema),
      output_schema: decode_schema(output_schema),
      contract: decode_contract(contract),
      timeout_ms: timeout_ms,
      memory_bytes: memory_bytes,
      status: status,
      created_at: created_at,
      activated_at: activated_at,
      created_by: created_by,
      pinned: pinned == 1,
      previous_version_id: previous_version_id
    }
  end

  defp encode_schema(nil), do: nil
  defp encode_schema(schema) when is_map(schema) or is_boolean(schema), do: Jason.encode!(schema)

  # A schema whose JSON does not decode did not come from `put_version`. It is
  # not servable — activation re-reads the raw text and refuses it — but a
  # plain read reports the field as absent rather than taking the shared store
  # down with it.
  defp decode_schema(nil), do: nil

  defp decode_schema(text) when is_binary(text) do
    case Jason.decode(text) do
      {:ok, schema} -> schema
      {:error, _reason} -> nil
    end
  end

  defp decode_contract(text) when is_binary(text) do
    case Integer.parse(text) do
      {contract, ""} -> contract
      _other -> nil
    end
  end

  defp decode_contract(contract), do: contract
end
