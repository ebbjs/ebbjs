defmodule EbbServer.Functions.Bundle.StoreLoader do
  @moduledoc """
  A bundle loader backed by `EbbServer.Functions.Store`.

  The store is the production home of versions: an upload writes a row, an
  activation moves the name's active pointer, and this loader reads the row the
  pointer names. `DirLoader` stays for tests and dev, where a directory of
  files is cheaper to produce than a database; both answer the same envelope
  shape, so `BundleCache` never learns which one it has.

  The loader is deliberately narrow. It does not cache (the cache above it
  re-reads on every invocation, so an activation is visible without a restart),
  it does not validate the envelope or its schemas, and it does not verify the
  digest. `BundleCache` fingerprints the answer and `Bundle.new/2` verifies the
  digest, contract, and name and resolves the schemas once, for every loader
  alike. Reading the active row is this module's only job.

  A name with no active row — including a disabled one, which the store leaves
  with no active slot — is `:not_found`. A store that cannot answer is
  `{:error, {:store_unavailable, reason}}`: an unreadable or corrupt deployment
  must never read as an undeployed one, because the cache maps those two onto
  different answers (`404` and a platform failure). The store's own errors pass
  through unchanged.
  """

  @behaviour EbbServer.Functions.Bundle.Loader

  alias EbbServer.Functions.Store
  alias EbbServer.Functions.Store.Version

  @impl true
  @spec load(String.t(), keyword()) ::
          {:ok, EbbServer.Functions.Bundle.Loader.envelope(), binary()}
          | :not_found
          | {:error, term()}
  def load(name, opts) do
    store = Keyword.fetch!(opts, :store)

    case active(name, store) do
      {:ok, %Version{} = version} -> {:ok, envelope(version), version.code}
      :not_found -> :not_found
      {:error, reason} -> {:error, reason}
    end
  end

  # The store is another process and can be gone, or hang, under a deployment
  # that is being torn down. That is a failure to read, not a miss.
  defp active(name, store) do
    Store.active(name, store)
  catch
    :exit, reason -> {:error, {:store_unavailable, reason}}
  end

  defp envelope(version) do
    %{
      "name" => version.name,
      "version" => version.version,
      "digest" => version.digest,
      "runtime" => version.runtime,
      "contract" => version.contract,
      "access" => version.access,
      "timeoutMs" => version.timeout_ms,
      "memoryBytes" => version.memory_bytes,
      "entry" => version.entry
    }
    |> put_schema("paramsSchema", version.params_schema)
    |> put_schema("outputSchema", version.output_schema)
  end

  defp put_schema(envelope, _key, nil), do: envelope
  defp put_schema(envelope, key, schema), do: Map.put(envelope, key, schema)
end
