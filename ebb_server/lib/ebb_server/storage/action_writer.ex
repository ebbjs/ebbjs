defmodule EbbServer.Storage.ActionWriter do
  use GenServer
  # --- Public API ---
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  def append(pid, action) do
    GenServer.call(pid, {:append, action})
  end

  def subscribe(pid, subscriber_pid) do
    GenServer.call(pid, {:subscribe, subscriber_pid})
  end

  # --- GenServer Callbacks ---
  def init(opts) do
    db = Keyword.fetch!(opts, :db)
    # Determine next GSN from existing data
    next_gsn = get_max_gsn(db) + 1
    {:ok, %{db: db, next_gsn: next_gsn, subscribers: []}}
  end

  def handle_call({:append, action}, _from, state) do
    gsn = state.next_gsn
    # Insert action and updates in a transaction
    Exqlite.Sqlite3.execute(state.db, "BEGIN")

    Exqlite.Sqlite3.execute(state.db, """
      INSERT INTO actions (id, actor_id, hlc, gsn, created_at)
      VALUES ('#{action.id}', '#{action.actor_id}', #{action.hlc}, #{gsn}, #{System.os_time(:millisecond)})
    """)

    for update <- action.updates do
      data_json = Jason.encode!(update.data)

      Exqlite.Sqlite3.execute(state.db, """
        INSERT INTO updates (id, action_id, subject_id, subject_type, method, data)
        VALUES ('#{update.id}', '#{action.id}', '#{update.subject_id}', '#{update.subject_type}', '#{update.method}', '#{data_json}')
      """)
    end

    Exqlite.Sqlite3.execute(state.db, "COMMIT")
    # Notify subscribers
    for pid <- state.subscribers do
      send(pid, {:batch_flushed, gsn, gsn})
    end

    {:reply, {:ok, gsn}, %{state | next_gsn: gsn + 1}}
  end

  def handle_call({:subscribe, pid}, _from, state) do
    {:reply, :ok, %{state | subscribers: [pid | state.subscribers]}}
  end

  # --- Private Helpers ---
  defp get_max_gsn(db) do
    {:ok, stmt} = Exqlite.Sqlite3.prepare(db, "SELECT MAX(gsn) FROM actions")

    case Exqlite.Sqlite3.step(db, stmt) do
      {:row, [nil]} -> 0
      {:row, [max]} -> max
    end
  end
end
