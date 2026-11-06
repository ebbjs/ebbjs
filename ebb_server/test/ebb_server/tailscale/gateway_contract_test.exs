defmodule EbbServer.Tailscale.GatewayContractTest do
  @moduledoc """
  Pins the gateway contract in `ebb_server/tsnode/contract.json`: the identity
  header names, the ones the gateway strips, and the exit status that means
  "do not restart".

  The two halves only meet on the wire, and no automated test can authenticate
  through the gateway without a tailnet. Without this check, renaming a header
  or changing a status on one side would reject every proxied request, or turn
  a fatal error into a restart loop, while every suite stayed green.
  """

  use ExUnit.Case, async: true

  @moduletag :gateway_contract

  alias EbbServer.Sync.AuthPlug
  alias EbbServer.Tailscale.Node

  @contract Path.expand("../../../tsnode/contract.json", __DIR__)
  @fields ~w(login name user_id secret)

  test "AuthPlug reads the names in the gateway contract" do
    headers = headers!()
    names = AuthPlug.tailscale_header_names()

    for field <- @fields do
      assert String.downcase(names[field]) == String.downcase(headers[field]),
             "header #{inspect(field)} differs between tsnode/contract.json " <>
               "(#{inspect(headers[field])}) and AuthPlug (#{inspect(names[field])})"
    end
  end

  test "the gateway strips every header it injects" do
    headers = headers!()
    names = AuthPlug.tailscale_header_names()

    for field <- @fields do
      header = String.downcase(names[field])

      stripped =
        Enum.any?(headers["stripped_prefixes"], &String.starts_with?(header, &1)) or
          header in headers["stripped_headers"]

      assert stripped,
             "gateway injects #{inspect(header)} but does not strip a peer-supplied copy"
    end
  end

  test "the fatal exit status is the one the node stops on" do
    contract = read_contract!()

    assert Node.fatal_exit_status() == contract["fatal_exit_status"],
           "tsnode/contract.json says fatal_exit_status " <>
             "#{inspect(contract["fatal_exit_status"])}, the node stops on " <>
             inspect(Node.fatal_exit_status())

    refute Node.fatal_exit_status() == 2,
           "exit 2 is the Go runtime's status for an unrecovered panic, which must be retried"
  end

  defp headers!, do: read_contract!()["headers"]

  defp read_contract! do
    @contract |> File.read!() |> Jason.decode!()
  end
end
