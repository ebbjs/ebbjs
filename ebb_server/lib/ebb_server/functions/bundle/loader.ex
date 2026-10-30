defmodule EbbServer.Functions.Bundle.Loader do
  @moduledoc """
  Where a bundle cache gets its bundles from.

  A loader answers one question for a name: which envelope and which code bytes
  are active. It returns them undigested and unvalidated — the cache verifies
  the digest and builds the `EbbServer.Functions.Bundle` — so every source
  refuses a tampered bundle the same way.

  The shape is deliberately narrow, and narrowing it further is the point: no
  mtime, no path, no version, no "list what changed". A directory loader
  decides which file is active behind this seam, and #595's store loader reads
  its rows behind it too, without the cache learning a second vocabulary.

  `load/2` receives the cache's `:loader_opts`, so a loader is configured where
  the cache is started rather than through a process-global: a directory for
  `DirLoader`, a store handle later.

  Errors are the loader's own; the cache maps them onto its own answers. The
  only one it interprets is `{:duplicate_active_version, version}`, because
  that is a reason to refuse a name rather than a failure to read one.
  """

  @type name :: String.t()
  @type envelope :: map()
  @type code :: binary()
  @type error :: term()

  @doc """
  Returns the active envelope and code for `name`.

  `:not_found` means the loader holds nothing for the name. Anything that is
  present but unusable is an error, never `:not_found`: a corrupted bundle must
  not read as an undeployed one.
  """
  @callback load(name(), opts :: keyword()) ::
              {:ok, envelope(), code()} | :not_found | {:error, error()}
end
