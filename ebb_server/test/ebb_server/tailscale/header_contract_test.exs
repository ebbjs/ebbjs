defmodule EbbServer.Tailscale.HeaderContractTest do
  @moduledoc """
  Pins the identity header names against the contract the Go gateway reads.

  The two halves only meet on the wire, and no automated test can authenticate
  through the gateway without a tailnet. Without this check, renaming a header
  on one side would reject every proxied request in production while `go test`,
  `mix test`, and the Docker smoke test all stayed green.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Sync.AuthPlug

  @contract Path.expand("../../../tsnode/headers.json", __DIR__)
  @fields ~w(login name user_id secret)

  test "AuthPlug reads the names in the gateway contract" do
    contract = read_contract!()
    names = AuthPlug.tailscale_header_names()

    for field <- @fields do
      assert String.downcase(names[field]) == String.downcase(contract[field]),
             "header #{inspect(field)} differs between tsnode/headers.json " <>
               "(#{inspect(contract[field])}) and AuthPlug (#{inspect(names[field])})"
    end
  end

  test "the gateway strips every header it injects" do
    contract = read_contract!()
    names = AuthPlug.tailscale_header_names()

    for field <- @fields do
      header = String.downcase(names[field])

      stripped =
        Enum.any?(contract["stripped_prefixes"], &String.starts_with?(header, &1)) or
          header in contract["stripped_headers"]

      assert stripped,
             "gateway injects #{inspect(header)} but does not strip a peer-supplied copy"
    end
  end

  defp read_contract! do
    @contract |> File.read!() |> Jason.decode!()
  end
end
