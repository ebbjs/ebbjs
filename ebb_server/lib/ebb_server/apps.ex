defmodule EbbServer.Apps do
  @moduledoc """
  The operator-registered set of apps and the browser origins each one is
  served from.

  An **app** is a deployed client with a name, a generated id, and one or more
  registered browser origins. It is the noun an operator thinks in when they
  admit a web app to the store: a production origin and its preview origins
  belong to the same app. Origins are canonicalized on the way in (see
  `EbbServer.Apps.Origin`), unique across the registry, and app names are
  unique case-insensitively.

  ## Boot is fail-closed

  `start_link/1` loads `<data_dir>/apps.json` through
  `EbbServer.Apps.Store`. A missing file is an empty registry; anything
  malformed — bad JSON, an unknown version, a duplicate name or origin, an
  invalid origin — is logged with the file path and read as empty. The file is
  not rewritten, so an operator can inspect what failed.
  """

  use GenServer
  require Logger

  alias EbbServer.Apps.{Origin, Store}
  alias EbbServer.Config

  @default_key {__MODULE__, :apps}
  @id_prefix "app_"

  @type state :: %{data_dir: Path.t(), key: term(), apps: [Store.app()]}

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @spec list(keyword()) :: [Store.app()]
  def list(opts \\ []) do
    opts |> snapshot() |> sorted()
  end

  @spec get(String.t(), keyword()) :: {:ok, Store.app()} | {:error, :not_found}
  def get(id, opts \\ []) do
    case Enum.find(snapshot(opts), fn app -> app.id == id end) do
      nil -> {:error, :not_found}
      app -> {:ok, app}
    end
  end

  @spec add(term(), term(), keyword()) ::
          {:ok, Store.app()}
          | {:error,
             :invalid_name
             | :invalid_origin
             | :duplicate_name
             | :duplicate_origin
             | :storage_error}
  def add(name, origins, opts \\ []) do
    GenServer.call(server(opts), {:add, name, origins})
  end

  @spec remove(String.t(), keyword()) :: :ok | {:error, :not_found | :storage_error}
  def remove(id, opts \\ []) do
    GenServer.call(server(opts), {:remove, id})
  end

  @spec add_origin(String.t(), term(), keyword()) ::
          {:ok, Store.app()}
          | {:error, :not_found | :invalid_origin | :duplicate_origin | :storage_error}
  def add_origin(id, origin, opts \\ []) do
    GenServer.call(server(opts), {:add_origin, id, origin})
  end

  @spec remove_origin(String.t(), term(), keyword()) ::
          {:ok, Store.app()}
          | {:error, :not_found | :origin_not_found | :invalid_origin | :storage_error}
  def remove_origin(id, origin, opts \\ []) do
    GenServer.call(server(opts), {:remove_origin, id, origin})
  end

  @doc """
  Exact origins win over wildcard patterns so a specific registration is not
  shadowed by another app's broader one.
  """
  @spec match_origin(term(), keyword()) :: {:ok, String.t()} | :error
  def match_origin(origin, opts \\ []) do
    case Origin.normalize(origin) do
      {:ok, canonical} -> match_canonical(snapshot(opts), canonical)
      {:error, :invalid_origin} -> :error
    end
  end

  @doc """
  There is no HTTP route for this: operators revoke apps one at a time through
  `DELETE /admin/apps/:id`. It exists for tests and for a local repair of a
  registry whose file has already been restored by hand.
  """
  @spec reset(keyword()) :: :ok | {:error, :storage_error}
  def reset(opts \\ []) do
    GenServer.call(server(opts), :reset)
  end

  @impl true
  def init(opts) do
    data_dir =
      Keyword.get(
        opts,
        :data_dir,
        Application.get_env(:ebb_server, :apps_data_dir, Config.data_dir())
      )

    key = Keyword.get(opts, :key, @default_key)
    apps = load(data_dir)

    publish(key, apps)

    {:ok, %{data_dir: data_dir, key: key, apps: apps}}
  end

  @impl true
  def handle_call({:add, raw_name, raw_origins}, _from, state) do
    with {:ok, name} <- Store.normalize_name(raw_name),
         {:ok, origins} <- Origin.normalize_all(raw_origins),
         :ok <- ensure_new_name(state.apps, name),
         :ok <- ensure_unregistered_origins(state.apps, origins) do
      warn_wildcards(name, origins)
      app = new_app(name, origins)
      commit(state, state.apps ++ [app], {:ok, app})
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:add_origin, id, raw_origin}, _from, state) do
    with {:ok, app} <- fetch(state.apps, id),
         {:ok, origin} <- Origin.normalize(raw_origin),
         :ok <- ensure_unregistered_origins(state.apps, [origin]) do
      warn_wildcards(app.name, [origin])
      updated = %{app | origins: app.origins ++ [origin]}
      commit(state, replace(state.apps, updated), {:ok, updated})
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:remove_origin, id, raw_origin}, _from, state) do
    with {:ok, app} <- fetch(state.apps, id),
         {:ok, origin} <- Origin.normalize(raw_origin),
         :ok <- ensure_registered_origin(app, origin) do
      updated = %{app | origins: List.delete(app.origins, origin)}
      commit(state, replace(state.apps, updated), {:ok, updated})
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:remove, id}, _from, state) do
    case fetch(state.apps, id) do
      {:ok, _app} -> commit(state, Enum.reject(state.apps, &(&1.id == id)), :ok)
      {:error, :not_found} -> {:reply, {:error, :not_found}, state}
    end
  end

  def handle_call(:reset, _from, state), do: commit(state, [], :ok)

  defp load(data_dir) do
    case Store.load(data_dir) do
      {:ok, apps} ->
        apps

      {:error, :enoent} ->
        []

      {:error, reason} ->
        Logger.error(
          "failed to load app registry from #{Store.path(data_dir)}: #{inspect(reason)}"
        )

        []
    end
  end

  # A wildcard admits every subdomain, which is a broader grant than an
  # operator usually means. It is supported, but never silent.
  defp warn_wildcards(name, origins) do
    for origin <- origins, Origin.wildcard?(origin) do
      Logger.warning(
        "app #{inspect(name)} registered a wildcard browser origin #{origin}; " <>
          "prefer exact origins"
      )
    end
  end

  defp commit(state, apps, reply) do
    case Store.write(state.data_dir, apps) do
      :ok ->
        publish(state.key, apps)
        {:reply, reply, %{state | apps: apps}}

      {:error, reason} ->
        Logger.error(
          "failed to persist app registry to #{Store.path(state.data_dir)}: #{inspect(reason)}"
        )

        {:reply, {:error, :storage_error}, state}
    end
  end

  defp snapshot(opts), do: :persistent_term.get(Keyword.get(opts, :key, @default_key), [])

  defp publish(key, apps), do: :persistent_term.put(key, apps)

  defp server(opts), do: Keyword.get(opts, :server, __MODULE__)

  defp new_app(name, origins) do
    %{
      id: @id_prefix <> Nanoid.generate(),
      name: name,
      origins: origins,
      created_at: DateTime.utc_now() |> DateTime.to_iso8601()
    }
  end

  defp fetch(apps, id) do
    case Enum.find(apps, &(&1.id == id)) do
      nil -> {:error, :not_found}
      app -> {:ok, app}
    end
  end

  defp replace(apps, updated) do
    Enum.map(apps, fn app -> if app.id == updated.id, do: updated, else: app end)
  end

  defp match_canonical(apps, canonical) do
    apps = sorted(apps)

    exact = Enum.find(apps, fn app -> canonical in app.origins end)

    wildcard =
      Enum.find(apps, fn app -> Enum.any?(app.origins, &Origin.match?(canonical, &1)) end)

    case exact || wildcard do
      nil -> :error
      app -> {:ok, app.id}
    end
  end

  defp ensure_new_name(apps, name) do
    if Store.duplicate_name?(apps, name), do: {:error, :duplicate_name}, else: :ok
  end

  defp ensure_unregistered_origins(apps, origins) do
    if Store.duplicate_origins?(apps, origins), do: {:error, :duplicate_origin}, else: :ok
  end

  defp sorted(apps), do: Enum.sort_by(apps, fn app -> {app.name, app.id} end)

  defp ensure_registered_origin(app, origin) do
    if origin in app.origins, do: :ok, else: {:error, :origin_not_found}
  end
end
