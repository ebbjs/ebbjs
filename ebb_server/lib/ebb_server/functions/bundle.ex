defmodule EbbServer.Functions.Bundle do
  @contract_version 1

  @moduledoc """
  One function version: its decoded envelope plus the code bytes.

  The envelope is camelCase because the TypeScript build writes it. `entry` is
  the exported binding name, never a path. `paramsSchema` and `outputSchema`
  are carried through untouched: they are the runtime's contract, and
  validating them is #595's, not this module's. Fields a future slice adds —
  `signature`, `signer_key_id` — are ignored rather than refused, so an older
  server can still load a bundle before it learns to verify one.

  ## Digest

  The digest is `sha256:<lowercase hex>` over the code bytes and nothing else,
  so it is exactly the check the loader can afford on every call. It is
  verified here, in the constructor every loader goes through, and a value that
  is not the code's digest is refused — including a placeholder, an uppercase
  hex, a truncated hash, or another algorithm. There is no "unverified" bundle
  in the system: a mismatch cannot be served.

  ## Contract

  `contract` is the bundle ABI, and this server speaks `#{@contract_version}`.
  A bundle stamped with a newer contract is refused at load: the CLI supports
  N/N-1, so the server never has to guess how to run an ABI it did not ship
  with. The check lives here rather than in a deploy path because the directory
  loader has no deploy — the files simply appear — and #595's store loader
  reaches the same constructor.

  ## Name

  The name matches `^[A-Za-z][A-Za-z0-9_-]*$`, is at most 64 bytes, and is not
  `default`. It is the `:name` route segment and the `function.<name>` grant
  suffix (the exported binding is `entry`, which may differ) with no
  normalization and no case folding, so `.` stays out of the grammar and a
  grant cannot be parsed two ways. This is validated here as well as in the CLI
  because the CLI is not the only writer of a bundle directory.
  """

  @max_name_bytes 64
  # Plan §2.12 caps wall clock at 60 s. A bundle asking for longer is refused
  # rather than allowed to run past the limit the platform documents.
  @max_timeout_ms 60_000
  @name_pattern ~r/\A[A-Za-z][A-Za-z0-9_-]*\z/
  @reserved_names ["default"]
  @access_values ["granted", "authenticated"]
  @digest_pattern ~r/\Asha256:[0-9a-f]{64}\z/
  @required_fields ~w(name version digest runtime contract access timeoutMs memoryBytes entry)

  @enforce_keys [
    :name,
    :version,
    :digest,
    :runtime,
    :contract,
    :access,
    :timeout_ms,
    :memory_bytes,
    :entry,
    :code
  ]
  defstruct [
    :name,
    :version,
    :digest,
    :runtime,
    :contract,
    :access,
    :timeout_ms,
    :memory_bytes,
    :entry,
    :params_schema,
    :output_schema,
    :code
  ]

  @type t :: %__MODULE__{
          name: String.t(),
          version: String.t(),
          digest: String.t(),
          runtime: String.t(),
          contract: pos_integer(),
          access: String.t(),
          timeout_ms: pos_integer(),
          memory_bytes: pos_integer(),
          entry: String.t(),
          params_schema: map() | nil,
          output_schema: map() | nil,
          code: binary()
        }
  @type reason ::
          {:missing_field, String.t()}
          | {:invalid_field, String.t()}
          | {:invalid_name, term()}
          | :digest_mismatch
          | {:unsupported_contract, term()}

  @doc """
  The bundle ABI this server speaks.
  """
  @spec contract_version() :: pos_integer()
  def contract_version, do: @contract_version

  @doc """
  The canonical digest of `code`: `sha256:` and the lowercase hex hash.
  """
  @spec digest_for(binary()) :: String.t()
  def digest_for(code) when is_binary(code) do
    "sha256:" <> (:crypto.hash(:sha256, code) |> Base.encode16(case: :lower))
  end

  @doc """
  The name grammar, without the length and reserved-word checks.
  """
  @spec valid_name?(term()) :: boolean()
  def valid_name?(name) when is_binary(name) do
    byte_size(name) <= @max_name_bytes and name not in @reserved_names and
      Regex.match?(@name_pattern, name)
  end

  def valid_name?(_name), do: false

  @doc """
  Validates a decoded envelope against `code`.

  Returns the struct a loader serves or the reason it may not be served.
  """
  @spec new(term(), term()) :: {:ok, t()} | {:error, reason()}
  def new(envelope, _code) when not is_map(envelope), do: {:error, {:invalid_field, "envelope"}}
  def new(_envelope, code) when not is_binary(code), do: {:error, {:invalid_field, "code"}}

  def new(envelope, code) do
    with :ok <- require_fields(envelope),
         {:ok, name} <- name(envelope["name"]),
         {:ok, version} <- string_field(envelope, "version"),
         {:ok, runtime} <- string_field(envelope, "runtime"),
         {:ok, entry} <- string_field(envelope, "entry"),
         {:ok, access} <- access_field(envelope["access"]),
         {:ok, contract} <- contract_field(envelope["contract"]),
         {:ok, timeout_ms} <- timeout_field(envelope),
         {:ok, memory_bytes} <- limit_field(envelope, "memoryBytes"),
         {:ok, digest} <- verify_digest(envelope["digest"], code) do
      {:ok,
       %__MODULE__{
         name: name,
         version: version,
         digest: digest,
         runtime: runtime,
         contract: contract,
         access: access,
         timeout_ms: timeout_ms,
         memory_bytes: memory_bytes,
         entry: entry,
         params_schema: envelope["paramsSchema"],
         output_schema: envelope["outputSchema"],
         code: code
       }}
    end
  end

  defp require_fields(envelope) do
    case Enum.find(@required_fields, &is_nil(envelope[&1])) do
      nil -> :ok
      field -> {:error, {:missing_field, field}}
    end
  end

  defp name(name) do
    if valid_name?(name), do: {:ok, name}, else: {:error, {:invalid_name, name}}
  end

  defp string_field(envelope, field) do
    case envelope[field] do
      value when is_binary(value) and value != "" -> {:ok, value}
      _value -> {:error, {:invalid_field, field}}
    end
  end

  defp access_field(access) when access in @access_values, do: {:ok, access}
  defp access_field(_access), do: {:error, {:invalid_field, "access"}}

  defp contract_field(contract) when is_integer(contract) and contract > 0 do
    if contract > @contract_version do
      {:error, {:unsupported_contract, contract}}
    else
      {:ok, contract}
    end
  end

  defp contract_field(_contract), do: {:error, {:invalid_field, "contract"}}

  defp timeout_field(envelope) do
    case envelope["timeoutMs"] do
      value when is_integer(value) and value > 0 and value <= @max_timeout_ms -> {:ok, value}
      _value -> {:error, {:invalid_field, "timeoutMs"}}
    end
  end

  defp limit_field(envelope, field) do
    case envelope[field] do
      value when is_integer(value) and value > 0 -> {:ok, value}
      _value -> {:error, {:invalid_field, field}}
    end
  end

  defp verify_digest(digest, code) do
    with true <- is_binary(digest),
         true <- Regex.match?(@digest_pattern, digest),
         true <- digest == digest_for(code) do
      {:ok, digest}
    else
      _ -> {:error, :digest_mismatch}
    end
  end
end
