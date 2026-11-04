defmodule EbbServer.TestFunctions do
  @moduledoc """
  Fixture loading and transport doubles for the functions protocol tests.
  """

  alias EbbServer.Functions.Protocol

  @fixture_dir Path.expand("../../../fixtures/functions/frames", __DIR__)

  @spec fixture_dir() :: String.t()
  def fixture_dir, do: @fixture_dir

  @spec fixture_names() :: [String.t()]
  def fixture_names do
    @fixture_dir
    |> File.ls!()
    |> Enum.filter(&String.ends_with?(&1, ".json"))
    |> Enum.map(&Path.rootname/1)
    |> Enum.sort()
  end

  @spec load_fixture!(String.t()) :: map()
  def load_fixture!(name) do
    @fixture_dir
    |> Path.join(name <> ".json")
    |> File.read!()
    |> Jason.decode!()
  end

  @spec invoke(String.t(), String.t()) :: Protocol.frame()
  def invoke(name, actor_id \\ "a_test") do
    Protocol.invoke(%{
      "invocation_id" => "inv_#{System.unique_integer([:positive])}",
      "name" => name,
      "version" => "1.0.0",
      "digest" => "sha256:fixture",
      "bundle" => "export const #{name} = () => ({ ok: true });",
      "entry" => name,
      "input" => %{},
      "subject_actor_id" => actor_id,
      "env" => %{},
      "limits" => %{"timeout_ms" => 30_000, "max_host_calls" => 1_000}
    })
  end
end

defmodule EbbServer.TestFunctions.RecordingWorker do
  @moduledoc """
  A fake worker that reports every frame the invocation sends and every close.
  """

  @behaviour EbbServer.Functions.Worker

  alias EbbServer.Functions.Worker.Fake

  @impl true
  def start(opts) do
    notify = Keyword.get(opts, :notify, self())

    case Fake.start(opts) do
      {:ok, handle} -> {:ok, %{handle: handle, notify: notify}}
      error -> error
    end
  end

  @impl true
  def send_frame(%{handle: handle, notify: notify}, frame) do
    send(notify, {:functions_worker_sent, frame})
    Fake.send_frame(handle, frame)
  end

  @impl true
  def close(%{handle: handle, notify: notify}) do
    send(notify, :functions_worker_closed)
    Fake.close(handle)
  end

  @impl true
  def os_pid(%{handle: handle}), do: Fake.os_pid(handle)

  @impl true
  def alive?(%{handle: handle}), do: Fake.alive?(handle)

  @impl true
  def monitor(%{handle: handle}), do: Fake.monitor(handle)
end

defmodule EbbServer.TestFunctions.DelayedHost do
  @moduledoc """
  A host double whose reads take a scripted time, so replies can land out of
  order without depending on storage timing.
  """

  def dispatch("get", %{"id" => id}, _context, opts) do
    notify = Keyword.get(opts, :notify)
    delay = Map.get(Keyword.get(opts, :delays, %{}), id, 0)

    if notify, do: send(notify, {:host_started, id})
    if delay > 0, do: Process.sleep(delay)
    if notify, do: send(notify, {:host_finished, id})

    {:ok, %{"id" => id}}
  end

  def dispatch(op, _payload, _context, _opts) do
    {:error, %{"error" => "protocol_error", "status" => 500, "details" => "unsupported #{op}"}}
  end
end

defmodule EbbServer.TestFunctions.RaisingHost do
  @moduledoc false

  def dispatch(_op, _payload, _context, _opts), do: raise("host exploded")
end

defmodule EbbServer.TestFunctions.FailingWorker do
  @moduledoc false

  @behaviour EbbServer.Functions.Worker

  @impl true
  def start(_opts), do: {:error, :no_worker}

  @impl true
  def send_frame(_handle, _frame), do: {:error, :no_worker}

  @impl true
  def close(_handle), do: :ok

  @impl true
  def os_pid(_handle), do: nil

  @impl true
  def alive?(_handle), do: false
end

