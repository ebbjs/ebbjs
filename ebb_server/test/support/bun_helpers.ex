defmodule EbbServer.TestFunctions.Bun do
  @moduledoc """
  Support for tests that run a function in a real Bun process.

  The runner is a source entrypoint rather than a built artifact, so these
  tests exercise the same package the release will ship without requiring a
  separate build step. When Bun is absent the tests are excluded by their
  `:bun` tag, which is why the rest of the suite stays runnable for everyone.

  Bundles here are hand-written IIFEs. The CLI's `bundle.ts` is covered by its
  own tests; these fixtures need only the shape the runner evaluates.
  """

  alias EbbServer.Functions.Bundle
  alias EbbServer.TestFunctions.Bundles

  @runner Path.expand("../../../packages/runner/src/main.ts", __DIR__)

  @doc "The runner entrypoint, overridable for a packaged build."
  @spec runner_path() :: String.t()
  def runner_path, do: System.get_env("EBB_BUN_RUNNER") || @runner

  @doc "The Bun executable, or nil when Bun is not installed."
  @spec bun_path() :: String.t() | nil
  def bun_path, do: System.find_executable("bun")

  @doc "Whether the real-runner tests can run here."
  @spec available?() :: boolean()
  def available? do
    not is_nil(bun_path()) and File.exists?(runner_path())
  end

  @doc """
  Adds the real runner and its socket directory to transport options.
  """
  @spec transport_opts(String.t(), keyword()) :: keyword()
  def transport_opts(socket_dir, opts \\ []) do
    Keyword.merge(
      [
        runner_path: runner_path(),
        bun_path: bun_path(),
        socket_dir: Path.join(socket_dir, "sockets")
      ],
      opts
    )
  end

  @doc """
  Writes a bundle whose exported handler is `handler_js`.

  `handler_js` is a JavaScript function expression evaluated with `ctx` and
  `params`; the bundle exposes it under `name` exactly as the CLI's IIFE does.
  """
  @spec deploy_handler!(String.t(), String.t(), String.t(), keyword()) :: map()
  def deploy_handler!(dir, name, handler_js, opts \\ []) do
    code = """
    var __ebbFunction = (() => {
      return { #{name}: #{handler_js} };
    })();
    """

    deploy_code!(dir, name, code, opts)
  end

  @doc "Writes a bundle whose IIFE body is `code`, exporting `name`."
  @spec deploy_code!(String.t(), String.t(), String.t(), keyword()) :: map()
  def deploy_code!(dir, name, code, opts \\ []) do
    overrides =
      %{"digest" => Bundle.digest_for(code)}
      |> Map.merge(Keyword.get(opts, :envelope, %{}))

    Bundles.write_bundle!(dir, Bundles.envelope(name, overrides), code)
  end
end

defmodule EbbServer.TestFunctions.LocalHttp do
  @moduledoc """
  A one-request HTTP server for proving a function's native `fetch` works.

  It answers every request with the same JSON body and closes the connection.
  The server is started on an ephemeral port, so tests never collide.
  """

  @spec start(String.t()) :: %{pid: pid(), url: String.t()}
  def start(body) do
    {:ok, listen} = :gen_tcp.listen(0, [:binary, packet: :raw, active: false, reuseaddr: true])
    {:ok, port} = :inet.port(listen)
    pid = spawn_link(fn -> accept(listen, body) end)
    %{pid: pid, url: "http://127.0.0.1:#{port}/"}
  end

  @spec stop(%{pid: pid()}) :: :ok
  def stop(%{pid: pid}) do
    Process.exit(pid, :kill)
    :ok
  end

  defp accept(listen, body) do
    case :gen_tcp.accept(listen) do
      {:ok, socket} ->
        request(socket)
        response = json_response(body)
        :ok = :gen_tcp.send(socket, response)
        :gen_tcp.close(socket)
        accept(listen, body)

      {:error, _reason} ->
        :ok
    end
  end

  defp request(socket) do
    case :gen_tcp.recv(socket, 0, 5_000) do
      {:ok, data} ->
        if String.contains?(data, "\r\n\r\n"), do: :ok, else: request(socket)

      {:error, _reason} ->
        :ok
    end
  end

  defp json_response(body) do
    [
      "HTTP/1.1 200 OK\r\n",
      "content-type: application/json\r\n",
      "content-length: #{byte_size(body)}\r\n",
      "connection: close\r\n",
      "\r\n",
      body
    ]
    |> IO.iodata_to_binary()
  end
end
