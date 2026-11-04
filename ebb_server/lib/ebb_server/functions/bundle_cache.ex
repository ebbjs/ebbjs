defmodule EbbServer.Functions.BundleCache do
  @moduledoc """
  The active bundle for each function name, over a `Bundle.Loader`.

  The cache is the one place that turns what a loader found into a bundle
  anybody may run: the digest is verified, the envelope is validated, and only
  then is the name's entry replaced. `active/1` asks the loader every time, so
  a bundle replaced on disk is visible on the next invocation without a restart
  and a digest is never carried over from an earlier read.

  The loader still re-reads, so the index is keyed by a fingerprint of the
  answer — the envelope fields that decide the bundle plus a hash of the code.
  An unchanged answer is served from the index instead of being validated
  again; a changed one replaces it. Refreshing in one process is what keeps the
  index consistent: two invocations cannot interleave one load with another's,
  and a failed refresh leaves the previous entry alone rather than serving a
  half-loaded or unverified version.

  Answers are deliberately distinguishable. An unknown name is not a broken
  bundle, a digest mismatch is not a missing one, and a duplicated version is
  neither: the endpoint above maps `:unknown_function` to `404` and the rest to
  a platform failure, so collapsing them here would make a tampered bundle
  look like a typo in the URL.

  The loader is injected as an option, and its own options are passed through
  untouched, so #595's store loader is a different `:loader` rather than a
  change here.
  """

  use GenServer

  alias EbbServer.Functions.Bundle
  alias EbbServer.Functions.Bundle.DirLoader

  @type error ::
          :unknown_function
          | :digest_mismatch
          | {:invalid_bundle, Bundle.reason()}
          | {:duplicate_active_version, {String.t(), String.t()}}
          | {:loader_failed, term()}

  @type fingerprint :: tuple()
  @type state :: %{
          loader: module(),
          loader_opts: keyword(),
          index: %{optional(String.t()) => {fingerprint(), Bundle.t()}}
        }

  @doc """
  Starts the cache.

  Options:

    * `:loader` — module implementing `Bundle.Loader` (default `DirLoader`)
    * `:loader_opts` — passed to the loader on every call (default `[]`)
    * `:name` — registered name (default `#{inspect(__MODULE__)}`, `nil` for none)
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    case Keyword.get(opts, :name, __MODULE__) do
      nil -> GenServer.start_link(__MODULE__, opts)
      name -> GenServer.start_link(__MODULE__, opts, name: name)
    end
  end

  @doc """
  Returns the active bundle for `name`.

  `:cache` is the server to ask, so a test or a second cache instance never has
  to share the registered name.
  """
  @spec active(String.t(), GenServer.server()) :: {:ok, Bundle.t()} | {:error, error()}
  def active(name, cache \\ __MODULE__) do
    GenServer.call(cache, {:active, name})
  end

  @impl true
  def init(opts) do
    {:ok,
     %{
       loader: Keyword.get(opts, :loader, DirLoader),
       loader_opts: Keyword.get(opts, :loader_opts, []),
       index: %{}
     }}
  end

  @impl true
  def handle_call({:active, name}, _from, state) do
    case resolve(name, state) do
      {:ok, fingerprint, bundle} ->
        index = Map.put(state.index, name, {fingerprint, bundle})
        {:reply, {:ok, bundle}, %{state | index: index}}

      {:error, _reason} = error ->
        {:reply, error, state}
    end
  end

  defp resolve(name, state) do
    case safe_load(state.loader, name, state.loader_opts) do
      {:ok, envelope, code} -> bundle(name, envelope, code, state.index)
      :not_found -> {:error, :unknown_function}
      {:error, {:duplicate_active_version, version}} -> {:error, duplicate(name, version)}
      {:error, reason} -> {:error, {:loader_failed, reason}}
      other -> {:error, {:loader_failed, {:unexpected_result, other}}}
    end
  end

  # Every field that reaches the struct is part of the fingerprint, so an
  # access, timeout or schema edit with the same code and digest is still
  # picked up.
  defp fingerprint(envelope, code) do
    {
      envelope["version"],
      envelope["digest"],
      envelope["access"],
      envelope["timeoutMs"],
      envelope["memoryBytes"],
      envelope["entry"],
      :erlang.phash2({envelope["paramsSchema"], envelope["outputSchema"]}),
      :erlang.phash2(code)
    }
  end

  defp bundle(name, envelope, code, index) do
    fingerprint = fingerprint(envelope, code)

    case Map.get(index, name) do
      {^fingerprint, bundle} ->
        {:ok, fingerprint, bundle}

      _changed ->
        build(envelope, code, fingerprint)
    end
  end

  defp build(envelope, code, fingerprint) do
    case Bundle.new(envelope, code) do
      {:ok, bundle} -> {:ok, fingerprint, bundle}
      {:error, :digest_mismatch} -> {:error, :digest_mismatch}
      {:error, reason} -> {:error, {:invalid_bundle, reason}}
    end
  end

  defp duplicate(name, version), do: {:duplicate_active_version, {name, version}}

  # A loader is a filesystem or a database handle in another process' clothing:
  # it can raise or exit on a corrupt deployment, and that must not take the
  # cache — and with it every function — down.
  defp safe_load(loader, name, opts) do
    loader.load(name, opts)
  rescue
    error -> {:error, {:loader_crashed, Exception.message(error)}}
  catch
    :exit, reason -> {:error, {:loader_crashed, reason}}
  end
end