defmodule EbbServer.TestFunctions.ClosedWorker do
  @moduledoc false

  @behaviour EbbServer.Functions.Worker

  @impl true
  def start(_opts), do: {:ok, %{}}

  @impl true
  def send_frame(_handle, _frame), do: {:error, :closed}

  @impl true
  def close(_handle), do: :ok

  @impl true
  def os_pid(_handle), do: nil

  @impl true
  def alive?(_handle), do: true
end

defmodule EbbServer.TestFunctions.BadHost do
  @moduledoc false

  def dispatch(_op, _payload, _context, _opts), do: :not_a_result
end

defmodule EbbServer.TestFunctions.NoMonitorWorker do
  @moduledoc """
  A transport that cannot be monitored, so the invocation falls back to
  `alive?/1`.
  """

  @behaviour EbbServer.Functions.Worker

  @impl true
  def start(_opts), do: {:ok, %{pid: spawn(fn -> :ok end)}}

  @impl true
  def send_frame(_handle, _frame), do: :ok

  @impl true
  def close(_handle), do: :ok

  @impl true
  def os_pid(_handle), do: nil

  @impl true
  def alive?(%{pid: pid}), do: Process.alive?(pid)
end

defmodule EbbServer.TestFunctions.Bundles do
  @moduledoc """
  Temp bundle directories for the bundle, loader, and cache tests.

  Every test writes its own `<name>@<version>.envelope.json` + `<name>@<version>.js`
  pair into a fresh directory, so a test can replace, corrupt, or remove a file
  without leaving anything behind for the next test or in the repo.
  """

  alias EbbServer.Functions.Bundle

  @default_code "export const proofreadDocument = () => ({ ok: true });"

  @doc """
  The code every helper-written bundle carries unless the test supplies its own.
  """
  @spec code() :: String.t()
  def code, do: @default_code

  @doc """
  Creates a temp bundle directory for the calling test and removes it on exit.
  """
  @spec tmp_bundle_dir() :: String.t()
  def tmp_bundle_dir do
    dir =
      Path.join([
        System.tmp_dir!(),
        "ebb_server_bundles",
        "#{System.unique_integer([:positive])}_#{System.os_time(:nanosecond)}"
      ])

    File.mkdir_p!(dir)
    ExUnit.Callbacks.on_exit(fn -> File.rm_rf(dir) end)
    dir
  end

  @doc """
  A valid envelope for `name`, with `overrides` merged over the defaults.

  The default digest is the digest of `code/0`, so a test that writes its own
  code passes `%{"digest" => Bundle.digest_for(code)}` instead.
  """
  @spec envelope(String.t(), map()) :: map()
  def envelope(name, overrides \\ %{}) do
    Map.merge(
      %{
        "name" => name,
        "version" => "1.0.0",
        "digest" => Bundle.digest_for(@default_code),
        "runtime" => "bun",
        "contract" => 1,
        "access" => "granted",
        "timeoutMs" => 30_000,
        "memoryBytes" => 268_435_456,
        "entry" => name
      },
      overrides
    )
  end

  @doc """
  Writes an envelope and its code into `dir` under `name@version`.

  `:filename_version` writes the pair under a different version than the
  envelope claims, which is how the loader's disagreement paths are tested.
  """
  @spec write_bundle!(String.t(), map(), String.t(), keyword()) :: map()
  def write_bundle!(dir, envelope, code \\ @default_code, opts \\ []) do
    envelope = Map.put_new(envelope, "digest", Bundle.digest_for(code))
    version = Keyword.get(opts, :filename_version, envelope["version"])
    write_envelope!(dir, envelope, version)
    write_code!(dir, envelope["name"], version, code)
    envelope
  end

  @doc """
  Writes just an envelope, JSON-encoded, and returns its path.
  """
  @spec write_envelope!(String.t(), map(), String.t() | nil) :: String.t()
  def write_envelope!(dir, envelope, version \\ nil) do
    version = version || envelope["version"]
    path = Path.join(dir, "#{envelope["name"]}@#{version}.envelope.json")
    File.mkdir_p!(dir)
    File.write!(path, Jason.encode!(envelope))
    path
  end

  @doc """
  Writes just a code file and returns its path.
  """
  @spec write_code!(String.t(), String.t(), String.t(), String.t()) :: String.t()
  def write_code!(dir, name, version, code \\ @default_code) do
    path = Path.join(dir, "#{name}@#{version}.js")
    File.mkdir_p!(dir)
    File.write!(path, code)
    path
  end

  @doc """
  Writes raw bytes to `basename` inside `dir`, for malformed-file tests.
  """
  @spec write_raw!(String.t(), String.t(), binary()) :: String.t()
  def write_raw!(dir, basename, bytes) do
    path = Path.join(dir, basename)
    File.mkdir_p!(dir)
    File.write!(path, bytes)
    path
  end

  @doc """
  Sets `path`'s mtime to a fixed instant, so ordering tests never sleep.
  """
  @spec set_mtime!(String.t(), non_neg_integer()) :: :ok
  def set_mtime!(path, unix_seconds) do
    File.touch!(path, erl_datetime(unix_seconds))
  end

  defp erl_datetime(unix_seconds) do
    ~U[1970-01-01 00:00:00Z]
    |> DateTime.add(unix_seconds, :second)
    |> Map.take([:year, :month, :day, :hour, :minute, :second])
    |> then(fn t -> {{t.year, t.month, t.day}, {t.hour, t.minute, t.second}} end)
  end
