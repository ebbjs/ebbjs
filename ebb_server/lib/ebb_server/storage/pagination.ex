defmodule EbbServer.Storage.Pagination do
  @moduledoc """
  The page window every listing route shares.

  No listing is unbounded, and no caller can ask for a page larger than
  `max_limit/0`. The sync route, the group listing, and the entity query all
  resolve a caller's `:limit` through `normalize_limit/1`, so a page size the
  route accepts is one the service underneath will serve. Keeping the window
  in one place is what stops the route and the service from drifting apart:
  a limit the route lets through is never one the service then rejects.
  """

  @default_limit 200
  @max_limit 1000

  @doc """
  The page size a listing applies when the caller names none.
  """
  @spec default_limit() :: pos_integer()
  def default_limit, do: @default_limit

  @doc """
  The largest page a listing will serve.
  """
  @spec max_limit() :: pos_integer()
  def max_limit, do: @max_limit

  @doc """
  Resolves a caller-supplied limit into the page size a listing applies.

  An omitted limit becomes `#{@default_limit}`. A value that is not a positive
  integer no larger than `#{@max_limit}` is rejected rather than clamped: a
  caller whose page is impossible should hear about it instead of silently
  getting another one.
  """
  @spec normalize_limit(term()) :: {:ok, pos_integer()} | {:error, :invalid_limit}
  def normalize_limit(nil), do: {:ok, @default_limit}

  def normalize_limit(limit) when is_integer(limit) and limit > 0 and limit <= @max_limit,
    do: {:ok, limit}

  def normalize_limit(_limit), do: {:error, :invalid_limit}
end
