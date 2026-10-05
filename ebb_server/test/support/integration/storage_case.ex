defmodule EbbServer.Integration.StorageCase do
  @moduledoc """
  ExUnit.CaseTemplate providing shared storage setup for integration tests.

  Handles:
  - Stopping any existing Storage.Supervisor
  - Creating isolated temporary directories
  - Starting fresh Storage.Supervisor
  - Cleanup on test exit

  ## Usage

      defmodule MyIntegrationTest do
        use ExUnit.Case, async: false
        use EbbServer.Integration.StorageCase
        # ...
      end

  ## Options

  - `:with_auth_mode` - When true, saves and restores the application's auth_mode
    setting. Useful for tests that bypass auth but need to restore original state.
  """

  import ExUnit.Callbacks

  alias EbbServer.TestHelpers

  defmacro __using__(opts \\ []) do
    with_auth_mode = Keyword.get(opts, :with_auth_mode, false)
    writer_opts = Keyword.get(opts, :writer_opts, [])

    quote do
      # Overridable per test module so a test can inject a `:commit_fn` or
      # a bad cache table into the Writer that `Storage.Supervisor` owns.
      def storage_writer_opts, do: unquote(writer_opts)
      defoverridable storage_writer_opts: 0

      setup do
        writer_opts = storage_writer_opts()

        if unquote(with_auth_mode) do
          unquote(__MODULE__).setup_with_auth(writer_opts)
        else
          unquote(__MODULE__).setup_without_auth(writer_opts)
        end
      end
    end
  end

  def setup_with_auth(writer_opts \\ []) do
    original_auth_mode = Application.get_env(:ebb_server, :auth_mode)
    Application.put_env(:ebb_server, :auth_mode, :bypass)
    storage_result = setup_storage(writer_opts)

    on_exit(fn ->
      cleanup_storage()
      restore_auth_mode(original_auth_mode)
    end)

    storage_result
  end

  def setup_without_auth(writer_opts \\ []) do
    storage_result = setup_storage(writer_opts)

    on_exit(fn ->
      cleanup_storage()
    end)

    storage_result
  end

  def setup_storage(writer_opts \\ []) do
    # Detach the application-managed Storage.Supervisor so we can replace
    # it with a per-test instance pointed at an isolated `tmp_dir`. We
    # `terminate_child/2` first (not `GenServer.stop/3`) so the parent
    # `EbbServer.Supervisor` does not immediately restart the child
    # against the same RocksDB directory — the restart would race with
    # the in-flight `close/1` and surface "lock hold by current process"
    # errors (see ebbjs/ebbjs#56).
    parent = Process.whereis(EbbServer.Supervisor)
    child_id = EbbServer.Storage.Supervisor

    if parent do
      case Supervisor.terminate_child(parent, child_id) do
        :ok -> :ok
        # Already gone (e.g. previous test ran cleanup first).
        {:error, :not_found} -> :ok
      end
    end

    if pid = Process.whereis(EbbServer.Sync.GroupRegistry) do
      GenServer.stop(pid, :normal, 5000)
      :timer.sleep(100)
    end

    tmp_dir =
      TestHelpers.tmp_dir(%{
        module: __MODULE__,
        test: "integration_#{:erlang.unique_integer([:positive])}"
      })

    Application.put_env(:ebb_server, :data_dir, tmp_dir)

    ensure_started(Registry, keys: :unique, name: EbbServer.Sync.GroupRegistry)

    # `EbbServer.Storage.Supervisor` is registered under `__MODULE__` so
    # only one instance can run per BEAM. Since we've terminated the
    # application-managed one above, we start a *new* supervisor *outside*
    # the application tree — the parent `EbbServer.Supervisor` no longer
    # holds a child spec for it. This per-test supervisor will be torn
    # down by `cleanup_storage/0`.
    # Storage.Supervisor now owns the Writer as its last child, so a
    # Writer crash restarts Writer alone and a cache crash rebuilds the
    # storage tree through `rest_for_one`. Per-test Writer behavior is
    # injected via `writer_opts`.
    {:ok, _pid} =
      EbbServer.Storage.Supervisor.start_link(data_dir: tmp_dir, writer_opts: writer_opts)

    ensure_started(EbbServer.Sync.Supervisor, [])
    ensure_started(EbbServer.Sync.GroupDynamicSupervisor, [])

    %{tmp_dir: tmp_dir}
  end

  def ensure_started(module, opts) do
    case module.start_link(opts) do
      {:ok, _pid} -> :ok
      {:error, {:already_started, _pid}} -> :ok
    end
  end

  def cleanup_storage do
    # Stop the Sync tree before Storage so the Writer's `Process.whereis`
    # guard sees the FanOutRouter gone rather than mid-shutdown. Storage
    # owns the Writer; stopping it must not first stop the Writer, or
    # `rest_for_one` would restart the whole tree mid-cleanup.
    stop_if_running(EbbServer.Sync.Supervisor)
    stop_if_running(EbbServer.Sync.GroupRegistry)
    stop_if_running(EbbServer.Storage.Supervisor)
    Application.delete_env(:ebb_server, :data_dir)
  end

  # credo:disable-for-next-line /Check\.Readability\.PreferImplicitTry/
  def stop_if_running(name) do
    # credo:disable-for-next-line /Check\.Readability\.PreferImplicitTry/
    try do
      if pid = Process.whereis(name) do
        GenServer.stop(pid, :normal, 5000)
      end
    catch
      _, _ -> :ok
    end
  end

  def restore_auth_mode(nil), do: Application.delete_env(:ebb_server, :auth_mode)
  def restore_auth_mode(original), do: Application.put_env(:ebb_server, :auth_mode, original)
end