end

defmodule EbbServer.TestFunctions.InputScriptedWorker do
  @moduledoc """
  A transport that answers from the `invoke` frame's `input`.

  `%{"hang" => true}` never answers, so the invocation runs into its deadline;
  anything else answers `%{"echo" => input}` at once. One configured transport
  can therefore serve a timeout and then a success on the same router, which is
  how the endpoint proves a deadline did not take the server down.

  A `:notify` pid receives `:functions_worker_started` once per worker, so a
  request refused before checkout can assert it spawned none.
  """

  @behaviour EbbServer.Functions.Worker

  @impl true
  def start(opts) do
    if notify = Keyword.get(opts, :notify) do
      send(notify, :functions_worker_started)
    end

    {:ok, %{owner: Keyword.get(opts, :owner, self())}}
  end

  @impl true
  def send_frame(%{owner: owner}, %{"type" => "invoke"} = frame) do
    case frame["input"] do
      %{"hang" => true} ->
        :ok

      input ->
        result = %{"type" => "result", "ok" => true, "value" => %{"echo" => input}}
        send(owner, {:functions_worker_frame, result})
        :ok
    end
  end

  def send_frame(_handle, _frame), do: :ok

  @impl true
  def close(_handle), do: :ok

  @impl true
  def os_pid(_handle), do: nil

  @impl true
  def alive?(_handle), do: true
end

defmodule EbbServer.TestFunctions.BlockingWorker do
  @moduledoc """
  A transport whose `invoke` is held open until the test releases it.

  `send_frame/2` reports the frame and the request process pid, then blocks in
  that process until the test sends it `{:functions_release, value}`. That is
  how the in-flight pinning test activates another version while one
  invocation is still running: nothing about the running invocation changes
  until it is let go, and the release value becomes the result.

  A `:notify` pid (the test) receives `{:functions_invoked, request_pid, frame}`.
  """

  @behaviour EbbServer.Functions.Worker

  alias EbbServer.Functions.Protocol

  @impl true
  def start(opts) do
    {:ok, %{owner: Keyword.fetch!(opts, :owner), notify: Keyword.get(opts, :notify)}}
  end

  @impl true
  def send_frame(%{owner: owner, notify: notify}, %{"type" => "invoke"} = frame) do
    if notify, do: send(notify, {:functions_invoked, self(), frame})

    receive do
      {:functions_release, value} ->
        send(owner, {:functions_worker_frame, Protocol.result({:ok, value})})
        :ok
    after
      5_000 -> :ok
    end
  end

  def send_frame(_handle, _frame), do: :ok

  @impl true
  def close(_handle), do: :ok

  @impl true
  def os_pid(_handle), do: nil

  @impl true
  def alive?(_handle), do: true
end
